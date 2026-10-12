/**
 * DSH session-store writer: encodes a session as the same on-disk artifact the
 * JSONL persistence backend produces, so `dsh` can list and resume it.
 *
 * The artifact layout mirrors dsh-session-persistence-jsonl/src/format.ts and
 * zstd.ts exactly:
 *   <root>/<projectKey(cwd)>/session-<encodeSegment(id)>/session.v4.jsonl.zstd
 * The zstd file is a concatenation of independent checksummed Zstandard
 * frames: one frame with only the header line, then one frame per append
 * batch (the import writes one batch with every event).
 *
 * 当前 dsh 构建（0.2.0-rc.2）的 current format 是 v4：
 *   - header 必须写 `version: 4`（v0 artifact 会被迁移链拒绝：
 *     "format v2 surface before first step cannot acquire a system head"）；
 *   - 文件名必须是 `session.v4.jsonl.zstd`（发布式 generation 命名），
 *     写成 `session.jsonl.zstd` 后端根本不会发现它；
 *   - header 需要 isSeeded / delegationDepth / agentPreset 字段。
 * 相邻迁移只处理 header，事件载荷按当前格式直接写即可。
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** zstd frame magic（RFC 8878，小端读作 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xFD2FB528

/** Dictionary_ID_flag → 该字段字节数。 */
const DICT_SIZES = [0, 1, 2, 4]

/** Frame_Content_Size_flag → 该字段字节数；flag 0 在单段帧里是 1 字节。 */
const FCS_SIZES = [0, 2, 4, 8]

const BLOCK_RAW = 0
const BLOCK_RLE = 1
const BLOCK_COMPRESSED = 2

/**
 * 帧头长度（从 magic 起算）。
 *
 * 这段解析与 dsh-reader.mjs 里的实现同源。之所以在 writer 里再放一份，
 * 是因为 reader 反过来 import 了 writer（readDshSession 要用
 * CURRENT_ARTIFACT_FILENAME）—— 让 writer 去 import reader 就成环了。
 * 改这里时请同步改 reader，反之亦然。
 */
function frameHeaderLength(buffer, offset) {
  if (offset + 5 > buffer.length) throw new Error('truncated frame header')
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`not a zstd frame at offset ${offset}`)
  const descriptor = buffer[offset + 4]
  const fcsFlag = descriptor >> 6
  const singleSegment = ((descriptor >> 5) & 1) === 1
  const checksum = ((descriptor >> 2) & 1) === 1
  const dictFlag = descriptor & 3

  let length = 5
  if (!singleSegment) length += 1
  length += DICT_SIZES[dictFlag]
  if (fcsFlag === 0) length += singleSegment ? 1 : 0
  else length += FCS_SIZES[fcsFlag]

  return { length, checksum }
}

/** 从 offset 起的那一帧的总字节长度（含尾部校验和）。 */
function frameTotalLength(buffer, offset) {
  const { length, checksum } = frameHeaderLength(buffer, offset)
  let position = offset + length

  for (;;) {
    if (position + 3 > buffer.length) throw new Error(`truncated block header at ${position}`)
    const header = buffer[position] | (buffer[position + 1] << 8) | (buffer[position + 2] << 16)
    const last = (header & 1) === 1
    const type = (header >> 1) & 3
    const size = header >> 3
    position += 3

    if (type === BLOCK_RLE) position += 1
    else if (type === BLOCK_RAW || type === BLOCK_COMPRESSED) position += size
    else throw new Error(`reserved block type at ${position - 3}`)

    if (position > buffer.length) throw new Error(`block overruns buffer at ${position}`)
    if (last) break
  }

  return position - offset + (checksum ? 4 : 0)
}

/**
 * 切出文件里每一帧的字节范围。
 *
 * 按 RFC 8878 结构解析，而不是「扫 magic 找下一帧」：压缩数据里出现
 * 28 B5 2F FD 是合法字节序列，扫 magic 会在极罕见情况下错位，而错位在这条
 * 链路上是静默的数据损坏。
 *
 * @param {Buffer} buffer
 * @returns {Array<{start: number, end: number}>}
 */
export function zstdFrames(buffer) {
  const out = []
  let offset = 0
  while (offset < buffer.length) {
    const length = frameTotalLength(buffer, offset)
    out.push({ start: offset, end: offset + length })
    offset += length
  }
  return out
}

/** 当前 dsh 会话格式版本（session-format-catalog 的 currentVersion）。 */
export const CURRENT_FORMAT_VERSION = 4

/** 发布式 generation 文件名（format.ts 的当前产物命名）。 */
export const CURRENT_ARTIFACT_FILENAME = 'session.v4.jsonl.zstd'

/**
 * 会话默认挂载的 agent 预设。
 *
 * 历史行为就是它：导入进来的会话一律按「标准模式」跑。任何拿不到/不认识的
 * 预设 id 都回落到这里，绝不让一个拼错的值把 header 写成无效状态 ——
 * 无效的 agentPreset 会让会话在 resume 时挂载失败，而那是打开即报错，
 * 比"用回默认模式"严重得多。
 */
export const DEFAULT_AGENT_PRESET = 'standard'

/**
 * 校验并归一化 agent 预设 id。
 *
 * 只做形状校验（非空字符串、长度合理、字符集安全）；**不做存在性校验** ——
 * 那是服务端拿 preset registry 的活儿，写盘层没有也拿不到那份名单。
 *
 * @param {unknown} raw
 * @returns {string} 合法 id，或 DEFAULT_AGENT_PRESET
 */
export function normalizePresetId(raw) {
  if (typeof raw !== 'string') return DEFAULT_AGENT_PRESET
  const id = raw.trim()
  if (id.length === 0) return DEFAULT_AGENT_PRESET
  // preset id 会被写进 JSON header，也会在日志/路径里出现：限长 + 限字符集。
  if (id.length > 128) return DEFAULT_AGENT_PRESET
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return DEFAULT_AGENT_PRESET
  return id
}

/** Encode an arbitrary string as one safe path segment (format.ts encodeSegment). */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return out
}

/** Build the readable directory key for a project path (format.ts projectKey). */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** One zstd-compressed frame with the backend's checksum flag. */
function zstdFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/**
 * Write one session artifact.
 * @param root - the session store root (e.g. ~/.dsh/sessions).
 * @param header - { id, createdAt, cwd, agentPreset } (id must be a stable import id).
 *   `agentPreset` selects which Agent preset the resumed session mounts; it
 *   defaults to 'standard' so existing callers keep the historical behaviour.
 * @param events - the complete event list (balanced, contiguous seq from 0).
 * @returns the absolute artifact path written.
 */
export function writeSession(root, header, events) {
  const headerLine = {
    type: 'session',
    version: CURRENT_FORMAT_VERSION,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: normalizePresetId(header.agentPreset),
  }
  const lines = [JSON.stringify(headerLine)]
  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq]
    lines.push(JSON.stringify({ type: event.type, seq, time: event.time, data: event.data, ...(event.surfaceOp ? { surfaceOp: event.surfaceOp } : {}) }))
  }
  const dir = join(root, header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd), encodeSegment(header.id))
  const path = join(dir, CURRENT_ARTIFACT_FILENAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, Buffer.concat([
    zstdFrame(`${lines[0]}\n`),
    zstdFrame(`${lines.slice(1).join('\n')}\n`),
  ]))
  return path
}

/**
 * Rewrite ONLY the header line of an existing artifact, in place.
 *
 * 产物是「多帧拼接」：第 0 帧只有表头，第 1 帧起是事件（后续追加还会再添帧）。
 * 所以要改 agentPreset，正确做法是**只重编码第 0 帧**，把第 1 帧之后的原始
 * 字节原样接回去。这样做有两个好处：
 *   1. 事件体一个字节都不动 —— 解压再重压会改变字节（压缩实现/参数差异），
 *      也会把可能存在的、本工具不认识的帧内容重写一遍；
 *   2. 对超大产物（README 提到有 11.9MB 的）不必整体解压，只解第 0 帧。
 *
 * @param path - session.v4.jsonl.zstd 的绝对路径。
 * @param mutate - 收 header 对象、返回新的 header（或原地改后返回它）。
 * @returns {{ header: object, changed: boolean, frames: number }}
 */
export function rewriteSessionHeader(path, mutate) {
  const buffer = readFileSync(path)
  const frames = [...zstdFrames(buffer)]
  if (frames.length === 0) throw new Error(`会话产物没有任何 zstd 帧: ${path}`)

  // 第 0 帧 = 表头帧。解出来一般是 "…\n" 一行。
  const firstText = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const lines = firstText.split('\n')
  const headerLine = lines[0]
  if (headerLine.trim().length === 0) throw new Error(`会话产物首帧为空: ${path}`)

  const header = JSON.parse(headerLine)
  if (header.type !== 'session') throw new Error(`首行不是 session 表头: ${header.type}`)

  const next = mutate({ ...header })
  if (next === undefined || next === null) throw new Error('rewriteSessionHeader: mutate 必须返回表头对象')

  const nextLine = JSON.stringify(next)
  const changed = nextLine !== headerLine
  if (!changed) return { header: next, changed: false, frames: frames.length }

  // 只重建第 0 帧；其余帧原样保留（连同它们各自的校验和）。
  const rebuilt = zstdFrame(`${nextLine}\n`)
  const rest = frames.slice(1).map(frame => buffer.subarray(frame.start, frame.end))
  writeFileSync(path, Buffer.concat([rebuilt, ...rest]))

  // 校验：重写后必须仍能解出正确表头，否则宁可不留一个半坏的产物。
  const verify = readFileSync(path)
  const verifyFrames = [...zstdFrames(verify)]
  const verifyText = zstdDecompressSync(verify.subarray(verifyFrames[0].start, verifyFrames[0].end)).toString('utf8')
  const verifyHeader = JSON.parse(verifyText.split('\n')[0])
  if (verifyHeader.agentPreset !== next.agentPreset) {
    throw new Error(`表头重写后校验失败: agentPreset=${verifyHeader.agentPreset}`)
  }
  return { header: verifyHeader, changed: true, frames: verifyFrames.length }
}

/** Whether a session id already has an artifact anywhere under the store root. */export function findExistingSession(root, id) {
  const needle = encodeSegment(id)
  let projectDirs
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const sessionDir = join(root, entry.name, needle)
    if (!existsSync(sessionDir)) continue
    // 目录存在还不够：必须存在某个已发布 generation 产物，否则视为未导入
    // （避免旧的 session.jsonl.zstd 残留让重复导入被误判为“已存在”）。
    if (existsSync(join(sessionDir, CURRENT_ARTIFACT_FILENAME))) return sessionDir
    if (existsSync(join(sessionDir, 'session.jsonl.zstd'))) return sessionDir
  }
  return false
}
