/**
 * 同步（sync）模式：把 DSH 里新产生的对话回写到 WorkBuddy 的原 jsonl。
 *
 * 拷贝模式的问题是分叉：导入那一刻之后，DSH 里往下聊的内容 WorkBuddy 永远看
 * 不到。同步模式保留 WorkBuddy 源文件不动，只把新增的轮次追加回去，两个客户端
 * 打开都能看到完整对话。
 *
 * 水位线是这个模式的命门。导入进来的会话**本身就包含原文件的全部消息**——那
 * 是拷贝过来的。如果回写从 seq 0 开始，源 jsonl 会被追加一整段重复历史。所以
 * 导入时必须先把水位线刻到「已写入的最后一条事件」上，回写只处理它之后的事件。
 * 水位线在 import-core 里无条件刻（与模式无关），这样用户之后想切成同步也来得及。
 *
 * 映射是有损的，要如实说明：
 *   - DSH 的 reasoning 块不回写（WorkBuddy 的 reasoning 行带大量 providerData，
 *     造不好就是脏数据），只回写正文。
 *   - 工具调用回写成 function_call / function_call_result，参数与输出按原样。
 *   - 结构性事件（turn/start、step/end、session/title …）不回写。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { randomUUID } from 'node:crypto'

import { findSessionArtifact, readDshSession } from './dsh-reader.mjs'

const WATERMARK_NAME = 'workbuddy-sync.json'
const WATERMARK_VERSION = 1

/** 结构性事件：不构成对话内容，回写时跳过。 */
const STRUCTURAL = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'session/title', 'session/end-seed', 'permission/preset',
  'sandbox/mode', 'approval/policy',
])

function watermarkPath(sessionDir) {
  return join(sessionDir, WATERMARK_NAME)
}

/**
 * 读水位线；没有就返回 -1（表示「一条都没同步过」）。
 *
 * 返回 -1 而不是 0 是有意的：seq 从 0 开始，-1 意味着「全部待同步」，
 * 调用方据此判断是否需要先补刻。
 */
export function readWatermark(sessionDir) {
  try {
    const parsed = JSON.parse(readFileSync(watermarkPath(sessionDir), 'utf8'))
    if (parsed?.version !== WATERMARK_VERSION) return { lastSeq: -1 }
    return { lastSeq: Number(parsed.lastSeq ?? -1), syncedAt: parsed.syncedAt ?? null, appended: parsed.appended ?? 0 }
  } catch {
    return { lastSeq: -1 }
  }
}

/**
 * 刻水位线：把「已经同步到哪条」记到会话目录里。
 *
 * 导入时调用一次（lastSeq = 写入事件数 - 1），回写后调用一次（lastSeq = 本次
 * 处理到的最大 seq）。
 */
export function writeWatermark(sessionDir, { lastSeq, appended = 0 }) {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(watermarkPath(sessionDir), JSON.stringify({
    version: WATERMARK_VERSION,
    lastSeq,
    appended,
    syncedAt: Date.now(),
  }, null, 2))
}

/** DSH 事件 → WorkBuddy jsonl 行；不该回写的返回 null。 */
function toWorkBuddyLine(event, context) {
  if (STRUCTURAL.has(event.type)) return null
  const { sessionId, cwd } = context
  const time = event.time ?? Date.now()
  const id = `dsh-${event.seq}-${randomUUID().slice(0, 8)}`

  if (event.type === 'user/message') {
    const text = (event.data?.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    if (text.length === 0) return null
    return {
      id, timestamp: time, type: 'message', role: 'user', status: 'completed',
      content: [{ type: 'input_text', text }], sessionId, cwd,
    }
  }

  if (event.type === 'assistant/message') {
    const message = event.data?.message ?? {}
    const text = (message.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    if (text.length === 0) return null
    return {
      id, timestamp: time, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }], sessionId, cwd,
    }
  }

  if (event.type === 'tool/call') {
    const data = event.data ?? {}
    if (typeof data.name !== 'string') return null
    return {
      id, timestamp: time, type: 'function_call',
      callId: data.callId ?? id, name: data.name, arguments: data.arguments ?? '',
      sessionId, cwd,
    }
  }

  if (event.type === 'tool/result') {
    const data = event.data ?? {}
    const text = (data.message?.content ?? [])
      .filter(block => block?.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    return {
      id, timestamp: time, type: 'function_call_result',
      name: data.name ?? 'tool', callId: data.toolCallId ?? data.message?.toolCallId ?? id,
      status: 'completed', output: [{ type: 'input_text', text }], sessionId, cwd,
    }
  }

  return null
}

/**
 * 把一个已导入会话的新增内容回写到 WorkBuddy 源 jsonl。
 *
 * @param {object} params
 * @param {string} params.id 候选 id（wb-<uuid>）
 * @param {string} params.source WorkBuddy 源 jsonl 绝对路径（同步模式下必须还在）
 * @param {string} params.sessionsRoot ~/.dsh/sessions
 * @param {string} [params.cwd] 回写行的 cwd 字段
 * @returns {{ appended: number, lastSeq: number, path: string }}
 * @throws 源文件或产物缺失、水位线未刻时抛错（调用方计入 failed）
 */
export function syncBack(params) {
  const { id, source, sessionsRoot, cwd } = params

  if (!existsSync(source)) {
    throw new Error('源文件已不存在（可能已被接管归档），无法同步回写')
  }

  const artifact = findSessionArtifact(sessionsRoot, id)
  if (artifact === undefined) throw new Error(`DSH 侧没有 ${id} 的产物，先导入再同步`)

  const sessionDir = dirname(artifact)
  const watermark = readWatermark(sessionDir)
  if (watermark.lastSeq < 0) {
    throw new Error('没有水位线，拒绝回写（会把整段历史重复追加）')
  }

  const { header, events } = readDshSession(artifact)
  const sessionId = String(header.id ?? id).replace(/^wb-/, '')
  const context = { sessionId, cwd: cwd ?? header.cwd ?? null }

  const lines = []
  let lastSeq = watermark.lastSeq
  for (const event of events) {
    if (typeof event.seq !== 'number' || event.seq <= watermark.lastSeq) continue
    const line = toWorkBuddyLine(event, context)
    if (line !== null) lines.push(JSON.stringify(line))
    if (event.seq > lastSeq) lastSeq = event.seq
  }

  if (lines.length === 0) return { appended: 0, lastSeq, path: source }

  // 原文件不一定以换行结尾；直接 append 会把第一行粘在最后一行后面，
  // 那一行 JSON 就废了。
  const existing = readFileSync(source, 'utf8')
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  appendFileSync(source, prefix + lines.join('\n') + '\n')

  writeWatermark(sessionDir, { lastSeq, appended: (watermark.appended ?? 0) + lines.length })

  return { appended: lines.length, lastSeq, path: source }
}
