/**
 * Conversation → DSH session-log conversion.
 *
 * Both source readers normalize to one message shape:
 *   { role: 'user'|'assistant', time: ms, provider?, model?, blocks: [...] }
 * where blocks are already mapped to DSH content blocks
 * (text / reasoning / tool-call). This module folds the message stream into a
 * balanced DSH event log: each user message opens a turn (turn/start +
 * user/message), following assistant messages join it with an increasing step
 * (assistant/message), and the turn closes with turn/end {kind:'completed'}.
 *
 * With `toolEvents: true` (the default for imports), an assistant message's
 * tool-call blocks additionally emit paired `tool/call` + `tool/result`
 * events: `tool/call` drives the trajectory UI, and the placeholder
 * `tool/result` keeps resumed model requests API-legal (every `tool_calls`
 * answered by a `tool` message, as OpenAI-compatible providers require).
 * The tool-call block stays in the assistant content so the call itself is
 * model-visible.
 */

/** Placeholder text for tool results the source tool never recorded. */
export const TOOL_RESULT_PLACEHOLDER = '[工具结果未记录：源工具不保存调用结果，仅保留调用信息]'
/**
 * Fold normalized messages into a balanced DSH event list (seq 0..n-1).
 * @param messages - normalized message stream in chronological order.
 * @param options.toolEvents - emit paired tool/call + tool/result events for
 *   tool-call blocks (default false; importers enable it).
 * @returns the balanced event list.
 */
export function buildDshEvents(messages, options = {}) {
  const events = []
  let turn = 0
  let step = 0
  let openTurn = false
  let openStep = false
  let lastTime = 0
  let firstUserSeq

  /** Non-decreasing timestamps keep the log well-formed for replay. */
  const atLeast = (time) => {
    if (time > lastTime) lastTime = time
    return lastTime
  }

  const push = (type, time, data, surfaceOp) => {
    events.push({ type, time: atLeast(time), data, ...(surfaceOp ? { surfaceOp } : {}) })
  }

  // Format v4 requires every assistant step to be bracketed by step/start +
  // step/end inside its turn; assistant/message, tool/call and tool/result are
  // only legal while a matching turn/step is open, and a turn closes only with
  // no open step. Emitting only turn/start + assistant/message + turn/end
  // produces a log the reader rejects ("does not match an open turn and step").
  const closeStep = (time) => {
    if (!openStep) return
    push('step/end', time, { turn, step })
    openStep = false
  }

  const closeTurn = (time) => {
    if (!openTurn) return
    closeStep(time)
    push('turn/end', time, { turn, reason: { kind: 'completed' } })
    openTurn = false
  }

  for (const message of messages) {
    if (message.role === 'user') {
      closeTurn(message.time)
      turn += 1
      step = 0
      openTurn = true
      push('turn/start', message.time, { turn })
      if (message.blocks.length > 0) {
        push('user/message', message.time, {
          role: 'user',
          source: { kind: 'user' },
          content: message.blocks,
          id: randomId(),
        }, 'append')
        if (firstUserSeq === undefined) firstUserSeq = events.length - 1
      }
    } else {
      if (!openTurn) {
        turn += 1
        step = 0
        openTurn = true
        push('turn/start', message.time, { turn })
      }
      if (message.blocks.length === 0) continue
      closeStep(message.time)
      step += 1
      push('step/start', message.time, { turn, step })
      openStep = true
      push('assistant/message', message.time, {
        turn,
        step,
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: message.provider ?? 'imported', model: message.model ?? 'unknown' },
          content: message.blocks,
          id: randomId(),
        },
        // dsh-session 的 seed 校验（assertAssistantSettlementShape）要求
        // assistant/message 携带 turn/step 之外还有一个 **stream 数组**，
        // 否则恢复会话时抛 "seed assistant/message at index N has invalid
        // settlement fields"。这里写一个最小但合法的流：每个块一条
        // block-start + block-end，结尾一条 finish。
        stream: buildImportStream(message, turn, step),
      }, 'append')
      if (options.toolEvents === true) {
        for (const block of message.blocks) {
          if (block.type !== 'tool-call') continue
          // tool/call is log-only: trajectory UI reads it, model requests do not.
          push('tool/call', message.time, {
            turn,
            step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
          })
          // tool/result must carry a first-class tool-role message: format v4
          // requires role 'tool', a toolCallId matching the tool source, and
          // raw result content (no released `tool-result` wrapper).
          // 若 reader 提供了真实结果（block.result），就写入真实内容；
          // 否则回退到占位符（源工具不保存结果）。
          const resultText = typeof block.result === 'string' && block.result.length > 0
            ? block.result
            : TOOL_RESULT_PLACEHOLDER
          push('tool/result', message.time, {
            turn,
            step,
            message: {
              role: 'tool',
              source: { kind: 'tool', callId: block.id },
              toolCallId: block.id,
              content: [{ type: 'text', text: resultText }],
              isError: block.isError === true,
              id: randomId(),
            },
          }, 'append')
        }
      }
      closeStep(message.time)
    }
  }
  closeTurn(lastTime)
  // 继承源会话标题：latest-wins 的 session/title 事件。默认 fallback 源
  // （继续对话后 LLM 标题生成器接管更新）；`titlePinned` 时用 user 源
  // 固定标题（自动生成停止调度，来源标识与标题持久保留）。
  if (options.title !== undefined && options.title.length > 0) {
    push('session/title', lastTime, {
      title: options.title,
      messageSeqs: options.titlePinned === true ? [] : (firstUserSeq !== undefined ? [firstUserSeq] : []),
      source: options.titlePinned === true ? { kind: 'user' } : { kind: 'fallback' },
    })
  }
  return events
}

/**
 * 从源标题或首条用户消息推导导入标题（规范化 + 截断 + 来源前缀）。
 * @param sourceTitle - 源工具的标题（opencode.title / claude ai-title），可缺省。
 * @param messages - 归一化消息流。
 * @param sourceName - 来源工具名（pi / opencode / codex / claude-code），
 *   拼成 `[来源] 标题` 前缀。
 * @returns 规范化标题，无可用文本时 undefined。
 */
export function deriveImportTitle(sourceTitle, messages, sourceName) {
  const clean = (text) => text.replace(/\s+/gu, ' ').trim().slice(0, 80)
  let title
  if (typeof sourceTitle === 'string') {
    title = clean(sourceTitle)
    // 忽略无意义的模板标题（如 opencode 的 "New session - …"）。
    if (title.length === 0 || /^new session[- ]/iu.test(title)) title = undefined
  }
  if (title === undefined) {
    const firstUser = messages.find(message =>
      message.role === 'user' && message.blocks.some(block => block.type === 'text'))
    if (firstUser !== undefined) {
      const text = firstUser.blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ')
        .trim()
      if (text.length > 0) title = clean(text)
    }
  }
  if (title === undefined) return undefined
  // 来源前缀：`[pi] 标题` —— 让会话列表一眼可见会话来自哪个工具。
  return typeof sourceName === 'string' && sourceName.length > 0
    ? `[${sourceName}] ${title}`
    : title
}

/** Fresh stable message identity (DSH MessageId is a branded uuid string). */
function randomId() {
  return crypto.randomUUID()
}

/**
 * 为导入的 assistant/message 造一个最小但合法的 stream 数组。
 *
 * 恢复会话时 dsh-session 的 seed 校验要求该事件带 stream（见
 * assertAssistantSettlementShape）。真实会话的 stream 是逐块的分片记录；
 * 导入没有那些分片，于是按块重建等价的 start/end 序列——语义上与原消息
 * 一致，只是没有字符级 dt 时序。
 *
 * @param message - 归一化消息（blocks 已就绪）。
 * @param turn - 所属轮次。
 * @param step - 所属步骤。
 * @returns stream 条目数组。
 */
function buildImportStream(message, turn, step) {
  const stream = []
  message.blocks.forEach((block, index) => {
    stream.push({ type: 'chunk', chunk: { type: 'block-start', index, blockType: block.type } })
    stream.push({ type: 'chunk', chunk: { type: 'block-end', index, block } })
  })
  stream.push({
    type: 'chunk',
    chunk: {
      type: 'finish',
      reason: { kind: message.blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' },
    },
  })
  return stream
}
