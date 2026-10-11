/**
 * 会话选择：交互式勾选 + 非交互过滤。
 *
 * 三种用法：
 *   1. 交互式（默认，TTY）—— 列出所有候选会话，让用户勾选要导入的；
 *   2. 非交互 —— `--only <ids>` / `--exclude <ids>` 精确控制；
 *   3. `--list` —— 只打印清单（含稳定序号），供脚本或人工挑选。
 *
 * 交互式选择支持：
 *   - 数字/区间：`1 3 5-9`、`1,3,5-9`（逗号可选）
 *   - `a` / `all`   全选
 *   - `n` / `none`  全不选
 *   - `i` / `invert` 反选
 *   - `q` / `quit`  取消（不导入任何会话）
 *   - 直接回车 = 采用当前默认（默认全不选，安全）
 *
 * 关键设计：默认全不选。这个导入器曾经因为"无过滤全量导入"把用户
 * 已删除的会话又导了回来，所以交互模式的初始状态必须是空选择，
 * 用户显式勾选才导入。
 */

import { createInterface } from 'node:readline'

/** 会话在列表里的显示行：序号 + 短 id + cwd + 消息数。 */
function formatRow(index, item, width) {
  const num = String(index).padStart(width, ' ')
  const msg = item.messageCount === undefined ? '?' : String(item.messageCount)
  const cwd = item.cwd ?? '(无 cwd)'
  return `${num}. ${item.id}  [${msg} 条]  ${cwd}`
}

/**
 * 打印候选会话清单。
 * @param items - { id, cwd, createdAt?, messageCount? }[]
 * @param options.marked - Set<string>，已勾选的 id（交互模式用）
 * @param options.selected - boolean，是否画勾选标记列
 */
export function printCandidates(items, options = {}) {
  const width = String(items.length).length
  const marked = options.marked
  const showMark = options.selected === true
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const box = showMark ? (marked !== undefined && marked.has(item.id) ? '[x] ' : '[ ] ') : ''
    process.stderr.write(`  ${box}${formatRow(i + 1, item, width)}\n`)
  }
}

/**
 * 解析选择表达式。
 * @param text - 用户输入，如 `1 3 5-9`、`all`、`none`、`invert`、`quit`
 * @param total - 候选总数
 * @returns { kind: 'set', values: Set<number> } | { kind:'all'|'none'|'invert'|'quit'|'accept' } | { kind:'error', message }
 *
 * 序号是 1-based（与屏幕显示一致）。
 */
export function parseSelection(text, total) {
  const raw = String(text ?? '').trim().toLowerCase()
  if (raw === '') return { kind: 'accept' }
  if (raw === 'a' || raw === 'all') return { kind: 'all' }
  if (raw === 'n' || raw === 'none') return { kind: 'none' }
  if (raw === 'i' || raw === 'invert') return { kind: 'invert' }
  if (raw === 'q' || raw === 'quit') return { kind: 'quit' }

  const values = new Set()
  // 逗号/空格/顿号都当分隔符
  const tokens = raw.split(/[\s,，、]+/).filter(t => t.length > 0)
  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return { kind: 'error', message: `无法解析区间 "${token}"` }
      }
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      if (lo < 1 || hi > total) {
        return { kind: 'error', message: `区间 ${lo}-${hi} 超出范围 1-${total}` }
      }
      for (let n = lo; n <= hi; n++) values.add(n)
      continue
    }
    const single = token.match(/^\d+$/)
    if (single) {
      const n = Number(token)
      if (n < 1 || n > total) {
        return { kind: 'error', message: `序号 ${n} 超出范围 1-${total}` }
      }
      values.add(n)
      continue
    }
    return { kind: 'error', message: `无法识别 "${token}"（支持数字、区间、all/none/invert/quit）` }
  }
  if (values.size === 0) return { kind: 'error', message: '没有解析出任何序号' }
  return { kind: 'set', values }
}

/**
 * 交互式让用户勾选会话。
 * @param items - 候选会话
 * @param options.input / options.output - 可注入的流（测试用）
 * @returns 被选中的 item 数组（按原顺序）
 *
 * 非 TTY 且未注入输入流时直接抛错，避免在管道里静默卡住。
 */
export async function selectInteractively(items, options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stderr
  if (items.length === 0) return []
  if (options.input === undefined && !process.stdin.isTTY) {
    throw new Error('标准输入不是终端，无法交互选择。请改用 --only <ids> / --exclude <ids> / --all，或在终端里运行。')
  }

  const rl = createInterface({ input, output, terminal: false })
  const marked = new Set()
  const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve))

  try {
    while (true) {
      output.write('\n可导入的 WorkBuddy 会话：\n')
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const box = marked.has(item.id) ? '[x]' : '[ ]'
        const msg = item.messageCount === undefined ? '?' : String(item.messageCount)
        output.write(`  ${box} ${String(i + 1).padStart(String(items.length).length)}. ${item.id}  [${msg} 条]  ${item.cwd ?? '(无 cwd)'}\n`)
      }
      output.write('\n输入要导入的序号（如 1 3 5-9）；a=全选 n=全不选 i=反选；回车=确认，q=取消\n')
      const answer = await ask(`选择 [已勾选 ${marked.size}/${items.length}]: `)
      const parsed = parseSelection(answer, items.length)

      if (parsed.kind === 'error') { output.write(`  × ${parsed.message}\n`); continue }
      if (parsed.kind === 'quit') return null
      if (parsed.kind === 'all') { for (let i = 1; i <= items.length; i++) marked.add(i); continue }
      if (parsed.kind === 'none') { marked.clear(); continue }
      if (parsed.kind === 'invert') {
        for (let i = 1; i <= items.length; i++) {
          if (marked.has(i)) marked.delete(i)
          else marked.add(i)
        }
        continue
      }
      if (parsed.kind === 'set') { for (const n of parsed.values) marked.add(n); continue }
      if (parsed.kind === 'accept') {
        const picked = []
        for (let i = 0; i < items.length; i++) if (marked.has(i + 1)) picked.push(items[i])
        return picked
      }
    }
  } finally {
    rl.close()
  }
}

/**
 * 用 id 列表过滤候选（精确匹配，支持带不带 `wb-` 前缀）。
 * @returns { selected, missing } —— missing 是没匹配上的输入 id
 */
export function filterByIds(items, ids) {
  const wanted = new Set()
  for (const raw of ids) {
    const id = String(raw).trim()
    if (id.length === 0) continue
    wanted.add(id)
    if (!id.startsWith('wb-')) wanted.add(`wb-${id}`)
  }
  const selected = items.filter(item => wanted.has(item.id))
  const hit = new Set(selected.map(item => item.id))
  const missing = [...wanted].filter(id => !hit.has(id) && items.some(i => i.id !== id))
  const unmatched = [...new Set(ids.map(s => String(s).trim()).filter(Boolean))]
    .filter(id => !hit.has(id) && !hit.has(`wb-${id}`))
  return { selected, missing: unmatched }
}

/** 剔除黑名单 id。支持带不带 `wb-` 前缀。 */
export function excludeByIds(items, ids) {
  const bad = new Set()
  for (const raw of ids) {
    const id = String(raw).trim()
    if (id.length === 0) continue
    bad.add(id)
    if (!id.startsWith('wb-')) bad.add(`wb-${id}`)
  }
  return items.filter(item => !bad.has(item.id))
}
