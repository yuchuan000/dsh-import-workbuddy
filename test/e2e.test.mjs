/**
 * 回归测试：端到端导入流程。
 *
 * 在临时目录里搭一个假的 WorkBuddy 源仓库 + 假的 DSH sessions 根，
 * 然后真的调 import.mjs（子进程），验证：
 *   - 非交互环境不给选择参数会拒绝（安全默认）
 *   - --only / --exclude / --list / --all 行为正确
 *   - 导入的会话带 system 头（11128 修复）
 *   - 重复导入跳过已存在
 *   - 产物路径符合 projectKey 规则
 *
 * 全程不碰真实 ~/.dsh。
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const IMPORT = join(projectRoot, 'import.mjs')

export const name = 'e2e'

/** 造一条 WorkBuddy 源会话 jsonl：带注入上下文的 user + assistant 往返。 */
function makeSourceSession({ id, cwd, userText, assistantText }) {
  const t0 = 1791600000000
  const lines = [
    { type: 'session-meta', sessionId: id, timestamp: t0, cwd, meta: {} },
    {
      type: 'message',
      id: 'm1',
      timestamp: t0 + 1000,
      cwd,
      role: 'user',
      content: [{
        type: 'input_text',
        text: `<system-reminder>
<user_info>
Workspace Folder: ${cwd}
</user_info>
<identity_context>
You are a helpful coding assistant.
</identity_context>
</system-reminder>
<user_query>${userText}</user_query>`,
      }],
    },
    {
      type: 'message',
      id: 'm2',
      timestamp: t0 + 2000,
      cwd,
      role: 'assistant',
      content: [{ type: 'output_text', text: assistantText }],
    },
  ]
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

/** 搭一个隔离的测试沙箱。 */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-import-test-'))
  const wbRoot = join(root, 'workbuddy')
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(wbRoot, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  return { root, wbRoot, sessionsRoot }
}

/** 在沙箱里放一个项目目录和若干会话。 */
function seed(sandbox, projectName, sessions) {
  const dir = join(sandbox.wbRoot, projectName)
  mkdirSync(dir, { recursive: true })
  for (const s of sessions) {
    writeFileSync(join(dir, `${s.id}.jsonl`), makeSourceSession(s))
  }
}

/** 跑 import.mjs，返回 { stdout, stderr, code }。 */
function runImport(sandbox, args) {
  const full = ['--workbuddy-root', sandbox.wbRoot, '--sessions-root', sandbox.sessionsRoot, ...args]
  // 用 spawnSync 而非 execFileSync：成功路径也要拿到 stderr
  // （import.mjs 的所有日志都走 stderr，成功时 execFileSync 只给 stdout）。
  const r = spawnSync(process.execPath, [IMPORT, ...full], {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: sandbox.root },
    encoding: 'utf8',
  })
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? 1,
  }
}

/** 读一个已写入的会话产物，返回事件数组。 */
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

/** 在 sessionsRoot 下找到某 id 的产物路径。 */
function findArtifact(sessionsRoot, id) {
  for (const slug of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const p = join(sessionsRoot, slug.name, id, 'session.v4.jsonl.zstd')
    if (existsSync(p)) return p
  }
  return undefined
}

function check(label, fn) {
  try { fn(); return { label, ok: true } } catch (error) { return { label, ok: false, error } }
}

export async function run() {
  const results = []
  const IS_TTY = process.stdin.isTTY === true

  // --- 1. 安全默认：非交互环境不给选择参数必须拒绝 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-1', cwd: 'd:/work/proj-a', userText: 'hi', assistantText: 'hello' }])
    const r = runImport(sb, ['--apply'])
    results.push(check('非交互不给选择参数 -> 拒绝并给出用法提示', () => {
      if (IS_TTY) {
        // 在真终端里会进入交互；这个用例只在非 TTY 环境成立
        return
      }
      assert.equal(r.code, 1, `应失败，实际 code=${r.code}`)
      assert.match(r.stderr, /标准输入不是终端/)
      assert.match(r.stderr, /--only/)
      assert.match(r.stderr, /--all/)
    }))
    results.push(check('被拒绝时没有写入任何会话', () => {
      if (IS_TTY) return
      const any = readdirSync(sb.sessionsRoot).some(d => d.isDirectory())
      assert.equal(any, false, '不应产生任何产物目录')
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 2. --list 只打印不写入 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [
      { id: 'sess-a1', cwd: 'd:/work/proj-a', userText: 'one', assistantText: 'r1' },
      { id: 'sess-a2', cwd: 'd:/work/proj-a', userText: 'two', assistantText: 'r2' },
    ])
    const r = runImport(sb, ['--list'])
    results.push(check('--list 打印清单且包含 id', () => {
      assert.match(r.stderr, /wb-sess-a1/)
      assert.match(r.stderr, /wb-sess-a2/)
      assert.match(r.stderr, /候选 2\/2/)
    }))
    results.push(check('--list 不写入任何会话', () => {
      const any = readdirSync(sb.sessionsRoot).some(d => d.isDirectory())
      assert.equal(any, false)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 3. --only 只导入指定会话 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [
      { id: 'sess-a1', cwd: 'd:/work/proj-a', userText: 'one', assistantText: 'r1' },
      { id: 'sess-a2', cwd: 'd:/work/proj-a', userText: 'two', assistantText: 'r2' },
      { id: 'sess-a3', cwd: 'd:/work/proj-a', userText: 'three', assistantText: 'r3' },
    ])
    const r = runImport(sb, ['--apply', '--only', 'wb-sess-a1,wb-sess-a3'])
    results.push(check('--only 只导入指定的 2 个', () => {
      assert.equal(r.code, 0, r.stderr)
      assert.ok(existsSync(findArtifact(sb.sessionsRoot, 'wb-sess-a1')), 'a1 应存在')
      assert.ok(existsSync(findArtifact(sb.sessionsRoot, 'wb-sess-a3')), 'a3 应存在')
      assert.equal(findArtifact(sb.sessionsRoot, 'wb-sess-a2'), undefined, 'a2 不应存在')
    }))
    results.push(check('--only 省略 wb- 前缀也能匹配', () => {
      const sb2 = makeSandbox()
      seed(sb2, 'proj-b', [{ id: 'sess-b1', cwd: 'd:/work/proj-b', userText: 'x', assistantText: 'y' }])
      const r2 = runImport(sb2, ['--apply', '--only', 'sess-b1'])
      assert.equal(r2.code, 0, r2.stderr)
      assert.ok(existsSync(findArtifact(sb2.sessionsRoot, 'wb-sess-b1')))
      rmSync(sb2.root, { recursive: true, force: true })
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 4. --exclude 排除指定会话 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [
      { id: 'sess-x1', cwd: 'd:/work/proj-a', userText: 'one', assistantText: 'r1' },
      { id: 'sess-x2', cwd: 'd:/work/proj-a', userText: 'two', assistantText: 'r2' },
    ])
    const r = runImport(sb, ['--apply', '--all', '--exclude', 'wb-sess-x2'])
    results.push(check('--all + --exclude 只跳过被排除的', () => {
      assert.equal(r.code, 0, r.stderr)
      assert.ok(existsSync(findArtifact(sb.sessionsRoot, 'wb-sess-x1')))
      assert.equal(findArtifact(sb.sessionsRoot, 'wb-sess-x2'), undefined)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 5. --all 与 --only 互斥 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-c1', cwd: 'd:/work/proj-a', userText: 'q', assistantText: 'a' }])
    const r = runImport(sb, ['--apply', '--all', '--only', 'wb-sess-c1'])
    results.push(check('--all 与 --only 同用 -> 报错', () => {
      assert.equal(r.code, 1)
      assert.match(r.stderr, /不能同时使用/)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 6. system 头（11128 修复的核心） ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-sys', cwd: 'd:/work/proj-a', userText: 'hello', assistantText: 'world' }])
    runImport(sb, ['--apply', '--only', 'wb-sess-sys'])
    results.push(check('导入的会话第 1 条 surface 事件是 system/message', () => {
      const f = findArtifact(sb.sessionsRoot, 'wb-sess-sys')
      assert.ok(f, '产物应存在')
      const events = readArtifact(f)
      const SURFACE = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result', 'agent/inbox/spliced'])
      const surface = events.filter(e => SURFACE.has(e.type) && e.surfaceOp === 'append')
      assert.equal(surface[0]?.type, 'system/message', `实际是 ${surface[0]?.type}`)
      const text = surface[0]?.data?.message?.content?.[0]?.text ?? ''
      assert.ok(text.length > 0, 'system 提示词不应为空')
      assert.match(text, /identity_context|user_info|Workspace Folder/, 'system 应含注入上下文')
    }))
    results.push(check('system 事件带 source.kind=system-prompt', () => {
      const f = findArtifact(sb.sessionsRoot, 'wb-sess-sys')
      const events = readArtifact(f)
      const sys = events.find(e => e.type === 'system/message')
      assert.equal(sys?.data?.message?.source?.kind, 'system-prompt')
      assert.equal(sys?.data?.message?.role, 'system')
    }))
    results.push(check('事件序列结构合法（turn/step 配对）', () => {
      const f = findArtifact(sb.sessionsRoot, 'wb-sess-sys')
      const events = readArtifact(f)
      const body = events.filter(e => e.type !== 'session')
      // 第 0 个事件是 header 行（type:'session'）；事件体从 turn/start 开始
      assert.equal(body[0]?.type, 'turn/start')
      assert.equal(body[1]?.type, 'step/start')
      const opens = body.filter(e => e.type === 'turn/start').length
      const closes = body.filter(e => e.type === 'turn/end').length
      assert.equal(opens, closes, 'turn/start 与 turn/end 必须配对')
      const sOpens = body.filter(e => e.type === 'step/start').length
      const sCloses = body.filter(e => e.type === 'step/end').length
      assert.equal(sOpens, sCloses, 'step/start 与 step/end 必须配对')
    }))
    results.push(check('seq 从 0 连续递增', () => {
      const f = findArtifact(sb.sessionsRoot, 'wb-sess-sys')
      const events = readArtifact(f)
      const body = events.filter(e => e.type !== 'session')
      for (let i = 0; i < body.length; i++) assert.equal(body[i].seq, i, `seq 应为 ${i}`)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 7. 重复导入跳过已存在 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-a', [{ id: 'sess-dup', cwd: 'd:/work/proj-a', userText: 'dupe', assistantText: 'ok' }])
    runImport(sb, ['--apply', '--only', 'wb-sess-dup'])
    const r2 = runImport(sb, ['--apply', '--only', 'wb-sess-dup'])
    results.push(check('重复导入被识别为已存在并跳过', () => {
      assert.equal(r2.code, 0, r2.stderr)
      assert.match(r2.stderr, /已存在跳过 1/)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 8. 产物路径符合 projectKey 规则 ---
  {
    const sb = makeSandbox()
    seed(sb, 'proj-key', [{ id: 'sess-key', cwd: 'd:/work/my proj', userText: 'k', assistantText: 'v' }])
    runImport(sb, ['--apply', '--only', 'wb-sess-key'])
    results.push(check('产物落在 projectKey(cwd) 目录下', () => {
      const slugs = readdirSync(sb.sessionsRoot, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name)
      assert.equal(slugs.length, 1, `应只有 1 个 slug 目录，实际 ${slugs.join(',')}`)
      // 空格应被编码成 ~0020
      assert.match(slugs[0], /~0020/, `空格未编码: ${slugs[0]}`)
      assert.match(slugs[0], /^--.*--$/, `slug 应以 -- 包裹: ${slugs[0]}`)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 9. --project 粗筛仍然可用 ---
  {
    const sb = makeSandbox()
    seed(sb, 'alpha', [{ id: 'sess-p1', cwd: 'd:/work/alpha', userText: 'a', assistantText: '1' }])
    seed(sb, 'beta', [{ id: 'sess-p2', cwd: 'd:/work/beta', userText: 'b', assistantText: '2' }])
    const r = runImport(sb, ['--apply', '--all', '--project', 'alpha'])
    results.push(check('--project 只选 cwd 匹配的会话', () => {
      assert.equal(r.code, 0, r.stderr)
      assert.ok(existsSync(findArtifact(sb.sessionsRoot, 'wb-sess-p1')))
      assert.equal(findArtifact(sb.sessionsRoot, 'wb-sess-p2'), undefined)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  // --- 10. 空会话被识别 ---
  {
    const sb = makeSandbox()
    const dir = join(sb.wbRoot, 'proj-empty')
    mkdirSync(dir, { recursive: true })
    // 只有 session-meta，没有任何消息
    writeFileSync(join(dir, 'sess-empty.jsonl'),
      JSON.stringify({ type: 'session-meta', sessionId: 'sess-empty', timestamp: 1791600000000, cwd: 'd:/work/e', meta: {} }) + '\n')
    const r = runImport(sb, ['--apply', '--all'])
    results.push(check('无消息的会话被计入空会话', () => {
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /空会话 1/)
    }))
    rmSync(sb.root, { recursive: true, force: true })
  }

  return results
}
