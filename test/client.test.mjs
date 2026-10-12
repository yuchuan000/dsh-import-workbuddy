/**
 * 冒烟测试：dsh-import-workbuddy CLIENT 半场（设置页）。
 *
 * client.js 是「经典脚本」——它通过 window.__ModuleLoader__.load 注册工厂，
 * 不能被 import。所以这里的做法是把源码读出来、用假 window 求值，再用假
 * require 驱动工厂，拿到注册的组件。
 *
 * DSH 应用里没有 react-dom，所以不搭 DOM，而是用 ~90 行的 hooks 运行时渲染：
 * 足够支撑 useState / useEffect / useCallback，可以挂载面板、读出它渲染出
 * 的行、点击它的按钮、再对下一次渲染做断言。这覆盖了这类代码真正会犯的错——
 * 条件调用 hook、对 `picked` 的闭包失效、渲染时抛异常、fetch 没把用户勾的
 * id 发出去。
 */

import { readFile } from 'node:fs/promises'

export const name = 'client'

// --- 最小 React --------------------------------------------------------------
//
// 按路径给 hook 开槽：面板是唯一有状态的组件，它渲染的每一行都是宿主元素，
// 所以位置在多次渲染之间是稳定的。

function flatten(children) {
  if (children === undefined || children === null || typeof children === 'boolean') return []
  if (Array.isArray(children)) return children.flatMap(flatten)
  return [children]
}

function createElement(type, props, ...rest) {
  const own = props !== null && props !== undefined && Object.prototype.hasOwnProperty.call(props, 'children')
  return { $$typeof: 'element', type, props: { ...(props ?? {}), children: flatten(own ? props.children : rest) } }
}

const hookSlots = new Map()
let currentSlot = null
let effectQueue = []

function slotAt(path) {
  if (!hookSlots.has(path)) hookSlots.set(path, { states: [], effects: [], memos: [], index: 0 })
  const slot = hookSlots.get(path)
  slot.index = 0
  return slot
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

const React = {
  createElement,
  useState(initial) {
    const slot = currentSlot
    const i = slot.index++
    if (slot.states[i] === undefined) slot.states[i] = { value: typeof initial === 'function' ? initial() : initial }
    const cell = slot.states[i]
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useEffect(callback, deps) {
    const slot = currentSlot
    const i = slot.index++
    const previous = slot.effects[i]
    slot.effects[i] = { deps, cleanup: previous?.cleanup }
    if (previous === undefined || !sameDeps(previous.deps, deps)) effectQueue.push({ slot, i, callback })
  },
  useCallback(callback, deps) {
    const slot = currentSlot
    const i = slot.index++
    const previous = slot.memos[i]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
    slot.memos[i] = { deps, value: callback }
    return callback
  },
  useMemo(factory, deps) {
    const slot = currentSlot
    const i = slot.index++
    const previous = slot.memos[i]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
    const value = factory()
    slot.memos[i] = { deps, value }
    return value
  },
  useRef(initial) {
    const slot = currentSlot
    const i = slot.index++
    if (slot.states[i] === undefined) slot.states[i] = { value: { current: initial } }
    return slot.states[i].value
  },
}

// --- 最小渲染器 --------------------------------------------------------------

function renderNode(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', value: String(node) }
  if (Array.isArray(node)) return { kind: 'list', items: node.map((child, i) => renderNode(child, `${path}.${i}`)) }
  if (typeof node === 'object' && node.$$typeof === 'element') {
    if (typeof node.type === 'function') {
      const outer = currentSlot
      currentSlot = slotAt(path)
      let produced
      try {
        produced = node.type(node.props)
      } finally {
        currentSlot = outer
      }
      return renderNode(produced, `${path}>${node.type.name || 'anon'}`)
    }
    return {
      kind: 'host',
      type: node.type,
      props: node.props,
      children: node.props.children.map((child, i) => renderNode(child, `${path}.${i}`)),
    }
  }
  return { kind: 'text', value: String(node) }
}

function flushEffects() {
  for (let pass = 0; pass < 8 && effectQueue.length > 0; pass += 1) {
    const queued = effectQueue.splice(0)
    for (const entry of queued) {
      const previous = entry.slot.effects[entry.i]
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      const cleanup = entry.callback()
      if (previous !== undefined) previous.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }
}

/** 挂载一个组件，返回驱动它的句柄。 */
function mount(component) {
  hookSlots.clear()
  effectQueue = []
  let tree = null
  const render = () => {
    tree = renderNode(createElement(component, {}), 'root')
    flushEffects()
  }
  render()
  return {
    tree: () => tree,
    /** 等异步 state 更新落地后重新渲染。 */
    settle: async () => {
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      render()
      flushEffects()
    },
  }
}

function collect(node, into = []) {
  if (node === null || node === undefined) return into
  into.push(node)
  if (node.kind === 'list') for (const item of node.items) collect(item, into)
  if (node.kind === 'host') for (const child of node.children) collect(child, into)
  return into
}

function all(view) { return collect(view.tree()) }

function text(node) {
  if (node === null || node === undefined) return ''
  if (node.kind === 'text') return node.value
  const parts = []
  collect(node).forEach(n => { if (n.kind === 'text') parts.push(n.value) })
  return parts.join('')
}

function hosts(view, predicate) { return all(view).filter(n => n.kind === 'host' && predicate(n)) }

function button(view, needle) {
  return hosts(view, n => n.type === 'button' && text(n).includes(needle)).at(-1)
}

/** 找到包含指定文字的 label 行里的 checkbox。 */
function checkbox(view, rowText) {
  const row = hosts(view, n => n.type === 'label' && text(n).includes(rowText)).at(-1)
  if (row === undefined) return undefined
  return collect(row).find(n => n.kind === 'host' && n.type === 'input')
}

function textInput(view) { return hosts(view, n => n.type === 'input' && n.props.type === 'text')[0] }

/** 归属方式下拉。 */
function selectBox(view) { return hosts(view, n => n.type === 'select')[0] }

/** 下拉里所有 option 的 value。 */
function optionValues(view) {
  const box = selectBox(view)
  if (box === undefined) return []
  return collect(box)
    .filter(n => n.kind === 'host' && n.type === 'option')
    .map(n => n.props.value)
}

/** 找到包含指定文字的 label 行里的徽章文本数组。 */
function rowBadges(view, rowText) {
  const row = hosts(view, n => n.type === 'label' && text(n).includes(rowText)).at(-1)
  if (row === undefined) return []
  return collect(row)
    .filter(n => n.kind === 'host' && n.type === 'span' && n.props?.style?.borderRadius === 8)
    .map(n => text(n))
}

function toastNode(view) { return hosts(view, n => n.props?.['data-toast'] === '1').at(-1) }

async function click(view, node) {
  await node?.props?.onClick?.()
  await view.settle()
}

async function change(view, node, target) {
  await node?.props?.onChange?.({ target })
  await view.settle()
}

// --- 加载 client 半场 ---------------------------------------------------------

const CLIENT_SOURCE = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

/** 求值 bundle，返回它的 ModuleLoader entry 与 require 记录。 */
function loadBundle() {
  const requested = []
  const loader = { entries: [], load(entry) { this.entries.push(entry) } }
  const require = (id) => {
    requested.push(id)
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      // 真实 Toast 是 portal 宿主；这里用宿主元素接住同样的 props，
      // 好让断言能把横幅文案读回来。
      return { Toast: (props) => createElement('div', { 'data-toast': '1', ...props }) }
    }
    throw new Error(`unexpected require: ${id}`)
  }
  const fn = new Function('window', 'navigator', CLIENT_SOURCE)
  fn({ __ModuleLoader__: loader }, { languages: ['zh-CN'], language: 'zh-CN' })
  if (loader.entries.length !== 1) throw new Error('bundle 必须注册恰好一个 entry')
  return { entry: loader.entries[0], require, requested }
}

/** 用假 cordis ctx 跑插件的 apply，返回它注册进各槽位的组件。 */
function runApply(bundle, services = {}) {
  const registrations = []
  const injections = []
  const ctx = {
    get: (key) => services[key],
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose !== 'function') return undefined
      return () => { try { dispose() } catch { /* best effort */ } }
    },
    inject: (deps, callback) => { injections.push({ deps, callback }); return undefined },
    slots: {
      inject: (name, callback) => { callback(); return undefined },
      register: (meta, component) => { registrations.push({ ...meta, component }); return () => {} },
    },
  }
  const exported = bundle.entry.factory(bundle.require)
  exported.apply(ctx)
  return {
    registrations,
    injections,
    exported,
    pick: (slot) => registrations.filter(r => r.name === slot),
  }
}

/**
 * 把设置页与 toast 浮层挂在同一棵树里：toast 状态是模块级共享的，
 * 分开挂载就断言不到横幅了。
 */
function mountPage(bundle, services) {
  const applied = runApply(bundle, services)
  const panel = applied.pick('settings.section')[0].component
  const toastHost = applied.pick('shell.overlay')[0].component
  const page = () => createElement('div', {}, [createElement(panel, {}), createElement(toastHost, {})])
  return { view: mount(page), applied }
}

// --- fixtures ----------------------------------------------------------------

// 字段与 host 的 /sessions 实际返回保持一致：三个状态标记互相独立。
const SESSION_A = {
  id: 'wb-aaa', title: '修一个导入 bug', cwd: 'D:\\proj\\a', projectDir: 'a',
  createdAt: 1_760_000_000_000, messageCount: 12, alreadyImported: false,
  deletedInWorkBuddy: false, adopted: false, canSyncBack: true,
}
const SESSION_B = {
  id: 'wb-bbb', title: '写一个可视化页面', cwd: 'D:\\proj\\b', projectDir: 'b',
  createdAt: 1_760_000_600_000, messageCount: 30, alreadyImported: false,
  deletedInWorkBuddy: false, adopted: false, canSyncBack: true,
}
const SESSION_DONE = {
  id: 'wb-ccc', title: '已经导过的会话', cwd: 'D:\\proj\\c', projectDir: 'c',
  createdAt: 1_759_999_000_000, messageCount: 4, alreadyImported: true,
  deletedInWorkBuddy: false, adopted: false, canSyncBack: true,
}
/** WorkBuddy 侧已删除、轨迹文件还在的会话。 */
const SESSION_DELETED = {
  id: 'wb-ddd', title: '我早就删掉的会话', cwd: 'D:\\proj\\d', projectDir: 'd',
  createdAt: 1_759_998_000_000, messageCount: 7, alreadyImported: false,
  deletedInWorkBuddy: true, adopted: false, canSyncBack: true,
}
/** 接管模式搬过来的：源文件已在 DSH 归档，不能再回写，但可以还原。 */
const SESSION_ADOPTED = {
  id: 'wb-eee', title: '已搬到 DSH 的会话', cwd: 'D:\\proj\\e', projectDir: null,
  createdAt: 1_759_997_000_000, messageCount: 9, alreadyImported: true,
  deletedInWorkBuddy: false, adopted: true, canSyncBack: false,
}

/**
 * 假 fetch：应答四条路由，并记录被问了什么。
 *
 * 状态迁移要跟着真 host 走，否则测不到面板的刷新逻辑：
 *   /import   命中的条目变成 alreadyImported；adopt 模式再额外置 adopted 与
 *             canSyncBack:false（源文件被搬走了，自然不能再回写）。
 *   /restore  命中的条目退回 alreadyImported:false、adopted:false。
 */
function fakeFetch({ sessions, importResult, syncResult, restoreResult } = {}) {
  const calls = []
  let current = (sessions ?? [SESSION_A, SESSION_B, SESSION_DONE]).map(s => ({ ...s }))
  const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url: String(url), method, body })
    if (url.endsWith('/sessions') && method === 'GET') {
      return respond({
        ok: true,
        workbuddyRoot: 'C:\\Users\\USER\\.workbuddy',
        sessionsRoot: 'C:\\Users\\USER\\.dsh\\sessions',
        sessions: current.map(s => ({ ...s })),
      })
    }
    if (url.endsWith('/import') && method === 'POST') {
      const ids = new Set(body?.ids ?? [])
      const adopting = body?.options?.mode === 'adopt'
      current = current.map(s => (ids.has(s.id)
        ? {
            ...s,
            alreadyImported: true,
            ...(adopting ? { adopted: true, canSyncBack: false, projectDir: null } : {}),
          }
        : s))
      return respond(importResult ?? {
        ok: true,
        mode: body?.options?.mode ?? 'copy',
        imported: (body?.ids ?? []).map(id => ({ id, path: `C:\\x\\${id}`, events: 20 })),
        existing: [], empty: [], failed: [], adoptFailed: [],
      })
    }
    if (url.endsWith('/sync') && method === 'POST') {
      return respond(syncResult ?? {
        ok: true,
        synced: (body?.ids ?? []).map(id => ({ id, appended: 4, lastSeq: 99 })),
        failed: [],
      })
    }
    if (url.endsWith('/restore') && method === 'POST') {
      const ids = new Set(body?.ids ?? [])
      current = current.map(s => (ids.has(s.id)
        ? { ...s, alreadyImported: false, adopted: false, canSyncBack: true }
        : s))
      return respond(restoreResult ?? {
        ok: true,
        restored: (body?.ids ?? []).map(id => ({ id, restored: `C:\\wb\\${id}.jsonl` })),
        failed: [],
      })
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }
  }
  return { impl, calls }
}

// --- 驱动 --------------------------------------------------------------------

const results = []
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}
async function checkAsync(label, fn) {
  try { await fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

const realFetch = globalThis.fetch

export async function run() {
  check('bundle 注册唯一的 ModuleLoader entry', () => {
    const bundle = loadBundle()
    if (bundle.entry.id !== 'dsh-import-workbuddy') throw new Error(`id 不对: ${bundle.entry.id}`)
    if (typeof bundle.entry.factory !== 'function') throw new Error('factory 必须是函数')
  })

  check('apply 注册 settings.section 与 shell.overlay', () => {
    const applied = runApply(loadBundle())
    const settings = applied.pick('settings.section')
    const overlay = applied.pick('shell.overlay')
    if (settings.length !== 1) throw new Error(`应注册一个设置页，实际 ${settings.length}`)
    if (settings[0].id !== 'import-workbuddy-settings') throw new Error(`id: ${settings[0].id}`)
    if (typeof settings[0].label !== 'function') throw new Error('label 必须是函数（跟随语言切换）')
    if (!settings[0].label().includes('WorkBuddy')) throw new Error(`导航名: ${settings[0].label()}`)
    if (overlay.length !== 1) throw new Error(`应注册一个 toast 浮层，实际 ${overlay.length}`)
  })

  check('factory 只 require react 与 primitives', () => {
    const bundle = loadBundle()
    const applied = runApply(bundle)
    const sorted = bundle.requested.slice().sort()
    const wanted = ['@deepseek-ai/dsh-client-ui-primitives', 'react']
    if (sorted.join(',') !== wanted.join(',')) throw new Error(`实际 require: ${sorted.join(',')}`)
    if (!applied.exported.inject.includes('slots')) throw new Error('client 半场应注入 slots')
  })

  check('缺少服务时改为 inject 而不是硬失败', () => {
    const applied = runApply(loadBundle())
    const deps = applied.injections.map(i => i.deps.join('+'))
    if (!deps.includes('sessions')) throw new Error(`应 inject sessions，实际: ${deps.join(' | ')}`)
    if (!deps.includes('locale')) throw new Error(`应 inject locale，实际: ${deps.join(' | ')}`)
  })

  await checkAsync('首次渲染显示加载态', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      if (!text(view.tree()).includes('正在读取')) throw new Error('应先显示加载态')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('列表渲染全部会话，并给已导入的行打徽章', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const body = text(view.tree())
      if (!body.includes('修一个导入 bug')) throw new Error('应显示会话标题')
      if (!body.includes('写一个可视化页面')) throw new Error('应显示第二个会话')
      if (!body.includes('共 3 个会话，其中 1 个已导入')) throw new Error(`统计行: ${body.slice(0, 200)}`)
      if (!body.includes('已导入')) throw new Error('应显示已导入徽章')

      const box = checkbox(view, '已经导过的会话')
      if (box === undefined) throw new Error('已导入行应有 checkbox')

      const pending = checkbox(view, '修一个导入 bug')
      if (pending.props.disabled !== false) throw new Error('未导入的行应可勾选')
    } finally { globalThis.fetch = realFetch }
  })

  // 已导入的行必须是可勾选的：它是「回写」与「还原」的目标。旧的规则让复选
  // 框替导入按钮做判断，结果同步和还原根本选不中任何东西。
  await checkAsync('已导入的行可勾选，但导入按钮忽略它', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const box = checkbox(view, '已经导过的会话')
      if (box.props.disabled !== false) throw new Error('已导入的行应可勾选（回写/还原的目标）')

      await change(view, box, { checked: true })
      if (button(view, '导入所选（0）') === undefined) {
        throw new Error(`勾选已导入的行不应计入导入: ${text(view.tree()).slice(0, 300)}`)
      }
      if (button(view, '导入所选（0）').props.disabled !== true) throw new Error('没有可导入的行时按钮应禁用')
      // 但回写按钮应当出现 —— 这正是勾选它的意义。
      if (button(view, '回写所选（1）') === undefined) {
        throw new Error(`勾选已导入且可回写的行应出现回写按钮: ${text(view.tree()).slice(0, 300)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('勾选一行后导入按钮反映数量', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      if (button(view, '导入所选（0）') === undefined) throw new Error('未选时按钮应是 0')

      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      const updated = button(view, '导入所选（1）')
      if (updated === undefined) throw new Error('勾选后按钮应显示 1')
      if (updated.props.disabled !== false) throw new Error('有选择时按钮应可用')

      // 再点一次取消勾选。
      await change(view, checkbox(view, '修一个导入 bug'), { checked: false })
      if (button(view, '导入所选（0）') === undefined) throw new Error('取消勾选后应回到 0')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('全选未导入 只选未导入的行', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await click(view, button(view, '全选未导入'))
      if (button(view, '导入所选（2）') === undefined) {
        throw new Error(`3 个里 1 个已导入，全选应得 2: ${text(view.tree()).slice(0, 300)}`)
      }
      await click(view, button(view, '清空选择'))
      if (button(view, '导入所选（0）') === undefined) throw new Error('再次点击应清空')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('导入只发送勾选的 id，并弹出 toast', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const before = toastNode(view)?.props?.key ?? 0
      await change(view, checkbox(view, '写一个可视化页面'), { checked: true })
      await click(view, button(view, '导入所选（1）'))

      const post = fetch.calls.find(c => c.method === 'POST')
      if (post === undefined) throw new Error('应发起 POST /import')
      if (JSON.stringify(post.body.ids) !== JSON.stringify(['wb-bbb'])) {
        throw new Error(`只应导入勾选的 id，实际: ${JSON.stringify(post.body)}`)
      }
      if (post.body.options.noTools !== false) throw new Error('应带上选项默认值')

      // `key` 就是 toast 的序号：比对它才能确认这次导入真的弹了新横幅，
      // 而不是读到上一次测试留下的那条。
      const toast = toastNode(view)
      if (toast === undefined) throw new Error('应弹出完成提示')
      if (toast.props.key <= before) throw new Error(`toast 未刷新: key ${toast.props.key} <= ${before}`)
      if (!String(toast.props.text).includes('已导入 1 个会话')) throw new Error(`toast 文案: ${toast.props.text}`)
      if (button(view, '导入所选（0）') === undefined) throw new Error('导入后选择应清空')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('导入选项会传给 host', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await change(view, checkbox(view, '丢弃工具调用'), { checked: true })
      await change(view, checkbox(view, '工具调用转纯文本'), { checked: true })
      await click(view, button(view, '导入所选（1）'))
      const post = fetch.calls.find(c => c.method === 'POST')
      if (post.body.options.noTools !== true) throw new Error('应传 noTools=true')
      if (post.body.options.toolsAsText !== true) throw new Error('应传 toolsAsText=true')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('筛选按标题 / 目录 / id 过滤', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const input = textInput(view)
      if (input === undefined) throw new Error('应有筛选框')

      await change(view, input, { value: 'D:\\proj\\b' })
      let body = text(view.tree())
      if (body.includes('修一个导入 bug')) throw new Error('筛选后不应保留其它会话')
      if (!body.includes('写一个可视化页面')) throw new Error('筛选应保留匹配会话')

      await change(view, input, { value: 'wb-aaa' })
      body = text(view.tree())
      if (!body.includes('修一个导入 bug')) throw new Error('按 id 也应能筛出')

      await change(view, input, { value: '可视化' })
      if (!text(view.tree()).includes('写一个可视化页面')) throw new Error('按标题也应能筛出')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('拉取失败显示错误与重试按钮', async () => {
    globalThis.fetch = async () => { throw new Error('boom') }
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      if (!text(view.tree()).includes('boom')) throw new Error(`应显示错误: ${text(view.tree()).slice(0, 200)}`)
      if (button(view, '重试') === undefined) throw new Error('应提供重试按钮')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('导入失败不吞掉错误且保留选择', async () => {
    globalThis.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/sessions')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, workbuddyRoot: 'r', sessions: [SESSION_A] }) }
      }
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) }
    }
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))
      if (!text(view.tree()).includes('disk full')) throw new Error('应显示 host 返回的错误')
      if (button(view, '导入所选（1）') === undefined) throw new Error('失败后选择应保留，便于重试')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('部分失败时列出失败项', async () => {
    globalThis.fetch = fakeFetch({
      importResult: {
        ok: true,
        imported: [{ id: 'wb-aaa', path: 'p', events: 3 }],
        existing: [],
        empty: [],
        failed: [{ id: 'wb-bbb', error: 'overrun' }],
      },
    }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await click(view, button(view, '全选未导入'))
      await click(view, button(view, '导入所选（2）'))
      if (!text(view.tree()).includes('overrun')) throw new Error('应显示失败原因')
    } finally { globalThis.fetch = realFetch }
  })

  // --- 归属模式 ---------------------------------------------------------------

  await checkAsync('模式下拉三选一，默认 copy，提示随选择变化', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const box = selectBox(view)
      if (box === undefined) throw new Error('应有归属方式下拉')
      const values = optionValues(view)
      if (values.join(',') !== 'copy,adopt,sync') throw new Error(`下拉选项: ${values.join(',')}`)
      if (box.props.value !== 'copy') throw new Error('默认应是 copy（与既有行为一致）')
      if (!text(view.tree()).includes('只读 WorkBuddy 的会话')) throw new Error('默认应显示 copy 的说明')

      await change(view, box, { value: 'adopt' })
      const body = text(view.tree())
      if (!body.includes('归档到 DSH')) throw new Error(`切到 adopt 后应显示接管说明: ${body.slice(0, 300)}`)
      if (body.includes('只读 WorkBuddy 的会话')) throw new Error('不应再显示 copy 的说明')

      await change(view, selectBox(view), { value: 'sync' })
      if (!text(view.tree()).includes('保留 WorkBuddy 原会话')) throw new Error('切到 sync 后应显示同步说明')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('导入请求带上选中的模式', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, selectBox(view), { value: 'adopt' })
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/import'))
      if (post === undefined) throw new Error('应发起导入请求')
      if (post.body.options?.mode !== 'adopt') throw new Error(`应带 mode=adopt: ${JSON.stringify(post.body)}`)
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('adopt 模式导入后行变「已接管」，并可还原', async () => {
    const fetch = fakeFetch({ sessions: [SESSION_A] })
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, selectBox(view), { value: 'adopt' })
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))

      const badges = rowBadges(view, '修一个导入 bug')
      if (!badges.includes('已接管')) throw new Error(`接管后应有已接管徽章: ${badges.join(',')}`)

      // 刚导入的那行已被清出选择，重新勾上才能还原。
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      if (button(view, '还原到 WorkBuddy') === undefined) {
        throw new Error(`已接管的行应可还原: ${text(view.tree()).slice(0, 300)}`)
      }
      await click(view, button(view, '还原到 WorkBuddy'))
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/restore'))
      if (post === undefined) throw new Error('应发起还原请求')
      if (post.body.ids.join(',') !== 'wb-aaa') throw new Error(`还原目标: ${post.body.ids.join(',')}`)
      // 还原成功后徽章应当消失（假 fetch 已把 adopted 置回 false）
      if (rowBadges(view, '修一个导入 bug').includes('已接管')) throw new Error('还原后不应还显示已接管')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('WorkBuddy 侧已删除的会话打标且不被全选', async () => {
    globalThis.fetch = fakeFetch({ sessions: [SESSION_A, SESSION_DELETED] }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      if (!text(view.tree()).includes('已删除')) throw new Error('应显示已删除徽章')
      if (!rowBadges(view, '我早就删掉的会话').includes('已删除')) throw new Error('徽章应在已删除的那一行上')
      if (!text(view.tree()).includes('你在 WorkBuddy 里已经删过')) throw new Error('应解释这个标记的含义')

      await click(view, button(view, '全选未导入'))
      const importBtn = button(view, '导入所选（1）')
      if (importBtn === undefined) {
        throw new Error(`全选应跳过已删除的，只选 1 个: ${text(view.tree()).slice(0, 300)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('已删除的会话可以手动勾选导入', async () => {
    const fetch = fakeFetch({ sessions: [SESSION_A, SESSION_DELETED] })
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, checkbox(view, '我早就删掉的会话'), { checked: true })
      const importBtn = button(view, '导入所选（1）')
      if (importBtn === undefined) throw new Error('手动勾选已删除的会话应能导入')
      await click(view, importBtn)
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/import'))
      if (post.body.ids.join(',') !== 'wb-ddd') throw new Error(`应只导入勾中的那条: ${post.body.ids.join(',')}`)
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('回写只发已导入的 id，且走 /sync', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      // 先勾一个未导入的：它不能进回写目标。
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      if (button(view, '回写所选（1）') !== undefined) throw new Error('未导入的行不该出现在回写目标里')

      await change(view, checkbox(view, '已经导过的会话'), { checked: true })
      const syncBtn = button(view, '回写所选（1）')
      if (syncBtn === undefined) throw new Error(`应出现回写按钮: ${text(view.tree()).slice(0, 300)}`)
      const before = toastNode(view)?.props?.key ?? 0
      await click(view, syncBtn)
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/sync'))
      if (post === undefined) throw new Error('应发起回写请求')
      if (post.body.ids.join(',') !== 'wb-ccc') throw new Error(`回写目标: ${post.body.ids.join(',')}`)

      // toast 文案是 prop 不是子节点，必须读 props.text。
      const toast = toastNode(view)
      if (toast === undefined) throw new Error('应弹出回写结果')
      if (toast.props.key <= before) throw new Error(`toast 未刷新: key ${toast.props.key}`)
      if (!String(toast.props.text).includes('新增 4 行')) throw new Error(`toast 文案: ${toast.props.text}`)
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('源文件已被接管归档的行不能回写', async () => {
    const fetch = fakeFetch({ sessions: [SESSION_ADOPTED] })
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      if (!rowBadges(view, '已搬到 DSH 的会话').includes('已接管')) throw new Error('应有已接管徽章')
      await change(view, checkbox(view, '已搬到 DSH 的会话'), { checked: true })
      if (button(view, '回写所选（1）') !== undefined) throw new Error('已归档的源文件不能再回写')
      if (button(view, '还原到 WorkBuddy') === undefined) throw new Error('但应当可以还原')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('接管失败单独提示，不算作导入失败', async () => {
    globalThis.fetch = fakeFetch({
      sessions: [SESSION_A],
      importResult: {
        ok: true,
        mode: 'adopt',
        imported: [{ id: 'wb-aaa', path: 'p', events: 10 }],
        existing: [], empty: [], failed: [],
        adoptFailed: [{ id: 'wb-aaa', error: '库被 WorkBuddy 占用' }],
      },
    }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, selectBox(view), { value: 'adopt' })
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))
      const body = text(view.tree())
      if (!body.includes('搬走源文件失败')) throw new Error(`应单独提示接管失败: ${body.slice(0, 300)}`)
      if (body.includes('部分失败')) throw new Error('不应混进「导入失败」的措辞')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('locale 服务在场时注册命名空间，缺席时回落内置词典', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      // (a) 有 locale 服务。
      const registered = []
      const locale = {
        register: (ns, tables) => { registered.push({ ns, tables }); return () => {} },
        translate: (ns, key) => key, // 不认识 → 回落内置词典
      }
      const withLocale = mountPage(loadBundle(), { locale })
      if (registered.length !== 1) throw new Error('应向 locale 服务注册命名空间')
      if (registered[0].ns !== 'import-workbuddy') throw new Error(`ns: ${registered[0].ns}`)
      if (registered[0].tables.zh['settings.nav'].length === 0) throw new Error('应带中文词典')
      await withLocale.view.settle()

      // (b) 无 locale 服务：内置词典 + 占位符插值。
      const { view } = mountPage(loadBundle(), {})
      await view.settle()
      const body = text(view.tree())
      if (!body.includes('共 3 个会话，其中 1 个已导入')) throw new Error(`占位符应插值: ${body.slice(0, 200)}`)
      if (body.includes('{n}')) throw new Error('不应残留未插值的占位符')
      if (body.includes('{root}')) throw new Error('root 占位符也应插值')
    } finally { globalThis.fetch = realFetch }
  })

  // 放最后：sessionsSvc 是模块级状态，一旦注入会影响后续用例的 resync 轮询。
  await checkAsync('导入后刷新侧边栏列表', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const refreshCalls = []
      const sessionsSvc = {
        refresh: () => { refreshCalls.push(1); return Promise.resolve() },
        list: { getSnapshot: () => ({ byId: { 'wb-aaa': { id: 'wb-aaa' } } }) },
      }
      const { view } = mountPage(loadBundle(), { sessions: sessionsSvc })
      await view.settle()
      const before = toastNode(view)?.props?.key ?? 0
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))
      if (refreshCalls.length === 0) throw new Error('导入后应刷新会话列表')

      const toast = toastNode(view)
      if (toast === undefined) throw new Error('应弹出提示')
      if (toast.props.key <= before) throw new Error(`toast 未刷新: key ${toast.props.key} <= ${before}`)
      if (!String(toast.props.text).includes('已导入 1 个会话')) throw new Error(`toast 文案: ${toast.props.text}`)
    } finally { globalThis.fetch = realFetch }
  })

  return results
}
