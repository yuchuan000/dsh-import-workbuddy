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

import { MODES, collectCandidates, importCandidates, normalizeMode } from './lib/import-core.mjs'
import { dshHome, log, parseArgs, parseSince } from './lib/util.mjs'
import { defaultWorkBuddyRoot } from './lib/workbuddy-reader.mjs'
import { excludeByIds, filterByIds, printCandidates, selectInteractively } from './lib/select.mjs'

const USAGE = `用法:
  node import.mjs [options]

把 WorkBuddy（腾讯 CodeBuddy 桌面端）的本地会话导入 DeepSeek Harness。

会话选择（默认在终端里交互式勾选；管道/脚本里请用 --only 或 --all）:
  （无选择参数）           在终端里列出所有会话，让你勾选要导入的
  --list                 只打印候选清单（带序号），不导入
  --only <ids>           只导入这些 id（逗号/空格分隔，可省略 wb- 前缀）
  --exclude <ids>        排除这些 id（与 --only 同用时先取 --only 再排除）
  --all                  导入全部候选（显式全量；非交互环境必须显式指定）

归属方式（默认 copy，与设置页的下拉同一组语义）:
  --mode <copy|adopt|sync>
          copy    只读源文件，在 DSH 里写一份新的（默认）
          adopt   导入后把源文件归档到 ~/.dsh/workbuddy-adopted 并在
                  WorkBuddy 注册表里打软删除，DSH 成为唯一一份
          sync    源文件不动；DSH 里新增的内容可用 sync-back.mjs 回写进去

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

/**
 * 解析出最终要导入的会话集合。
 *
 * 顺序：候选全量 → --project/--since 粗筛 → --only/--exclude 精确筛 →
 * 交互式勾选（当没有任何显式选择参数时）→ --limit 截断。
 *
 * 安全默认：交互模式初始全不选；非交互环境不给 --all 就报错，
 * 杜绝"什么都不指定却全量导入"。
 */
async function resolveSelection(candidates, options) {
  let selected = candidates

  if (options.project !== undefined) {
    selected = selected.filter(c => typeof c.cwd === 'string' && c.cwd.includes(options.project))
  }
  if (options.since !== undefined) {
    selected = selected.filter(c => typeof c.createdAt === 'number' && c.createdAt >= options.since)
  }

  const hasOnly = options.only !== undefined && options.only.length > 0
  const hasExclude = options.exclude !== undefined && options.exclude.length > 0
  const explicit = hasOnly || options.all === true

  if (hasOnly) {
    const { selected: hit, missing } = filterByIds(selected, options.only)
    if (missing.length > 0) {
      log(`[workbuddy] 警告: --only 里这些 id 没有匹配到候选会话: ${missing.join(', ')}`)
    }
    selected = hit
  }
  if (hasExclude) {
    const before = selected.length
    selected = excludeByIds(selected, options.exclude)
    const dropped = before - selected.length
    if (dropped > 0) log(`[workbuddy] --exclude 排除了 ${dropped} 个会话`)
  }

  if (!explicit && options.list !== true) {
    if (options.input === undefined && !process.stdin.isTTY) {
      throw new Error(
        '标准输入不是终端，无法交互选择。\n' +
        '  请显式指定要导入的会话：\n' +
        '    --all                     导入全部候选\n' +
        '    --only <id,id,...>        只导入指定会话\n' +
        '    --list                    先看清单再决定\n' +
        '  这是刻意的安全默认：不指定选择就不会全量导入。',
      )
    }
    const picked = await selectInteractively(selected, options)
    if (picked === null) {
      log('[workbuddy] 已取消，未导入任何会话')
      return { selected: [], cancelled: true, candidates }
    }
    selected = picked
    if (selected.length === 0) {
      log('[workbuddy] 没有勾选任何会话，未导入')
      return { selected: [], cancelled: true, candidates }
    }
  } else if (options.list === true) {
    return { selected: [], cancelled: true, candidates, listed: selected }
  }

  if (options.limit !== undefined) {
    selected = [...selected].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, options.limit)
  }
  return { selected, cancelled: false, candidates }
}

/** 导入 WorkBuddy 会话；返回各类结果计数。 */
async function importWorkBuddy(options) {
  const candidates = collectCandidates(options.workbuddyRoot)

  const resolution = await resolveSelection(candidates, options)

  // --list：只打印清单（含序号与消息数），供人工或脚本挑选。
  if (resolution.listed !== undefined) {
    log(`[workbuddy] 候选 ${resolution.listed.length}/${candidates.length} 个会话\n`)
    printCandidates(resolution.listed.map(c => ({
      id: c.id,
      cwd: c.cwd,
      createdAt: c.createdAt,
      messageCount: c.messageCount,
    })))
    log('\n用 --only <序号对应 id> 导入，或去掉 --list 在终端里交互勾选。')
    return { imported: [], existing: [], empty: [], failed: [], listed: resolution.listed }
  }
  if (resolution.cancelled) {
    return { imported: [], existing: [], empty: [], failed: [], cancelled: true }
  }

  const selected = resolution.selected
  log(`[workbuddy] 候选 ${selected.length}/${candidates.length} 个会话`)

  const { imported, existing, empty, failed, adoptFailed } = importCandidates(selected, options)
  let previewDone = false
  for (const entry of imported) {
    const { candidate, events, path: written } = entry
    if (options.apply) {
      log(`  [写入] ${candidate.id}  ${candidate.cwd ?? '(无 cwd)'}  ${candidate.messageCount} 条消息 -> ${events.length} 事件 -> ${written}`)
    } else {
      log(`  [待导入] ${candidate.id}  ${candidate.cwd ?? '(无 cwd)'}  ${candidate.messageCount} 条消息 -> ${events.length} 事件`)
    }
    if (!previewDone && options.preview > 0) {
      previewDone = true
      log('  --- 事件预览 ---')
      for (let i = 0; i < Math.min(events.length, options.preview); i++) {
        log(`    [${i}] ${events[i].type}`)
      }
    }
  }
  for (const entry of failed) {
    log(`  [失败] ${entry.candidate.id}: ${entry.error}`)
  }
  // 接管是两件事（搬文件 + 打软删除），要说清楚各自成没成：
  // 文件搬走了但库没写成，状态可诊断；反过来就是「列表没了、文件也没了」。
  for (const entry of imported) {
    if (entry.adopted === undefined) continue
    log(`  [接管] ${entry.candidate.id} -> ${entry.adopted.archived}`)
    if (entry.adopted.softDeleted !== true) {
      log(`    注意: 未能在 WorkBuddy 注册表里标记删除（${entry.adopted.alreadyDeleted === true ? '那里本来就删过了' : '可能正被 WorkBuddy 占用'}），文件已归档`)
    }
  }
  for (const entry of adoptFailed) {
    log(`  [接管失败] ${entry.id}: ${entry.error}（会话已导入，只是源文件没搬走）`)
  }

  log(`[workbuddy] 结果: 新导入 ${imported.length}，已存在跳过 ${existing.length}，空会话 ${empty.length}，失败 ${failed.length}${adoptFailed.length > 0 ? `，接管失败 ${adoptFailed.length}` : ''}`)
  if (!options.apply && imported.length > 0) {
    log(`[workbuddy] 提示: 加上 --apply 才会写入 ${options.sessionsRoot}，随后重启 dsh web 生效`)
  }
  return { imported, existing, empty, failed, adoptFailed }
}

/** 把 `--only a,b c` 这类值拆成 id 数组。 */
function splitIds(value) {
  if (value === undefined) return undefined
  return String(value).split(/[\s,，、]+/).map(s => s.trim()).filter(s => s.length > 0)
}

async function main() {
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
    only: splitIds(flags.only),
    exclude: splitIds(flags.exclude),
    all: flags.all === true,
    list: flags.list === true,
    mode: normalizeMode(flags.mode),
  }
  // 界面上的下拉给不出非法值，但终端里是手打的。静默回落成 copy 会让人以为
  // 已经接管了其实没有，所以在 CLI 这里直接报错。
  if (flags.mode !== undefined && !MODES.includes(flags.mode)) {
    throw new Error(`--mode 只接受 ${MODES.join(' | ')}，收到: ${flags.mode}`)
  }
  if (options.limit !== undefined && !Number.isInteger(options.limit)) throw new Error('--limit 必须是整数')
  if (options.truncate !== undefined && (!Number.isInteger(options.truncate) || options.truncate < 0)) throw new Error('--truncate 必须是非负整数')
  if (options.toolTruncate !== undefined && (!Number.isInteger(options.toolTruncate) || options.toolTruncate < 0)) throw new Error('--tool-truncate 必须是非负整数')
  if (options.truncate === 0) options.truncate = undefined
  if (options.toolTruncate === 0) options.toolTruncate = undefined
  if (options.all === true && options.only !== undefined) throw new Error('--all 与 --only 不能同时使用')

  log(`写入: ${options.apply ? '--apply（真正写入）' : '--dry-run（只预览）'}`)
  log(`归属方式: ${options.mode}`)
  log(`会话根: ${options.sessionsRoot}`)
  log(`WorkBuddy 根: ${options.workbuddyRoot}`)

  await importWorkBuddy(options)
}

main().catch((error) => {
  log(`错误: ${error.message}`)
  process.exitCode = 1
})
