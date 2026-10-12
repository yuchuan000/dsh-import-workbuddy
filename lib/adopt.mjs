/**
 * 接管（adopt）模式：把会话从 WorkBuddy 挪到 DSH，而不是复制一份。
 *
 * 拷贝模式的代价是分叉：WorkBuddy 里那份停在导入那一刻，DSH 里这份继续往下
 * 走，同一个对话在磁盘上变成两份互不相干的历史。接管模式把源轨迹归档走、
 * 在 WorkBuddy 的注册表里打上软删除，让 DSH 成为唯一归属。
 *
 * 两件事必须一起做，只做一半会更糟：
 *   - 只归档 jsonl：WorkBuddy 列表里条目还在（标题来自 db），点进去轨迹没了。
 *   - 只软删除：磁盘上还留着 103KB 的 jsonl，就是白占空间。
 *
 * 归档目录落在 DSH_HOME 而不是 ~/.workbuddy 下：WorkBuddy 会扫自己的目录，
 * 把归档文件放回去有被重新识别的风险。
 *
 * 操作全程可逆：归档目录留着原文件，manifest 记着原路径，restoreAdopted 能
 * 把文件放回去并把 deleted_at 清成 NULL。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { dshHome } from './util.mjs'
import { dbSessionId, workbuddyDbPath } from './workbuddy-state.mjs'

const MANIFEST_NAME = 'manifest.json'
const MANIFEST_VERSION = 1

/** 归档根目录（默认 ~/.dsh/workbuddy-adopted）。 */
export function adoptArchiveRoot() {
  return join(dshHome(), 'workbuddy-adopted')
}

function manifestPath(archiveRoot) {
  return join(archiveRoot, MANIFEST_NAME)
}

/** 读归档清单；不存在或损坏时返回空清单。 */
export function readAdoptManifest(archiveRoot = adoptArchiveRoot()) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(archiveRoot), 'utf8'))
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.entries !== 'object') return { entries: {} }
    return { entries: parsed.entries ?? {} }
  } catch {
    return { entries: {} }
  }
}

function writeAdoptManifest(archiveRoot, entries) {
  mkdirSync(archiveRoot, { recursive: true })
  writeFileSync(manifestPath(archiveRoot), JSON.stringify({ version: MANIFEST_VERSION, entries }, null, 2))
}

/**
 * source 必须落在 workbuddyRoot 之内。
 *
 * 与 dsh-session-recycle 的回收站同一个教训：rename/删除路径来自外部数据
 * （这里来自扫描结果，但仍要挡住越界与符号链接逃逸），不校验就是任意文件
 * 搬运漏洞。
 */
function assertInside(root, target, what) {
  const outer = resolve(root)
  const inner = resolve(target)
  if (inner === outer || !inner.startsWith(outer + '\\') && !inner.startsWith(outer + '/')) {
    throw new Error(`${what} 不在 ${outer} 之内: ${inner}`)
  }
}

/** 打开主库做一次写操作；库不存在或正被独占时抛错由调用方归类。 */
function withWriteDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath, { timeout: 5000 })
  try {
    return fn(db)
  } finally {
    try { db.close() } catch { /* best effort */ }
  }
}

/**
 * 接管一个已导入的会话。
 *
 * @param {object} params
 * @param {string} params.id 候选 id（wb-<uuid>）
 * @param {string} params.source WorkBuddy 源 jsonl 的绝对路径
 * @param {string} [params.workbuddyRoot] 用于越界校验
 * @param {string} [params.archiveRoot]
 * @param {string} [params.cwd] 记进清单，恢复时展示用
 * @param {number} [params.now]
 * @returns {{ archived: string, source: string, softDeleted: boolean, alreadyDeleted: boolean }}
 * @throws 源不存在、越界、归档目标已存在时抛错（调用方计入 failed）
 */
export function adoptSession(params) {
  const {
    id,
    source,
    workbuddyRoot,
    archiveRoot = adoptArchiveRoot(),
    cwd = null,
    now = Date.now(),
  } = params

  if (typeof id !== 'string' || id.length === 0) throw new Error('id 不能为空')
  if (typeof source !== 'string' || source.length === 0) throw new Error('source 不能为空')
  if (!existsSync(source)) throw new Error(`源文件已不存在: ${source}`)
  if (workbuddyRoot !== undefined) assertInside(workbuddyRoot, source, '源文件')

  mkdirSync(archiveRoot, { recursive: true })
  const archived = join(archiveRoot, `${id}.jsonl`)
  if (existsSync(archived)) throw new Error(`归档目标已存在，拒绝覆盖: ${archived}`)

  // 先搬文件，再动库：文件搬成功了但库没写成，状态是可诊断的（归档在、列表还在），
  // 反过来则是「列表没了、文件也没了」。
  renameSync(source, archived)

  const entries = readAdoptManifest(archiveRoot).entries
  entries[id] = { source, archived, archivedAt: now, cwd }
  writeAdoptManifest(archiveRoot, entries)

  let softDeleted = false
  let alreadyDeleted = false
  const dbPath = workbuddyDbPath(workbuddyRoot)
  if (existsSync(dbPath)) {
    try {
      withWriteDb(dbPath, (db) => {
        const row = db.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get(dbSessionId(id))
        if (row === undefined) return
        if (row.deleted_at !== null && row.deleted_at !== undefined) {
          alreadyDeleted = true
          return
        }
        db.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(now, dbSessionId(id))
        softDeleted = true
      })
    } catch (error) {
      // 库写不进去（WorkBuddy 正开着并持有写锁）不该让整个接管失败：文件已经
      // 归好档了，把原因带回去让界面提示用户关掉 WorkBuddy 再补一次。
      entries[id].dbError = error?.message ?? String(error)
      writeAdoptManifest(archiveRoot, entries)
    }
  }

  return { archived, source, softDeleted, alreadyDeleted }
}

/**
 * 恢复一个被接管的会话：文件放回原处，软删除标记清掉。
 *
 * @param {object} params
 * @param {string} params.id
 * @param {string} [params.archiveRoot]
 * @param {string} [params.workbuddyRoot]
 * @returns {{ restored: string, unDeleted: boolean }}
 */
export function restoreAdopted(params) {
  const { id, archiveRoot = adoptArchiveRoot(), workbuddyRoot } = params
  const entries = readAdoptManifest(archiveRoot).entries
  const entry = entries[id]
  if (entry === undefined) throw new Error(`归档清单里没有 ${id}`)

  const archived = entry.archived ?? join(archiveRoot, `${id}.jsonl`)
  if (!existsSync(archived)) throw new Error(`归档文件已丢失: ${archived}`)

  const source = entry.source
  if (source === undefined) throw new Error(`清单缺少原始路径，无法安全恢复: ${id}`)
  if (workbuddyRoot !== undefined) assertInside(workbuddyRoot, source, '恢复目标')
  if (existsSync(source)) throw new Error(`原位置已经有文件，拒绝覆盖: ${source}`)

  mkdirSync(dirname(source), { recursive: true })
  renameSync(archived, source)

  let unDeleted = false
  const dbPath = workbuddyDbPath(workbuddyRoot)
  if (existsSync(dbPath)) {
    try {
      withWriteDb(dbPath, (db) => {
        const result = db.prepare('UPDATE sessions SET deleted_at = NULL WHERE id = ?').run(dbSessionId(id))
        unDeleted = result.changes > 0
      })
    } catch { /* 文件已归位；库标记让用户自己去 WorkBuddy 里恢复 */ }
  }

  delete entries[id]
  writeAdoptManifest(archiveRoot, entries)

  return { restored: source, unDeleted }
}

/** 清单里所有被接管的会话 id。 */
export function listAdopted(archiveRoot = adoptArchiveRoot()) {
  return Object.entries(readAdoptManifest(archiveRoot).entries).map(([id, entry]) => ({
    id,
    archived: entry.archived ?? join(archiveRoot, `${id}.jsonl`),
    source: entry.source ?? null,
    archivedAt: entry.archivedAt ?? null,
    cwd: entry.cwd ?? null,
    present: existsSync(entry.archived ?? join(archiveRoot, `${id}.jsonl`)),
  }))
}
