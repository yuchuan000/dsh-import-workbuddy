/**
 * 读回 DSH 的会话产物（session.v4.jsonl.zstd）。
 *
 * 为什么要自己写：Node 的 zstdDecompressSync 只解**一个**帧，而且会静默忽略
 * 帧尾多余字节——直接把整个文件喂给它，11.9MB 的产物只会吐出第 1 行表头，
 * 后面几百个事件全部消失。DSH 的产出是「多帧拼接」（writeSession 就写两帧：
 * 表头一帧、事件一帧，后续追加还会再来新帧），所以必须先把帧切开。
 *
 * 帧格式按 RFC 8878 解析，不用「扫 magic 找下一帧」那种近似做法：压缩数据
 * 里出现 28 B5 2F FD 是合法字节序列，扫 magic 会在极罕见情况下错位，而错位
 * 在这条链路上是静默的数据损坏。
 *
 * Frame_Header_Descriptor 的位布局（RFC 8878 §3.1.1.1）：
 *   bits 7-6  Frame_Content_Size_flag
 *   bit  5    Single_Segment_flag
 *   bit  4    未使用
 *   bit  3    保留
 *   bit  2    Content_Checksum_flag   ← 置位时帧尾多 4 字节
 *   bits 1-0  Dictionary_ID_flag
 */

import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { zstdDecompressSync } from 'node:zlib'

import { CURRENT_ARTIFACT_FILENAME, findExistingSession } from './dsh-writer.mjs'

const MAGIC = 0xFD2FB528

/** Dictionary_ID_flag → 字段字节数。 */
const DICT_SIZES = [0, 1, 2, 4]

/** Frame_Content_Size_flag → 字段字节数；flag 0 在单段帧里是 1 字节。 */
const FCS_SIZES = [0, 2, 4, 8]

const BLOCK_RAW = 0
const BLOCK_RLE = 1
const BLOCK_COMPRESSED = 2

/**
 * 帧头长度（从 magic 起算）。
 *
 * @param {Buffer} buffer
 * @param {number} offset 帧起点
 * @returns {{ length: number, checksum: boolean }}
 */
function frameHeader(buffer, offset) {
  if (offset + 5 > buffer.length) throw new Error('truncated frame header')
  if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`not a zstd frame at offset ${offset}`)
  const descriptor = buffer[offset + 4]
  const fcsFlag = descriptor >> 6
  const singleSegment = ((descriptor >> 5) & 1) === 1
  const checksum = ((descriptor >> 2) & 1) === 1
  const dictFlag = descriptor & 3

  let length = 5
  // 单段帧没有 Window_Descriptor（窗口大小由 FCS 推出）。
  if (!singleSegment) length += 1
  length += DICT_SIZES[dictFlag]
  if (fcsFlag === 0) length += singleSegment ? 1 : 0
  else length += FCS_SIZES[fcsFlag]

  return { length, checksum }
}

/**
 * 从 offset 起的那一帧的总长度。
 *
 * 块头是 3 字节小端：bit0 = last，bits1-2 = type，bits3-23 = size。
 * RLE 块的内容只有 1 个字节（那一字节重复 size 次）——这一点是拿手工合成的
 * RLE 帧实测确认的，不是照抄文档猜的：把 RLE 块按 size 推进会多算 7 字节，
 * 而 zstdDecompressSync 忽略帧尾垃圾，错位不会被报错，只会静默丢数据。
 */
function frameLength(buffer, offset) {
  const { length, checksum } = frameHeader(buffer, offset)
  let position = offset + length

  for (;;) {
    if (position + 3 > buffer.length) throw new Error(`truncated block header at ${position}`)
    const header = buffer[position] | (buffer[position + 1] << 8) | (buffer[position + 2] << 16)
    const last = (header & 1) === 1
    const type = (header >> 1) & 3
    const size = header >> 3
    position += 3

    if (type === BLOCK_RLE) {
      position += 1
    } else if (type === BLOCK_RAW || type === BLOCK_COMPRESSED) {
      position += size
    } else {
      throw new Error(`reserved block type at ${position - 3}`)
    }
    if (position > buffer.length) throw new Error(`block overruns buffer at ${position}`)
    if (last) break
  }

  // 校验和跟在最后一个块后面。
  return position - offset + (checksum ? 4 : 0)
}

/**
 * 切出文件里每一帧的字节范围。
 *
 * @param {Buffer} buffer
 * @yields {{ start: number, end: number }}
 */
export function* zstdFrames(buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const length = frameLength(buffer, offset)
    yield { start: offset, end: offset + length }
    offset += length
  }
}

/** 把每一帧解码后拼成一整段文本。 */
export function decodeZstdFrames(buffer) {
  const parts = []
  for (const frame of zstdFrames(buffer)) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 读一个 DSH 会话产物。
 *
 * @param {string} path session.v4.jsonl.zstd 的绝对路径
 * @returns {{ header: object, events: object[], dir: string }}
 *   header 是首行（type:'session'）；events 按 seq 排序。
 */
export function readDshSession(path) {
  const text = decodeZstdFrames(readFileSync(path))
  const lines = text.split('\n').filter(line => line.length > 0)
  if (lines.length === 0) throw new Error(`会话产物为空: ${path}`)

  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error(`首行不是 session 表头: ${header.type}`)

  const events = []
  for (let i = 1; i < lines.length; i++) {
    events.push(JSON.parse(lines[i]))
  }
  events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

  return { header, events, dir: dirname(path), file: basename(path), path }
}

/**
 * 定位一个已导入会话的产物路径。
 *
 * @param {string} sessionsRoot ~/.dsh/sessions
 * @param {string} id 形如 wb-<uuid>
 * @returns {string | undefined} 找不到（或目录里没有已发布产物）时返回 undefined
 */
export function findSessionArtifact(sessionsRoot, id) {
  const dir = findExistingSession(sessionsRoot, id)
  if (!dir) return undefined
  return join(dir, CURRENT_ARTIFACT_FILENAME)
}
