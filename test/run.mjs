#!/usr/bin/env node
/**
 * 回归测试运行器。
 *
 * 用法:
 *   node test/run.mjs            跑全部
 *   node test/run.mjs select     只跑选择逻辑
 *   node test/run.mjs e2e        只跑端到端
 *
 * 零依赖（不引入任何测试框架）。退出码 0 = 全绿，1 = 有失败。
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

const files = readdirSync(here)
  .filter(f => f.endsWith('.test.mjs'))
  .filter(f => filter === undefined || f.includes(filter))
  .sort()

if (files.length === 0) {
  process.stderr.write(`没有找到匹配 "${filter ?? ''}" 的测试文件\n`)
  process.exit(1)
}

let total = 0
let passed = 0
const failures = []

for (const file of files) {
  const mod = await import(pathToFileURL(join(here, file)).href)
  const suiteName = mod.name ?? file.replace(/\.test\.mjs$/, '')
  process.stdout.write(`\n── ${suiteName} (${file}) ──\n`)
  const results = await mod.run()
  for (const r of results) {
    total += 1
    if (r.ok) {
      passed += 1
      process.stdout.write(`  ✓ ${r.label}\n`)
    } else {
      process.stdout.write(`  ✗ ${r.label}\n`)
      process.stdout.write(`      ${r.error?.message ?? r.error}\n`)
      failures.push({ suite: suiteName, label: r.label, error: r.error })
    }
  }
}

process.stdout.write(`\n${'─'.repeat(50)}\n`)
process.stdout.write(`结果: ${passed}/${total} 通过`)
if (failures.length > 0) process.stdout.write(`  ✗ ${failures.length} 个失败`)
process.stdout.write('\n')

if (failures.length > 0) {
  process.stdout.write('\n失败详情:\n')
  for (const f of failures) {
    process.stdout.write(`  [${f.suite}] ${f.label}\n`)
    process.stdout.write(`      ${f.error?.stack ?? f.error}\n`)
  }
  process.exit(1)
}
process.exit(0)
