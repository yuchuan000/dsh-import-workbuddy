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
    // The two lists as tabs on one section. They are the same candidates read
    // two ways — what is still to come across, and what already has — and the
    // actions differ per tab (import vs sync back / put back), so a tab that
    // names the state keeps each toolbar to the verb that fits it.
    const TAB_PENDING = 'pending'
    const TAB_IMPORTED = 'imported'

    // --- locale -----------------------------------------------------------------

    const NS = 'import-workbuddy'

    const zh = {
      'settings.nav': 'WorkBuddy 导入',
      'settings.tabsLabel': '导入页签',
      'settings.tabPending': '待导入',
      'settings.tabImported': '已导入',
      'settings.tabCount': '共 {n} 条',
      'settings.config': '配置',
      'settings.configTitle': '导入设置',
      'settings.configDesc': '这里的改动立即生效，关掉即生效完毕。',
      'settings.close': '关闭',
      'settings.desc': '把本机 WorkBuddy（腾讯 CodeBuddy）的会话导入 DSH，成为可继续对话的原生会话。勾选要导入的内容，重复导入会自动跳过。',
      'settings.importedHint': '已经在 DSH 里的会话。勾选可以把 DSH 这边新产生的对话回写进 WorkBuddy 原会话；接管过来的还可以还原回去。',
      'settings.plan': '导入方式：{mode}｜工具调用：{tools}',
      'settings.planTools.keep': '保留',
      'settings.planTools.text': '转为纯文本',
      'settings.planTools.drop': '丢弃',
      'settings.root': 'WorkBuddy 目录：{root}',
      'settings.filter': '筛选（标题 / 目录 / id）',
      'settings.selectPage': '全选本页',
      'settings.selectNone': '清空选择',
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
      'settings.filterEmpty': '没有符合条件的会话。',
      'batch.selected': '已选 {n} 条',
      'settings.badgeDone': '已导入',
      'settings.badgeDeleted': '已删除',
      'settings.badgeAdopted': '已接管',
      'settings.colTitle': '会话',
      'settings.options': '导入选项',
      'settings.noTools': '丢弃工具调用',
      'settings.noToolsHint': '只保留对话文本，适合只想看聊天内容的场景。',
      'settings.toolsAsText': '工具调用转纯文本',
      'settings.toolsAsTextHint': '工具调用以文本形式保留在轨迹里，不生成工具卡片。',
      'settings.retry': '重试',
      'settings.result': '完成：新导入 {imported}，已存在跳过 {existing}，空会话 {empty}，失败 {failed}',
      'settings.resultFailures': '部分失败：{failures}',
      'settings.importedOne': '已导入 {n} 个会话',
      'settings.sidebarHint': '会话已写入，侧边栏已刷新；如未出现请重启 DSH。',
      'settings.unknownError': '未知错误',

      // 归属模式
      'settings.mode': '归属方式',
      'settings.mode.copy': '拷贝（保留原会话）',
      'settings.mode.copyHint': '只读 WorkBuddy 的会话，在 DSH 里写一份新的。源文件一个字节都不动，两边从此分叉：WorkBuddy 那份停在导入那一刻。',
      'settings.mode.adopt': '接管（原会话搬过来）',
      'settings.mode.adoptHint': '导入后把 WorkBuddy 的轨迹文件归档到 DSH，并在它的注册表里打上删除标记，DSH 成为唯一一份。可逆：归档文件保留着，随时可以还原。',
      'settings.mode.sync': '同步（两边都能接着看）',
      'settings.mode.syncHint': '保留 WorkBuddy 原会话，DSH 里后续新产生的对话可以回写进去，两边内容保持一致。回写是有损的：推理过程不回写，只回写正文与工具调用。',
      'settings.syncButton': '回写所选（{n}）',
      'settings.syncing': '正在回写…',
      'settings.syncedOne': '已回写 {n} 个会话，新增 {lines} 行',
      'settings.syncNone': '没有新增内容需要回写',
      'settings.syncFailures': '回写失败：{failures}',
      'settings.syncOnlyImported': '只能回写已经在 DSH 里的会话',
      'settings.restoreButton': '还原到 WorkBuddy',
      'settings.restoring': '正在还原…',
      'settings.restoredOne': '已还原 {n} 个会话到 WorkBuddy',
      'settings.restoreNone': '没有已接管的会话',
      'settings.restoreFailures': '还原失败：{failures}',
      'settings.deletedHint': '这些会话你在 WorkBuddy 里已经删过（软件只打了删除标记，轨迹文件还留着）。默认不勾选，需要时可以手动选上。',
      'settings.adoptFailedHint': '会话已导入，但搬走源文件失败：{failures}',
    }

    const en = {
      'settings.nav': 'WorkBuddy import',
      'settings.tabsLabel': 'Import page tabs',
      'settings.tabPending': 'Pending',
      'settings.tabImported': 'Imported',
      'settings.tabCount': '{n} entries',
      'settings.config': 'Settings',
      'settings.configTitle': 'Import settings',
      'settings.configDesc': 'Every change here applies immediately — just close this when you are done.',
      'settings.close': 'Close',
      'settings.desc': 'Import local WorkBuddy (Tencent CodeBuddy) conversations into DSH as native, resumable sessions. Tick what you want; re-importing skips automatically.',
      'settings.importedHint': 'Conversations already in DSH. Tick one to write later turns in DSH back to the WorkBuddy original; anything adopted can also be put back.',
      'settings.plan': 'Import as: {mode} · Tool calls: {tools}',
      'settings.planTools.keep': 'kept',
      'settings.planTools.text': 'as plain text',
      'settings.planTools.drop': 'dropped',
      'settings.root': 'WorkBuddy root: {root}',
      'settings.filter': 'Filter (title / folder / id)',
      'settings.selectPage': 'Select page',
      'settings.selectNone': 'Clear selection',
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
      'settings.filterEmpty': 'Nothing matches the filter.',
      'batch.selected': '{n} selected',
      'settings.badgeDone': 'Imported',
      'settings.badgeDeleted': 'Deleted',
      'settings.badgeAdopted': 'Adopted',
      'settings.colTitle': 'Conversation',
      'settings.options': 'Import options',
      'settings.noTools': 'Drop tool calls',
      'settings.noToolsHint': 'Keep dialogue text only — for when you just want the chat content.',
      'settings.toolsAsText': 'Tool calls as plain text',
      'settings.toolsAsTextHint': 'Tool calls stay in the transcript as text, with no tool cards.',
      'settings.retry': 'Retry',
      'settings.result': 'Done: {imported} imported, {existing} already present, {empty} empty, {failed} failed',
      'settings.resultFailures': 'Some failed: {failures}',
      'settings.importedOne': 'Imported {n} conversation(s)',
      'settings.sidebarHint': 'Sessions written and the sidebar refreshed; restart DSH if they do not show up.',
      'settings.unknownError': 'unknown error',

      'settings.mode': 'Ownership',
      'settings.mode.copy': 'Copy (keep the original)',
      'settings.mode.copyHint': 'Reads the WorkBuddy conversation and writes a new one in DSH. The source file is untouched, and the two histories diverge from this moment on.',
      'settings.mode.adopt': 'Adopt (move it over)',
      'settings.mode.adoptHint': 'After importing, the WorkBuddy transcript is archived into DSH and marked deleted in its registry, so DSH holds the only copy. Reversible: the archived file is kept and can be put back.',
      'settings.mode.sync': 'Sync (keep both readable)',
      'settings.mode.syncHint': 'Keeps the WorkBuddy original, and later turns made in DSH can be written back to it so both sides stay in step. Writing back is lossy: reasoning is dropped, only message text and tool calls come across.',
      'settings.syncButton': 'Sync back ({n})',
      'settings.syncing': 'Syncing…',
      'settings.syncedOne': 'Synced {n} conversation(s), {lines} new line(s)',
      'settings.syncNone': 'Nothing new to sync back',
      'settings.syncFailures': 'Sync failed: {failures}',
      'settings.syncOnlyImported': 'Only conversations already in DSH can be synced back',
      'settings.restoreButton': 'Put back in WorkBuddy',
      'settings.restoring': 'Restoring…',
      'settings.restoredOne': 'Restored {n} conversation(s) to WorkBuddy',
      'settings.restoreNone': 'Nothing has been adopted',
      'settings.restoreFailures': 'Restore failed: {failures}',
      'settings.deletedHint': 'You already deleted these in WorkBuddy (it only marks them; the transcript files survive). Unticked by default — tick them manually if you want them back.',
      'settings.adoptFailedHint': 'Imported, but moving the source file failed: {failures}',
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
    const badgeStyle = {
      flex: 'none', fontSize: 11, lineHeight: '16px', padding: '0 8px',
      borderRadius: 8, whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
    }
    // 已删除用警示色：它意味着「你删过这个，现在要把它拿回来」。
    const deletedBadgeStyle = {
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
    const toolbarStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '6px 0 8px',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    const filterInputStyle = {
      flex: '1 1 180px', minWidth: 140, padding: '5px 10px',
      fontSize: 12, borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }

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
      padding: '6px 10px', marginBottom: -1, borderRadius: '6px 6px 0 0',
      border: 'none', borderBottom: '2px solid transparent',
      background: 'transparent', cursor: 'pointer',
      fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
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
    const settingHintStyle = {
      display: 'block', fontSize: 12, lineHeight: '18px', marginTop: 2,
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }
    const settingRowStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0',
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

    function OptionRow(props) {
      const { label, hint, checked, disabled, onChange } = props
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
        React.createElement('span', { key: 'text', style: { display: 'block' } }, [
          React.createElement('span', {
            key: 'label', style: { display: 'block', fontSize: 13, lineHeight: '20px' },
          }, label),
          React.createElement('span', {
            key: 'hint',
            style: {
              display: 'block', fontSize: 12, lineHeight: '18px', marginTop: 2,
              color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
            },
          }, hint),
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

    /**
     * The page's tab strip: the candidate list in its two states, plus the
     * Configure button.
     *
     * The badge says how many rows each side is holding — the one number that
     * decides whether crossing over is worth a click. Both are known as soon as
     * the first read lands, so unlike the session-recycle strip there is nothing
     * to fetch here; they are simply withheld while that read is in flight, so
     * the strip never claims a zero it is about to contradict.
     */
    function ImportTabs(props) {
      const __ = props.__ || t
      const tabs = [
        { id: TAB_PENDING, label: __('settings.tabPending'), count: props.pending },
        { id: TAB_IMPORTED, label: __('settings.tabImported'), count: props.imported },
      ]
      return React.createElement('div', { style: tabStripStyle }, [
        React.createElement('div', {
          key: 'list',
          role: 'tablist',
          'aria-label': __('settings.tabsLabel'),
          style: tabListStyle,
        }, tabs.map(tab => {
          const on = props.tab === tab.id
          return React.createElement('button', {
            key: tab.id,
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
      return React.createElement(Modal, {
        open: true,
        onClose: () => setConfigOpen(false),
        title: __('settings.configTitle'),
        closeLabel: __('settings.close'),
        description: __('settings.configDesc'),
        footer: [React.createElement('button', {
          key: 'close', type: 'button', style: primaryBtnStyle, onClick: () => setConfigOpen(false),
        }, __('settings.close'))],
      }, [
        React.createElement('div', {
          key: 'mode-head', style: { ...settingLabelStyle, fontWeight: 600, marginBottom: 2 },
        }, __('settings.mode')),
        React.createElement('select', {
          key: 'mode-select',
          value: mode,
          style: selectStyle,
          'aria-label': __('settings.mode'),
          onChange: (event) => setOption('mode', event.target.value),
        }, [
          React.createElement('option', { key: 'copy', value: 'copy' }, __('settings.mode.copy')),
          React.createElement('option', { key: 'adopt', value: 'adopt' }, __('settings.mode.adopt')),
          React.createElement('option', { key: 'sync', value: 'sync' }, __('settings.mode.sync')),
        ]),
        // 选中项的解释紧跟其后：三种模式的代价都不是一句话能说清的，而
        // 「接管会搬走原文件」这种事必须在按按钮之前就看见。
        React.createElement('div', { key: 'mode-hint', style: { ...metaStyle, marginTop: 6 } },
          __(`settings.mode.${mode}Hint`)),

        React.createElement('div', { key: 'sep', style: separatorStyle }),
        React.createElement(OptionRow, {
          key: 'opt-notools',
          label: __('settings.noTools'),
          hint: __('settings.noToolsHint'),
          checked: importOptions.noTools,
          onChange: (value) => setOption('noTools', value),
        }),
        React.createElement(OptionRow, {
          key: 'opt-asttext',
          label: __('settings.toolsAsText'),
          hint: __('settings.toolsAsTextHint'),
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
     * One list in two tabs rather than one long page: the candidates split into
     * what still has to come across and what already has, because the verb
     * differs (import vs sync back / put back) and a toolbar with all three in
     * it makes "which button is mine" a question the user has to answer first.
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
     * back, put-back only takes rows this plugin adopted.
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
      const [restoring, setRestoring] = useState(false)
      // Paging. `page` is zero-based and the slice is derived (`paginate`), so a
      // filter or an import that shortens the list can never strand the page on
      // a slice it has no way back from.
      const [tab, setTab] = useState(TAB_PENDING)
      const [page, setPage] = useState(0)
      const [pageSize, setPageSize] = useState(() => readPageSize())
      const [, forceRender] = useState(0)

      // Import / sync / restore are mutually exclusive and all three mutate
      // something, so one flag gates every control rather than three.
      const busy = importing || syncing || restoring

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

      const pending = sessions.filter(s => !s.alreadyImported)
      const imported = sessions.filter(s => s.alreadyImported)
      const byId = new Map(sessions.map(s => [s.id, s]))
      const inTab = tab === TAB_PENDING ? pending : imported

      const needle = filter.trim().toLowerCase()
      const visible = needle.length === 0
        ? inTab
        : inTab.filter(s => (
          String(s.title || '').toLowerCase().includes(needle)
          || String(s.cwd || '').toLowerCase().includes(needle)
          || String(s.projectDir || '').toLowerCase().includes(needle)
          || String(s.id || '').toLowerCase().includes(needle)
        ))
      // 「全选」跳过 WorkBuddy 侧已删除的：那是用户主动删过的，默认勾上等于复活。
      // 已导入那栏没有这回事，整页都可选。
      const selectable = tab === TAB_PENDING
        ? visible.filter(s => !s.deletedInWorkBuddy)
        : visible
      const allVisiblePicked = selectable.length > 0 && selectable.every(s => picked.has(s.id))
      const anyDeleted = pending.some(s => s.deletedInWorkBuddy)

      // One tick set, three targets. Which rows a button acts on depends on
      // what the row *is*, so a single list serves import, sync and restore
      // without three competing selections fighting over the same checkbox.
      const importIds = [...picked].filter(id => byId.get(id) !== undefined && !byId.get(id).alreadyImported)
      const syncIds = [...picked].filter(id => byId.get(id)?.alreadyImported === true && byId.get(id).canSyncBack !== false)
      const restoreIds = [...picked].filter(id => byId.get(id)?.adopted === true)

      // Select acts on the page, not on the tab behind it: with 400 candidates
      // behind a filter, "select all" that reached off-screen would hand the
      // import button ids the user never saw.
      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (selectable.every(s => next.has(s.id))) {
            for (const row of selectable) next.delete(row.id)
          } else {
            for (const row of selectable) next.add(row.id)
          }
          return next
        })
      }, [selectable])

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
          // 接管失败是「导进来了但源文件没搬走」，不是「没导进来」：单独一条
          // 提示，绝不混进 resultFailures 让人以为会话丢失。
          const adoptFailures = result.adoptFailed ?? []
          if (adoptFailures.length > 0) {
            setNote(__('settings.adoptFailedHint', {
              failures: adoptFailures.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          } else if (result.failed.length > 0) {
            setNote(__('settings.resultFailures', {
              failures: result.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
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

      /** Undo for adopt mode: archived files go home, deletion marks clear. */
      const onRestore = useCallback(async () => {
        if (restoreIds.length === 0) return
        setRestoring(true)
        setError(null)
        setNote(null)
        try {
          const result = await postRestore(restoreIds)
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
        setRestoring(false)
      }, [restoreIds, refresh, __])

      const { rows: pageRows, page: safePage, pageCount } = paginate(visible, page, pageSize)
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
          ]
        // 回写与还原只在有对应目标时出现：按钮常驻会让「现在该按哪个」变成
        // 一个要用户先想清楚的问题，而多数时候答案只有一个。
        : [
            syncIds.length > 0 || syncing
              ? React.createElement('button', {
                  key: 'sync',
                  type: 'button',
                  style: syncIds.length === 0 || busy ? disabledBtnStyle : ghostBtnStyle,
                  disabled: syncIds.length === 0 || busy,
                  onClick: onSync,
                }, syncing ? __('settings.syncing') : __('settings.syncButton', { n: syncIds.length }))
              : null,
            restoreIds.length > 0 || restoring
              ? React.createElement('button', {
                  key: 'restore',
                  type: 'button',
                  style: restoreIds.length === 0 || busy ? disabledBtnStyle : ghostBtnStyle,
                  disabled: restoreIds.length === 0 || busy,
                  onClick: onRestore,
                }, restoring ? __('settings.restoring') : __('settings.restoreButton'))
              : null,
          ]

      return React.createElement('div', { style: { padding: '4px 0 8px' } }, [
        React.createElement(ImportTabs, {
          key: 'tabs',
          tab,
          pending: pending.length,
          imported: imported.length,
          loading,
          onTab,
          __,
        }),

        // Hint for the open tab. It is the first thing under the strip because
        // it answers "which of the two am I looking at" before the rows do.
        React.createElement('div', {
          key: 'hint', style: { ...metaStyle, margin: '8px 0 0' },
        }, tab === TAB_PENDING ? __('settings.desc') : __('settings.importedHint')),

        // The policy is behind a button, so the one line that quotes it stays
        // on the page: without it the mode is invisible exactly while it is
        // being applied.
        tab === TAB_PENDING
          ? React.createElement('div', { key: 'plan', style: { ...metaStyle, margin: '4px 0 0' } },
              __('settings.plan', { mode: modeHint, tools: toolsHint }))
          : null,

        tab === TAB_PENDING && anyDeleted
          ? React.createElement('div', { key: 'deleted-hint', style: { ...metaStyle, margin: '4px 0 0' } },
              __('settings.deletedHint'))
          : null,

        // Toolbar: filter, select helpers, refresh, the selection count, and the
        // verbs that fit this tab.
        React.createElement('div', { key: 'bar', style: toolbarStyle }, [
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
          React.createElement('button', {
            key: 'all',
            type: 'button',
            style: selectable.length === 0 || busy ? ghostBtnOffStyle : ghostBtnStyle,
            disabled: selectable.length === 0 || busy,
            onClick: toggleAllVisible,
          }, allVisiblePicked ? __('settings.selectNone') : __('settings.selectPage')),
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
          ...actions,
        ]),

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                inTab.length === 0
                  ? (tab === TAB_PENDING ? __('settings.empty') : __('settings.emptyImported'))
                  : __('settings.filterEmpty'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                pageRows.map((session, index) => {
                  const badges = []
                  if (session.alreadyImported) {
                    badges.push(React.createElement('span', { key: 'done', style: badgeStyle }, __('settings.badgeDone')))
                  }
                  if (session.deletedInWorkBuddy) {
                    badges.push(React.createElement('span', { key: 'deleted', style: deletedBadgeStyle }, __('settings.badgeDeleted')))
                  }
                  if (session.adopted) {
                    badges.push(React.createElement('span', { key: 'adopted', style: adoptedBadgeStyle }, __('settings.badgeAdopted')))
                  }
                  return React.createElement('label', {
                    key: session.id,
                    style: index === 0 ? rowStyle : rowBorderStyle,
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
                  ])
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
