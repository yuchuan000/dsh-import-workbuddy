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
const HIDE_PATH = '/__dsh-import-workbuddy/hide'
const UNHIDE_PATH = '/__dsh-import-workbuddy/unhide'
const REGROUP_PATH = '/__dsh-import-workbuddy/regroup'
const PRESETS_PATH = '/__dsh-import-workbuddy/presets'
const PRESET_PATH = '/__dsh-import-workbuddy/preset'

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

/**
 * @param {object} opts
 * @param {number} [opts.at] 这条会话的时间基准。列表按「最后活动」排序，所以
 *   用例必须能造出活动时间各不相同的会话 —— 默认基准下所有候选都是同一秒，
 *   排序怎么排都看不出问题。
 * @param {number} [opts.lastAt] 最后一条消息的时间。它和 `at` 拉开距离，才造得出
 *   「开得很早、但一直聊到最近」这种会话 —— 正是按创建时间排序会把它压到底下、
 *   按最后活动排序会把它顶上来的那一批。
 */
function makeSourceSession({ id, cwd, userText, assistantText, toolCall, at, lastAt }) {
  const t0 = at ?? 1791600000000
  const tN = lastAt ?? (t0 + (toolCall ? 4000 : 2000))
  const lines = [
    { type: 'session-meta', sessionId: id, timestamp: t0, cwd, meta: {} },
    {
      type: 'message', id: 'm1', timestamp: t0 + 1000, cwd, role: 'user',
      content: [{
        type: 'input_text',
        text: `<system-reminder>\n<user_info>\nWorkspace Folder: ${cwd}\n</user_info>\n</system-reminder>\n<user_query>${userText}</user_query>`,
      }],
    },
    { type: 'message', id: 'm2', timestamp: toolCall ? t0 + 2000 : tN, cwd, role: 'assistant', content: [{ type: 'output_text', text: assistantText }] },
  ]
  if (toolCall) {
    lines.push({
      type: 'message', id: 'm3', timestamp: t0 + 3000, cwd, role: 'assistant',
      content: [{ type: 'function_call', name: toolCall.name, arguments: toolCall.arguments, call_id: toolCall.callId }],
    })
    lines.push({
      type: 'message', id: 'm4', timestamp: tN, cwd, role: 'tool',
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
  const dshHome = join(root, 'dsh')
  process.env.DSH_HOME = dshHome
  process.env.WORKBUDDY_HOME = wbHome
  return {
    root, wbRoot, sessionsRoot, dshHome,
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

function makeHarness(services = {}) {
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
    get(name) { return name === 'webServer' ? webServer : services[name] },
    inject() { /* webServer 已存在，走不到这里 */ },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
  mod.apply(ctx)
  const route = (path) => registrations.find(r => r.path === path)
  return { registrations, route }
}

/**
 * 假的 workspaceRegistry：只实现 host 真正用到的四个成员。
 *
 * 真注册表的 attachSession 会读会话 header 校验 cwd 必须 realpath 后等于工作区
 * path——这里保留这个拒绝路径（`reject` 集合），因为「挂不上要如实报失败」正是
 * 被测的行为之一。
 */
function makeRegistry({ existing = [], reject = new Set() } = {}) {
  const created = []
  /**
   * 实体自己带 attachSession —— 真注册表的接口就是这样（实体是 Workspace），
   * 而 host 调用的正是 `workspace.attachSession(id)`。
   */
  const makeWorkspace = (id, path, title, sessionIds = []) => ({
    id,
    path,
    title,
    sessionIds,
    async attachSession(sessionId) {
      if (reject.has(sessionId)) throw new Error(`cannot attach session '${sessionId}': its cwd resolves elsewhere`)
      if (!sessionIds.includes(sessionId)) sessionIds.unshift(sessionId)
    },
  })
  const workspaces = existing.map((entry, index) => makeWorkspace(
    entry.id ?? `ws-${index + 1}`,
    entry.path,
    entry.title ?? (entry.path.split(/[\\/]/).filter(Boolean).pop() ?? ''),
    entry.sessionIds ?? [],
  ))
  const registry = {
    created,
    list() { return workspaces },
    async create(path) {
      const found = workspaces.find(w => String(w.path).toLowerCase() === String(path).toLowerCase())
      if (found !== undefined) return found
      const workspace = makeWorkspace(
        `ws-${workspaces.length + 1}`,
        path,
        path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      )
      workspaces.push(workspace)
      created.push(path)
      return workspace
    },
  }
  return registry
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

  // 1b. 最后活动时间：字段语义 + 列表排序都用它
  {
    const DAY = 86400000
    const T0 = 1791600000000
    const sb = makeSandbox()
    sb.seed('proj-a', [
      // 开得最早，但一直聊到第五天 —— 按创建时间它垫底，按最后活动它排第二。
      { id: 'sess-long', cwd: 'd:/work/proj-a', userText: 'a', assistantText: 'b', at: T0, lastAt: T0 + DAY * 5 },
      // 昨天开的，聊完就没动过。
      { id: 'sess-mid', cwd: 'd:/work/proj-a', userText: 'c', assistantText: 'd', at: T0 + DAY * 4, lastAt: T0 + DAY * 4 + 2000 },
    ])
    sb.seed('proj-b', [
      // 今天开的，最新。
      { id: 'sess-new', cwd: 'd:/work/proj-b', userText: 'e', assistantText: 'f', at: T0 + DAY * 9, lastAt: T0 + DAY * 9 + 2000 },
    ])
    const { route } = makeHarness()
    const { payload } = await call(route(SESSIONS_PATH))
    const byId = new Map(payload.sessions.map(s => [s.id, s]))

    check('updatedAt 是最后一条消息的时间，不是创建时间', () => {
      const long = byId.get('wb-sess-long')
      assert.equal(long?.createdAt, T0, 'createdAt 应是会话开头')
      assert.equal(long?.updatedAt, T0 + DAY * 5, 'updatedAt 应是最后一条消息')
      assert.ok(long.updatedAt - long.createdAt === DAY * 5, '两者必须真的差五天，否则这个用例什么都没测到')
    })

    check('列表按最后活动时间倒序：最新的在最上面', () => {
      const ids = payload.sessions.map(s => s.id)
      // sess-long 开得最早但聊到第五天，所以它压在昨天开的 sess-mid 上面。
      assert.deepEqual(ids, ['wb-sess-new', 'wb-sess-long', 'wb-sess-mid'],
        `实际顺序：${ids.join(' > ')}`)
    })

    check('按创建时间排会把「开了很久还在聊」的压到底下 —— 这正是改掉的那种顺序', () => {
      // 同一批行，按 createdAt 排：sess-long 从第二位掉到第三位。
      const byCreated = [...payload.sessions].sort((a, b) => b.createdAt - a.createdAt).map(s => s.id)
      assert.notDeepEqual(byCreated, payload.sessions.map(s => s.id),
        '两种排序若一致，说明「改显示时间」这个诉求本身没有落到排序上')
      assert.equal(byCreated[byCreated.length - 1], 'wb-sess-long')
    })

    check('没有时间的行沉到最后，而不是当成 0 混进最旧的一批', () => {
      const rows = [
        { id: 'a', updatedAt: T0 + DAY },
        { id: 'b' },
        { id: 'c', updatedAt: T0 + DAY * 2 },
        { id: 'd', createdAt: T0 + DAY * 3 },
      ]
      // 与 host 同一套规则：没有时间的一律沉底。
      const activity = (r) => (typeof r.updatedAt === 'number' ? r.updatedAt
        : typeof r.createdAt === 'number' ? r.createdAt : null)
      const sorted = [...rows].sort((x, y) => {
        const at = activity(x); const bt = activity(y)
        if (at === null && bt === null) return 0
        if (at === null) return 1
        if (bt === null) return -1
        return bt - at
      })
      assert.equal(sorted[sorted.length - 1].id, 'b', '没时间的必须在最后')
      assert.equal(sorted[0].id, 'd', '只有 createdAt 的也应参与排序')
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

  // 6. 导入即归组：写盘只是半个导入，另一半是挂进 DSH 的工作区分组
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [{ id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'r' }])
    sb.seed('proj-b', [{ id: 'sess-2', cwd: 'd:/work/proj-b', userText: 'second', assistantText: 'r' }])
    const registry = makeRegistry({ existing: [{ id: 'ws-b', path: 'd:/work/proj-b' }] })
    const { route } = makeHarness({ workspaceRegistry: registry })

    await checkAsync('导入后按 cwd 建分组并挂上会话', async () => {
      const { status, payload } = await call(route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1', 'wb-sess-2'] },
      })
      assert.equal(status, 200)
      assert.deepEqual(payload.grouped.map(g => g.id).sort(), ['wb-sess-1', 'wb-sess-2'])
      // 已存在的分组复用，没有的不建；挂载要真的落到 sessionIds 上。
      assert.deepEqual(registry.created, ['d:/work/proj-a'])
      const a = registry.list().find(w => w.path === 'd:/work/proj-a')
      const b = registry.list().find(w => w.path === 'd:/work/proj-b')
      assert.deepEqual(a.sessionIds, ['wb-sess-1'])
      assert.deepEqual(b.sessionIds, ['wb-sess-2'])
      assert.equal(payload.grouped.find(g => g.id === 'wb-sess-2').workspaceTitle, 'proj-b')
    })

    await checkAsync('/sessions 标出哪些已经归组', async () => {
      const { payload } = await call(route(SESSIONS_PATH))
      const byId = new Map(payload.sessions.map(s => [s.id, s]))
      assert.equal(byId.get('wb-sess-1').grouped, true)
      assert.equal(byId.get('wb-sess-2').grouped, true)
    })

    await checkAsync('注册表拒绝挂载时如实报失败，会话仍在 imported 里', async () => {
      const strict = makeRegistry({ reject: new Set(['wb-sess-3']) })
      const harness = makeHarness({ workspaceRegistry: strict })
      sb.seed('proj-c', [{ id: 'sess-3', cwd: 'd:/work/proj-c', userText: 'third', assistantText: 'r' }])
      const { status, payload } = await call(harness.route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-3'] },
      })
      assert.equal(status, 200)
      assert.equal(payload.imported.length, 1, '导入本身应当成功')
      assert.equal(payload.regroupFailed.length, 1)
      assert.match(payload.regroupFailed[0].error, /cannot attach/)
    })

    await checkAsync('没有 workspaceRegistry 时导入照常成功', async () => {
      const harness = makeHarness()
      sb.seed('proj-d', [{ id: 'sess-4', cwd: 'd:/work/proj-d', userText: 'fourth', assistantText: 'r' }])
      const { status, payload } = await call(harness.route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-4'] },
      })
      assert.equal(status, 200)
      assert.equal(payload.imported.length, 1)
      assert.deepEqual(payload.grouped, [])
      assert.deepEqual(payload.regroupFailed, [])
    })

    await checkAsync('POST /regroup 补挂已经导入过的会话', async () => {
      const registry = makeRegistry()
      const harness = makeHarness({ workspaceRegistry: registry })
      const { status, payload } = await call(harness.route(REGROUP_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1', 'wb-sess-2'] },
      })
      assert.equal(status, 200)
      assert.deepEqual(payload.grouped.map(g => g.id).sort(), ['wb-sess-1', 'wb-sess-2'])
      const a = registry.list().find(w => w.path === 'd:/work/proj-a')
      assert.deepEqual(a.sessionIds, ['wb-sess-1'])
    })

    await checkAsync('/regroup 缺少 ids 返回 400', async () => {
      const harness = makeHarness()
      const { status } = await call(harness.route(REGROUP_PATH), { method: 'POST', body: {} })
      assert.equal(status, 400)
    })

    sb.restore()
  }

  // 7. 页面自己的回收站：软删除只动插件清单，不碰 WorkBuddy
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [
      { id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'r' },
      { id: 'sess-2', cwd: 'd:/work/proj-a', userText: 'second', assistantText: 'r' },
    ])
    const { route } = makeHarness()

    await checkAsync('POST /hide 让行离开待导入、出现在 hidden 标记里', async () => {
      const hidden = await call(route(HIDE_PATH), { method: 'POST', body: { ids: ['wb-sess-1'] } })
      assert.equal(hidden.status, 200)
      const { payload } = await call(route(SESSIONS_PATH))
      const byId = new Map(payload.sessions.map(s => [s.id, s]))
      assert.equal(byId.get('wb-sess-1').hidden, true)
      assert.equal(byId.get('wb-sess-1').title.length > 0, true, '清单要记住标题')
      assert.equal(byId.get('wb-sess-1').cwd, 'd:/work/proj-a')
      assert.equal(byId.get('wb-sess-2').hidden, false)
    })

    await checkAsync('软删除不动 WorkBuddy 的轨迹文件', async () => {
      const files = readdirSync(join(sb.wbRoot, 'proj-a'))
      assert.deepEqual(files.filter(name => name.endsWith('.jsonl')).sort(), ['sess-1.jsonl', 'sess-2.jsonl'])
    })

    await checkAsync('清单落盘在 DSH_HOME 下', async () => {
      const manifest = join(sb.dshHome, 'import-workbuddy-hidden.json')
      assert.equal(existsSync(manifest), true)
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      assert.equal(parsed.entries.length, 1)
      assert.equal(parsed.entries[0].id, 'wb-sess-1')
    })

    await checkAsync('POST /unhide 让它回到待导入', async () => {
      const undone = await call(route(UNHIDE_PATH), { method: 'POST', body: { ids: ['wb-sess-1'] } })
      assert.equal(undone.status, 200)
      const { payload } = await call(route(SESSIONS_PATH))
      const row = payload.sessions.find(s => s.id === 'wb-sess-1')
      assert.equal(row.hidden, false)
    })

    await checkAsync('轨迹文件不见了，回收站里那一行仍能被描述出来', async () => {
      await call(route(HIDE_PATH), { method: 'POST', body: { ids: ['wb-sess-2'] } })
      rmSync(join(sb.wbRoot, 'proj-a', 'sess-2.jsonl'))
      const { payload } = await call(route(SESSIONS_PATH))
      const row = payload.sessions.find(s => s.id === 'wb-sess-2')
      assert.ok(row, '清单兜底的那一行仍应出现在列表里')
      assert.equal(row.hidden, true)
      assert.equal(row.title, 'second', `应保留划掉时的标题：${row.title}`)
      assert.equal(row.cwd, 'd:/work/proj-a')
      assert.equal(row.projectDir, 'proj-a')
    })

    await checkAsync('/hide 缺少 ids 返回 400', async () => {
      const { status } = await call(route(HIDE_PATH), { method: 'POST', body: {} })
      assert.equal(status, 400)
    })

    await checkAsync('/hide 跨源返回 403', async () => {
      const { status } = await call(route(HIDE_PATH), {
        method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { ids: ['wb-sess-1'] },
      })
      assert.equal(status, 403)
    })

    await checkAsync('/unhide 方法不符返回 405', async () => {
      const { status } = await call(route(UNHIDE_PATH))
      assert.equal(status, 405)
    })

    sb.restore()
  }

  // N. agent 预设：导入时指定 + 导入后改写
  {
    const sb = makeSandbox()
    sb.seed('proj-a', [
      { id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'first', assistantText: 'reply' },
      { id: 'sess-2', cwd: 'd:/work/proj-a', userText: 'second', assistantText: 'reply2' },
    ])
    // 假的 agent-preset registry：只提供 host 真正用到的两个成员。
    const roster = [
      { id: 'standard', name: '标准模式' },
      { id: 'ptc' },
      { id: 'minimal', name: '精简' },
    ]
    const registry = {
      async list() { return roster.map(row => ({ ...row })) },
      defaultId: 'standard',
    }
    const { route } = makeHarness({ agentPresets: registry })

    await checkAsync('GET /presets 返回名单，并标出默认那个', async () => {
      const { status, payload } = await call(route(PRESETS_PATH))
      assert.equal(status, 200)
      assert.equal(payload.known, true)
      assert.deepEqual(payload.presets.map(row => row.id), ['standard', 'ptc', 'minimal'])
      assert.equal(payload.presets.find(row => row.id === 'standard').isDefault, true)
      assert.equal(payload.presets.find(row => row.id === 'ptc').isDefault, undefined)
      assert.equal(payload.default, 'standard')
    })

    await checkAsync('导入时指定预设，表头就写那个预设', async () => {
      const done = await call(route(IMPORT_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1'], options: { agentPreset: 'ptc' } },
      })
      assert.equal(done.status, 200)
      assert.equal(done.payload.imported.length, 1)
      const { payload } = await call(route(SESSIONS_PATH))
      const row = payload.sessions.find(s => s.id === 'wb-sess-1')
      assert.equal(row.alreadyImported, true)
      assert.equal(row.agentPreset, 'ptc')
    })

    await checkAsync('不指定时落回 standard（名单上的默认值）', async () => {
      await call(route(IMPORT_PATH), { method: 'POST', body: { ids: ['wb-sess-2'] } })
      const { payload } = await call(route(SESSIONS_PATH))
      assert.equal(payload.sessions.find(s => s.id === 'wb-sess-2').agentPreset, 'standard')
    })

    await checkAsync('POST /preset 改写表头，并回报 from → to', async () => {
      const { status, payload } = await call(route(PRESET_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1'], preset: 'minimal' },
      })
      assert.equal(status, 200)
      assert.equal(payload.changed.length, 1)
      assert.equal(payload.changed[0].from, 'ptc')
      assert.equal(payload.changed[0].to, 'minimal')
      const after = await call(route(SESSIONS_PATH))
      assert.equal(after.payload.sessions.find(s => s.id === 'wb-sess-1').agentPreset, 'minimal')
    })

    await checkAsync('POST /preset 拒绝名单外的预设', async () => {
      const { status } = await call(route(PRESET_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1'], preset: 'nope' },
      })
      assert.equal(status, 400)
    })

    await checkAsync('POST /preset 缺少 ids / preset 返回 400', async () => {
      assert.equal((await call(route(PRESET_PATH), { method: 'POST', body: { ids: ['wb-sess-1'] } })).status, 400)
      assert.equal((await call(route(PRESET_PATH), { method: 'POST', body: { preset: 'ptc' } })).status, 400)
    })

    await checkAsync('在 DSH 里继续聊过的会话被跳过，并说明原因', async () => {
      const dir = findExistingSession(sb.sessionsRoot, 'wb-sess-1')
      assert.ok(dir, '应能定位到产物目录')
      // 水位线退到 0，等于「导入之后又发生了事件」：真实场景是事件真的变多，
      // 这里造的是 host 用来判断的那一个数。
      writeFileSync(join(dir, 'workbuddy-sync.json'), JSON.stringify({ version: 1, lastSeq: 0 }))
      const { payload } = await call(route(PRESET_PATH), {
        method: 'POST', body: { ids: ['wb-sess-1'], preset: 'standard' },
      })
      assert.equal(payload.changed.length, 0)
      assert.equal(payload.skipped.length, 1)
      assert.match(payload.skipped[0].reason, /继续对话/)
      // 被跳过的行保持原值：不写半截状态。
      const after = await call(route(SESSIONS_PATH))
      assert.equal(after.payload.sessions.find(s => s.id === 'wb-sess-1').agentPreset, 'minimal')
    })

    await checkAsync('找不到产物的 id 进 failed，不静默当成成功', async () => {
      const { payload } = await call(route(PRESET_PATH), {
        method: 'POST', body: { ids: ['wb-nothing'], preset: 'ptc' },
      })
      assert.equal(payload.failed.length, 1)
      assert.equal(payload.failed[0].id, 'wb-nothing')
    })

    await checkAsync('没有 registry 的部署：known=false，改预设仍放行', async () => {
      const { route: bare } = makeHarness()
      const listed = await call(bare(PRESETS_PATH))
      assert.equal(listed.payload.known, false)
      assert.deepEqual(listed.payload.presets, [])
      const done = await call(bare(PRESET_PATH), {
        method: 'POST', body: { ids: ['wb-sess-2'], preset: 'anything' },
      })
      assert.equal(done.status, 200)
      assert.equal(done.payload.changed.length, 1)
      assert.equal(done.payload.changed[0].to, 'anything')
    })

    sb.restore()
  }

  return results
}
