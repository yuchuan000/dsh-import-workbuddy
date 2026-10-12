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
    const { Toast } = require('@deepseek-ai/dsh-client-ui-primitives')

    const PREFIX = '/__dsh-import-workbuddy'
    const SETTINGS_SLOT = 'settings.section'
    const OVERLAY_SLOT = 'shell.overlay'
    const SETTINGS_ID = 'import-workbuddy-settings'
    const TOAST_ID = 'import-workbuddy-toast'

    // --- locale -----------------------------------------------------------------

    const NS = 'import-workbuddy'

    const zh = {
      'settings.nav': 'WorkBuddy 导入',
      'settings.desc': '把本机 WorkBuddy（腾讯 CodeBuddy）的会话导入 DSH，成为可继续对话的原生会话。勾选要导入的内容，重复导入会自动跳过。',
      'settings.root': 'WorkBuddy 目录：{root}',
      'settings.candidates': '共 {n} 个会话，其中 {done} 个已导入',
      'settings.filter': '筛选（标题 / 目录 / id）',
      'settings.selectAll': '全选未导入',
      'settings.selectNone': '清空选择',
      'settings.refresh': '刷新列表',
      'settings.import': '导入所选（{n}）',
      'settings.importing': '正在导入…',
      'settings.loading': '正在读取 WorkBuddy 会话…',
      'settings.empty': '没有发现可导入的 WorkBuddy 会话。',
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
      'settings.desc': 'Import local WorkBuddy (Tencent CodeBuddy) conversations into DSH as native, resumable sessions. Tick what you want; re-importing skips automatically.',
      'settings.root': 'WorkBuddy root: {root}',
      'settings.candidates': '{n} conversations, {done} already imported',
      'settings.filter': 'Filter (title / folder / id)',
      'settings.selectAll': 'Select all pending',
      'settings.selectNone': 'Clear selection',
      'settings.refresh': 'Refresh',
      'settings.import': 'Import selected ({n})',
      'settings.importing': 'Importing…',
      'settings.loading': 'Reading WorkBuddy conversations…',
      'settings.empty': 'No importable WorkBuddy conversations found.',
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
     * The import page, registered into `settings.section` so it appears with
     * the harness's own settings pages.
     *
     * Selection state is a Set of candidate ids; already-imported rows are
     * shown for completeness but cannot be picked (the host would skip them
     * anyway — this keeps the count honest instead of lying about the work).
     */
    function ImportPanel() {
      const __ = t
      useLocaleRevision()
      const [sessions, setSessions] = useState([])
      const [root, setRoot] = useState('')
      const [picked, setPicked] = useState(() => new Set())
      const [filter, setFilter] = useState('')
      const [loading, setLoading] = useState(true)
      const [importing, setImporting] = useState(false)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      const [noTools, setNoTools] = useState(false)
      const [toolsAsText, setToolsAsText] = useState(false)
      // 归属模式。默认 copy：与这个插件一直以来的行为一致，且完全不碰源文件。
      const [mode, setMode] = useState('copy')
      const [syncing, setSyncing] = useState(false)
      const [restoring, setRestoring] = useState(false)

      // Import / sync / restore are mutually exclusive and all three mutate
      // something, so one flag gates every control rather than three.
      const busy = importing || syncing || restoring

      const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          const payload = await fetchSessions()
          setSessions(payload.sessions ?? [])
          setRoot(payload.workbuddyRoot ?? '')
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

      const pending = sessions.filter(s => !s.alreadyImported)
      const byId = new Map(sessions.map(s => [s.id, s]))
      const needle = filter.trim().toLowerCase()
      const visible = needle.length === 0
        ? sessions
        : sessions.filter(s => (
          String(s.title || '').toLowerCase().includes(needle)
          || String(s.cwd || '').toLowerCase().includes(needle)
          || String(s.projectDir || '').toLowerCase().includes(needle)
          || String(s.id || '').toLowerCase().includes(needle)
        ))
      const visiblePending = visible.filter(s => !s.alreadyImported)
      // 「全选」跳过 WorkBuddy 侧已删除的：那是用户主动删过的，默认勾上等于复活。
      const autoPickable = visiblePending.filter(s => !s.deletedInWorkBuddy)
      const pickedVisible = visiblePending.filter(s => picked.has(s.id)).length
      const allVisiblePicked = autoPickable.length > 0 && autoPickable.every(s => picked.has(s.id))
      const anyDeleted = sessions.some(s => s.deletedInWorkBuddy)

      // One tick set, three targets. Which rows a button acts on depends on
      // what the row *is*, so a single list serves import, sync and restore
      // without three competing selections fighting over the same checkbox.
      const importIds = [...picked].filter(id => byId.get(id) !== undefined && !byId.get(id).alreadyImported)
      const syncIds = [...picked].filter(id => byId.get(id)?.alreadyImported === true && byId.get(id).canSyncBack !== false)
      const restoreIds = [...picked].filter(id => byId.get(id)?.adopted === true)

      const togglePick = useCallback((id) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => (allVisiblePicked
          ? new Set()
          : new Set(autoPickable.map(s => s.id))))
      }, [allVisiblePicked, autoPickable])

      const onImport = useCallback(async () => {
        const ids = importIds
        if (ids.length === 0) return
        setImporting(true)
        setError(null)
        setNote(null)
        try {
          const result = await postImport(ids, { noTools, toolsAsText, mode })
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
      }, [importIds, noTools, toolsAsText, mode, refresh, __])

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

      const headingStyle = { fontSize: 13, fontWeight: 600, margin: '14px 0 2px' }

      return React.createElement('div', { style: { padding: '4px 0 8px' } }, [
        React.createElement('div', {
          key: 'desc', style: { ...metaStyle, margin: '0 0 8px' },
        }, __('settings.desc')),
        root.length > 0
          ? React.createElement('div', { key: 'root', style: { ...metaStyle, marginBottom: 8 } },
              __('settings.root', { root }))
          : null,

        // Toolbar: filter, select helpers, refresh, and the import action.
        React.createElement('div', {
          key: 'bar',
          style: {
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
            padding: '6px 0 8px',
            borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
          },
        }, [
          React.createElement('input', {
            key: 'filter',
            type: 'text',
            value: filter,
            placeholder: __('settings.filter'),
            onChange: (event) => setFilter(event.target.value),
            style: {
              flex: '1 1 180px', minWidth: 140, padding: '5px 10px',
              fontSize: 12, borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
              background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
            },
          }),
          React.createElement('button', {
            key: 'all',
            type: 'button',
            style: ghostBtnStyle,
            disabled: autoPickable.length === 0 || busy,
            onClick: toggleAllVisible,
          }, allVisiblePicked ? __('settings.selectNone') : __('settings.selectAll')),
          React.createElement('button', {
            key: 'refresh',
            type: 'button',
            style: ghostBtnStyle,
            disabled: loading || busy,
            onClick: () => refresh(),
          }, __('settings.refresh')),
          React.createElement('button', {
            key: 'import',
            type: 'button',
            style: importIds.length === 0 || busy ? disabledBtnStyle : primaryBtnStyle,
            disabled: importIds.length === 0 || busy,
            onClick: onImport,
          }, importing ? __('settings.importing') : __('settings.import', { n: importIds.length })),
          // 回写与还原只在有对应目标时出现：三个按钮常驻会让「现在该按哪个」
          // 变成一个要用户先想清楚的问题，而多数时候答案只有一个。
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
        ]),

        React.createElement('div', { key: 'count', style: { ...metaStyle, margin: '2px 0 0' } },
          __('settings.candidates', { n: sessions.length, done: sessions.length - pending.length })),

        anyDeleted
          ? React.createElement('div', {
              key: 'deleted-hint', style: { ...metaStyle, marginTop: 4 },
            }, __('settings.deletedHint'))
          : null,

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                sessions.length === 0 ? __('settings.empty') : __('settings.filter'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                visible.map((session, index) => {
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

        // 归属方式。放在选项之前：它决定「导入」这个动作到底意味着什么，
        // 比「要不要保留工具卡片」高一个层级。
        React.createElement('div', { key: 'mode-head', style: headingStyle }, __('settings.mode')),
        React.createElement('select', {
          key: 'mode-select',
          value: mode,
          disabled: busy,
          onChange: (event) => setMode(event.target.value),
          style: selectStyle,
        }, [
          React.createElement('option', { key: 'copy', value: 'copy' }, __('settings.mode.copy')),
          React.createElement('option', { key: 'adopt', value: 'adopt' }, __('settings.mode.adopt')),
          React.createElement('option', { key: 'sync', value: 'sync' }, __('settings.mode.sync')),
        ]),
        // 选中项的解释紧跟其后：三种模式的代价都不是一句话能说清的，而
        // 「接管会搬走原文件」这种事必须在按按钮之前就看见。
        React.createElement('div', { key: 'mode-hint', style: { ...metaStyle, marginTop: 6 } },
          __(`settings.mode.${mode}Hint`)),

        React.createElement('div', { key: 'opts-head', style: headingStyle }, __('settings.options')),
        React.createElement(OptionRow, {
          key: 'opt-notools',
          label: __('settings.noTools'),
          hint: __('settings.noToolsHint'),
          checked: noTools,
          disabled: busy,
          onChange: setNoTools,
        }),
        React.createElement(OptionRow, {
          key: 'opt-asttext',
          label: __('settings.toolsAsText'),
          hint: __('settings.toolsAsTextHint'),
          checked: toolsAsText,
          disabled: busy,
          onChange: setToolsAsText,
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
    }

    return { apply, inject: ['slots'] }
  },
})
