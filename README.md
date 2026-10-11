# dsh-import-workbuddy

把 **WorkBuddy**（腾讯 CodeBuddy 桌面端）的本地聊天记录，导入成 **DeepSeek Harness (DSH)** 里
**原生、可继续对话的会话** —— 带完整历史（文本 / 思考 / 工具调用 / 真实工具输出），
会话列表里按**原工作区目录**分组，看起来和 DSH 自己产生的会话完全一样。

> **English**: Import WorkBuddy (Tencent CodeBuddy) chat history into DeepSeek Harness (DSH)
> as native, resumable sessions grouped by their original workspace.

```
WorkBuddy (~/.workbuddy/projects/*.jsonl)
        │
        │  workbuddy-reader.mjs   ← 解析会话 + 剥离 system-reminder
        ▼
   归一化消息流
        │
        │  convert.mjs            ← 折叠成 DSH 事件（turn/step/tool 配对）
        ▼
   DSH 事件日志
        │
        │  dsh-writer.mjs         ← 写出 format v4 产物 session.v4.jsonl.zstd
        ▼
DSH ($DSH_HOME/sessions)  →  重启后出现在会话列表
        │
        │  attach-workspaces.mjs ← 注册工作区并挂载会话
        ▼
   按工作区目录分组 ✓
```

---

## ⚡️ 快速上手：把下面这段话复制给你的 AI Agent

> 你不需要手动敲命令。把下面整段复制给任意一个能读写文件的 AI Agent
> （DSH / Claude Code / Codex / Cursor 等），它会自己完成安装、导入和归组。

```text
请帮我把 WorkBuddy 的聊天记录导入到 DeepSeek Harness (DSH)。按以下步骤做，每步做完告诉我结果：

1. 克隆并进入项目：
   git clone https://github.com/yuchuan000/dsh-import-workbuddy.git
   cd dsh-import-workbuddy

2. 环境检查：确认 node --version >= 22.19（DSH 需要 node:sqlite 和 zstd）。
   我的系统是 [Windows / macOS / Linux]，请按对应方式给命令。

3. 先预览，不要写入。运行：
   node import.mjs
   把「候选 N 个会话」和「待导入」的结果念给我听，确认数量合理再继续。

4. 确认后真正导入：
   node import.mjs --apply
   如果有失败项，把错误原文贴给我。

5. 把会话归入工作区分组（这一步不能省，否则全挤在「未分组」）：
   注意 attach-workspaces.mjs 必须能解析 @deepseek-ai/* 依赖，
   所以要在 DSH 的应用安装目录里运行，而不是在本仓库目录里。
   先找到 DSH 安装目录（里面有 node_modules/@deepseek-ai 的那个文件夹），
   把 attach-workspaces.mjs 复制进去，然后：
     node attach-workspaces.mjs            # 先预览会分成哪些组
     node attach-workspaces.mjs --apply    # 确认后写入
   原项目文件夹已被删除、因而无法归组的会话，先列给我看，不要擅自删。

6. 告诉我如何重启 DSH（dsh web 或桌面端），以及重启后该刷新页面。

全程不要修改我的 WorkBuddy 原始数据，只读不写。遇到任何一步失败就停下来问我。
```

**完成。** 重启 DSH 并刷新页面后，会话列表里就会出现这些会话，
按它们原本所在的项目目录分组。

---

## 它解决什么问题

WorkBuddy 的聊天记录存在本地，但**格式和 DSH 不兼容**，直接拷进去 DSH 读不出来。
更麻烦的是有几个隐蔽的坑，本项目都处理了：

| 坑 | 现象 |
|---|---|
| 用户输入被淹没 | 每条 user 消息前面裹着几 KB 的 `<system-reminder>`（身份文件、项目结构、记忆提醒），真正的话在 `<user_query>` 里 |
| cwd 无法反推 | 目录名 `d-Users-me-proj` 是有损编码，破折号来源不明；真实路径只存在于事件的 `cwd` 字段 |
| 工具调用 id 会重复 | WorkBuddy 重试/并行批次会产生同一 id，DSH 格式要求同一条消息内唯一 |
| DSH 格式版本 | 旧写法产出 format v0，当前 DSH 要求 v4，且文件名必须是 `session.v4.jsonl.zstd` |
| 恢复校验 | `assistant/message` 必须带 `stream` 字段，否则恢复会话时报 `invalid settlement fields` |
| Windows 家目录 | Node 的 `process.env.HOME` 在 Windows 下为空，会扫不到任何会话 |
| 分组不等于目录 | DSH 分组由 `storages/workspace.json` 注册表决定，光放对目录不会自动归组 |

---

## 环境要求

- **Node.js ≥ 22.19**（DSH 自身基线，用到 `node:sqlite` 与 zstd）
- 已安装 **DSH**（`dsh web` 或 DSH 桌面端）
- 本机有 **WorkBuddy** 的会话数据

## 手动安装

```bash
git clone https://github.com/yuchuan000/dsh-import-workbuddy.git
cd dsh-import-workbuddy
```

无需 `npm install` —— 本项目**零运行时依赖**，只用 Node 内置模块。

## 用法

### 1. 预览

```bash
node import.mjs
```

只打印将要导入什么，**不写任何文件**。输出示例：

```
模式: --dry-run（预览）
会话根: /home/me/.dsh/sessions
WorkBuddy 根: /home/me/.workbuddy/projects
[workbuddy] 候选 59/59 个会话
  [待导入] wb-071d093b-...  d:\proj\demo  16 条消息 -> 75 事件
[workbuddy] 结果: 新导入 59，已存在跳过 0，空会话 0，失败 0
```

### 2. 导入

```bash
node import.mjs --apply
```

幂等：已导入的会话按稳定 id（`wb-<uuid>`）自动跳过，可以反复运行。

**常用筛选**：

```bash
node import.mjs --apply --limit 10              # 只导入最近 10 个
node import.mjs --apply --project novel         # 只导入 cwd 含 "novel" 的
node import.mjs --apply --since 2026-09-01      # 只导入该日期之后的
node import.mjs --apply --no-tools              # 丢弃工具调用，只留对话
node import.mjs --apply --tools-as-text         # 工具调用转纯文本（不生成轨迹卡片）
node import.mjs --apply --workbuddy-root "/path/to/.workbuddy/projects"
```

### 3. 归入工作区分组 ⚠️ 别漏

DSH 的**分组不是由会话文件所在目录决定的**，而是由一个独立的持久化注册表
`$DSH_HOME/storages/workspace.json` 决定：

```json
"workspaces": {
  "<id>": { "path": "D:\\proj\\demo", "title": "demo", "sessionIds": ["..."] }
}
```

只有出现在某个 workspace 的 `sessionIds` 里的会话才显示在该分组下，
否则一律落到「**未分组**」。

因为脚本要 import `@deepseek-ai/*`，必须在 **DSH 应用目录**里运行：

```bash
# 1) 找到 DSH 安装目录（含 node_modules/@deepseek-ai 的那个），把脚本拷进去
cp attach-workspaces.mjs "/path/to/dsh-app/"

# 2) 在 DSH 应用目录里运行
cd "/path/to/dsh-app"
node attach-workspaces.mjs            # 预览会分成哪些组
node attach-workspaces.mjs --apply    # 写入

# 原项目文件夹已删除、想建回空目录再归组：
node attach-workspaces.mjs --apply --create-missing-dirs
```

脚本用 DSH 自己的服务（`ctx.workspaceRegistry.create()` + `attachSession()`）完成，
不是手改 JSON。`attachSession` 会校验会话的 `cwd` 与工作区路径一致**且目录真实存在**，
所以路径不能伪造 —— 原文件夹已删除的会话无法自动归组，脚本会列出来让你决定。

### 4. 重启

重启 `dsh web` 或 DSH 桌面端，然后**刷新页面**。旧页面的 RPC 连接在重启后已失效。

---

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--apply` | 真正写入（默认 dry-run 只预览） |
| `--project <substr>` | 只导入 cwd 包含该子串的会话 |
| `--since <iso\|ms>` | 只导入创建时间不早于该值的会话 |
| `--limit <n>` | 最多导入 n 个（按创建时间从新到旧） |
| `--no-tools` | 丢弃工具调用块，只留对话文本 |
| `--tools-as-text` | 工具调用转纯文本（轨迹里不显示工具卡片） |
| `--truncate <n>` | 文本/推理块截断到 n 字符 |
| `--tool-truncate <n>` | 工具调用参数截断到 n 字符（默认 1000） |
| `--preview <n>` | 预览前 n 个事件 |
| `--sessions-root <dir>` | 会话存储根（默认 `$DSH_HOME/sessions`） |
| `--workbuddy-root <dir>` | WorkBuddy 会话根（默认 `~/.workbuddy/projects`） |
| `--title-prefix <str>` | 给标题加前缀（默认无，保持原生外观） |

环境变量 `WORKBUDDY_HOME` 可覆盖 WorkBuddy 数据根目录，`DSH_HOME` 可覆盖 DSH 家目录。

---

## 数据从哪来

WorkBuddy 的会话在：

```
~/.workbuddy/projects/<编码后的-cwd>/<session-uuid>.jsonl
```

每行一个事件：`session-meta` / `message` / `reasoning` / `function_call` /
`function_call_result` / `file-history-snapshot`。

> `~/.workbuddy/sessions/*.json` **不是**聊天记录 —— 那是进程心跳文件
> （记录哪个 pid 在跑 CLI）。真正的对话在 `projects/` 里。

**本项目只读这些文件，从不修改或删除你的 WorkBuddy 原始数据。**

---

## 工作原理

`lib/workbuddy-reader.mjs` 把 JSONL 解析成归一化消息流，两个关键设计：

1. **用户文本提取**：有 `<user_query>` 就取它 → 否则剥掉所有 `<system-reminder>` →
   仍为空就整条丢弃（纯系统注入不算对话）。
2. **cwd 以事件为准**：从每条事件的 `cwd` 字段读取，目录名仅作兜底。

`function_call_result` 通过 `callId` **回填**到对应的 tool-call 上，
所以导入后轨迹里能看到**真实的工具输出**，而不是占位符。

`lib/convert.mjs` 把消息流折叠成平衡的 DSH 事件日志：每条 user 消息开启一个
turn，随后的 assistant 消息带递增 step，最后以 `turn/end` 收尾；
工具调用额外产出配对的 `tool/call` + `tool/result` 事件
（轨迹可渲染，且恢复会话时模型请求合法）。

`lib/dsh-writer.mjs` 写出 DSH 当前的 **format v4** 产物：
`session.v4.jsonl.zstd`（多个带校验和的独立 zstd 帧）。

---

## 已知限制

- **工具调用的字符级时序没有保留** —— 源文件里就没有这个信息。
  导入的 `stream` 是按块重建的等价序列，语义一致但没有逐字 `dt` 时序。
- **原项目文件夹已删除的会话无法归组** —— DSH 要求工作区目录真实存在。
  可以 `--create-missing-dirs` 建回空目录，或让它们留在「未分组」。
- **只支持 WorkBuddy / CodeBuddy**。其他工具请用
  [dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents)
  （pi / opencode / codex / claude-code）。

## 兼容性

在 **DSH `0.2.0-rc.2`**（session format v4）上开发并验证。DSH 若变更格式版本，
`lib/dsh-writer.mjs` 里的 `CURRENT_FORMAT_VERSION` 与产物文件名需要同步更新。

## 致谢

架构（reader / convert / writer 分层）来自
[dsh-import-agents](https://github.com/Chang-Tong/dsh-import-agents)（MIT）。
本项目的 WorkBuddy reader 与 format-v4 writer 修复为原创贡献。

## License

[MIT](LICENSE)
