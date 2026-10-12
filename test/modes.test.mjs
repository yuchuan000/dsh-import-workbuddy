/**
 * 进程内回归测试：三种归属模式（copy / adopt / sync）及其支撑模块。
 *
 * 覆盖五个文件，全部在临时沙箱里跑，绝不触碰真实的 ~/.dsh 与 ~/.workbuddy：
 *   - lib/import-core.mjs   normalizeMode、导入后接管、水位线无条件刻
 *   - lib/workbuddy-state.mjs  软删除识别、库缺失退化
 *   - lib/adopt.mjs        归档 + 软删除 + 越界校验 + 恢复
 *   - lib/dsh-reader.mjs   多帧 zstd 切分与回读
 *   - lib/sync-back.mjs    水位线截断、拒绝无水位线回写
 *
 * 最要紧的一条是「水位线截断」：导入进来的会话本身就含原文件全部消息，
 * 回写若从 seq 0 开始会把整段历史重复追加进源 jsonl。这个测试就是钉死它。
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

const here = fileURLToPath(new URL('.', import.meta.url))
const load = (rel) => import(pathToFileURL(join(here, '..', 'lib', rel)).href)

const { normalizeMode, MODES, collectCandidates, importCandidates } = await load('import-core.mjs')
const { workbuddyDbPath, dbSessionId, readWorkbuddyState, isDeletedInWorkBuddy } = await load('workbuddy-state.mjs')
const { adoptArchiveRoot, adoptSession, restoreAdopted, listAdopted } = await load('adopt.mjs')
const { zstdFrames, decodeZstdFrames, readDshSession, findSessionArtifact } = await load('dsh-reader.mjs')
const { readWatermark, writeWatermark, syncBack } = await load('sync-back.mjs')
const { CURRENT_ARTIFACT_FILENAME } = await load('dsh-writer.mjs')

export const name = 'modes'

const results = []
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

// --- fixtures -----------------------------------------------------------------

const T0 = 1791600000000

/** 造一个 WorkBuddy 会话 jsonl（两轮，带 cwd）。 */
function workbuddyJsonl({ id, cwd, rounds }) {
  const lines = [{ type: 'session-meta', sessionId: id, timestamp: T0, cwd, meta: {} }]
  for (let i = 0; i < rounds; i++) {
    lines.push({
      type: 'message', id: `u${i}`, timestamp: T0 + 1000 + i * 2000, cwd, role: 'user',
      content: [{ type: 'input_text', text: `问题 ${i + 1}` }],
    })
    lines.push({
      type: 'message', id: `a${i}`, timestamp: T0 + 2000 + i * 2000, cwd, role: 'assistant',
      content: [{ type: 'output_text', text: `回答 ${i + 1}` }],
    })
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}

/** 造一个与 dsh-writer 相同参数的一帧，用来模拟「DSH 之后又追加了一批」。 */
function appendFrame(artifactPath, lines) {
  const frame = zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  appendFileSync(artifactPath, frame)
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-import-modes-'))
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
    root, wbHome, wbRoot, sessionsRoot,
    seedDb() {
      const db = new DatabaseSync(workbuddyDbPath(wbRoot))
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, deleted_at INTEGER)')
      return db
    },
    seed(project, sessions) {
      const dir = join(wbRoot, project)
      mkdirSync(dir, { recursive: true })
      for (const s of sessions) writeFileSync(join(dir, `${s.id}.jsonl`), workbuddyJsonl(s))
    },
    restore() {
      if (prevDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDsh
      if (prevWb === undefined) delete process.env.WORKBUDDY_HOME; else process.env.WORKBUDDY_HOME = prevWb
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function run() {
  // --- normalizeMode ---------------------------------------------------------
  {
    check('normalizeMode 三个合法值原样通过', () => {
      for (const m of MODES) assert.equal(normalizeMode(m), m)
    })
    check('normalizeMode 未知值回落 copy（保守方向）', () => {
      for (const bad of ['bogus', '', 'ADOPT', null, undefined, 42, {}]) {
        assert.equal(normalizeMode(bad), 'copy', `输入 ${JSON.stringify(bad)} 应回落 copy`)
      }
    })
  }

  // --- workbuddy-state -------------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      const db = sb.seedDb()
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run('sess-live', 'D:\\p', '活着的会话', 'active')
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('sess-gone', 'D:\\p', '已删的会话', 'active', T0 + 9999)
      db.close()

      check('dbSessionId 剥掉 wb- 前缀', () => {
        assert.equal(dbSessionId('wb-abc'), 'abc')
        assert.equal(dbSessionId('abc'), 'abc')
      })
      check('readWorkbuddyState 认出软删除的会话', () => {
        const states = readWorkbuddyState(['wb-sess-live', 'wb-sess-gone'], { workbuddyRoot: sb.wbRoot })
        assert.equal(states.get('wb-sess-live').deletedAt, null)
        assert.equal(states.get('wb-sess-gone').deletedAt, T0 + 9999)
        assert.equal(isDeletedInWorkBuddy(states.get('wb-sess-gone')), true)
        assert.equal(isDeletedInWorkBuddy(states.get('wb-sess-live')), false)
      })
      check('readWorkbuddyState 带上库里的标题', () => {
        const states = readWorkbuddyState(['wb-sess-live'], { workbuddyRoot: sb.wbRoot })
        assert.equal(states.get('wb-sess-live').title, '活着的会话')
      })
      check('库里没有的行不出现在结果里（且不抛）', () => {
        const states = readWorkbuddyState(['wb-nope'], { workbuddyRoot: sb.wbRoot })
        assert.equal(states.has('wb-nope'), false)
      })
      check('未查到状态时按「未删除」处理', () => {
        assert.equal(isDeletedInWorkBuddy(undefined), false)
      })
    } finally {
      sb.restore()
    }

    const sb2 = makeSandbox()
    try {
      check('库不存在时退化成空表而不是抛错', () => {
        assert.equal(existsSync(workbuddyDbPath(sb2.wbRoot)), false)
        const states = readWorkbuddyState(['wb-anything'], { workbuddyRoot: sb2.wbRoot })
        assert.equal(states.size, 0)
      })
      check('空 id 列表直接返回，不打开库', () => {
        assert.equal(readWorkbuddyState([], { workbuddyRoot: sb2.wbRoot }).size, 0)
      })
    } finally {
      sb2.restore()
    }
  }

  // --- dsh-reader ------------------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      sb.seed('proj', [{ id: 'sess-1', cwd: 'D:\\proj', rounds: 2 }])
      const candidates = collectCandidates(sb.wbRoot)
      const result = importCandidates(candidates, { sessionsRoot: sb.sessionsRoot, apply: true })
      const artifact = result.imported[0].path

      check('多帧 zstd 能被完整切分', () => {
        const frames = [...zstdFrames(readFileSync(artifact))]
        assert.ok(frames.length >= 2, `帧数应 >= 2，实为 ${frames.length}`)
        assert.equal(frames.at(-1).end, readFileSync(artifact).length, '末帧终点必须对齐文件长度')
      })
      check('追加一帧后切分仍对齐', () => {
        const before = [...zstdFrames(readFileSync(artifact))].length
        appendFrame(artifact, [JSON.stringify({ type: 'user/message', seq: 999, data: {} })])
        const after = [...zstdFrames(readFileSync(artifact))]
        assert.equal(after.length, before + 1)
        assert.equal(after.at(-1).end, readFileSync(artifact).length)
      })
      check('readDshSession 回读出 header 与事件的全部内容', () => {
        const session = readDshSession(artifact)
        assert.equal(session.header.id, 'wb-sess-1')
        assert.equal(session.header.version, 4)
        assert.ok(session.events.length >= 4)
        // 追加的那一帧也要读得到 —— 回写靠这个
        assert.equal(session.events.at(-1).seq, 999)
      })
      check('findSessionArtifact 能反查到产物路径', () => {
        assert.equal(findSessionArtifact(sb.sessionsRoot, 'wb-sess-1'), artifact)
        assert.equal(findSessionArtifact(sb.sessionsRoot, 'wb-nope'), undefined)
      })
    } finally {
      sb.restore()
    }

    check('decodeZstdFrames 把多帧拼成完整文本', () => {
      const a = zstdCompressSync(Buffer.from('line-a\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
      const b = zstdCompressSync(Buffer.from('line-b\n'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
      const text = decodeZstdFrames(Buffer.concat([a, b]))
      assert.equal(text, 'line-a\nline-b\n')
    })
  }

  // --- watermark -------------------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      const dir = join(sb.root, 'wm')
      check('没有水位线时读到 -1（全部待同步）', () => {
        assert.equal(readWatermark(dir).lastSeq, -1)
      })
      check('水位线写入后能原样读回', () => {
        writeWatermark(dir, { lastSeq: 41, appended: 3 })
        const wm = readWatermark(dir)
        assert.equal(wm.lastSeq, 41)
        assert.equal(wm.appended, 3)
      })
      check('水位线在会话目录不存在时会自动创建', () => {
        const nested = join(sb.root, 'a', 'b', 'c')
        writeWatermark(nested, { lastSeq: 7 })
        assert.equal(readWatermark(nested).lastSeq, 7)
      })
    } finally {
      sb.restore()
    }
  }

  // --- adopt -----------------------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      const db = sb.seedDb()
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run('sess-adopt', 'D:\\p', '待接管', 'active')
      db.close()
      sb.seed('proj', [{ id: 'sess-adopt', cwd: 'D:\\p', rounds: 1 }])
      const source = join(sb.wbRoot, 'proj', 'sess-adopt.jsonl')
      const archiveRoot = adoptArchiveRoot()

      check('接管：源文件移走、归档落盘、db 打上软删除', () => {
        const r = adoptSession({ id: 'wb-sess-adopt', source, workbuddyRoot: sb.wbRoot, archiveRoot })
        assert.equal(existsSync(source), false, '源文件应已移走')
        assert.equal(existsSync(r.archived), true, '归档文件应存在')
        assert.equal(r.softDeleted, true)
        assert.equal(r.alreadyDeleted, false)
        const chk = new DatabaseSync(workbuddyDbPath(sb.wbRoot), { readOnly: true })
        assert.notEqual(chk.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('sess-adopt').deleted_at, null)
        chk.close()
      })
      check('接管清单里有这条，且标记为仍在', () => {
        const list = listAdopted(archiveRoot)
        const entry = list.find(e => e.id === 'wb-sess-adopt')
        assert.ok(entry !== undefined)
        assert.equal(entry.present, true)
        assert.equal(entry.source, source)
      })
      check('恢复：文件回原位、软删除清空、清单移除', () => {
        const r = restoreAdopted({ id: 'wb-sess-adopt', archiveRoot, workbuddyRoot: sb.wbRoot })
        assert.equal(existsSync(source), true, '源文件应已归位')
        assert.equal(r.unDeleted, true)
        const chk = new DatabaseSync(workbuddyDbPath(sb.wbRoot), { readOnly: true })
        assert.equal(chk.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('sess-adopt').deleted_at, null)
        chk.close()
        assert.equal(listAdopted(archiveRoot).find(e => e.id === 'wb-sess-adopt'), undefined)
      })
      check('归档目标已存在时拒绝覆盖', () => {
        sb.seed('proj', [{ id: 'sess-adopt2', cwd: 'D:\\p', rounds: 1 }])
        const source2 = join(sb.wbRoot, 'proj', 'sess-adopt2.jsonl')
        // 先在归档位上放个文件，逼出「拒绝覆盖」分支
        writeFileSync(join(archiveRoot, 'wb-sess-adopt2.jsonl'), 'stub\n')
        assert.throws(
          () => adoptSession({ id: 'wb-sess-adopt2', source: source2, workbuddyRoot: sb.wbRoot, archiveRoot }),
          /拒绝覆盖/,
        )
        assert.equal(existsSync(source2), true, '被拒绝时源文件必须原封不动')
      })
    } finally {
      sb.restore()
    }

    const sb2 = makeSandbox()
    try {
      sb2.seed('proj', [{ id: 'sess-x', cwd: 'D:\\p', rounds: 1 }])
      const outside = join(sb2.root, 'outside.jsonl')
      writeFileSync(outside, 'x\n')
      check('源文件在 WorkBuddy 根目录之外时拒绝接管', () => {
        assert.throws(
          () => adoptSession({ id: 'wb-sess-x', source: outside, workbuddyRoot: sb2.wbRoot }),
          /不在 .* 之内/,
        )
        assert.equal(existsSync(outside), true, '被拒绝时源文件必须原封不动')
      })
      check('源文件不存在时拒绝接管', () => {
        assert.throws(
          () => adoptSession({ id: 'wb-x', source: join(sb2.root, 'nope.jsonl'), workbuddyRoot: sb2.wbRoot }),
          /已不存在/,
        )
      })
      check('清单里没有的 id 拒绝恢复', () => {
        assert.throws(() => restoreAdopted({ id: 'wb-nothing' }), /没有/)
      })
    } finally {
      sb2.restore()
    }
  }

  // --- import-core: 模式行为 -------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      const db = sb.seedDb()
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run('sess-copy', 'D:\\p', 'A', 'active')
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run('sess-take', 'D:\\p', 'B', 'active')
      db.close()
      sb.seed('proj', [
        { id: 'sess-copy', cwd: 'D:\\p', rounds: 1 },
        { id: 'sess-take', cwd: 'D:\\p', rounds: 1 },
      ])
      const copySource = join(sb.wbRoot, 'proj', 'sess-copy.jsonl')
      const takeSource = join(sb.wbRoot, 'proj', 'sess-take.jsonl')

      const candidates = collectCandidates(sb.wbRoot)
      const byId = new Map(candidates.map(c => [c.id, c]))
      const result = importCandidates(
        [byId.get('wb-sess-copy')],
        { sessionsRoot: sb.sessionsRoot, workbuddyRoot: sb.wbRoot, apply: true, mode: 'copy' },
      )

      check('copy 模式：源文件原封不动', () => {
        assert.equal(result.imported.length, 1)
        assert.equal(existsSync(copySource), true)
      })
      check('copy 模式也刻水位线（为将来切 sync 留路）', () => {
        const dir = dirname(result.imported[0].path)
        assert.equal(readWatermark(dir).lastSeq, result.imported[0].events.length - 1)
      })
      check('水位线落在会话目录里、与产物同级', () => {
        const dir = dirname(result.imported[0].path)
        assert.equal(existsSync(join(dir, CURRENT_ARTIFACT_FILENAME)), true)
        assert.ok(readWatermark(dir).lastSeq >= 0)
      })

      const adopted = importCandidates(
        [byId.get('wb-sess-take')],
        { sessionsRoot: sb.sessionsRoot, workbuddyRoot: sb.wbRoot, apply: true, mode: 'adopt' },
      )
      check('adopt 模式：导入成功后源文件被归档', () => {
        assert.equal(adopted.imported.length, 1)
        assert.equal(existsSync(takeSource), false)
        assert.equal(adopted.imported[0].adopted.softDeleted, true)
        assert.equal(adopted.adoptFailed.length, 0)
      })
      check('result.mode 回显实际生效的模式', () => {
        assert.equal(result.mode, 'copy')
        assert.equal(adopted.mode, 'adopt')
      })

      const retry = importCandidates(
        [{ ...byId.get('wb-sess-take'), file: join(sb.wbRoot, 'proj', 'sess-take.jsonl') }],
        { sessionsRoot: sb.sessionsRoot, workbuddyRoot: sb.wbRoot, apply: true, mode: 'adopt' },
      )
      check('重复导入进 existing 桶，不会二次接管', () => {
        assert.equal(retry.imported.length, 0)
        assert.equal(retry.existing.length, 1)
      })
    } finally {
      sb.restore()
    }

    const sb3 = makeSandbox()
    try {
      sb3.seed('proj', [{ id: 'sess-af', cwd: 'D:\\p', rounds: 1 }])
      const candidates = collectCandidates(sb3.wbRoot)
      const bad = [{ ...candidates[0], file: join(sb3.root, 'outside.jsonl') }]
      writeFileSync(bad[0].file, 'x\n')
      const r = importCandidates(bad, {
        sessionsRoot: sb3.sessionsRoot, workbuddyRoot: sb3.wbRoot, apply: true, mode: 'adopt',
      })
      check('接管越界：会话仍算导入成功，失败单独进 adoptFailed', () => {
        assert.equal(r.imported.length, 1, 'DSH 里已经有了，不能算失败')
        assert.equal(r.failed.length, 0)
        assert.equal(r.adoptFailed.length, 1)
        assert.match(r.adoptFailed[0].error, /之内/)
      })
    } finally {
      sb3.restore()
    }
  }

  // --- sync back -------------------------------------------------------------
  {
    const sb = makeSandbox()
    try {
      sb.seed('proj', [{ id: 'sess-sync', cwd: 'D:\\p', rounds: 2 }])
      const source = join(sb.wbRoot, 'proj', 'sess-sync.jsonl')
      const before = readFileSync(source, 'utf8')
      const candidates = collectCandidates(sb.wbRoot)
      const result = importCandidates(candidates, { sessionsRoot: sb.sessionsRoot, apply: true, mode: 'sync' })
      const artifact = result.imported[0].path
      const sessionDir = dirname(artifact)

      check('sync 模式导入后源文件仍在（不归档）', () => {
        assert.equal(existsSync(source), true)
        assert.equal(readFileSync(source, 'utf8'), before, '导入本身不应改动源文件')
      })

      const wm = readWatermark(sessionDir)
      const rounds = 3
      const extra = []
      let seq = wm.lastSeq + 1
      for (let i = 0; i < rounds; i++) {
        extra.push(JSON.stringify({
          type: 'user/message', seq: seq++,
          time: T0 + 100000 + i * 1000,
          data: { content: [{ type: 'text', text: `DSH 新增问题 ${i + 1}` }] },
        }))
        extra.push(JSON.stringify({
          type: 'assistant/message', seq: seq++,
          time: T0 + 100500 + i * 1000,
          data: { message: { content: [{ type: 'text', text: `DSH 新增回答 ${i + 1}` }] } },
        }))
      }
      appendFrame(artifact, extra)

      const syncResult = syncBack({
        id: 'wb-sess-sync', source, sessionsRoot: sb.sessionsRoot, cwd: 'D:\\p',
      })
      check('回写只追加水位线之后的内容', () => {
        assert.equal(syncResult.appended, rounds * 2, `应追加 ${rounds * 2} 行，实为 ${syncResult.appended}`)
        assert.equal(syncResult.lastSeq, seq - 1)
      })
      check('回写把新内容真的写进了源 jsonl', () => {
        const after = readFileSync(source, 'utf8')
        assert.ok(after.startsWith(before), '原文必须原样保留')
        assert.ok(after.includes('DSH 新增问题 1'))
        assert.ok(after.includes('DSH 新增回答 3'))
      })
      check('回写后源 jsonl 每行都是合法 JSON', () => {
        const lines = readFileSync(source, 'utf8').split('\n').filter(l => l.trim().length > 0)
        for (const line of lines) JSON.parse(line)
        assert.ok(lines.length > 0)
      })
      check('水位线推进，二次回写不重复追加', () => {
        assert.equal(readWatermark(sessionDir).lastSeq, seq - 1)
        const again = syncBack({ id: 'wb-sess-sync', source, sessionsRoot: sb.sessionsRoot })
        assert.equal(again.appended, 0)
        const after = readFileSync(source, 'utf8')
        assert.equal(after.split('DSH 新增问题 1').length - 1, 1, '同一句只能出现一次')
      })
    } finally {
      sb.restore()
    }

    const sb2 = makeSandbox()
    try {
      sb2.seed('proj', [{ id: 'sess-nw', cwd: 'D:\\p', rounds: 1 }])
      const source = join(sb2.wbRoot, 'proj', 'sess-nw.jsonl')
      const candidates = collectCandidates(sb2.wbRoot)
      const artifact = importCandidates(candidates, { sessionsRoot: sb2.sessionsRoot, apply: true }).imported[0].path
      // 手抹水位线，模拟「导入早于水位线功能」的旧产物
      rmSync(join(dirname(artifact), 'workbuddy-sync.json'), { force: true })
      check('没有水位线时拒绝回写（否则会重复追加整段历史）', () => {
        assert.throws(
          () => syncBack({ id: 'wb-sess-nw', source, sessionsRoot: sb2.sessionsRoot }),
          /没有水位线/,
        )
        assert.equal(readFileSync(source, 'utf8').includes('问题 1'), true)
      })
      // 水位线功能之前导入的会话：补刻到最后一条，等于是说「现有内容都是从
      // WorkBuddy 拷来的，已经同步过了」。这是 --stamp 的语义，必须钉死。
      check('补刻水位线后，现有内容不回写、后续新增才回写', () => {
        const dir = dirname(artifact)
        const events = readDshSession(artifact).events
        writeWatermark(dir, { lastSeq: events.at(-1).seq })
        const first = syncBack({ id: 'wb-sess-nw', source, sessionsRoot: sb2.sessionsRoot })
        assert.equal(first.appended, 0, '现有内容不该被重复追加')

        appendFrame(artifact, [JSON.stringify({
          type: 'user/message', seq: events.at(-1).seq + 1,
          data: { content: [{ type: 'text', text: '补刻之后的新问题' }] },
        })])
        const second = syncBack({ id: 'wb-sess-nw', source, sessionsRoot: sb2.sessionsRoot })
        assert.equal(second.appended, 1, '补刻之后新增的内容应当回写')
        assert.ok(readFileSync(source, 'utf8').includes('补刻之后的新问题'))
      })
      check('源文件已被接管归档时拒绝回写', () => {
        assert.throws(
          () => syncBack({ id: 'wb-sess-nw', source: join(sb2.root, 'gone.jsonl'), sessionsRoot: sb2.sessionsRoot }),
          /源文件已不存在/,
        )
      })
      check('DSH 侧没产物时拒绝回写', () => {
        assert.throws(
          () => syncBack({ id: 'wb-nothing', source, sessionsRoot: sb2.sessionsRoot }),
          /先导入再同步/,
        )
      })
    } finally {
      sb2.restore()
    }
  }

  return results
}
