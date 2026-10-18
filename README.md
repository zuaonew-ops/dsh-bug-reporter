# dsh-bug-reporter

用 DSH 的时候撞上 bug，不用再手动复制粘贴一堆报错去开 issue —— 这个插件**实时**把它们抓下来，
让你在设置面板里**一键修复**（改完立刻热重载生效，不用重启 DSH），再**提交成 GitHub PR**。
同时它还会**实时巡检插件的新版本**，有更新就提醒你（或按你的策略自动装）。

## 它解决什么

出问题的那一刻信息最全，但也是最不想整理的时刻。等你回头去描述「刚才那个报错」，
stack 早滚没了、上下文忘了、复现步骤说不清。这个插件在错误发生的**当时**就把
message / stack / 归属插件 / 会话 / turn / step 全存下来，并且把重复出现的同一个错误
归并成一条（带出现次数），于是「报告」这件事变成点一下按钮。

## 四条链路

```
运行时错误 ──► 实时捕获 ──► 归并存储 ──► 设置页列表
                                            │
                          ┌─────────────────┼─────────────────┐
                          ▼                 ▼                 ▼
                     一键修复            标记/忽略         提交为 PR
                  （写文件+热重载）                      （建分支+提交+开 PR）

已装插件 ──► 定时巡检 ──► 比对最新版 ──► 设置页「可用更新」
                                            │
                          ┌─────────────────┴─────────────────┐
                          ▼                                   ▼
                     手动点「更新」                    按策略自动装（可选）
```

### 1. 实时捕获

挂在 DSH 的真实事件上（不是猜的，逐个核实过）：

| 来源 | 事件 | 记什么 |
|---|---|---|
| `agent/error` | 一个 step/turn 出错 | **主捕获点**：error + turn + step |
| `api-session/error` | Agent 在持久 turn 位之外失败 | sessionId + message |
| `agent-loop/config-start-failed` | 声明式 agent 条目没能发布 | sessionId + error |
| `tools/result` | 工具执行失败（`result.isError`） | 工具名 + 失败结果 |
| `process` | `uncaughtException` / `unhandledRejection` | 只记录，**不吞掉**，不改变默认行为（见下方边界说明） |

### 2. 归并存储

写到 `$DSH_HOME/bug-reports.jsonl`，一行一条 JSON。同一个错误的
`fingerprint`（message + stack 前 3 个 `at ` 帧 + `pluginId` 的 sha256）相同就累加 `count`、
更新 `lastAt`，不会刷屏。stack 里没有 `at ` 帧时，退化成对整个 stack 文本取哈希 ——
避免「不同 stack 因为只看 message 而被错误合并」。

### 3. 一键修复 + 热重载

`POST /bug-reporter/repair` 收 `{id, path, content}`，写入前要过四道围栏：

1. 路径含 NUL 字节或 UNC 前缀（`\\?\`、`\\`）→ 直接拒
2. 对目标（存在则对其本身，否则对其最近存在的祖先）做 **`realpath`**，之后一律用真实路径判定
   —— 这一步堵住 junction / symlink 绕过
3. 真实路径必须落在 `repairRoots` 里的某个根，**或**落在该报告 `pluginId` 所属插件的包目录内；
   否则 `403 path-not-allowed`。**没有 `pluginId` 的报告默认修不了**，要显式配 `repairRoots`
4. 拒绝 basename 为 `package.json`，且扩展名必须在白名单内（`.js` `.mjs` `.cjs` `.ts`
   `.jsx` `.tsx` `.css` `.html` `.svg` `.txt`）

过了围栏之后：原子写（先 `.tmp` 再 rename）→ 若归属包有 `dsh.client` 就调
`clientModules.rebuilt(包名)` 发布新的 bundle 代次，浏览器自己热更新，**不用重启 DSH**
→ 报告置 `fixed`，记下路径、时间、是否真的重载成功、新的 rev。

### 4. 提交为 PR

`POST /bug-reporter/submit` 走 GitHub REST：

```
GET  /repos/{repo}                          取默认分支
GET  /repos/{repo}/git/ref/heads/{base}     取 base 的 sha
POST /repos/{repo}/git/refs                 建 refs/heads/bug-report/<指纹前12位>
PUT  /repos/{repo}/contents/bug-reports/... 写报告 markdown（base64）
POST /repos/{repo}/pulls                    开 PR，返回 URL
```

PR 正文带完整报告；如果这条已经修过，还会带上修复的文件路径。

token 从 DSH 凭据 `GITHUB_TOKEN` 取（可改），取不到再退到 `gh auth token`。

### 5. 实时更新新版本

挂载后约 **3 秒**先主动查一次，之后按 `updateCheckMs`（默认 1 小时）轮询。

版本信息全部走 DSH 的 `pluginManager` 服务，**不自己写 HTTP 去查 npm**：

| 目的 | 调用 |
|---|---|
| 已装版本 | `pluginManager.listBundles()` |
| 仓库里的最新版 | `pluginManager.inspect(包名)` 的 `version` |
| 安装新版本 | `pluginManager.installBundle(包名)` |

比对用自写的语义化版本比较（认 `v` 前缀、`+build`，且预发布版正确判低于正式版），
并给出更新类型 `patch` / `minor` / `major`。

- **默认只报告，不自动装**（`autoUpdate: false`）。设置页里点「更新」才会装。
- 想让它自动装就把 `autoUpdate` 设 `true`，并用 `updatePolicy` 限定跨度
  （`patch` 只装补丁版 / `minor` 装小版本 / `any` 全装）。
- 不想再看到某个版本，点「忽略」；忽略记录存在 `ignoredUpdates` 里，可随时取消。
- `application` 返回 `restart-required` 时**如实记录**，不会谎报已生效。

## 安全模型

**前提事实（实测）**：DSH 的 `webServer` **没有任何**全局 Origin / Host / CSRF 防护 ——
`WebRoute` 契约就是 `{kind, path, handler}`，没有鉴权钩子。对运行中的宿主发一个带
`Origin: https://evil.example` 的请求会正常返回 200，再加 `Sec-Fetch-Site: cross-site` 仍 200，
响应里也没有任何 `Access-Control-Allow-*`。宿主只监听 `127.0.0.1`。

也就是说：**任意一个你访问的网页，都能向本机这些端口发请求**。所以防护必须由插件自己做。
`/bug-reporter` 的所有路径、所有方法统一先过三道闸：

| 闸 | 规则 | 拒绝时 |
|---|---|---|
| 1 | `Sec-Fetch-Site: cross-site` | `403 cross-site` |
| 2 | `Origin` 存在且与服务端不同源（loopback 别名等价，端口必须相同） | `403 bad-origin` |
| 3 | POST 的 `Content-Type` 不是 `application/json` | `415 unsupported-media-type` |

**为什么这三道能挡住跨站写**：跨站发 `text/plain` 属于 CORS「简单请求」，不触发预检 ——
但闸 3 会以 415 拒掉它。而想发 `application/json` 就会触发预检，服务端不返回任何
`Access-Control-Allow-*`，预检失败，浏览器根本不会发出真正的请求。两道各自独立生效。

`Origin` 缺失时放行（curl、脚本、本机原生客户端要能用）。

**已知边界（如实列出，不要当成没这回事）**：

- **GET 类读接口不做认证。** 跨站 GET 会执行，但浏览器读不到响应（无 CORS 头），所以拿不走数据；
  而本机任意进程本来就能直接读 `$DSH_HOME/bug-reports.jsonl`，所以这不构成新的权限边界。
- **`pluginId` 来自请求体**，本机进程可以伪造它来让 `/repair` 的规则 3 放行。
  但本机进程本来就能直接改插件文件，不算提权；跨站那条路已被闸 1/2/3 堵死。
- **硬链接不被 `realpath` 解析**（同一 inode 的另一个名字）。
- **`realpath` 判定与写入之间有 TOCTOU 窗口。**
- 后两条都要求攻击者**已经**对允许根有写权限。

## 安装

```
plugin_manager install_bundle target=D:\ai aegit\deepseek\dsh-bug-reporter
```

浏览器半区是新的客户端模块，**装完必须重启一次 DSH 宿主**，设置面板左侧才会出现
「Bug 报告」那一页 —— 刷新页面不够：宿主对客户端模块的扫描是增量的，而且
「不是客户端包」的否定结论会缓存到进程重启。

## 设置页

设置面板左侧导航 → **Bug 报告**（排序位固定 `40`，写在浏览器半区 `client.js`，**不是配置项**）。

- **总开关**（最上面单独一张卡片）：**已开启 / 已关闭** 两态。关掉后**不再记录任何新报告**，
  设置页本身与已有报告照常可用，重新打开立刻恢复记录。关掉时下面三个子开关置灰（值保留）。
  它**不是**卸载插件 —— `config.enabled: false` 才是「整行不挂载」。
- **开关区**：记工具失败 / 记进程级异常 / 允许修复（跟随总开关）
- **设置区**：目标仓库 `owner/name`、token 凭据名、PR 基分支、token 是否已配置、存储文件绝对路径，
  以及 **恢复默认** 按钮（二次确认；清空界面保存的设置、回到 `cordis.patch.yml`，**不删报告**）
- **报告列表**：按出现次数、来源、归属插件、状态展示；可展开看 stack 与 context；
  每条能 **提交为 PR** / **修复** / **标记已修** / **忽略** / **重新打开** / **删除**
- **可用更新**：插件名 / 已装版本 / 最新版本 / 更新类型 / 「更新」与「忽略」按钮；
  已忽略的单独一行，可取消忽略；另有最近 5 条更新记录
- **全部清空**

> 界面里改的设置会**原子写盘**（默认 `$DSH_HOME/bug-reporter-settings.json`，见 `settingsPath`），
> **重启 DSH 后仍然生效，并且优先于 `cordis.patch.yml`**。想丢掉这些改动就用「恢复默认」。
> 持久化只记「界面能改的键」，`repairRoots` / `storePath` 这类界面改不了的键永远以 yml 为准。

## 配置

`cordis.patch.yml` 里覆写同名 id（patch 是整行替换 `config`，要写全想保留的字段）：

```yaml
- id: bug-reporter
  name: 'dsh-bug-reporter'
  config:
    enabled: true
    repo: 'owner/name'
    tokenRef: 'GITHUB_TOKEN'
    baseBranch: ''
    maxReports: 500
    captureTools: true
    captureProcess: true
    repairEnabled: true
    storePath: ''
    settingsPath: ''
    repairRoots: []
    updateCheckMs: 3600000
    autoUpdate: false
    updatePolicy: 'minor'
    ignoredUpdates: []
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` 则整行不挂载 |
| `repo` | string | `''` | PR 目标仓库 `owner/name`；留空则用报告里记的 |
| `tokenRef` | string | `'GITHUB_TOKEN'` | 去哪个凭据名取 GitHub token |
| `baseBranch` | string | `''` | PR 基分支；留空用仓库默认分支 |
| `maxReports` | number | `500` | 最多保留多少条 |
| `captureTools` | boolean | `true` | 是否记工具执行失败 |
| `captureProcess` | boolean | `true` | 是否监听进程级异常 |
| `repairEnabled` | boolean | `true` | 是否允许 `/repair` 写文件并触发热重载 |
| `storePath` | string | `''` | 报告存储文件；留空用 `$DSH_HOME/bug-reports.jsonl` |
| `settingsPath` | string | `''` | 界面设置的持久化文件；留空用**与报告同目录**的 `bug-reporter-settings.json`（默认即 `$DSH_HOME` 下） |
| `repairRoots` | string[] | `[]` | `/repair` 额外允许的根目录（realpath 后比对）。给「报告没有 `pluginId`」的场景当逃生舱 |
| `updateCheckMs` | number | `3600000` | 巡检新版本的间隔（≥ 60000） |
| `autoUpdate` | boolean | `false` | 是否自动装新版本；`false` 时只能手动点「更新」 |
| `updatePolicy` | `'patch'\|'minor'\|'any'` | `'minor'` | 自动更新允许的最大跨度 |
| `ignoredUpdates` | string[] | `[]` | 不再提示的版本，形如 `"dsh-ops@0.3.1"` |

未知键会**抛错并点名**，不会静默忽略。配置项共 **15 个**（上表全部）。

> 设置面板左侧导航的排序位**不是配置项**：它固定在浏览器半区 `client.js` 注册
> `settings.section` 时写的 `order: 40`，改 `config` 不影响它；写 `order` 会被当成未知键报错。

> **界面改动 vs yml**：界面里改的设置写进 `settingsPath`，挂载时**文件优先于 yml**。
> 所以「改了 yml 却不生效」通常是因为界面里存过值 —— 用设置页的「恢复默认」清掉即可。
> 文件不存在、坏 JSON、不是对象、含未知键都不会让插件崩：分别是静默、warn 后退回 yml、
> warn 后退回 yml、直接丢弃（详见 [docs/USAGE.md](docs/USAGE.md) 的数据文件与排错章节）。

## HTTP 接口

前缀 `/bug-reporter`，统一响应 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/bug-reporter/state` | 取全量状态（配置 + 报告 + 可用更新） |
| POST | `/bug-reporter/state` | 改配置项（只发要改的键） |
| POST | `/bug-reporter/report` | 手工记一条报告 |
| POST | `/bug-reporter/report/update` | 改报告状态 `open`/`fixed`/`ignored` |
| POST | `/bug-reporter/report/delete` | 删一条 |
| POST | `/bug-reporter/report/clear` | 清空 |
| POST | `/bug-reporter/repair` | 写文件 + 热重载，报告置 `fixed` |
| POST | `/bug-reporter/submit` | 建分支 + 提交报告 + 开 PR |
| POST | `/bug-reporter/update/check` | 立刻巡检一次新版本 |
| POST | `/bug-reporter/update/apply` | 装某个包的最新版 |
| POST | `/bug-reporter/update/ignore` | 忽略/取消忽略某个版本 |
| POST | `/bug-reporter/settings/reset` | 清空界面持久化的设置、回到 `cordis.patch.yml`（**不删报告**） |

常见错误码：`bad-json` · `missing-param` · `unsupported-media-type` · `body-too-large` ·
`cross-site` · `bad-origin` · `path-not-allowed` · `repair-disabled` · `no-token` ·
`repo-not-found` · `github-unauthorized` · `github-error` · `operation-failed` · `unknown-module`

**请求体上限 1 MiB**（`MAX_BODY = 1 << 20`）：超限回 `413 body-too-large`。超限后服务端
只排空余下的 body、**不主动关连接**，所以客户端写完自己的 body 后能正常读到 413 ——
实测 1 B ~ 15.7 MB 超出上限都是 `413`（`undici fetch` 与 `curl` 一致）。
（task-17 之前会在回完 413 后关连接，导致超限 1.2 MB 以上只剩 `ECONNRESET`；
细节与三段实测见 `docs/USAGE.md` 的 7.6。）

## 依赖

`webServer`（设置页数据路由）、`credentials`（取 GitHub token）、`clientModules`（热重载入口）、
`pluginManager`（版本查询与安装）、`timer`（定时巡检）
都是**软依赖**（`ctx.inject`）。缺哪一个就少哪一项能力，不会加载失败。

宿主半区不 import 任何 `@deepseek-ai/*` 值。

## 进程级捕获的边界

`uncaughtException` / `unhandledRejection` 是「**只记录，不改默认行为**」：
记录之后把原始错误原样抛回，让 Node 走它原本的致命路径。

但要注意一个前提：**如果插件之后还注册了别的 `uncaughtException` 监听器**，
抛回会被那个监听器接住，Node 默认的致命路径就不再触发（实测这种情况下退出码是 0）。
这是 Node 的监听器语义，不是插件吞掉了异常 —— 用一个不含本插件的对照组复刻同样的写法，
行为完全一致。

## 测试

仓库自带 6 个可独立运行的测试脚本（都在 `test/`，只用 Node 内置模块，不需要装任何依赖）：

| 脚本 | 覆盖什么 | 我本机的实际结果 |
|---|---|---|
| `node test/bug-check.mjs` | 宿主半区桩测：配置校验 / 软依赖 / `/state` / 报告增删改清 / `/repair` / PR 链路 / process 捕获 / HTTP 协议层 | `57/57 通过` |
| `node test/bug-client-smoke.mjs` | 客户端烟测：静态检查 + 桩 React hooks 运行时**真挂载** + 假 http 宿主 + 失败路径 | `ALL PASS` |
| `node test/bug-update-check.mjs` | 更新链路 + 设置持久化（含 D14 的 49 条：坏 JSON / 未知键 / ENOENT / reset） | `ALL PASS（PASS 257 / FAIL 0）` |
| `node test/verify-bug-http.mjs` | **独立验证**：把 handler 挂到真 socket，用真 `fetch` 与真 `curl` 打 | `PASS 18 / FAIL 2 / INFO 3` |
| `node test/verify-bug-contract.mjs` | **独立验证**：两端契约交叉核对 / 软依赖 32 组合 / 配置边界 / JSONL 损坏恢复 | `PASS 12 / FAIL 4 / INFO 3` |
| `node test/verify-bug-proc.mjs` | **独立验证**：process 级捕获（真子进程、真退出码、监听器顺序） | `PASS 4 / FAIL 0 / INFO 3` |

在仓库根逐个跑即可 —— 脚本内部按 `import.meta.url` 解析插件源码路径，与当前工作目录无关，
所有写入都落在 `os.tmpdir()` 下并在结束前清理（不会碰你的 `$DSH_HOME`）。

`verify-*` 里的 FAIL **不是回归**：2 项是第 8.4 / 8.5 节写明的已知设计边界
（`A1` GET 不做认证、`B8` 没有 `pluginId` 的报告默认不许修），4 项是「作者自己的测试用假 fetch /
假 `clientModules.rebuilt`」这类弱点审计项。逐条说明见 [`docs/USAGE.md`](docs/USAGE.md) 的
第 8.4 / 8.5 / 12 节。

`test/` 不进 npm 包（`package.json` 的 `files` 里没有它），只随 Git 仓库分发。

## 卸载

```
plugin_manager remove_bundle target=dsh-bug-reporter
```

卸载**不会**删除 `$DSH_HOME/bug-reports.jsonl`，也不会删除设置文件
`$DSH_HOME/bug-reporter-settings.json`（想连设置一起清掉，卸载前先点「恢复默认」，
或者直接删这个文件）。

## 文档

详细的中文使用说明见 [`docs/USAGE.md`](docs/USAGE.md)。
