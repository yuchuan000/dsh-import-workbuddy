/**
 * 进程内回归测试：端到端导入流程的核心断言。
 *
 * 与 e2e.test.mjs 的区别：e2e 用 spawnSync 调 import.mjs 子进程，在某些
 * 环境（Windows 上 node.exe 被占用时会 EBUSY）跑不起来；本文件直接驱动
 * 同一批模块（reader → convert → writer），覆盖：
 *   - system 头（11128 修复）
 *   - turn/step 配对、seq 连续
 *   - 重复导入跳过已存在
 *   - 产物路径符合 projectKey 规则
 *   - tool-call 同轮去重（含跨 assistant 消息的场景）
 *   - tool-result 按轮次配对（不跨轮偷结果）
 *   - filterByIds / excludeByIds / parseSelection
 *
 * 全程只在临时目录里写，不碰真实 ~/.dsh。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { findExistingSession, writeSession } from '../lib/dsh-writer.mjs'
import { buildDshEvents, deriveImportTitle } from '../lib/convert.mjs'
import { parseWorkBuddySession } from '../lib/workbuddy-reader.mjs'
import { filterByIds, excludeByIds, parseSelection } from '../lib/select.mjs'

export const name = 'inproc'

function makeSourceSession({ id, cwd, userText, assistantText }) {
  const t0 = 1791600000000
  const lines = [
    { type: 'session-meta', sessionId: id, timestamp: t0, cwd, meta: {} },
    {
      type: 'message', id: 'm1', timestamp: t0 + 1000, cwd, role: 'user',
      content: [{
        type: 'input_text',
        text: `<system-reminder>\n<user_info>\nWorkspace Folder: ${cwd}\n</user_info>\n<identity_context>\nYou are a helpful coding assistant.\n</identity_context>\n</system-reminder>\n<user_query>${userText}</user_query>`,
      }],
    },
    { type: 'message', id: 'm2', timestamp: t0 + 2000, cwd, role: 'assistant', content: [{ type: 'output_text', text: assistantText }] },
  ]
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-import-inproc-'))
  const wbRoot = join(root, 'workbuddy')
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(wbRoot, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  return { root, wbRoot, sessionsRoot }
}

function seed(sandbox, projectName, sessions) {
  const dir = join(sandbox.wbRoot, projectName)
  mkdirSync(dir, { recursive: true })
  for (const s of sessions) writeFileSync(join(dir, `${s.id}.jsonl`), makeSourceSession(s))
}

/** Mirror import.mjs's toEvents with default options. */
function toEvents(messages, options, systemPrompt) {
  return buildDshEvents(messages, { toolEvents: true, title: options.title, titlePinned: true, systemPrompt })
}

/** Mirror import.mjs's per-candidate flow. */
function importOne(sandbox, file) {
  const parsed = parseWorkBuddySession(file)
  const id = `wb-${parsed.header.id}`
  if (findExistingSession(sandbox.sessionsRoot, id)) return { id, existed: true }
  const sourceTitle = parsed.messages
    .filter(m => m.role === 'user').map(m => m.blocks.filter(b => b.type === 'text').map(b => b.text).join(' ')).join(' ').trim() || undefined
  const baseTitle = deriveImportTitle(sourceTitle, parsed.messages, undefined)
  const events = toEvents(parsed.messages, { title: baseTitle }, parsed.header.injectedContext)
  const path = writeSession(sandbox.sessionsRoot, {
    id, createdAt: parsed.header.createdAt, cwd: parsed.header.cwd,
  }, events)
  return { id, path, events }
}

function readArtifact(file) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const b = readFileSync(file)
  const frames = []
  let s = 0
  for (let i = 4; i < b.length - 3; i++) {
    if (b.compare(MAGIC, 0, 4, i, i + 4) === 0) { frames.push(b.subarray(s, i)); s = i }
  }
  frames.push(b.subarray(s))
  const events = []
  for (const fr of frames) {
    let text
    try { text = zlib.zstdDecompressSync(fr).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch {}
    }
  }
  return events
}

function findArtifact(sessionsRoot, id) {
  for (const slug of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const p = join(sessionsRoot, slug.name, id, 'session.v4.jsonl.zstd')
    if (existsSync(p)) return p
  }
  return undefined
}

export async function run() {
  const results = []
  const check = (label, fn) => {
    try { fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
  }

  // --- 1. system 头（11128 修复） ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-sys', cwd: 'd:/work/proj-a', userText: 'hello', assistantText: 'world' }])
    const out = importOne(sb, join(sb.wbRoot, 'proj-a', 'sess-sys.jsonl'))
    check('写入产物存在', () => {
      assert.ok(out.path && existsSync(out.path))
    })
    check('第 1 条 surface 事件是 system/message', () => {
      const events = readArtifact(out.path)
      const SURFACE = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result', 'agent/inbox/spliced'])
      const surface = events.filter(e => SURFACE.has(e.type) && e.surfaceOp === 'append')
      assert.equal(surface[0]?.type, 'system/message', `实际是 ${surface[0]?.type}`)
      const text = surface[0]?.data?.message?.content?.[0]?.text ?? ''
      assert.ok(text.length > 0, 'system 提示词不应为空')
      assert.match(text, /identity_context|user_info|Workspace Folder/)
    })
    check('system 事件带 source.kind=system-prompt', () => {
      const events = readArtifact(out.path)
      const sys = events.find(e => e.type === 'system/message')
      assert.equal(sys?.data?.message?.source?.kind, 'system-prompt')
      assert.equal(sys?.data?.message?.role, 'system')
    })
    check('turn/step 配对且 seq 连续', () => {
      const events = readArtifact(out.path)
      const body = events.filter(e => e.type !== 'session')
      assert.equal(body[0]?.type, 'turn/start')
      assert.equal(body[1]?.type, 'step/start')
      assert.equal(body.filter(e => e.type === 'turn/start').length, body.filter(e => e.type === 'turn/end').length)
      assert.equal(body.filter(e => e.type === 'step/start').length, body.filter(e => e.type === 'step/end').length)
      for (let i = 0; i < body.length; i++) assert.equal(body[i].seq, i, `seq 应为 ${i}`)
    })
    check('标题继承源首条用户消息', () => {
      const events = readArtifact(out.path)
      const title = events.find(e => e.type === 'session/title')
      assert.ok(title, '应有 session/title 事件')
      assert.match(title.data.title, /hello/)
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 2. 重复导入跳过 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-dup', cwd: 'd:/work/proj-a', userText: 'dupe', assistantText: 'ok' }])
    const first = importOne(sb, join(sb.wbRoot, 'proj-a', 'sess-dup.jsonl'))
    const second = importOne(sb, join(sb.wbRoot, 'proj-a', 'sess-dup.jsonl'))
    check('重复导入被识别为已存在', () => {
      assert.equal(first.existed, undefined)
      assert.equal(second.existed, true)
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 3. projectKey 路径 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-key', [{ id: 'sess-key', cwd: 'd:/work/my proj', userText: 'k', assistantText: 'v' }])
    const out = importOne(sb, join(sb.wbRoot, 'proj-key', 'sess-key.jsonl'))
    check('产物落在 projectKey(cwd) 目录下', () => {
      const slugs = readdirSync(sb.sessionsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
      assert.equal(slugs.length, 1, `实际 ${slugs.join(',')}`)
      assert.match(slugs[0], /~0020/)
      assert.match(slugs[0], /^--.*--$/)
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 4. 空会话 ---
  {
    const sb = makeSandbox()
    const dir = join(sb.wbRoot, 'proj-empty')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-empty.jsonl'),
      JSON.stringify({ type: 'session-meta', sessionId: 'sess-empty', timestamp: 1791600000000, cwd: 'd:/work/e', meta: {} }) + '\n')
    const parsed = parseWorkBuddySession(join(dir, 'sess-empty.jsonl'))
    check('无消息的会话 messages 为空', () => {
      assert.equal(parsed.messages.length, 0)
      assert.equal(parsed.header.id, 'sess-empty')
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 5. 选择逻辑 ---
  {
    const items = [{ id: 'wb-a' }, { id: 'wb-b' }, { id: 'wb-c' }]
    check('filterByIds 省略前缀', () => {
      const r = filterByIds(items, ['a', 'c'])
      assert.deepEqual(r.selected.map(i => i.id), ['wb-a', 'wb-c'])
      assert.deepEqual(r.missing, [])
    })
    check('filterByIds missing 报告', () => {
      const r = filterByIds(items, ['zzz'])
      assert.deepEqual(r.selected, [])
      assert.deepEqual(r.missing, ['zzz'])
    })
    check('excludeByIds 省略前缀', () => {
      assert.deepEqual(excludeByIds(items, ['b']).map(i => i.id), ['wb-a', 'wb-c'])
    })
    check('parseSelection 倒序区间', () => {
      const r = parseSelection('9-5', 10)
      assert.equal(r.kind, 'set')
      assert.deepEqual([...r.values].sort((x, y) => x - y), [5, 6, 7, 8, 9])
    })
  }

  // --- 6. 工具调用 + 真实结果 ---
  {
    const sb = makeSandbox()
    const dir = join(sb.wbRoot, 'proj-tools')
    mkdirSync(dir, { recursive: true })
    const t0 = 1791600000000
    const cwd = 'd:/work/t'
    const lines = [
      { type: 'session-meta', sessionId: 'sess-tools', timestamp: t0, cwd, meta: {} },
      { type: 'message', id: 'm1', timestamp: t0 + 1000, cwd, role: 'user', content: [{ type: 'input_text', text: '<user_query>run ls</user_query>' }] },
      { type: 'message', id: 'm2', timestamp: t0 + 2000, cwd, role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] },
      { type: 'function_call', id: 'call-1', timestamp: t0 + 3000, cwd, name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_result', id: 'r1', timestamp: t0 + 4000, cwd, name: 'Bash', callId: 'chatcmpl-1', status: 'completed', output: { type: 'text', text: 'file-a\nfile-b' } },
      // 同一轮里重复的 function_call id（重试批次）——必须去重
      { type: 'function_call', id: 'call-1', timestamp: t0 + 5000, cwd, name: 'Bash', arguments: '{"command":"ls -la"}' },
    ]
    writeFileSync(join(dir, 'sess-tools.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const out = importOne(sb, join(dir, 'sess-tools.jsonl'))
    check('同一轮重复 function_call id 被去重', () => {
      const events = readArtifact(out.path)
      const callIds = events.filter(e => e.type === 'tool/call').map(e => e.data.callId)
      assert.equal(new Set(callIds).size, callIds.length, `重复 callId: ${callIds.join(',')}`)
    })
    check('tool/result 带上真实结果文本', () => {
      const events = readArtifact(out.path)
      const result = events.find(e => e.type === 'tool/result')
      assert.match(result?.data?.message?.content?.[0]?.text ?? '', /file-a/)
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 7. 重复 id 中间隔着 assistant 文本消息（同一轮） ---
  {
    const sb = makeSandbox()
    const dir = join(sb.wbRoot, 'proj-tools2')
    mkdirSync(dir, { recursive: true })
    const t0 = 1791600000000
    const cwd = 'd:/work/t2'
    const lines = [
      { type: 'session-meta', sessionId: 'sess-tools2', timestamp: t0, cwd, meta: {} },
      { type: 'message', id: 'm1', timestamp: t0 + 1000, cwd, role: 'user', content: [{ type: 'input_text', text: '<user_query>go</user_query>' }] },
      { type: 'function_call', id: 'call-x', timestamp: t0 + 2000, cwd, name: 'Bash', arguments: '{"command":"a"}' },
      { type: 'message', id: 'm2', timestamp: t0 + 3000, cwd, role: 'assistant', content: [{ type: 'output_text', text: 'thinking' }] },
      { type: 'function_call', id: 'call-x', timestamp: t0 + 4000, cwd, name: 'Bash', arguments: '{"command":"b"}' },
    ]
    writeFileSync(join(dir, 'sess-tools2.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const out = importOne(sb, join(dir, 'sess-tools2.jsonl'))
    check('跨 assistant 消息的同轮重复 id 也被去重', () => {
      const events = readArtifact(out.path)
      const callIds = events.filter(e => e.type === 'tool/call').map(e => e.data.callId)
      assert.equal(new Set(callIds).size, callIds.length, `重复 callId: ${callIds.join(',')}`)
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 8. tool-result 不跨轮次偷结果 ---
  {
    const sb = makeSandbox()
    const dir = join(sb.wbRoot, 'proj-tools3')
    mkdirSync(dir, { recursive: true })
    const t0 = 1791600000000
    const cwd = 'd:/work/t3'
    const lines = [
      { type: 'session-meta', sessionId: 'sess-tools3', timestamp: t0, cwd, meta: {} },
      // 第一轮：一个没有记录到结果的调用
      { type: 'message', id: 'm1', timestamp: t0 + 100, cwd, role: 'user', content: [{ type: 'input_text', text: '<user_query>first</user_query>' }] },
      { type: 'function_call', id: 'c1', timestamp: t0 + 200, cwd, name: 'Bash', arguments: '{"command":"one"}' },
      // 第二轮：同名工具再次调用，这次有结果
      { type: 'message', id: 'm2', timestamp: t0 + 300, cwd, role: 'user', content: [{ type: 'input_text', text: '<user_query>second</user_query>' }] },
      { type: 'function_call', id: 'c2', timestamp: t0 + 400, cwd, name: 'Bash', arguments: '{"command":"two"}' },
      { type: 'function_call_result', id: 'r2', timestamp: t0 + 500, cwd, name: 'Bash', callId: 'x2', status: 'completed', output: { type: 'text', text: 'RESULT-FOR-TURN-2' } },
    ]
    writeFileSync(join(dir, 'sess-tools3.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const { messages } = parseWorkBuddySession(join(dir, 'sess-tools3.jsonl'))
    check('tool-result 只配对当前轮次的调用', () => {
      const calls = messages.flatMap(m => m.blocks).filter(b => b.type === 'tool-call')
      const c1 = calls.find(b => b.id === 'c1')
      const c2 = calls.find(b => b.id === 'c2')
      assert.equal(c1.result, undefined, '第一轮没记到结果的调用不应被第二轮的结果补上')
      assert.match(c2.result ?? '', /RESULT-FOR-TURN-2/, '结果必须挂在第二轮自己的调用上')
    })
    rmSync(sb.root, { recursive: true, force: true })
  }

  return results
}
