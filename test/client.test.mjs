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

/**
 * 工具栏最左的全选框。
 *
 * 它的标签文字就是「全选」，所以能按整段文字精确定位——列表行里的 label
 * 文字是标题，不会撞上。
 */
function selectAllBox(view) {
  const label = hosts(view, n => n.type === 'label' && text(n).trim() === '全选')[0]
  if (label === undefined) return undefined
  return collect(label).find(n => n.kind === 'host' && n.type === 'input')
}

/** 列表里的分组小标题（它是唯一带 data-group 的宿主元素）。 */
function groupHeadings(view) {
  return hosts(view, n => n.props?.['data-group'] !== undefined).map(n => text(n))
}
/** 分组标题所属的分组键（完整目录），用来断言排序。 */
function groupKeys(view) {
  return hosts(view, n => n.props?.['data-group'] !== undefined).map(n => n.props['data-group'])
}

function textInput(view) { return hosts(view, n => n.type === 'input' && n.props.type === 'text')[0] }

/** 标签按钮，按 data-tab 取。别按文案找：标签名和页内文案是同一批词。 */
function tabButton(view, name) {
  return hosts(view, n => n.type === 'button' && n.props?.['data-tab'] === name)[0]
}
const tabText = (view, name) => text(tabButton(view, name))

/** 配置弹窗的子树（Modal 桩渲出的宿主元素）。 */
function configModal(view) {
  return hosts(view, n => n.props?.['data-modal'] !== undefined).at(-1)
}
/**
 * 弹窗里的节点。
 *
 * 必须限定在弹窗内：列表底部的分页器也有一个 select，树级查询会取到它，
 * 断言就会读到「每页 50」而不是归属方式。
 */
function inModal(view, predicate) {
  const box = configModal(view)
  if (box === undefined) return []
  return collect(box).filter(n => n.kind === 'host' && predicate(n))
}
const modalSelect = (view) => inModal(view, n => n.type === 'select')[0]
function modalCheckbox(view, rowText) {
  const row = inModal(view, n => n.type === 'label' && text(n).includes(rowText)).at(-1)
  if (row === undefined) return undefined
  return collect(row).find(n => n.kind === 'host' && n.type === 'input')
}
const optionValuesOf = (node) => (node === undefined ? [] : collect(node)
  .filter(n => n.kind === 'host' && n.type === 'option')
  .map(n => n.props.value))

// --- 「?」气泡 ---------------------------------------------------------------
//
// 解释性文字全都挂在这些问号上，所以测试必须能精确点到某一个：按 aria-label
// 认，而不是按位置——位置会随版面变，aria-label 是给读屏用的，本来就该唯一。

/** 悬浮/聚焦之后才存在的气泡。 */
const tooltipOf = (node) => collect(node).find(n => n.kind === 'host' && n.props?.role === 'tooltip')

/** chip 的 aria-label 前缀，带标题时是「说明：xxx」。 */
const TIP_LABEL = '说明'

/**
 * 标题右侧那个「?」。
 *
 * `label` 省略时找的是没有附属标题的那一个（设置弹窗自己的说明行）。
 */
function tipChip(root, label) {
  return collect(root).find(n => n.kind === 'host' && n.props?.role === 'button'
    && (label === undefined
      ? n.props?.['aria-label'] === TIP_LABEL
      : n.props?.['aria-label'] === `${TIP_LABEL}：${label}`))
}

/** 气泡的容器（问号外两层）：定位上下文必须挂在它身上。 */
function tipLine(root, chip) {
  const anchor = collect(root).find(n => n.kind === 'host' && n.children?.includes(chip))
  return collect(root).find(n => n.kind === 'host' && n.children?.includes(anchor))
}

/** 气泡的锚点：chip 的父元素，悬浮事件挂在它身上。 */
function tipAnchor(root, label) {
  const chip = tipChip(root, label)
  if (chip === undefined) return undefined
  return collect(root).find(n => n.kind === 'host' && n.children?.includes(chip))
}

/** 所有问号的锚点，用来在悬浮下一个之前把上一个收起来。 */
function tipAnchors(root) {
  return collect(root).filter(n => n.kind === 'host' && Array.isArray(n.children)
    && n.children.some(c => c !== null && c !== undefined && c.kind === 'host'
      && c.props?.role === 'button'
      && typeof c.props?.['aria-label'] === 'string'
      && c.props['aria-label'].startsWith(TIP_LABEL)))
}

/** 悬浮某个问号，返回展开后的气泡（在重渲后的新树里找）。 */
async function hoverTip(view, root, label) {
  // One pointer, one chip: leaving every other anchor first is what the mouse
  // does on its way over. Skipping it leaves the previous bubble in the tree,
  // and `tooltipOf` would hand back that one instead of the new one.
  for (const anchor of tipAnchors(root)) anchor.props.onMouseLeave?.()
  await view.settle()
  const anchor = tipAnchor(view.tree(), label)
  if (anchor === undefined) throw new Error(`没有找到「${label ?? '设置说明'}」的问号`)
  anchor.props.onMouseEnter()
  await view.settle()
  return tooltipOf(view.tree())
}

/** 打开配置弹窗（页面上的「配置」按钮）。 */
async function openConfig(view) { await click(view, button(view, '配置')) }
/** 关掉配置弹窗（弹窗底部的「关闭」）。 */
async function closeConfig(view) { await click(view, inModal(view, n => n.type === 'button' && text(n).includes('关闭')).at(-1)) }

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
      return {
        // 真实 Toast 是 portal 宿主；这里用宿主元素接住同样的 props，
        // 好让断言能把横幅文案读回来。
        Toast: (props) => createElement('div', { 'data-toast': '1', ...props }),
        // 真实 Modal 也是 portal 宿主：标题下方先渲 description，然后是 body
        // 的 children 和 footer 的按钮。三段都接住，测试才点得到配置弹窗里的
        // 控件，也才读得到挂在 description 上的说明问号。
        Modal: (props) => createElement('div', { 'data-modal': props.title ?? '' },
          [props.description, props.children, props.footer]),
      }
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
 * 把设置页与全部浮层挂在同一棵树里：toast 与配置弹窗的状态都是模块级共享的，
 * 分开挂载就断言不到横幅，也点不到弹窗。
 */
function mountPage(bundle, services) {
  const applied = runApply(bundle, services)
  const panel = applied.pick('settings.section')[0].component
  const overlays = applied.pick('shell.overlay').map(entry => entry.component)
  const page = () => createElement('div', {}, [
    createElement(panel, {}),
    ...overlays.map((overlay, index) => createElement(overlay, { key: index })),
  ])
  return { view: mount(page), applied }
}

// --- fixtures ----------------------------------------------------------------

// 字段与 host 的 /sessions 实际返回保持一致：状态标记互相独立。
const SESSION_A = {
  id: 'wb-aaa', title: '修一个导入 bug', cwd: 'D:\\proj\\a', projectDir: 'a',
  createdAt: 1_760_000_000_000, messageCount: 12, alreadyImported: false,
  deletedInWorkBuddy: false, adopted: false, hidden: false, grouped: false, canSyncBack: true,
}
const SESSION_B = {
  id: 'wb-bbb', title: '写一个可视化页面', cwd: 'D:\\proj\\b', projectDir: 'b',
  createdAt: 1_760_000_600_000, messageCount: 30, alreadyImported: false,
  deletedInWorkBuddy: false, adopted: false, hidden: false, grouped: false, canSyncBack: true,
}
const SESSION_DONE = {
  id: 'wb-ccc', title: '已经导过的会话', cwd: 'D:\\proj\\c', projectDir: 'c',
  createdAt: 1_759_999_000_000, messageCount: 4, alreadyImported: true,
  deletedInWorkBuddy: false, adopted: false, hidden: false, grouped: true, canSyncBack: true,
}
/** WorkBuddy 侧已删除、轨迹文件还在的会话。它只是一个普通候选：标记已去掉。 */
const SESSION_DELETED = {
  id: 'wb-ddd', title: '我早就删掉的会话', cwd: 'D:\\proj\\d', projectDir: 'd',
  createdAt: 1_759_998_000_000, messageCount: 7, alreadyImported: false,
  deletedInWorkBuddy: true, adopted: false, hidden: false, grouped: false, canSyncBack: true,
}
/** 接管模式搬过来的：源文件已在 DSH 归档，不能再回写，但可以还原。 */
const SESSION_ADOPTED = {
  id: 'wb-eee', title: '已搬到 DSH 的会话', cwd: 'D:\\proj\\e', projectDir: null,
  createdAt: 1_759_997_000_000, messageCount: 9, alreadyImported: true,
  deletedInWorkBuddy: false, adopted: true, hidden: false, grouped: true, canSyncBack: false,
}
/** 导进来了、却因为当时代码没挂工作区而落在「未分组」的会话。 */
const SESSION_UNGROUPED = {
  id: 'wb-fff', title: '还没归组的会话', cwd: 'D:\\proj\\f', projectDir: 'f',
  createdAt: 1_759_996_000_000, messageCount: 5, alreadyImported: true,
  deletedInWorkBuddy: false, adopted: false, hidden: false, grouped: false, canSyncBack: true,
}

/**
 * 假 fetch：应答全部路由，并记录被问了什么。
 *
 * 状态迁移要跟着真 host 走，否则测不到面板的刷新逻辑：
 *   /import    命中的条目变成 alreadyImported；adopt 模式再额外置 adopted 与
 *              canSyncBack:false（源文件被搬走了，自然不能再回写）。
 *   /restore   命中的条目退回 alreadyImported:false、adopted:false。
 *   /hide      命中的条目 hidden:true（待导入 -> 回收站）。
 *   /unhide    命中的条目 hidden:false（回收站 -> 待导入）。
 *   /regroup   命中的条目 grouped:true。
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
            grouped: true,
            ...(adopting ? { adopted: true, canSyncBack: false, projectDir: null } : {}),
          }
        : s))
      return respond(importResult ?? {
        ok: true,
        mode: body?.options?.mode ?? 'copy',
        imported: (body?.ids ?? []).map(id => ({ id, path: `C:\\x\\${id}`, events: 20 })),
        existing: [], empty: [], failed: [], adoptFailed: [],
        grouped: (body?.ids ?? []).map(id => ({ id, workspaceTitle: 'proj' })),
        regroupFailed: [],
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
    if (url.endsWith('/hide') && method === 'POST') {
      const ids = new Set(body?.ids ?? [])
      current = current.map(s => (ids.has(s.id) ? { ...s, hidden: true } : s))
      return respond({ ok: true, hidden: body?.ids ?? [] })
    }
    if (url.endsWith('/unhide') && method === 'POST') {
      const ids = new Set(body?.ids ?? [])
      current = current.map(s => (ids.has(s.id) ? { ...s, hidden: false } : s))
      return respond({ ok: true, restored: body?.ids ?? [] })
    }
    if (url.endsWith('/regroup') && method === 'POST') {
      const ids = new Set(body?.ids ?? [])
      current = current.map(s => (ids.has(s.id) ? { ...s, grouped: true } : s))
      return respond({
        ok: true,
        grouped: (body?.ids ?? []).map(id => ({ id, workspaceTitle: 'proj' })),
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

  check('apply 注册 settings.section 与两个浮层（toast + 配置弹窗）', () => {
    const applied = runApply(loadBundle())
    const settings = applied.pick('settings.section')
    const overlay = applied.pick('shell.overlay')
    if (settings.length !== 1) throw new Error(`应注册一个设置页，实际 ${settings.length}`)
    if (settings[0].id !== 'import-workbuddy-settings') throw new Error(`id: ${settings[0].id}`)
    if (typeof settings[0].label !== 'function') throw new Error('label 必须是函数（跟随语言切换）')
    if (!settings[0].label().includes('WorkBuddy')) throw new Error(`导航名: ${settings[0].label()}`)
    const ids = overlay.map(entry => entry.id).sort()
    if (ids.join(',') !== 'import-workbuddy-config,import-workbuddy-toast') {
      throw new Error(`浮层应是 toast 与配置弹窗，实际 ${ids.join(',') || '(空)'}`)
    }
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

  await checkAsync('页面顶部是标签条：三栏各报条数 + 配置按钮', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      if (tabText(view, 'pending') !== '待导入2') throw new Error(`待导入栏应报 2：${tabText(view, 'pending')}`)
      if (tabText(view, 'imported') !== '已导入1') throw new Error(`已导入栏应报 1：${tabText(view, 'imported')}`)
      if (tabText(view, 'recycle') !== '回收站0') throw new Error(`回收站栏应报 0：${tabText(view, 'recycle')}`)
      if (tabButton(view, 'pending').props['aria-selected'] !== true) throw new Error('默认停在待导入')
      if (button(view, '配置') === undefined) throw new Error('标签条右侧应有配置按钮')
      // 回收站排在已导入右边，不是插在中间：它是收尾，不是流程的一步。
      const order = hosts(view, n => n.props?.['data-tab'] !== undefined).map(n => n.props['data-tab'])
      if (order.join(',') !== 'pending,imported,recycle') throw new Error(`标签顺序: ${order.join(',')}`)
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('默认栏只列待导入，已导入的行在另一个栏里', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const body = text(view.tree())
      if (!body.includes('修一个导入 bug')) throw new Error('应显示会话标题')
      if (!body.includes('写一个可视化页面')) throw new Error('应显示第二个会话')
      if (body.includes('已经导过的会话')) throw new Error('已导入的行不该出现在待导入栏')
      if (!body.includes('共 2 个会话')) throw new Error(`页脚应报当前栏的条数: ${body.slice(0, 240)}`)

      const pending = checkbox(view, '修一个导入 bug')
      if (pending === undefined) throw new Error('待导入行应有 checkbox')
      if (pending.props.disabled !== false) throw new Error('未导入的行应可勾选')

      // 切到已导入栏：那一条在这儿，带自己的徽章。
      await click(view, tabButton(view, 'imported'))
      if (!text(view.tree()).includes('已经导过的会话')) throw new Error('已导入栏应列出已导入的会话')
      if (!rowBadges(view, '已经导过的会话').includes('已导入')) throw new Error('应显示已导入徽章')
      if (checkbox(view, '已经导过的会话') === undefined) throw new Error('已导入行应有 checkbox')
      if (text(view.tree()).includes('修一个导入 bug')) throw new Error('待导入的行不该出现在已导入栏')
    } finally { globalThis.fetch = realFetch }
  })

  // 已导入的行必须是可勾选的：它是「回写」与「还原」的目标。旧的规则让复选
  // 框替导入按钮做判断，结果同步和还原根本选不中任何东西。
  await checkAsync('已导入的行可勾选，但导入按钮忽略它', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await click(view, tabButton(view, 'imported'))
      const box = checkbox(view, '已经导过的会话')
      if (box.props.disabled !== false) throw new Error('已导入的行应可勾选（回写/还原的目标）')

      await change(view, box, { checked: true })
      // 已导入栏里不该有导入按钮：这一栏没有可导入的东西。
      if (button(view, '导入所选') !== undefined) throw new Error('已导入栏不该出现导入按钮')
      // 但回写按钮应当出现 —— 这正是勾选它的意义。
      if (button(view, '回写所选（1）') === undefined) {
        throw new Error(`勾选已导入且可回写的行应出现回写按钮: ${text(view.tree()).slice(0, 300)}`)
      }
      // 回到待导入栏：这一勾不算进导入（它已经在了），导入按钮仍是 0。
      await click(view, tabButton(view, 'pending'))
      if (button(view, '导入所选（0）') === undefined) {
        throw new Error(`勾选已导入的行不应计入导入: ${text(view.tree()).slice(0, 300)}`)
      }
      if (button(view, '导入所选（0）').props.disabled !== true) throw new Error('没有可导入的行时按钮应禁用')
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

  // 筛选框自己一行，按钮在下一行，全选框在最左 —— 三件事一起断言，因为它们
  // 是同一个布局决定的三面：筛选框不该和按钮抢同一行。
  await checkAsync('筛选框独占一行，全选框在按钮行最左、且是全选整份筛选结果', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const input = textInput(view)
      if (input === undefined) throw new Error('应有筛选框')
      if (input.props.style.width !== '100%') throw new Error('筛选框应占满一行')

      const allBox = selectAllBox(view)
      if (allBox === undefined) throw new Error('按钮行最左应有全选框')
      const label = hosts(view, n => n.type === 'label' && text(n).trim() === '全选')[0]
      if (text(label) !== '全选') throw new Error('全选框的标签应是「全选」')
      // 全选框在 tree 里必须排在「刷新列表」之前：它是那一行的第一个控件。
      const flattened = all(view)
      if (flattened.indexOf(label) > flattened.indexOf(button(view, '刷新列表'))) {
        throw new Error('全选框应在按钮行最左侧')
      }

      await change(view, allBox, { checked: true })
      if (button(view, '导入所选（2）') === undefined) {
        throw new Error(`全选应勾上整份列表的 2 条：${text(view.tree()).slice(0, 300)}`)
      }
      if (!text(view.tree()).includes('已选 2 条')) throw new Error('工具栏应报出选中条数')
      // 再点一次取消：同一个框，不需要第二个「取消全选」按钮。
      await change(view, selectAllBox(view), { checked: false })
      if (button(view, '导入所选（0）') === undefined) throw new Error('再次勾选应清空')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('全选跨过整页，不只当前页', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `wb-m${index + 1}`,
      title: `会话 ${index + 1}`,
      cwd: 'D:\\proj\\many',
      projectDir: 'many',
      createdAt: 1_760_000_000_000 + index,
      messageCount: 3,
      alreadyImported: false,
      deletedInWorkBuddy: false, adopted: false, hidden: false, grouped: false, canSyncBack: true,
    }))
    globalThis.fetch = fakeFetch({ sessions: many }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      // 一页 50 条，全选要的是 60。
      if (!text(view.tree()).includes('共 60 个会话')) throw new Error('应分页')
      await change(view, selectAllBox(view), { checked: true })
      if (button(view, '导入所选（60）') === undefined) {
        throw new Error(`全选应跨页勾上 60 条：${text(view.tree()).slice(0, 300)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('筛选后全选只作用于筛选结果', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, textInput(view), { value: '可视化' })
      await change(view, selectAllBox(view), { checked: true })
      if (button(view, '导入所选（1）') === undefined) {
        throw new Error(`筛选后全选应只勾中 1 条：${text(view.tree()).slice(0, 300)}`)
      }
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

  await checkAsync('导入选项在配置弹窗里，改完会传给 host', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      // 选项已经不在页面上：勾选框只出现在配置弹窗里。
      if (checkbox(view, '丢弃工具调用') !== undefined) throw new Error('选项不该出现在页面上')
      await openConfig(view)
      await change(view, modalCheckbox(view, '丢弃工具调用'), { checked: true })
      await change(view, modalCheckbox(view, '工具调用转纯文本'), { checked: true })
      await closeConfig(view)
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
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
      await change(view, selectAllBox(view), { checked: true })
      await click(view, button(view, '导入所选（2）'))
      if (!text(view.tree()).includes('overrun')) throw new Error('应显示失败原因')
    } finally { globalThis.fetch = realFetch }
  })

  // --- 归属模式 ---------------------------------------------------------------

  await checkAsync('配置弹窗：归属方式三选一，默认 copy，说明随选择变化', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await openConfig(view)
      const box = modalSelect(view)
      if (box === undefined) throw new Error('弹窗里应有归属方式下拉')
      const values = optionValuesOf(box)
      if (values.join(',') !== 'copy,adopt,sync') throw new Error(`下拉选项: ${values.join(',')}`)
      if (box.props.value !== 'copy') throw new Error('默认应是 copy（与既有行为一致）')

      // 说明不再是下拉框下面那段话，而是标题右侧问号里的分点。
      const about = text(configModal(view))
      if (about.includes('只读 WorkBuddy 的会话')) throw new Error(`说明不该常驻版面: ${about.slice(0, 300)}`)
      const copyTip = await hoverTip(view, configModal(view), '归属方式')
      if (!copyTip || !text(copyTip).includes('只读 WorkBuddy 的会话')) {
        throw new Error(`默认应显示 copy 的说明: ${copyTip && text(copyTip)}`)
      }

      await change(view, modalSelect(view), { value: 'adopt' })
      const adopted = await hoverTip(view, configModal(view), '归属方式')
      if (!adopted || !text(adopted).includes('归档到 DSH')) {
        throw new Error(`切到 adopt 后应显示接管说明: ${adopted && text(adopted)}`)
      }
      if (text(adopted).includes('只读 WorkBuddy 的会话')) throw new Error('不应再显示 copy 的说明')

      await change(view, modalSelect(view), { value: 'sync' })
      const synced = await hoverTip(view, configModal(view), '归属方式')
      if (!synced || !text(synced).includes('保留 WorkBuddy 原会话')) {
        throw new Error(`切到 sync 后应显示同步说明: ${synced && text(synced)}`)
      }

      // 页面上那一行要把当下的选择说出来：弹窗关掉之后它只能靠这行。
      await closeConfig(view)
      if (!text(view.tree()).includes('导入方式：同步')) {
        throw new Error(`页面上应复述当前方式: ${text(view.tree()).slice(0, 300)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('配置弹窗：说明挂在标题下方的问号里，不再是段落', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await openConfig(view)

      const chip = tipChip(configModal(view))
      if (chip === undefined) throw new Error('设置弹窗应有自己的问号')
      if (text(configModal(view)).includes('改动立即生效')) throw new Error('说明不该常驻版面')
      if (tooltipOf(configModal(view)) !== undefined) throw new Error('没悬浮就展开了气泡')

      const tip = await hoverTip(view, configModal(view))
      if (!tip || !text(tip).includes('改动立即生效')) {
        throw new Error(`悬浮后应说出「改动立即生效」: ${tip && text(tip)}`)
      }
      // 弹簧卡片只有 380px 宽且裁掉溢出：说明行在最上面，气泡必须向下开。
      if (tip.props.style.top !== '100%') throw new Error('说明行的气泡要向下展开')
      if (tip.props.style.bottom !== 'auto') throw new Error('向下展开时不该再压着 bottom')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('页签不带问号；正文区「帮助 ?」承载这一栏的说明，内容随栏切换', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()

      const page = text(view.tree())
      for (const said of ['把本机 WorkBuddy', '已经在 DSH 里的会话', '从待导入里划掉的会话']) {
        if (page.includes(said)) throw new Error(`栏说明不该常驻版面: ${said}`)
      }

      // 页签条上没有问号：三个页签始终都在条上，挂在某个页签上的气泡会去
      // 解释一个用户还没打开的栏。
      const strip = collect(view.tree()).find(n => n.kind === 'host' && n.props?.role === 'tablist')
      if (strip === undefined) throw new Error('应有页签条')
      if (collect(strip).some(n => n.kind === 'host' && n.props?.role === 'button')) {
        throw new Error('页签条上不该挂问号')
      }

      const cases = [
        ['pending', '把本机 WorkBuddy'],
        ['imported', '已经在 DSH 里的会话'],
        ['recycle', '从待导入里划掉的会话'],
      ]
      for (const [name, said] of cases) {
        await click(view, tabButton(view, name))
        const chip = tipChip(view.tree(), '帮助')
        if (chip === undefined) throw new Error(`正文区缺少「帮助 ?」: ${text(view.tree()).slice(0, 300)}`)
        // 没有定位上下文，气泡会挂到更上层的祖先上 —— 实测会落到视口外面。
        if (tipLine(view.tree(), chip).props.style.position !== 'relative') {
          throw new Error('「帮助 ?」要有自己的定位上下文')
        }
        const tip = await hoverTip(view, view.tree(), '帮助')
        if (!tip || !text(tip).includes(said)) {
          throw new Error(`「${name}」栏的帮助应说出这一栏的事: ${tip && text(tip)}`)
        }
        // 正文区第一行，上方只有页签条，向上开没有空间。
        if (tip.props.style.top !== '100%') throw new Error(`「${name}」的气泡要向下展开`)
        if (tip.props.style.bottom !== 'auto') throw new Error('向下展开时不该再压着 bottom')
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('导入请求带上选中的模式', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await openConfig(view)
      await change(view, modalSelect(view), { value: 'adopt' })
      await closeConfig(view)
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
      await openConfig(view)
      await change(view, modalSelect(view), { value: 'adopt' })
      await closeConfig(view)
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, button(view, '导入所选（1）'))

      // 导进来的行离开了待导入栏，接管过的还会多一个徽章 —— 那些在另一栏里看。
      await click(view, tabButton(view, 'imported'))
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
      // 还原成功后它回到待导入栏（假 fetch 已把 adopted 置回 false）。
      await click(view, tabButton(view, 'pending'))
      if (!text(view.tree()).includes('修一个导入 bug')) throw new Error('还原后应回到待导入栏')
      if (rowBadges(view, '修一个导入 bug').includes('已接管')) throw new Error('还原后不应还显示已接管')
    } finally { globalThis.fetch = realFetch }
  })

  // --- 列表分组 ---------------------------------------------------------------

  await checkAsync('列表按分组分块：同组相邻，每组一个小标题', async () => {
    // 三个不同项目 + 一条没有目录的，故意打乱给进来。
    const rows = [
      { ...SESSION_A, id: 'wb-a1', title: 'A 的第一个', cwd: 'D:\\proj\\zz' },
      { ...SESSION_B, id: 'wb-b1', title: 'B 的', cwd: 'D:\\proj\\aa' },
      { ...SESSION_A, id: 'wb-a2', title: 'A 的第二个', cwd: 'D:\\proj\\zz' },
      { ...SESSION_A, id: 'wb-n1', title: '没有目录的', cwd: null, projectDir: '' },
    ]
    globalThis.fetch = fakeFetch({ sessions: rows }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const keys = groupKeys(view)
      if (keys.join('|') !== 'D:\\proj\\aa|D:\\proj\\zz|') {
        throw new Error(`分组应排序且同组相邻，实际: ${keys.join('|')}`)
      }
      const headings = groupHeadings(view)
      if (!headings[0].startsWith('aa1')) throw new Error(`小标题应是组名 + 条数: ${headings.join(' / ')}`)
      if (!headings[1].startsWith('zz2')) throw new Error(`同组两行只该有一个标题: ${headings.join(' / ')}`)
      if (!headings[2].startsWith('未分组1')) throw new Error(`没有目录的应落在未分组: ${headings.join(' / ')}`)

      // 同一组的行必须连在一起：A 的两行之间不该隔着 B。
      const body = text(view.tree())
      const atFirst = body.indexOf('A 的第一个')
      const atSecond = body.indexOf('A 的第二个')
      const atB = body.indexOf('B 的')
      if (!(atFirst < atSecond && atB < atFirst)) {
        throw new Error(`同组未相邻: ${[atFirst, atSecond, atB].join(',')}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('时间列显示的是最后活动时间，不是创建时间', async () => {
    // 一个开在去年、一直聊到今年的会话：两个时间差了一年，谁被显示出来一目了然。
    const createdAt = new Date('2025-01-05T10:00:00').getTime()
    const updatedAt = new Date('2026-06-09T10:00:00').getTime()
    const rows = [{
      ...SESSION_A, id: 'wb-t1', title: '开了很久还在聊的',
      cwd: 'D:\\proj\\tt', createdAt, updatedAt,
    }]
    globalThis.fetch = fakeFetch({ sessions: rows }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const body = text(view.tree())
      const shown = new Date(updatedAt).toLocaleString()
      const stale = new Date(createdAt).toLocaleString()
      if (!body.includes(shown)) throw new Error(`时间列应显示最后活动 ${shown}，实际: ${body.slice(0, 400)}`)
      if (body.includes(stale)) throw new Error(`不该再显示创建时间 ${stale}`)
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('分块之间按块内最新活动排，不再按目录名字母序', async () => {
    // 字母序会把 aa 排在最上面；但 aa 里全是去年的旧会话，zz 里刚聊过。
    const OLD = new Date('2025-01-05T10:00:00').getTime()
    const NEW = new Date('2026-06-09T10:00:00').getTime()
    const rows = [
      { ...SESSION_A, id: 'wb-a1', title: 'aa 里的旧会话', cwd: 'D:\\proj\\aa', createdAt: OLD, updatedAt: OLD },
      { ...SESSION_A, id: 'wb-z1', title: 'zz 里的旧会话', cwd: 'D:\\proj\\zz', createdAt: OLD, updatedAt: OLD },
      { ...SESSION_B, id: 'wb-z2', title: 'zz 里刚聊过的', cwd: 'D:\\proj\\zz', createdAt: OLD, updatedAt: NEW },
    ]
    globalThis.fetch = fakeFetch({ sessions: rows }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const keys = groupKeys(view)
      // zz 整体排到 aa 上面：它里面有一条是最近的，而 aa 里最晚的也停在去年。
      // 字母序会把 aa 排在前面，所以这条断言本身就区分了两种排序依据。
      if (keys.join('|') !== 'D:\\proj\\zz|D:\\proj\\aa') {
        throw new Error(`块应按块内最新活动排，实际: ${keys.join('|')}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('已导入栏里未归组的行有徽标，勾选后可以一键归组', async () => {
    const fetch = fakeFetch({ sessions: [SESSION_DONE, SESSION_UNGROUPED] })
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await click(view, tabButton(view, 'imported'))
      const badges = rowBadges(view, '还没归组的会话')
      if (!badges.includes('未分组')) throw new Error(`未归组的行应有徽标: ${badges.join(',')}`)
      if (rowBadges(view, '已经导过的会话').includes('未分组')) throw new Error('已归组的行不该有徽标')
      if (button(view, '归入分组（1）') !== undefined) throw new Error('没勾选时不该出现归组按钮')

      await change(view, checkbox(view, '还没归组的会话'), { checked: true })
      const btn = button(view, '归入分组（1）')
      if (btn === undefined) throw new Error(`勾选未归组的行后应出现归组按钮: ${text(view.tree()).slice(0, 300)}`)
      const before = toastNode(view)?.props?.key ?? 0
      await click(view, btn)
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/regroup'))
      if (post === undefined) throw new Error('应发起归组请求')
      if (post.body.ids.join(',') !== 'wb-fff') throw new Error(`归组目标: ${post.body.ids.join(',')}`)
      const toast = toastNode(view)
      if (toast === undefined || toast.props.key <= before) throw new Error('应弹出归组结果')
      if (!String(toast.props.text).includes('已把 1 个会话归入原分组')) throw new Error(`toast 文案: ${toast.props.text}`)
      if (rowBadges(view, '还没归组的会话').includes('未分组')) throw new Error('归组后徽标应消失')
    } finally { globalThis.fetch = realFetch }
  })

  // --- 软删除 / 回收站 ---------------------------------------------------------

  await checkAsync('删除所选是软删除：离开待导入，落进回收站栏', async () => {
    const fetch = fakeFetch()
    globalThis.fetch = fetch.impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await change(view, checkbox(view, '写一个可视化页面'), { checked: true })
      await click(view, button(view, '删除所选（1）'))
      const post = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/hide'))
      if (post === undefined) throw new Error('应发起 hide 请求')
      if (post.body.ids.join(',') !== 'wb-bbb') throw new Error(`删除目标: ${post.body.ids.join(',')}`)

      const body = text(view.tree())
      if (body.includes('写一个可视化页面')) throw new Error('软删除后不该还在待导入栏')
      if (tabText(view, 'pending') !== '待导入1') throw new Error(`待导入条数应减一: ${tabText(view, 'pending')}`)
      if (tabText(view, 'recycle') !== '回收站1') throw new Error(`回收站条数应加一: ${tabText(view, 'recycle')}`)
      if (button(view, '删除所选（0）').props.disabled !== true) throw new Error('删除后选择应清空')

      // 回收站栏里能看到它，并且能恢复。
      await click(view, tabButton(view, 'recycle'))
      if (!text(view.tree()).includes('写一个可视化页面')) throw new Error('回收站应列出被划掉的会话')
      if (button(view, '删除所选（0）') !== undefined) throw new Error('回收站栏不该有删除按钮')
      await change(view, checkbox(view, '写一个可视化页面'), { checked: true })
      const restore = button(view, '恢复所选（1）')
      if (restore === undefined) throw new Error(`回收站里应能恢复: ${text(view.tree()).slice(0, 300)}`)
      await click(view, restore)
      const undo = fetch.calls.find(c => c.method === 'POST' && c.url.endsWith('/unhide'))
      if (undo === undefined) throw new Error('应发起 unhide 请求')
      if (undo.body.ids.join(',') !== 'wb-bbb') throw new Error(`恢复目标: ${undo.body.ids.join(',')}`)

      await click(view, tabButton(view, 'pending'))
      if (!text(view.tree()).includes('写一个可视化页面')) throw new Error('恢复后应回到待导入栏')
      if (tabText(view, 'recycle') !== '回收站0') throw new Error('恢复后回收站应清空')
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('回收站为空时给出自己的空状态', async () => {
    globalThis.fetch = fakeFetch().impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      await click(view, tabButton(view, 'recycle'))
      if (!text(view.tree()).includes('回收站是空的')) {
        throw new Error(`回收站空态: ${text(view.tree()).slice(0, 240)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('WorkBuddy 侧删过的会话不再打标、也不被全选排除', async () => {
    globalThis.fetch = fakeFetch({ sessions: [SESSION_A, SESSION_DELETED] }).impl
    try {
      const { view } = mountPage(loadBundle())
      await view.settle()
      const body = text(view.tree())
      if (body.includes('已删除')) throw new Error('「已删除」标记应当已经去掉')
      if (rowBadges(view, '我早就删掉的会话').length > 0) throw new Error('那一行不该再有任何徽章')

      // 全选包含它：想排除哪一条，用本页自己的删除，而不是替用户猜。
      await change(view, selectAllBox(view), { checked: true })
      if (button(view, '导入所选（2）') === undefined) {
        throw new Error(`全选应包含 WorkBuddy 侧删过的会话: ${text(view.tree()).slice(0, 300)}`)
      }
    } finally { globalThis.fetch = realFetch }
  })

  await checkAsync('WorkBuddy 侧删过的会话可以手动勾选导入', async () => {
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
      // 先勾一个未导入的：它不能进回写目标，虽然它这一勾会被记住。
      await change(view, checkbox(view, '修一个导入 bug'), { checked: true })
      await click(view, tabButton(view, 'imported'))
      if (button(view, '回写所选（0）') !== undefined) throw new Error('未导入的行不该出现在回写目标里')

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
      await click(view, tabButton(view, 'imported'))
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
      await openConfig(view)
      await change(view, modalSelect(view), { value: 'adopt' })
      await closeConfig(view)
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
      if (!body.includes('共 2 个会话')) throw new Error(`占位符应插值: ${body.slice(0, 240)}`)
      if (!body.includes('导入方式：拷贝（保留原会话）')) throw new Error(`计划行应插值: ${body.slice(0, 240)}`)
      if (body.includes('{n}') || body.includes('{mode}')) throw new Error('不应残留未插值的占位符')

      // 源目录在配置弹窗里，占位符同样要插值。
      await openConfig(view)
      const dialog = text(configModal(view))
      if (!dialog.includes('C:\\Users\\USER\\.workbuddy')) throw new Error(`root 应插值: ${dialog.slice(0, 240)}`)
      if (dialog.includes('{root}')) throw new Error('root 占位符也应插值')
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
