/**
 * 把导入的会话挂进 DSH 的工作区分组。
 *
 * 为什么单靠 `writeSession` 不够：DSH 的分组不是由会话文件躺在哪个目录决定的，
 * 而是由一份独立的注册表 `storages/workspace.json` 决定——
 *   workspaces[<id>] = { path, title, sessionIds: [...] }
 * 只有出现在某个 workspace 的 sessionIds 里的会话才显示在那个分组下，其余
 * 一律落到「未分组」。所以导入写盘之后必须再挂一次，否则每一次导入都默认
 * 落进未分组——用户看见的就是「分组没了」。
 *
 * 分组名（title）由注册表自己从 path 推导（`defaultWorkspaceTitle`，即目录
 * 名），与 WorkBuddy 里按项目文件夹分组是同一套名字，不需要我们命名。
 *
 * 走 `workspaceRegistry` 而不是直接写域表：`WorkspaceEntity.attachSession`
 * 在同一笔写入里做完校验 + 变更通知，直接 `table.put()` 则绕过通知，客户端
 * 的侧边栏会一直显示旧分组直到重启。
 *
 * 校验很严（这是好事）：会话 header 的 cwd 必须 realpath 后**等于**工作区
 * path，且该目录必须真实存在。所以 cwd 已被删掉的（WorkBuddy 项目目录被清理
 * 过的）挂不上——那种情况如实报失败，不假装成功。
 */

/**
 * 已经在某个分组里的会话 id。
 *
 * `WorkspaceEntity.sessionIds` 这个 getter 会把 cwd 与工作区 path 不符的 id
 * 过滤掉，所以它给出的就是侧边栏真正会显示在那组里的集合。
 *
 * @param {object} registry workspaceRegistry 服务（可能缺席）
 * @returns {Set<string>}
 */
export function groupedSessionIds(registry) {
  const out = new Set()
  if (!registry || typeof registry.list !== 'function') return out
  try {
    for (const view of registry.list()) {
      const ids = Array.isArray(view?.sessionIds) ? view.sessionIds : []
      for (const id of ids) out.add(String(id))
    }
  } catch { /* 注册表没起来：当作谁都没分组，列表照常可用 */ }
  return out
}

/**
 * 把一批会话按 cwd 挂进各自的工作区。
 *
 * 空闲目录不建：`create` 需要目录真实存在，而「导入一个早已被删掉的项目」
 * 不该顺手在磁盘上造一个空文件夹出来。这类会话留在未分组，如实报出来。
 *
 * @param {object} registry workspaceRegistry 服务（可能缺席 → 返回空结果）
 * @param {{ id: string, cwd?: string }[]} entries
 * @returns {Promise<{ grouped: {id: string, workspaceTitle: string}[], failed: {id: string, error: string}[] }>}
 */
export async function attachSessionsToWorkspaces(registry, entries) {
  const grouped = []
  const failed = []
  if (!registry || typeof registry.create !== 'function' || typeof registry.list !== 'function') {
    return { grouped, failed }
  }

  // 同一个 cwd 的会话共用一次 create：`create` 本身幂等（同 path 返回已有
  // 实体），但每次都要走一遍 realpath + 域写入队列，没必要的重复。
  const byCwd = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : ''
    if (cwd.length === 0) {
      failed.push({ id: entry.id, error: '会话没有记录工作目录，无法确定分组' })
      continue
    }
    const key = cwd.toLowerCase()
    if (!byCwd.has(key)) byCwd.set(key, { cwd, ids: [] })
    byCwd.get(key).ids.push(entry.id)
  }

  for (const { cwd, ids } of byCwd.values()) {
    let workspace
    try {
      workspace = await registry.create(cwd)
    } catch (error) {
      const message = error?.message ?? String(error)
      for (const id of ids) failed.push({ id, error: message })
      continue
    }
    if (workspace === undefined || workspace === null) {
      for (const id of ids) failed.push({ id, error: `无法为 ${cwd} 建立分组` })
      continue
    }
    let title = ''
    try { title = typeof workspace.title === 'string' ? workspace.title : '' } catch { /* 名字只是展示 */ }
    for (const id of ids) {
      try {
        await workspace.attachSession(id)
        grouped.push({ id, workspaceTitle: title })
      } catch (error) {
        failed.push({ id, error: error?.message ?? String(error) })
      }
    }
  }
  return { grouped, failed }
}
