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
      const pickedVisible = visiblePending.filter(s => picked.has(s.id)).length
      const allVisiblePicked = visiblePending.length > 0 && pickedVisible === visiblePending.length

      const togglePick = useCallback((id) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => (visiblePending.length > 0 && visiblePending.every(s => prev.has(s.id))
          ? new Set()
          : new Set(visiblePending.map(s => s.id))))
      }, [visiblePending])

      const onImport = useCallback(async () => {
        const ids = [...picked].filter(id => !sessions.some(s => s.id === id && s.alreadyImported))
        if (ids.length === 0) return
        setImporting(true)
        setError(null)
        setNote(null)
        try {
          const result = await postImport(ids, { noTools, toolsAsText })
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
          if (result.failed.length > 0) {
            setNote(__('settings.resultFailures', {
              failures: result.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'),
            }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setImporting(false)
      }, [picked, sessions, noTools, toolsAsText, refresh, __])

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
            disabled: visiblePending.length === 0,
            onClick: toggleAllVisible,
          }, allVisiblePicked ? __('settings.selectNone') : __('settings.selectAll')),
          React.createElement('button', {
            key: 'refresh',
            type: 'button',
            style: ghostBtnStyle,
            disabled: loading || importing,
            onClick: () => refresh(),
          }, __('settings.refresh')),
          React.createElement('button', {
            key: 'import',
            type: 'button',
            style: picked.size === 0 || importing ? disabledBtnStyle : primaryBtnStyle,
            disabled: picked.size === 0 || importing,
            onClick: onImport,
          }, importing ? __('settings.importing') : __('settings.import', { n: picked.size })),
        ]),

        React.createElement('div', { key: 'count', style: { ...metaStyle, margin: '2px 0 0' } },
          __('settings.candidates', { n: sessions.length, done: sessions.length - pending.length })),

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                sessions.length === 0 ? __('settings.empty') : __('settings.filter'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                visible.map((session, index) => React.createElement('label', {
                  key: session.id,
                  style: index === 0 ? rowStyle : rowBorderStyle,
                }, [
                  React.createElement('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: session.alreadyImported || picked.has(session.id),
                    disabled: session.alreadyImported || importing,
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
                  session.alreadyImported
                    ? React.createElement('span', { key: 'badge', style: badgeStyle }, __('settings.badgeDone'))
                    : null,
                ]))),

        React.createElement('div', { key: 'opts-head', style: headingStyle }, __('settings.options')),
        React.createElement(OptionRow, {
          key: 'opt-notools',
          label: __('settings.noTools'),
          hint: __('settings.noToolsHint'),
          checked: noTools,
          disabled: importing,
          onChange: setNoTools,
        }),
        React.createElement(OptionRow, {
          key: 'opt-asttext',
          label: __('settings.toolsAsText'),
          hint: __('settings.toolsAsTextHint'),
          checked: toolsAsText,
          disabled: importing,
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
