/**
 * WorkBuddy → DSH 导入管线（CLI 与 DSH 插件 host 半场共用）。
 *
 * 这里只放纯函数：收集候选、编译事件、写入会话。交互式选择、命令行参数
 * 解析留在 import.mjs，HTTP 路由与安全护栏留在 src/index.js。
 *
 * 与 import.mjs 早先内联实现的对应关系：
 *   collectCandidates  ← importWorkBuddy 的候选收集段
 *   buildEventsFor     ← import.mjs 私有 toEvents
 *   importCandidates   ← importWorkBuddy 的导入循环
 * 行为保持一致（含 dry-run 语义），CLI 改为薄封装后原有测试不变。
 */

import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { adoptSession } from './adopt.mjs'
import { buildDshEvents, deriveImportTitle } from './convert.mjs'
import { findExistingSession, writeSession, normalizePresetId } from './dsh-writer.mjs'
import { writeWatermark } from './sync-back.mjs'
import { truncate } from './util.mjs'
import {
  defaultWorkBuddyRoot,
  listWorkBuddySessions,
  parseWorkBuddySession,
  workbuddyTitle,
} from './workbuddy-reader.mjs'

/** 三种归属模式。copy 之外的都需要 WorkBuddy 根目录做越界校验。 */
export const MODES = ['copy', 'adopt', 'sync']

/** 归一化模式串；未知值一律回落成 copy（保守方向）。 */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : 'copy'
}

/**
 * 候选的「最后活动时间」：最后一条消息的时间。
 *
 * 不是文件名，也不是 header.createdAt —— 列表是按它排序、并按它显示的，
 * 而「这个会话最近聊到什么时候」才是翻列表时真正要找的东西。一个开了两周、
 * 每天接着聊的会话，创建时间会说它是两周前的，然后被压到列表底下。
 *
 * 回落链：最后一条消息 → 首条消息（header.createdAt 已回落到它）→ 文件
 * mtime。mtime 只是兜底，它会被任何一次拷贝或备份改写，但总比没有强。
 *
 * @param {{ header: object, messages: object[] }} parsed
 * @param {string} file 轨迹文件路径，仅用于最后的 mtime 兜底
 * @returns {number|null}
 */
function candidateUpdatedAt(parsed, file) {
  let latest
  for (const message of Array.isArray(parsed?.messages) ? parsed.messages : []) {
    const time = message?.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (latest === undefined || time > latest) latest = time
  }
  if (latest !== undefined) return latest
  if (typeof parsed?.header?.createdAt === 'number') return parsed.header.createdAt
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

/**
 * 枚举 WorkBuddy 会话并解析成候选。
 *
 * @param {string} [workbuddyRoot] WorkBuddy 会话根目录
 * @returns {{ file, projectDir, parsed, id, cwd, createdAt, updatedAt, messageCount }[]}
 *   id 形如 `wb-<uuid>`，与 DSH 会话 id 命名空间隔离；解析不出 header.id
 *   的文件直接跳过（与 CLI 一致）。
 */
export function collectCandidates(workbuddyRoot = defaultWorkBuddyRoot()) {
  const candidates = []
  for (const entry of listWorkBuddySessions(workbuddyRoot)) {
    let parsed
    try {
      parsed = parseWorkBuddySession(entry.file)
    } catch {
      continue // 单个坏文件不能拖垮整次列举
    }
    if (parsed?.header?.id === undefined) continue
    candidates.push({
      file: entry.file,
      projectDir: entry.projectDir,
      parsed,
      id: `wb-${parsed.header.id}`,
      cwd: parsed.header.cwd,
      createdAt: parsed.header.createdAt,
      updatedAt: candidateUpdatedAt(parsed, entry.file),
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    })
  }
  return candidates
}

/**
 * 把一个候选编译成 DSH 事件流（应用截断/工具策略与标题）。
 *
 * 注入上下文（<system-reminder> 块）会变成会话开头的 system 消息：没有它，
 * 导入的会话能看不能聊——WorkBuddy 上游要求请求第 1 条消息是系统提示词，
 * 否则以业务码 11128 拒绝。
 *
 * @param {object} candidate collectCandidates 的元素
 * @param {object} [options]
 * @param {boolean} [options.noTools] 丢弃工具调用块
 * @param {boolean} [options.toolsAsText] 工具调用转纯文本
 * @param {number} [options.truncate] 文本/推理块截断长度
 * @param {number} [options.toolTruncate] 工具参数截断长度（默认 1000）
 * @param {number} [options.keepLast] 只取最后 N 条消息（0/缺省 = 全部）
 * @param {boolean} [options.fromLastCompaction] 只取最后一次压缩及其之后
 * @param {string} [options.title] 覆盖标题（默认从内容推导）
 * @param {string} [options.titlePrefix] 标题前缀
 * @returns {object[]} DSH 事件
 */

/**
 * 最后一次「上下文压缩」落在第几条消息上（没有就 -1）。
 *
 * WorkBuddy 把压缩结果写成一条 user 消息，正文是 `<cb_summary>…</cb_summary>`
 * 或 `<conversation_history_summary>…</conversation_history_summary>`，后面紧跟
 * 一句「请基于以上摘要继续」。它之后的轨迹才是会话此刻真正依赖的东西；它之前
 * 的几万条都已经被这段摘要概括掉了 —— 留着只是重复付费。
 *
 * 只认这两个标签：`<task-notification>` 里也有 `<summary>`，那是后台任务的
 * 完成通知，跟压缩毫无关系。
 */
export function lastCompactionIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    // 先认解析时摘出来的标记：绝大多数压缩摘要和 <user_query> 同在一条消息里，
    // 正文里只剩用户问题，标签早被提取时剥掉了 —— 只看正文会漏掉真正的最后一
    // 次压缩，切点就退回到很早的一次，白留一大段。
    if (messages[i]?.compaction !== undefined && messages[i]?.compaction !== null) return i
    const blocks = messages[i]?.blocks
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      if (/<(cb_summary|conversation_history_summary)[\s>]/u.test(block.text)) return i
    }
  }
  return -1
}

/**
 * 把压缩摘要请回一条消息的正文。
 *
 * 摘要不在正文里（见 workbuddy-reader 的 extractCompaction），所以按压缩点切完
 * 之后，切点那条消息必须把它加回去 —— 否则「只导入压缩之后」得到的就是一句
 * 孤立的用户提问，前面几千条发生了什么全没了。
 */
function withCompactionText(message) {
  const summary = message?.compaction?.text
  if (typeof summary !== 'string' || summary.length === 0) return message
  const already = (message.blocks ?? []).some(
    block => block?.type === 'text' && typeof block.text === 'string' && block.text.includes(summary.slice(0, 40)),
  )
  if (already) return message
  return { ...message, blocks: [{ type: 'text', text: summary }, ...(message.blocks ?? [])] }
}

export function buildEventsFor(candidate, options = {}) {
  const all = candidate.parsed.messages
  //
  // 导入多少。为什么必须有这个口子：一个跑了很久的会话可以有几万条消息、几十
  // MB 轨迹，整份导进来之后每一次请求都远超模型窗口（实测 33 MB ≈ 千万 token，
  // 而窗口是 1M）。这时唯一的减肥手段是上下文压缩，而压缩本身就是一次模型调用
  // —— 它同样会超时（实测 compaction/end 带 `error: pi-ai stream idle
  // timeout`），于是上下文永远降不下来，会话卡死在「每次 5 分钟一个字都没有」。
  // 所以必须在导入这一侧就把体量切掉，不能指望事后的压缩。
  //
  // 按消息边界切是安全的：工具调用与它的结果由同一条消息的同一个 block 生成
  // （见 convert.mjs），切在消息之间不会留下没人认领的 tool/result。
  let messages = all
  if (options.fromLastCompaction === true) {
    const at = lastCompactionIndex(all)
    // at === 0 表示整段就剩压缩那一段，没什么可切的；-1 是从没压缩过，
    // 那就老实全量导入 —— 宁可慢，也不能把会话截成没头没尾的一段。
    if (at > 0) {
      const head = withCompactionText(all[at])
      messages = head === all[at] ? all.slice(at) : [head, ...all.slice(at + 1)]
    }
  }
  const keepLast = Number.isInteger(options.keepLast) && options.keepLast > 0 ? options.keepLast : 0
  if (keepLast > 0 && messages.length > keepLast) messages = messages.slice(-keepLast)

  const filtered = []
  for (const message of messages) {
    let blocks = message.blocks
    if (options.noTools === true) {
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

  // 标题始终按完整消息推：切掉开头之后「第一条用户消息」可能已经不在了，
  // 而用户认的是原来那个会话标题，不是被切剩下的那一段。
  const sourceTitle = workbuddyTitle(all)
  const baseTitle = deriveImportTitle(sourceTitle, all, undefined)
  const title = options.title !== undefined
    ? options.title
    : options.titlePrefix !== undefined && baseTitle !== undefined
      ? `${options.titlePrefix}${baseTitle}`
      : baseTitle

  return buildDshEvents(filtered, {
    toolEvents: options.noTools !== true && options.toolsAsText !== true,
    title,
    titlePinned: true,
    systemPrompt: candidate.parsed.header.injectedContext,
  })
}

/**
 * 导入一批候选（幂等：已存在 artifacts 的跳过）。
 *
 * @param {object[]} selected collectCandidates 的子集
 * @param {object} [options]
 * @param {string} [options.sessionsRoot] DSH 会话存储根（$DSH_HOME/sessions）
 * @param {boolean} [options.apply] false 时只编译不落盘（dry-run）
 * @param {'copy'|'adopt'|'sync'} [options.mode] 归属模式，默认 copy
 * @param {string} [options.workbuddyRoot] adopt 模式做越界校验用
 * @param {boolean} [options.noTools] 见 buildEventsFor
 * @param {boolean} [options.toolsAsText] 见 buildEventsFor
 * @param {number} [options.truncate] 见 buildEventsFor
 * @param {number} [options.toolTruncate] 见 buildEventsFor
 * @param {number} [options.keepLast] 见 buildEventsFor
 * @param {boolean} [options.fromLastCompaction] 见 buildEventsFor
 * @param {string} [options.titlePrefix] 见 buildEventsFor
 * @param {string} [options.agentPreset] 导入的会话挂载哪个 agent 预设（默认 standard）
 * @returns {{ imported, existing, empty, failed, adoptFailed, mode }}
 *   imported 元素为 { candidate, events, path?, adopted? }；
 *   adoptFailed 与导入成功与否无关——会话已经进 DSH 了，只是「搬走源文件」这
 *   一步没成，可以事后补，所以单独成桶而不是算作导入失败。
 */
export function importCandidates(selected, options = {}) {
  const mode = normalizeMode(options.mode)
  const imported = []
  const existing = []
  const empty = []
  const failed = []
  const adoptFailed = []

  for (const candidate of selected) {
    if (options.sessionsRoot !== undefined && findExistingSession(options.sessionsRoot, candidate.id)) {
      existing.push(candidate)
      continue
    }
    try {
      const messages = candidate.parsed.messages
      if (!Array.isArray(messages) || messages.length === 0) {
        empty.push(candidate)
        continue
      }
      const events = buildEventsFor(candidate, options)
      let written
      if (options.apply === true) {
        written = writeSession(options.sessionsRoot, {
          id: candidate.id,
          createdAt: candidate.createdAt ?? messages[0].time,
          cwd: candidate.cwd,
          // 导入时指定的 agent 预设。没给就是 'standard'（历史行为），
          // 归一化在 writeSession 里做，这里不做二次判断。
          agentPreset: options.agentPreset,
        }, events)

        // 水位线与模式无关，一律刻：同步模式要靠它才能只回写「导入之后新增」
        // 的部分，而用户可能今天用 copy、下周才想切成 sync。
        writeWatermark(dirname(written), { lastSeq: events.length - 1 })
      }
      imported.push({ candidate, events, mode, ...(written !== undefined ? { path: written } : {}) })

      if (mode === 'adopt' && options.apply === true) {
        try {
          const adopted = adoptSession({
            id: candidate.id,
            source: candidate.file,
            workbuddyRoot: options.workbuddyRoot,
            cwd: candidate.cwd ?? null,
          })
          imported.at(-1).adopted = adopted
        } catch (error) {
          // 导入本身成功了：不要把会话算进 failed，否则界面会让人以为没导进来。
          adoptFailed.push({ id: candidate.id, error: error?.message ?? String(error) })
        }
      }
    } catch (error) {
      failed.push({ candidate, error: error?.message ?? String(error) })
    }
  }

  return { imported, existing, empty, failed, adoptFailed, mode }
}
