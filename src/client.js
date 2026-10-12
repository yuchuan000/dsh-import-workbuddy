/**
 * dsh-import-workbuddy — CLIENT half.
 *
 * A settings page ("WorkBuddy 导入") that lists the local WorkBuddy
 * conversations and imports a hand-picked subset into DSH as native sessions.
 *
 * Bundle format (client-modules protocol): a classic script that registers a
 * factory through window.__ModuleLoader__.load. No JSX — plain
 * React.createElement — and theme tokens only, exactly like the host's own
 * settings sections.
 *
 * The page never talks to the filesystem itself: every read and every write
 * goes through the host half's guarded routes (/__dsh-import-workbuddy/*),
 * the same carrier the community market uses for its own mutating actions.
 */

window.__ModuleLoader__.load({
  id: 'dsh-import-workbuddy',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives')

    const PREFIX = '/__dsh-import-workbuddy'
    const SETTINGS_SLOT = 'settings.section'
    const OVERLAY_SLOT = 'shell.overlay'
    const SETTINGS_ID = 'import-workbuddy-settings'
    const TOAST_ID = 'import-workbuddy-toast'
    // The import policy, moved off the page and behind a button, exactly as in
    // dsh-session-recycle's settings page: the list is the reason to open this
    // page, and a form above it pushes the list below the fold.
    const CONFIG_ID = 'import-workbuddy-config'
    // The lists as tabs on one section. They are the same candidates read
    // three ways — what is still to come across, what already has, and what the
    // user swept aside — and the actions differ per tab (import vs sync back /
    // put back), so a tab that names the state keeps each toolbar to the verb
    // that fits it.
    const TAB_PENDING = 'pending'
    const TAB_IMPORTED = 'imported'
    // The third one is this page's own bin, not WorkBuddy's: a candidate swept
    // out of the pending list waits here rather than vanishing. It sits after
    // the two real states because it holds leftovers, not a stage of the flow.
    const TAB_RECYCLE = 'recycle'

    // --- locale -----------------------------------------------------------------

    const NS = 'import-workbuddy'

    const zh = {
      'settings.nav': 'WorkBuddy 导入',
      'settings.tabsLabel': '导入页签',
      'settings.tabPending': '待导入',
      'settings.tabImported': '已导入',
      'settings.tabRecycle': '回收站',
      'settings.tabCount': '共 {n} 条',
      'settings.config': '配置',
      'settings.configTitle': '导入设置',
      // The dialog's own explanation, behind the "?" under its title. It used to
      // be the description paragraph; nothing here is read without asking.
      'settings.configAbout': '这里的改动立即生效，关掉即生效完毕。',
      'settings.close': '关闭',
      'settings.tip': '说明',
      // One explanation per tab, behind that tab's own "?" — the sentence used to
      // be a paragraph under the strip, where it answered "which of the three am
      // I looking at" only after you had already crossed over.
      'settings.pendingTip1': '把本机 WorkBuddy（腾讯 CodeBuddy）的会话导入 DSH，成为可继续对话的原生会话。',
      'settings.pendingTip2': '勾选要导入的内容，重复导入会自动跳过。',
      'settings.importedTip1': '已经在 DSH 里的会话。',
      'settings.importedTip2': '勾选可以把 DSH 这边新产生的对话回写进 WorkBuddy 原会话；接管过来的还可以还原回去。',
      'settings.recycleTip1': '从待导入里划掉的会话。',
      'settings.recycleTip2': '恢复后回到待导入列表；WorkBuddy 里的轨迹文件从头到尾没有被改动过。',
      'settings.plan': '导入方式：{mode}｜工具调用：{tools}',
      'settings.planTools.keep': '保留',
      'settings.planTools.text': '转为纯文本',
      'settings.planTools.drop': '丢弃',
      'settings.root': 'WorkBuddy 目录：{root}',
      'settings.filter': '筛选（标题 / 目录 / id）',
      'settings.selectAll': '全选',
      'settings.refresh': '刷新列表',
      'settings.count': '共 {n} 个会话',
      'settings.pagePosition': '第 {page}/{pages} 页',
      'settings.pagerPrev': '上一页',
      'settings.pagerNext': '下一页',
      'settings.pageSize': '每页',
      'settings.import': '导入所选（{n}）',
      'settings.importing': '正在导入…',
      'settings.loading': '正在读取 WorkBuddy 会话…',
      'settings.empty': '没有发现可导入的 WorkBuddy 会话。',
      'settings.emptyImported': '还没有导入过的会话。',
      'settings.emptyRecycle': '回收站是空的。',
      'settings.filterEmpty': '没有符合条件的会话。',
      'batch.selected': '已选 {n} 条',
      'settings.badgeDone': '已导入',
      'settings.badgeUngrouped': '未分组',
      'settings.badgeAdopted': '已接管',
      'settings.colTitle': '会话',
      'settings.options': '导入选项',
      'settings.noTools': '丢弃工具调用',
      'settings.noToolsTip1': '只保留对话文本。',
      'settings.noToolsTip2': '适合只想看聊天内容的场景。',
      'settings.toolsAsText': '工具调用转纯文本',
      'settings.toolsAsTextTip1': '工具调用以文本形式保留在轨迹里。',
      'settings.toolsAsTextTip2': '不生成工具卡片。',
      'settings.retry': '重试',
      'settings.result': '完成：新导入 {imported}，已存在跳过 {existing}，空会话 {empty}，失败 {failed}',
      'settings.resultFailures': '部分失败：{failures}',
      'settings.importedOne': '已导入 {n} 个会话',
      'settings.sidebarHint': '会话已写入，侧边栏已刷新；如未出现请重启 DSH。',
      'settings.unknownError': '未知错误',

      // 归组：导入会按会话原本的工作目录挂进 DSH 的分组，分组名就是那个目录名。
      'settings.regroup': '归入分组（{n}）',
      'settings.regrouping': '正在归组…',
      'settings.regroupedOne': '已把 {n} 个会话归入原分组',
      'settings.regroupPartial': '已归入 {ok} 个，{fail} 个失败',
      'settings.regroupFailures': '归入分组失败：{failures}',

      // 软删除（本页自己的回收站）。
      'settings.deletePick': '删除所选（{n}）',
      'settings.deleting': '正在移入…',
      'settings.deletedPick': '已移入回收站 {n} 条',
      'settings.deletedPickPartial': '已移入回收站 {ok} 条，{fail} 条失败',
      'settings.deleteFailures': '移入回收站失败：{failures}',
      'settings.restorePick': '恢复所选（{n}）',
      'settings.restoring': '正在恢复…',
      'settings.restoredPick': '已恢复 {n} 条',
      'settings.restoredPickPartial': '已恢复 {ok} 条，{fail} 条失败',
      'settings.restoreFailures': '恢复失败：{failures}',

      // 列表里的分组小标题。没有目录的会话归到一个没有名字的组。
      'settings.groupUngrouped': '未分组',

      // 归属模式
      // The label carries the one fact that must not be missed — copy keeps the
      // original, adopt moves it over — and the rest waits behind the "?" on the
      // heading, showing the mode that is currently selected.
      'settings.mode': '归属方式',
      'settings.mode.copy': '拷贝（保留原会话）',
      'settings.mode.copyTip1': '只读 WorkBuddy 的会话，在 DSH 里写一份新的。',
      'settings.mode.copyTip2': '源文件一个字节都不动，两边从此分叉：WorkBuddy 那份停在导入那一刻。',
      'settings.mode.adopt': '接管（原会话搬过来）',
      'settings.mode.adoptTip1': '导入后把 WorkBuddy 的轨迹文件归档到 DSH，并在它的注册表里打上删除标记，DSH 成为唯一一份。',
      'settings.mode.adoptTip2': '可逆：归档文件保留着，随时可以还原。',
      'settings.mode.sync': '同步（两边都能接着看）',
      'settings.mode.syncTip1': '保留 WorkBuddy 原会话，DSH 里后续新产生的对话可以回写进去，两边内容保持一致。',
      'settings.mode.syncTip2': '回写是有损的：推理过程不回写，只回写正文与工具调用。',
      'settings.syncButton': '回写所选（{n}）',
      'settings.syncing': '正在回写…',
      'settings.syncedOne': '已回写 {n} 个会话，新增 {lines} 行',
      'settings.syncNone': '没有新增内容需要回写',
      'settings.syncFailures': '回写失败：{failures}',
      'settings.syncOnlyImported': '只能回写已经在 DSH 里的会话',
      'settings.restoreButton': '还原到 WorkBuddy',
      'settings.restoringOne': '正在还原…',
      'settings.restoredOne': '已还原 {n} 个会话到 WorkBuddy',
      'settings.restoreNone': '没有已接管的会话',
      'settings.restoreFailures': '还原失败：{failures}',
      'settings.adoptFailedHint': '会话已导入，但搬走源文件失败：{failures}',
      'settings.importRegroupFailed': '会话已导入，但没能归入它原来的分组：{failures}',
    }

    const en = {
      'settings.nav': 'WorkBuddy import',
      'settings.tabsLabel': 'Import page tabs',
      'settings.tabPending': 'Pending',
      'settings.tabImported': 'Imported',
      'settings.tabRecycle': 'Recycle bin',
      'settings.tabCount': '{n} entries',
      'settings.config': 'Settings',
      'settings.configTitle': 'Import settings',
      'settings.configAbout': 'Every change here applies immediately — just close this when you are done.',
      'settings.close': 'Close',
      'settings.tip': 'Explanation',
      'settings.pendingTip1': 'Import local WorkBuddy (Tencent CodeBuddy) conversations into DSH as native, resumable sessions.',
      'settings.pendingTip2': 'Tick what you want; re-importing skips automatically.',
      'settings.importedTip1': 'Conversations already in DSH.',
      'settings.importedTip2': 'Tick one to write later turns in DSH back to the WorkBuddy original; anything adopted can also be put back.',
      'settings.recycleTip1': 'Conversations you swept out of the pending list.',
      'settings.recycleTip2': 'Restoring puts them back there; the WorkBuddy transcript was never touched either way.',
      'settings.plan': 'Import as: {mode} · Tool calls: {tools}',
      'settings.planTools.keep': 'kept',
      'settings.planTools.text': 'as plain text',
      'settings.planTools.drop': 'dropped',
      'settings.root': 'WorkBuddy root: {root}',
      'settings.filter': 'Filter (title / folder / id)',
      'settings.selectAll': 'Select all',
      'settings.refresh': 'Refresh',
      'settings.count': '{n} conversation(s)',
      'settings.pagePosition': 'Page {page} of {pages}',
      'settings.pagerPrev': 'Previous',
      'settings.pagerNext': 'Next',
      'settings.pageSize': 'Per page',
      'settings.import': 'Import selected ({n})',
      'settings.importing': 'Importing…',
      'settings.loading': 'Reading WorkBuddy conversations…',
      'settings.empty': 'No importable WorkBuddy conversations found.',
      'settings.emptyImported': 'Nothing has been imported yet.',
      'settings.emptyRecycle': 'The recycle bin is empty.',
      'settings.filterEmpty': 'Nothing matches the filter.',
      'batch.selected': '{n} selected',
      'settings.badgeDone': 'Imported',
      'settings.badgeUngrouped': 'Ungrouped',
      'settings.badgeAdopted': 'Adopted',
      'settings.colTitle': 'Conversation',
      'settings.options': 'Import options',
      'settings.noTools': 'Drop tool calls',
      'settings.noToolsTip1': 'Keep dialogue text only.',
      'settings.noToolsTip2': 'For when you just want the chat content.',
      'settings.toolsAsText': 'Tool calls as plain text',
      'settings.toolsAsTextTip1': 'Tool calls stay in the transcript as text.',
      'settings.toolsAsTextTip2': 'No tool cards are generated.',
      'settings.retry': 'Retry',
      'settings.result': 'Done: {imported} imported, {existing} already present, {empty} empty, {failed} failed',
      'settings.resultFailures': 'Some failed: {failures}',
      'settings.importedOne': 'Imported {n} conversation(s)',
      'settings.sidebarHint': 'Sessions written and the sidebar refreshed; restart DSH if they do not show up.',
      'settings.unknownError': 'unknown error',

      'settings.regroup': 'Group them ({n})',
      'settings.regrouping': 'Grouping…',
      'settings.regroupedOne': 'Grouped {n} conversation(s) into their original group',
      'settings.regroupPartial': 'Grouped {ok}, {fail} failed',
      'settings.regroupFailures': 'Could not group: {failures}',

      'settings.deletePick': 'Delete selected ({n})',
      'settings.deleting': 'Moving…',
      'settings.deletedPick': 'Moved {n} to the recycle bin',
      'settings.deletedPickPartial': 'Moved {ok} to the recycle bin, {fail} failed',
      'settings.deleteFailures': 'Could not move to the recycle bin: {failures}',
      'settings.restorePick': 'Restore selected ({n})',
      'settings.restoring': 'Restoring…',
      'settings.restoredPick': 'Restored {n} entry(ies)',
      'settings.restoredPickPartial': 'Restored {ok}, {fail} failed',
      'settings.restoreFailures': 'Restore failed: {failures}',

      'settings.groupUngrouped': 'Ungrouped',

      'settings.mode': 'Ownership',
      'settings.mode.copy': 'Copy (keep the original)',
      'settings.mode.copyTip1': 'Reads the WorkBuddy conversation and writes a new one in DSH.',
      'settings.mode.copyTip2': 'The source file is untouched, and the two histories diverge from this moment on.',
      'settings.mode.adopt': 'Adopt (move it over)',
      'settings.mode.adoptTip1': 'After importing, the WorkBuddy transcript is archived into DSH and marked deleted in its registry, so DSH holds the only copy.',
      'settings.mode.adoptTip2': 'Reversible: the archived file is kept and can be put back.',
      'settings.mode.sync': 'Sync (keep both readable)',
      'settings.mode.syncTip1': 'Keeps the WorkBuddy original, and later turns made in DSH can be written back to it so both sides stay in step.',
      'settings.mode.syncTip2': 'Writing back is lossy: reasoning is dropped, only message text and tool calls come across.',
      'settings.syncButton': 'Sync back ({n})',
      'settings.syncing': 'Syncing…',
      'settings.syncedOne': 'Synced {n} conversation(s), {lines} new line(s)',
      'settings.syncNone': 'Nothing new to sync back',
      'settings.syncFailures': 'Sync failed: {failures}',
      'settings.syncOnlyImported': 'Only conversations already in DSH can be synced back',
      'settings.restoreButton': 'Put back in WorkBuddy',
      'settings.restoringOne': 'Restoring…',
      'settings.restoredOne': 'Restored {n} conversation(s) to WorkBuddy',
      'settings.restoreNone': 'Nothing has been adopted',
      'settings.restoreFailures': 'Restore failed: {failures}',
      'settings.adoptFailedHint': 'Imported, but moving the source file failed: {failures}',
      'settings.importRegroupFailed': 'Imported, but could not be put back in its original group: {failures}',
    }

    // --- locale service bridge ----------------------------------------------------
    //
    // Mirrors dsh-session-recycle: the host locale service is the authority
    // when present, the bundled tables are the fallback, and `{name}`
    // placeholders are interpolated either way (dropping the params leaves raw
    // braces on screen, which is exactly the bug that pattern fixes).

    let localeSvc

    function fallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function t(key, params) {
      if (localeSvc && typeof localeSvc.translate === 'function') {
        const text = localeSvc.translate(NS, key, params)
        if (typeof text === 'string' && text !== key) return text
      }
      const template = (fallbackLang() === 'en' ? en : zh)[key] || key
      if (params === undefined || typeof template !== 'string') return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function useLocaleRevision() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        if (!localeSvc || typeof localeSvc.subscribe !== 'function') return undefined
        return localeSvc.subscribe(() => setRevision(v => v + 1))
      }, [])
      return undefined
    }

    // --- host bridge ---------------------------------------------------------------

    /** One JSON round-trip against this plugin's host routes. */
    async function api(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      let payload = {}
      try { payload = await response.json() } catch { /* keep {} */ }
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || `${path} failed (HTTP ${response.status})`)
      }
      return payload
    }

    /**
     * Candidate list plus the two roots the page shows.
     *
     * Normalized here rather than at the call site: the shape is what the
     * render depends on, and `payload.sessions` read off the *array* this
     * returns is `undefined` — which silently renders an empty page.
     */
    async function fetchSessions() {
      const payload = await api(`${PREFIX}/sessions`)
      return {
        sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        workbuddyRoot: typeof payload.workbuddyRoot === 'string' ? payload.workbuddyRoot : '',
        sessionsRoot: typeof payload.sessionsRoot === 'string' ? payload.sessionsRoot : '',
      }
    }

    async function postImport(ids, options) {
      return api(`${PREFIX}/import`, { method: 'POST', body: { ids, options } })
    }

    /**
     * Sync mode's other half: push turns made in DSH back into the WorkBuddy
     * transcript. The host refuses without a watermark, so this cannot
     * duplicate history even if the user keeps pressing the button.
     */
    async function postSync(ids) {
      return api(`${PREFIX}/sync`, { method: 'POST', body: { ids } })
    }

    /** Undo for adopt mode: archived files go home, deletion marks are cleared. */
    async function postRestore(ids) {
      return api(`${PREFIX}/restore`, { method: 'POST', body: { ids } })
    }

    /** Soft delete: the row moves to this page's own bin, nothing on disk moves. */
    async function postHide(ids) {
      return api(`${PREFIX}/hide`, { method: 'POST', body: { ids } })
    }

    /** Take rows back out of the bin, so they show up in the pending list again. */
    async function postUnhide(ids) {
      return api(`${PREFIX}/unhide`, { method: 'POST', body: { ids } })
    }

    /**
     * Attach already-imported sessions to the group their cwd names.
     *
     * The repair for everything imported before the import route learned to do
     * this itself, and for the ones the workspace registry refused at the time.
     */
    async function postRegroup(ids) {
      return api(`${PREFIX}/regroup`, { method: 'POST', body: { ids } })
    }

    // --- sidebar resync ------------------------------------------------------------
    //
    // Importing writes the log on disk; the sidebar renders from the client's
    // list, which has to be re-read before the rows exist. The service method
    // is `refresh()` on the `sessions` controller (NOT `refreshList()` on the
    // store — that is undefined and silently does nothing, which is why
    // imported sessions used to only ever appear after a restart).

    let sessionsSvc

    function pullSessionList() {
      try {
        const refresh = sessionsSvc?.refresh
        if (typeof refresh === 'function') return refresh.call(sessionsSvc)
      } catch { /* fall through to the list-store probe */ }
      try {
        const store = sessionsSvc?.list
        if (store && typeof store.refresh === 'function') return store.refresh()
      } catch { /* nothing else to try */ }
      return undefined
    }

    /**
     * Re-read the session list until every imported id is visible.
     *
     * The host has to discover the freshly written directories with its own
     * scan before any refresh can report them, and that is not instantaneous,
     * so the window is generous; the loop stops the moment the last id shows.
     *
     * @param {string[]} ids imported session ids
     * @returns how many of them became visible
     */
    async function resyncSessionList(ids) {
      const wanted = ids.map(String)
      if (wanted.length === 0) return 0
      const visibleCount = () => {
        try {
          const snapshot = sessionsSvc?.list?.getSnapshot?.()
          const byId = snapshot?.byId || {}
          return wanted.filter(id => byId[id] !== undefined).length
        } catch { return 0 }
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const pulled = pullSessionList()
        if (pulled && typeof pulled.then === 'function') await pulled
        if (visibleCount() === wanted.length) return wanted.length
        await new Promise(resolve => setTimeout(resolve, attempt < 10 ? 50 : 150))
      }
      return visibleCount()
    }

    // --- transient banner -----------------------------------------------------------
    //
    // Import feedback is a top-center banner rather than inline text: the
    // settings panel may be scrolled away, and a message the user has to hunt
    // for is not feedback.

    const toastState = { seq: 0, text: '', tone: undefined, listeners: new Set() }

    function toastSubscribe(listener) {
      toastState.listeners.add(listener)
      return () => toastState.listeners.delete(listener)
    }

    function showToast(text, tone) {
      if (typeof text !== 'string' || text.length === 0) return
      toastState.seq += 1
      toastState.text = text
      toastState.tone = tone
      for (const listener of [...toastState.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    function ToastHost() {
      const [, forceRender] = useState(0)
      const [shown, setShown] = useState(0)
      useEffect(() => toastSubscribe(() => forceRender(n => n + 1)), [])
      const seq = toastState.seq
      if (seq === 0 || seq === shown) return null
      return React.createElement(Toast, {
        key: seq,
        text: toastState.text,
        tone: toastState.tone,
        holdMs: 3200,
        onDone: () => setShown(seq),
      })
    }

    // --- module-level state ----------------------------------------------------------
    //
    // Both cells live here rather than in the page for the same reason: the
    // settings dialog and the toast are *overlay* entries, so the page cannot
    // hand them props. In the session-recycle plugin the equivalent cell holds
    // the dialog's open flag only, because its prefs live on the host; here the
    // import policy is client-side (it is sent per request), so it lives here
    // too — and the page that reads it re-renders off the same subscription.

    const configState = { open: false, listeners: new Set() }

    /**
     * Subscribe to anything either cell changes.
     *
     * One listener set for both: the page cares about either change the same way
     * (re-render), and the dialog is the only thing that writes them, so keeping
     * two ledgers would just be two ways to forget one of them.
     */
    function configSubscribe(listener) {
      configState.listeners.add(listener)
      return () => { configState.listeners.delete(listener) }
    }

    function notifyConfig() {
      for (const listener of [...configState.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    function setConfigOpen(open) {
      if (configState.open === open) return
      configState.open = open
      notifyConfig()
    }

    /**
     * How a session comes across, and what happens to its tool calls.
     *
     * Defaults are the plugin's long-standing behaviour: copy (the source file
     * is never touched) and keep tool calls as cards.
     */
    const importOptions = { mode: 'copy', noTools: false, toolsAsText: false }

    function setOption(key, value) {
      if (importOptions[key] === value) return
      importOptions[key] = value
      notifyConfig()
    }

    /**
     * Where the page is reading from, for the dialog to quote.
     *
     * The page writes it on every read and the dialog reads it when it renders:
     * no subscription, because the write always lands before the dialog can be
     * opened, and a dialog left open across a re-read is showing a path that
     * does not change.
     */
    const sourceInfo = { root: '' }

    // --- styles ---------------------------------------------------------------------
    //
    // Theme tokens only, with the same fallbacks the host's own panels use, so
    // the page follows light/dark without knowing which is active.

    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 12,
      lineHeight: '18px',
    }
    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12,
      lineHeight: '18px', marginTop: 8, whiteSpace: 'pre-wrap',
    }
    const okStyle = {
      color: 'var(--dsw-alias-state-success-primary, #30a46c)', fontSize: 12,
      lineHeight: '18px', marginTop: 8,
    }
    const primaryBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      background: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: '#fff', fontSize: 13, cursor: 'pointer', flex: 'none',
    }
    const ghostBtnStyle = {
      padding: '6px 12px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 12, cursor: 'pointer', flex: 'none',
    }
    const disabledBtnStyle = { ...primaryBtnStyle, opacity: 0.5, cursor: 'default' }
    /** 划进回收站是唯一一个「让东西消失」的动作，所以只有它用红色描边。 */
    const dangerOutlineBtnStyle = {
      padding: '6px 12px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontSize: 12, cursor: 'pointer', flex: 'none',
    }
    const dangerOutlineBtnOffStyle = { ...dangerOutlineBtnStyle, opacity: 0.5, cursor: 'default' }
    const badgeStyle = {
      flex: 'none', fontSize: 11, lineHeight: '16px', padding: '0 8px',
      borderRadius: 8, whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
    }
    // 未归组用警示色：它在说「这一行现在不在任何分组里」，而不是装饰。
    const warnBadgeStyle = {
      ...badgeStyle,
      color: 'var(--dsw-alias-state-warning-primary, #f5a524)',
      border: '1px solid var(--dsw-alias-state-warning-primary, #f5a524)',
    }
    // 已接管用强调色：源文件已经不在 WorkBuddy 了，这一行的状态跟别人不一样。
    const adoptedBadgeStyle = {
      ...badgeStyle,
      color: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      border: '1px solid var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    const selectStyle = {
      padding: '5px 8px', fontSize: 12, borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      maxWidth: '100%',
    }
    const listBoxStyle = {
      marginTop: 8, maxHeight: 340, overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      borderRadius: 8,
    }
    const rowStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px',
    }
    const rowBorderStyle = {
      ...rowStyle,
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    const ghostBtnOffStyle = { ...ghostBtnStyle, opacity: 0.5, cursor: 'default' }
    /**
     * The toolbar, in two rows.
     *
     * The filter is a box the user types into; the buttons are things they
     * press. On one wrapped row the filter shared its line with five buttons and
     * ended up a 140px slot in the middle of them. It gets its own row now, and
     * the row under it holds the controls — which is also what lets the
     * select-all box sit flush left, exactly where each row's own box is.
     */
    const filterRowStyle = { padding: '6px 0 0' }
    const actionRowStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '8px 0',
    }
    const filterInputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '5px 10px',
      fontSize: 12, borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }
    /** The select-all box: shaped like a list row's own, so the parallel reads. */
    const selectAllStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      flex: 'none', cursor: 'pointer', fontSize: 12, lineHeight: '18px',
    }
    /**
     * A group heading inside the pick-list.
     *
     * The list is one flat scroll box, so groups need something to be *seen* as
     * groups: rows are sorted by group and each run is opened by this bar. It is
     * repeated at the top of every page on purpose — a page that starts in the
     * middle of a group still has to say which group that is.
     */
    const groupHeadingStyle = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px',
      fontSize: 12, lineHeight: '18px', fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.12))',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    /** The first heading has the box's own top edge; a line there would double it. */
    const groupHeadingFirstStyle = { ...groupHeadingStyle, borderTop: 'none' }

    // --- tab strip --------------------------------------------------------------
    //
    // Same shape as the session-recycle page's strip: the open tab is marked
    // with a rule on the shared baseline rather than a filled pill, because a
    // second filled surface would compete with the list right below it.

    const tabStripStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      paddingBottom: 0,
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    const tabListStyle = {
      display: 'flex', alignItems: 'center', gap: 2,
      flex: '1 1 auto', minWidth: 0,
    }
    const tabBaseStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 10px', borderRadius: '6px 6px 0 0',
      border: 'none', borderBottom: '2px solid transparent',
      background: 'transparent', cursor: 'pointer',
      fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }
    // A tab and its "?" on one line. The negative bottom margin moved here from
    // the tab itself: the tab's underline has to sit 1px into the strip's own
    // border, and the wrapper is now what the flex line measures.
    // `position: relative` is what the tab's "?" hangs its bubble off. Without
    // it the bubble is placed against the nearest positioned ancestor further
    // up — measured in the real layout, that put it 116px below the viewport
    // rather than under the tab it describes.
    const tabItemStyle = {
      position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4,
      marginBottom: -1,
    }
    /** The open tab: same shape as the idle one, marked rather than disabled. */
    const tabOnStyle = {
      ...tabBaseStyle, fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, inherit)',
      borderBottomColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    /** How much a list is holding — quiet, so it does not outrank the label. */
    const tabBadgeStyle = {
      display: 'inline-block', padding: '0 6px', borderRadius: 8,
      fontSize: 11, lineHeight: '16px',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }

    // --- dialog rows ---------------------------------------------------------------

    const settingLabelStyle = { display: 'block', fontSize: 13, lineHeight: '20px' }
    // A title and its "?" on one line. It is also the bubble's positioning
    // context, and that is deliberate: the settings dialog is 380px wide with
    // `overflow: hidden`, so a bubble hung off the right of a long title would
    // be clipped. Anchored to the line instead, the bubble starts at the
    // column's left edge and its fixed width keeps it inside by construction.
    const settingLabelRowStyle = {
      position: 'relative',
      display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
    }
    const settingRowStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0',
    }

    // --- the "?" tip -------------------------------------------------------------
    //
    // Explanations used to sit under their title as a paragraph — on the settings
    // rows, on the tabs, and in the dialogs' description. In a 380px dialog they
    // made every row three lines tall; on a page they put a wall of prose between
    // the user and the first row. They hang off a "?" now, and the user asks.
    //
    // The bubble is the platform's own tooltip surface (`--dsw-alias-tooltip-bg`
    // is a dark chip in both themes, which is why the text is the platform's
    // white), lifted off the page with a border and a shadow.
    const tipAnchorStyle = { display: 'inline-flex', flex: 'none' }
    const tipChipStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 14, height: 14, borderRadius: '50%', flex: 'none',
      fontSize: 10, lineHeight: '14px', fontWeight: 600,
      border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.5))',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'help', userSelect: 'none',
    }
    const tipChipOnStyle = {
      ...tipChipStyle,
      borderColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    // The bubble opens *upward* by default: inside the 380px settings card the
    // only thing that matters is clearing the card's top edge, and measured in
    // that card's own layout every row bubble does. Below the last row there is
    // far less room, so a bubble opening downward would be cut.
    //
    // Two anchors sit the other way round — the dialog's own caption, and a tab
    // strip at the top of a page — where opening up would run into the card's
    // header instead. Those pass `placement: 'down'`.
    const tipBoxStyle = {
      position: 'absolute', left: 0, bottom: '100%', zIndex: 30,
      // A fixed 260px, not a percentage: a percentage resolves against the title
      // line, so a long title squeezes the bubble into a narrow column and the
      // text grows tall enough to run past the card's top edge.
      width: 260, maxWidth: 'calc(100vw - 140px)',
      padding: '8px 10px', borderRadius: 8,
      background: 'var(--dsw-alias-tooltip-bg, #2c2c2e)',
      color: 'var(--dsw-static-neutral-bluish-00, #fff)',
      border: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.18))',
      boxShadow: '0 8px 24px rgba(0,0,0,.28), 0 2px 6px rgba(0,0,0,.18)',
      fontSize: 12, lineHeight: '18px', fontWeight: 400,
      textAlign: 'left', whiteSpace: 'normal',
      cursor: 'default',
    }
    const tipBoxDownStyle = { ...tipBoxStyle, top: '100%', bottom: 'auto' }
    const tipListStyle = {
      margin: 0, padding: '0 0 0 16px', listStyle: 'disc',
    }
    const tipItemStyle = { margin: '2px 0' }
    // The settings dialog's own explanation: a caption-shaped line holding only
    // a "?" — the sentence that used to be the description paragraph sits in it.
    const aboutRowStyle = {
      position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }
    const separatorStyle = {
      height: 1, margin: '12px 0 4px',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }

    // --- pager -------------------------------------------------------------------
    //
    // The candidate list grows with the WorkBuddy store, so it is paged rather
    // than left to run off the bottom of the modal. Paging also gives "select
    // all" a meaning the user can see: the rows in front of them.
    //
    // The page size is a local preference (localStorage), not host state: how
    // many rows fit on a screen is a property of the screen.

    const PAGE_SIZE_KEY = 'import-workbuddy:pageSize'
    const PAGE_SIZES = [20, 50, 100, 200]
    const DEFAULT_PAGE_SIZE = 50

    function readPageSize() {
      try {
        const value = Number(window.localStorage?.getItem(PAGE_SIZE_KEY))
        if (PAGE_SIZES.includes(value)) return value
      } catch { /* no storage (private mode) — the default stands */ }
      return DEFAULT_PAGE_SIZE
    }

    function writePageSize(value) {
      try { window.localStorage?.setItem(PAGE_SIZE_KEY, String(value)) } catch { /* preference only */ }
    }

    const pagerStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      marginTop: 8, paddingTop: 8,
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    /** The current page's button: same shape, marked rather than disabled. */
    const pagerPageOnStyle = {
      ...ghostBtnStyle, fontWeight: 600,
      borderColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    const pageSizeSelectStyle = {
      padding: '3px 6px', fontSize: 12, borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      try {
        return new Date(value).toLocaleString()
      } catch { return '' }
    }

    /**
     * The "?" that sits next to a setting's title, holding its explanation.
     *
     * Hover, not click: reading a row's reasoning is a glance, not a task. The
     * chip lives inside a `<label>`, where a click is forwarded to the checkbox,
     * so it stops the event rather than letting a look at the text flip a switch.
     * Focus does the same as a hover, for the keyboard.
     *
     * `placement` chooses which way the bubble opens — `up` for a settings row,
     * `down` for an anchor with nothing above it (see `tipBoxStyle`). `label`
     * only widens the accessible name, so three chips on one tab strip do not
     * all announce themselves as "说明".
     */
    function InfoTip(props) {
      const __ = props.t || t
      const [open, setOpen] = useState(false)
      const points = Array.isArray(props.items)
        ? props.items.filter((item) => typeof item === 'string' && item.length > 0)
        : []
      if (points.length === 0) return null
      const down = props.placement === 'down'
      const described = props.label ? `${__('settings.tip')}：${props.label}` : __('settings.tip')
      return React.createElement('span', {
        style: tipAnchorStyle,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      }, [
        React.createElement('span', {
          key: 'chip',
          tabIndex: 0,
          role: 'button',
          style: open ? tipChipOnStyle : tipChipStyle,
          'aria-label': described,
          'aria-expanded': open,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen((value) => !value)
          },
          onMouseDown: (event) => event.preventDefault(),
        }, '?'),
        open
          ? React.createElement('span', {
              key: 'tip',
              role: 'tooltip',
              style: down ? tipBoxDownStyle : tipBoxStyle,
              // Selecting text in the bubble must not reach the <label> around
              // the row, or a copy would flip the switch it explains.
              onClick: (event) => { event.preventDefault(); event.stopPropagation() },
            }, React.createElement('ul', { key: 'points', style: tipListStyle },
              points.map((point, index) => React.createElement('li', {
                key: `point:${index}`, style: tipItemStyle,
              }, point))))
          : null,
      ])
    }

    /**
     * One option row: a title with its "?" on the same line, and a checkbox.
     *
     * `tip` carries the explanation; nothing sits under the title any more, so
     * the two options read as two lines rather than a paragraph each.
     */
    function OptionRow(props) {
      const __ = props.t || t
      const { label, tip, checked, disabled, onChange } = props
      return React.createElement('label', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '8px 0', cursor: disabled ? 'default' : 'pointer',
        },
      }, [
        React.createElement('input', {
          key: 'box', type: 'checkbox', checked: checked === true, disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
          style: { marginTop: 2, flex: 'none' },
        }),
        React.createElement('span', { key: 'text', style: { display: 'block', minWidth: 0 } }, [
          React.createElement('span', { key: 'title', style: settingLabelRowStyle }, [
            React.createElement('span', { key: 'label', style: settingLabelStyle }, label),
            // The option's own title goes into the chip's label: the dialog's
            // about row has a "?" with no title of its own, and two chips both
            // announced as just "说明" cannot be told apart — by a screen
            // reader, or by a test trying to hover one of them.
            React.createElement(InfoTip, { key: 'tip', t: __, label, items: tip }),
          ]),
        ]),
      ])
    }

    // --- the page --------------------------------------------------------------------

    /**
     * The page numbers to render, with '…' where the run is broken.
     *
     * The first and last pages and the current one (plus its neighbours) are
     * always reachable: a pager that only ever shows 1 2 3 cannot tell you that
     * you are on page 40 of 60.
     *
     * @param page - zero-based current page.
     * @param pageCount - total pages, at least 1.
     * @returns 1-based page numbers with the string '…' between runs.
     */
    function pageWindow(page, pageCount) {
      const last = pageCount - 1
      const wanted = new Set([0, 1, last - 1, last, page - 1, page, page + 1])
      const indexes = [...wanted]
        .filter(index => index >= 0 && index <= last)
        .sort((a, b) => a - b)
      const out = []
      let previous = -1
      for (const index of indexes) {
        if (previous >= 0 && index - previous > 1) out.push('…')
        out.push(index + 1)
        previous = index
      }
      return out
    }

    /** The list footer: how many rows, which page, and how many per page. */
    function Pager(props) {
      const __ = props.__ || t
      const { page, pageCount, total, pageSize, onPage, onPageSize } = props
      const children = [
        React.createElement('span', {
          key: 'count', style: { ...metaStyle, margin: 0 },
        }, __('settings.count', { n: total })),
      ]
      // With one page there is nothing to navigate; the count and the size
      // selector still belong to the footer, so only the buttons drop out.
      if (pageCount > 1) {
        children.push(React.createElement('span', {
          key: 'pos', style: { ...metaStyle, margin: 0 },
        }, __('settings.pagePosition', { page: page + 1, pages: pageCount })))
        children.push(React.createElement('button', {
          key: 'prev', type: 'button',
          style: page <= 0 ? ghostBtnOffStyle : ghostBtnStyle,
          disabled: page <= 0,
          onClick: () => onPage(page - 1),
        }, __('settings.pagerPrev')))
        pageWindow(page, pageCount).forEach((token, index) => {
          if (token === '…') {
            children.push(React.createElement('span', {
              key: `gap${index}`, style: { ...metaStyle, margin: 0, padding: '0 2px' },
            }, '…'))
            return
          }
          const target = token - 1
          children.push(React.createElement('button', {
            key: `p${token}`, type: 'button',
            'aria-current': target === page ? 'page' : undefined,
            style: target === page ? pagerPageOnStyle : ghostBtnStyle,
            onClick: () => onPage(target),
          }, String(token)))
        })
        children.push(React.createElement('button', {
          key: 'next', type: 'button',
          style: page >= pageCount - 1 ? ghostBtnOffStyle : ghostBtnStyle,
          disabled: page >= pageCount - 1,
          onClick: () => onPage(page + 1),
        }, __('settings.pagerNext')))
      }
      if (total > 0) {
        children.push(React.createElement('span', {
          key: 'sizeLabel', style: { ...metaStyle, margin: 0, marginLeft: 'auto' },
        }, __('settings.pageSize')))
        children.push(React.createElement('select', {
          key: 'size',
          value: String(pageSize),
          style: pageSizeSelectStyle,
          'aria-label': __('settings.pageSize'),
          onChange: (event) => onPageSize(Number(event.target.value)),
        }, PAGE_SIZES.map(size => React.createElement('option', {
          key: size, value: String(size),
        }, String(size)))))
      }
      return React.createElement('div', { style: pagerStyle }, children)
    }

    /**
     * The slice of `rows` the current page shows, clamping a page that the
     * current filter or an import has left past the end.
     *
     * @returns { rows, page, pageCount } — `page` is zero-based and always in
     *   range, so callers can feed it straight back to the pager.
     */
    function paginate(rows, page, pageSize) {
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
      const safe = Math.min(Math.max(page, 0), pageCount - 1)
      const start = safe * pageSize
      return { rows: rows.slice(start, start + pageSize), page: safe, pageCount }
    }

    // --- grouping ------------------------------------------------------------------
    //
    // Every candidate belongs to a project, and that is the axis the user thinks
    // in: "the sessions from that repo". The list was flat, so a project's
    // conversations were scattered through it by import time and finding one
    // meant reading every row.
    //
    // The group is read off the working directory, not off `projectDir`: the
    // latter is WorkBuddy's own flattened folder name (`d-Users-me-proj`), which
    // is not what the directory is called. The last path segment is the project
    // name — and that is, deliberately, the same string DSH titles the workspace
    // group with once the session is imported, so the two lines of the page agree.

    /** The group a candidate belongs to: its working directory, else the store folder. */
    function groupKeyOf(row) {
      const cwd = typeof row?.cwd === 'string' ? row.cwd.trim() : ''
      if (cwd.length > 0) return cwd
      const projectDir = typeof row?.projectDir === 'string' ? row.projectDir.trim() : ''
      return projectDir
    }

    /** What to print for a group: the project folder name, or '' for none. */
    function groupLabelOf(key) {
      if (key.length === 0) return ''
      const parts = key.split(/[\\/]+/).filter(part => part.length > 0)
      return parts.length > 0 ? parts[parts.length - 1] : key
    }

    /**
     * Rows in group order: same group adjacent, groups by name, no-group last.
     *
     * Sorting is what makes the headings meaningful — a heading over an
     * unsorted run would just be a label that happens to be true once. Order
     * inside a group is left as the host sent it (newest first).
     *
     * @returns {{ row, key, label }[]}
     */
    function groupRows(rows) {
      return rows
        .map(row => ({ row, key: groupKeyOf(row) }))
        .sort((a, b) => {
          if (a.key === b.key) return 0
          // Sessions with no directory cannot be placed; they go last rather
          // than first, so the named groups stay at the top where they are read.
          if (a.key.length === 0) return 1
          if (b.key.length === 0) return -1
          return a.key.localeCompare(b.key)
        })
        .map(entry => ({ ...entry, label: groupLabelOf(entry.key) }))
    }

    /**
     * How many rows each group holds, over the rows currently visible.
     *
     * Counted over the filtered list, not the page: the heading is a statement
     * about the group, and "3" that means "3 on this page" would be a different
     * statement that changes as you page.
     */
    function groupCounts(entries) {
      const counts = new Map()
      for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
      return counts
    }

    /**
     * One group's heading inside the pick-list.
     *
     * `title` carries the full directory so the shortening never hides the only
     * thing that distinguishes two projects with the same folder name.
     */
    function GroupHeading(props) {
      const { label, groupKey, count, first, __ } = props
      return React.createElement('div', {
        style: first ? groupHeadingFirstStyle : groupHeadingStyle,
        'data-group': groupKey,
      }, [
        React.createElement('span', {
          key: 'name',
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: groupKey,
        }, label.length > 0 ? label : __('settings.groupUngrouped')),
        React.createElement('span', { key: 'n', style: tabBadgeStyle }, String(count)),
      ])
    }

    /**
     * The select-all box, at the head of the toolbar's second row.
     *
     * A checkbox rather than a button, because it is the same gesture as ticking
     * a row — and it selects the whole filtered list, not the page: the button
     * it replaces said "this page", which meant a select-all that silently
     * stopped at row 50. The filter is what narrows a selection now, and the
     * count next to it is always the honest number.
     */
    function SelectAllBox(props) {
      const { label, checked, disabled, onToggle } = props
      return React.createElement('label', {
        style: {
          ...selectAllStyle,
          ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}),
        },
      }, [
        React.createElement('input', {
          key: 'box',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: () => onToggle(),
          style: { flex: 'none' },
        }),
        React.createElement('span', { key: 'l' }, label),
      ])
    }

    /**
     * The page's tab strip: the candidate list in its three states, plus the
     * Configure button.
     *
     * The badge says how many rows each side is holding — the one number that
     * decides whether crossing over is worth a click. Both are known as soon as
     * the first read lands, so unlike the session-recycle strip there is nothing
     * to fetch here; they are simply withheld while that read is in flight, so
     * the strip never claims a zero it is about to contradict.
     *
     * Each tab carries its own "?" on the label's right. The explanation used to
     * be a paragraph under the strip, where it answered "which of the three am I
     * looking at" only *after* you had already crossed over; on the tab it
     * answers before, and the strip gets its line back.
     */
    function ImportTabs(props) {
      const __ = props.__ || t
      const tabs = [
        {
          id: TAB_PENDING,
          label: __('settings.tabPending'),
          count: props.pending,
          tip: [__('settings.pendingTip1'), __('settings.pendingTip2')],
        },
        {
          id: TAB_IMPORTED,
          label: __('settings.tabImported'),
          count: props.imported,
          tip: [__('settings.importedTip1'), __('settings.importedTip2')],
        },
        {
          id: TAB_RECYCLE,
          label: __('settings.tabRecycle'),
          count: props.recycled,
          tip: [__('settings.recycleTip1'), __('settings.recycleTip2')],
        },
      ]
      return React.createElement('div', { style: tabStripStyle }, [
        React.createElement('div', {
          key: 'list',
          role: 'tablist',
          'aria-label': __('settings.tabsLabel'),
          style: tabListStyle,
        }, tabs.map(tab => {
          const on = props.tab === tab.id
          // The "?" is a *sibling* of the tab button, not a child: a button may
          // not contain another button, and as a sibling a click on it cannot be
          // mistaken for a request to switch tabs.
          return React.createElement('span', { key: tab.id, style: tabItemStyle }, [
            React.createElement('button', {
              key: 'tab',
              type: 'button',
              role: 'tab',
              'data-tab': tab.id,
              'aria-selected': on,
              style: on ? tabOnStyle : tabBaseStyle,
              onClick: () => props.onTab?.(tab.id),
            }, [
              React.createElement('span', { key: 'l' }, tab.label),
              props.loading === true
                ? null
                : React.createElement('span', {
                    key: 'n', style: tabBadgeStyle, title: __('settings.tabCount', { n: tab.count }),
                  }, String(tab.count)),
            ]),
            React.createElement(InfoTip, {
              key: 'tip', t: __, placement: 'down', label: tab.label, items: tab.tip,
            }),
          ])
        })),
        React.createElement('button', {
          key: 'config',
          type: 'button',
          style: ghostBtnStyle,
          onClick: () => setConfigOpen(true),
        }, __('settings.config')),
      ])
    }

    /**
     * The import policy, behind the strip's Configure button.
     *
     * Everything that is a *policy* lives here and nothing that is a *row* does.
     * The ownership mode leads because it is the one that has to be read before
     * importing rather than after: adopt moves the source file out of WorkBuddy,
     * and that is not something to discover from a badge afterwards.
     *
     * It renders from the overlay slot, like the toast: the button that opens it
     * sits inside the settings modal, so this is the one place guaranteed to
     * paint above it.
     */
    function ConfigDialog(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [, forceRender] = useState(0)

      // The dialog renders from its own overlay entry, so it has no props to
      // follow: it watches the same cells every writer touches.
      useEffect(() => configSubscribe(() => forceRender(n => n + 1)), [])

      if (!configState.open) return null

      const mode = importOptions.mode
      const modeLabel = __('settings.mode')
      // The dialog's own explanation. It used to be the description paragraph —
      // prose in front of the first control; now it is a caption holding a "?",
      // like every row's own.
      //
      // It is not hung off the title itself: `Modal` copies `title` into the
      // dialog's `aria-label`, so a node there would announce the dialog as
      // "[object Object]" to a screen reader.
      const about = React.createElement('span', { key: 'about', style: aboutRowStyle }, [
        React.createElement('span', { key: 'l' }, __('settings.tip')),
        React.createElement(InfoTip, {
          key: 'tip', t: __, placement: 'down', items: [__('settings.configAbout')],
        }),
      ])

      return React.createElement(Modal, {
        open: true,
        onClose: () => setConfigOpen(false),
        title: __('settings.configTitle'),
        closeLabel: __('settings.close'),
        description: about,
        footer: [React.createElement('button', {
          key: 'close', type: 'button', style: primaryBtnStyle, onClick: () => setConfigOpen(false),
        }, __('settings.close'))],
      }, [
        // The heading carries the "?" for the mode that is selected right now,
        // so the detail follows the choice instead of sitting under the control
        // as a paragraph. What may not be missed is in the option labels
        // themselves — copy keeps the original, adopt moves it over.
        React.createElement('div', { key: 'mode-head', style: { ...settingLabelRowStyle, marginBottom: 2 } }, [
          React.createElement('span', {
            key: 'l', style: { ...settingLabelStyle, fontWeight: 600 },
          }, modeLabel),
          React.createElement(InfoTip, {
            key: 'tip',
            t: __,
            label: modeLabel,
            items: [`settings.mode.${mode}Tip1`, `settings.mode.${mode}Tip2`].map(key => __(key)),
          }),
        ]),
        React.createElement('select', {
          key: 'mode-select',
          value: mode,
          style: selectStyle,
          'aria-label': modeLabel,
          onChange: (event) => setOption('mode', event.target.value),
        }, [
          React.createElement('option', { key: 'copy', value: 'copy' }, __('settings.mode.copy')),
          React.createElement('option', { key: 'adopt', value: 'adopt' }, __('settings.mode.adopt')),
          React.createElement('option', { key: 'sync', value: 'sync' }, __('settings.mode.sync')),
        ]),

        React.createElement('div', { key: 'sep', style: separatorStyle }),
        React.createElement(OptionRow, {
          key: 'opt-notools',
          label: __('settings.noTools'),
          tip: [__('settings.noToolsTip1'), __('settings.noToolsTip2')],
          t: __,
          checked: importOptions.noTools,
          onChange: (value) => setOption('noTools', value),
        }),
        React.createElement(OptionRow, {
          key: 'opt-asttext',
          label: __('settings.toolsAsText'),
          tip: [__('settings.toolsAsTextTip1'), __('settings.toolsAsTextTip2')],
          t: __,
          checked: importOptions.toolsAsText,
          onChange: (value) => setOption('toolsAsText', value),
        }),

        // 读的是哪儿，属于「你在改什么」的一部分：源目录写错时，模式选得再对
        // 也没用。它随每次读取更新，在配置里报一次就够。
        sourceInfo.root.length === 0
          ? null
          : React.createElement('div', {
              key: 'root',
              style: { ...metaStyle, marginTop: 10, marginBottom: 0, wordBreak: 'break-all' },
            }, __('settings.root', { root: sourceInfo.root })),
      ])
    }

    /**
     * The import page, registered into `settings.section` so it appears with
     * the harness's own settings pages.
     *
     * One list in three tabs rather than one long page: the candidates split into
     * what still has to come across, what already has, and what the user swept
     * aside, because the verb differs (import vs sync back / put back vs restore)
     * and a toolbar with all of them makes "which button is mine" a question the
     * user has to answer first.
     *
     * The page is a list and nothing else. The import policy used to sit under
     * the list, which meant every visit ended in a form rather than at the rows;
     * it lives behind the strip's Configure button now (`ConfigDialog`), and the
     * one line that quotes it keeps the current choice visible while importing.
     *
     * Selection is a Set of candidate ids, shared across the tabs: a tick is a
     * statement about a row, not about the tab it was made in, and the action
     * buttons already sort the ticks by what the row *is* — import only takes
     * rows that are not in DSH yet, sync only takes rows that can be written
     * back, put-back only takes rows this plugin adopted, restore only takes
     * rows the bin is holding.
     */
    function ImportPanel() {
      const __ = t
      useLocaleRevision()
      const [sessions, setSessions] = useState([])
      const [picked, setPicked] = useState(() => new Set())
      const [filter, setFilter] = useState('')
      const [loading, setLoading] = useState(true)
      const [importing, setImporting] = useState(false)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      const [syncing, setSyncing] = useState(false)
      // 三个「目标态」的动作各有自己的忙碌位：它们的目标集合不同，一次只能有
      // 一个在跑，但哪个在跑决定了按钮上那句话该说什么。
      const [puttingBack, setPuttingBack] = useState(false)
      const [grouping, setGrouping] = useState(false)
      const [hiding, setHiding] = useState(false)
      const [unhiding, setUnhiding] = useState(false)
      // Paging. `page` is zero-based and the slice is derived (`paginate`), so a
      // filter or an import that shortens the list can never strand the page on
      // a slice it has no way back from.
      const [tab, setTab] = useState(TAB_PENDING)
      const [page, setPage] = useState(0)
      const [pageSize, setPageSize] = useState(() => readPageSize())
      const [, forceRender] = useState(0)

      // 六个动作都会改磁盘或 host 状态，所以一个忙碌位统一闸住全部控件：
      // 允许并发只会让两批目标在半路上互相看不见。
      const busy = importing || syncing || puttingBack || grouping || hiding || unhiding

      const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          const payload = await fetchSessions()
          setSessions(payload.sessions ?? [])
          sourceInfo.root = payload.workbuddyRoot ?? ''
          // A row that just got imported must lose its checkbox immediately.
          setPicked((prev) => {
            const done = new Set((payload.sessions ?? []).filter(s => s.alreadyImported).map(s => s.id))
            const next = new Set()
            for (const id of prev) if (!done.has(id)) next.add(id)
            return next
          })
          setError(null)
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        if (!quiet) setLoading(false)
      }, [])

      useEffect(() => { refresh() }, [refresh])

      // The plan line quotes the dialog's policy, so the page has to re-render
      // when the dialog changes it.
      useEffect(() => configSubscribe(() => forceRender(n => n + 1)), [])

      // 三栏的分界是「这件事现在处于哪一步」，而不是「能不能导入」：
      // hidden 的行虽然没进过 DSH，但它已经不在待办里了。
      const pending = sessions.filter(s => s.hidden !== true && s.alreadyImported !== true)
      const imported = sessions.filter(s => s.hidden !== true && s.alreadyImported === true)
      const recycled = sessions.filter(s => s.hidden === true)
      const byId = new Map(sessions.map(s => [s.id, s]))
      const inTab = tab === TAB_PENDING ? pending : tab === TAB_IMPORTED ? imported : recycled

      const needle = filter.trim().toLowerCase()
      const visible = needle.length === 0
        ? inTab
        : inTab.filter(s => (
          String(s.title || '').toLowerCase().includes(needle)
          || String(s.cwd || '').toLowerCase().includes(needle)
          || String(s.projectDir || '').toLowerCase().includes(needle)
          || String(s.id || '').toLowerCase().includes(needle)
        ))

      // 分组排序 + 分页。分页作用于「分组条目」而不是裸行，所以一页里不会是
      // 半个组拼半个组之外的第三种东西——切页只会在组与组之间切。
      const entries = groupRows(visible)
      const counts = groupCounts(entries)
      const { rows: pageEntries, page: safePage, pageCount } = paginate(entries, page, pageSize)

      // One tick set, five targets. Which rows a button acts on depends on what
      // the row *is*, so a single list serves every verb without competing
      // selections fighting over the same checkbox.
      const importIds = [...picked].filter((id) => {
        const row = byId.get(id)
        return row !== undefined && row.hidden !== true && row.alreadyImported !== true
      })
      const syncIds = [...picked].filter((id) => {
        const row = byId.get(id)
        return row?.hidden !== true && row?.alreadyImported === true && row.canSyncBack !== false
      })
      const putBackIds = [...picked].filter(id => byId.get(id)?.hidden !== true && byId.get(id)?.adopted === true)
      // 归组的候选：已经在 DSH 里、却不在任何分组里的。这个徽标与按钮共用一条
      // 判断，所以「为什么有按钮」和「哪一行需要它」永远是同一句话。
      const regroupIds = [...picked].filter((id) => {
        const row = byId.get(id)
        return row?.hidden !== true && row?.alreadyImported === true && row.grouped === false
      })
      const unhideIds = [...picked].filter(id => byId.get(id)?.hidden === true)

      // Select all reaches the whole filtered list, not the page. It used to
      // stop at the page on the grounds that selecting rows the user cannot see
      // is a trap — but the trap was the *silence*, and the fix for that is the
      // count beside it, which is always the honest number. The filter is the
      // tool for narrowing; the page size is how you read what you picked.
      const allVisiblePicked = visible.length > 0 && visible.every(s => picked.has(s.id))
      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (visible.every(s => next.has(s.id))) {
            for (const row of visible) next.delete(row.id)
          } else {
            for (const row of visible) next.add(row.id)
          }
          return next
        })
      }, [visible])

      const togglePick = useCallback((id) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const onTab = useCallback((id) => {
        setTab(id)
        // Row 51 of the other list is not row 51 of this one.
        setPage(0)
      }, [])

      const onPageSize = useCallback((size) => {
        setPageSize(size)
        writePageSize(size)
        setPage(0)
      }, [])

      const onImport = useCallback(async () => {
        const ids = importIds
        if (ids.length === 0) return
        setImporting(true)
        setError(null)
        setNote(null)
        try {
          const result = await postImport(ids, { ...importOptions })
          // Pull the sidebar in parallel with the panel re-read: the rows the
          // user is about to look for live in the sidebar, not here.
          const listed = resyncSessionList(result.imported.map(entry => entry.id))
          await refresh(true)
          await listed
          showToast(
            result.imported.length > 0
              ? __('settings.importedOne', { n: result.imported.length })
              : __('settings.result', {
                  imported: 0,
                  existing: result.existing.length,
                  empty: result.empty.length,
                  failed: result.failed.length,
                }),
            'success',
          )
          // 三种「事情没全成」各有各的说法，谁也不该盖掉谁：接管失败是「进来了
          // 但源文件没搬走」，逐条失败是「没进来」，归组失败是「进来了但没回到
          // 原来的分组」。合成一段列出，读的人不用去猜哪句是最后写的那句。
          const problems = []
          const adoptFailures = result.adoptFailed ?? []
          if (adoptFailures.length > 0) {
            problems.push(__('settings.adoptFailedHint', {
              failures: adoptFailures.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
          if (result.failed.length > 0) {
            problems.push(__('settings.resultFailures', {
              failures: result.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
          const regroupFailures = result.regroupFailed ?? []
          if (regroupFailures.length > 0) {
            problems.push(__('settings.importRegroupFailed', {
              failures: regroupFailures.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
          if (problems.length > 0) setNote(problems.join('\n\n'))
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setImporting(false)
      }, [importIds, refresh, __])

      /**
       * Sync mode's second half.
       *
       * Only already-imported rows qualify — there is nothing to write back
       * until DSH has a transcript of its own. The host refuses to append
       * without a watermark, so pressing this twice is harmless.
       */
      const onSync = useCallback(async () => {
        if (syncIds.length === 0) return
        setSyncing(true)
        setError(null)
        setNote(null)
        try {
          const result = await postSync(syncIds)
          const lines = (result.synced ?? []).reduce((sum, entry) => sum + (entry.appended ?? 0), 0)
          await refresh(true)
          showToast(
            lines > 0
              ? __('settings.syncedOne', { n: (result.synced ?? []).length, lines })
              : __('settings.syncNone'),
            lines > 0 ? 'success' : undefined,
          )
          if ((result.failed ?? []).length > 0) {
            setNote(__('settings.syncFailures', {
              failures: result.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setSyncing(false)
      }, [syncIds, refresh, __])

      /**
       * Undo for adopt mode: archived files go home, deletion marks clear.
       *
       * Distinct from the recycle tab's restore, which only edits this plugin's
       * own manifest — hence the separate flag and the separate wording.
       */
      const onPutBack = useCallback(async () => {
        if (putBackIds.length === 0) return
        setPuttingBack(true)
        setError(null)
        setNote(null)
        try {
          const result = await postRestore(putBackIds)
          await refresh(true)
          showToast(
            __('settings.restoredOne', { n: (result.restored ?? []).length }),
            'success',
          )
          if ((result.failed ?? []).length > 0) {
            setNote(__('settings.restoreFailures', {
              failures: result.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setPuttingBack(false)
      }, [putBackIds, refresh, __])

      /**
       * Attach already-imported sessions to the group their cwd names.
       *
       * Imports made before the import route learned to attach — or ones the
       * workspace registry refused at the time — sit under Ungrouped with no way
       * back. This is that way back: same host code path as the import, so a row
       * that still cannot be grouped reports why instead of silently staying put.
       */
      const onRegroup = useCallback(async () => {
        if (regroupIds.length === 0) return
        setGrouping(true)
        setError(null)
        setNote(null)
        try {
          const result = await postRegroup(regroupIds)
          await refresh(true)
          const ok = (result.grouped ?? []).length
          const failed = result.failed ?? []
          showToast(
            failed.length === 0
              ? __('settings.regroupedOne', { n: ok })
              : __('settings.regroupPartial', { ok, fail: failed.length }),
            ok > 0 ? 'success' : undefined,
          )
          if (failed.length > 0) {
            setNote(__('settings.regroupFailures', {
              failures: failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setGrouping(false)
      }, [regroupIds, refresh, __])

      /**
       * Sweep the ticked pending rows into this page's bin.
       *
       * Nothing on disk moves: hiding is a line in the plugin's own manifest, so
       * the row is back in the pending list the moment it is restored, and
       * WorkBuddy never hears about it.
       */
      const onHide = useCallback(async () => {
        const targets = importIds
        if (targets.length === 0) return
        setHiding(true)
        setError(null)
        setNote(null)
        try {
          const result = await postHide(targets)
          setPicked(new Set())
          await refresh(true)
          const failed = result.failed ?? []
          showToast(
            failed.length === 0
              ? __('settings.deletedPick', { n: targets.length })
              : __('settings.deletedPickPartial', { ok: targets.length - failed.length, fail: failed.length }),
            'success',
          )
          if (failed.length > 0) {
            setNote(__('settings.deleteFailures', {
              failures: failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setHiding(false)
      }, [picked, byId, refresh, __])

      /** Put the ticked bin entries back in the pending list. */
      const onUnhide = useCallback(async () => {
        if (unhideIds.length === 0) return
        setUnhiding(true)
        setError(null)
        setNote(null)
        try {
          const result = await postUnhide(unhideIds)
          setPicked(new Set())
          await refresh(true)
          const restored = result.restored ?? []
          const failed = result.failed ?? []
          showToast(
            failed.length === 0
              ? __('settings.restoredPick', { n: restored.length })
              : __('settings.restoredPickPartial', { ok: restored.length, fail: failed.length }),
            'success',
          )
          if (failed.length > 0) {
            setNote(__('settings.restoreFailures', {
              failures: failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setUnhiding(false)
      }, [unhideIds, refresh, __])

      const modeHint = __(`settings.mode.${importOptions.mode}`)
      const toolsHint = importOptions.noTools
        ? __('settings.planTools.drop')
        : (importOptions.toolsAsText ? __('settings.planTools.text') : __('settings.planTools.keep'))

      const actions = tab === TAB_PENDING
        ? [
            React.createElement('button', {
              key: 'import',
              type: 'button',
              style: importIds.length === 0 || busy ? disabledBtnStyle : primaryBtnStyle,
              disabled: importIds.length === 0 || busy,
              onClick: onImport,
            }, importing ? __('settings.importing') : __('settings.import', { n: importIds.length })),
            React.createElement('button', {
              key: 'hide',
              type: 'button',
              style: importIds.length === 0 || busy ? dangerOutlineBtnOffStyle : dangerOutlineBtnStyle,
              disabled: importIds.length === 0 || busy,
              onClick: onHide,
            }, hiding ? __('settings.deleting') : __('settings.deletePick', { n: importIds.length })),
          ]
        // 目标态的动作只在真有对应目标时出现：按钮常驻会让「现在该按哪个」变成
        // 一个要用户先想清楚的问题，而多数时候答案只有一个（甚至没有）。
        : tab === TAB_IMPORTED
          ? [
              syncIds.length > 0 || syncing
                ? React.createElement('button', {
                    key: 'sync',
                    type: 'button',
                    style: syncIds.length === 0 || busy ? disabledBtnStyle : ghostBtnStyle,
                    disabled: syncIds.length === 0 || busy,
                    onClick: onSync,
                  }, syncing ? __('settings.syncing') : __('settings.syncButton', { n: syncIds.length }))
                : null,
              regroupIds.length > 0 || grouping
                ? React.createElement('button', {
                    key: 'regroup',
                    type: 'button',
                    style: regroupIds.length === 0 || busy ? disabledBtnStyle : ghostBtnStyle,
                    disabled: regroupIds.length === 0 || busy,
                    onClick: onRegroup,
                  }, grouping ? __('settings.regrouping') : __('settings.regroup', { n: regroupIds.length }))
                : null,
              putBackIds.length > 0 || puttingBack
                ? React.createElement('button', {
                    key: 'putback',
                    type: 'button',
                    style: putBackIds.length === 0 || busy ? disabledBtnStyle : ghostBtnStyle,
                    disabled: putBackIds.length === 0 || busy,
                    onClick: onPutBack,
                  }, puttingBack ? __('settings.restoringOne') : __('settings.restoreButton'))
                : null,
            ]
          : [
              React.createElement('button', {
                key: 'unhide',
                type: 'button',
                style: unhideIds.length === 0 || busy ? disabledBtnStyle : primaryBtnStyle,
                disabled: unhideIds.length === 0 || busy,
                onClick: onUnhide,
              }, unhiding ? __('settings.restoring') : __('settings.restorePick', { n: unhideIds.length })),
            ]

      const emptyText = tab === TAB_PENDING
        ? __('settings.empty')
        : tab === TAB_IMPORTED ? __('settings.emptyImported') : __('settings.emptyRecycle')

      return React.createElement('div', { style: { padding: '4px 0 8px' } }, [
        React.createElement(ImportTabs, {
          key: 'tabs',
          tab,
          pending: pending.length,
          imported: imported.length,
          recycled: recycled.length,
          loading,
          onTab,
          __,
        }),

        // No hint paragraph under the strip: each tab now carries its own "?" on
        // the label, so the answer to "which of the three am I looking at" is
        // available on the tabs themselves — and the strip gets its line back.
        //
        // The policy is behind a button, so the one line that quotes it stays
        // on the page: without it the mode is invisible exactly while it is
        // being applied.
        tab === TAB_PENDING
          ? React.createElement('div', { key: 'plan', style: { ...metaStyle, margin: '4px 0 0' } },
              __('settings.plan', { mode: modeHint, tools: toolsHint }))
          : null,

        // Toolbar: filter, select helpers, refresh, the selection count, and the
        // verbs that fit this tab.
        // Toolbar, in two rows: the filter is a box you type into and gets its
        // own line; the controls live under it, starting with the select-all box
        // at the far left — level with the row boxes it mirrors.
        React.createElement('div', {
          key: 'bar',
          style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))' },
        }, [
          React.createElement('div', { key: 'filter-row', style: filterRowStyle }, [
            React.createElement('input', {
              key: 'filter',
              type: 'text',
              value: filter,
              placeholder: __('settings.filter'),
              // A filter is a new list: page 1 is where the user expects to be.
              onChange: (event) => { setFilter(event.target.value); setPage(0) },
              style: filterInputStyle,
              'aria-label': __('settings.filter'),
            }),
          ]),
          React.createElement('div', { key: 'action-row', style: actionRowStyle }, [
            React.createElement(SelectAllBox, {
              key: 'all',
              label: __('settings.selectAll'),
              checked: allVisiblePicked,
              disabled: visible.length === 0 || busy,
              onToggle: toggleAllVisible,
            }),
            React.createElement('button', {
              key: 'refresh',
              type: 'button',
              style: loading || busy ? ghostBtnOffStyle : ghostBtnStyle,
              disabled: loading || busy,
              onClick: () => refresh(),
            }, __('settings.refresh')),
            React.createElement('span', {
              key: 'picked', style: { ...metaStyle, margin: 0 },
            }, __('batch.selected', { n: picked.size })),
            React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
            ...actions,
          ]),
        ]),

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                inTab.length === 0 ? emptyText : __('settings.filterEmpty'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                pageEntries.flatMap((entry, index) => {
                  const session = entry.row
                  // A heading opens each group, and page 1 of a group is only
                  // "the first row of the page": a page that starts mid-group
                  // still has to say which group these rows belong to.
                  const opensGroup = index === 0 || pageEntries[index - 1].key !== entry.key
                  const nodes = []
                  if (opensGroup) {
                    nodes.push(React.createElement(GroupHeading, {
                      key: `group:${entry.key}:${index}`,
                      groupKey: entry.key,
                      label: entry.label,
                      count: counts.get(entry.key) ?? 0,
                      first: index === 0,
                      __,
                    }))
                  }
                  const badges = []
                  if (session.alreadyImported) {
                    badges.push(React.createElement('span', { key: 'done', style: badgeStyle }, __('settings.badgeDone')))
                  }
                  // 未归组只在已导入那栏说：待导入的行本来就没进过 DSH，
                  // 给每一行都挂一个「未分组」等于没挂。
                  if (tab === TAB_IMPORTED && session.grouped === false) {
                    badges.push(React.createElement('span', { key: 'ungrouped', style: warnBadgeStyle }, __('settings.badgeUngrouped')))
                  }
                  if (session.adopted) {
                    badges.push(React.createElement('span', { key: 'adopted', style: adoptedBadgeStyle }, __('settings.badgeAdopted')))
                  }
                  nodes.push(React.createElement('label', {
                    key: session.id,
                    style: opensGroup ? rowStyle : rowBorderStyle,
                  }, [
                    // 已导入的行仍可勾选：它是回写与还原的目标，不是禁区。
                    // 「不能重复导入」由导入按钮自己过滤（importIds），不该让复选
                    // 框替它做出这个判断。
                    React.createElement('input', {
                      key: 'box',
                      type: 'checkbox',
                      checked: picked.has(session.id),
                      disabled: busy,
                      onChange: () => togglePick(session.id),
                      style: { marginTop: 3, flex: 'none' },
                    }),
                    React.createElement('span', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                      React.createElement('span', {
                        key: 'title',
                        style: {
                          display: 'block', fontSize: 13, lineHeight: '20px',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                      }, session.title || session.id),
                      React.createElement('span', {
                        key: 'meta',
                        style: {
                          display: 'block', fontSize: 12, lineHeight: '18px',
                          color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                      }, [
                        session.cwd ? `${session.cwd} · ` : '',
                        formatTime(session.createdAt),
                        session.messageCount !== undefined ? ` · ${session.messageCount} 条消息` : '',
                      ].join('')),
                    ]),
                    ...badges,
                  ]))
                  return nodes
                })),

        // Not rendered while empty: a footer under "nothing to import" is one
        // more line of furniture.
        loading || visible.length === 0
          ? null
          : React.createElement(Pager, {
              key: 'pager',
              page: safePage,
              pageCount,
              total: visible.length,
              pageSize,
              onPage: setPage,
              onPageSize,
              __,
            }),

        error !== null
          ? React.createElement('div', { key: 'err', style: errStyle }, [
              React.createElement('div', { key: 'msg' }, error),
              React.createElement('button', {
                key: 'retry', type: 'button', style: { ...ghostBtnStyle, marginTop: 6 },
                onClick: () => refresh(),
              }, __('settings.retry')),
            ])
          : null,
        note !== null
          ? React.createElement('div', { key: 'note', style: okStyle }, note)
          : null,
      ])
    }

    // --- apply -----------------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      localeSvc = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }))
        }
      } catch { /* namespace already registered */ }
    }

    function apply(ctx) {
      sessionsSvc = ctx.get('sessions')
      if (!sessionsSvc) ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions })

      adoptLocale(ctx.get('locale'), ctx)
      if (!localeSvc) {
        ctx.inject(['locale'], (sub) => { adoptLocale(sub.locale, ctx) })
      }

      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: SETTINGS_ID,
        order: 70,
        label: () => t('settings.nav'),
        ...(localeSvc ? { locale: NS } : {}),
      }, ImportPanel))

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: TOAST_ID,
        order: 130,
        ...(localeSvc ? { locale: NS } : {}),
      }, ToastHost))

      // The policy dialog, from the same overlay. It sits after the toast so a
      // banner raised while it is open still lands on top of it.
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: CONFIG_ID,
        order: 140,
        ...(localeSvc ? { locale: NS } : {}),
      }, ConfigDialog))
    }

    return { apply, inject: ['slots'] }
  },
})
