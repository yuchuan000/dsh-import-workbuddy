#!/usr/bin/env node
/**
 * WorkBuddy → DeepSeek Harness 会话导入 CLI。
 *
 * 用法:
 *   node import.mjs [options]
 *
 * 默认 --dry-run 只打印将要导入的内容；--apply 才真正写入
 * `$DSH_HOME/sessions` 下的会话产物。
 *
 * 导入的会话 id 是稳定的（wb-<workbuddy-session-uuid>），重复导入自动跳过。
 *
 * 导入完成后需要重启 dsh web / DSH 桌面端，GUI 会话列表才会刷新；
 * 想要归入工作区分组，再跑一次 attach-workspaces.mjs。
 */

import { join } from 'node:path'

import { dshHome, log, parseArgs, parseSince, truncate } from './lib/util.mjs'
import { findExistingSession, writeSession } from './lib/dsh-writer.mjs'
import { buildDshEvents, deriveImportTitle } from './lib/convert.mjs'
import { defaultWorkBuddyRoot, listWorkBuddySessions, parseWorkBuddySession, workbuddyTitle } from './lib/workbuddy-reader.mjs'

const USAGE = `用法:
  node import.mjs [options]

把 WorkBuddy（腾讯 CodeBuddy 桌面端）的本地会话导入 DeepSeek Harness。

options:
  --apply                真正写入（默认 --dry-run 只预览）
  --project <substr>     只导入 cwd 包含该子串的会话
  --since <iso|ms>       只导入创建时间不早于该值的会话
  --limit <n>            最多导入 n 个会话（按创建时间从新到旧）
  --no-tools             丢弃工具调用块（只留对话文本）
  --tools-as-text        工具调用转成纯文本（默认保留 tool-call 块并为每个
                         调用写入配对的 tool/call + tool/result 事件：
                         轨迹可见、恢复会话时模型请求合法）
  --truncate <n>         文本/推理块截断到 n 字符（默认不截断）
  --tool-truncate <n>    工具调用参数截断到 n 字符（默认 1000）
  --preview <n>          预览前 n 个事件（默认 1）
  --sessions-root <dir>  会话存储根目录（默认 $DSH_HOME/sessions）
  --workbuddy-root <dir> WorkBuddy 会话根目录（默认 ~/.workbuddy/projects，
                         可用 WORKBUDDY_HOME 覆盖）
  --title-prefix <str>   标题前缀（默认无；导入的会话标题与原生会话一致）
`

/** 把归一化消息流编译成 DSH 事件，并应用各 --no-tools / --truncate 选项。 */
function toEvents(messages, options) {
  const filtered = []
  for (const message of messages) {
    let blocks = message.blocks
    if (options.noTools) {
      blocks = blocks.filter(block => block.type !== 'tool-call')
    } else if (options.toolsAsText === true) {
      // 纯文本模式：不生成 tool/call + tool/result 事件（轨迹无工具卡片）。
      blocks = blocks.map((block) => {
        if (block.type === 'tool-call') {
          return { type: 'text', text: `[工具调用: ${block.name}]\n${block.arguments}` }
        }
        return block
      })
    }
    if (options.truncate !== undefined) {
      blocks = blocks.map((block) => {
        if (block.type === 'text' || block.type === 'reasoning') {
          return { ...block, text: truncate(block.text, options.truncate) }
        }
        return block
      })
    }
    if (options.toolTruncate !== undefined) {
      blocks = blocks.map((block) => {
        if (block.type === 'tool-call') return { ...block, arguments: truncate(block.arguments, options.toolTruncate) }
        return block
      })
    }
    filtered.push({ ...message, blocks })
  }
  return buildDshEvents(filtered, {
    toolEvents: options.noTools !== true && options.toolsAsText !== true,
    title: options.title,
    titlePinned: true,
  })
}

/** 导入 WorkBuddy 会话；返回各类结果计数。 */
function importWorkBuddy(options) {
  const candidates = []
  for (const entry of listWorkBuddySessions(options.workbuddyRoot)) {
    const parsed = parseWorkBuddySession(entry.file)
    if (parsed.header.id === undefined) continue
    candidates.push({
      file: entry.file,
      parsed,
      id: `wb-${parsed.header.id}`,
      cwd: parsed.header.cwd,
      createdAt: parsed.header.createdAt,
    })
  }

  let selected = candidates
  if (options.project !== undefined) {
    selected = selected.filter(c => typeof c.cwd === 'string' && c.cwd.includes(options.project))
  }
  if (options.since !== undefined) {
    selected = selected.filter(c => typeof c.createdAt === 'number' && c.createdAt >= options.since)
  }
  if (options.limit !== undefined) {
    selected = [...selected].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, options.limit)
  }
  log(`[workbuddy] 候选 ${selected.length}/${candidates.length} 个会话`)

  const existing = []
  const imported = []
  const empty = []
  const failed = []
  let previewDone = false

  for (const candidate of selected) {
    if (findExistingSession(options.sessionsRoot, candidate.id)) {
      existing.push(candidate)
      continue
    }
    try {
      const messages = candidate.parsed.messages
      if (messages.length === 0) {
        empty.push(candidate)
        continue
      }
      const sourceTitle = workbuddyTitle(messages)
      const baseTitle = deriveImportTitle(sourceTitle, messages, undefined)
      const title = options.titlePrefix !== undefined && baseTitle !== undefined
        ? `${options.titlePrefix}${baseTitle}`
        : baseTitle
      const events = toEvents(messages, { ...options, title })
      if (options.apply) {
        const path = writeSession(options.sessionsRoot, {
          id: candidate.id,
          createdAt: candidate.createdAt ?? messages[0].time,
          cwd: candidate.cwd,
        }, events)
        log(`  [写入] ${candidate.id}  ${candidate.cwd ?? '(无 cwd)'}  ${messages.length} 条消息 -> ${events.length} 事件 -> ${path}`)
      } else {
        log(`  [待导入] ${candidate.id}  ${candidate.cwd ?? '(无 cwd)'}  ${messages.length} 条消息 -> ${events.length} 事件`)
      }
      imported.push({ candidate, events })
      if (!previewDone && options.preview > 0) {
        previewDone = true
        log('  --- 事件预览 ---')
        for (let i = 0; i < Math.min(events.length, options.preview); i++) {
          log(`    [${i}] ${events[i].type}`)
        }
      }
    } catch (error) {
      failed.push({ candidate, error })
      log(`  [失败] ${candidate.id}: ${error.message}`)
    }
  }

  log(`[workbuddy] 结果: 新导入 ${imported.length}，已存在跳过 ${existing.length}，空会话 ${empty.length}，失败 ${failed.length}`)
  if (!options.apply && imported.length > 0) {
    log(`[workbuddy] 提示: 加上 --apply 才会写入 ${options.sessionsRoot}，随后重启 dsh web 生效`)
  }
  return { imported, existing, empty, failed }
}

function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2), {
    'dry-run': false,
    apply: false,
    preview: 1,
    'tool-truncate': 1000,
  })
  if (flags.help || positionals.length > 0) {
    process.stdout.write(USAGE)
    if (flags.help) return
  }
  const options = {
    apply: flags.apply === true,
    project: flags.project,
    since: parseSince(flags.since),
    limit: flags.limit === undefined ? undefined : Number(flags.limit),
    noTools: flags['no-tools'] === true,
    toolsAsText: flags['tools-as-text'] === true,
    truncate: flags.truncate === undefined ? undefined : Number(flags.truncate),
    toolTruncate: flags['tool-truncate'] === undefined ? 1000 : Number(flags['tool-truncate']),
    preview: Number(flags.preview ?? 1),
    sessionsRoot: flags['sessions-root'] ?? join(dshHome(), 'sessions'),
    workbuddyRoot: flags['workbuddy-root'] ?? defaultWorkBuddyRoot(),
    titlePrefix: flags['title-prefix'],
  }
  if (options.limit !== undefined && !Number.isInteger(options.limit)) throw new Error('--limit 必须是整数')
  if (options.truncate !== undefined && (!Number.isInteger(options.truncate) || options.truncate < 0)) throw new Error('--truncate 必须是非负整数')
  if (options.toolTruncate !== undefined && (!Number.isInteger(options.toolTruncate) || options.toolTruncate < 0)) throw new Error('--tool-truncate 必须是非负整数')
  if (options.truncate === 0) options.truncate = undefined
  if (options.toolTruncate === 0) options.toolTruncate = undefined

  log(`模式: ${options.apply ? '--apply（写入）' : '--dry-run（预览）'}`)
  log(`会话根: ${options.sessionsRoot}`)
  log(`WorkBuddy 根: ${options.workbuddyRoot}`)

  importWorkBuddy(options)
}

main()
