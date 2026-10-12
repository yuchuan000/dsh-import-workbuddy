/**
 * dsh-import-workbuddy — HOST half.
 *
 * Exposes the import pipeline to the DSH settings page over two same-origin
 * guarded HTTP routes on the web server:
 *
 *   GET  /__dsh-import-workbuddy/sessions  — list WorkBuddy candidates
 *   POST /__dsh-import-workbuddy/import    — import a picked subset
 *
 * Why routes and not a native tool: the only caller is this plugin's own
 * settings page, which runs in the browser where @deepseek-ai/dsh-tools has no
 * client export (`ctx.get('tools')` is always undefined there). The fence below
 * is the community market's, deliberately: `exact` registrations win over the
 * harness's own /api fence, so the route has to defend itself.
 *
 * The pipeline itself lives in lib/import-core.mjs and is shared verbatim with
 * the CLI (import.mjs), so the page and the terminal cannot drift apart.
 */

import { join } from 'node:path'

import { adoptArchiveRoot, listAdopted, restoreAdopted } from '../lib/adopt.mjs'
import { collectCandidates, importCandidates, normalizeMode } from '../lib/import-core.mjs'
import { deriveImportTitle } from '../lib/convert.mjs'
import { findExistingSession } from '../lib/dsh-writer.mjs'
import { syncBack } from '../lib/sync-back.mjs'
import { dshHome } from '../lib/util.mjs'
import { readWorkbuddyState } from '../lib/workbuddy-state.mjs'
import {
  defaultWorkBuddyRoot,
  parseWorkBuddySession,
  workbuddyTitle,
} from '../lib/workbuddy-reader.mjs'

const name = 'import-workbuddy'
const inject = ['webServer']

/** Route prefix; the package name keeps ownership obvious in logs. */
const PREFIX = '/__dsh-import-workbuddy'

/** Bodies are small (id lists), but hundreds of ids must still fit. */
const MAX_BODY_BYTES = 256 * 1024

/** Refuse absurd selections rather than walking the whole store for them. */
const MAX_IDS = 5000

// --- fences ------------------------------------------------------------------
//
// Copied from the market's own mutating routes (and from dsh-session-recycle,
// which this plugin sits next to): Host must be loopback or a host the
// deployment declared through `dsh web --trusted-host` — the one header a
// DNS-rebinding page cannot forge. `Origin === Host` equality alone is
// satisfied by the attacker's own pair, so it is a second check, not the first.

/** Parse a bare `host[:port]` authority; null when the value is not one. */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === String(value).toLowerCase() ? url : null
  } catch {
    return null
  }
}

/** Whether a `Host` header names a loopback authority. */
function loopbackAuthority(host) {
  if (host === undefined) return false
  const lower = String(host).toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Authorities this deployment serves besides loopback, as the host declared them. */
function trustedHosts(ctx) {
  try {
    const connection = ctx.get('connection')
    const list = connection?.trustedHosts
    if (Array.isArray(list)) return list
    if (typeof list?.getSnapshot === 'function') return list.getSnapshot() ?? []
  } catch { /* older host: loopback-only, which is the stricter rule */ }
  return []
}

function trustedAuthority(host, list) {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return list.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/** Whether this request may read or mutate plugin state. */
function sameOrigin(ctx, request) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts(ctx))) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a size-capped JSON body. */
async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

// --- roots -------------------------------------------------------------------

/** DSH session store root; honours DSH_HOME exactly like the CLI. */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** WorkBuddy conversation root; honours WORKBUDDY_HOME. */
function workbuddyRoot() {
  return defaultWorkBuddyRoot()
}

/**
 * Shape the candidate list for the page.
 *
 * Batch rather than per-row on purpose: `readWorkbuddyState` opens the
 * WorkBuddy registry once and prepared-statements its way through the ids.
 * Doing it per candidate would open and close a SQLite handle 61 times on
 * every page load, against a database the WorkBuddy app may be writing to.
 *
 * Three flags, and they are independent:
 *   - `alreadyImported`  — has a DSH artifact (idempotency)
 *   - `deletedInWorkBuddy` — soft-deleted on the WorkBuddy side; the jsonl
 *     survives on disk, which is how deleted conversations used to get
 *     resurrected by a filesystem-only scan
 *   - `adopted`          — source jsonl already archived away to DSH
 */
function describeCandidates(candidates) {
  const states = readWorkbuddyState(candidates.map(c => c.id), { workbuddyRoot: workbuddyRoot() })
  const adoptedIds = new Set(listAdopted().filter(entry => entry.present).map(entry => entry.id))

  return candidates.map((candidate) => {
    let title
    try {
      title = deriveImportTitle(workbuddyTitle(candidate.parsed.messages), candidate.parsed.messages, undefined)
    } catch { /* a title is cosmetic; never fail the listing over one */ }
    const state = states.get(candidate.id)
    return {
      id: candidate.id,
      title: typeof title === 'string' && title.length > 0 ? title : candidate.id,
      workBuddyTitle: state?.title ?? null,
      cwd: candidate.cwd ?? null,
      projectDir: candidate.projectDir ?? null,
      createdAt: candidate.createdAt ?? null,
      messageCount: candidate.messageCount,
      alreadyImported: findExistingSession(sessionsRoot(), candidate.id) !== false,
      deletedInWorkBuddy: state !== undefined && state.deletedAt !== null,
      adopted: adoptedIds.has(candidate.id),
      // 同步回写需要源文件还在；被接管归档的就没法再回写了。
      canSyncBack: !adoptedIds.has(candidate.id),
    }
  })
}

/**
 * Rows for conversations adopt mode has already taken away.
 *
 * Without these the page loses them: `collectCandidates` scans the WorkBuddy
 * projects tree, and adopting moves the jsonl out of that tree. A reversibility
 * the user cannot reach from the page is not reversibility — adopt mode would
 * be a one-way door with the key filed in a manifest nobody reads.
 *
 * Title and message count come from the archived transcript itself, so the row
 * still says what it is even though nothing else can see it any more.
 */
function describeAdoptedRows(adopted, onDiskIds) {
  const rows = []
  for (const entry of adopted) {
    if (!entry.present || onDiskIds.has(entry.id)) continue
    let title = entry.id
    let messageCount = 0
    let cwd = entry.cwd ?? null
    try {
      const parsed = parseWorkBuddySession(entry.archived)
      messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
      if (parsed.header?.cwd !== undefined) cwd = parsed.header.cwd
      const derived = deriveImportTitle(workbuddyTitle(parsed.messages), parsed.messages, undefined)
      if (typeof derived === 'string' && derived.length > 0) title = derived
    } catch { /* an unreadable archive still restores; the row just says less */ }
    rows.push({
      id: entry.id,
      title,
      workBuddyTitle: null,
      cwd,
      projectDir: null,
      createdAt: entry.archivedAt ?? null,
      messageCount,
      alreadyImported: findExistingSession(sessionsRoot(), entry.id) !== false,
      // 已在 WorkBuddy 侧软删除，但界面上「已接管」才是可操作的那条信息。
      deletedInWorkBuddy: false,
      adopted: true,
      canSyncBack: false,
    })
  }
  return rows
}

/** Normalize a body id list: strings only, trimmed, de-duplicated, capped. */
function normalizeIds(value) {
  if (!Array.isArray(value)) return undefined
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length > 0) seen.add(id)
    if (seen.size > MAX_IDS) throw new Error(`too many ids (max ${MAX_IDS})`)
  }
  return [...seen]
}

/** Pick the import options a page may set; everything else stays default. */
function normalizeOptions(value) {
  const options = {}
  if (value === null || typeof value !== 'object') return options
  if (value.noTools === true) options.noTools = true
  if (value.toolsAsText === true) options.toolsAsText = true
  // 模式走 normalizeMode：未知值回落 copy，绝不因为一个拼错的枚举走成接管。
  if (value.mode !== undefined) options.mode = normalizeMode(value.mode)
  if (typeof value.titlePrefix === 'string' && value.titlePrefix.length > 0) options.titlePrefix = value.titlePrefix
  for (const key of ['truncate', 'toolTruncate']) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`)
    options[key] = n
  }
  return options
}

/** Register the client-facing routes; returns a disposer. */
function registerRoutes(host, ctx) {
  const disposers = []

  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/sessions`,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        const candidates = collectCandidates(workbuddyRoot())
        const sessions = describeCandidates(candidates)
        const adopted = listAdopted()
        sessions.push(...describeAdoptedRows(adopted, new Set(sessions.map(s => s.id))))
        sendJson(response, 200, {
          ok: true,
          workbuddyRoot: workbuddyRoot(),
          sessionsRoot: sessionsRoot(),
          archiveRoot: adoptArchiveRoot(),
          sessions,
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/import`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // Mutating route: the fence runs before the body is even read.
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      let ids
      let exclude
      let options
      try {
        ids = normalizeIds(body?.ids)
        exclude = normalizeIds(body?.exclude)
        options = normalizeOptions(body?.options)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message })
        return
      }
      // An empty pick is a no-op, not "import everything": the page always
      // sends the ids the user actually ticked.
      if (ids !== undefined && ids.length === 0) {
        sendJson(response, 200, { ok: true, imported: [], existing: [], empty: [], failed: [] })
        return
      }
      try {
        const candidates = collectCandidates(workbuddyRoot())
        let selected = candidates
        if (ids !== undefined) {
          const wanted = new Set(ids)
          selected = selected.filter(c => wanted.has(c.id) || wanted.has(c.id.replace(/^wb-/, '')))
        }
        if (exclude !== undefined && exclude.length > 0) {
          const dropped = new Set(exclude)
          selected = selected.filter(c => !dropped.has(c.id) && !dropped.has(c.id.replace(/^wb-/, '')))
        }
        const result = importCandidates(selected, {
          sessionsRoot: sessionsRoot(),
          workbuddyRoot: workbuddyRoot(),
          apply: true,
          ...options,
        })
        sendJson(response, 200, {
          ok: true,
          mode: result.mode,
          imported: result.imported.map(entry => ({
            id: entry.candidate.id,
            path: entry.path ?? null,
            events: entry.events.length,
            adopted: entry.adopted ?? null,
          })),
          existing: result.existing.map(c => c.id),
          empty: result.empty.map(c => c.id),
          failed: result.failed.map(entry => ({ id: entry.candidate.id, error: entry.error })),
          adoptFailed: result.adoptFailed,
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  // Sync mode's other half: push what happened in DSH back into the
  // WorkBuddy transcript the import came from.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/sync`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const ids = normalizeIds(body?.ids)
      if (ids !== undefined && ids.length === 0) {
        sendJson(response, 200, { ok: true, synced: [], failed: [] })
        return
      }
      try {
        const root = workbuddyRoot()
        const candidates = collectCandidates(root)
        const wanted = new Set(ids ?? candidates.map(c => c.id))
        const synced = []
        const failed = []
        for (const candidate of candidates) {
          if (!wanted.has(candidate.id)) continue
          try {
            const result = syncBack({
              id: candidate.id,
              source: candidate.file,
              sessionsRoot: sessionsRoot(),
              cwd: candidate.cwd ?? undefined,
            })
            synced.push({ id: candidate.id, appended: result.appended, lastSeq: result.lastSeq })
          } catch (error) {
            failed.push({ id: candidate.id, error: error?.message ?? String(error) })
          }
        }
        sendJson(response, 200, { ok: true, synced, failed })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  // Undo for adopt mode. Destructive in the other direction, so it reuses the
  // same fence and the same containment check as the adopt itself.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/restore`,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const ids = normalizeIds(body?.ids)
      if (ids === undefined || ids.length === 0) {
        sendJson(response, 400, { ok: false, error: 'ids is required' })
        return
      }
      const restored = []
      const failed = []
      for (const id of ids) {
        try {
          const result = restoreAdopted({ id, workbuddyRoot: workbuddyRoot() })
          restored.push({ id, ...result })
        } catch (error) {
          failed.push({ id, error: error?.message ?? String(error) })
        }
      }
      sendJson(response, 200, { ok: true, restored, failed })
    },
  }))

  // What adopt mode has taken, so the page can offer to give it back.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/adopted`,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        sendJson(response, 200, {
          ok: true,
          archiveRoot: adoptArchiveRoot(),
          adopted: listAdopted(),
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* best effort */ }
    }
  }
}

/** Cordis plugin entry (host realm). */
function apply(ctx) {
  // `webServer` is optional — a terminal-only profile has no web surface — so
  // the routes register when the service exists or appears later. The plugin
  // must never hang waiting on a service a profile will never provide.
  const register = (webServer, targetCtx) => {
    targetCtx.effect(() => registerRoutes(webServer, ctx), 'import-workbuddy: client bridge')
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) register(webServer, ctx)
  else ctx.inject(['webServer'], (sub) => register(sub.webServer, sub))
}

export { apply, inject, name }
