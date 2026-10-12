/**
 * WorkBuddy (腾讯 CodeBuddy / WorkBuddy 桌面端) session reader.
 *
 * 会话存放在 ~/.workbuddy/projects/<encoded-cwd>/<uuid>.jsonl，每行一个事件：
 *   session-meta          { id, sessionId, timestamp, meta }
 *   message               { id, parentId, timestamp, type:'message', role, content:[…] }
 *   reasoning             { id, parentId, timestamp, rawContent:[{type:'reasoning_text',text}] }
 *   function_call         { id, parentId, timestamp, name, arguments, … }
 *   function_call_result  { id, parentId, timestamp, name, callId, status, output:{type,text} }
 *   file-history-snapshot { … }  ← 与对话无关，跳过
 *
 * content 块类型：input_text / output_text / reasoning_text。
 *
 * user 消息被大量上下文包裹：`<system-reminder>` 里塞了身份文件、项目结构、
 * 记忆提醒等；真正的用户输入在末尾的 `<user_query>…</user_query>` 中。
 * 因此用户文本的提取规则是：
 *   1. 有 <user_query> 就取它（这是用户真正打的内容）；
 *   2. 否则剥掉所有 <system-reminder …>…</system-reminder>（网络错误重试等噪音）；
 *   3. 仍然为空就整条丢弃（纯系统注入，不是对话）。
 *
 * 目录名是 cwd 的可读编码（如 `d-Users-me-projects-demo`），不可逆——
 * 破折号既可能来自路径分隔符也可能来自目录名本身。真实 cwd 从每个事件的
 * `cwd` 字段读取（每条 message/reasoning/function_call 都带），目录名仅作兜底。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { fileLines } from './lines.mjs'

/**
 * Default WorkBuddy conversation root.
 * Windows 上必须用 os.homedir()：Node 的 process.env.HOME 在 Windows 下
 * 通常为空，join('', '.workbuddy') 会得到相对路径而扫不到任何会话。
 * WORKBUDDY_HOME 可覆盖（与应用自身一致）。
 */
export function defaultWorkBuddyRoot() {
  const home = process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy')
  return join(home, 'projects')
}

/**
 * Enumerate WorkBuddy conversation files.
 * 跳过 `<uuid>.file-rollback.ndjson`（文件回滚日志，不是对话）。
 * @returns { file, projectDir }[]
 */
export function listWorkBuddySessions(root) {
  const files = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let entries
    try {
      entries = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (entry.name.endsWith('.file-rollback.ndjson')) continue
      files.push({ file: join(projectDir, entry.name), projectDir: project.name })
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

/** 去掉 <system-reminder …>…</system-reminder> 包裹块（含内部所有换行）。 */
function stripSystemReminders(text) {
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu, '')
}

/**
 * 从一条 user 消息里取出被注入的系统上下文（`<system-reminder>` 的内部）。
 *
 * 这些块**不是噪音**，而是 WorkBuddy 运行时注入的上下文（user_info /
 * identity_context / product_identity / project_context / additional_data /
 * memory_and_skills_reminder）。它们必须保留：
 *
 *   - WorkBuddy 上游要求请求的第 1 条消息是它自己的系统提示词，否则以
 *     业务码 11128「首条消息不是系统提示词」拒绝 —— 这是导入会话无法继续
 *     对话的直接原因；
 *   - 源 jsonl 里**没有** role:"system" 的消息，系统提示词是客户端请求时
 *     注入的，所以这些注入块是本地唯一能还原它的材料。
 *
 * 早先的实现把这些块整段丢弃，只保留 <user_query>，导致导入的会话看得见
 * 历史却发不出请求。
 *
 * @returns 注入块的原文（未包裹时的空串）。
 */
export function extractInjectedContext(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const blocks = [...text.matchAll(/<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/giu)]
  if (blocks.length === 0) return ''
  return blocks.map(match => match[1].trim()).filter(part => part.length > 0).join('\n\n')
}

/**
 * 从一条 user 消息的完整文本里提取用户真正说的话。
 * @returns 提取后的文本（可能为空字符串，表示纯系统注入）。
 */
export function extractUserText(raw) {
  const text = typeof raw === 'string' ? raw : ''
  // 1) 优先取 <user_query> 内部内容。
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/giu)]
  if (queries.length > 0) {
    const joined = queries.map(match => match[1]).join('\n').trim()
    if (joined.length > 0) return joined
  }
  // 2) 没有 user_query：剥掉 system-reminder 噪音后剩下的就是用户内容。
  const stripped = stripSystemReminders(text)
  // 3) 其余注入型标签块（<system-reminder> 之外）也一并清理。
  const cleaned = stripped
    .replace(/<\/?(user_query|system-reminder)\b[^>]*>/giu, '')
    .trim()
  return cleaned
}

/**
 * 把注入上下文按一级标签切成块，用于去重与拼装。
 *
 * 一份 `<system-reminder>` 里通常是 `<user_info>` / `<identity_context>` /
 * `<product_identity>` / `<project_context>` / `<additional_data>` /
 * `<memory_and_skills_reminder>` 若干块。按标签切分后，逐块去重就能既保留
 * 每个标签的最新内容，又不让重复的块把 system 消息撑爆。
 *
 * @returns 每块带标签名的原文；无法切分时整段作为一块返回。
 */
function splitContextBlocks(text) {
  const parts = []
  const re = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/giu
  for (const match of text.matchAll(re)) parts.push(match[0].trim())
  if (parts.length === 0) {
    const trimmed = text.trim()
    if (trimmed.length > 0) parts.push(trimmed)
  }
  return parts
}

/** Assistant 结束/未完成的状态：只保留有实际内容的消息。 */
function mapAssistantBlock(block) {
  switch (block?.type) {
    case 'output_text':
    case 'text':
      return { type: 'text', text: block.text ?? '' }
    case 'reasoning_text':
      return { type: 'reasoning', text: block.text ?? '' }
    default:
      return undefined
  }
}

/** 工具输出可能是 text 或 JSON；统一成字符串并限长。 */
const TOOL_OUTPUT_MAX = 2000

function toolOutputText(output) {
  if (output === undefined || output === null) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object' && typeof output.text === 'string') return output.text
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

/**
 * 解析一个 WorkBuddy 会话文件。
 * @returns { header: {id, createdAt, cwd, title?}, messages: normalized[] }
 *   normalized = { role, time, provider, model?, blocks[] }
 */
export function parseWorkBuddySession(file) {
  const header = { id: undefined, createdAt: undefined, cwd: undefined, title: undefined, injectedContext: undefined }
  const messages = []
  let firstTime
  // function_call 与 function_call_result 通过 callId 配对。
  const pendingCalls = new Map()
  // 当前轮次在 messages 里的起始下标：一条 user 消息开启新轮次，
  // 之后的 assistant 消息 / function_call / function_call_result 都属于它。
  // 去重与结果配对都必须限制在这个范围里（见下方两处注释）。
  let turnStart = 0
  // 注入上下文按出现顺序累积；只在首次见到某一块时记录，避免 200+ 条
  // user 消息把同一份 6 KB 上下文重复几千遍。
  const contextSeen = new Set()
  const contextParts = []

  for (const rawLine of fileLines(file)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const time = typeof event.timestamp === 'number' ? event.timestamp : undefined
    if (typeof event.sessionId === 'string' && header.id === undefined) header.id = event.sessionId
    if (typeof event.cwd === 'string' && header.cwd === undefined) header.cwd = event.cwd
    if (time !== undefined && (firstTime === undefined || time < firstTime)) firstTime = time

    // file-history-snapshot / session-meta 与对话内容无关。
    if (event.type === 'session-meta' || event.type === 'file-history-snapshot') continue

    if (event.type === 'reasoning') {
      const blocks = []
      for (const block of Array.isArray(event.rawContent) ? event.rawContent : []) {
        const mapped = mapAssistantBlock(block)
        if (mapped !== undefined && mapped.text.length > 0) blocks.push(mapped)
      }
      if (blocks.length === 0) continue
      messages.push({
        role: 'assistant',
        time: time ?? firstTime ?? Date.now(),
        provider: 'workbuddy',
        model: event.providerData?.model,
        blocks,
      })
      continue
    }

    if (event.type === 'message') {
      const role = event.role === 'user' ? 'user' : event.role === 'assistant' ? 'assistant' : undefined
      if (role === undefined) continue
      const blocks = []
      if (role === 'user') {
        const joined = (Array.isArray(event.content) ? event.content : [])
          .filter(block => block?.type === 'input_text' || block?.type === 'text')
          .map(block => block.text ?? '')
          .join('\n')
        // 收集注入上下文（同一块只留一份），再提取用户真正说的话。
        const injected = extractInjectedContext(joined)
        if (injected.length > 0) {
          // 按 <tag> 名称分块去重：同一份 identity_context 会随每条消息重复，
          // 而 memory_and_skills_reminder 会随时间变化，两者都要处理。
          for (const part of splitContextBlocks(injected)) {
            const key = part.slice(0, 200)
            if (contextSeen.has(key)) continue
            contextSeen.add(key)
            contextParts.push(part)
          }
        }
        const text = extractUserText(joined)
        if (text.length > 0) blocks.push({ type: 'text', text })
      } else {
        for (const block of Array.isArray(event.content) ? event.content : []) {
          const mapped = mapAssistantBlock(block)
          if (mapped !== undefined && mapped.text.length > 0) blocks.push(mapped)
        }
      }
      // 纯系统注入的 user 消息（提取后为空）直接丢弃。
      if (blocks.length === 0) continue
      messages.push({
        role,
        time: time ?? firstTime ?? Date.now(),
        provider: 'workbuddy',
        model: event.providerData?.model,
        blocks,
      })
      // user 消息开启一个新轮次：记录轮次起点，供 tool-call 去重与
      // tool-result 配对界定范围。
      if (role === 'user') turnStart = messages.length - 1
      continue
    }

    if (event.type === 'function_call') {
      // WorkBuddy 把工具调用单独成事件，字段名是 name/arguments。
      // 注意：源数据会在同一轮里重复同一个 function_call id（重试/并行批次），
      // 而 dsh format v4 要求一个 assistant/message 内 advertised tool call 唯一，
      // 否则读回时报 "assistant/message repeats advertised tool call"。因此这里
      // 对同一轮内已出现过的 id 追加序号去重，保持 id 稳定且唯一。
      //
      // 去重范围必须是**整个当前轮次**（turnStart 之后的所有 assistant
      // 消息），不能只看最后一条：一轮里常见「文本消息 → 多个 function_call」
      // 的节奏，若中间又插了一条 assistant 文本消息，只看最后一条就会漏掉
      // 之前消息里已出现的 id，产出同一轮内重复的 callId。
      const rawId = typeof event.id === 'string' ? event.id : undefined
      const baseId = rawId ?? `wb-call-${crypto.randomUUID()}`
      const seenInTurn = []
      for (const message of messages.slice(turnStart)) {
        if (message.role !== 'assistant') continue
        for (const block of message.blocks) {
          if (block.type === 'tool-call') seenInTurn.push(block.id)
        }
      }
      let callId = baseId
      if (seenInTurn.includes(baseId)) {
        let n = 2
        while (seenInTurn.includes(`${baseId}#${n}`)) n += 1
        callId = `${baseId}#${n}`
      }
      let args = event.arguments
      if (typeof args !== 'string') {
        try {
          args = args === undefined ? '' : JSON.stringify(args)
        } catch {
          args = String(args)
        }
      }
      const block = {
        type: 'tool-call',
        id: callId,
        name: String(event.name ?? 'tool'),
        arguments: args,
      }
      pendingCalls.set(callId, block)
      // 工具调用挂到当前 assistant 轮次；若上一条不是 assistant 则新建一条。
      const last = messages[messages.length - 1]
      if (last !== undefined && last.role === 'assistant') last.blocks.push(block)
      else {
        messages.push({
          role: 'assistant',
          time: time ?? firstTime ?? Date.now(),
          provider: 'workbuddy',
          model: event.providerData?.model,
          blocks: [block],
        })
      }
      continue
    }

    if (event.type === 'function_call_result') {
      // WorkBuddy 记录了真实工具输出——把它挂回对应的 tool-call 块，
      // 由 convert.mjs 写进 tool/result 事件（轨迹里能看到真实结果）。
      const text = toolOutputText(event.output)
      const callId = typeof event.callId === 'string' ? event.callId : undefined
      const shrink = (value) => (value.length > TOOL_OUTPUT_MAX ? `${value.slice(0, TOOL_OUTPUT_MAX)}…` : value)
      let attached = false
      if (callId !== undefined) {
        // callId 是服务端 id（chatcmpl-tool-…），与 function_call 的 id 不同，
        // 无法直接对应，因此按出现顺序配对。
        //
        // 关键：必须**从早到晚**找第一个「尚未收到结果」的同名调用。
        // 一轮里可能有多个并行调用（如同时发 3 个 Bash），其结果按调用顺序
        // 依次返回；若从后往前找，结果会被整体倒序错配到调用上。
        //
        // 范围还必须限制在**当前轮次**（turnStart 起）。若扫全历史，前一轮
        // 某个没记到结果的同名调用会把后一轮的结果偷走——后一轮的调用反而
        // 只剩占位符，轨迹上显示的结果属于另一次调用。
        outer: for (const message of messages.slice(turnStart)) {
          if (message.role !== 'assistant') continue
          for (const block of message.blocks) {
            if (block.type !== 'tool-call') continue
            if (block.result !== undefined) continue
            if (event.name !== undefined && block.name !== event.name) continue
            if (text.length > 0) block.result = shrink(text)
            block.isError = typeof event.status === 'string' && event.status !== 'completed'
            attached = true
            break outer
          }
        }
      }
      if (attached) continue
      if (text.length === 0) continue
      // 无法配对时退化成文本，至少不丢信息。
      const block = { type: 'text', text: `[工具结果: ${event.name ?? 'tool'}]\n${shrink(text)}` }
      const last = messages[messages.length - 1]
      if (last !== undefined && last.role === 'assistant') last.blocks.push(block)
      else {
        messages.push({
          role: 'assistant',
          time: time ?? firstTime ?? Date.now(),
          provider: 'workbuddy',
          model: undefined,
          blocks: [block],
        })
      }
      continue
    }
  }

  // 没有 sessionId 事件时用文件名兜底。
  if (header.id === undefined) {
    header.id = file.replace(/\\/gu, '/').split('/').pop()?.replace(/\.jsonl$/u, '')
  }
  if (header.createdAt === undefined) header.createdAt = firstTime
  if (contextParts.length > 0) header.injectedContext = contextParts.join('\n\n')
  return { header, messages }
}

/** 会话标题：取第一条有文本的 user 消息，压缩空白并截断。 */
export function workbuddyTitle(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
    if (text.length > 0) return text.slice(0, 80)
  }
  return undefined
}
