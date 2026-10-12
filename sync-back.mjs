#!/usr/bin/env node
/**
 * 同步（sync）模式的另一半：把 DSH 里新增的对话回写到 WorkBuddy 的原 jsonl。
 *
 * 设置页上的「回写所选」按钮走 host 的 /sync 路由，这里走同一条
 * lib/sync-back.mjs，两种入口不可能走出两种结果。
 *
 * 用法:
 *   node sync-back.mjs --list            看哪些会话可以回写、各有多少待写内容
 *   node sync-back.mjs --only <ids>      只回写这些 id（逗号/空格分隔）
 *   node sync-back.mjs --all             回写全部可同步的会话
 *   node sync-back.mjs --stamp --all     给早先导入的会话补刻水位线
 *
 * 只追加水位线之后的事件，所以重复运行是安全的：第二次就是 0 行。
 *
 * `--stamp` 是给水印功能之前就导入过的会话准备的：那些会话在 DSH 里的内容
 * 本来就是从 WorkBuddy 拷过来的，整个都算「已同步」，只是当时没记下来。补刻
 * 之后它们就进入同步模式；不补刻的话 syncBack 会一直拒绝回写（宁可不动，
 * 也不能把整段历史重复追加进原文件）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { collectCandidates } from './lib/import-core.mjs'
import { findSessionArtifact, readDshSession } from './lib/dsh-reader.mjs'
import { readWatermark, syncBack, writeWatermark } from './lib/sync-back.mjs'
import { dshHome, log, parseArgs } from './lib/util.mjs'
import { defaultWorkBuddyRoot } from './lib/workbuddy-reader.mjs'

const USAGE = `用法:
  node sync-back.mjs [options]

把 DSH 里新增的对话回写到 WorkBuddy 的原 jsonl（sync 模式的另一半）。
只追加水位线之后的事件，重复运行安全。

options:
  --list                只打印可回写的会话与待写事件数，不写入
  --only <ids>          只回写这些 id（逗号/空格分隔，可省略 wb- 前缀）
  --all                 回写全部可同步的会话
  --stamp               只补刻水位线、不回写（给水印功能之前导入的会话用，
                        把它们现有内容整体视为「已同步」）
  --sessions-root <dir> 会话存储根目录（默认 $DSH_HOME/sessions）
  --workbuddy-root <dir> WorkBuddy 会话根目录（默认 ~/.workbuddy/projects）
`

const STATE_LABEL = {
  ok: '待写 {n} 条',
  'not-imported': 'DSH 里还没有（先导入）',
  'no-watermark': '没有水位线（重新导入一次就会刻上）',
  'source-gone': '源文件已被接管归档',
}

function splitIds(value) {
  if (value === undefined) return undefined
  return String(value).split(/[\s,，、]+/).map(s => s.trim()).filter(s => s.length > 0)
}

/**
 * 一个会话当前有多少待回写的内容。
 *
 * 四种状态要说清楚：「没有水位线」和「源文件已归档」不是错误，是两种不同
 * 的前置条件没满足，混在一起报「失败」会让人不知道该去做什么。
 */
function inspect(candidate, sessionsRoot) {
  const artifact = findSessionArtifact(sessionsRoot, candidate.id)
  if (artifact === undefined) return { state: 'not-imported', pending: 0 }
  const watermark = readWatermark(join(artifact, '..'))
  if (watermark.lastSeq < 0) return { state: 'no-watermark', pending: 0 }
  if (!existsSync(candidate.file)) return { state: 'source-gone', pending: 0 }
  const events = readDshSession(artifact).events
  return {
    state: 'ok',
    pending: events.filter(e => typeof e.seq === 'number' && e.seq > watermark.lastSeq).length,
  }
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2), {})
  if (flags.help || positionals.length > 0) {
    process.stdout.write(USAGE)
    if (flags.help) return
  }

  const sessionsRoot = flags['sessions-root'] ?? join(dshHome(), 'sessions')
  const workbuddyRoot = flags['workbuddy-root'] ?? defaultWorkBuddyRoot()
  const only = splitIds(flags.only)

  const candidates = collectCandidates(workbuddyRoot)
  let targets = candidates
  if (only !== undefined) {
    const wanted = new Set(only)
    targets = targets.filter(c => wanted.has(c.id) || wanted.has(c.id.replace(/^wb-/, '')))
    if (targets.length === 0) {
      log(`[sync] --only 没匹配到任何候选会话: ${only.join(', ')}`)
      return
    }
  } else if (flags.all !== true && flags.list !== true) {
    // 与 import.mjs 同一个安全默认：不指定选择就不动任何文件。
    log('[sync] 请显式指定要回写的会话：--only <ids> 或 --all（先看 --list）')
    process.stdout.write(USAGE)
    return
  }

  if (flags.stamp === true) {
    let stamped = 0
    for (const candidate of targets) {
      const artifact = findSessionArtifact(sessionsRoot, candidate.id)
      if (artifact === undefined) continue
      const sessionDir = join(artifact, '..')
      if (readWatermark(sessionDir).lastSeq >= 0) continue // 已经有，别动
      const events = readDshSession(artifact).events
      const lastSeq = events.length === 0 ? -1 : (events.at(-1).seq ?? events.length - 1)
      if (lastSeq < 0) continue
      writeWatermark(sessionDir, { lastSeq })
      log(`  [刻线] ${candidate.id}  lastSeq=${lastSeq}（现有内容整体视为已同步）`)
      stamped += 1
    }
    log(`[sync] 已为 ${stamped} 个会话补刻水位线`)
    if (stamped === 0) log('[sync] 没有需要补刻的会话（都已经有水位线，或还没导入）')
    return
  }

  if (flags.list === true) {
    log(`[sync] 可回写清单（共 ${candidates.length} 个候选）\n`)
    for (const candidate of targets) {
      const info = inspect(candidate, sessionsRoot)
      const label = STATE_LABEL[info.state].replace('{n}', String(info.pending))
      log(`  ${candidate.id}  ${candidate.cwd ?? '(无 cwd)'}  ${label}`)
    }
    return
  }

  let written = 0
  let lines = 0
  const failed = []
  for (const candidate of targets) {
    try {
      const result = syncBack({
        id: candidate.id,
        source: candidate.file,
        sessionsRoot,
        cwd: candidate.cwd ?? undefined,
      })
      if (result.appended > 0) {
        log(`  [回写] ${candidate.id}  新增 ${result.appended} 行 -> ${result.path}`)
        written += 1
        lines += result.appended
      }
    } catch (error) {
      failed.push({ id: candidate.id, error: error?.message ?? String(error) })
      log(`  [失败] ${candidate.id}: ${error.message}`)
    }
  }

  log(`[sync] 结果: 回写 ${written} 个会话，共 ${lines} 行，失败 ${failed.length}`)
  if (written === 0 && failed.length === 0) log('[sync] 没有新增内容需要回写')
}

main().catch((error) => {
  log(`错误: ${error.message}`)
  process.exitCode = 1
})
