/**
 * 把导入的 WorkBuddy 会话挂进 DSH 的工作区分组。
 *
 * 为什么需要这一步：DSH 的分组**不是**由会话文件所在目录决定的，而是由一个
 * 独立的持久化注册表 `storages/workspace.json` 决定——
 *   workspaces[<id>] = { path, title, sessionIds: [...] }
 * 只有出现在某个 workspace 的 sessionIds 里的会话才会显示在该分组下；
 * 否则一律落到「未分组」。所以光把 session 文件写进 sessions/ 是不够的。
 *
 * 本脚本用 DSH 自己的服务做完这件事：
 *   1. workspaceRegistry.create(path, title)  —— 目录不存在则创建并注册
 *   2. workspace.attachSession(sessionId)     —— 校验 cwd 一致后挂上去
 *
 * attachSession 会校验会话 header 的 cwd 解析后必须等于工作区 path，
 * 且该 cwd 必须真实存在于磁盘上；因此 cwd 已被删除的会话无法归组
 * （--create-missing-dirs 可以补齐缺失目录，默认不补）。
 *
 * 用法（在 DSH 应用目录下运行，见 run-attach-workspaces.mjs）：
 *   node attach-workspaces.mjs [--apply] [--create-missing-dirs] [--prefix wb-]
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, statSync } from 'node:fs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const createMissingDirs = args.includes('--create-missing-dirs')
const prefixArg = args.find(a => a.startsWith('--prefix='))
const prefix = prefixArg !== undefined ? prefixArg.slice('--prefix='.length) : 'wb-'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const storagesRoot = join(dshHome, 'storages')

// 与 dsh-base 的 cordis.patch.yml 完全一致的挂载顺序：
// storage -> storage-json(root) -> storage-domain(backend: json) -> workspaceRegistry
const ctx = new Context()
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: storagesRoot })
await ctx.plugin(StorageDomain, { backend: 'json' })
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' })
await ctx.plugin(WorkspaceRegistry)
await new Promise(resolve => setTimeout(resolve, 800))

const registry = ctx.workspaceRegistry
if (registry === undefined) throw new Error('workspaceRegistry service unavailable')

// Collect target sessions with their header cwd.
const headers = (await ctx.sessionPersistence.list()).map(snapshot => snapshot.header)
const targets = headers.filter(h => String(h.id).startsWith(prefix))
console.log(`模式: ${apply ? '--apply（写入注册表）' : '--dry-run（预览）'}`)
console.log(`会话: ${targets.length} 个以 "${prefix}" 开头的会话\n`)

// Group by cwd.
const byCwd = new Map()
for (const header of targets) {
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) continue
  if (!byCwd.has(cwd)) byCwd.set(cwd, [])
  byCwd.get(cwd).push(header.id)
}

let created = 0
let attached = 0
let already = 0
const skipped = []

for (const [cwd, sessionIds] of [...byCwd].sort((a, b) => a[0].localeCompare(b[0]))) {
  let isDir = false
  try { isDir = statSync(cwd).isDirectory() } catch {}
  if (!isDir) {
    if (createMissingDirs) {
      try { mkdirSync(cwd, { recursive: true }); isDir = true } catch (error) {
        skipped.push([cwd, sessionIds.length, `mkdir failed: ${error.message}`])
        continue
      }
    } else {
      skipped.push([cwd, sessionIds.length, 'cwd 不存在于磁盘'])
      continue
    }
  }

  if (!apply) {
    console.log(`[待处理] ${cwd}  (${sessionIds.length} 个会话)`)
    continue
  }

  let workspace
  try {
    workspace = await registry.create(cwd)
  } catch (error) {
    skipped.push([cwd, sessionIds.length, `registry.create failed: ${error.message}`])
    continue
  }
  if (workspace === undefined) { skipped.push([cwd, sessionIds.length, 'create returned undefined']); continue }
  created += 1

  for (const sessionId of sessionIds) {
    try {
      const before = (registry.list() ?? []).find(w => w.id === workspace.id)?.sessionIds?.length ?? 0
      await workspace.attachSession(sessionId)
      const after = (registry.list() ?? []).find(w => w.id === workspace.id)?.sessionIds?.length ?? 0
      if (after > before) attached += 1
      else { already += 1 }
    } catch (error) {
      skipped.push([`${cwd} :: ${sessionId}`, 1, error.message.slice(0, 120)])
    }
  }
  const title = (registry.list() ?? []).find(w => w.id === workspace.id)?.title
  console.log(`[已归组] ${cwd}  -> 分组 "${title}"  (${sessionIds.length} 个会话)`)
}

console.log('')
if (apply) {
  console.log(`工作区: 处理 ${created} 个 | 会话挂载 新增 ${attached}，已存在 ${already}`)
} else {
  console.log(`以上为预览（${byCwd.size} 个分组）。加 --apply 真正写入。`)
}
if (skipped.length > 0) {
  console.log(`\n跳过 ${skipped.length} 项:`)
  for (const [what, count, why] of skipped.slice(0, 20)) console.log(`  ${what}  (${count})  -> ${why}`)
  if (skipped.length > 20) console.log(`  … 还有 ${skipped.length - 20} 项`)
}
