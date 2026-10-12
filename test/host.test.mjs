/**
 * 进程内回归测试：dsh-import-workbuddy HOST 半场（client 桥接路由）。
 *
 * 用假 cordis ctx + 假 webServer 驱动 src/index.js 注册的两条路由，沙箱
 * DSH_HOME / WORKBUDDY_HOME，覆盖：
 *   - GET  /sessions 列出候选（含 alreadyImported 判定）
 *   - POST /import   按 id 精确导入、幂等跳过、exclude、空选择 no-op
 *   - 空会话进 empty 桶
 *   - noTools 选项真的丢掉工具事件
 *   - 安全护栏：方法不符 405、跨源 403、坏 body 400、坏选项 400
 *
 * host 半场不 import @deepseek-ai/dsh-tools（只有路由，没有 native tool），
 * 因此本测试在任何装了 node 的机器上都能跑，不需要 DSH 安装在场。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'src', 'index.js')).href)

export const name = 'host'

const SESSIONS_PATH = '/__dsh-import-workbuddy/sessions'
const IMPORT_PATH = '/__dsh-import-workbuddy/import'

const results = []
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

async function checkAsync(label, fn) {
  try { await fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

// --- fixtures -----------------------------------------------------------------

function makeSourceSession({ id, cwd, userText, assistantText, toolCall }) {
  const t0 = 1791600000000
  const lines = [
    { type: 'session-meta', sessionId: id, timestamp: t0, cwd, meta: {} },
    {
      type: 'message', id: 'm1', timestamp: t0 + 1000, cwd, role: 'user',
      content: [{
        type: 'input_text',
        text: `<system-reminder>\n<user_info>\nWorkspace Folder: ${cwd}\n</user_info>\n</system-reminder>\n<user_query>${userText}</user_query>`,
      }],
    },
    { type: 'message', id: 'm2', timestamp: t0 + 2000, cwd, role: 'assistant', content: [{ type: 'output_text', text: assistantText }] },
  ]
  if (toolCall) {
    lines.push({
      type: 'message', id: 'm3', timestamp: t0 + 3000, cwd, role: 'assistant',
      content: [{ type: 'function_call', name: toolCall.name, arguments: toolCall.arguments, call_id: toolCall.callId }],
    })
    lines.push({
      type: 'message', id: 'm4', timestamp: t0 + 4000, cwd, role: 'tool',
      content: [{ type: 'function_call_result', call_id: toolCall.callId, output: 'ok' }],
    })
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-import-host-'))
  const wbHome = join(root, 'workbuddy')
  const wbRoot = join(wbHome, 'projects')
  const sessionsRoot = join(root, 'dsh', 'sessions')
  mkdirSync(wbRoot, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  const prevDsh = process.env.DSH_HOME
  const prevWb = process.env.WORKBUDDY_HOME
  process.env.DSH_HOME = join(root, 'dsh')
  process.env.WORKBUDDY_HOME = wbHome
  return {
    root, wbRoot, sessionsRoot,
    seed(project, sessions) {
      const dir = join(wbRoot, project)
      mkdirSync(dir, { recursive: true })
      for (const s of sessions) writeFileSync(join(dir, `${s.id}.jsonl`), makeSourceSession(s))
    },
    restore() {
      if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh
      if (prevWb === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = prevWb
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// --- fake cordis / web server --------------------------------------------------

function makeHarness() {
  const registrations = []
  const webServer = {
    register(entry) {
      registrations.push(entry)
      return () => {
        const at = registrations.indexOf(entry)
        if (at >= 0) registrations.splice(at, 1)
      }
    },
  }
  const ctx = {
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject() { /* webServer 已存在，走不到这里 */ },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  mod.apply(ctx)
  const route = (path) => registrations.find(r => r.path === path)
  return { registrations, route }
}

function makeRequest(method, { headers = {}, body } = {}) {
  return {
    method,
    headers: { host: '127.0.0.1:7777', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
      }
    },
  }
}

function makeResponse() {
  const out = { status: 0, headers: {}, body: '', done: false }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(text) { out.body = text ?? ''; out.done = true },
  }
}

/** Drive one route; returns the parsed JSON payload. */
async function call(route, { method = 'GET', headers, body } = {}) {
  const response = makeResponse()
  await route.handler(makeRequest(method, { headers, body }), response)
  let payload = {}
  try { payload = JSON.parse(response.out.body) } catch { /* keep {} */ }
  return { status: response.out.status, payload }
}

/** 读回产物里的事件类型序列（解 zstd 多帧）。 */
function artifactEventTypes(sessionsRoot, id) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  let projectDirs
  try { projectDirs = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return null }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue
    const file = join(sessionsRoot, entry.name, id, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const buffer = readFileSync(file)
    const frames = []
    let start = 0
    for (let i = 4; i < buffer.length - 3; i++) {
      if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) { frames.push(buffer.subarray(start, i)); start = i }
    }
    frames.push(buffer.subarray(start))
    const text = frames.map(f => zlib.zstdDecompressSync(f).toString('utf8')).join('')
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line).type)
  }
  return null
}

// --- cases ---------------------------------------------------------------------

export async function run() {
  // 1. 列出候选
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [
      { id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'reply' },
      { id: 'sess-2', cwd: 'd:/work/proj-a', userText: 'second', assistantText: 'reply2' },
    ])
    sb.seed('proj-b', [
      { id: 'sess-3', cwd: 'd:/work/proj-b', userText: 'third', assistantText: 'reply3' },
    ])
    const { route } = makeHarness()
    await checkAsync('GET /sessions 返回 200 与 3 个候选', async () => {
      const { status, payload } = await call(route(SESSIONS_PATH))
      assert.equal(status, 200)
      assert.equal(payload.ok, true)
      assert.equal(payload.sessions.length, 3)
    })
    const { payload } = await call(route(SESSIONS_PATH))
    const s1 = payload.sessions.find(s => s.id === 'wb-sess-1')
    check('候选带 cwd / messageCount / alreadyImported=false', () => {
      assert.equal(s1?.cwd, 'd:/work/proj-a')
      assert.equal(s1?.messageCount, 2)
      assert.equal(s1?.alreadyImported, false)
    })
    check('候选标题非空', () => {
      assert.ok(typeof s1?.title === 'string' && s1.title.length > 0)
    })
    sb.restore()
  }

  // 2. 按 id 精确导入 + 幂等
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [
      { id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'reply' },
      { id: 'sess-2', cwd: 'd:/work/proj-a', userText: 'second', assistantText: 'reply2' },
    ])
    const { route } = makeHarness()
    await checkAsync('POST /import 精确导入 1 个', async () => {
      const { status, payload } = await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-1'] } })
      assert.equal(status, 200)
      assert.equal(payload.ok, true)
      assert.equal(payload.imported.length, 1)
      assert.equal(payload.imported[0].id, 'wb-sess-1')
    })
    check('导入后产物落盘', () => {
      assert.ok(existsSync(join(sb.sessionsRoot, '--d-work-proj-a--', 'wb-sess-1', 'session.v4.jsonl.zstd')))
    })
    await checkAsync('重复导入走 existing 跳过', async () => {
      const { payload } = await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-1'] } })
      assert.equal(payload.imported.length, 0)
      assert.equal(payload.existing.length, 1)
    })
    await checkAsync('列表反映 alreadyImported=true', async () => {
      const { payload } = await call(route(SESSIONS_PATH))
      const done = payload.sessions.find(s => s.id === 'wb-sess-1')
      assert.equal(done?.alreadyImported, true)
    })
    sb.restore()
  }

  // 3. exclude + 省略 wb- 前缀
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [
      { id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'reply' },
      { id: 'sess-2', cwd: 'd:/work/proj-a', userText: 'second', assistantText: 'reply2' },
    ])
    const { route } = makeHarness()
    await checkAsync('exclude 排除指定 id', async () => {
      const { payload } = await call(route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['sess-1', 'sess-2'], exclude: ['wb-sess-2'] },
      })
      assert.equal(payload.imported.length, 1)
      assert.equal(payload.imported[0].id, 'wb-sess-1')
    })
    sb.restore()
  }

  // 4. 空选择 no-op
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{ id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'x', assistantText: 'y' }])
    const { route } = makeHarness()
    await checkAsync('空 ids 是 no-op 而不是全量导入', async () => {
      const { status, payload } = await call(route(IMPORT_PATH), { method: 'POST', body: { ids: [] } })
      assert.equal(status, 200)
      assert.equal(payload.ok, true)
      assert.equal(payload.imported.length, 0)
      assert.equal(existsSync(join(sb.sessionsRoot, '--d-work-proj-a--')), false)
    })
    sb.restore()
  }

  // 5. 空会话进 empty 桶
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{ id: 'sess-empty', cwd: 'd:/work/proj-a', userText: 'x', assistantText: 'y' }])
    // 覆盖成只有 session-meta、没有任何消息行的文件
    writeFileSync(
      join(sb.wbRoot, 'proj-a', 'sess-empty.jsonl'),
      `${JSON.stringify({ type: 'session-meta', sessionId: 'sess-empty', timestamp: 1, cwd: 'd:/work/proj-a', meta: {} })}\n`,
    )
    const { route } = makeHarness()
    await checkAsync('无消息内容的会话进 empty 桶', async () => {
      const { payload } = await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-empty'] } })
      assert.ok(payload.empty.includes('wb-sess-empty'))
    })
    sb.restore()
  }

  // 6. noTools 选项
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{
      id: 'sess-tool', cwd: 'd:/work/proj-a', userText: 'run it', assistantText: 'calling',
      toolCall: { name: 'bash', arguments: '{"cmd":"ls"}', callId: 'call-1' },
    }])
    const { route } = makeHarness()
    await checkAsync('noTools 后产物无 tool/call 事件', async () => {
      const { payload } = await call(route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-tool'], options: { noTools: true } },
      })
      assert.equal(payload.imported.length, 1)
      const types = artifactEventTypes(sb.sessionsRoot, 'wb-sess-tool')
      assert.ok(Array.isArray(types))
      assert.ok(!types.some(t => t.startsWith('tool/call')))
    })
    sb.restore()
  }

  // 7. 安全护栏
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{ id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'x', assistantText: 'y' }])
    const { route } = makeHarness()
    await checkAsync('路由方法不符返回 405', async () => {
      const { status } = await call(route(SESSIONS_PATH), { method: 'POST' })
      assert.equal(status, 405)
    })
    await checkAsync('非 loopback Host 返回 403', async () => {
      const { status } = await call(route(SESSIONS_PATH), { headers: { host: 'evil.example.com' } })
      assert.equal(status, 403)
    })
    await checkAsync('Origin 与 Host 不符返回 403', async () => {
      const { status } = await call(route(SESSIONS_PATH), { headers: { origin: 'http://evil.example.com' } })
      assert.equal(status, 403)
    })
    await checkAsync('sec-fetch-site: cross-site 返回 403', async () => {
      const { status } = await call(route(IMPORT_PATH), {
        method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { ids: ['wb-sess-1'] },
      })
      assert.equal(status, 403)
    })
    await checkAsync('坏 body 返回 400', async () => {
      const { status } = await call(route(IMPORT_PATH), { method: 'POST', body: 'not json' })
      assert.equal(status, 400)
    })
    await checkAsync('坏选项返回 400', async () => {
      const { status } = await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-1'], options: { truncate: -1 } } })
      assert.equal(status, 400)
    })
    sb.restore()
  }

  return results
}
