/**
 * dsh-import-workbuddy — HOST half.
 *
 * Exposes the import pipeline to the DSH settings page over two same-origin
 * guarded HTTP routes on the web server:
 *
 *   GET  /__dsh-import-workbuddy/sessions  — list WorkBuddy candidates
 *   POST /__dsh-import-workbuddy/import    — import a picked subset
 *   POST /__dsh-import-workbuddy/sync      — write DSH turns back
 *   POST /__dsh-import-workbuddy/restore   — undo an adopt
 *   GET  /__dsh-import-workbuddy/adopted   — what adopt has taken
 *   POST /__dsh-import-workbuddy/hide      — soft-delete candidates (page's bin)
 *   POST /__dsh-import-workbuddy/unhide    — take them back out of the bin
 *   POST /__dsh-import-workbuddy/regroup   — attach imported sessions to their group
 *   GET  /__dsh-import-workbuddy/presets   — agent presets this deployment offers
 *   POST /__dsh-import-workbuddy/preset    — set the agent preset of imported sessions
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

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { adoptArchiveRoot, listAdopted, restoreAdopted } from '../lib/adopt.mjs'
import { collectCandidates, importCandidates, normalizeMode } from '../lib/import-core.mjs'
import { deriveImportTitle } from '../lib/convert.mjs'
import { findExistingSession, rewriteSessionHeader, normalizePresetId, DEFAULT_AGENT_PRESET, CURRENT_ARTIFACT_FILENAME } from '../lib/dsh-writer.mjs'
import { readDshSession } from '../lib/dsh-reader.mjs'
import { hideCandidates, hiddenIds, readHidden, unhideCandidates } from '../lib/hidden.mjs'
import { syncBack, readWatermark } from '../lib/sync-back.mjs'
import { dshHome } from '../lib/util.mjs'
import { attachSessionsToWorkspaces, groupedSessionIds } from '../lib/workspace-group.mjs'
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
 * Four flags, and they are independent:
 *   - `alreadyImported`  — has a DSH artifact (idempotency)
 *   - `deletedInWorkBuddy` — soft-deleted on the WorkBuddy side; the jsonl
 *     survives on disk, which is how deleted conversations used to get
 *     resurrected by a filesystem-only scan
 *   - `adopted`          — source jsonl already archived away to DSH
 *   - `hidden`           — the user swept it out of the pending list from this
 *     page; it lives in the page's own recycle tab until unhidden
 *   - `grouped`          — a DSH workspace already lists it, so importing it
 *     lands it in a named group rather than under Ungrouped
 *
 * @param {object[]} candidates collectCandidates output
 * @param {object} marks
 * @param {Set<string>} marks.hidden ids the page's bin is holding
 * @param {Set<string>} marks.grouped ids a DSH workspace already accounts for
 */
function describeCandidates(candidates, marks = {}) {
  const states = readWorkbuddyState(candidates.map(c => c.id), { workbuddyRoot: workbuddyRoot() })
  const adoptedIds = new Set(listAdopted().filter(entry => entry.present).map(entry => entry.id))
  const hidden = marks.hidden ?? new Set()
  const grouped = marks.grouped ?? new Set()

  return candidates.map((candidate) => {
    const state = states.get(candidate.id)
    const title = candidateTitle(candidate)
    const dir = findExistingSession(sessionsRoot(), candidate.id)
    return {
      id: candidate.id,
      title,
      workBuddyTitle: state?.title ?? null,
      cwd: candidate.cwd ?? null,
      projectDir: candidate.projectDir ?? null,
      createdAt: candidate.createdAt ?? null,
      // 最后一条消息的时间。列表按它排序也按它显示 —— 创建时间会把「开了
      // 两周、每天还在聊」的会话压到底下，那正是最该排在前面的那一批。
      updatedAt: candidate.updatedAt ?? null,
      messageCount: candidate.messageCount,
      alreadyImported: dir !== false,
      // 已经进 DSH 的那些行才报自己挂在哪个 agent 预设下：要改就得先看见
      // 现在是什么。待导入的行没有 DSH 产物，报 null（页面不显示）。
      agentPreset: dir === false ? null : readImportedPreset(dir),
      deletedInWorkBuddy: state !== undefined && state.deletedAt !== null,
      adopted: adoptedIds.has(candidate.id),
      hidden: hidden.has(candidate.id),
      grouped: grouped.has(candidate.id),
      // 同步回写需要源文件还在；被接管归档的就没法再回写了。
      canSyncBack: !adoptedIds.has(candidate.id),
    }
  })
}

/**
 * The agent preset an already-imported session currently carries.
 *
 * Read from the artifact header, which is the same field the import writes and
 * `/preset` rewrites — so what the row reports and what the button changes are
 * the same value. `null` when it cannot be read: a preset nobody can see is a
 * guess, and a guess is worse than a blank.
 *
 * Only called for rows that do have an artifact, so an import-heavy page does
 * not pay for candidates that are still on the WorkBuddy side.
 *
 * @param {string} dir session directory inside `$DSH_HOME/sessions`
 * @returns {string | null}
 */
function readImportedPreset(dir) {
  try {
    const artifact = join(dir, CURRENT_ARTIFACT_FILENAME)
    const path = existsSync(artifact) ? artifact : join(dir, 'session.jsonl.zstd')
    if (!existsSync(path)) return null
    const header = readDshSession(path).header ?? {}
    return normalizePresetId(header.agentPreset ?? DEFAULT_AGENT_PRESET)
  } catch {
    return null
  }
}

/** The title a candidate would carry once imported (falls back to its id). */
function candidateTitle(candidate) {
  try {
    const derived = deriveImportTitle(workbuddyTitle(candidate.parsed.messages), candidate.parsed.messages, undefined)
    if (typeof derived === 'string' && derived.length > 0) return derived
  } catch { /* a title is cosmetic */ }
  return candidate.id
}

/** What an archived transcript can still say about itself. */
function archiveFacts(entry) {
  const facts = { title: entry.id, cwd: entry.cwd ?? null, messageCount: 0 }
  try {
    const parsed = parseWorkBuddySession(entry.archived)
    facts.messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0
    if (parsed.header?.cwd !== undefined) facts.cwd = parsed.header.cwd
    const derived = deriveImportTitle(workbuddyTitle(parsed.messages), parsed.messages, undefined)
    if (typeof derived === 'string' && derived.length > 0) facts.title = derived
  } catch { /* an unreadable archive still restores; the row just says less */ }
  return facts
}

/**
 * Describe ids for the recycle manifest, so a hidden row can still be drawn
 * after its transcript is gone.
 *
 * The three sources are tried in order, cheapest truth first: the projects tree
 * (the normal case — hiding never moves the file), the adopt archive (the
 * transcript is in DSH now), and the manifest's own earlier row (already hidden;
 * re-hiding must not erase what it knew).
 */
function resolveRowsForIds(ids) {
  const wanted = new Set(ids)
  const rows = []
  const seen = new Set()

  for (const candidate of collectCandidates(workbuddyRoot())) {
    if (!wanted.has(candidate.id)) continue
    seen.add(candidate.id)
    rows.push({
      id: candidate.id,
      title: candidateTitle(candidate),
      cwd: candidate.cwd ?? '',
      projectDir: candidate.projectDir ?? '',
    })
  }

  const archived = new Map(listAdopted().filter(entry => entry.present).map(entry => [entry.id, entry]))
  for (const id of ids) {
    if (seen.has(id)) continue
    const archive = archived.get(id)
    if (archive === undefined) continue
    seen.add(id)
    const facts = archiveFacts(archive)
    rows.push({
      id,
      title: facts.title,
      cwd: typeof facts.cwd === 'string' ? facts.cwd : '',
      projectDir: '',
    })
  }

  for (const entry of readHidden()) {
    if (!wanted.has(entry.id) || seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push(entry)
  }

  // 兜底：什么都不认识也照样记一行，否则「划掉」这个动作会静默失败。
  for (const id of ids) {
    if (seen.has(id)) continue
    rows.push({ id, title: '', cwd: '', projectDir: '' })
  }
  return rows
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
function describeAdoptedRows(adopted, onDiskIds, marks = {}) {
  const hidden = marks.hidden ?? new Set()
  const grouped = marks.grouped ?? new Set()
  const rows = []
  for (const entry of adopted) {
    if (!entry.present || onDiskIds.has(entry.id)) continue
    const facts = archiveFacts(entry)
    const dir = findExistingSession(sessionsRoot(), entry.id)
    rows.push({
      id: entry.id,
      title: facts.title,
      workBuddyTitle: null,
      cwd: facts.cwd,
      projectDir: null,
      createdAt: entry.archivedAt ?? null,
      // 归档之后轨迹不再变动，归档那一刻就是它最后活动的时间。
      updatedAt: entry.archivedAt ?? null,
      messageCount: facts.messageCount,
      alreadyImported: dir !== false,
      agentPreset: dir === false ? null : readImportedPreset(dir),
      // 已在 WorkBuddy 侧软删除，但界面上「已接管」才是可操作的那条信息。
      deletedInWorkBuddy: false,
      adopted: true,
      hidden: hidden.has(entry.id),
      grouped: grouped.has(entry.id),
      canSyncBack: false,
    })
  }
  return rows
}

/**
 * Rows the page's recycle tab holds but the projects tree no longer has.
 *
 * A hidden candidate normally still sits in the projects tree and arrives with
 * the rest of the list. But it can go away underneath us — WorkBuddy's own
 * cleanup, or adopting it from another session — and a row that silently
 * disappears from the bin is a row nobody can get back. The manifest recorded
 * enough at hide time to keep describing it.
 *
 * @param {object[]} entries readHidden()
 * @param {Set<string>} known ids already present in the list
 */
function describeHiddenRows(entries, known, marks = {}) {
  const grouped = marks.grouped ?? new Set()
  const rows = []
  for (const entry of entries) {
    if (known.has(entry.id)) continue
    rows.push({
      id: entry.id,
      title: entry.title.length > 0 ? entry.title : entry.id,
      workBuddyTitle: null,
      cwd: entry.cwd.length > 0 ? entry.cwd : null,
      projectDir: entry.projectDir.length > 0 ? entry.projectDir : null,
      createdAt: entry.at ?? null,
      // 划进回收站那一刻：它已经离开列表，不会再有新的活动。
      updatedAt: entry.at ?? null,
      messageCount: undefined,
      alreadyImported: findExistingSession(sessionsRoot(), entry.id) !== false,
      deletedInWorkBuddy: false,
      adopted: false,
      hidden: true,
      grouped: grouped.has(entry.id),
      canSyncBack: false,
    })
  }
  return rows
}

/**
 * 一行的「最后活动时间」：有 updatedAt 用它，否则用创建时间顶上，
 * 两者都没有的返回 null（排序时一律沉到最后）。
 *
 * 界面按这个排序，所以它必须是唯一的一个数 —— 不能让「没有更新时间」的
 * 行变成 0 混在最旧的一批里，那是拿一个不知道的值冒充一个知道的值。
 *
 * @param {object} row
 * @returns {number|null}
 */
function rowActivity(row) {
  const value = row?.updatedAt ?? row?.createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 列表按最后活动时间倒序：最新的排在最上面。
 *
 * 在 host 侧排，不在 client 侧：client 还要再按项目目录分块，而分块用的是
 * 稳定排序 —— 先在这里把全局顺序定死，client 分块之后块内块间才都是新→旧。
 */
function byMostRecent(rows) {
  return [...rows].sort((a, b) => {
    const at = rowActivity(a)
    const bt = rowActivity(b)
    if (at === null && bt === null) return 0
    if (at === null) return 1
    if (bt === null) return -1
    return bt - at
  })
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
  // agent 预设：形状校验（限长/限字符集）在 normalizePresetId 里做，
  // 非法值会被它归一成 'standard' —— 也就是历史行为，绝不写进无效 id。
  // 存在性校验留给调用方，因为那需要 agent-preset registry。
  if (value.agentPreset !== undefined) options.agentPreset = normalizePresetId(value.agentPreset)
  for (const key of ['truncate', 'toolTruncate']) {
    const raw = value[key]
    if (raw === undefined || raw === null) continue
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${key} must be a non-negative integer`)
    options[key] = n
  }
  return options
}

// --- agent presets -----------------------------------------------------------
//
// Why the page needs this at all: a session's agent preset is decided when the
// session is created/resumed, from the `agentPreset` field of the session
// header. The import writes that header, so the import is the only chance to
// pick the preset — and afterwards the only way to change it is to rewrite that
// one header line. Both directions need the deployment's preset roster, which
// lives in the `agentPresets` service (dsh-agent-preset-registry).

/** The preset registry, or undefined on a deployment that has no such service. */
function presetRegistry(ctx) {
  try {
    return ctx.get('agentPresets')
  } catch {
    return undefined
  }
}

/**
 * The presets this deployment offers, as the page should list them.
 *
 * Returns `undefined` when the service is absent so callers can distinguish
 * "no registry" (fall back to a free-form id) from "registry says none".
 *
 * @returns {Promise<Array<{id: string, name?: string, description?: string, isDefault?: boolean, broken?: string}> | undefined>}
 */
async function listPresets(ctx) {
  const registry = presetRegistry(ctx)
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  const rows = await registry.list()
  if (!Array.isArray(rows)) return undefined
  let defaultId
  try {
    defaultId = registry.defaultId
  } catch { /* older host: no default notion, fine */ }
  return rows.map(row => ({ ...row, ...(row.id === defaultId ? { isDefault: true } : {}) }))
}

/** Whether `id` names a preset this deployment actually has. */
async function presetExists(ctx, id) {
  const rows = await listPresets(ctx)
  // No registry: we cannot prove it does not exist, so we allow it. The
  // alternative — refusing every id — would break deployments that supply
  // presets some other way.
  if (rows === undefined) return { known: false, ok: true }
  return { known: true, ok: rows.some(row => row.id === id) }
}

/**
 * Whether this session's agent preset may still be changed.
 *
 * Changing the preset of a session that already ran under the old one is not a
 * rename: the system prompt, the tool set and the whole composition change
 * mid-conversation, so the transcript would contain turns produced by two
 * different agents. For an imported session's *original* turns that is harmless
 * — they came from WorkBuddy and were never governed by a DSH preset — but once
 * DSH itself has appended turns, the session has a genuinely preset-dependent
 * history. Those are refused instead of silently rewritten.
 *
 * The signal is the import watermark: the import stamps `lastSeq = events - 1`,
 * and every later append (a resume, a new turn) pushes the real event count past
 * it. A missing watermark means the artifact was not written by this plugin, and
 * then we cannot tell — we allow it, since the picker only ever offers sessions
 * this plugin imported.
 *
 * @param {string} artifactPath
 * @returns {{ ok: boolean, events?: number, extra?: number, reason?: string }}
 */
function presetChangeAllowed(artifactPath) {
  let session
  try {
    session = readDshSession(artifactPath)
  } catch (error) {
    return { ok: false, reason: `无法解析会话产物：${error?.message ?? String(error)}` }
  }
  const events = Array.isArray(session.events) ? session.events.length : 0
  const watermark = readWatermark(session.dir)
  if (Number.isInteger(watermark.lastSeq) && watermark.lastSeq >= 0) {
    const extra = events - (watermark.lastSeq + 1)
    if (extra > 0) {
      return {
        ok: false,
        events,
        extra,
        reason: `这个会话在 DSH 里已经继续对话过（比导入时多了 ${extra} 条事件），换预设会让同一段对话前后跑在不同的 agent 下`,
      }
    }
  }
  return { ok: true, events }
}

// --- self-update -------------------------------------------------------------
//
// Updating the plugin is two moves, and neither alone is enough: pull upstream
// into the copy the user installed, then publish those files into the copy DSH
// actually loads (`syncLoadedCopy`). The second half exists because a `file:`
// dependency often lands in `node_modules` as a *hard-linked copy* rather than
// a symlink: git writes the vendor files with a fresh inode, the link does not
// follow, and the app keeps running the old bytes. That failure is invisible
// from the interface — this very page can show a feature the loaded code does
// not have, which is a hard thing to report from inside the thing that is
// lying to you.

const SELF_NAME = 'dsh-import-workbuddy'
const SELF_REPO_URL = 'https://github.com/yuchuan000/dsh-import-workbuddy.git'
const SELF_BRANCH = 'main'

/**
 * What the plugin is, as paths: anything else in the directory (a `.bak`
 * folder, something the user left next to it) is not ours to publish into
 * `node_modules`.
 */
const SELF_TOP_FILES = ['package.json', 'cordis.patch.yml', 'README.md']
const SELF_SUBDIRS = ['src', 'lib', 'bin']

const execFileAsync = promisify(execFile)

/**
 * The directory this running copy sits in: `src/index.js` is one level below
 * the package root. Read from the module's own URL rather than `process.cwd()`,
 * which is the app's, not the plugin's.
 */
export function selfRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Run one git command; trims stdout and throws on any non-zero exit. */
async function gitRun(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    // An update must never wait on a credential prompt nobody can answer: the
    // button is not a terminal.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
  })
  return String(stdout).trim()
}

/**
 * A remote written either way is the same repository: `git@host:owner/name` is
 * the ssh spelling of `https://host/owner/name`.
 */
function canonicalRepoUrl(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '')
  const ssh = raw.match(/^git@([^:]+):(.+)$/)
  return (ssh === null ? raw : `${ssh[1]}/${ssh[2]}`).replace(/^https?:\/\//, '')
}

/**
 * What is installed here, or why there isn't an answer.
 *
 * `repo: false` covers the shape this plugin is most often found in: synced
 * from another machine, unpacked from a zip, or left behind by an uninstall —
 * a directory with the right files and no history. Not something the user did
 * wrong, and nothing they can fix from the page; `adoptSelfRepo` repairs it in
 * place.
 */
export async function readSelfVersion({ root = selfRoot(), run = gitRun } = {}) {
  try {
    const [commit, date, branch] = await Promise.all([
      run(['rev-parse', '--short', 'HEAD'], root),
      run(['log', '-1', '--format=%cd', '--date=short'], root),
      run(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    ])
    const [remote, porcelain] = await Promise.all([
      run(['remote', 'get-url', 'origin'], root).catch(() => ''),
      run(['status', '--porcelain'], root).catch(() => ''),
    ])
    return { repo: true, commit, date, branch, remote: remote || '', dirty: porcelain !== '' }
  } catch (error) {
    return { repo: false, error: error?.message ?? String(error) }
  }
}

/**
 * Point an existing tree at its own upstream without replacing it.
 *
 * `git clone` into a non-empty directory is refused outright, and emptying the
 * directory first would take local-only files with it. `init` + remote + fetch
 * keeps untracked files and overwrites tracked ones — which is exactly what
 * "install the current release" means.
 */
export async function adoptSelfRepo({ root = selfRoot(), run = gitRun } = {}) {
  await run(['init', '-q'], root)
  await run(['remote', 'remove', 'origin'], root).catch(() => {})
  await run(['remote', 'add', 'origin', SELF_REPO_URL], root)
}

/**
 * Make `origin` be this plugin's own repository.
 *
 * The one input here worth correcting rather than trusting: the install below
 * applies whatever `origin` currently points at, and "update" that follows a
 * rewritten remote is remote code execution wearing a reassuring label.
 */
async function assertSelfRemote(root, run) {
  const current = await run(['remote', 'get-url', 'origin'], root).catch(() => '')
  if (canonicalRepoUrl(current) === canonicalRepoUrl(SELF_REPO_URL)) return false
  // `set-url` refuses a remote that does not exist yet ("No such remote
  // 'origin'"), which is the ordinary shape of a `.git` that came from
  // `git init` alone — including the one `adoptSelfRepo` writes when the tree
  // had no history. Letting that throw turned the whole check into a 500.
  const names = await run(['remote'], root).catch(() => '')
  const has = String(names).split('\n').map(name => name.trim()).includes('origin')
  if (has) await run(['remote', 'set-url', 'origin', SELF_REPO_URL], root)
  else await run(['remote', 'add', 'origin', SELF_REPO_URL], root)
  return true
}

/** Fetch upstream and read where it stands today. */
async function fetchSelf({ root, run }) {
  // Shallow on purpose: the newest commit is the answer, and its ancestors are
  // not something this button owes anybody.
  await run(['fetch', '--depth', '50', 'origin', SELF_BRANCH], root)
  const [commit, date] = await Promise.all([
    run(['rev-parse', '--short', 'FETCH_HEAD'], root),
    run(['log', '-1', '--format=%cd', '--date=short', 'FETCH_HEAD'], root),
  ])
  return { commit, date }
}

/**
 * Where upstream stands relative to this copy.
 *
 * A copy with no history cannot answer "am I behind" — every commit upstream is
 * new to it, which is another way of describing a fresh install. Reported as
 * `available` rather than as an error, because it is the ordinary state of a
 * copy that was never checked out.
 */
export async function checkSelfUpdate({ root = selfRoot(), run = gitRun } = {}) {
  let installed = await readSelfVersion({ root, run })
  let adopted = false
  if (installed.repo !== true) {
    await adoptSelfRepo({ root, run })
    adopted = true
  }
  const remoteFixed = await assertSelfRemote(root, run)
  let latest
  try {
    latest = await fetchSelf({ root, run })
  } catch (error) {
    return {
      ok: false,
      code: 'FETCH_FAILED',
      error: error?.message ?? String(error),
      installed: installed.repo === true ? { commit: installed.commit, date: installed.date, dirty: installed.dirty } : null,
      adopted,
      remoteFixed,
    }
  }
  const behind = installed.repo !== true
    ? null
    : Number(await run(['rev-list', '--count', `${installed.commit}..FETCH_HEAD`], root).catch(() => '0')) || 0
  return {
    ok: true,
    installed: installed.repo === true
      ? { commit: installed.commit, date: installed.date, dirty: installed.dirty }
      : null,
    latest,
    behind,
    available: behind === null || behind > 0,
    adopted,
    remoteFixed,
  }
}

/**
 * Install upstream over this copy; returns what changed, including whether the
 * copy DSH loads was published to — see `syncLoadedCopy`.
 */
export async function applySelfUpdate({ root = selfRoot(), run = gitRun } = {}) {
  const before = await readSelfVersion({ root, run })
  if (before.repo !== true) await adoptSelfRepo({ root, run })
  await assertSelfRemote(root, run)
  await run(['fetch', '--depth', '50', 'origin', SELF_BRANCH], root)
  // `-f` overwrites tracked files; untracked ones stay. A named branch rather
  // than a detached HEAD, so the next check has something to compare from.
  await run(['checkout', '-f', '-B', SELF_BRANCH, 'FETCH_HEAD'], root)
  const after = await readSelfVersion({ root, run })
  const published = syncLoadedCopy({ root })
  return {
    from: before.repo === true ? before.commit : null,
    to: after.repo === true ? after.commit : null,
    published,
    restartRequired: true,
  }
}

/**
 * Where DSH loads this plugin from, when that is somewhere else.
 *
 * Three layouts worth telling apart: a symlink into `vendor/` (same bytes,
 * nothing to do), a real directory of hard links (must be overwritten in
 * place), and no second copy at all.
 */
export function loadedCopyRoot(root = selfRoot()) {
  const profile = dirname(dirname(root))
  return join(profile, 'node_modules', SELF_NAME)
}

/**
 * Whether two paths are already the same file.
 *
 * Not a redundant check: a `file:` dependency installed as hard links leaves
 * `vendor/x` and `node_modules/x` pointing at one inode, and copying a file
 * onto *itself* truncates it before it is read — which empties it. The copy
 * that would "publish" the file is the copy that destroys it.
 */
function sameFile(a, b) {
  try {
    const left = statSync(a)
    const right = statSync(b)
    return left.ino !== 0 && left.ino === right.ino && left.dev === right.dev
  } catch {
    return false
  }
}

/**
 * Publish this copy's files over whichever copy DSH loads.
 *
 * `copyFileSync` rather than remove-then-write: it rewrites an existing file's
 * bytes, so its inode — and therefore any hard link pointing at it — survives.
 * Deleting first would break the link and leave `node_modules` holding the old
 * content forever. That is the bug this whole route exists to retire.
 */
export function syncLoadedCopy({ root = selfRoot() } = {}) {
  const target = loadedCopyRoot(root)
  if (target === root) return { state: 'self', copied: [], shared: [], failed: [] }
  if (!existsSync(target)) return { state: 'absent', copied: [], shared: [], failed: [] }
  try {
    if (lstatSync(target).isSymbolicLink()) return { state: 'linked', copied: [], shared: [], failed: [] }
  } catch {
    return { state: 'absent', copied: [], shared: [], failed: [] }
  }

  const pairs = []
  for (const file of SELF_TOP_FILES) {
    const from = join(root, file)
    if (existsSync(from)) pairs.push([from, join(target, file), file])
  }
  for (const dir of SELF_SUBDIRS) {
    const from = join(root, dir)
    if (!existsSync(from) || !statSync(from).isDirectory()) continue
    try { mkdirSync(join(target, dir), { recursive: true }) } catch { /* see per-file failures below */ }
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      pairs.push([join(from, entry.name), join(target, dir, entry.name), `${dir}/${entry.name}`])
    }
  }

  const copied = []
  const shared = []
  const failed = []
  for (const [from, to, label] of pairs) {
    try {
      // Already one file: nothing to publish, and copying would empty it.
      if (sameFile(from, to)) { shared.push(label); continue }
      copyFileSync(from, to)
      copied.push(label)
    } catch (error) {
      // EBUSY is the interesting one — a running DSH holding the file open.
      // Reported rather than swallowed: "updated" without this note would read
      // as finished while the app still runs the old bytes.
      failed.push({ file: label, error: error?.message ?? String(error) })
    }
  }
  return { state: 'copied', copied, shared, failed }
}

/** Register the client-facing routes; returns a disposer. */
function registerRoutes(host, ctx) {
  const disposers = []

  // The preset roster, for the import dialog's picker and the row editor.
  // Read-only, and the page needs it before it can offer any choice at all.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/presets`,
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
        const presets = await listPresets(ctx)
        sendJson(response, 200, {
          ok: true,
          presets: presets ?? [],
          // The page must know whether the list is authoritative: with no
          // registry it should not offer a picker it cannot populate.
          known: presets !== undefined,
          default: DEFAULT_AGENT_PRESET,
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  // Change the agent preset of already-imported sessions. Rewrites one header
  // line per session; the event frames are copied through untouched.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/preset`,
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

      const preset = normalizePresetId(body?.preset)
      if (typeof body?.preset !== 'string' || body.preset.trim().length === 0) {
        sendJson(response, 400, { ok: false, error: 'preset is required' })
        return
      }
      let ids
      try {
        ids = normalizeIds(body?.ids)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message })
        return
      }
      if (ids === undefined || ids.length === 0) {
        sendJson(response, 400, { ok: false, error: 'ids is required' })
        return
      }

      try {
        // Existence check against the roster. A typo here would produce a
        // session that fails to mount on resume, which is worse than a refusal.
        const known = await presetExists(ctx, preset)
        if (known.known && !known.ok) {
          sendJson(response, 400, { ok: false, error: `未知的 agent 预设：${preset}` })
          return
        }

        const root = sessionsRoot()
        const changed = []
        const skipped = []
        const failed = []

        for (const rawId of ids) {
          // Rows in the imported tab carry the import id (wb-…); adopt keeps
          // whatever id the artifact already had. Try both so neither shape
          // silently reports "not found".
          const candidates = [rawId.startsWith('wb-') ? rawId : `wb-${rawId}`, rawId]
          let dir
          for (const candidate of candidates) {
            dir = findExistingSession(root, candidate)
            if (dir) break
          }
          if (!dir) {
            failed.push({ id: rawId, error: '找不到已导入的会话产物' })
            continue
          }

          const artifact = join(dir, CURRENT_ARTIFACT_FILENAME)
          const path = existsSync(artifact) ? artifact : join(dir, 'session.jsonl.zstd')
          if (!existsSync(path)) {
            failed.push({ id: rawId, error: '产物文件不存在' })
            continue
          }

          const allowed = presetChangeAllowed(path)
          if (!allowed.ok) {
            skipped.push({ id: rawId, reason: allowed.reason })
            continue
          }

          try {
            // Read the current value first so the response can report a real
            // from → to transition instead of guessing.
            const before = readDshSession(path).header?.agentPreset ?? DEFAULT_AGENT_PRESET
            const result = rewriteSessionHeader(path, header => ({ ...header, agentPreset: preset }))
            changed.push({ id: rawId, from: before, to: result.header.agentPreset, changed: result.changed })
          } catch (error) {
            failed.push({ id: rawId, error: error?.message ?? String(error) })
          }
        }

        sendJson(response, 200, { ok: true, preset, changed, skipped, failed })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

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
        const hidden = hiddenIds()
        const grouped = groupedSessionIds(ctx.get('workspaceRegistry'))
        const sessions = describeCandidates(candidates, { hidden, grouped })
        const known = new Set(sessions.map(s => s.id))
        sessions.push(...describeAdoptedRows(listAdopted(), known, { hidden, grouped }))
        // 被划进回收站、但已经不在 projects 树里的：只能靠清单自己描述。
        const hiddenEntries = readHidden()
        sessions.push(...describeHiddenRows(hiddenEntries, new Set(sessions.map(s => s.id)), { grouped }))
        const ordered = byMostRecent(sessions)
        sendJson(response, 200, {
          ok: true,
          workbuddyRoot: workbuddyRoot(),
          sessionsRoot: sessionsRoot(),
          archiveRoot: adoptArchiveRoot(),
          sessions: ordered,
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
        // 写盘只是半个导入：DSH 的分组由 workspace 注册表决定，不挂一次就会
        // 一直躺在「未分组」里。挂失败的会话仍然导入成功了，所以单独成桶。
        const regrouped = await attachSessionsToWorkspaces(
          ctx.get('workspaceRegistry'),
          result.imported.map(entry => ({ id: entry.candidate.id, cwd: entry.candidate.cwd })),
        )
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
          grouped: regrouped.grouped,
          regroupFailed: regrouped.failed,
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

  // --- the page's own recycle bin ---------------------------------------------
  //
  // Soft delete, deliberately: hiding a candidate says "stop showing me this",
  // nothing about the WorkBuddy transcript, which is never touched. The row
  // moves to the third tab instead of disappearing, so the gesture is undoable
  // without going near WorkBuddy's own UI.

  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/hide`,
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
      try {
        // The manifest is one file written atomically, so this is all-or-nothing:
        // a false is "the write did not land", never "some of them did".
        const written = await hideCandidates(resolveRowsForIds(ids))
        if (written !== true) {
          sendJson(response, 500, { ok: false, error: 'could not write the recycle manifest' })
          return
        }
        sendJson(response, 200, { ok: true, hidden: ids })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/unhide`,
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
      try {
        const written = await unhideCandidates(ids)
        if (written !== true) {
          sendJson(response, 500, { ok: false, error: 'could not write the recycle manifest' })
          return
        }
        sendJson(response, 200, { ok: true, restored: ids })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
    },
  }))

  // Attach already-imported sessions to the group their cwd names. Imports made
  // before this route existed (or ones the registry refused at the time) sit
  // under Ungrouped; this is the repair, and it is the same code path the import
  // itself uses — so a session that still cannot be grouped says why.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/regroup`,
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
      try {
        const wanted = new Set(ids)
        const entries = []
        for (const candidate of collectCandidates(workbuddyRoot())) {
          if (wanted.has(candidate.id)) entries.push({ id: candidate.id, cwd: candidate.cwd })
        }
        // Adopted sessions have no transcript in the tree any more; their cwd
        // lives in the archive.
        const seen = new Set(entries.map(entry => entry.id))
        for (const archive of listAdopted()) {
          if (!archive.present || !wanted.has(archive.id) || seen.has(archive.id)) continue
          entries.push({ id: archive.id, cwd: archiveFacts(archive).cwd })
        }
        const result = await attachSessionsToWorkspaces(ctx.get('workspaceRegistry'), entries)
        sendJson(response, 200, { ok: true, grouped: result.grouped, failed: result.failed })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error?.message ?? String(error) })
      }
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

  // --- self-update ----------------------------------------------------------
  //
  // GET reports where upstream stands; POST installs it. The fence runs before
  // either, because the POST is `git fetch` followed by a checkout of whatever
  // came back — update, in the literal sense, over this plugin's own files.
  //
  // Why this is a route and not a paragraph in the README: the hard part of
  // updating this plugin is knowing which of the two copies the app loads, and
  // that is a fact about this machine, not about the reader.
  disposers.push(host.register({
    kind: 'exact',
    path: `${PREFIX}/update`,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        const result = request.method === 'GET'
          ? await checkSelfUpdate()
          : await applySelfUpdate()
        // `root` rides along on every answer: the one question a failure raises
        // first is "which copy did it try to update", and only the host knows.
        sendJson(response, 200, { ok: true, ...result, root: selfRoot() })
      } catch (error) {
        sendJson(response, 500, {
          ok: false, error: error?.message ?? String(error), root: selfRoot(),
        })
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
