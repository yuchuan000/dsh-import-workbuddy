/**
 * 回归测试：选择逻辑（lib/select.mjs）。
 *
 * 零依赖，`node test/run.mjs` 直接跑。
 * 每个用例在内存里构造输入，不碰真实 ~/.dsh。
 */

import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'

import { excludeByIds, filterByIds, parseSelection, selectInteractively } from '../lib/select.mjs'

export const name = 'select'

/** 极简断言包装，输出统一的 ✓/✗ 行。 */
function check(label, fn) {
  try {
    fn()
    return { label, ok: true }
  } catch (error) {
    return { label, ok: false, error }
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    return { label, ok: true }
  } catch (error) {
    return { label, ok: false, error }
  }
}

/**
 * 造一个"逐行应答"的输入流。
 *
 * readline 的 question() 等一个换行符。这里的做法是用 PassThrough，
 * 在 readline 真正挂上 data 监听之后再**定时**逐行写入——直接 push 会
 * 因为 read() 被同步反复调用而一次吐完并 EOF，导致后续 question 抛
 * "readline was closed"。
 *
 * 每次 question 输出提示后投喂一行；投喂完所有行后不再写入（流保持打开），
 * 这样最后一个 answer 能正常返回。调用方应当以一次"空行确认"收尾。
 */
function fakeInput(lines) {
  const stream = new PassThrough()
  stream.isTTY = true
  let i = 0
  // 与 question 的节奏解耦：让 readline 先建立监听，再逐行投喂。
  const feed = () => {
    if (i >= lines.length) return
    const line = lines[i++]
    setTimeout(() => {
      stream.write(`${line}\n`)
      feed()
    }, 1)
  }
  setImmediate(feed)
  return stream
}

/** 收集写入的黑洞流（避免测试输出刷屏）。 */
function sink() {
  const chunks = []
  return { write: (s) => chunks.push(String(s)), chunks, text: () => chunks.join('') }
}

export async function run() {
  const results = []

  // --- parseSelection ---
  results.push(check('parseSelection: 空输入 = 确认', () => {
    assert.equal(parseSelection('', 10).kind, 'accept')
    assert.equal(parseSelection('   ', 10).kind, 'accept')
  }))
  results.push(check('parseSelection: all/none/invert/quit 别名', () => {
    for (const v of ['a', 'all', 'ALL', ' a ']) assert.equal(parseSelection(v, 5).kind, 'all')
    for (const v of ['n', 'none']) assert.equal(parseSelection(v, 5).kind, 'none')
    for (const v of ['i', 'invert']) assert.equal(parseSelection(v, 5).kind, 'invert')
    for (const v of ['q', 'quit']) assert.equal(parseSelection(v, 5).kind, 'quit')
  }))
  results.push(check('parseSelection: 单个序号', () => {
    const r = parseSelection('3', 10)
    assert.equal(r.kind, 'set')
    assert.deepEqual([...r.values], [3])
  }))
  results.push(check('parseSelection: 空格分隔多个序号', () => {
    const r = parseSelection('1 3 5', 10)
    assert.deepEqual([...r.values].sort((a, b) => a - b), [1, 3, 5])
  }))
  results.push(check('parseSelection: 逗号/顿号分隔', () => {
    assert.deepEqual([...parseSelection('1,3,5', 10).values].sort((a, b) => a - b), [1, 3, 5])
    assert.deepEqual([...parseSelection('1，3、5', 10).values].sort((a, b) => a - b), [1, 3, 5])
  }))
  results.push(check('parseSelection: 区间 5-9', () => {
    const r = parseSelection('5-9', 10)
    assert.deepEqual([...r.values].sort((a, b) => a - b), [5, 6, 7, 8, 9])
  }))
  results.push(check('parseSelection: 混合序号与区间', () => {
    const r = parseSelection('1 3-5 9', 10)
    assert.deepEqual([...r.values].sort((a, b) => a - b), [1, 3, 4, 5, 9])
  }))
  results.push(check('parseSelection: 倒序区间自动纠正', () => {
    const r = parseSelection('9-7', 10)
    assert.deepEqual([...r.values].sort((a, b) => a - b), [7, 8, 9])
  }))
  results.push(check('parseSelection: 区间重叠去重', () => {
    const r = parseSelection('1-5 3-7', 10)
    assert.deepEqual([...r.values].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7])
  }))
  results.push(check('parseSelection: 越界报错', () => {
    assert.equal(parseSelection('11', 10).kind, 'error')
    assert.equal(parseSelection('0', 10).kind, 'error')
    assert.equal(parseSelection('1-11', 10).kind, 'error')
  }))
  results.push(check('parseSelection: 非法输入报错', () => {
    assert.equal(parseSelection('abc', 10).kind, 'error')
    assert.equal(parseSelection('1;3', 10).kind, 'error')
    assert.equal(parseSelection('-', 10).kind, 'error')
  }))

  // --- filterByIds ---
  const items = [
    { id: 'wb-aaa', cwd: 'd:/x' },
    { id: 'wb-bbb', cwd: 'd:/y' },
    { id: 'wb-ccc', cwd: 'd:/z' },
  ]
  results.push(check('filterByIds: 精确匹配', () => {
    const r = filterByIds(items, ['wb-aaa'])
    assert.equal(r.selected.length, 1)
    assert.equal(r.selected[0].id, 'wb-aaa')
    assert.deepEqual(r.missing, [])
  }))
  results.push(check('filterByIds: 省略 wb- 前缀也能匹配', () => {
    const r = filterByIds(items, ['aaa', 'ccc'])
    assert.deepEqual(r.selected.map(i => i.id).sort(), ['wb-aaa', 'wb-ccc'])
  }))
  results.push(check('filterByIds: 不存在的 id 进 missing', () => {
    const r = filterByIds(items, ['wb-aaa', 'wb-zzz'])
    assert.equal(r.selected.length, 1)
    assert.deepEqual(r.missing, ['wb-zzz'])
  }))
  results.push(check('filterByIds: 保持原顺序', () => {
    const r = filterByIds(items, ['wb-ccc', 'wb-aaa'])
    assert.deepEqual(r.selected.map(i => i.id), ['wb-aaa', 'wb-ccc'])
  }))

  // --- excludeByIds ---
  results.push(check('excludeByIds: 剔除单个', () => {
    const r = excludeByIds(items, ['wb-bbb'])
    assert.deepEqual(r.map(i => i.id), ['wb-aaa', 'wb-ccc'])
  }))
  results.push(check('excludeByIds: 省略前缀也能剔除', () => {
    const r = excludeByIds(items, ['bbb'])
    assert.deepEqual(r.map(i => i.id), ['wb-aaa', 'wb-ccc'])
  }))
  results.push(check('excludeByIds: 排除全部', () => {
    assert.equal(excludeByIds(items, ['aaa', 'bbb', 'ccc']).length, 0)
  }))

  // --- selectInteractively ---
  results.push(await checkAsync('交互: 输入序号后回车 = 选中', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['1 3', '']), output: out })
    assert.deepEqual(picked.map(i => i.id), ['wb-aaa', 'wb-ccc'])
  }))
  results.push(await checkAsync('交互: 默认回车 = 什么都没选（安全默认）', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['']), output: out })
    assert.deepEqual(picked, [])
  }))
  results.push(await checkAsync('交互: a 全选后回车', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['a', '']), output: out })
    assert.equal(picked.length, 3)
  }))
  results.push(await checkAsync('交互: n 清空已选', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['a', 'n', '']), output: out })
    assert.deepEqual(picked, [])
  }))
  results.push(await checkAsync('交互: i 反选', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['2', 'i', '']), output: out })
    assert.deepEqual(picked.map(i => i.id).sort(), ['wb-aaa', 'wb-ccc'])
  }))
  results.push(await checkAsync('交互: q 取消返回 null', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['q']), output: out })
    assert.equal(picked, null)
  }))
  results.push(await checkAsync('交互: 非法输入不中断，继续提问', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['abc', '99', '1', '']), output: out })
    assert.deepEqual(picked.map(i => i.id), ['wb-aaa'])
    assert.match(out.text(), /无法识别|超出范围/)
  }))
  results.push(await checkAsync('交互: 追加选择是累加的', async () => {
    const out = sink()
    const picked = await selectInteractively(items, { input: fakeInput(['1', '2', '']), output: out })
    assert.deepEqual(picked.map(i => i.id), ['wb-aaa', 'wb-bbb'])
  }))
  results.push(await checkAsync('交互: 空候选直接返回空数组', async () => {
    const out = sink()
    const picked = await selectInteractively([], { input: fakeInput([]), output: out })
    assert.deepEqual(picked, [])
  }))

  return results
}
