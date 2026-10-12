/**
 * 进程内回归测试：dsh-import-workbuddy HOST 半场（client 桥接路由）。
 *
 * 用假 cordis ctx + 假 webServer 驱动 src/index.js 注册的五条路由，沙箱
 * DSH_HOME / WORKBUDDY_HOME，覆盖：
 *   - GET  /sessions 列出候选（含 alreadyImported、已删除、已接管判定）
 *   - POST /import   按 id 精确导入、幂等跳过、exclude、空选择 no-op
 *   - POST /sync     回写新增内容、不重复追加
 *   - POST /restore  接管的可逆路径
 *   - GET  /adopted  列出已接管
 *   - 空会话进 empty 桶
 *   - noTools 选项真的丢掉工具事件
 *   - 安全护栏：方法不符 405、跨源 403、坏 body 400、坏选项 400
 *
 * host 半场不 import @deepseek-ai/dsh-tools（只有路由，没有 native tool），
 * 因此本测试在任何装了 node 的机器上都能跑，不需要 DSH 安装在场。
 */

import { strict as assert } from 'node:assert'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import zlib from 'node:zlib'

const here = fileURLToPath(new URL('.', import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'src', 'index.js')).href)
const { CURRENT_ARTIFACT_FILENAME, findExistingSession } = await import(
  pathToFileURL(join(here, '..', 'lib', 'dsh-writer.mjs')).href
)

export const name = 'host'

const SESSIONS_PATH = '/__dsh-import-workbuddy/sessions'
const IMPORT_PATH = '/__dsh-import-workbuddy/import'
const SYNC_PATH = '/__dsh-import-workbuddy/sync'
const RESTORE_PATH = '/__dsh-import-workbuddy/restore'
const ADOPTED_PATH = '/__dsh-import-workbuddy/adopted'

const ZSTD_C_CHECKSUM = zlib.constants.ZSTD_c_checksumFlag
const { zstdCompressSync } = zlib

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

  // 7. 归属模式：已删除标注、接管、回写、还原
  {
    const sb = makeSandbox()
    const db = new DatabaseSync(join(dirname(sb.wbRoot), 'workbuddy.db'))
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, deleted_at INTEGER)')
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run('sess-live', 'd:/work/proj-a', '活着的', 'active')
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('sess-gone', 'd:/work/proj-a', '删掉的', 'active', 1791600009999)
    db.close()
    sb.seed('proj-a', [
      { id: 'sess-live', cwd: 'd:/work/proj-a', userText: 'a', assistantText: 'b' },
      { id: 'sess-gone', cwd: 'd:/work/proj-a', userText: 'c', assistantText: 'd' },
    ])
    const { route } = makeHarness()

    await checkAsync('/sessions 标出 WorkBuddy 侧已删除的会话', async () => {
      const { payload } = await call(route(SESSIONS_PATH))
      const live = payload.sessions.find(s => s.id === 'wb-sess-live')
      const gone = payload.sessions.find(s => s.id === 'wb-sess-gone')
      assert.equal(live.deletedInWorkBuddy, false)
      assert.equal(gone.deletedInWorkBuddy, true, 'db 里打了 deleted_at 的必须标出来')
      assert.equal(gone.workBuddyTitle, '删掉的')
    })

    await checkAsync('adopt 模式导入会把源文件归档走', async () => {
      const { payload } = await call(route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-live'], options: { mode: 'adopt' } },
      })
      assert.equal(payload.imported.length, 1)
      assert.equal(payload.mode, 'adopt')
      assert.equal(existsSync(join(sb.wbRoot, 'proj-a', 'sess-live.jsonl')), false)
    })

    // 接管之后源文件离开了 WorkBuddy 目录树，扫描再也看不到它。如果 /sessions
    // 不补上这一行，还原就只能在终端里做——可逆性等于不存在。
    await checkAsync('/sessions 仍列出已接管的会话，供还原', async () => {
      const { payload } = await call(route(SESSIONS_PATH))
      const row = payload.sessions.find(s => s.id === 'wb-sess-live')
      assert.ok(row !== undefined, '接管后这一行不能消失')
      assert.equal(row.adopted, true)
      assert.equal(row.canSyncBack, false)
    })

    await checkAsync('GET /adopted 列出被接管的会话', async () => {
      const { payload } = await call(route(ADOPTED_PATH))
      assert.ok(payload.adopted.some(entry => entry.id === 'wb-sess-live' && entry.present))
    })

    await checkAsync('POST /restore 把源文件放回去并清掉软删除', async () => {
      const { payload } = await call(route(RESTORE_PATH), {
        method: 'POST', body: { ids: ['wb-sess-live'] },
      })
      assert.equal(payload.restored.length, 1)
      assert.equal(existsSync(join(sb.wbRoot, 'proj-a', 'sess-live.jsonl')), true)
      const check = new DatabaseSync(join(dirname(sb.wbRoot), 'workbuddy.db'), { readOnly: true })
      assert.equal(check.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('sess-live').deleted_at, null)
      check.close()
    })
    sb.restore()
  }

  // 8. 同步回写
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{ id: 'sess-s', cwd: 'd:/work/proj-a', userText: 'a', assistantText: 'b' }])
    const source = join(sb.wbRoot, 'proj-a', 'sess-s.jsonl')
    const { route } = makeHarness()

    await checkAsync('没导入就回写会失败，且写进 failed 桶', async () => {
      const { payload } = await call(route(SYNC_PATH), { method: 'POST', body: { ids: ['wb-sess-s'] } })
      assert.equal(payload.synced.length, 0)
      assert.equal(payload.failed.length, 1)
      assert.match(payload.failed[0].error, /先导入再同步/)
    })

    const before = readFileSync(source, 'utf8')
    await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-s'], options: { mode: 'sync' } } })

    await checkAsync('sync 模式导入不改动源文件', async () => {
      assert.equal(readFileSync(source, 'utf8'), before)
    })

    // 模拟 DSH 里又聊了几轮：往产物尾部追加一帧。
    const artifact = join(
      findExistingSession(sb.sessionsRoot, 'wb-sess-s'),
      CURRENT_ARTIFACT_FILENAME,
    )
    const watermark = JSON.parse(readFileSync(join(dirname(artifact), 'workbuddy-sync.json'), 'utf8'))
    let seq = watermark.lastSeq + 1
    const extra = []
    for (let i = 0; i < 2; i++) {
      extra.push(JSON.stringify({
        type: 'user/message', seq: seq++,
        data: { content: [{ type: 'text', text: `DSH 新问题 ${i + 1}` }] },
      }))
      extra.push(JSON.stringify({
        type: 'assistant/message', seq: seq++,
        data: { message: { content: [{ type: 'text', text: `DSH 新回答 ${i + 1}` }] } },
      }))
    }
    appendFileSync(artifact, zstdCompressSync(Buffer.from(`${extra.join('\n')}\n`, 'utf8'), {
      params: { [ZSTD_C_CHECKSUM]: 1 },
    }))

    await checkAsync('POST /sync 只回写水位线之后的内容', async () => {
      const { payload } = await call(route(SYNC_PATH), { method: 'POST', body: { ids: ['wb-sess-s'] } })
      assert.equal(payload.synced.length, 1)
      assert.equal(payload.synced[0].appended, 4)
      const after = readFileSync(source, 'utf8')
      assert.ok(after.startsWith(before), '原文必须原样保留')
      assert.ok(after.includes('DSH 新问题 1'))
    })

    await checkAsync('再次回写不重复追加', async () => {
      const { payload } = await call(route(SYNC_PATH), { method: 'POST', body: { ids: ['wb-sess-s'] } })
      assert.equal(payload.synced[0].appended, 0)
      const after = readFileSync(source, 'utf8')
      assert.equal(after.split('DSH 新问题 1').length - 1, 1)
    })

    await checkAsync('回写后源文件每行仍是合法 JSON', async () => {
      for (const line of readFileSync(source, 'utf8').split('\n').filter(l => l.trim().length > 0)) {
        JSON.parse(line)
      }
    })
    sb.restore()
  }

  // 9. 安全护栏（含新路由）
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

    // 新路由必须继承同一套护栏：/sync 会往 WorkBuddy 的轨迹文件里追加内容，
    // /restore 会把文件搬回原位，两者都是 DNS-rebinding 页面想要的目标。
    await checkAsync('/sync 方法不符返回 405', async () => {
      const { status } = await call(route(SYNC_PATH))
      assert.equal(status, 405)
    })
    await checkAsync('/sync 跨源返回 403', async () => {
      const { status } = await call(route(SYNC_PATH), {
        method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { ids: ['wb-sess-1'] },
      })
      assert.equal(status, 403)
    })
    await checkAsync('/sync 坏 body 返回 400', async () => {
      const { status } = await call(route(SYNC_PATH), { method: 'POST', body: 'not json' })
      assert.equal(status, 400)
    })
    await checkAsync('/restore 缺少 ids 返回 400', async () => {
      const { status } = await call(route(RESTORE_PATH), { method: 'POST', body: {} })
      assert.equal(status, 400)
    })
    await checkAsync('/restore 跨源返回 403', async () => {
      const { status } = await call(route(RESTORE_PATH), {
        method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { ids: ['wb-sess-1'] },
      })
      assert.equal(status, 403)
    })
    await checkAsync('/adopted 非 loopback Host 返回 403', async () => {
      const { status } = await call(route(ADOPTED_PATH), { headers: { host: 'evil.example.com' } })
      assert.equal(status, 403)
    })
    sb.restore()
  }

  return results
}
