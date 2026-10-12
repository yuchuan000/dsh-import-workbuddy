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

3. 先列出清单，不要写入。运行：
   node import.mjs --list
   把每个会话的 id、消息数、原目录整理成一张表念给我听。

4. 【重要】等我从表里挑完要导入的会话，把挑中的 id 告诉我，
   你再用 --only 精确导入，例如：
     node import.mjs --only wb-aaaa,wb-bbbb        # 先预览
     node import.mjs --only wb-aaaa,wb-bbbb --apply # 确认后写入
   ⚠️ 不要用 --all，也不要自己替我决定导哪些 —— 我之前删过一些会话，
   全量导入会把我不想留的又导回来。只导我点名的那几个。

5. 把会话归入工作区分组（这一步不能省，否则全挤在「未分组」）：
   注意 attach-workspaces.mjs 必须能解析 @deepseek-ai/* 依赖，
   所以要在 DSH 的应用安装目录里运行，而不是在本仓库目录里。
   先找到 DSH 安装目录（里面有 node_modules/@deepseek-ai 的那个文件夹），
   把 attach-workspaces.mjs 复制进去，然后：
     node attach-workspaces.mjs --only=wb-aaaa,wb-bbbb         # 先预览
     node attach-workspaces.mjs --apply --only=wb-aaaa,wb-bbbb # 确认后写入
   同样只处理我点名的那几个。原项目文件夹已被删除、因而无法归组的会话，
   先列给我看，不要擅自删、也不要擅自建目录。

6. 告诉我如何重启 DSH（dsh web 或桌面端），以及重启后该刷新页面。

全程不要修改我的 WorkBuddy 原始数据，只读不写。遇到任何一步失败就停下来问我。
```

**完成。** 重启 DSH 并刷新页面后，会话列表里就会出现这些会话，
按它们原本所在的项目目录分组。

---

## 图形界面：在 DSH 设置里导入 ⭐️

装成 DSH 插件后，本项目会在 **DSH 设置 → WorkBuddy 导入** 里加一页可视化面板，
不用敲命令行。页面是一条**标签条**加一张列表：**待导入**、**已导入**，
再右边是**回收站**，各自带着条数；右上角是**配置**按钮。

栏的说明不挂在标签上，而在正文区第一行：一个小标题 **帮助**，后面跟个 **?**，
悬浮展开**当前这一栏**的说明 —— 页内不再摆解释文字。挂在标签上的话，标签条始终
显示全部三个标签，气泡就会去解释一个还没打开的栏。

设置导航里这一行**不再是齿轮**。外壳按分区 id 配图标，认不出的 id 一律回落到齿轮 ——  
也就是**通用设置**那一枚，两行于是看起来是同一件事。而 `settings.section` 槽位不接受  
图标（外壳自己的注释：「kept local until the upstream slot accepts icons」），所以图标由  
插件在 DOM 层自己换：把齿轮隐藏，用 **mask** 画一个**箭头进门**（导入的方向：  
WorkBuddy → DSH），涂色用 `currentColor`，明暗主题、悬停与选中态都自动跟随。  
图形特意**不是**「箭头入盒」—— 那是旁边**归档会话**那一行的图标，16px 下两者会被  
看成同一个图形。

```
[待导入 42] [已导入 7] [回收站 2]                          [配置]
帮助 ?
导入方式：拷贝（保留原会话）｜工具调用：保留
[筛选（标题/目录/id）                                      ]
☑ 全选  [刷新列表]                              已选 2 条 [导入所选（2）]
┌──────────────────────────────────────────────┐
│ D:\proj\a                                           12 │
│ ☑ 修一个导入 bug                              │
│   D:\proj\a · 2025/10/9 16:53 · 12 条消息      │
│ D:\proj\b                                            3 │
│ ☐ 重构结算模块                                │
│   D:\proj\b · 2025/10/8 11:02 · 8 条消息       │
└──────────────────────────────────────────────┘
共 42 个会话   第 1/1 页                                  每页 [50 ▾]
```

**工具栏是两行**：**筛选框独占第一行**（整行宽），操作按钮在第二行，由**全选框**打头，
贴在最左边 —— 和每一行自己的复选框在同一列上，所以「勾一行」和「勾全部」是同一个
动作的两种粒度。

- **列出**本机全部 WorkBuddy 会话（标题、工作目录、**最后活动时间**、消息数），
  **分页**显示，每页 20 / 50 / 100 / 200 可选（默认 50，记在本机）
- **勾选**要导入的内容，支持按标题 / 目录 / id **筛选**；**全选是全量**：勾上那个框，
  整个筛选结果一起被勾上，翻到第 2 页那些行同样在勾选里。想只导一部分就用筛选
  缩小范围 —— 筛选是什么，全选就是什么。翻页/切栏时已勾的保留，工具栏一直显示
  「已选 N 条」
- **时间列是最后活动时间**（最后一条消息），**不是创建时间**，并且**最新的排在最
  上面**。一个 8 月开的、一直聊到今天的会话，按创建时间会被压到列表底下 —— 而它
  恰恰是最该排在前面的那一批。读不出时间的行一律沉到最后，不会当成 `0` 混进最旧的
  一批里（那是拿一个不知道的值冒充一个知道的值）
- **按分组分块**：同一个工作区目录的会话排在一起，块与块之间是一条**小标题**，
  写目录名和这一组有几条（`D:\proj\a 12`）。块内是最新在最上，**块与块之间也按
  块内最新的那条活动排** —— 昨天还在用的项目整体排在最上面，上次动它是六月的
  那个沉下去。代价是块的位置会随会话更新而变动，不再固定按目录名字母序。
  路径读不出来的会话排在最后，挂在「未分组」下；每一页顶部都会重新给出分组名，
  翻到组中间也不会不知道自己在哪一栏
- **已导入的那一栏**里是已经在 DSH 里的会话，导入时自动跳过（幂等）；这些行仍然
  可以勾选，因为它们是**回写**与**还原**的目标
- **回收站那一栏**是这一页自己软删除掉的行（在待导入栏勾上几行点「删除所选」）。
  软删除只写本插件自己的清单（`$DSH_HOME/import-workbuddy-hidden.json`），
  **不动 WorkBuddy 的任何东西** —— 它的数据库、轨迹文件一个字节都不改，
  想删的会话随时能从这里「恢复所选」放回列表
- 导入完自动刷新侧边栏会话列表，并弹出结果横幅（新导入 / 已存在 / 空 / 失败）

### 三种归属方式

**配置**按钮里有个下拉，决定「导入」这个动作到底意味着什么。默认 **copy**，也就是
这个插件一直以来的行为。里面还有**丢弃工具调用**（只留对话文本）与**工具调用转
纯文本**两个选项，以及当前读取的 WorkBuddy 目录。

弹窗里每一行只有**标题 + 控件**，三种方式各自的代价、两个选项各自的后果都挂在
标题右侧的 **?** 上，悬浮（或键盘聚焦）展开，分点写、带背景色和阴影；弹窗自己那句
「这里的改动立即生效」也收进了标题下方那一行的 **?** 里。气泡在页面最上方，一律
**向下展开**。

这三种模式里，**接管会搬走源文件**，所以配置弹窗关掉以后，待导入栏会把当前选择
复述一遍（`导入方式：接管（原会话搬过来）｜工具调用：保留`）—— 否则按导入之前
看不到自己选的是哪一种。

| 方式 | WorkBuddy 里的原会话 | DSH 里继续聊的内容 | 可逆 |
|---|---|---|---|
| **拷贝 copy** | 原封不动 | 只留在 DSH，WorkBuddy 看不到 | 无需 |
| **接管 adopt** | 轨迹文件归档到 `~/.dsh/workbuddy-adopted`，注册表打软删除 | DSH 是唯一一份 | ✅ 一键还原 |
| **同步 sync** | 原封不动 | 可以**回写**进去，两边内容一致 | 无需 |

三种方式都会在导入时**刻一条水位线**（`workbuddy-sync.json`，记「已同步到第几条
事件」）。这个值和模式无关地写，所以今天用 copy 导入的会话，下周想切成 sync 也
来得及——回写只处理水位线之后的事件，不会把整段历史重复追加进原文件。

**同步是有损的**，如实说明：DSH 的 reasoning 块不回写（WorkBuddy 的 reasoning 行
带大量 providerData，造不好就是脏数据），只回写正文与工具调用；结构性事件
（turn/start、session/title 等）也不回写。

**接管是可逆的**：归档目录留着原文件，manifest 记着原路径，面板上的「还原到
WorkBuddy」把文件放回去并把 `deleted_at` 清成 NULL。即使源文件已经被搬走、扫描
再也看不到它，设置页仍会把它列出来——否则「可逆」只是句写在文档里的话。

### 为什么能看见「你删过的会话」

WorkBuddy 的删除是**软删除**：只写 `sessions.deleted_at`，jsonl 原封不动留在磁盘
上。只扫文件系统就会把这些会话又列出来导回去。现在设置页读
`~/.workbuddy/workbuddy.db`，把删过的标出来、默认不选——你仍然可以手动勾上，
但那是一个你知道自己在做什么的动作。

页面本身不碰文件系统：所有读写都走 host 半场的同源校验路由
`/__dsh-import-workbuddy/*`，与命令行共用 `lib/import-core.mjs` 同一条管线，
所以界面和终端不会走出两种结果。

### 装成插件

在 DSH profile 目录（`~/.dsh/profiles/desktop/`）里：

```bash
# 1) 依赖指向本地 vendor 副本（避免市场更新覆盖掉你的修改）
npm pkg set dependencies.dsh-import-workbuddy=file:./vendor/dsh-import-workbuddy

# 2) 加进 bundle 列表
npm pkg set 'dsh.profile.bundles[5]=dsh-import-workbuddy'

# 3) 把 src/ lib/ 等文件放到 vendor/dsh-import-workbuddy/ 下，并链接进 node_modules
mklink /J node_modules\dsh-import-workbuddy vendor\dsh-import-workbuddy
```

**重启 DSH** 生效，设置里就会出现「WorkBuddy 导入」这一页。

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
| **导入后无法继续对话** | 源 jsonl 里**没有** `role:"system"` 消息（系统提示词是客户端请求时注入的）。缺了它，上游以业务码 **11128**「首条消息不是系统提示词」拒绝，会话能看不能聊。本项目从 `<system-reminder>` 里还原注入上下文，写成会话开头的 `system/message` 事件 |
| **全量导入复活已删会话** | 早期版本无过滤全量导入，会把用户删过的会话导回来。现在默认**绝不自动全量导入**，见「为什么默认不全部导入」 |

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

### 1. 先看清单

```bash
node import.mjs --list
```

列出所有可导入的会话，带**序号 / id / 消息数 / 原目录**，**不写任何文件**：

```
[workbuddy] 候选 59/59 个会话

   1. wb-3b2d03af-7893-4893-bc8c-bb69f4078676  [7 条]  c:\Users\me\WorkBuddy\2026-08-27-14-22-11
   2. wb-f460cadb-01aa-4bd0-9c91-43ee5ef6be91  [25 条]  c:\Users\me\WorkBuddy\2026-08-27-14-24-19
   3. wb-1277494d-3ba6-4b2c-a191-5e9555cf2b79  [61 条]  c:\Users\me\WorkBuddy\2026-09-04-23-39-07
   ...
```

### 2. 挑你要导入的 ⭐️

**方式 A：交互式勾选（推荐，在终端里跑）**

```bash
node import.mjs --apply
```

不带任何选择参数时，会列出会话让你勾选：

```
可导入的 WorkBuddy 会话：
  [ ]  1. wb-071d093b-...  [16 条]  d:\proj\demo
  [ ]  2. wb-10be499d-...  [147 条]  d:\proj\novel
  [x]  3. wb-1816399f-...  [5 条]   d:\proj\pkg2

输入要导入的序号（如 1 3 5-9）；a=全选 n=全不选 i=反选；回车=确认，q=取消
选择 [已勾选 1/59]:
```

支持的输入：

| 输入 | 含义 |
|---|---|
| `1 3 5-9` | 选中这些序号（空格 / 逗号 / 顿号 / 区间都行，可累加多次） |
| `a` / `all` | 全选 |
| `n` / `none` | 全不选 |
| `i` / `invert` | 反选 |
| 直接回车 | 确认，按当前勾选执行 |
| `q` / `quit` | 取消，什么都不导入 |

**默认全不选** —— 必须显式勾选才会导入。

**方式 B：非交互精确指定（脚本 / 管道里用）**

```bash
node import.mjs --only wb-aaa,wb-bbb              # 只导这两个（先预览）
node import.mjs --only wb-aaa,wb-bbb --apply      # 确认后写入
node import.mjs --all --apply                     # 显式全量导入
node import.mjs --all --exclude wb-ccc --apply    # 全量但排除 ccc
```

> `--only` / `--exclude` 都**可以省略 `wb-` 前缀**，写 `--only aaa,bbb` 也能匹配。

### 3. 导入是幂等的

已导入的会话按稳定 id（`wb-<uuid>`）自动跳过，可以反复运行。

⚠️ **在非终端环境（管道、CI、Agent 的工具调用）里，不给 `--all` 或 `--only` 会直接报错**，
不会静默全量导入。这是刻意的安全默认 —— 见下方「为什么默认不全部导入」。

### 常用筛选

```bash
node import.mjs --list --project novel          # 只看 cwd 含 "novel" 的
node import.mjs --apply --only aaa --limit 10   # 配合各种过滤
node import.mjs --apply --all --since 2026-09-01
node import.mjs --apply --all --no-tools        # 丢弃工具调用，只留对话
node import.mjs --apply --all --tools-as-text   # 工具调用转纯文本
```

---

## ⚠️ 为什么默认不全部导入

这个工具**早期版本默认全量导入**，结果踩了一个真实的坑：

> 用户删掉了若干不想要的导入会话 → 之后重新跑一次全量导入 →
> 那些已删除的会话**又全部回来了**。

原因是导入器只检查「磁盘上有没有这个会话产物」，完全不知道用户删过什么。
DSH 的回收站（`$DSH_HOME/session-recycle-bin.json`）也不足以作为依据 ——
实测发现它**并不记录每一次删除**，靠它过滤会漏。

所以现在的设计是：

- **没有显式选择参数时，绝不自动全量导入**；
- 交互模式**默认全不选**，必须手动勾选；
- 非交互环境必须显式给出 `--all` 或 `--only`；
- 图形界面里删掉的行记在本插件自己的清单
  （`$DSH_HOME/import-workbuddy-hidden.json`），下次打开还在**回收站**那一栏里，
  不会又冒回待导入列表 —— 而 WorkBuddy 的数据库和轨迹文件一个字节都没动过。

宁可多按几个键，也不要替用户决定删掉的东西该不该回来。

### 4. 归入工作区分组 ⚠️ 别漏

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
node attach-workspaces.mjs                              # 预览会分成哪些组
node attach-workspaces.mjs --apply                      # 写入
node attach-workspaces.mjs --apply --only=wb-aaa,wb-bbb # 只归组指定的几个
node attach-workspaces.mjs --apply --exclude=wb-ccc     # 排除指定的

# 原项目文件夹已删除、想建回空目录再归组：
node attach-workspaces.mjs --apply --create-missing-dirs
```

脚本用 DSH 自己的服务（`ctx.workspaceRegistry.create()` + `attachSession()`）完成，
不是手改 JSON。`attachSession` 会校验会话的 `cwd` 与工作区路径一致**且目录真实存在**，
所以路径不能伪造 —— 原文件夹已删除的会话无法自动归组，脚本会列出来让你决定。

### 5. 重启

重启 `dsh web` 或 DSH 桌面端，然后**刷新页面**。旧页面的 RPC 连接在重启后已失效。

---

## 命令行参数

### 会话选择

| 参数 | 说明 |
|---|---|
| *（无）* | 在终端里交互式勾选要导入的会话 |
| `--list` | 只打印候选清单（带序号），不导入 |
| `--only <ids>` | 只导入这些 id（逗号/空格分隔，可省略 `wb-` 前缀） |
| `--exclude <ids>` | 排除这些 id |
| `--all` | 导入全部候选（非交互环境**必须**显式指定） |

### 其他

| 参数 | 说明 |
|---|---|
| `--apply` | 真正写入（默认 dry-run 只预览） |
| `--mode <copy\|adopt\|sync>` | 归属方式，默认 `copy`；见上文「三种归属方式」<br>写错直接报错，不会静默回落 |
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

`--all` 与 `--only` 互斥。环境变量 `WORKBUDDY_HOME` 可覆盖 WorkBuddy 数据根目录，
`DSH_HOME` 可覆盖 DSH 家目录。

### 回写（sync 模式的另一半）

```bash
node sync-back.mjs --list              # 看哪些能回写、各有多少待写内容
node sync-back.mjs --only wb-<uuid>    # 只回写这一个
node sync-back.mjs --all               # 回写全部可同步的
node sync-back.mjs --stamp --all       # 给早先导入的会话补刻水位线
```

设置页上的「回写所选」按钮走 host 的 `/sync` 路由，这里走同一条
`lib/sync-back.mjs`，两种入口结果一致。同样有安全默认：不指定 `--only` 或
`--all` 就不动任何文件。

**`--stamp` 是干什么的**：水位线是回写的前提（没有它就必须拒绝，否则会把整段
历史重复追加进原文件）。这个功能之前导入的会话没有水位线，`--stamp` 把它们
现有内容整体标记为「已同步」——那些内容本来就是从 WorkBuddy 拷过来的，这么标
是准确的。补刻之后这些会话就进入同步模式。

---

## 测试

```bash
node test/run.mjs           # 全部
node test/run.mjs select    # 只跑选择逻辑
node test/run.mjs e2e       # 只跑端到端
```

143 个用例，零测试框架依赖。所有用例都在**临时沙箱**里搭假的 WorkBuddy 源仓库
和假的 `$DSH_HOME`，**绝不触碰你真实的 `~/.dsh` 和 `~/.workbuddy`**。

| 套件 | 用例 | 覆盖 |
|---|---|---|
| `select` | 27 | 选择表达式解析、交互式勾选 |
| `inproc` | 16 | reader → convert → writer 全链路 |
| `host` | 33 | 五条桥接路由（含同源/跨源护栏、三种模式） |
| `client` | 26 | 设置页渲染与交互（自研 90 行 hooks 运行时） |
| `modes` | 39 | copy / adopt / sync 与水位线、归档、回读 |
| `e2e` | 16 | 子进程端到端（环境不允许 fork 时整套跳过） |

覆盖范围：

- 选择表达式解析（序号 / 区间 / 混合 / 倒序区间 / 越界 / 非法输入）
- 交互式勾选（累加选择、全选、反选、取消、非法输入不中断、默认空选）
- `--only` / `--exclude`（含省略 `wb-` 前缀、不存在的 id、保持原顺序）
- 安全默认（非交互不给选择参数必须拒绝且不写任何文件）
- `--list` 只读不写
- `--all` 与 `--only` 互斥
- **system 头**（11128 修复的核心）：第 1 条 surface 事件必须是 `system/message`，
  带 `source.kind=system-prompt`、非空提示词、含注入上下文
- 事件结构合法性（turn/step 配对、seq 连续）
- 产物路径符合 `projectKey` 编码规则
- 重复导入幂等、空会话识别
- **host 路由**：按 id 精确导入、`exclude`、空选择是 no-op、选项真的生效、
  方法不符 405、非 loopback Host / 跨源 Origin / `sec-fetch-site` 403、
  坏 body 与坏选项 400；`deletedInWorkBuddy` / `adopted` / `canSyncBack` 三个
  标记互相独立；接管后仍能在列表里看到（否则还原无从下手）；
  导入时**自动归入工作区分组**（写盘只是半个导入，分组由 workspace 注册表说了算）、
  归组失败逐条报告、目录不在时不建目录只报错；`/regroup` 能补挂历史导入；
  `/hide` + `/unhide` 只动插件自己的清单（WorkBuddy 的库与轨迹文件一个字节不变）
- **归属模式**：`normalizeMode` 未知值回落 copy；copy 不动源文件；adopt 归档
  并软删除、越界拒绝、还原后标记清空；sync 只回写水位线之后的内容、二次回写
  不重复、无水位线拒绝、源文件缺失拒绝
- **多帧 zstd**：10MB 级真实产物的帧切分对齐、追加一帧后仍对齐、回读完整
- **设置页**：标签条待导入 / 已导入 / 回收站三栏各报条数且默认停在待导入、
  三栏各自只列自己那批行、已导入行打标且仍可勾选（回写/还原的目标）、
  导入按钮忽略已导入的、筛选（标题 / 目录 / id）、
  工具栏两行（筛选独占一行、全选在操作行最左）、**全选作用于整个筛选结果**
  （60 条里第 2 页的 10 条同样被勾上）、**按分组分块且小标题写分组名**、
  软删除 → 回收站 → 恢复的往返、导入只发送勾选的 id、配置弹窗里的模式与两个选项
  改完传给 host、页面复述当前方式、接管失败单独提示、
  拉取与导入失败都显示错误且保留选择、导入后刷新侧边栏

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

**默认的 copy 模式只读这些文件，一个字节都不动。** 只有显式选择 **接管 adopt**
才会把文件移到你自己的 `~/.dsh/workbuddy-adopted/`（不是删除，随时可还原），
**同步 sync** 才会往原文件**追加**新内容（不删除、不覆盖已有内容）。

---

## 工作原理

`lib/workbuddy-reader.mjs` 把 JSONL 解析成归一化消息流，三个关键设计：

1. **用户文本提取**：有 `<user_query>` 就取它 → 否则剥掉所有 `<system-reminder>` →
   仍为空就整条丢弃（纯系统注入不算对话）。
2. **cwd 以事件为准**：从每条事件的 `cwd` 字段读取，目录名仅作兜底。
3. **注入上下文提取**：把 `<system-reminder>` 里的 `<user_info>` / `<identity_context>` /
   `<project_context>` 等块按标签去重后保留，作为会话开头的 system 提示词。
   这是让导入的会话**能继续对话**的关键（见上表 11128 那行）。

`function_call_result` 通过 `callId` **回填**到对应的 tool-call 上，
所以导入后轨迹里能看到**真实的工具输出**，而不是占位符。

`lib/convert.mjs` 把消息流折叠成平衡的 DSH 事件日志：可选地在最前面写一个
`system/message`（承载注入上下文），然后每条 user 消息开启一个 turn，
随后的 assistant 消息带递增 step，最后以 `turn/end` 收尾；
工具调用额外产出配对的 `tool/call` + `tool/result` 事件
（轨迹可渲染，且恢复会话时模型请求合法）。

`lib/select.mjs` 负责会话选择：交互式勾选、`--only` / `--exclude` 过滤、
以及"绝不静默全量导入"的安全默认。

`lib/dsh-writer.mjs` 写出 DSH 当前的 **format v4** 产物：
`session.v4.jsonl.zstd`（多个带校验和的独立 zstd 帧）。

---

## 已知限制

- **工具调用的字符级时序没有保留** —— 源文件里就没有这个信息。
  导入的 `stream` 是按块重建的等价序列，语义一致但没有逐字 `dt` 时序。
- **原项目文件夹已删除的会话无法归组** —— DSH 要求工作区目录真实存在。
  可以 `--create-missing-dirs` 建回空目录，或让它们留在「未分组」。
- **system 提示词是尽力还原** —— 源 jsonl 不保存 WorkBuddy 真正的系统提示词，
  本项目从 `<system-reminder>` 注入块还原。如果某个源会话完全没有注入块，
  它就没有 system 头，导入后仍然可能无法继续对话。
- **不做删除检测** —— 导入器不知道你删过什么（DSH 的回收站清单不完整，
  无法作为依据），所以它**不会自动跳过**你删过的会话。想避免复活，
  就用 `--only` 精确点名，或在交互模式里只勾你要的。
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
