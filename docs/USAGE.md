# dsh-bug-reporter 使用文档

> 本文是 [README.md](../README.md) 的详细展开版。文中每个事实都取自源码并标注 `文件:行号`，
> 行号基线：`index.js` **2021 行**、`client.js` **1133 行**、`package.json` 35 行、
> `cordis.patch.yml` 42 行、`locale/zh.json` 36 行（2026-10-18 当前版本）。
> 未做真机联调的部分统一收在[第 12 节「未验证项」](#12-未验证项实测缺口)，正文只写能在源码里指到行号的事实。

---

## 目录

| # | 部分 |
|---|---|
| 1 | [这是什么 / 解决什么问题](#1-这是什么--解决什么问题) |
| 2 | [安装](#2-安装) |
| 3 | [设置页逐项说明](#3-设置页逐项说明) |
| 4 | [四条链路怎么工作](#4-四条链路怎么工作) |
| 5 | [数据文件](#5-数据文件) |
| 6 | [配置项全表（15 个键）](#6-配置项全表15-个键) |
| 7 | [HTTP 接口全表](#7-http-接口全表) |
| 8 | [安全模型](#8-安全模型) |
| 9 | [排错](#9-排错) |
| 10 | [卸载](#10-卸载) |
| 11 | [开发 / 结构说明](#11-开发--结构说明) |
| 12 | [未验证项（实测缺口）](#12-未验证项实测缺口) |

---

## 1. 这是什么 / 解决什么问题

**一句话：在 DSH 跑出 bug 的那一刻把错误抓下来，在设置页里一键写文件修复并热重载生效，再提交成 GitHub PR；
同时实时巡检插件有没有新版本。**

出问题的那一刻信息最全，但也是最不想整理的时刻。这个插件在错误发生的当时就把
message / stack / 归属插件 / 会话 / turn / step 存下来，并把重复出现的同一个错误归并成一条（带出现次数），
于是「报告」这件事变成点一下按钮（`index.js:1-6`）。

对应用户的四条要求：

| 要求 | 落地方式 | 主要位置 |
|---|---|---|
| 实时抓 bug | 挂 DSH 的 5 类真实事件 + process 级异常 | `index.js:1756-1868` |
| 实时维修 | `POST /repair` 原子写源码 → `clientModules.rebuilt()` 触发热重载 | `index.js:1362-1447` |
| 提交 PR | `POST /submit` 走 GitHub REST 建分支 / 放文件 / 开 PR | `index.js:1450-1540` |
| 实时更新新版本 | 挂载 3 秒后首次巡检，之后按 `updateCheckMs` 轮询 | `index.js:128, 1949-1972` |

插件由两个半区组成：

| 半区 | 文件 | 职责 | 行数 |
|---|---|---|---|
| 宿主半区 | `index.js` | 捕获、存储、路径围栏、GitHub 调用、版本巡检、HTTP 路由 | 2021 |
| 浏览器半区 | `client.js` | 在「设置 → 侧边栏」注册一页（slot `settings.section`，id `bug-reporter`，排序位 `order: 40` 写死在这里、不是配置项），只做读写与渲染 | 1133 |

两者之间唯一通道是 HTTP 前缀 `/bug-reporter`（`index.js:26`、`client.js:29-40`）。
包元数据：`dsh-bundle` 补丁 + `dsh.client`（`platform: 'web'`、`immediately: true`、`inject: []`），
版本 `0.1.0`、`private: true`（`package.json:3-4`），`dsh` 块见 `package.json:25-34`。

---

## 2. 安装

### 2.1 安装命令

```
plugin_manager install_bundle target=D:\ai aegit\deepseek\dsh-bug-reporter
```

宿主行由 `cordis.patch.yml` 的 `insert` 提供（`cordis.patch.yml:41-44`，`id: bug-reporter`、
`name: 'dsh-bug-reporter'`、`config: {}`），浏览器半区由 `package.json` 的 `dsh.client` 声明加载
（`package.json:29-33`）。

### 2.2 ⚠️ 装完必须重启一次 DSH 宿主

**实测结论：装完要重启一次 DSH 宿主进程，设置面板左侧才会出现「Bug 报告」那一页。只刷新浏览器页面不够。**

原因是宿主对 `dsh.client` 的扫描是**增量**的，而「这个包不是客户端包」这个**否定结论会缓存到进程重启**
（`cordis.patch.yml:37-39` 原文：「这一行**热装**进正在运行的宿主时，浏览器半区可能进不了 boot graph
（宿主对 `dsh.client` 的扫描是增量的，否定结论缓存到进程重启）。装完重启一次 DSH 宿主即可。」）。

重启后确认：

1. 打开 DSH Web GUI；
2. 进入**设置**；
3. 左侧导航应出现 **Bug 报告**（英文界面 `Bug reports`，`client.js:49, 138`）。

> 该页面能否真的在真宿主里出现，本机尚未验证（插件未安装），见[第 12 节](#12-未验证项实测缺口)。

### 2.3 安装前检查

| 检查项 | 位置 | 期望值 |
|---|---|---|
| bundle 补丁声明 | `package.json:26-28` | `dsh.bundle.patch = ./cordis.patch.yml` |
| 客户端半区声明 | `package.json:29-33` | `platform: web`、`immediately: true`、`inject: []` |
| 宿主行 id | `cordis.patch.yml:40-42` | `id: bug-reporter`、`config: {}` |
| 已装 bundle 列表 | `plugin_manager` 的 `list_bundles` | 能看到本 bundle |
| 报告文件目录可写 | `index.js:326-331`（`mkdirSync` + `renameSync`） | `$DSH_HOME` 可写 |

---

## 3. 设置页逐项说明

页面文案自带字典，**不走客户端 locale 服务**（`client.js:42-46`：那个 `bind()` 的返回签名没有实测过）；
语言按 `navigator.language` 是否以 `zh` 开头选择，缺键回落中文（`client.js:257-268`）。
主题色一律用 `TOKEN` 里已核实的 `--dsw-alias-*` token（`client.js:270-283`）。

页面从上到下的区域顺序（`client.js:741-1213`）：

### 3.1 头部

| 元素 | 说明 | 行号 |
|---|---|---|
| 一行说明文字 | 「运行时捕获的错误会出现在这里。可以写文件修复（宿主热重载生效），也可以直接提交成 GitHub PR。」 | `client.js:50, 709` |
| 未处理徽章 | `未处理 N 条`，N = `status === 'open'` 的报告数；有未处理时黄色，否则灰色 | `client.js:701, 710` |

### 3.2 总开关与捕获开关区（改动**立刻**保存）

**最上面是「总开关」**（`client.js:757-782`），单独一张卡片：

| 元素 | 说明 | 行号 |
|---|---|---|
| 标题 + 两态徽章 | 「总开关」+ **已开启**（绿，`--dsw-alias-state-success-primary`）/ **已关闭**（灰，`--dsw-alias-state-idle-primary`） | `client.js:54-56, 771-772` |
| 说明文字 | 开启时「正在记录新的 bug 报告。」；关闭时「已停止记录新的 bug 报告。设置页与已有报告照常可用；重新打开会立刻恢复记录。」 | `client.js:57-58, 775` |
| 持久化说明 | 「界面里的改动会自动保存，重启 DSH 后仍然生效（优先于 `cordis.patch.yml`）。」 | `client.js:63, 777` |
| 按钮 | 开启时显示「关闭」、关闭时显示「开启」（此时是主色按钮）；`onClick` → `changeSetting({ enabled: !masterOn }, true)`，立即保存 | `client.js:59-60, 778-782` |

> 总开关关掉的是**记录新报告**：所有捕获点直接返回（`capture()` 首行判断），process 监听器被摘掉。
> 它**不是**「卸载插件」——`config.enabled: false` 才是整行不挂载；HTTP 路由不受它影响，
> 所以关掉之后设置页仍然打得开（这是有意的：否则关掉就再也开不回来了）。

下面是**三个子开关**（`client.js:787-816`），勾选态 = `data[field] !== false`（`client.js:808`），
`onChange` 直接 `changeSetting({ [field]: data[field] === false }, true)` —— 第二个参数 `true`
表示立即发请求，不走防抖（`client.js:811, 560-584`）：

| 开关 | 界面文字 | 关掉之后的后果 | 行号 |
|---|---|---|---|
| `captureTools` | 记录工具执行失败 | `tools/result` 里 `isError` 的工具失败不再记 | `index.js:1804` |
| `captureProcess` | 监听未捕获异常 / 未处理 Promise | 摘掉 `uncaughtException` / `unhandledRejection` 监听器 | `index.js:1872, 1875-1881` |
| `repairEnabled` | 允许写文件修复（热重载） | `POST /repair` 一律 `403 repair-disabled` | `index.js:1363-1365` |

**总开关关掉时这三个一起置灰**（`disabled: busy !== '' || !masterOn`，`client.js:810`），
卡片底部有一行「跟随总开关：总开关关掉后这三项不再生效。」（`client.js:810-815`）。
置灰**不清值**：勾选状态照原样留着，总开关开回来立刻恢复原来的行为。

> **改动会写盘（task-19 改）**：这些开关和下面所有界面设置都会**原子写**进设置文件
> （默认 `$DSH_HOME/bug-reporter-settings.json`，见 6 节的 `settingsPath`），
> **重启宿主后仍然生效，并且优先于 `cordis.patch.yml`**。
> 只有「界面能改的键」进这个文件：`enabled` / `captureTools` / `captureProcess` / `repairEnabled` /
> `repo` / `tokenRef` / `baseBranch` / `ignoredUpdates`；
> 界面改不了的键（`repairRoots` / `storePath` / `maxReports` / `updateCheckMs` / `autoUpdate` /
> `updatePolicy` / `settingsPath`）**永远以 yml 为准**，不会被文件盖掉（`index.js:120-130`）。
> 想丢掉界面上的改动、回到 yml，用 3.3 的「恢复默认」。

### 3.3 设置区（文本框走 400ms 防抖）

| 元素 | 行为 | 行号 |
|---|---|---|
| 目标仓库（owner/name） | 文本框，占位符 `例如 zuaonew-ops/dsh-bug-reporter`；改动防抖 400ms 后 `POST /state` | `client.js:58-59, 751-761` |
| 凭据名（GitHub token） | 文本框，占位符 `GITHUB_TOKEN`；防抖保存 | `client.js:60, 763-773` |
| 凭据状态徽章 | 绿色「已配置凭据」/ 黄色「未配置凭据」；未配置时附一行「在宿主的凭据配置里补一条同名凭据即可。」 | `client.js:63-65, 775-783` |
| 基分支 | 文本框，占位符 `留空用目标仓库默认分支`；防抖保存 | `client.js:61-62, 785-795` |
| 报告存储文件 | 只读一行 `报告存储文件: <绝对路径>`，路径来自 GET 响应的 `storeFile` | `client.js:66, 874-877` |
| 恢复默认 | 「恢复默认」按钮（`client.js:884-891`）+ 说明「清空界面保存的设置，回到 `cordis.patch.yml` 的值。只重置设置，不删除任何报告。」；点了先出确认条（`client.js:894-905`）：`确定恢复默认设置？…报告不会被删除。` + 「确定恢复默认」（红色）/「取消」 | `client.js:64-66, 884-905` |

「恢复默认」调 `POST /bug-reporter/settings/reset`（`client.js:41`；前端入口 `actResetSettings` 在 `client.js:653-659`）：
宿主删掉设置文件、
把内存设置还原成 yml 的值，然后回整份 `/state`（界面随之刷新）。**报告一条都不动** ——
报告在另一个文件里，由 store 自己管（`resetSettings` 只碰设置，`index.js:2026-2043`）。

`tokenConfigured` 是宿主每次响应时现算的：`credentials.resolve(tokenRef)` 拿到非空 `value` 才算已配置
（`index.js:1395-1400, 1438`）——**token 不缓存**，改了凭据不用重启（`index.js:14`）。

### 3.4 报告列表

| 元素 | 行为 | 行号 |
|---|---|---|
| 「报告列表」标题 + 「全部清空」按钮 | 清空按钮只在 `reports.length > 0` 时渲染 | `client.js:805-813` |
| 清空确认条 | 点「全部清空」不直接删，先弹出确认条：`确定清空全部 N 条报告？此操作不可撤销。` + 「确定清空」（红色）/「取消」 | `client.js:69-71, 815-829` |
| 空态 | 没有报告时显示 `还没抓到 bug —— 出问题时这里会自动出现`（虚线框） | `client.js:72, 831-839` |

### 3.5 单条报告卡片（每个控件点了会怎样）

第一行（`client.js:855-871`）：

| 元素 | 说明 | 行号 |
|---|---|---|
| 级别 | 大写显示 `report.level`，颜色按 `LEVEL_COLOR`：error/fatal 红、warn/warning 黄、info/debug 灰 | `client.js:258-265, 859-864` |
| 来源 | `report.source` 原文 | `client.js:865` |
| 次数 | `出现 N 次` | `client.js:75, 866` |
| 状态徽章 | 未处理（黄）/ 已修复（绿）/ 已忽略（灰） | `client.js:268-272, 867` |
| 时间 | `首次 <本地化时间> · 最近 <本地化时间>`；非法时间原样显示 | `client.js:316-325, 868-870` |

中间几行：

| 元素 | 说明 | 行号 |
|---|---|---|
| message | 原文，保留换行（`white-space: pre-wrap`） | `client.js:874-876` |
| 归属 / 会话 / 指纹 | `归属插件: <pluginId 或 未定位>`、`会话: <sessionId>`（有才显示）、`指纹: <fingerprint>` | `client.js:76-79, 879-885` |
| 修复结果行 | 有 `fix` 时显示绿色 `已修复：<path>，热重载=是/否 rev=<rev 或 —>` | `client.js:104-106, 888-894` |
| PR 链接 | 有 `pr.url` 时显示 `PR #<number> <repo>`，新窗口打开（`target="_blank"` + `rel="noreferrer"`） | `client.js:896-906` |

按钮行（`client.js:908-926`），**只要有操作在进行（`busy !== ''`）就全部禁用**：

| 按钮 | 点了会怎样 | 行号 |
|---|---|---|
| 提交为 PR（主按钮） | `POST /submit`，请求体带 `id`；若界面上的「目标仓库」/「基分支」非空则一并带上 | `client.js:637-648, 910` |
| 修复 | 打开修复面板，并预填路径：`fix.path` → `context.file` → `context.path` → `context.filePath` | `client.js:667-679, 911` |
| 标记已修 | 仅 `status === 'open'` 时显示；`POST /report/update` 置 `fixed` | `client.js:912, 588-594` |
| 忽略 | 仅 `open` 时显示；置 `ignored` | `client.js:913` |
| 重新打开 | 非 `open` 时显示；置 `open` | `client.js:914` |
| ▸ / ▾ | 展开/收起详情（stack + context 的 `<pre>`） | `client.js:915-919, 928-943` |
| ×（红色） | 删除这一条（`POST /report/delete`），无二次确认 | `client.js:920-925, 596-606` |

修复面板（`client.js:945-985`，点「修复」后才出现）：

| 元素 | 说明 | 行号 |
|---|---|---|
| 标题 | `写文件修复：填绝对路径与新内容，保存后宿主热重载` | `client.js:92, 953-955` |
| 文件绝对路径 | 文本框，占位符示例 `D:\ai aegit\deepseek\dsh-bug-reporter\index.js` | `client.js:93-94, 956-966` |
| 新的文件内容 | 多行文本框（`rows: 6`，等宽字体，可纵向拉伸） | `client.js:95-96, 967-979` |
| 写入并热重载（主按钮） | 路径为空 → 状态行显示「请先填文件绝对路径」且不发请求；否则 `POST /repair {id, path, content}` | `client.js:99, 621-634, 980-981` |
| 取消修复 | 收起面板，已填内容丢弃 | `client.js:982` |

### 3.6 可用更新区

| 元素 | 说明 | 行号 |
|---|---|---|
| 标题行 | 「可用更新」+ 上次检查时间（`上次检查：<时间>` 或 `还没检查过`）+「立即检查更新」按钮 | `client.js:1002-1012` |
| 空态 | `没有可用更新` | `client.js:1014-1019` |
| 每条可用更新 | 模块名 / `已装 <版本>` / `→ 最新 <版本>` / 类型徽章（修订=灰、次版本=黄、主版本=红）/「更新」/「忽略」 | `client.js:1021-1050` |
| 「更新」按钮 | `POST /update/apply {moduleName}`，**不受 `autoUpdate` 限制**，但必须是当前巡检出来的可用更新 | `client.js:656-658`；`index.js:1673-1675` |
| 「忽略」按钮 | `POST /update/ignore {moduleName, version}`，把 `模块名@版本` 写进 `ignoredUpdates` | `client.js:661-665` |
| 已忽略的更新 | 单独一区列出，每行一个「取消忽略」按钮（**再发一次同样参数即取消**） | `client.js:1052-1071`；`index.js:1124-1133` |
| 更新记录 | 只显示**最近 5 条**（倒序）：结果（已应用=绿 / 需重启生效=黄 / 失败=红 / 已跳过=灰）+ 模块名 + 版本跨度 + 时间 + detail | `client.js:1073-1093` |

### 3.7 状态行与整页态

| 状态 | 显示 | 行号 |
|---|---|---|
| 首次载入中 | 整页只显示 `载入中…` | `client.js:681-683` |
| 首次载入失败 | 红色 `操作失败: <原因>` + 「重试」按钮 | `client.js:685-698` |
| 操作失败 | 状态行红色 `操作失败: <宿主返回的 message 或 code>` | `client.js:355-358, 1096-1101` |
| 进行中 | 状态行 `保存中… <busy 标签>`（标签形如 `repair:<id>`、`submit:<id>`、`update-apply:<模块名>`） | `client.js:566-585, 1101` |
| 已保存 | 绿色 `已保存` | `client.js:1098-1101` |

请求统一走 `request()`：解包 `{ok, value}` 信封；网络层失败 → `网络请求失败: <原因>`；
响应不是 JSON → `响应不是合法 JSON，HTTP <状态码>`；`ok !== true` → 用宿主的 `error.message` 或 `error.code`
（`request()` 本体在 `client.js:370-388`）。任何异常都被 `runAction` 捕获写进状态行，不会白屏（`client.js:595-614`）。

---

## 4. 四条链路怎么工作

### 4.1 捕获：5 个事件来源 + process 级

所有捕获点都走同一个入口 `capture()`：`enabled !== true` 直接返回；记录抛错只 `logger.warn`，**绝不冒泡**
（`index.js:1738-1747`）。

| # | 来源 | 事件 / 时机 | 记什么 | 开关 | 行号 |
|---|---|---|---|---|---|
| 1 | `agent/error` | 一个 step / turn 出错（**主捕获点**） | `describeError(payload.error)` 的 message + stack；`sessionId = payload.agent.id`；`context = {turn, step}` | `enabled` | `index.js:1759-1774` |
| 2 | `api-session/error` | Agent 在持久 turn 位之外失败 | `(sessionId, message)`；message 为空时写「未知的会话错误」 | `enabled` | `index.js:1777-1786` |
| 3 | `agent-loop/config-start-failed` | 声明式 agent 条目在发布成活的 agent 之前失败 | error 的 message + stack；`sessionId` | `enabled` | `index.js:1789-1800` |
| 4 | `tools/result` | 工具执行失败（`result.isError === true` 才记） | message 形如 `工具 <name> 执行失败：<detail>`；`context = {tool, code, file, arguments}` | `enabled` + `captureTools` | `index.js:1803-1824` |
| 5 | process 级 | `uncaughtException` / `unhandledRejection` | message + stack；`context = {kind}`（`uncaughtException` / `unhandledRejection`） | `enabled` + `captureProcess` | `index.js:1843-1868` |
| — | `hmr/reload` | 热重载发生（**只观察，不产生报告**） | 只往 `reloadEvents` 里塞 `{at, ids}`，最多 50 条 | 无 | `index.js:60, 1826-1835` |
| — | `manual` | `POST /report` 手动补一条 | 由请求体决定 | `enabled` | `index.js:1572-1607` |

- 合法的 `source` 只有 6 个：`agent/error`、`api-session/error`、`agent-loop/config-start-failed`、
  `tools/result`、`process`、`manual`（`index.js:66-73`）。HTTP 层传非法值 → `400 invalid-report`
  （`index.js:1573-1576`）；内部记录时非法值静默归一成 `manual`（`index.js:603`）。
- `context` 超过 4000 字节（`MAX_CONTEXT_BYTES`）时被替换成 `{truncated: true, preview: <前 4000 字>}`，
  循环引用则返回 `null`（`index.js:35, 281-299`）。
- process 级捕获的写法：记录 → `process.removeListener` 摘掉自己 → `setImmediate` 里把**原始值**抛回
  （`index.js:1836-1861`）。这个「不吞掉」是有前提的，见[第 12 节](#12-未验证项实测缺口)。
- `syncProcessHooks()` 按当前设置增删监听器：`enabled && captureProcess` 才挂，否则完全摘除；
  每次 `POST /state` 之后都会重挂一次（`index.js:1863-1875, 1560`）。

### 4.2 存储与指纹去重

- 存储是一份 **JSONL 文件 + 内存表**：内存里**新→旧**（`index.js:529-530`，读完 `reverse()` 见 `554`），
  文件里**旧→新**（`index.js:561-566`）。
- 每次改动都是「改内存 → 写 tmp → rename」的**整文件原子写**，不做 append
  （`index.js:519-523` 的注释解释了原因：追加没法原子更新已有的那条报告）。
- 指纹 `fingerprintOf(message, stack, pluginId)` = `sha256(message + "\0" + basis + "\0" + pluginId)` 的
  前 16 位十六进制（`index.js:264-279`）。`basis` 取 stack 里**前 3 个以 `at ` 开头的帧**（`FINGERPRINT_FRAMES = 3`，
  `index.js:38`）；**一个 `at ` 帧都没有时退化成对整个 stack 文本取哈希**（`index.js:266-270`），
  这样「message 相同但 stack 完全不同」的两条不会被错误合并（`index.js:254-258`）。
- `pluginId` 参与指纹：不同插件里的同名报错不会互相合并（`index.js:258, 584`）。
- `record()`：同指纹 → `count += 1` + 更新 `lastAt`（`index.js:591-596`）；新指纹 → 插到最前面
  （`index.js:614-617`）。超过 `maxReports` 时从尾部（最旧）丢（`index.js:556-559`）。
- 读盘时的容错（`index.js:527-552`）：
  - 空行跳过（`535-536`）；
  - **单行 JSON 解析失败 → 丢弃这一行，继续读后面的**（`537-541`，注释：不让一行脏数据毁掉整份报告表）；
  - `normalizeReport` 返回 `null` 的行丢弃（`543-544`），`message` 为空的行就是这种（`491-492`）；
  - 缺字段补默认值（`495-512`）；
  - 文件读不动且**不是** `ENOENT` → **抛错**（`546-551`），不会用空表盖掉用户数据；
  - 文件不存在（`ENOENT`）→ 空表起步，不报错。

### 4.3 修复与热重载

`POST /repair` 收 `{id, path, content}`（`index.js:1634-1640`），执行顺序：

1. `repairEnabled !== true` → `403 repair-disabled`（`index.js:1356-1358`）；
2. 校验 `id` / `path` / `content`，缺一个 → `400 invalid-request`（`index.js:1362-1364`）；
3. 报告不存在 → `404 not-found`（`index.js:1365-1366`）；
4. 路径围栏（4 道，详见[第 8.5 节](#85-repair-的路径围栏规则)）（`index.js:1370-1418`）；
5. `atomicWrite(real, content)` —— **按 realpath 之后的真实路径写**（`index.js:1420`）；
6. 热重载：`findOwningPackage(real)` 找到归属包，若该包 `package.json` 有 `dsh.client` 且
   `clientModules.rebuilt` 可用，就调 `rebuilt(pkg.name)`；返回字符串才算重载成功，
   `reloaded = true`、`rev = <返回值>`（`index.js:1400, 1424-1435`）；
7. 记 `fix = { path: absolute, appliedAt, reloaded, rev }` —— 注意 `path` 记的是**请求里的词法绝对路径**
   （`resolve(target)` 的结果），不是 `real`（`index.js:1368, 1437`）；
8. 报告置 `fixed` 并保存（`index.js:1438`，`markFixed` 见 `630-637`）。

`findOwningPackage` 从文件所在目录向上找最近的、含非空 `name` 的 `package.json`
（`index.js:671-694`），并据此判断 `hasClient`（`dsh.client` 是否存在，`index.js:683-685`）。

### 4.4 提交 PR

`POST /submit` 收 `{id, repo?, baseBranch?}`（`index.js:1642-1648`）。校验顺序（`index.js:1443-1463`）：

| 顺序 | 条件 | 失败响应 |
|---|---|---|
| 1 | `id` 缺失 | `400 invalid-request` |
| 2 | 报告不存在 | `404 not-found` |
| 3 | token 拿不到 | `401 no-token` |
| 4 | 目标仓库为空 | `400 no-repo` |

- token 来源：`credentials.resolve(tokenRef).value` →（拿不到时）`gh auth token`
  （`index.js:1286-1315`；`gh` 调用超时 10 秒、失败返回 `undefined` 绝不抛，`index.js:158-174`）。
- 目标仓库优先级：请求体 `repo` → 设置里的 `repo` → 报告 `context.repo`（`index.js:1454-1462`）。
- 基分支优先级：请求体 `baseBranch` → 设置里的 `baseBranch` → 仓库默认分支 → 兜底 `main`
  （`index.js:1463, 1476-1481`）。
- 分支名 `branch = bug-report/<指纹前 12 位>`（`index.js:1465`）；PR 标题 `[bug-reporter] <message 首行前 72 字>`
  （`index.js:1466` 的 `firstLine(...)`，首行为空时是 `(空)`，`index.js:301-305`）。

GitHub REST 调用序列（`index.js:1474-1512`）：

| # | 调用 | 用途 | 备注 |
|---|---|---|---|
| 1 | `GET /repos/{repo}` | 取默认分支 | 失败按状态码映射错误 |
| 2 | `GET /repos/{repo}/git/ref/heads/{base}` | 取 base 的 sha | 取不到 sha → `502 github-error`（`1489-1491`） |
| 3 | `POST /repos/{repo}/git/refs` | 建 `refs/heads/<分支>` | **422 = 分支已存在 → 复用，不报错**（`1494-1495`） |
| 4 | `PUT /repos/{repo}/contents/bug-reports/<紧凑时间戳>-<slug>.md` | 写报告 markdown（base64） | 文件名形如 `bug-reports/20261018-114000-xxx.md`（`318-322, 307-316`） |
| 5 | `POST /repos/{repo}/pulls` | 开 PR | 返回 `html_url` / `number` |

请求头固定为 `accept: application/vnd.github+json`、`authorization: Bearer <token>`、
`user-agent: dsh-bug-reporter`、`x-github-api-version: 2022-11-28`（`index.js:761-766`）。

错误映射（`githubFailure`，`index.js:783-791`）：HTTP 401/403 → `401 github-unauthorized`；
404 → `404 repo-not-found`；其余 → `502 github-error`。网络层异常 → `502 github-error`
（`index.js:1513-1516`）。成功后把 `{url, number, repo, branch, at}` 记进报告的 `pr` 字段
（`index.js:1518-1531`）。

PR 正文 = 报告全文（id / fingerprint / source / level / 次数 / 首次 / 最近 / sessionId / pluginId +
message + stack + context）；若这条报告**已经修过**，还会追加「修复」一节，写明 `path` / `appliedAt` /
`reloaded` / `rev`，并声明 `/repair` 做的是**整文件替换**（`index.js:793-839`）。

### 4.5 版本更新

- 首次巡检：挂载后 **3 秒**（`FIRST_UPDATE_CHECK_MS`，`index.js:127, 1949-1956`），
  不等到第一个 `updateCheckMs`（默认 1 小时），否则界面上会长时间显示「还没检查过」（`index.js:122-126`）。
- 之后按 `updateCheckMs` 轮询（`index.js:1958-1964`）；间隔取 `settings.updateCheckMs`，
  非法或 `< 60000` 时回落到默认 1 小时（`index.js:1944-1947`）。
- 巡检流程 `check()`（`index.js:973-1025`）：`pluginManager.listBundles()` → 逐个 `inspect(模块名)`
  → `inspected.status !== 'accepted'` 的跳过（`1006`）→ `compareVersions(latest, installed) <= 0` 的不算更新
  （`1013`）→ 算出 `kind`（`updateKind`，`912-918`）。
- 版本比较是自写的语义化比较：认 `v` 前缀、忽略 `+build`、预发布版正确判低于正式版
  （`parseVersion` `852-865`、`comparePrerelease` `867-892`、`compareVersions` `894-909`）。
- 安装 `applyOne()`（`index.js:1031-1069`）：`pluginManager.installBundle(模块名)`；
  `application` 映射为 `applied` → `applied`、`restart-required` → `restart-required`、
  **其余（含 `overridden` / `failed` / `cancelled`）→ `failed`**（`1048-1054`）；
  装过之后从「可用更新」里移除（`1067`）。
- 自动更新 `autoApply()`（`index.js:1072-1103`）：只有 `settings.autoUpdate === true` 才跑；
  被忽略的、以及 `updatePolicy` 不允许的，只记一条 `skipped` 日志（每种原因只记一次，`skipLogged`）。
- 更新日志最多 100 条（`MAX_UPDATE_LOG`，`index.js:130, 951-954`），界面只显示最近 5 条。
- 忽略名单：`toggleIgnore(模块名, 版本)` 把 `模块名@版本` 加进/移出 `settings.ignoredUpdates`
  （`index.js:1117-1126`）。**这份名单只存在内存里**，重启即失效（`index.js:1730`）。
- 缺 `pluginManager`：`updates` 保持空数组并记一条 warn，其余能力照常（`index.js:976-981`）。
- 缺 `timer`：完全不巡检（`index.js:1943`）。

---

## 5. 数据文件

### 5.1 路径与格式

- 默认 `$DSH_HOME/bug-reports.jsonl`（`STORE_FILE`，`index.js:29`）；路径解析：显式 `storePath` 优先，
  否则 `process.env.DSH_HOME || join(homedir(), '.dsh')` 下的 `bug-reports.jsonl`（`index.js:241-249`）。
  设置页底部会显示实际路径（响应里的 `data.storeFile`，`client.js:874-877`）。
- 格式是 **JSONL**：一行一条 JSON，无 BOM，文件末尾有换行（`persist()`，`index.js:670-674`）。
- 文件里**旧→新**（最早的在第一行），内存里**新→旧**（`createStore` 的 `index.js:635-674`）。

### 5.2 字段表（`normalizeReport`，`index.js:597-620`）

| 字段 | 类型 | 含义 | 默认 / 兜底 |
|---|---|---|---|
| `id` | string | 报告 id | 缺失时 `randomUUID()`（`496`） |
| `fingerprint` | string | 去重指纹（16 位 hex） | 缺失时用 `fingerprintOf(message, stack)` 补（`497-498`） |
| `firstAt` | string(ISO) | 首次出现 | 当前时间（`499`） |
| `lastAt` | string(ISO) | 最近一次出现 | 当前时间（`500`） |
| `count` | number | 出现次数 | 1（`501`） |
| `source` | string | 6 种来源之一 | 非法值 → `manual`（`502`） |
| `level` | string | 级别 | `error`（`503`） |
| `message` | string | 错误文本 | **空 → 整条丢弃**（`491-492`） |
| `stack` | string | 调用栈 | `''`（`493`） |
| `pluginId` | string \| null | 归属插件 | `null`（`506`） |
| `sessionId` | string \| null | 会话 | `null`（`507`） |
| `context` | object \| null | 附加信息（≤4000 字节） | `null`（`508`） |
| `status` | `open` \| `fixed` \| `ignored` | 状态 | 非法值 → `open`（`509`） |
| `fix` | object \| null | `{path, appliedAt, reloaded, rev}` | `null`（`510`，`459-468`） |
| `pr` | object \| null | `{url, number, repo, branch, at}` | `null`（`511`，`470-480`） |

### 5.3 真实 JSON 示例

下面这份是**插件自己的 `persist()` 写出来的真实内容**（本机实测，2026-10-18，
用临时 `storePath` 跑 `POST /report` 与一次成功的 `/repair` 得到；改动只有两处：
临时目录名，以及把 Windows 用户名脱敏成 `<user>`）。磁盘上就是两行 JSONL：

```text
{"id":"6ede9502-8e49-47d8-a55c-12b0a2814b0b","fingerprint":"30ae89dd568df231","firstAt":"2026-10-18T05:10:54.119Z","lastAt":"2026-10-18T05:10:54.119Z","count":1,"source":"manual","level":"error","message":"probe-一条中文报告","stack":"","pluginId":null,"sessionId":null,"context":null,"status":"open","fix":null,"pr":null}
{"id":"6a435c7e-48ba-43f7-bb97-4000e7bdf645","fingerprint":"650c64bbd717fc26","firstAt":"2026-10-18T05:10:54.142Z","lastAt":"2026-10-18T05:10:54.142Z","count":1,"source":"manual","level":"error","message":"probe 围栏用例","stack":"","pluginId":null,"sessionId":null,"context":null,"status":"fixed","fix":{"path":"C:\\Users\\<user>\\AppData\\Local\\Temp\\_br-doc-probe\\repair-root\\ok.js","appliedAt":"2026-10-18T05:10:54.156Z","reloaded":false,"rev":null},"pr":null}
```

第二行美化后（**合法 JSON 对象**，已用 `JSON.parse` 校验）：

```json
{
  "id": "6a435c7e-48ba-43f7-bb97-4000e7bdf645",
  "fingerprint": "650c64bbd717fc26",
  "firstAt": "2026-10-18T05:10:54.142Z",
  "lastAt": "2026-10-18T05:10:54.142Z",
  "count": 1,
  "source": "manual",
  "level": "error",
  "message": "probe 围栏用例",
  "stack": "",
  "pluginId": null,
  "sessionId": null,
  "context": null,
  "status": "fixed",
  "fix": {
    "path": "C:\\Users\\<user>\\AppData\\Local\\Temp\\_br-doc-probe\\repair-root\\ok.js",
    "appliedAt": "2026-10-18T05:10:54.156Z",
    "reloaded": false,
    "rev": null
  },
  "pr": null
}
```

一条由 `agent/error` 事件产生的报告长这样（字段与 `store.record()` 的写入一致，`index.js:1863-1870`；
`stack` 里前 3 个 `at ` 帧参与指纹）：

```json
{
  "id": "0f9d3b21-7c4e-4d6a-9b02-5e17a8c3f410",
  "fingerprint": "b41c9a77e0d5f238",
  "firstAt": "2026-10-18T05:22:10.004Z",
  "lastAt": "2026-10-18T05:22:31.771Z",
  "count": 3,
  "source": "agent/error",
  "level": "error",
  "message": "Cannot read properties of undefined (reading 'id')",
  "stack": "TypeError: Cannot read properties of undefined (reading 'id')\n    at runStep (D:\\ai aegit\\deepseek\\dsh-ops\\lib\\loop.js:88:21)\n    at Agent.tick (D:\\ai aegit\\deepseek\\dsh-ops\\lib\\agent.js:141:9)\n    at listOnTimeout (node:internal/timers:581:17)",
  "pluginId": "dsh-ops",
  "sessionId": "sess-2026-10-18-0522",
  "context": { "turn": 4, "step": 2 },
  "status": "open",
  "fix": null,
  "pr": null
}
```

### 5.4 坏行 / 截断时的恢复行为

| 情况 | 行为 | 行号 |
|---|---|---|
| 某一行 JSON 坏掉（含写一半就被中断的最后一行） | **丢弃这一行**，其余行照常载入 | `index.js:545-549` |
| 某一行 JSON 合法但结构不对（`message` 为空 / 不是对象） | 丢弃这一行 | `index.js:498-499, 550-551` |
| 字段缺失或类型不对 | 按第 5.2 节的兜底补齐，不丢整行 | `index.js:502-519` |
| 文件不存在 | 空表起步，正常写入 | `index.js:553-559` |
| 文件存在但读不动（权限 / 目录占位 / IO 错） | **抛错** `dsh-bug-reporter: 无法读取报告文件 <路径>：<原因>`，不会用空表覆盖 | `index.js:553-558` |
| 写入 | 先写 `<文件>.bug-reporter.tmp` 再 `renameSync`，不会留下半截正式文件 | `index.js:325-331` |

> 手工编辑该文件时的两个注意点：① 行的先后顺序是**旧→新**，别按内存里的顺序理解；
> ② 若某行没有 `fingerprint` 字段，载入时用 `fingerprintOf(message, stack)` 补——这个调用**不带 `pluginId`**，
> 而 `record()` 计算指纹时**带 `pluginId`**（`index.js:597-620` vs `697`），两者对同一条报告可能给出不同指纹。

### 5.5 上限与「什么不在这里」

| 项 | 值 | 行号 |
|---|---|---|
| 报告条数上限 | `maxReports`，默认 500，超了丢最旧 | `index.js:97, 563-566` |
| 单条 `context` JSON 上限 | 4000 字节（超了只留 `{truncated, preview}`） | `index.js:35, 283-300` |
| 热重载观察记录上限 | 50 条（只在内存，不落盘） | `index.js:60, 1830-1831` |
| 更新日志上限 | 100 条（只在内存，不落盘） | `index.js:131, 958-961` |
| **设置不在这个文件里** | 设置写在**另一个文件** `bug-reporter-settings.json` 里（见 5.6），报告文件只存报告 | `index.js:273-283` |

### 5.6 设置文件 `bug-reporter-settings.json`（task-19 新增）

界面里改过的设置要能在重启后活下来，所以单独落一个文件。

| 项 | 说明 | 行号 |
|---|---|---|
| 路径 | 显式 `settingsPath` 优先；留空则**与报告存储同目录**，默认即 `$DSH_HOME/bug-reporter-settings.json` | `index.js:32, 243-259` |
| 写入时机 | 每次设置变更后（`POST /state`、`/update/ignore`、总开关、子开关）**原子写**：先写同目录 `*.bug-reporter.tmp` 再 rename（复用报告那套 `atomicWrite`，没有第二种写法） | `index.js:273-283, 350-356, 2016-2020, 1131-1133` |
| 文件内容 | 只写**界面能改的键**：`enabled` / `captureTools` / `captureProcess` / `repairEnabled` / `repo` / `tokenRef` / `baseBranch` / `ignoredUpdates` | `index.js:120-130, 264-271` |
| 优先级 | 挂载时 `{ ...config, ...文件里的合法值 }` —— **文件优先于 yml**，这就是「记住」的含义 | `index.js:1848-1855` |
| 格式 | 普通 JSON 对象，缩进 2 空格，末尾换行；例：`{"enabled": false, "repo": "owner/name", ...}` | `index.js:276` |

**容错四条**（`loadPersistedSettings`，`index.js:288-333`）：

| 情况 | 行为 |
|---|---|
| 文件不存在（`ENOENT`） | **静默**用 yml 的值，不报错、不 `warn`、不凭空建文件 |
| 坏 JSON | **不崩**，`warn` 一条（含「不是合法 JSON」），退回 yml 的值 |
| 不是对象（数组 / 字符串 / `null`） | **不崩**，`warn` 一条（含「不是对象」），退回 yml 的值 |
| 含未知键（或界面改不了的键） | **直接丢弃，不抛错** —— 注意 `resolveConfig` 对未知键是**抛错**的，所以过滤必须发生在它之前，否则一个手改坏的文件会让整行挂载失败 |
| 键合法但类型不对（如 `{"enabled":"yes"}`） | 丢弃该键（持久化文件是外部输入，不让它绕过 `resolveConfig` 的类型校验） |
| 目录不存在 | 写的时候由 `atomicWrite` 的 `mkdirSync(recursive)` 建出来 |
| 写盘失败（如路径指向一个目录） | 只 `warn`，主流程照常（值仍在内存里生效） |

> 想丢掉这个文件、回到 yml：设置页的「恢复默认」，或直接删掉这个文件。
> 它**只影响设置**，删了不会少一条报告。

---

## 6. 配置项全表（15 个键）

`DEFAULTS`（`index.js:93-109`）的键集合就是「合法 config 键」的唯一定义，共 **15 个**。

| # | 键 | 类型 | 默认 | 边界 / 校验 | 作用 | 行号 |
|---|---|---|---|---|---|---|
| 1 | `enabled` | boolean | `true` | `BOOLEAN_KEYS`：必须 boolean | `false` 则 `apply()` 直接 return，**整行不挂载** | `94, 214-215, 1845` |
| 2 | `storePath` | string | `''` | 必须 string | 报告文件绝对路径；空则 `$DSH_HOME/bug-reports.jsonl`（`resolveStorePath`） | `95, 241-249` |
| 3 | `settingsPath` | string | `''` | 必须 string | 界面设置的持久化文件；空则**与报告同目录**（默认 `$DSH_HOME/bug-reporter-settings.json`） | `96, 250-259` |
| 4 | `repo` | string | `''` | 必须 string | 提交 PR 的目标仓库 `owner/name` | `97, 1569` |
| 5 | `tokenRef` | string | `'GITHUB_TOKEN'` | 必须 string | 去哪个凭据名取 GitHub token | `98, 1400` |
| 6 | `baseBranch` | string | `''` | 必须 string | PR 基分支；空则用目标仓库默认分支 | `99, 1573` |
| 7 | `maxReports` | number | `500` | 有限数字且 **≥ 1** | 最多保留多少条报告 | `100, 217-220, 664-666` |
| 8 | `captureTools` | boolean | `true` | 必须 boolean | 是否把工具执行失败记成报告 | `101, 1921` |
| 9 | `captureProcess` | boolean | `true` | 必须 boolean | 是否监听 `uncaughtException` / `unhandledRejection` | `102, 1988-1996` |
| 10 | `repairEnabled` | boolean | `true` | 必须 boolean | 是否允许 `/repair` 写文件并热重载 | `103, 1466-1467` |
| 11 | `updateCheckMs` | number | `3600000` | 有限数字且 **≥ 60000** | 版本巡检间隔（毫秒） | `104, 221-223, 2096-2097` |
| 12 | `autoUpdate` | boolean | `false` | 必须 boolean | `settings.autoUpdate` 为 `true` 时，巡检（`updateCheckMs`）之后自动 `installBundle`；默认只报告 | `1181` |
| 13 | `updatePolicy` | string | `'minor'` | 只能是 `patch` \| `minor` \| `any`（`UPDATE_POLICIES`） | 自动更新允许的最大跨度 | `106, 133, 228-231, 1191-1200` |
| 14 | `ignoredUpdates` | string[] | `[]` | 必须 `string[]` | 不再提示的版本，元素形如 `dsh-ops@0.3.1` | `107, 224-227, 1071-1101` |
| 15 | `repairRoots` | string[] | `[]` | 必须 `string[]` | `/repair` 允许写的额外根目录（realpath 后判定） | `108, 1503` |

> **行号列是快照**：task-19 只把**动过的区域**（`DEFAULTS`、`resolveConfig`、设置持久化、
> 开关与恢复默认）逐处核对过（开发期脚本 `_doc-lineno-check.mjs`，未随仓库分发）；task-12 / task-15 / task-17
> 留下的历史漂移没有全量重编号。**键名与 `DEFAULTS`（`index.js:93-109`）才是权威定义。**
>
> **`order` 不在上表里**（task-17 已从 `DEFAULTS` / `NUMBER_KEYS` 删除）：它不是配置项，
> 设置面板左侧导航的排序位固定在浏览器半区 `client.js:1232` 注册 `settings.section` 时写的
> `order: 40`。配置里写 `order` 现在会走「未知键抛错并点名」（见 6.1）。

### 6.1 校验规则（fail loud）

| 情况 | 抛出的错误 | 行号 |
|---|---|---|
| `config` 不是映射（数组 / 标量） | `dsh-bug-reporter: config 必须是一个映射（mapping）` | `204-206` |
| **未知键** | `dsh-bug-reporter: 未知的 config 键 "<键名>"（可用：enabled, storePath, settingsPath, repo, tokenRef, baseBranch, maxReports, captureTools, captureProcess, repairEnabled, updateCheckMs, autoUpdate, updatePolicy, ignoredUpdates, repairRoots）` | `209-213` |
| boolean 键类型不对（`BOOLEAN_KEYS`） | `dsh-bug-reporter: config.<键> 必须是 boolean` | `214-215` |
| number 键非有限数字（`Number.isFinite`） | `dsh-bug-reporter: config.<键> 必须是有限数字` | `216-219` |
| `maxReports < 1` | `dsh-bug-reporter: config.maxReports 必须 >= 1` | `220` |
| `updateCheckMs < 60000` | `dsh-bug-reporter: config.updateCheckMs 必须 >= 60000` | `221-223` |
| 数组键不是 `string[]` | `dsh-bug-reporter: config.<键> 必须是 string[]` | `224-227` |
| `updatePolicy` 非法 | `dsh-bug-reporter: config.updatePolicy 必须是 patch \| minor \| any` | `228-231` |
| 其余键不是字符串（`typeof value !== 'string'`） | `dsh-bug-reporter: config.<键> 必须是 string` | `232-233` |

配置错误会让宿主行加载失败（不静默兜底）。

### 6.2 `order` 不是配置项，写它会报「未知键」（task-17 改）

`order` 曾经出现在 `DEFAULTS` 与 `NUMBER_KEYS` 里，所以写它能通过校验，但**全文件没有任何一处读取它** ——
它是一个「被接受但不生效」的死配置。task-17 已把它从这两处删掉。

现在配置里写 `order` 会走**未知键**路径，抛错并点名（`Object.hasOwn(DEFAULTS, key)` 在 `index.js:209-213`）：

```
dsh-bug-reporter: 未知的 config 键 "order"（可用：enabled, storePath, settingsPath, repo,
tokenRef, baseBranch, maxReports, captureTools, captureProcess, repairEnabled, updateCheckMs,
autoUpdate, updatePolicy, ignoredUpdates, repairRoots）
```

设置页左侧的排序位**从来就不是配置项**，它写死在浏览器半区注册 slot 的地方：
`client.js:1232` 的 `order: 40`（`client.js:1229-1234`）。**要改顺序只能改 `client.js:1232`。**

### 6.3 哪些键能在运行时改

`POST /state` 只认 `PATCHABLE` 里的 **7 个键**（`index.js:82-90`）：
`enabled`、`captureTools`、`captureProcess`、`repairEnabled`、`repo`、`tokenRef`、`baseBranch`。
**其余键出现在请求体里会被静默忽略、不报错**（`index.js:81-82` 注释 + `1449-1459` 只遍历 `PATCHABLE`）。
本机实测：`POST /state {"maxReports":3}` → `200`，而 `settings.maxReports` 仍是 `500`。

`ignoredUpdates` 不在 `PATCHABLE` 里，但它由 `/update/ignore` 改，**同样会持久化**（`index.js:1225-1233`）。

### 6.4 profile 覆写示例

本 bundle 的 `cordis.patch.yml` 里 `config: {}` 留空（`cordis.patch.yml:47-50`）。要调参就在 **profile 的
`cordis.patch.yml`** 里覆写同名 id 的行：

```yaml
- id: bug-reporter
  name: 'dsh-bug-reporter'
  config:
    enabled: true
    storePath: ''
    settingsPath: ''
    repo: 'zuaonew-ops/dsh-bug-reporter'
    tokenRef: 'GITHUB_TOKEN'
    baseBranch: ''
    maxReports: 500
    captureTools: true
    captureProcess: true
    repairEnabled: true
    updateCheckMs: 3600000
    autoUpdate: false
    updatePolicy: 'minor'
    ignoredUpdates: []
    repairRoots: []
```

⚠️ patch 是**整行替换 `config`**，所以覆写时要把想保留的字段写全（没写的键会回到默认值）。
界面顺序与 `config` 无关，`order` 也不是配置项（写它会报未知键，见 6.2）。

---

## 7. HTTP 接口全表

### 7.1 路由注册与统一信封

- 宿主用 `webServer.register({ kind: 'prefix', path: '/bug-reporter', handler })` 注册（`index.js:2048`），
  前缀固定 `/bug-reporter`（`index.js:26`），不可配置。
- **所有**请求先进跨站防护（`rejectCrossSite`，`index.js:1658`，见第 8 节），再进路由表。
- 成功：`200 {ok: true, value: {...}}`；失败：`{ok: false, error: {code, message}}`（`sendJson`，`index.js:463-474`）。
- 响应头固定 `content-type: application/json; charset=utf-8`、`cache-control: no-store`、`vary: Origin`
  （`sendJson` 里，`index.js:463-471`）。

### 7.2 12 条路由

| # | 方法 + 路径 | 请求体 | 成功的 `value` | 行号 |
|---|---|---|---|---|
| 1 | `GET /bug-reporter/state` | — | `{enabled, captureTools, captureProcess, repairEnabled, repo, tokenRef, baseBranch, tokenConfigured, storeFile, reports[], updates[], lastUpdateCheckAt, updateLog[]}` | `1661-1665, 1428-1447` |
| 2 | `POST /bug-reporter/state` | 7 个可改键的子集 | 同上（保存后的状态），并**原子写盘** | `1661-1673` |
| 3 | `POST /bug-reporter/settings/reset` | `{}` | 同上（回到 `cordis.patch.yml` 的值，**报告不删**） | `1675-1681` |
| 4 | `POST /bug-reporter/report` | `{message, source?, level?, stack?, pluginId?, sessionId?, context?}` | `{report}` | `1683-1718` |
| 5 | `POST /bug-reporter/report/update` | `{id, status}` | `{report}` | `1720-1732` |
| 6 | `POST /bug-reporter/report/delete` | `{id}` | `{deleted: true}` | `1734-1742` |
| 7 | `POST /bug-reporter/report/clear` | `{}` | `{cleared: <清掉的条数>}` | `1744-1750` |
| 8 | `POST /bug-reporter/repair` | `{id, path, content}` | `{report, fix}` | `1752-1758` |
| 9 | `POST /bug-reporter/submit` | `{id, repo?, baseBranch?}` | `{report, pr}` | `1760-1766` |
| 10 | `POST /bug-reporter/update/check` | `{}` | 整份状态（同 #1） | `1768-1776` |
| 11 | `POST /bug-reporter/update/apply` | `{moduleName}` | 整份状态 | `1778-1799` |
| 12 | `POST /bug-reporter/update/ignore` | `{moduleName, version}` | 整份状态（并写盘） | `1801-1813` |
| — | 其他任何路径 | — | `404 not-found`，message `未知路径 <pathname>` | `1815` |

非 `GET`/`POST` 的方法（含 `OPTIONS`）在命中的路由里一律 `405 method-not-allowed`
（`index.js:1666, 1676, 1684, 1721, 1735, 1745, 1753, 1761, 1769, 1779, 1802`）。

### 7.3 全部错误码

| `code` | HTTP | 触发条件 | 行号 |
|---|---|---|---|
| `bad-url` | 400 | `req.url` 无法解析成 URL | `1649-1653` |
| `cross-site` | 403 | `Sec-Fetch-Site: cross-site` | `1354-1361` |
| `bad-origin` | 403 | `Origin` 存在且与服务端不同源 | `1363-1374` |
| `unsupported-media-type` | 415 | `POST` 的 `content-type` 不是 `application/json` | `1376-1389` |
| `body-too-large` | **413** | 请求体超过 1 MiB | `487-500, 523-534` |
| `bad-body` | 400 | 读请求体本身失败（非超限） | `536-538` |
| `bad-json` | 400 | body 不是合法 JSON，或不是 JSON 对象 | `542-553` |
| `method-not-allowed` | 405 | 命中的路由不支持该方法 | `1666` 等（见 7.2） |
| `invalid-state` | 400 | `POST /state` 的键类型不对 | `1449-1459` |
| `invalid-report` | 400 | `POST /report` 字段非法（message 空 / source 非法 / stack / level / pluginId / sessionId 类型错） | `1689-1706` |
| `invalid-status` | 400 | `status` 不是 `open`/`fixed`/`ignored` | `1726` |
| `invalid-request` | 400 | 缺 `id` / 缺 `path` / 缺 `content` | `1472-1474, 1555, 1724, 1738` |
| `not-found` | 404 | 报告不存在 / 未知路径 | `1476, 1557, 1729, 1739, 1815` |
| `repair-disabled` | 403 | `repairEnabled` 为 `false` 时调 `/repair` | `1466-1468` |
| `path-not-allowed` | 403 | `/repair` 路径围栏拒绝（6 种原因，见 8.5） | `1490-1530` |
| `no-token` | 401 | `credentials.resolve` 与 `gh auth token` 都拿不到 token | `1559-1562` |
| `no-repo` | 400 | 请求体 / 设置 / 报告 context 都没有仓库 | `1570-1572` |
| `github-unauthorized` | 401 | GitHub 返回 401 / 403 | `896` |
| `repo-not-found` | 404 | GitHub 返回 404 | `897` |
| `github-error` | 502 | GitHub 其他状态码 / 拿不到 sha / 网络异常 | `898, 1600, 1625` |
| `missing-param` | 400 | `/update/apply` 缺 `moduleName`；`/update/ignore` 缺 `moduleName` 或 `version` | `1783, 1807-1808` |
| `unknown-module` | 404 | `/update/apply` 的模块不在当前可用更新里 | `1785-1787` |
| `operation-failed` | 502 | `installBundle` 抛错 | `1788-1796` |
| `internal` | 500 | 上面没接住的其他异常 | `1821-1827` |

### 7.4 本机实测输出（真 socket，临时 `storePath`）

下面是我把宿主 handler 挂到真 `http` server 上打出来的（2026-10-18，`http://127.0.0.1:54533`，
临时目录已清理）。所有响应都**没有**任何 `access-control-*` 头：

| 请求 | 实测 |
|---|---|
| `GET /bug-reporter/state`（裸请求，无任何头） | `200`，`vary: Origin` |
| `GET /bug-reporter/nope` | `404` `not-found`，`未知路径 /bug-reporter/nope` |
| `PUT /bug-reporter/state` | `405` `method-not-allowed`，`不支持 PUT` |
| `POST /report/clear` + `Origin: https://evil.example` + `Sec-Fetch-Site: cross-site` + `text/plain` | `403` `cross-site` |
| `POST /report/clear` + `Origin: https://evil.example`（JSON） | `403` `bad-origin`，`拒绝来源 https://evil.example：与本机不同源` |
| `POST /report/clear` + `Sec-Fetch-Site: cross-site`（无 Origin） | `403` `cross-site` |
| `POST /report/clear` + `Origin` 同主机但**端口不同** | `403` `bad-origin` |
| `POST /report/clear` + `Origin: http://127.0.0.1:<同端口>` | `200` `{cleared:0}` |
| `POST /report/clear` + `Origin: http://localhost:<同端口>`（loopback 别名） | `200` `{cleared:0}` |
| `POST /report` + `text/plain`、无 Origin | `415` `unsupported-media-type`，`POST 必须使用 content-type: application/json` |
| `POST /report` 无 `content-type` | `415` `unsupported-media-type` |
| `POST /report` + `application/json; charset=utf-8` | `200`，返回 `{report:{...}}` |
| `OPTIONS /bug-reporter/state`（无 Origin） | `405` `method-not-allowed` |
| `OPTIONS /bug-reporter/state` + `Origin: https://evil.example` | `403` `bad-origin` |
| `POST /report` `message` 为空串 | `400` `invalid-report`，`report.message 必须是非空字符串` |
| `POST /report` `source: "nope"` | `400` `invalid-report`，`report.source 非法："nope"` |
| `POST /state` `{enabled:"yes"}` | `400` `invalid-state`，`state.enabled 必须是 boolean` |
| `POST /state` `{maxReports:3}` | `200`，但 `settings.maxReports` 仍 `500`（不在 `PATCHABLE`） |
| `POST /state` `{repo:"o/r"}` | `200`，`settings.repo` 变为 `o/r` |
| `POST /repair` 报告 id 不存在 | `404` `not-found` |
| `POST /submit` 报告 id 不存在 | `404` `not-found`（**先查报告，再要 token**） |
| `POST /update/apply` `{}` | `400` `missing-param`，`缺少 moduleName` |
| `POST /update/ignore` `{moduleName:"dsh-ops"}` | `400` `missing-param`，`缺少 version` |
| `POST /repair` `package.json`（在允许根内） | `403` `path-not-allowed`，`拒绝写入 package.json：改 manifest 等于换插件` |
| `POST /repair` `evil.exe`（在允许根内） | `403` `path-not-allowed`，只允许白名单扩展名 |
| `POST /repair` 路径含 NUL 字节 | `403` `path-not-allowed`，`拒绝写入：路径含 NUL 字节` |
| `POST /repair` UNC 路径 `\\localhost\C$\...` | `403` `path-not-allowed`，`不接受 UNC 路径` |
| `POST /repair` 允许根之外的路径（报告无 `pluginId`） | `403` `path-not-allowed` |
| `POST /repair` `repairRoots` 内的 `.js` | `200`，文件内容被替换，`fix.reloaded=false`（无 `clientModules`） |
| `POST /state` `{repairEnabled:false}` 之后 `POST /repair` | `403` `repair-disabled` |
| `POST /bug-reporter/settings/reset` | `200`，返回整份状态；设置文件被删掉，值回到 yml，`reports` 条数不变（task-19，实测见 5.6） |

### 7.5 调用示例

curl：

```bash
# 读状态（无需任何头）
curl -s http://127.0.0.1:<端口>/bug-reporter/state

# 手动补一条报告
curl -s -X POST http://127.0.0.1:<端口>/bug-reporter/report \
  -H 'content-type: application/json' \
  --data-binary '{"message":"手动补的一条","source":"manual"}'

# 改设置（只认 7 个键）
curl -s -X POST http://127.0.0.1:<端口>/bug-reporter/state \
  -H 'content-type: application/json' \
  --data-binary '{"repo":"zuaonew-ops/dsh-bug-reporter","captureTools":false}'

# 检查更新 / 装某个包
curl -s -X POST http://127.0.0.1:<端口>/bug-reporter/update/check -H 'content-type: application/json' --data-binary '{}'
curl -s -X POST http://127.0.0.1:<端口>/bug-reporter/update/apply -H 'content-type: application/json' --data-binary '{"moduleName":"dsh-ops"}'

# 恢复默认：清掉界面保存的设置、回到 cordis.patch.yml（报告不删）
curl -s -X POST http://127.0.0.1:<端口>/bug-reporter/settings/reset \
  -H 'content-type: application/json' --data-binary '{}'
```

PowerShell：

```powershell
$base = 'http://127.0.0.1:<端口>/bug-reporter'

# 读状态
$state = Invoke-RestMethod -Uri "$base/state"
$state.value.reports.Count
$state.value.storeFile

# 写（必须显式按 UTF-8 取字节，否则中文会乱码；PS 5.1 默认按 ISO-8859-1 编码请求体）
$json  = [IO.File]::ReadAllText('D:\report.json', [Text.Encoding]::UTF8)
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Method Post -Uri "$base/report" `
  -ContentType 'application/json; charset=utf-8' -Body $bytes
```

⚠️ 三个坑：

1. **`content-type` 必须是 `application/json`**，否则 `415`（`index.js:1376-1389`）——
   `curl -d` 默认发 `application/x-www-form-urlencoded`，要用 `--data-binary` + `-H`；
2. 端口是本次运行的 DSH Web 端口（每次启动可能不同），以浏览器地址栏为准；
3. PowerShell 5.1 的 `Get-Content` 读 UTF-8 中文会按 GBK 解码出错，用
   `[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`。

### 7.6 请求体上限 1 MiB 的实测边界（task-17 已修好，如实写）

上限是 `MAX_BODY = 1 << 20` = 1048576 字节（`index.js:35`）。超限时的实现是：停止缓冲
（内存仍有界）、`req.resume()` 把余下的 body 排空丢掉、回 `413`，
并且**不带 `connection: close`、也不主动 `destroy()`**，让客户端写完自己的 body 之后正常读到响应
（`index.js:477-500, 516-534`）。

**修复过程（三段实测，都是同一个 handler + 真 socket + 精确字节数）**：

| 实现 | 1200014（超 151438 B） | 2097152 | 5242880 |
|---|---|---|---|
| 带 `connection: close` + `finish` 后 `req.destroy()` | `ECONNRESET` | `ECONNRESET` | `ECONNRESET` |
| 只去掉自己的 `destroy()` | `413` | `413` | `ECONNRESET` |
| 再去掉 `connection: close`（**当前实现**） | `413` | `413` | `413` |

**当前实测表**（开发期探针 `_task-17-413-probe.mjs`，未随仓库分发；`undici fetch` 与 `curl` 两种客户端一致）：

| body 总字节 | 超出上限 | 客户端拿到 |
|---|---|---|
| 1048577 | 1 | `413` + `{"ok":false,"error":{"code":"body-too-large",...}}` |
| 1100000 | 51424 | `413` |
| 1200014 | 151438 | `413` |
| 2097152 | 1048576 | `413` |
| 5242880 | 4194304 | `413` |
| 16777216 | 15728640 | `413` |

`curl -s -o NUL -w '%{http_code}'` 交叉验证：1100000 / 2097152 / 5242880 → 全部 `413`。

也就是说：**修复后 413 不再随 body 增大而退化**（实测到 16 MiB 超出上限仍然是 413）。
原因写进了源码注释（`index.js:522-531`）：超限 body 越大，客户端越可能**还在写**；
此时只要服务端关连接（主动 `destroy()`，或 Node 因 `connection: close` 而收尾），
客户端的写失败就早于它读到响应，于是只剩 `ECONNRESET`。

⚠️ 仍未验证的上界：没有测 100 MiB 以上的 body，也没有测「客户端边写边断」这类异常时序；
连接在超限后保持打开，直到客户端写完（由 Node 的 `requestTimeout` 兜底），这一段的实际行为
没有在真宿主里长跑验证。

---

## 8. 安全模型

### 8.1 前提事实：DSH 的 `webServer` 没有全局防护

`WebRoute` 契约就是 `{kind, path, handler}`，没有鉴权钩子（本机契约核对笔记
`D:\ai aegit\deepseek\_doctor-contract.md:24`；该文件在插件仓库之外，是开发期的核对记录，不随包发布）。
对运行中的宿主发一个带恶意 `Origin`（再加 `Sec-Fetch-Site: cross-site`）的请求仍返回 200，
且响应里没有任何 CORS 头 —— 这一点由 lead 在本机实测确认；**我这一轮只测了插件自己 handler 的行为**
（见 7.4 的实测表），没有自己复测「绕过插件的裸 webServer」。
插件源码里同一段结论写在 `index.js:1222-1239` 的注释里：
「任意网页都能用 `content-type: text/plain` 发**跨站简单请求**（不触发预检）打到这里，
而且请求会在服务端真的执行 —— `/report/clear`（清空报告）、`/state`（改 repo）、
`/repair`（往包目录写文件 → 下次加载即代码执行）全都在射程内。」

### 8.2 插件自己加的三道闸

入口是 `rejectCrossSite()`（`index.js:1240-1282`），在**所有路径、所有方法**上最先执行一次
（`index.js:1547-1548`）：

| 闸 | 条件 | 结果 | 行号 |
|---|---|---|---|
| 1 | 请求头 `Sec-Fetch-Site` 存在，且 `trim().toLowerCase()` 后等于 `cross-site` | `403` `cross-site` | `1244-1251` |
| 2 | `Origin` 存在（非空）且其 host 与服务端**不同源** | `403` `bad-origin` | `1253-1264` |
| 3 | 方法为 `POST` 且 `content-type` 去掉参数后不是 `application/json` | `415` `unsupported-media-type` | `1266-1279` |

配套细节：

- **`Origin` 缺失时放行**（闸 2 只在 `Origin` 存在时判定），这是为了 curl / 本机原生客户端能用
  （`index.js:1232-1233`）。
- 服务端自己的 host：优先 `webServer.getOrigin()`，取不到 / 抛错 / 方法不存在时**退化**成比对
  本次请求的 `Host` 头（`selfHostOf`，`index.js:1177-1202`）。
- `sameHost`（`index.js:1204-1220`）：完全相同，或**都是 loopback 别名且端口相同**
  （`localhost` ↔ `127.0.0.1` ↔ `[::1]`）。加这条是因为浏览器地址栏写 `localhost:<端口>`
  而 `getOrigin()` 返回 `127.0.0.1:<端口>` 时，严格字符串比对会把**设置页自己**403 掉；
  跨站域名永远匹配不上，防护不受影响（`index.js:1216-1218`）。**端口不同仍然拒**（拦同站不同端口）。
- 响应**不加**任何 `Access-Control-Allow-*`；统一加 `Vary: Origin`（源码里是 `vary: 'Origin'`，`index.js:361-362`）。
- 设置页自己的 POST 带 `content-type: application/json`（`client.js:301-308`），所以闸 3 不会打死设置页。

### 8.3 为什么这三道能挡住跨站写

1. **闸 3（415）挡「简单请求」。** 跨站表单 / `fetch` 用 `text/plain`、`application/x-www-form-urlencoded`
   或 `multipart/form-data` 时属于 CORS「简单请求」，浏览器**不预检**直接发；但服务端要求
   `application/json`，这类请求一律 `415`，写操作根本进不到路由。
2. **强制 JSON 会把跨站请求推进预检。** 跨站要带 `content-type: application/json` 就属于非简单请求，
   浏览器**先发 `OPTIONS` 预检**；而本服务对预检不返回任何 `Access-Control-Allow-*`（实测
   `OPTIONS /bug-reporter/state` → `405`，且所有响应里 `access-control-*` 头为空），
   预检失败 → 浏览器**不会发真正的请求**。
3. **闸 1 / 闸 2 兜住其余路径。** 即使某个客户端能绕过预检（非浏览器客户端、老的浏览器），
   带 `Sec-Fetch-Site: cross-site` 或异源 `Origin` 的请求也会在 handler 最前面被 `403`。

我自己的真 socket 实测（`http://127.0.0.1:54533`）验证了这三条：
`Origin=evil` + `cross-site` + `text/plain` 的 `POST /report/clear` → `403 cross-site`（报告数没变）；
`Origin=evil` + JSON → `403 bad-origin`；`text/plain` 无 Origin → `415`；同源与 loopback 别名 → `200`。

### 8.4 已知边界（如实写，不要当成「已解决」）

| 边界 | 说明 | 证据 / 行号 |
|---|---|---|
| **GET 类读接口不做认证** | 裸 `curl` 无 Cookie / 无 Token / 无自定义头即可 `200` 读到全部报告。本机任意进程本来就能直接读那个 jsonl，所以这不构成**新的**权限边界 | 实测 `GET /state` → `200`；`index.js:1558-1562` 无任何鉴权 |
| **`pluginId` 来自请求体，本机进程可伪造** | `POST /report` 的 `pluginId` 由请求体提供（`index.js:1601`），本机进程可伪造 `pluginId` 让「该报告所属包的目录」落进围栏；但跨站路径已被 8.2 堵死，且本机进程本来就能直接改插件文件 | `index.js:1601, 1404-1405`；task-15 报告的残余风险说明 |
| **硬链接不被 `realpath` 解析** | `realpathSync` 解析 symlink / junction，但**不解析硬链接**（同一 inode）；允许根内的硬链接仍可写到别处。创建硬链接需要对允许根有写权限 | `realpathForWrite` `index.js:703-726` |
| **realpath → write 之间有 TOCTOU 窗口** | `real = realpathForWrite(absolute)`（`1394`）与 `atomicWrite(real, content)`（`1427`）之间，路径可能被换掉。同样需要本机写权限 | `index.js:1394, 1427` |
| **`Origin` 缺失即放行；`Host` 头不校验** | 不带 `Origin` 的请求（含伪造 `Host`）不被拦；实测「伪造 `Host: evil.example` + 无 Origin」→ `200` | `index.js:1260-1271`；实测输出 |
| **同站不同端口被拒，但 loopback 别名放行** | 这是刻意的取舍：不认别名会 403 掉设置页自己 | `index.js:1211-1227` |
| **`/repair` 是整文件替换** | 没有 diff / 补丁语义，写入的 `content` 就是文件的全部新内容；PR 正文里也这么写明 | `index.js:1427, 841-842` |

这三条（`pluginId` 可伪造 / 硬链接 / TOCTOU）是「路径围栏」的固有边界，不是本轮实现引入的；
要做成 inode 级判定得换设计（task-15 报告的「围栏的残余风险」一节）。

### 8.5 `/repair` 的路径围栏规则

`handleRepair` 按顺序过 4 道（`index.js:1370-1418`）：

| 道 | 规则 | 拒绝时的 message | 行号 |
|---|---|---|---|
| 1a | 词法绝对路径含 NUL 字节（`\u0000`） | `拒绝写入：路径含 NUL 字节` | `1380-1382` |
| 1b | 原路径或绝对路径以 `\\` / `//` 开头（UNC） | `拒绝写入 <原路径>：不接受 UNC 路径` | `1383-1385` |
| 2 | 对目标做 **realpath**（对已存在的最近祖先 `realpathSync`，再把不存在的尾段拼回去；连盘根都 realpath 不了时退化为入参）；realpath 后含 NUL 再拒一次 | `拒绝写入：真实路径含 NUL 字节` | `1387-1390, 696-719` |
| 3 | 真实路径必须落在**允许根**内。允许根 = `config.repairRoots`（各自 realpath 后）**∪** 该报告 `pluginId` 所属插件包的目录（`clientModules.clientPath(pluginId)` → 向上找最近 `package.json` → realpath） | `拒绝写入 <真实路径>：它不在报告所属插件（<pluginId 或 无 pluginId>）的包目录内，也不在 config.repairRoots 里` | `1392-1407, 730-753` |
| 4a | basename（小写）等于 `package.json` | `拒绝写入 package.json：改 manifest 等于换插件` | `1408-1410` |
| 4b | 扩展名不在白名单 | `拒绝写入 <真实路径>：只允许改源码/资源文件（.js .mjs .cjs .ts .jsx .tsx .css .html .svg .txt）` | `1411-1418, 46-57` |

判定「是否在目录内」用 `isInsideDir`：先 `resolve` 再比较，**Windows 上大小写不敏感**，
相等或 `isInsideDir` 里 `target.startsWith(...)` 才算在内（`index.js:721-728`）。

扩展名白名单（`ALLOWED_REPAIR_EXT`，`index.js:46-57`）：
`.js` `.mjs` `.cjs` `.ts` `.jsx` `.tsx` `.css` `.html` `.svg` `.txt`
（白名单而不是黑名单，`index.js:41-45` 说明理由：写 `.exe` / `.bat` / `.ps1` 等于直接换掉插件行为；
`.txt` 是为了兼容「报告里附带的普通文本资源」而留的）。

**「没有 `pluginId` 的报告默认修不了」**：允许根只有 `repairRoots` ∪ 该报告 `pluginId` 的包目录；
默认 `repairRoots` 是空数组（`index.js:104`），所以 `pluginId` 为 `null` 的报告（例如手动 `POST /report`
补的、或 `clientModules.clientPath` 解析不出包目录的）**在任何路径上都会被 `403 path-not-allowed` 拒掉**，
除非显式配 `repairRoots`。我的实测印证了这一点：同一条 `pluginId: null` 的报告，
写允许根之外的路径 → `403`，写 `repairRoots` 内的 `.js` → `200`。

---

## 9. 排错

### 9.1 设置里看不到「Bug 报告」那一页

1. **重启一次 DSH 宿主**（最常见原因：宿主对 `dsh.client` 的扫描是增量的，「不是客户端包」的否定结论
   缓存到进程重启，热装那一行会永久漏掉；`cordis.patch.yml:37-39`）；
2. `plugin_manager` 的 `list_bundles` 里确认本 bundle 已装；
3. 确认 `package.json` 的 `dsh.client` 没被改坏（`platform: 'web'`、`immediately: true`、`inject: []`，
   `package.json:28-33`）；
4. 宿主行加载失败也会导致整页消失：配置校验是 fail loud 的（未知键 / 类型错都会抛，见 6.1）；
5. 打开浏览器开发者工具看 `GET /bug-reporter/state` 是否 200；404 说明宿主行没挂上
   （或 `webServer` 是软依赖没注入，`index.js:1891-1906`）。

### 9.2 装完没生效

| 检查 | 说明 |
|---|---|
| 是否重启过宿主 | 见 9.1 第 1 条 |
| `config.enabled` | `false` 时整行不挂载（`index.js:1845`），设置页与数据接口都不会有 |
| 设置里的「总开关」 | 关掉后所有捕获点直接 return（`index.js:1864`），但设置页照常可用（这是有意的） |
| 界面改了但 yml 没生效 | **正常**：界面改动会持久化并**优先于 yml**（见 5.6 / 6.4）。点「恢复默认」或删掉设置文件即可回到 yml |
| yml 改了但界面没变 | 同上：设置文件里的旧值盖住了 yml。点「恢复默认」 |
| 页面载入失败 | 状态行 / 整页会显示 `操作失败: <原因>` 或 `载入中…`（`client.js:722-739`） |

### 9.3 PR 提交失败：错误码含义

| 错误码 | HTTP | 含义与处理 |
|---|---|---|
| `no-token` | 401 | `credentials.resolve(tokenRef)` 与 `gh auth token` 都拿不到 token（`index.js:1456-1459`）。在宿主凭据里补一条与「凭据名」同名的凭据，或让 `gh auth login` 可用 |
| `no-repo` | 400 | 请求体、设置里的 repo、报告 `context.repo` 三处都为空（`index.js:1467-1469`）。在设置区填「目标仓库（owner/name）」 |
| `github-unauthorized` | 401 | GitHub 返回 401/403（token 无效 / 无 repo 权限）（`index.js:795`） |
| `repo-not-found` | 404 | GitHub 返回 404（仓库名写错 / token 看不到该仓库）（`index.js:796`） |
| `github-error` | 502 | 其他 GitHub 状态码、拿不到 base 的 sha、或网络层异常（`index.js:797, 1496-1498, 1520-1523`） |
| `invalid-request` | 400 | 请求缺 `id`（`index.js:1452`） |
| `not-found` | 404 | 报告 id 不存在（可能已被删除）（`index.js:1454`） |

补充：分支名固定 `branch = bug-report/<指纹前 12 位>`（`index.js:1465`），所以**同一个错误重复提交会复用同一条分支**
（`POST /git/refs` 返回 422 时不报错，`index.js:1494-1495`）；第二次提交会因为「同一分支下同名文件」
或 PR 已存在而由 GitHub 报错，报错会按上表映射成 `github-error`。

### 9.4 更新装不上 / `restart-required` 是什么意思

| 现象 | 含义 | 行号 |
|---|---|---|
| 更新记录里 `已应用`（`applied`） | `installBundle` 返回的 `application === 'applied'`，本次已生效 | `index.js:1055-1061` |
| 更新记录里 `需重启生效`（`restart-required`） | `application === 'restart-required'`：**装了但需要重启宿主才生效**，插件如实记录，不谎报 | `index.js:1059-1061`；`client.js:1078-1091` |
| 更新记录里 `失败`（`failed`） | `application` 是 `overridden` / `failed` / `cancelled` 或缺失，或 `installBundle` 抛错 | `index.js:1055-1061, 1050-1053` |
| 更新记录里 `已跳过`（`skipped`） | 在 `ignoredUpdates` 里，或 `updatePolicy` 不含该 `kind`（只记一次） | `index.js:1083-1103` |
| HTTP `502 operation-failed` | 手动点「更新」时 `installBundle` 抛错 | `index.js:1677-1685` |
| HTTP `404 unknown-module` | 手动点的模块不在当前「可用更新」列表里（先点「立即检查更新」） | `index.js:1674-1676` |
| HTTP `400 missing-param` | `/update/apply` 缺 `moduleName`，或 `/update/ignore` 缺 `version` | `index.js:1672, 1696-1697` |
| 「可用更新」一直是空 | `pluginManager` 没注入（`updates` 保持空 + warn，`index.js:983-988`）；或 `timer` 没注入（完全不巡检，`index.js:1950`）；或没有真正的新版本（`compareVersions(latest, installed) <= 0` 不算更新，`index.js:1020`）；或 `inspect` 的 `status` 不是 `accepted`（`index.js:1013`） |
| 忽略名单重启就没了 | `ignoredUpdates` 只在内存里（`index.js:1737`）；要持久化就写进 profile 的 `config` |

### 9.5 修复被拒

| 错误码 | 原因（按 8.5 的 6 种） | 处理 |
|---|---|---|
| `repair-disabled` | 「允许写文件修复」开关关了 | 打开该开关，或 `config.repairEnabled: true` |
| `path-not-allowed` + `含 NUL 字节` | 路径里有 `\u0000` | 换正常路径 |
| `path-not-allowed` + `不接受 UNC 路径` | 路径以 `\\` 或 `//` 开头 | 用盘符绝对路径 |
| `path-not-allowed` + `不在报告所属插件…也不在 config.repairRoots 里` | 报告没有 `pluginId`（默认修不了），或目标不在允许根内 | 给报告补 `pluginId`（`POST /report` 时带上），或配 `config.repairRoots` |
| `path-not-allowed` + `拒绝写入 package.json` | 想改 manifest | 不允许，改别的文件 |
| `path-not-allowed` + `只允许改源码/资源文件` | 扩展名不在白名单 | 用 `.js` `.mjs` `.cjs` `.ts` `.jsx` `.tsx` `.css` `.html` `.svg` `.txt` |
| 写入成功但界面显示 `热重载=否` | 归属包没有 `dsh.client`，或 `clientModules` 没注入（`index.js:1431-1442`） | 源码已改，但浏览器半区不会自动更新；重启宿主 |

### 9.6 报告没抓到 / 抓重复了

| 现象 | 原因 | 行号 |
|---|---|---|
| 什么都不记 | 「启用捕获」关了（`enabled !== true`） | `index.js:1747` |
| 工具失败不记 | 「记录工具执行失败」关了，或工具结果 `isError !== true`（工具成功不记） | `index.js:1804-1805` |
| 进程崩溃不记 | 「监听未捕获异常」关了；或 `enabled` 关了（两者都要为真） | `index.js:1872` |
| 多条错误合成一条 | 指纹相同：message + stack 前 3 个 `at ` 帧 + `pluginId` 都一样（这是设计行为，`count` 会累加） | `index.js:265-280, 594-603` |
| 同一个错误分成两条 | `pluginId` 不同（不同插件的同名报错不合并），或 stack 里 `at ` 帧不同 | `index.js:259, 267-271` |
| 报告条数莫名减少 | 超过 `maxReports`（默认 500）时最旧的被丢 | `index.js:563-566` |
| 手改文件后指纹变了 | 手写行若没有 `fingerprint`，载入时按**不含 `pluginId`** 的算法补 | `index.js:504-505` |

### 9.7 其他

- **`413` 与连接重置**：task-17 之前，小幅超限能收到 `413 body-too-large`，body 远大于 1 MiB 时
  客户端只看到 `ECONNRESET`。task-17 去掉「超限后关连接」之后，实测 1 B ~ 15.7 MB 超出上限
  都是 `413`（`undici fetch` 与 `curl` 一致，见 7.6）。
- **状态行一直「保存中…」**：说明有请求没回来（宿主行没挂 / 端口变了），看浏览器网络面板。
- **改设置没生效**：`POST /state` 只认 7 个键（见 6.3）；
  改 `maxReports` / `updateCheckMs` / `autoUpdate` / `updatePolicy` / `repairRoots` / `storePath` /
  `settingsPath` 必须改 profile 的 `config` 再重启（这些键界面改不了，也**不会被设置文件盖掉**）。
- **改了 yml 却不生效 / 关了开关重启又开了**：界面里的改动写在设置文件里、**优先于 yml**
  （见 5.6）。前者点「恢复默认」，后者说明持久化按预期工作了。

---

## 10. 卸载

```
plugin_manager remove_bundle target=dsh-bug-reporter
```

- **不会删除** `$DSH_HOME/bug-reports.jsonl`，报告留着（`README.md:294`；`index.js` 全文件没有任何
  删除报告文件的代码路径）。
- **也不会删除**设置文件 `bug-reporter-settings.json`（同样没有删它的路径，只有「恢复默认」会删）。
- 卸载后「Bug 报告」页消失，`/bug-reporter/*` 路由不再注册（`scoped.effect`，`index.js:2047-2050` 被 dispose），
  process 监听器被摘掉（`process.removeListener`，`index.js:2002-2011`）。
- 想彻底清干净：先卸载，再手动删除 `$DSH_HOME/bug-reports.jsonl` 与
  `$DSH_HOME/bug-reporter-settings.json`（以及可能残留的 `*.bug-reporter.tmp`）。
- 重装后行为：报告文件还在就**沿用**；设置**也会沿用**（设置文件还在），
  想回到 profile `config` 的值就先点「恢复默认」或删掉设置文件。

---

## 11. 开发 / 结构说明

### 11.1 文件职责

| 文件 | 行数 | 作用 |
|---|---|---|
| `index.js` | 2165 | **宿主半区**：捕获、存储、设置持久化、路径围栏、GitHub、版本巡检、HTTP 路由。导出 `apply(ctx, rawConfig)`（`1842`）与 `internals`（`2127`） |
| `client.js` | 1238 | **浏览器半区**：`window.__ModuleLoader__.load({ id: 'dsh-bug-reporter', factory(require) })`（`18-21`），`react` 从浏览器模块表 `require`；无构建步骤，**不用 JSX**，全部 `React.createElement`（`9-16`）；注册 `settings.section`（`1229-1234`） |
| `package.json` | 35 | 包元数据 + `dsh.bundle.patch` + `dsh.client` + `exports` / `files`（`9-34`） |
| `cordis.patch.yml` | 50 | bundle 补丁：**只 insert 一行**（`47-50`），并在注释里列出 15 个可调项与 5 个软依赖（`5-41`） |
| `locale/zh.json`、`locale/en.json` | 36 / — | `meta.title` / `meta.description`，以及一份 `ui.updates.*` 文案表（`locale/zh.json:6-35`） |
| `icon.svg` | — | 设置页图标 |

> 注意：`client.js` **不读取** `locale/*.json`（`DICT` 前的注释 `client.js:42-49` 说明了原因），界面文案走它自带的
> `DICT`（`client.js:49-270`）。所以 `locale/zh.json` 里的 `ui.updates` 块目前**没有任何代码引用**。

### 11.2 模块边界

- **宿主半区不 import 任何 `@deepseek-ai/*` 值**（`index.js:8-11`）；宿主服务一律通过
  `ctx.inject([...], scoped => ...)` 获取。
- 宿主半区只用 Node 内置模块：`node:child_process`、`node:crypto`、`node:fs`、`node:os`、`node:path`
  （`index.js:19-23`）。
- 浏览器半区只 `require('react')`，不 import 任何 `@deepseek-ai/*` 客户端包（`client.js:18-23`）。

### 11.3 软依赖清单

| 服务 | 注入点 | 用途 | 缺失后果 |
|---|---|---|---|
| `webServer` | `index.js:2042-2057` | 注册 `/bug-reporter` 前缀路由；句柄也存进 `services` 供同源比对 | 没有设置页数据接口（捕获与存储照常） |
| `credentials` | `index.js:2060-2068` | `resolve(tokenRef)` 取 GitHub token | 提交 PR 时只能退到 `gh auth token` |
| `clientModules` | `index.js:2071-2080` | `clientPath(id)` 定位插件包目录；`rebuilt(包名)` 触发热重载 | `/repair` 无法定位归属包（除非配 `repairRoots`），且不会热重载 |
| `pluginManager` | `index.js:2083-2091` | `listBundles` / `inspect` / `installBundle` | 不巡检，`updates` 保持空数组并记一条 warn（`index.js:1042-1046`） |
| `timer` | `index.js:2094-2116` | 首次 3 秒巡检 + 按 `updateCheckMs` 轮询 | 完全不巡检（`index.js:2100-2108`） |

每个注入点都用 `scoped.effect(...)` 注册了 dispose（把 `services.*` 置回 `null`），所以服务下线后
handler 不会拿着旧句柄（`scoped.effect` 的 `index.js:2051-2056, 2062-2067, 2073-2078, 2085-2090, 2100-2115`）。

### 11.4 测试 / 排障用的内部句柄

`internals`（`index.js:2127-2165`）导出：`resolveConfig`、`fingerprintOf`、`normalizeReport`、
`findOwningPackage`、`prBody`、`slugify`、`createStore`、`DEFAULTS`、`ROUTE_PREFIX`、
`createUpdateManager`、`compareVersions`、`parseVersion`、`updateKind`、`policyAllows`、
`UPDATE_POLICIES`、`MIN_UPDATE_CHECK_MS`、`MAX_UPDATE_LOG`，以及：

| 成员 | 用途 | 行号 |
|---|---|---|
| `active` | 最近一次 `apply()` 的内部状态 `{store, settings, services, reloadEvents, capture, syncProcessHooks, updates}`；没 apply 过就是 `null` | `2146-2147` |
| `setFetch(fn)` | 替换 `fetch`（传 `null` 恢复 `globalThis.fetch`） | `2148-2151, 168-172` |
| `setGhTokenRunner(fn)` | 替换 `gh auth token` | `2152-2155, 174-176` |
| `resetOverrides()` | 恢复两个外部调用 | `2156-2160` |
| `reloads()` | 热重载观察记录副本（最多 50 条） | `2161-2164` |

### 11.5 客户端实现细节

| 项 | 说明 | 行号 |
|---|---|---|
| 端点常量 | `ROUTE` 映射 10 个路径（state / update / remove / clear / repair / submit / updateCheck / updateApply / updateIgnore / settingsReset） | `client.js:29-42` |
| 请求封装 | `request()` 解包 `{ok, value}`；网络失败 / 非 JSON / `ok!==true` 三种错误各有文案 | `client.js:370-388` |
| POST 封装 | 固定 `content-type: application/json`（这也是能过宿主 415 闸的原因） | `client.js:329-336` |
| 防抖 | 文本框 400ms，开关立即；连点合并成一次 | `client.js:560-584` |
| 乐观更新 | 先改本地镜像，宿主回了整份状态才 `adopt()` 覆盖 | `client.js:521-554` |
| 卸载守卫 | 组件卸载后到达的响应直接丢弃（`alive` ref + `AbortController`） | `client.js:470-518` |
| 忙态 | `busy` 非空时所有按钮禁用（报告行里是 `locked`） | `client.js:458, 951` |
| 主题 token | `TOKEN` 只用已核实的 `--dsw-alias-*`，不发明新名字 | `client.js:270-283` |
| 语言 | `navigator.language` 以 `zh` 开头 → 中文，否则英文；缺键回落中文 | `client.js:257-268` |

### 11.6 打包

`package.json:16-24` 的 `files` 是 `index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、
`icon.svg`、`README.md`、`docs/*.md`——**包含 `docs/*.md`**，所以本文会随 `npm pack` 一起打包
（与 `dsh-work-habits` 不同，那个插件的 `files` 不含 `docs/`）。

---

## 12. 未验证项（实测缺口）

**本节内容不要当成已验证的行为。** 下面每一条都写清了「已验的是什么、没验的是什么」。

### 12.1 未做真机联调：本机没起 DSH 宿主 + 浏览器，插件尚未安装

- **已验证**：桩测（假 `ctx` / 假服务）与**真 socket** 测试。这 6 个脚本**随仓库分发在 `test/` 下**
  （文件名去掉了 `_` 前缀，内部按 `import.meta.url` 解析插件源码，在仓库根直接跑即可）。
  我在本机实跑的结果：
  - `node test/verify-bug-http.mjs` → 共 23 项：**PASS 18 / FAIL 2 / INFO 3**
    （两项 FAIL：`A1 裸 curl 读 /state`、`B8 对照组：/repair 写自己包内文件应当成功`——两项都是
    第 8.4 / 8.5 节写明的**已知设计边界**：GET 不做认证、没有 `pluginId` 的报告默认不许修）；
  - `node test/bug-check.mjs` → **57/57 通过**（宿主半区桩测，假 `ctx` / 假 `req-res` / 假 fetch）；
  - `node test/bug-client-smoke.mjs` → **ALL PASS**（桩 React hooks 运行时真挂载 + 假 http 宿主）；
  - `node test/bug-update-check.mjs` → **ALL PASS（PASS 257 / FAIL 0）**（task-19 加了 D14 一节，见 12.7）；
  - `node test/verify-bug-contract.mjs` → 共 19 项：**PASS 12 / FAIL 4 / INFO 3**（4 项 FAIL 是
    「作者测试的弱点清单」审计项，见 12.2 / 12.3）；
  - `node test/verify-bug-proc.mjs` → 共 7 项：**PASS 4 / FAIL 0 / INFO 3**；
  - 我自己写的独立 socket 探针（临时目录、已删除）→ 第 7.4 节的 30 条输出。
- **未验证**：
  - 真宿主里**设置页是否出现**、左侧导航排序、按钮是否真的打通；
  - 真宿主里 `webServer.getOrigin()` 返回什么（这直接影响 8.2 的同源比对是否会 403 掉设置页自己——
    loopback 别名等价就是为这个加的，但仍需宿主就位后确认）；
  - 真宿主里「修复后热重载真的生效」；
  - 真浏览器里跨站简单请求是否被 415 / 403 拦住（8.3 的推理是按 Fetch 规范 + 真 HTTP 打真 handler 验证的，
    浏览器侧行为本身没有在浏览器里跑过）。

### 12.2 `clientModules.rebuilt` 在所有测试里都是假实现

- **已验证**：`/repair` 的围栏、原子写、`fix` 字段（`reloaded` / `rev`）在假 `clientModules` 下的取值。
- **未验证**：**「修复后浏览器半区真的热重载」这条端到端行为没有真实验证**。
  真实 `rebuilt()` 返回什么、浏览器是否真的换到新一代 bundle，都没有跑过（`index.js:1424-1435` 只做
  「返回值是字符串就算成功」的判定）。

### 12.3 `fetch` 全是假的

- **已验证**：GitHub 调用的**顺序**、请求体形状、状态码到错误码的映射（用假 `fetch` 注入）。
- **未验证**：真实网络错误路径——**DNS 解析失败 / TLS 失败 / 超时 / 连接重置**都没有覆盖。
  这些情况会走 `index.js:1513-1516` 兜底成 `502 github-error`，但那条分支没有用真实网络触发过。

### 12.4 `uncaughtException` 的「不吞掉」是**有条件**的

README 第 234-240 行的说法是「只记录，不改默认行为：记录之后把原始错误原样抛回，让 Node 走它原本的致命路径」。
按实测，这个说法**要带上前提**：

- 插件做的事是「记录 → `process.removeListener` 摘掉自己 → `setImmediate` 里把原始值抛回」
  （`index.js:1836-1847`）。
- **当插件之后还注册了别的 `uncaughtException` 监听器时，抛回会被那个监听器接住，Node 默认的致命路径
  不再触发。** 我实跑 `test/verify-bug-proc.mjs` 得到：
  - `P1`（只有插件的监听器）：**实际退出码 = 1**，stderr 含原始错误，报告存下 1 条
    （`source=process`、`context.kind=uncaughtException`）；
  - `P4`（插件之前注册了 A、之后注册了 B）：A 和 B 都跑了，**退出码 = 0**，stderr 长度 0；
  - `P6`（**不含本插件的对照组**，复刻同样的「摘掉自己 + `setImmediate` 抛回」写法、后面还有别的监听器）：
    **退出码 = 0**、stderr 长度 0。
- 结论：退出码 0 是 **Node 的监听器语义**（只要有 `uncaughtException` 监听器，默认致命路径就不触发），
  不是插件把异常吞了——对照组复刻出完全一样的行为。
- 因此「只记录，不吞掉」在**插件是最后一个/唯一监听器**时成立；宿主或别的插件再挂一个监听器时，
  进程不会因这个异常退出。`unhandledRejection` 同理（`index.js:1849-1861`）。

### 12.5 我在写本文时另外实测到、后续任务已处理的两点

1. **413 曾经不是「一定送达」**：body 远大于 1 MiB 时客户端只拿到 `ECONNRESET`（见 7.6 的实测表）。
   task-15 修掉了「一超限就 `destroy` 导致 413 根本送不出去」的问题，小幅超限能收到 413，
   但大幅超限仍是连接重置。**task-17 已修好**：去掉超限后主动 `destroy()` 与 `connection: close`，
   实测 1 B ~ 15.7 MB 超出上限都是 `413`（`undici fetch` 与 `curl` 一致），原因与三段实测
   都写进了源码注释（`index.js:414-423`）与 7.6。
2. **`config.order` 曾经是死配置，task-17 已删除**（见 6.2）。删掉之前 `cordis.patch.yml` 里那行注释（原第 7 行，**该行已随删除消失**）
   说它是「设置面板左侧导航排序位」，与代码不符；现在 `DEFAULTS` 里没有这个键，配置里写它会抛
   「未知键」并点名。界面顺序写死在 `client.js:1127`。

### 12.6 其他没有验证到的点

- `hmr/reload` 的观察记录（`index.js:1819-1828`）没有真实事件驱动过，`reloads()` 的返回形状只在桩测里看过。
- `POST /state` 改 `captureProcess` 之后 `syncProcessHooks()` 的真实重挂行为（`index.js:1560, 1863-1875`）
  只在桩测里跑过，没有在真宿主里验证「关掉后真的不再记录进程异常」。
- `updateCheckMs` 的真实轮询节奏（默认 1 小时）没有长时间跑过；`FIRST_UPDATE_CHECK_MS = 3000` 的
  首次巡检只在桩测里观察。

### 12.7 设置持久化只在桩测 + 真 HTTP handler 里验证过（task-19）

- **已验证**（`test/bug-update-check.mjs` 的 D14 一节，49 条断言，全部真读写临时目录）：
  写盘 → 重新挂载读回 → 文件优先于 yml；坏 JSON / 数组 / 字符串标量 / `null` 四种坏内容都不崩、
  退回 yml 并 `warn`；未知键（`nope` / `order`）不抛错、被丢弃；`maxReports` 与 `repairRoots`
  这类界面改不了的键不会被文件盖掉；目录不存在会建；`settingsPath` 指向一个目录时只 `warn`
  且内存值照常生效；`POST /settings/reset` 删文件 + 回到 yml + 报告一条不少 + `GET` 回 `405`；
  跑完真实 `$DSH_HOME` 下**没有**多出设置文件。
- **未验证**：真 DSH 进程里「关掉总开关 → 重启宿主 → 总开关仍是关闭」这一整条链
  （需要真宿主 + 真浏览器；桩测只覆盖到 handler 层与文件层）。
  也没有验证过两个 DSH 实例同时写同一个设置文件时的行为（`atomicWrite` 是整文件 tmp+rename，
  没有跨进程锁）。
