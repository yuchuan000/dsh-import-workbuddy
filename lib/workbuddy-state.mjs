/**
 * 读 WorkBuddy 的权威会话注册表（~/.workbuddy/workbuddy.db）。
 *
 * 为什么需要它：projects/ 下的 jsonl 只是轨迹文件，用户在 WorkBuddy 里点
 * 「删除」是**软删除**——只写 sessions.deleted_at，jsonl 原封不动留在磁盘
 * 上。只扫文件系统就会把这些已经删掉的会话又列出来导回去，也就是 README 里
 * 那个「全量导入复活已删会话」的口子，只是之前靠「绝不自动全选」绕开，没有
 * 真正识别。
 *
 * 全部只读打开：列举是高频操作，绝不能因为 WorkBuddy 正在写库而失败或加锁。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { defaultWorkBuddyRoot } from './workbuddy-reader.mjs'

/**
 * WorkBuddy 主库路径。
 *
 * @param {string} [workbuddyRoot] projects 目录；库在它的同级
 */
export function workbuddyDbPath(workbuddyRoot = defaultWorkBuddyRoot()) {
  return join(dirname(workbuddyRoot), 'workbuddy.db')
}

/** 候选 id（`wb-<uuid>`）→ 库里的主键（`<uuid>`）。 */
export function dbSessionId(candidateId) {
  return candidateId.replace(/^wb-/, '')
}

/**
 * 批量读会话状态。
 *
 * 库不存在、表不存在、或者库正被占用，都退化成「查不到」而不是抛错：列举
 * 会话是页面的首要功能，不能因为读不到注册表就整个不可用。查不到时调用方
 * 应当按「未删除」处理——这是保守方向，不会漏掉用户真正想导入的会话。
 *
 * @param {string[]} candidateIds `wb-<uuid>` 列表
 * @param {object} [options]
 * @param {string} [options.workbuddyRoot]
 * @returns {Map<string, { deletedAt: number | null, title: string | null, status: string | null }>}
 */
export function readWorkbuddyState(candidateIds, options = {}) {
  const states = new Map()
  const dbPath = workbuddyDbPath(options.workbuddyRoot)
  if (!existsSync(dbPath) || candidateIds.length === 0) return states

  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
  } catch {
    return states // 库被独占/损坏：退化，不拖垮列举
  }

  try {
    const statement = db.prepare(
      'SELECT id, title, status, deleted_at FROM sessions WHERE id = ?',
    )
    for (const candidateId of candidateIds) {
      try {
        const row = statement.get(dbSessionId(candidateId))
        if (row === undefined) continue
        states.set(candidateId, {
          deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
          title: row.title === null || row.title === undefined ? null : String(row.title),
          status: row.status === null || row.status === undefined ? null : String(row.status),
        })
      } catch { /* 单条查失败不影响其它条 */ }
    }
  } catch {
    // 表结构变了（比如新版 WorkBuddy 改了列名）：整体退化。
    return new Map()
  } finally {
    try { db.close() } catch { /* best effort */ }
  }

  return states
}

/** 单个候选是否已在 WorkBuddy 侧被删除。 */
export function isDeletedInWorkBuddy(state) {
  return state !== undefined && state.deletedAt !== null
}
