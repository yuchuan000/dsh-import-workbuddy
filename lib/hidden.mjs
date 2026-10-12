/**
 * 待导入列表的「软删除」清单。
 *
 * 用户在导入页把某些候选划掉时，删的只是**这件事**——「别再列给我看了」——
 * 而不是 WorkBuddy 里那份轨迹。所以这里既不动 jsonl，也不写 WorkBuddy 的库
 * （那是它的私有注册表），只在本插件自己的清单里记一行。清单是回收站标签页
 * 的全部数据来源，恢复就是删掉那一行。
 *
 * 清单放在 DSH_HOME 下、与 session-recycle 的回收站清单同级：它描述的是
 * 「这个 DSH 安装里的用户偏好」，不是某个项目或某次导入的中间产物。
 *
 * 每行都顺手记下标题与目录：候选文件可能随后被 WorkBuddy 自己删掉（或导入
 * 模式接管走），那时 `/sessions` 再也扫不到它，回收站里就会剩一个光秃秃的
 * uuid——一个没法判断该不该恢复的行，等于没有回收站。
 */

import fs from 'node:fs'
import path from 'node:path'

import { dshHome } from './util.mjs'

/** 清单文件名（放在 DSH_HOME 根下）。 */
export const HIDDEN_FILE = 'import-workbuddy-hidden.json'

/** 清单最多保留多少行；超出时丢弃最旧的。 */
const MAX_ENTRIES = 2000

export function hiddenPath() {
  return path.join(dshHome(), HIDDEN_FILE)
}

/**
 * 读清单。
 *
 * 任何异常都退化成空清单：文件不存在是常态（没人软删过任何东西），损坏的
 * 文件也只该让回收站看起来是空的，不该让整个导入页打不开。
 *
 * @returns {{ id: string, title: string, cwd: string, projectDir: string, at: number }[]}
 */
export function readHidden() {
  try {
    const parsed = JSON.parse(fs.readFileSync(hiddenPath(), 'utf8'))
    if (!Array.isArray(parsed?.entries)) return []
    return parsed.entries.filter(entry => entry && typeof entry.id === 'string')
  } catch {
    return []
  }
}

/** 清单里的 id 集合，给列举去重/打标用。 */
export function hiddenIds() {
  return new Set(readHidden().map(entry => entry.id))
}

/**
 * 串行化的读-改-写。
 *
 * 每次更新都是「读整份 → 改 → 覆盖」，两次重叠的调用会读到同一份旧内容，
 * 后写的那个把先写的整条丢掉。所以读必须发生在链**里面**，写用临时文件 +
 * rename 原子替换；临时名带 pid 与计数器，两次写不可能撞同一个路径。
 */
let writeChain = Promise.resolve()
let writeSeq = 0

export function mutateHidden(mutate) {
  const job = writeChain.then(() => {
    try {
      const next = mutate(readHidden())
      const file = hiddenPath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeSeq += 1
      const tmp = `${file}.${process.pid}.${writeSeq}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify({ entries: next }, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch {
      // 一次失败不能把后面所有更新堵在链上。
      return false
    }
  })
  writeChain = job.catch(() => {})
  return job
}

/**
 * 把若干候选划进回收站，最新在前。
 *
 * @param {{ id: string, title?: string, cwd?: string, projectDir?: string }[]} rows
 * @returns whether the manifest was replaced
 */
export function hideCandidates(rows) {
  const entries = []
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) continue
    entries.push({
      id: row.id,
      title: typeof row.title === 'string' ? row.title : '',
      cwd: typeof row.cwd === 'string' ? row.cwd : '',
      projectDir: typeof row.projectDir === 'string' ? row.projectDir : '',
      at: Date.now(),
    })
  }
  if (entries.length === 0) return Promise.resolve(false)
  const wanted = new Set(entries.map(entry => entry.id))
  return mutateHidden(current => [
    ...entries,
    ...current.filter(entry => !wanted.has(entry.id)),
  ].slice(0, MAX_ENTRIES))
}

/** 从回收站取回若干条（清单里删掉即恢复）。 */
export function unhideCandidates(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.length > 0))
  if (wanted.size === 0) return Promise.resolve(false)
  return mutateHidden(current => current.filter(entry => !wanted.has(entry.id)))
}
