/**
 * Shared helpers for the pi / opencode → DSH import scripts.
 * Zero-dependency ESM, runs on Node >= 22.19 (node:sqlite + node:zlib zstd).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the DSH Harness home the same way @deepseek-ai/dsh-home-paths does. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Resolve the shared agents home the same way dsh-skill-filesystem does. */
export function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

/** Log a line to stderr (stdout stays reserved for command output). */
export function log(...parts) {
  process.stderr.write(`${parts.join(' ')}\n`)
}

/** Truncate a string to `max` chars, appending an ellipsis when cut. */
export function truncate(text, max) {
  if (max === undefined || text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * Parse `--key value` style flags plus a bare positional list.
 *
 * 支持三种形式：
 *   --key value      取值
 *   --key=value      取值（内联）
 *   --flag           布尔（下一个参数以 -- 开头、或没有下一个参数时）
 *
 * 已知的布尔开关集合由 BOOLEAN_FLAGS 决定——否则 `--list` 会把后面的
 * 位置参数误吞成它的值。
 */
const BOOLEAN_FLAGS = new Set([
  'dry-run', 'apply', 'all', 'list', 'help',
  'no-tools', 'tools-as-text',
])

export function parseArgs(argv, spec) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      flags.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = (eq >= 0 ? arg.slice(0, eq) : arg).slice(2)
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined

    if (inline !== undefined) {
      flags[name] = inline
      continue
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    // 没有内联值：下一个参数不是 flag 就吃掉，否则视为布尔
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  for (const key of Object.keys(spec)) {
    if (flags[key] === undefined && spec[key] !== undefined) flags[key] = spec[key]
  }
  return { flags, positionals }
}

/** Parse an ISO date or epoch-ms string into ms, or undefined. */
export function parseSince(value) {
  if (value === undefined) return undefined
  const ms = Number(value)
  if (Number.isFinite(ms) && ms > 1e11) return ms
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new Error(`cannot parse --since value "${value}" (use ISO date or epoch ms)`)
  return parsed
}


