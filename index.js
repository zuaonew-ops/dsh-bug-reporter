/**
 * dsh-bug-reporter —— 宿主半区。
 *
 * 运行时实时抓 bug（agent/error、api-session/error、agent-loop/config-start-failed、
 * tools/result、process 级异常）→ 存成一份去重后的报告表 → 通过 HTTP 暴露给浏览器半区
 * → 支持一键把修复内容原子写进源码并触发热重载 → 提交成 GitHub PR。
 *
 * 设计约束（照 dsh-work-habits 的既有做法）：
 * - **不 import 任何 `@deepseek-ai/*` 值**：宿主服务一律通过 cordis 的
 *   `ctx.inject([...], scoped => ...)` 拿，全部是软依赖 —— webServer / credentials /
 *   clientModules 缺任何一个都不影响加载，只是少一项能力。
 * - `uncaughtException` / `unhandledRejection` 只**记录**，绝不吞掉：记录完立刻摘掉自己的
 *   监听器再把原始值抛回去，让 Node 走默认路径（打印 + 非 0 退出）。
 * - 不缓存 token：每次操作都重新 `credentials.resolve`，这样凭据改了不用重启。
 *
 * @module dsh-bug-reporter
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

/** HTTP 路由前缀。浏览器半区按它取数，不做成可配置项。 */
const ROUTE_PREFIX = '/bug-reporter'

/** 默认报告文件名，落在 `$DSH_HOME` 下。 */
const STORE_FILE = 'bug-reports.jsonl'

/** 默认设置文件名（task-19）：与报告同目录，默认即 `$DSH_HOME` 下。 */
const SETTINGS_FILE = 'bug-reporter-settings.json'

/** 请求体上限：1 MiB。 */
const MAX_BODY = 1 << 20

/** 单条 context 的 JSON 上限，超了就只留 preview，避免把报告文件撑爆。 */
const MAX_CONTEXT_BYTES = 4000

/** 指纹取 stack 的前几帧。 */
const FINGERPRINT_FRAMES = 3

/**
 * `/repair` 允许写的扩展名（task-15 收紧）。
 *
 * 白名单而不是黑名单：写 `.exe` / `.bat` / `.ps1` 这类东西等于直接换掉插件行为。
 * 注：`.txt` 是为了兼容「报告里附带的普通文本资源」而留的，见 task-15 报告里的 DEVIATIONS。
 */
const ALLOWED_REPAIR_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.jsx',
  '.tsx',
  '.css',
  '.html',
  '.svg',
  '.txt',
])

/** 热重载事件最多留几条观察记录。 */
const MAX_RELOAD_EVENTS = 50

/** GitHub REST 入口。 */
const GITHUB_API = 'https://api.github.com'

/** `source` 的合法取值。 */
const SOURCES = new Set([
  'agent/error',
  'api-session/error',
  'agent-loop/config-start-failed',
  'tools/result',
  'process',
  'manual',
])

/** `status` 的合法取值。 */
const STATUSES = new Set(['open', 'fixed', 'ignored'])

/** `POST /state` 允许改的键（其余键忽略，不报错）。 */
const PATCHABLE = new Set([
  'enabled',
  'captureTools',
  'captureProcess',
  'repairEnabled',
  'repo',
  'tokenRef',
  'baseBranch',
])

/** 配置默认值。键集合就是「合法 config 键」的唯一定义。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  storePath: '',
  settingsPath: '',
  repo: '',
  tokenRef: 'GITHUB_TOKEN',
  baseBranch: '',
  maxReports: 500,
  captureTools: true,
  captureProcess: true,
  repairEnabled: true,
  updateCheckMs: 3600000,
  autoUpdate: false,
  updatePolicy: 'minor',
  ignoredUpdates: [],
  repairRoots: [],
})

/** 取 boolean 的配置键。 */
const BOOLEAN_KEYS = new Set(['enabled', 'captureTools', 'captureProcess', 'repairEnabled', 'autoUpdate'])

/** 取 number 的配置键。 */
const NUMBER_KEYS = new Set(['maxReports', 'updateCheckMs'])

/** 取 string[] 的配置键。 */
const STRING_ARRAY_KEYS = new Set(['ignoredUpdates', 'repairRoots'])

/**
 * 真正会被**持久化**的键（task-19）：只有界面能改的那些。
 *
 * 持久化文件是「界面改动的记忆」，界面改不了的键（`repairRoots` / `storePath` / `settingsPath` /
 * `maxReports` / `updateCheckMs` / `autoUpdate` / `updatePolicy`）没理由进文件：
 * 一是没意义，二是**危险** —— `repairRoots` 是安全相关配置，一旦把 yml 的值写进文件，
 * 之后改 yml 就会被文件里的旧值静默盖掉（实测踩到过：同一进程里两个实例共用一个设置文件时，
 * 后一个实例的 `repairRoots` 被前一个实例写下的值覆盖，本该 200 的写入变成 403）。
 * 读的时候也只认这个集合，比 `DEFAULTS` 更窄；未知键自然一并丢弃。
 */
const PERSISTED_KEYS = new Set([...PATCHABLE, 'ignoredUpdates'])

/** `updatePolicy` 的合法取值。 */
const UPDATE_POLICIES = new Set(['patch', 'minor', 'any'])

/** 版本巡检的最小间隔：1 分钟。 */
const MIN_UPDATE_CHECK_MS = 60000

/**
 * 挂载后多久做第一次版本巡检。
 * 不取 0：boot 瞬间不该打注册表请求。但也不能只等 `updateCheckMs`（默认 1 小时），
 * 否则「实时更新新版本」在界面上会长时间显示「还没检查过」。
 */
const FIRST_UPDATE_CHECK_MS = 3000

/** `updateLog` 最多留几条。 */
const MAX_UPDATE_LOG = 100

/** DEFAULTS 的浅拷贝；数组键单独拷一份，免得调用方改到共享的默认数组。 */
function defaultsCopy() {
  return {
    ...DEFAULTS,
    ignoredUpdates: [...DEFAULTS.ignoredUpdates],
    repairRoots: [...DEFAULTS.repairRoots],
  }
}

// ---------------------------------------------------------------------------
// 可替换的外部调用（测试用；生产走真实实现）
// ---------------------------------------------------------------------------

/** 覆盖 fetch；null 表示用 globalThis.fetch。 */
let fetchOverride = null

/** 覆盖 `gh auth token`；null 表示真的去跑 gh。 */
let ghTokenOverride = null

/** 真实 fetch。 */
function doFetch(url, init) {
  const impl = fetchOverride !== null ? fetchOverride : globalThis.fetch
  if (typeof impl !== 'function') throw new Error('当前运行时没有可用的 fetch')
  return impl(url, init)
}

/** 真实 `gh auth token`：拿不到就 undefined，绝不抛。 */
function runGhAuthToken() {
  return new Promise((resolveToken) => {
    try {
      execFile('gh', ['auth', 'token'], { timeout: 10000, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolveToken(undefined)
          return
        }
        const value = String(stdout === undefined || stdout === null ? '' : stdout).trim()
        resolveToken(value === '' ? undefined : value)
      })
    } catch {
      resolveToken(undefined)
    }
  })
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 校验并归一化插件配置。未知键直接抛错并点名 —— 不静默兜底。
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) return defaultsCopy()
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-bug-reporter: config 必须是一个映射（mapping）')
  }
  const resolved = defaultsCopy()
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      throw new Error(
        `dsh-bug-reporter: 未知的 config 键 "${key}"（可用：${Object.keys(DEFAULTS).join(', ')}）`,
      )
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`dsh-bug-reporter: config.${key} 必须是 boolean`)
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`dsh-bug-reporter: config.${key} 必须是有限数字`)
      }
      if (key === 'maxReports' && value < 1) throw new Error('dsh-bug-reporter: config.maxReports 必须 >= 1')
      if (key === 'updateCheckMs' && value < MIN_UPDATE_CHECK_MS) {
        throw new Error(`dsh-bug-reporter: config.updateCheckMs 必须 >= ${MIN_UPDATE_CHECK_MS}`)
      }
    } else if (STRING_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`dsh-bug-reporter: config.${key} 必须是 string[]`)
      }
    } else if (key === 'updatePolicy') {
      if (typeof value !== 'string' || !UPDATE_POLICIES.has(value)) {
        throw new Error(`dsh-bug-reporter: config.updatePolicy 必须是 ${[...UPDATE_POLICIES].join(' | ')}`)
      }
    } else if (typeof value !== 'string') {
      throw new Error(`dsh-bug-reporter: config.${key} 必须是 string`)
    }
    resolved[key] = STRING_ARRAY_KEYS.has(key) ? [...value] : value
  }
  return resolved
}

/** 报告文件的绝对路径：显式 storePath 优先，否则 `$DSH_HOME/bug-reports.jsonl`。 */
function resolveStorePath(config) {
  if (config.storePath) return resolve(config.storePath)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, STORE_FILE)
}

/**
 * 设置文件的绝对路径（task-19）。
 *
 * 显式 `settingsPath` 优先；留空则**与报告存储同目录**（复用 resolveStorePath），
 * 默认就是 `$DSH_HOME/bug-reporter-settings.json`。
 *
 * 为什么跟着 storePath 的目录走、而不是直接拼 `$DSH_HOME`：只覆盖了 `storePath` 的调用方
 * （测试、验证脚本）会把设置文件一起放进它们自己的临时目录，不会写脏真实的 `$DSH_HOME`。
 * 实测过：`_verify-bug-http.mjs` 会 `POST /state {repo:'../../etc'}`，若默认写死 `$DSH_HOME`，
 * 那个探针值就会被持久化进真机配置。
 */
function resolveSettingsPath(config) {
  if (config.settingsPath) return resolve(config.settingsPath)
  return join(dirname(resolveStorePath(config)), SETTINGS_FILE)
}

/** 要落盘的设置：只写 `PERSISTED_KEYS` 里的键（界面能改的那些）。 */
function persistedShape(settings) {
  const out = {}
  for (const key of PERSISTED_KEYS) {
    out[key] = settings[key]
  }
  return out
}

/** 把当前设置原子写盘（复用 atomicWrite 的 tmp + rename）。写失败只 warn，不影响主流程。 */
function saveSettings(ctx, settings) {
  try {
    atomicWrite(resolveSettingsPath(settings), `${JSON.stringify(persistedShape(settings), null, 2)}\n`)
  } catch (error) {
    warn(ctx, error)
  }
}

/**
 * 读持久化的设置。**文件优先于 yml** —— 这就是「界面上的改动能被记住」的全部含义。
 *
 * 容错四条（task-19）：
 * 1. 文件不存在（ENOENT）→ 静默用 config，不报错、不 warn
 * 2. 坏 JSON / 非对象 / 数组 → **不崩**，退回 config 并 warn
 * 3. 未知键 → 丢弃（**必须在这里丢**：`resolveConfig` 对未知键是抛错的，挂载会整行失败）
 * 4. 目录不存在 → 由 atomicWrite 的 mkdirSync 负责；读的时候不存在就是第 1 条
 *
 * 另外顺手丢掉「键合法但类型不对」的值（如 `{"enabled":"yes"}`）—— 持久化文件是外部输入，
 * 让它绕过 `resolveConfig` 的类型校验会把一个手改坏的文件变成运行时炸弹。
 *
 * @returns {Record<string, unknown>} 只含合法且类型正确的已知键
 */
function loadPersistedSettings(ctx, config) {
  const file = resolveSettingsPath(config)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error === null || error === undefined || error.code !== 'ENOENT') warn(ctx, error)
    return {}
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    warn(ctx, new Error(`dsh-bug-reporter: 设置文件 ${file} 不是合法 JSON，已忽略：${error.message}`))
    return {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(ctx, new Error(`dsh-bug-reporter: 设置文件 ${file} 的内容不是对象，已忽略`))
    return {}
  }

  const kept = {}
  for (const [key, value] of Object.entries(raw)) {
    // 只认「界面能改的键」（见 PERSISTED_KEYS）：未知键、以及界面改不了的键一律丢弃。
    // **必须在这里丢**：`resolveConfig` 对未知键是抛错的，漏过去会让整行挂载失败。
    if (!PERSISTED_KEYS.has(key)) continue
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') kept[key] = value
      continue
    }
    if (NUMBER_KEYS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value
      continue
    }
    if (STRING_ARRAY_KEYS.has(key)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) kept[key] = [...value]
      continue
    }
    if (typeof value === 'string') kept[key] = value
  }
  return kept
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 任意值 → `{message, stack}`。 */
function describeError(error) {
  if (error === undefined || error === null) return { message: '未知错误（error 为空）', stack: '' }
  if (error instanceof Error) {
    const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    return { message, stack: typeof error.stack === 'string' ? error.stack : '' }
  }
  if (typeof error === 'string') return { message: error === '' ? '未知错误（空字符串）' : error, stack: '' }
  try {
    return { message: JSON.stringify(error), stack: '' }
  } catch {
    return { message: String(error), stack: '' }
  }
}

/** message + stack 前几帧 → sha256 前 16 位。 */
/**
 * 指纹：message + stack 的前 3 个 `at ` 帧 + pluginId。
 *
 * task-15 修的两个退化：
 * 1. stack 里**一个 `at ` 帧都没有**时（手写栈、别的运行时、被截断的栈），
 *    以前 basis 取空串，指纹就只由 message 决定 —— 两条 message 相同、stack 完全不同的
 *    报告会被合并。现在退化成对整个 stack 文本取哈希。
 * 2. pluginId 以前不在指纹里：不同插件里的同名报错是两件事，合并会丢掉第二条的 pluginId。
 *
 * @param {unknown} message
 * @param {unknown} stack
 * @param {unknown} [pluginId]
 */
function fingerprintOf(message, stack, pluginId = '') {
  const text = String(stack === undefined || stack === null ? '' : stack)
  const frames = text
    .split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .slice(0, FINGERPRINT_FRAMES)
  const basis = frames.length > 0 ? frames.join('\n') : text.trim()
  return createHash('sha256')
    .update(String(message === undefined || message === null ? '' : message))
    .update('\u0000')
    .update(basis)
    .update('\u0000')
    .update(String(pluginId === undefined || pluginId === null ? '' : pluginId))
    .digest('hex')
    .slice(0, 16)
}

/** JSON 安全的 context：能序列化就原样，太长就截断成 preview，循环引用返回 null。 */
function jsonSafe(value, limit = MAX_CONTEXT_BYTES) {
  if (value === undefined) return null
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return null
  }
  if (text === undefined) return null
  if (text.length <= limit) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  return { truncated: true, preview: text.slice(0, limit) }
}

/** 多行文本的第一行，用于标题。 */
function firstLine(text) {
  const line = String(text === undefined || text === null ? '' : text).split('\n')[0].trim()
  return line === '' ? '(空)' : line
}

/** 文本 → 文件名安全的 slug（纯 ASCII，避免 URL 编码问题）。 */
function slugify(text) {
  const slug = String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'bug' : slug
}

/** 当前时间的紧凑时间戳：`20261018-114000`。 */
function compactTimestamp(date = new Date()) {
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/** 原子写：先写同目录 tmp，再 rename 覆盖。 */
function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.bug-reporter.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 日志：拿不到 logger 就算了，绝不因为日志失败影响主流程。 */
function warn(ctx, error) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger.warn === 'function') logger.warn(error)
  } catch {
    /* 日志不可用 */
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/** 抛一个带 HTTP 状态与错误码的错误，由路由统一转成响应。 */
function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** 统一信封响应。`extra` 用于单次响应头（如 `connection: close`）。 */
function sendJson(res, status, payload, extra) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    // 同一路径的响应随 Origin 变化；显式声明，免得中间层缓存串味。
    vary: 'Origin',
    ...(extra === undefined || extra === null ? null : extra),
  })
  res.end(body)
}

/** 读请求体（上限 1 MiB）。超限抛 `body-too-large`。 */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY) {
        settled = true
        // task-15/task-17：**不要**在这里 destroy。socket 一断，调用方写回去的 413
        // 就到不了客户端 —— 真 socket 下客户端只看到 ECONNRESET / UND_ERR_SOCKET。
        // 改成停止缓冲（内存仍然有界）、把余下的 body 排空丢掉，交给 readJsonBody 回 413。
        if (typeof req.resume === 'function') {
          try {
            req.resume()
          } catch {
            /* 已经断了 */
          }
        }
        rejectBody(fail(413, 'body-too-large', '请求体超过 1 MiB 上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    })
  })
}

/** 读 + 解析 JSON 对象；任何问题都直接回响应并返回 undefined。 */
async function readJsonBody(req, res) {
  let text
  try {
    text = await readBody(req)
  } catch (error) {
    if (error && error.status === 413) {
      // task-17：这里**故意不**带 `connection: close`、也**不**主动 `destroy()`。
      // 实测（`_task-17-413-probe.mjs`，真 socket + undici，精确字节数）：
      //   带 close + finish 后 destroy → 超限 >151438 B 就只剩 ECONNRESET（没有响应）
      //   只去掉自己的 destroy         → 撑到 >1 MB 才失败（5 MB 仍失败）
      //   再去掉 connection: close     → 1 B ~ 4 MB 全部拿到 413
      // 原因：超限 body 越大，客户端越可能**还在写**；此时只要服务端关连接（主动 destroy
      // 或 Node 因 close 而收尾），客户端的写失败就早于它读到响应。
      // 现在 readBody 已把余下 body `req.resume()` 排空丢掉，连接保持打开，
      // 客户端写完自己的 body 后正常读到 413，之后按 keep-alive 规则自然关闭。
      // 内存仍有界（只缓冲到 1 MiB，超出即丢）；请求侧超时由 Node 的 requestTimeout 兜。
      sendJson(res, 413, { ok: false, error: { code: 'body-too-large', message: error.message } })
      return undefined
    }
    sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-body', message: `读取请求体失败：${error instanceof Error ? error.message : String(error)}` },
    })
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(text.trim() === '' ? '{}' : text)
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'bad-json', message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}` },
    })
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体必须是 JSON 对象' } })
    return undefined
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 报告归一化
// ---------------------------------------------------------------------------

/** 时间字段：字符串原样，否则当前时间。 */
function asTime(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** `fix` 字段：null 或 `{path, appliedAt, reloaded, rev}`。 */
function normalizeFix(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    appliedAt: asTime(raw.appliedAt, new Date().toISOString()),
    reloaded: raw.reloaded === true,
    rev: typeof raw.rev === 'string' ? raw.rev : null,
  }
}

/** `pr` 字段：null 或 `{url, number, repo, branch, at}`。 */
function normalizePr(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    number: typeof raw.number === 'number' && Number.isFinite(raw.number) ? raw.number : null,
    repo: typeof raw.repo === 'string' ? raw.repo : '',
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    at: asTime(raw.at, new Date().toISOString()),
  }
}

/**
 * 把磁盘上的一条记录修成契约里的完整 Report 形状（字段名与顺序都固定）。
 * 缺字段补默认值，坏记录返回 null（调用方丢弃）。
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function normalizeReport(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null
  const message = typeof raw.message === 'string' ? raw.message : ''
  if (message === '') return null
  const stack = typeof raw.stack === 'string' ? raw.stack : ''
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    fingerprint:
      typeof raw.fingerprint === 'string' && raw.fingerprint !== '' ? raw.fingerprint : fingerprintOf(message, stack),
    firstAt: asTime(raw.firstAt, now),
    lastAt: asTime(raw.lastAt, now),
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) && raw.count >= 1 ? Math.floor(raw.count) : 1,
    source: SOURCES.has(raw.source) ? raw.source : 'manual',
    level: typeof raw.level === 'string' && raw.level !== '' ? raw.level : 'error',
    message,
    stack,
    pluginId: typeof raw.pluginId === 'string' && raw.pluginId !== '' ? raw.pluginId : null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    context: raw.context === undefined ? null : raw.context,
    status: STATUSES.has(raw.status) ? raw.status : 'open',
    fix: normalizeFix(raw.fix),
    pr: normalizePr(raw.pr),
  }
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/**
 * 报告存储：JSONL 文件 + 内存表（**内存里新→旧**，文件里旧→新）。
 *
 * 每次改动都是「读全量 → 改内存 → 写 tmp → rename」的原子整文件写，
 * 不做 append 追加（追加没法原子更新已有的那条报告）。
 *
 * @param {typeof DEFAULTS} config
 */
function createStore(config) {
  const file = resolveStorePath(config)
  /** 新→旧。 */
  const reports = []

  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue // 坏行丢弃，不让一行脏数据毁掉整份报告表
      }
      const normalized = normalizeReport(parsed)
      if (normalized !== null) reports.push(normalized)
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new Error(
        `dsh-bug-reporter: 无法读取报告文件 ${file}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 文件是旧→新，内存要新→旧。
  reports.reverse()

  /** 按 maxReports 丢最旧的（新→旧，所以从尾部丢）。 */
  function trim() {
    while (reports.length > config.maxReports) reports.pop()
  }

  /** 原子落盘：文件按旧→新写，一行一条。 */
  function persist() {
    const lines = []
    for (let i = reports.length - 1; i >= 0; i -= 1) lines.push(JSON.stringify(reports[i]))
    atomicWrite(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  }

  trim()

  return {
    file,

    /** 新→旧。 */
    list() {
      return reports.map((report) => ({ ...report }))
    },

    get(id) {
      return reports.find((report) => report.id === id)
    },

    /**
     * 记一条：同指纹累加 count、更新 lastAt；新指纹则插到最前面。
     * 指纹含 pluginId，所以不同插件的同名报错不会互相合并。
     * @returns {object} 报告
     */
    record(input) {
      const now = new Date().toISOString()
      const fingerprint = fingerprintOf(input.message, input.stack, input.pluginId)
      const existing = reports.find((report) => report.fingerprint === fingerprint)
      if (existing !== undefined) {
        existing.count += 1
        existing.lastAt = now
        persist()
        return { ...existing }
      }
      const report = {
        id: randomUUID(),
        fingerprint,
        firstAt: now,
        lastAt: now,
        count: 1,
        source: SOURCES.has(input.source) ? input.source : 'manual',
        level: typeof input.level === 'string' && input.level !== '' ? input.level : 'error',
        message: String(input.message),
        stack: typeof input.stack === 'string' ? input.stack : '',
        pluginId: typeof input.pluginId === 'string' && input.pluginId !== '' ? input.pluginId : null,
        sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
        context: input.context === undefined ? null : input.context,
        status: 'open',
        fix: null,
        pr: null,
      }
      reports.unshift(report)
      trim()
      persist()
      return { ...report }
    },

    /** 改 status；找不到返回 undefined。 */
    update(id, status) {
      const report = reports.find((item) => item.id === id)
      if (report === undefined) return undefined
      report.status = status
      persist()
      return { ...report }
    },

    /** 标记已修并写 fix。 */
    markFixed(id, fix) {
      const report = reports.find((item) => item.id === id)
      if (report === undefined) return undefined
      report.status = 'fixed'
      report.fix = fix
      persist()
      return { ...report }
    },

    /** 记下 PR。 */
    setPr(id, pr) {
      const report = reports.find((item) => item.id === id)
      if (report === undefined) return undefined
      report.pr = pr
      persist()
      return { ...report }
    },

    /** 删一条；返回是否真的删掉了。 */
    remove(id) {
      const index = reports.findIndex((item) => item.id === id)
      if (index < 0) return false
      reports.splice(index, 1)
      persist()
      return true
    },

    /** 清空；返回清掉的条数。 */
    clear() {
      const count = reports.length
      reports.length = 0
      persist()
      return count
    },
  }
}

// ---------------------------------------------------------------------------
// 修复：找归属包
// ---------------------------------------------------------------------------

/**
 * 从文件路径向上找最近的「含 name 的 package.json」。
 *
 * @param {string} filePath
 * @returns {{name: string, dir: string, hasClient: boolean} | null}
 */
function findOwningPackage(filePath) {
  let dir = dirname(filePath)
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg !== null && typeof pkg === 'object' && typeof pkg.name === 'string' && pkg.name !== '') {
        const dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : undefined
        const client = dsh === undefined ? undefined : dsh.client
        return { name: pkg.name, dir, hasClient: client !== undefined && client !== null }
      }
    } catch {
      /* 没有 package.json / 读不动 / 不是 JSON → 继续向上 */
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 目标文件的**真实路径**：对已存在的最近祖先做 `realpathSync`，再把还不存在的尾段拼回去。
 *
 * 这一步堵的是 junction / symlink 绕过：`pkg-a\esc\escaped.txt` 词法上在包内，
 * 但 `esc\` 是个指向包外的 junction，`realpath` 之后落点才暴露出来。
 *
 * @param {string} absolute 已 `resolve` 的绝对路径
 * @returns {string} 真实路径；连盘根都 realpath 不了时退化为入参
 */
function realpathForWrite(absolute) {
  let dir = absolute
  const tail = []
  for (;;) {
    try {
      const real = realpathSync(dir)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return absolute
      tail.unshift(basename(dir))
      dir = parent
    }
  }
}

/** `child` 是否落在 `root` 目录内（含相等）。Windows 上大小写不敏感。 */
function isInsideDir(root, child) {
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = norm(resolve(root)).replace(/[\\/]+$/, '')
  const target = norm(resolve(child))
  if (base === target) return true
  return target.startsWith(`${base}${sep}`)
}

/**
 * 报告里的 `pluginId` → 该插件包的目录（realpath 后）。
 * 走 `clientModules.clientPath(id)`：它给的是这个插件客户端半区的文件路径，
 * 从它向上找最近的 package.json 就是归属包。软依赖，拿不到一律 null。
 */
function packageDirOfPlugin(pluginId, services) {
  if (typeof pluginId !== 'string' || pluginId === '') return null
  const clientModules = services === null || services === undefined ? undefined : services.clientModules
  if (
    clientModules === null ||
    clientModules === undefined ||
    typeof clientModules.clientPath !== 'function'
  ) {
    return null
  }
  try {
    const file = clientModules.clientPath(pluginId)
    if (typeof file !== 'string' || file === '') return null
    const owner = findOwningPackage(resolve(file))
    return owner === null ? null : realpathForWrite(owner.dir)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/** 一次 GitHub REST 调用 → `{ok, status, json}`。 */
async function github(token, method, path, body) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'dsh-bug-reporter',
    'x-github-api-version': '2022-11-28',
  }
  const init = { method, headers }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await doFetch(`${GITHUB_API}${path}`, init)
  let parsed
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  return { ok: response.ok === true, status: response.status, json: parsed }
}

/** GitHub 失败 → 契约里的错误码。 */
function githubFailure(result) {
  const message =
    result.json !== null && typeof result.json === 'object' && typeof result.json.message === 'string'
      ? result.json.message
      : `GitHub 返回 HTTP ${result.status}`
  if (result.status === 401 || result.status === 403) return fail(401, 'github-unauthorized', message)
  if (result.status === 404) return fail(404, 'repo-not-found', message)
  return fail(502, 'github-error', message)
}

/** PR 正文 / 提交的文件内容：报告全文（+ 已修时附 fix 说明）。 */
function prBody(report) {
  const lines = [
    `# ${firstLine(report.message)}`,
    '',
    '> 由 `dsh-bug-reporter` 自动提交。',
    '',
    '## 报告',
    '',
    `- id: \`${report.id}\``,
    `- fingerprint: \`${report.fingerprint}\``,
    `- source: \`${report.source}\``,
    `- level: \`${report.level}\``,
    `- 次数: ${report.count}`,
    `- 首次: ${report.firstAt}`,
    `- 最近: ${report.lastAt}`,
    `- sessionId: ${report.sessionId === null ? '—' : `\`${report.sessionId}\``}`,
    `- pluginId: ${report.pluginId === null ? '—' : `\`${report.pluginId}\``}`,
    '',
    '### message',
    '',
    '```text',
    report.message,
    '```',
  ]
  if (typeof report.stack === 'string' && report.stack !== '') {
    lines.push('', '### stack', '', '```text', report.stack, '```')
  }
  if (report.context !== null && report.context !== undefined) {
    lines.push('', '### context', '', '```json', JSON.stringify(report.context, null, 2), '```')
  }
  if (report.status === 'fixed' && report.fix !== null) {
    lines.push(
      '',
      '## 修复',
      '',
      `- path: \`${report.fix.path}\``,
      `- appliedAt: ${report.fix.appliedAt}`,
      `- reloaded: ${report.fix.reloaded}`,
      `- rev: ${report.fix.rev === null ? '—' : `\`${report.fix.rev}\``}`,
      '',
      'diff 说明：`/bug-reporter/repair` 对上面的 path 做的是**整文件替换**（先写同目录 tmp 再 rename），' +
        '所以本 PR 里该文件的变更内容就是修复后的完整文件内容。',
    )
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 版本更新（pluginManager 软依赖）
// ---------------------------------------------------------------------------

/**
 * 解析版本号：忽略 `v` 前缀与 `+build` 元数据，拆出三段数字与预发布标识。
 * 非数字段按 0 处理，任何输入都不抛。
 *
 * @param {unknown} value
 * @returns {{parts: number[], prerelease: string}}
 */
function parseVersion(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  const withoutBuild = text.split('+')[0]
  const withoutV = withoutBuild.replace(/^[vV]/, '')
  const dash = withoutV.indexOf('-')
  const core = dash === -1 ? withoutV : withoutV.slice(0, dash)
  const prerelease = dash === -1 ? '' : withoutV.slice(dash + 1)
  const parts = core.split('.').map((piece) => {
    const parsed = Number.parseInt(piece, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  while (parts.length < 3) parts.push(0)
  return { parts: parts.slice(0, 3), prerelease }
}

/** 预发布标识比较（语义化规则：数字标识符 < 字母标识符；前缀相同则短的更小）。 */
function comparePrerelease(left, right) {
  const a = left === '' ? [] : left.split('.')
  const b = right === '' ? [] : right.split('.')
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const size = Math.min(a.length, b.length)
  for (let i = 0; i < size; i += 1) {
    const x = a[i]
    const y = b[i]
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const dx = Number.parseInt(x, 10)
      const dy = Number.parseInt(y, 10)
      if (dx !== dy) return dx < dy ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * 语义化版本比较：a > b → 1，a < b → -1，相等 → 0。
 * `1.0.0-rc.1` < `1.0.0`；`v1.2.0` == `1.2.0`；`1.2.0+build.5` == `1.2.0`。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** 更新类型：主版本 / 次版本 / 修订号变了。 */
function updateKind(installed, latest) {
  const from = parseVersion(installed).parts
  const to = parseVersion(latest).parts
  if (to[0] !== from[0]) return 'major'
  if (to[1] !== from[1]) return 'minor'
  return 'patch'
}

/** `updatePolicy` 允许的更新类型。 */
const POLICY_KINDS = Object.freeze({
  patch: new Set(['patch']),
  minor: new Set(['patch', 'minor']),
  any: new Set(['patch', 'minor', 'major']),
})

/** 该更新类型是否在策略允许范围内（未知策略按 minor 处理，不抛）。 */
function policyAllows(policy, kind) {
  const allowed = Object.hasOwn(POLICY_KINDS, policy) ? POLICY_KINDS[policy] : POLICY_KINDS.minor
  return allowed.has(kind)
}

/**
 * 版本巡检与更新。`pluginManager` 是软依赖：拿不到就保持空 updates + 记一条 log，
 * 绝不抛错。所有外部调用各自 try/catch，单个包失败不影响其余包。
 *
 * @param {typeof DEFAULTS} settings 运行时可改的设置（`ignoredUpdates` 会被整体替换）
 * @param {{pluginManager?: object | null}} services
 * @param {(error: unknown) => void} onWarn
 */
function createUpdateManager(settings, services, onWarn, onSettingsChanged) {
  /** 当前可用更新（含被忽略的，`ignored:true`）。 */
  let current = []
  /** 最近一次巡检时间（epoch ms；0 = 还没查过）。 */
  let lastCheckAt = 0
  /** 更新动作日志，最多 MAX_UPDATE_LOG 条。 */
  const entries = []
  /** 已经记过「跳过」的 key，避免每轮巡检都刷同一条日志。 */
  const skipLogged = new Set()

  function record(moduleName, from, to, result, detail) {
    entries.push({ at: new Date().toISOString(), moduleName, from, to, result, detail })
    while (entries.length > MAX_UPDATE_LOG) entries.shift()
  }

  /** 拿 pluginManager；缺失返回 null（不抛）。 */
  function manager() {
    const candidate = services.pluginManager
    return candidate === null || candidate === undefined ? null : candidate
  }

  /** ignoredUpdates → Set。 */
  function ignoredSet() {
    return new Set(Array.isArray(settings.ignoredUpdates) ? settings.ignoredUpdates : [])
  }

  /** 按当前 ignoredUpdates 重算每条更新的 ignored 标记（不发网络请求）。 */
  function refreshIgnored() {
    const ignored = ignoredSet()
    current = current.map((item) => ({ ...item, ignored: ignored.has(`${item.moduleName}@${item.latest}`) }))
  }

  /** 巡检一次：listBundles → 逐个 inspect → 比较版本。 */
  async function check() {
    const pm = manager()
    if (pm === null || typeof pm.listBundles !== 'function' || typeof pm.inspect !== 'function') {
      current = []
      lastCheckAt = Date.now()
      onWarn(new Error('dsh-bug-reporter: pluginManager 不可用，版本巡检跳过（updates 保持空数组）'))
      return current
    }

    let bundles
    try {
      bundles = await pm.listBundles()
    } catch (error) {
      current = []
      lastCheckAt = Date.now()
      onWarn(error)
      return current
    }

    const ignored = ignoredSet()
    const found = []
    for (const bundle of Array.isArray(bundles) ? bundles : []) {
      const moduleName =
        bundle !== null && typeof bundle === 'object' && typeof bundle.name === 'string' ? bundle.name : ''
      const installed =
        bundle !== null && typeof bundle === 'object' && typeof bundle.version === 'string' ? bundle.version : ''
      // 没名字或没版本（例如 not-bundle 行）的跳过。
      if (moduleName === '' || installed === '') continue
      let latest = ''
      try {
        const inspected = await pm.inspect(moduleName)
        // refused / 形状不对 → 这个包不进 updates，也不影响别的包。
        if (inspected === null || inspected === undefined || inspected.status !== 'accepted') continue
        latest = typeof inspected.version === 'string' ? inspected.version : ''
      } catch (error) {
        onWarn(error)
        continue
      }
      // 没有最新版、或最新版不比已装的新（含降级）→ 不算可用更新。
      if (latest === '' || compareVersions(latest, installed) <= 0) continue
      found.push({
        moduleName,
        installed,
        latest,
        kind: updateKind(installed, latest),
        ignored: ignored.has(`${moduleName}@${latest}`),
      })
    }
    current = found
    lastCheckAt = Date.now()
    return current
  }

  /**
   * 装一个包。硬错误（pluginManager 没了 / installBundle 抛了）往外抛，由路由转成
   * `operation-failed`；软失败（application 是 failed / cancelled / overridden）只记 log。
   */
  async function applyOne(moduleName) {
    const pm = manager()
    if (pm === null || typeof pm.installBundle !== 'function') {
      throw new Error('dsh-bug-reporter: pluginManager 不可用，无法安装')
    }
    const item = current.find((candidate) => candidate.moduleName === moduleName)
    const from = item === undefined ? '' : item.installed
    const to = item === undefined ? '' : item.latest

    let result
    try {
      result = await pm.installBundle(moduleName)
    } catch (error) {
      record(moduleName, from, to, 'failed', error instanceof Error ? error.message : String(error))
      throw error
    }

    const application =
      result !== null && typeof result === 'object' && typeof result.application === 'string'
        ? result.application
        : 'failed'
    // 只有 applied 才算真的生效；restart-required 如实记下来，不谎报。
    const outcome =
      application === 'applied' ? 'applied' : application === 'restart-required' ? 'restart-required' : 'failed'
    const detail = [`application=${application}`]
    if (result !== null && typeof result === 'object') {
      if (typeof result.version === 'string') detail.push(`version=${result.version}`)
      if (typeof result.restartReason === 'string') detail.push(`restartReason=${result.restartReason}`)
      const errorCode =
        result.error !== null && result.error !== undefined && typeof result.error === 'object'
          ? result.error.code
          : undefined
      if (typeof errorCode === 'string') detail.push(`error=${errorCode}`)
    }
    record(moduleName, from, to, outcome, detail.join(' '))
    // 装过之后就不再是「可用更新」。
    current = current.filter((candidate) => candidate.moduleName !== moduleName)
    return { application, outcome }
  }

  /** autoUpdate 打开时按 updatePolicy 自动装；被忽略 / 不在策略内的只记一次 skipped。 */
  async function autoApply() {
    if (settings.autoUpdate !== true) return
    for (const item of [...current]) {
      const key = `${item.moduleName}@${item.latest}`
      if (item.ignored) {
        if (!skipLogged.has(`ignored:${key}`)) {
          skipLogged.add(`ignored:${key}`)
          record(item.moduleName, item.installed, item.latest, 'skipped', '在 ignoredUpdates 中')
        }
        continue
      }
      if (!policyAllows(settings.updatePolicy, item.kind)) {
        const reason = `policy:${key}:${settings.updatePolicy}`
        if (!skipLogged.has(reason)) {
          skipLogged.add(reason)
          record(
            item.moduleName,
            item.installed,
            item.latest,
            'skipped',
            `updatePolicy=${settings.updatePolicy} 不含 ${item.kind}`,
          )
        }
        continue
      }
      try {
        await applyOne(item.moduleName)
      } catch (error) {
        onWarn(error)
      }
    }
  }

  /** 巡检 + （autoUpdate 时）自动装。任何失败都吞成 log，绝不外抛。 */
  async function runCheck() {
    try {
      await check()
      await autoApply()
    } catch (error) {
      onWarn(error)
    }
    return current
  }

  /** 切换忽略：`moduleName@version` 已在列表里就取消，否则加入。 */
  function toggleIgnore(moduleName, version) {
    const key = `${moduleName}@${version}`
    const list = Array.isArray(settings.ignoredUpdates) ? [...settings.ignoredUpdates] : []
    const at = list.indexOf(key)
    if (at === -1) list.push(key)
    else list.splice(at, 1)
    settings.ignoredUpdates = list
    refreshIgnored()
    // task-19：ignoredUpdates 也是 settings，改了要落盘（否则重启后忽略列表失忆）。
    if (typeof onSettingsChanged === 'function') onSettingsChanged()
    return at === -1
  }

  return {
    list() {
      return current.map((item) => ({ ...item }))
    },
    log() {
      return entries.map((entry) => ({ ...entry }))
    },
    lastCheckAt() {
      return lastCheckAt
    },
    has(moduleName) {
      return current.some((item) => item.moduleName === moduleName)
    },
    check,
    runCheck,
    applyOne,
    toggleIgnore,
    ignoredSet,
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

/**
 * 造出 `/bug-reporter` 前缀路由的 handler。
 *
 * @param {ReturnType<typeof createStore>} store
 * @param {typeof DEFAULTS} settings 运行时可改的设置（与 config 同键）
 * @param {{credentials: object | null, clientModules: object | null}} services
 * @param {() => void} onSettingsChanged 设置变化后的副作用（重挂 process 钩子）
 * @param {ReturnType<typeof createUpdateManager>} updates 版本巡检与更新
 */
// ---------------------------------------------------------------------------
// 跨站防护（task-15 S1）
// ---------------------------------------------------------------------------

/** 解析 Origin 的 host；非法 / 空 → null。 */
function originHostOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = new URL(value)
    return parsed.host === '' ? null : parsed.host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 服务端自己的 host：优先 `webServer.getOrigin()`，退化到本次请求的 `Host` 头。
 * `webServer` 是软依赖，`getOrigin` 也可能不存在 / 抛错 —— 一律不冒泡。
 */
function selfHostOf(services, req) {
  const webServer = services === null || services === undefined ? undefined : services.webServer
  if (webServer !== null && webServer !== undefined && typeof webServer.getOrigin === 'function') {
    try {
      const origin = webServer.getOrigin()
      const text =
        typeof origin === 'string'
          ? origin
          : origin === null || origin === undefined
            ? ''
            : origin.origin
      const host = originHostOf(text)
      if (host !== null) return host
    } catch {
      /* 软依赖：拿不到就退化到 Host 头 */
    }
  }
  const headers =
    req === null || req === undefined || req.headers === null || req.headers === undefined ? {} : req.headers
  const header = headers.host
  return typeof header === 'string' && header !== '' ? header.toLowerCase() : null
}

/** host 是否同源可比：完全相同，或都是 loopback 别名且端口相同。 */
function sameHost(a, b) {
  if (a === null || b === null) return false
  if (a === b) return true
  const split = (value) => {
    const index = value.lastIndexOf(':')
    return index < 0
      ? { name: value, port: '' }
      : { name: value.slice(0, index), port: value.slice(index + 1) }
  }
  const left = split(a)
  const right = split(b)
  // `localhost` 与 `127.0.0.1` / `[::1]` 指向同一台机器：浏览器地址栏写哪个都可能，
  // 不认这个等价关系会把设置页自己 403 掉（跨站域名永远匹配不上，防护不受影响）。
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  return left.port === right.port && loopback.has(left.name) && loopback.has(right.name)
}

/**
 * 跨站防护：`/bug-reporter` 前缀下的**所有**路径统一过一遍。
 *
 * 背景：DSH 的 webServer 契约就是 `{kind, path, handler}`，没有全局 Origin/CSRF 防护。
 * 任意网页都能用 `content-type: text/plain` 发**跨站简单请求**（不触发预检）打到这里，
 * 而且请求会在服务端真的执行 —— `/report/clear`（清空报告）、`/state`（改 repo）、
 * `/repair`（往包目录写文件 → 下次加载即代码执行）全都在射程内。
 *
 * 三道闸：
 * 1. `Sec-Fetch-Site: cross-site` → 403 `cross-site`
 * 2. `Origin` 存在时必须同源，否则 403 `bad-origin`；**Origin 缺失时放行**
 *    （curl / 本机原生客户端要能用）
 * 3. `POST` 必须 `content-type: application/json` → 否则 415 `unsupported-media-type`。
 *    这是结构性防线：跨站想带 JSON content-type 就会触发 CORS 预检，而本服务不返回任何
 *    `Access-Control-Allow-*`，浏览器会把请求拦在预检阶段。
 *
 * @returns {boolean} true = 已经回过响应，调用方直接 return。
 */
function rejectCrossSite(req, res, services, method) {
  const headers =
    req === null || req === undefined || req.headers === null || req.headers === undefined ? {} : req.headers

  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') {
    sendJson(res, 403, {
      ok: false,
      error: { code: 'cross-site', message: '拒绝跨站请求（Sec-Fetch-Site: cross-site）' },
    })
    return true
  }

  const origin = headers.origin
  if (typeof origin === 'string' && origin.trim() !== '') {
    const got = originHostOf(origin)
    const want = selfHostOf(services, req)
    if (!sameHost(got, want)) {
      sendJson(res, 403, {
        ok: false,
        error: { code: 'bad-origin', message: `拒绝来源 ${origin}：与本机不同源` },
      })
      return true
    }
  }

  if (method === 'POST') {
    const raw = headers['content-type']
    const base = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
    if (base !== 'application/json') {
      sendJson(res, 415, {
        ok: false,
        error: {
          code: 'unsupported-media-type',
          message: 'POST 必须使用 content-type: application/json',
        },
      })
      return true
    }
  }

  return false
}

function createHttpHandler(store, settings, services, onSettingsChanged, updates, resetSettings) {
  /** `credentials.resolve(tokenRef)` → token；拿不到就 undefined，绝不抛。 */
  async function credentialsToken() {
    const credentials = services.credentials
    if (credentials === null || typeof credentials.resolve !== 'function') return undefined
    try {
      const resolved = await credentials.resolve(settings.tokenRef)
      const value = resolved !== null && typeof resolved === 'object' ? resolved.value : undefined
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 提交用 token：先凭据服务，再 `gh auth token`。 */
  async function submitToken() {
    const fromCredentials = await credentialsToken()
    if (fromCredentials !== undefined) return fromCredentials
    if (ghTokenOverride !== null) {
      try {
        const value = await ghTokenOverride()
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }
    try {
      return await runGhAuthToken()
    } catch {
      return undefined
    }
  }

  /** GET / POST /state 的 value。 */
  async function stateValue() {
    const token = await credentialsToken()
    return {
      enabled: settings.enabled,
      captureTools: settings.captureTools,
      captureProcess: settings.captureProcess,
      repairEnabled: settings.repairEnabled,
      repo: settings.repo,
      tokenRef: settings.tokenRef,
      baseBranch: settings.baseBranch,
      tokenConfigured: token !== undefined,
      storeFile: store.file,
      reports: store.list(),
      // task-12 新增（只做加法，上面的字段一个没动）。
      updates: updates.list(),
      lastUpdateCheckAt: updates.lastCheckAt(),
      updateLog: updates.log(),
    }
  }

  /** 校验 `POST /state` 的补丁：只认 PATCHABLE，类型不对就 400。 */
  function parseStatePatch(body) {
    const patch = {}
    for (const key of PATCHABLE) {
      if (!Object.hasOwn(body, key)) continue
      const value = body[key]
      if (BOOLEAN_KEYS.has(key)) {
        if (typeof value !== 'boolean') throw fail(400, 'invalid-state', `state.${key} 必须是 boolean`)
      } else if (typeof value !== 'string') {
        throw fail(400, 'invalid-state', `state.${key} 必须是 string`)
      }
      patch[key] = value
    }
    return patch
  }

  /** `POST /repair`。 */
  async function handleRepair(body) {
    if (settings.repairEnabled !== true) {
      throw fail(403, 'repair-disabled', 'repairEnabled 为 false，/repair 已被禁用')
    }
    const id = body.id
    const target = body.path
    const content = body.content
    if (typeof id !== 'string' || id === '') throw fail(400, 'invalid-request', '缺少 id')
    if (typeof target !== 'string' || target.trim() === '') throw fail(400, 'invalid-request', '缺少 path')
    if (typeof content !== 'string') throw fail(400, 'invalid-request', '缺少 content（必须是字符串）')
    const existing = store.get(id)
    if (existing === undefined) throw fail(404, 'not-found', `找不到报告 ${id}`)

    const absolute = resolve(target)

    // --- 路径围栏（task-15 S2 收紧）-------------------------------------------
    // 原来只有「必须有 package.json 祖先」一条，实测 4 种绕过：穿越到别的包、
    // 直接改别的包、改 package.json、junction（词法在包内 / 物理在包外）。
    // 现在按顺序过 4 道：
    //   1) NUL / UNC 直接拒
    //   2) realpath 之后判定（堵 junction / symlink）
    //   3) 目标必须在 config.repairRoots，或该报告 pluginId 对应包的目录内
    //      —— 只能修「这条报告所属的那个插件」；pluginId 缺失 / 解析不出包目录
    //      又不在 repairRoots 里就一律拒（默认 repairRoots 为空 = 没有 pluginId 就不许修）
    //   4) 拒 package.json（改 manifest 等于换插件）+ 扩展名白名单
    if (absolute.includes('\u0000')) {
      throw fail(403, 'path-not-allowed', '拒绝写入：路径含 NUL 字节')
    }
    if (/^[\\/]{2}/.test(target) || /^[\\/]{2}/.test(absolute)) {
      throw fail(403, 'path-not-allowed', `拒绝写入 ${target}：不接受 UNC 路径`)
    }

    const real = realpathForWrite(absolute)
    if (real.includes('\u0000')) {
      throw fail(403, 'path-not-allowed', '拒绝写入：真实路径含 NUL 字节')
    }

    const roots = []
    for (const root of settings.repairRoots) {
      if (typeof root !== 'string' || root.trim() === '') continue
      roots.push(realpathForWrite(resolve(root)))
    }
    const pluginDir = packageDirOfPlugin(existing.pluginId, services)
    if (pluginDir !== null) roots.push(pluginDir)

    const pkg = findOwningPackage(real)
    if (!roots.some((root) => isInsideDir(root, real))) {
      throw fail(
        403,
        'path-not-allowed',
        `拒绝写入 ${real}：它不在报告所属插件（${existing.pluginId === null ? '无 pluginId' : existing.pluginId}）的包目录内，也不在 config.repairRoots 里`,
      )
    }
    if (basename(real).toLowerCase() === 'package.json') {
      throw fail(403, 'path-not-allowed', '拒绝写入 package.json：改 manifest 等于换插件')
    }
    const ext = extname(real).toLowerCase()
    if (!ALLOWED_REPAIR_EXT.has(ext)) {
      throw fail(
        403,
        'path-not-allowed',
        `拒绝写入 ${real}：只允许改源码/资源文件（${[...ALLOWED_REPAIR_EXT].join(' ')}）`,
      )
    }

    atomicWrite(real, content)

    let reloaded = false
    let rev = null
    if (
      pkg !== null &&
      pkg.hasClient &&
      services.clientModules !== null &&
      typeof services.clientModules.rebuilt === 'function'
    ) {
      const value = services.clientModules.rebuilt(pkg.name)
      if (typeof value === 'string') {
        reloaded = true
        rev = value
      }
    }

    const fix = { path: absolute, appliedAt: new Date().toISOString(), reloaded, rev }
    const report = store.markFixed(id, fix)
    return { report, fix }
  }

  /** `POST /submit`：建分支 → 放文件 → 开 PR。 */
  async function handleSubmit(body) {
    const id = body.id
    if (typeof id !== 'string' || id === '') throw fail(400, 'invalid-request', '缺少 id')
    const report = store.get(id)
    if (report === undefined) throw fail(404, 'not-found', `找不到报告 ${id}`)

    const token = await submitToken()
    if (token === undefined) {
      throw fail(401, 'no-token', '没有可用的 GitHub token：credentials.resolve 与 `gh auth token` 都拿不到')
    }

    const contextRepo =
      report.context !== null && typeof report.context === 'object' && typeof report.context.repo === 'string'
        ? report.context.repo
        : ''
    const repo =
      (typeof body.repo === 'string' ? body.repo.trim() : '') || settings.repo.trim() || contextRepo.trim()
    if (repo === '') {
      throw fail(400, 'no-repo', '没有目标仓库：请填 repo 设置，或用 config.repo / 请求体的 repo')
    }
    const requestedBase = (typeof body.baseBranch === 'string' ? body.baseBranch.trim() : '') || settings.baseBranch.trim()

    const branch = `bug-report/${report.fingerprint.slice(0, 12)}`
    const title = `[bug-reporter] ${firstLine(report.message).slice(0, 72)}`

    let repoInfo
    let baseRef
    let created
    let put
    let pull
    try {
      repoInfo = await github(token, 'GET', `/repos/${repo}`)
      if (!repoInfo.ok) throw githubFailure(repoInfo)
      const repoDefault =
        repoInfo.json !== null && typeof repoInfo.json === 'object' && typeof repoInfo.json.default_branch === 'string'
          ? repoInfo.json.default_branch
          : ''
      // 请求体 / config 指定的基分支优先，否则用仓库默认分支，再兜底 main。
      const base = requestedBase !== '' ? requestedBase : repoDefault === '' ? 'main' : repoDefault

      baseRef = await github(token, 'GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`)
      if (!baseRef.ok) throw githubFailure(baseRef)
      const sha =
        baseRef.json !== null && typeof baseRef.json === 'object' && baseRef.json.object !== null && typeof baseRef.json.object === 'object'
          ? baseRef.json.object.sha
          : undefined
      if (typeof sha !== 'string' || sha === '') {
        throw fail(502, 'github-error', `无法解析 ${repo}@${base} 的 sha`)
      }

      created = await github(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
      // 422 = 分支已存在 → 复用，不报错。
      if (!created.ok && created.status !== 422) throw githubFailure(created)

      const filePath = `bug-reports/${compactTimestamp()}-${slugify(report.message)}.md`
      const markdown = prBody(report)
      put = await github(token, 'PUT', `/repos/${repo}/contents/${filePath}`, {
        message: title,
        content: Buffer.from(markdown, 'utf8').toString('base64'),
        branch,
      })
      if (!put.ok) throw githubFailure(put)

      pull = await github(token, 'POST', `/repos/${repo}/pulls`, {
        title,
        head: branch,
        base,
        body: markdown,
      })
      if (!pull.ok) throw githubFailure(pull)
    } catch (error) {
      if (error && typeof error.status === 'number') throw error
      throw fail(502, 'github-error', `GitHub 请求失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const pr = {
      url:
        pull.json !== null && typeof pull.json === 'object' && typeof pull.json.html_url === 'string'
          ? pull.json.html_url
          : '',
      number:
        pull.json !== null && typeof pull.json === 'object' && typeof pull.json.number === 'number'
          ? pull.json.number
          : null,
      repo,
      branch,
      at: new Date().toISOString(),
    }
    const updated = store.setPr(id, pr)
    return { report: updated === undefined ? report : updated, pr }
  }

  /** 前缀路由的总入口。 */
  return async function handle(req, res) {
    let pathname
    try {
      pathname = new URL(req.url === undefined || req.url === null ? '/' : req.url, 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-url', message: '无法解析请求 URL' } })
      return
    }

    const method = req.method === undefined || req.method === null ? 'GET' : req.method

    // 跨站防护：所有路径、所有方法统一先过一遍（task-15 S1）。
    if (rejectCrossSite(req, res, services, method)) return

    try {
      if (pathname === `${ROUTE_PREFIX}/state`) {
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, value: await stateValue() })
          return
        }
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        Object.assign(settings, parseStatePatch(body))
        onSettingsChanged()
        sendJson(res, 200, { ok: true, value: await stateValue() })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/settings/reset`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        // 清空持久化文件 + 回到 cordis.patch.yml 的值（task-19）。**不删报告。**
        resetSettings()
        sendJson(res, 200, { ok: true, value: await stateValue() })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/report`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const message = body.message
        if (typeof message !== 'string' || message.trim() === '') {
          throw fail(400, 'invalid-report', 'report.message 必须是非空字符串')
        }
        const source = body.source === undefined ? 'manual' : body.source
        if (!SOURCES.has(source)) {
          throw fail(400, 'invalid-report', `report.source 非法：${JSON.stringify(source)}`)
        }
        if (body.stack !== undefined && typeof body.stack !== 'string') {
          throw fail(400, 'invalid-report', 'report.stack 必须是 string')
        }
        if (body.level !== undefined && typeof body.level !== 'string') {
          throw fail(400, 'invalid-report', 'report.level 必须是 string')
        }
        if (body.pluginId !== undefined && typeof body.pluginId !== 'string') {
          throw fail(400, 'invalid-report', 'report.pluginId 必须是 string')
        }
        if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
          throw fail(400, 'invalid-report', 'report.sessionId 必须是 string')
        }
        const report = store.record({
          source,
          level: body.level === undefined ? 'error' : body.level,
          message,
          stack: body.stack === undefined ? '' : body.stack,
          pluginId: body.pluginId === undefined ? null : body.pluginId,
          sessionId: body.sessionId === undefined ? null : body.sessionId,
          context: jsonSafe(body.context),
        })
        sendJson(res, 200, { ok: true, value: { report } })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/report/update`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        if (typeof body.id !== 'string' || body.id === '') throw fail(400, 'invalid-request', '缺少 id')
        if (!STATUSES.has(body.status)) {
          throw fail(400, 'invalid-status', `status 非法：${JSON.stringify(body.status)}`)
        }
        const report = store.update(body.id, body.status)
        if (report === undefined) throw fail(404, 'not-found', `找不到报告 ${body.id}`)
        sendJson(res, 200, { ok: true, value: { report } })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/report/delete`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        if (typeof body.id !== 'string' || body.id === '') throw fail(400, 'invalid-request', '缺少 id')
        if (!store.remove(body.id)) throw fail(404, 'not-found', `找不到报告 ${body.id}`)
        sendJson(res, 200, { ok: true, value: { deleted: true } })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/report/clear`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        sendJson(res, 200, { ok: true, value: { cleared: store.clear() } })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/repair`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        sendJson(res, 200, { ok: true, value: await handleRepair(body) })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/submit`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        sendJson(res, 200, { ok: true, value: await handleSubmit(body) })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/update/check`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        // runCheck 内部把所有失败吞成 log，不会抛。
        await updates.runCheck()
        sendJson(res, 200, { ok: true, value: await stateValue() })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/update/apply`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const moduleName = typeof body.moduleName === 'string' ? body.moduleName.trim() : ''
        if (moduleName === '') throw fail(400, 'missing-param', '缺少 moduleName')
        // 手动安装不受 autoUpdate 限制，但必须是当前巡检出来的可用更新。
        if (!updates.has(moduleName)) {
          throw fail(404, 'unknown-module', `当前可用更新里没有 ${moduleName}`)
        }
        try {
          await updates.applyOne(moduleName)
        } catch (error) {
          throw fail(
            502,
            'operation-failed',
            `安装 ${moduleName} 失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
        sendJson(res, 200, { ok: true, value: await stateValue() })
        return
      }

      if (pathname === `${ROUTE_PREFIX}/update/ignore`) {
        if (method !== 'POST') throw fail(405, 'method-not-allowed', `不支持 ${method}`)
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        const moduleName = typeof body.moduleName === 'string' ? body.moduleName.trim() : ''
        const version = typeof body.version === 'string' ? body.version.trim() : ''
        if (moduleName === '') throw fail(400, 'missing-param', '缺少 moduleName')
        if (version === '') throw fail(400, 'missing-param', '缺少 version')
        // 再发一次同样参数 = 取消忽略。
        updates.toggleIgnore(moduleName, version)
        sendJson(res, 200, { ok: true, value: await stateValue() })
        return
      }

      throw fail(404, 'not-found', `未知路径 ${pathname}`)
    } catch (error) {
      if (error && typeof error.status === 'number') {
        sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        return
      }
      sendJson(res, 500, {
        ok: false,
        error: {
          code: 'internal',
          message: `dsh-bug-reporter 内部错误：${error instanceof Error ? error.message : String(error)}`,
        },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

/**
 * 挂载宿主半区。
 *
 * @param {object} ctx cordis Context
 * @param {unknown} rawConfig 插件配置（见 DEFAULTS）
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  // enabled: false —— 整行不挂载（与 cordis.patch.yml 的说明一致）。
  if (!config.enabled) return

  // task-19：先把界面上改过的设置读回来（**文件优先于 yml**），再建内存设置对象。
  const persisted = loadPersistedSettings(ctx, config)

  /** 运行时可改的设置；与 config 同键，初值来自 config，被持久化文件覆盖。 */
  const settings = { ...config, ...persisted }
  // 两个数组键必须各持一份自己的副本（沿用原写法，避免与 config 共享引用）。
  settings.ignoredUpdates = [...settings.ignoredUpdates]
  settings.repairRoots = [...settings.repairRoots]
  const store = createStore(config)
  const services = { credentials: null, clientModules: null, pluginManager: null }
  /** hmr/reload 的观察记录（只观察，不产生报告）。 */
  const reloadEvents = []
  /** 版本巡检与更新（pluginManager 软依赖；拿不到就只保持空 updates）。 */
  const updates = createUpdateManager(settings, services, (error) => warn(ctx, error), () => onSettingsChanged())

  /** 所有捕获点的公共入口：关了就不记，记失败也绝不冒泡。 */
  function capture(input) {
    if (settings.enabled !== true) return undefined
    try {
      return store.record(input)
    } catch (error) {
      warn(ctx, error)
      return undefined
    }
  }

  // --- 事件捕获 ------------------------------------------------------------

  // 主捕获点：一个 step / turn 出错。
  ctx.on('agent/error', (payload) => {
    if (settings.enabled !== true) return
    const info = describeError(payload === null || payload === undefined ? undefined : payload.error)
    const agent = payload === null || payload === undefined ? undefined : payload.agent
    capture({
      source: 'agent/error',
      level: 'error',
      message: info.message,
      stack: info.stack,
      sessionId: agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : null,
      context: jsonSafe({
        turn: payload === null || payload === undefined ? undefined : payload.turn,
        step: payload === null || payload === undefined ? undefined : payload.step,
      }),
    })
  })

  // Agent 在持久 turn 位之外失败。
  ctx.on('api-session/error', (sessionId, message) => {
    if (settings.enabled !== true) return
    const text = typeof message === 'string' && message !== '' ? message : '未知的会话错误'
    capture({
      source: 'api-session/error',
      level: 'error',
      message: text,
      sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    })
  })

  // 声明式 agent 条目在发布成活的 agent 之前就失败了。
  ctx.on('agent-loop/config-start-failed', (payload) => {
    if (settings.enabled !== true) return
    const info = describeError(payload === null || payload === undefined ? undefined : payload.error)
    const sessionId = payload === null || payload === undefined ? undefined : payload.sessionId
    capture({
      source: 'agent-loop/config-start-failed',
      level: 'error',
      message: info.message,
      stack: info.stack,
      sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    })
  })

  // 冻结的最终工具结果：只有 isError 才记。
  ctx.on('tools/result', (exec, result) => {
    if (settings.enabled !== true || settings.captureTools !== true) return
    if (result === null || result === undefined || result.isError !== true) return
    const name =
      exec !== null && exec !== undefined && typeof exec.name === 'string' && exec.name !== '' ? exec.name : 'unknown'
    const failure =
      result.error !== null && result.error !== undefined && typeof result.error === 'object' ? result.error : {}
    const detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : ''
    const args = exec === null || exec === undefined ? undefined : exec.arguments
    const file =
      args !== null && args !== undefined && typeof args === 'object' && typeof args.path === 'string' ? args.path : undefined
    const info = failure.info !== null && failure.info !== undefined && typeof failure.info === 'object' ? failure.info : {}
    const agent = exec === null || exec === undefined ? undefined : exec.agent
    capture({
      source: 'tools/result',
      level: 'error',
      message: detail === '' ? `工具 ${name} 执行失败` : `工具 ${name} 执行失败：${detail}`,
      sessionId: agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : null,
      // file 是给浏览器半区的修复面板预填路径用的（客户端读 context.file）。
      context: jsonSafe({ tool: name, code: typeof info.code === 'string' ? info.code : null, file, arguments: args }),
    })
  })

  // 可选：只观察热重载，不产生报告。
  ctx.on('hmr/reload', (reloads) => {
    try {
      const ids = reloads instanceof Map ? Array.from(reloads.keys(), (key) => (key && typeof key.name === 'string' ? key.name : String(key))) : []
      reloadEvents.push({ at: new Date().toISOString(), ids })
      while (reloadEvents.length > MAX_RELOAD_EVENTS) reloadEvents.shift()
    } catch (error) {
      warn(ctx, error)
    }
  })

  // --- process 级捕获 ------------------------------------------------------

  /**
   * uncaughtException：记录 → 摘掉自己的监听器 → 把原始值抛回去。
   * 摘掉之后再抛，Node 就回到默认路径（打印 + 非 0 退出），所以是「只记录，绝不吞掉」。
   */
  const onUncaught = (error) => {
    try {
      const info = describeError(error)
      capture({ source: 'process', level: 'error', message: info.message, stack: info.stack, context: { kind: 'uncaughtException' } })
    } catch {
      /* 记录失败也要继续把异常抛回去 */
    }
    process.removeListener('uncaughtException', onUncaught)
    setImmediate(() => {
      throw error
    })
  }

  /** unhandledRejection：同上，抛回原始 reason。 */
  const onRejection = (reason) => {
    try {
      const info = describeError(reason)
      capture({ source: 'process', level: 'error', message: info.message, stack: info.stack, context: { kind: 'unhandledRejection' } })
    } catch {
      /* 同上 */
    }
    process.removeListener('unhandledRejection', onRejection)
    setImmediate(() => {
      throw reason
    })
  }

  /** 按当前设置增删 process 监听器；captureProcess / enabled 关掉时完全摘除。 */
  function syncProcessHooks() {
    const want = settings.enabled === true && settings.captureProcess === true
    const hasUncaught = process.listeners('uncaughtException').includes(onUncaught)
    const hasRejection = process.listeners('unhandledRejection').includes(onRejection)
    if (want) {
      if (!hasUncaught) process.on('uncaughtException', onUncaught)
      if (!hasRejection) process.on('unhandledRejection', onRejection)
    } else {
      if (hasUncaught) process.removeListener('uncaughtException', onUncaught)
      if (hasRejection) process.removeListener('unhandledRejection', onRejection)
    }
  }

  ctx.effect(
    () => {
      syncProcessHooks()
      return () => {
        process.removeListener('uncaughtException', onUncaught)
        process.removeListener('unhandledRejection', onRejection)
      }
    },
    'dsh-bug-reporter: process 级捕获',
  )

  /**
   * 设置变更后的副作用（task-19）：重挂 process 钩子 + **原子写盘**。
   * 写盘失败只 warn —— 一个记不住的设置也不该把主流程搞挂。
   */
  function onSettingsChanged() {
    syncProcessHooks()
    saveSettings(ctx, settings)
  }

  /**
   * 「恢复默认」（task-19）：删掉持久化文件，并把内存设置还原成 `cordis.patch.yml` 的值。
   * **只重置设置，一条报告都不动**（报告在另一个文件里，由 store 自己管）。
   * 必须原地改 `settings`：capture() / updates 等闭包都持有这个对象引用。
   */
  function resetSettings() {
    try {
      rmSync(resolveSettingsPath(settings), { force: true })
    } catch (error) {
      warn(ctx, error)
    }
    for (const key of Object.keys(settings)) delete settings[key]
    Object.assign(settings, config)
    settings.ignoredUpdates = [...config.ignoredUpdates]
    settings.repairRoots = [...config.repairRoots]
    syncProcessHooks()
  }

  // --- 软依赖 --------------------------------------------------------------

  // webServer：设置页要用的 HTTP 路由。没有它，捕获与存储照常工作。
  ctx.inject(['webServer'], (scoped) => {
    // 跨站防护要拿服务端自己的 origin 做同源比对（webServer.getOrigin()），
    // 所以把句柄也存进 services；拿不到时 handler 会退化成比对 Host 头，不会崩。
    services.webServer = scoped.webServer
    const handler = createHttpHandler(store, settings, services, onSettingsChanged, updates, resetSettings)
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-bug-reporter: 设置页路由',
    )
    scoped.effect(
      () => () => {
        services.webServer = null
      },
      'dsh-bug-reporter: webServer 句柄',
    )
  })

  // credentials：取 GitHub token。每次操作现取，不缓存。
  ctx.inject(['credentials'], (scoped) => {
    services.credentials = scoped.credentials
    scoped.effect(
      () => () => {
        services.credentials = null
      },
      'dsh-bug-reporter: credentials 句柄',
    )
  })

  // clientModules：修复后发布新的 bundle 代次，触发浏览器热更新。
  ctx.inject(['clientModules'], (scoped) => {
    services.clientModules = scoped.clientModules
    scoped.effect(
      () => () => {
        services.clientModules = null
      },
      'dsh-bug-reporter: clientModules 句柄',
    )
  })

  // pluginManager：查已装版本（listBundles）、查最新版（inspect）、装新版（installBundle）。
  // 没有它就不巡检，updates 保持空数组，其余能力照常。
  ctx.inject(['pluginManager'], (scoped) => {
    services.pluginManager = scoped.pluginManager
    scoped.effect(
      () => () => {
        services.pluginManager = null
      },
      'dsh-bug-reporter: pluginManager 句柄',
    )
  })

  // timer：挂载后先短延迟查一次，然后按 updateCheckMs 实时巡检。没有 timer 就不巡检。
  ctx.inject(['timer'], (scoped) => {
    const delay =
      Number.isFinite(settings.updateCheckMs) && settings.updateCheckMs >= MIN_UPDATE_CHECK_MS
        ? settings.updateCheckMs
        : DEFAULTS.updateCheckMs
    // 首次巡检。timeout 的 disposer 交给 effect，dispose 之后这次待触发的巡检不会跑。
    scoped.effect(
      () =>
        scoped.timer.timeout(() => {
          // runCheck 内部把一切失败吞成 log；这里再兜一层，绝不产生未处理 rejection。
          updates.runCheck().catch((error) => warn(ctx, error))
        }, FIRST_UPDATE_CHECK_MS),
      'dsh-bug-reporter: 首次版本巡检',
    )
    // 之后按 updateCheckMs 轮询。首次那次不改变轮询节奏。
    scoped.effect(
      () =>
        scoped.timer.interval(() => {
          updates.runCheck().catch((error) => warn(ctx, error))
        }, delay),
      'dsh-bug-reporter: 版本巡检轮询',
    )
  })

  // --- 测试与自检用的内部句柄 ---------------------------------------------

  internals.active = { store, settings, services, reloadEvents, capture, syncProcessHooks, updates }
}

/**
 * 内部句柄。宿主 Loader 只用 `apply`，这里是给 `_bug-check.mjs` 与排障用的：
 * 想验证 process 钩子、替换 fetch / gh、或读热重载观察记录时用得上。
 */
export const internals = {
  resolveConfig,
  fingerprintOf,
  normalizeReport,
  findOwningPackage,
  prBody,
  slugify,
  createStore,
  DEFAULTS,
  ROUTE_PREFIX,
  // task-12：版本更新相关的可测单元。
  createUpdateManager,
  compareVersions,
  parseVersion,
  updateKind,
  policyAllows,
  UPDATE_POLICIES,
  MIN_UPDATE_CHECK_MS,
  MAX_UPDATE_LOG,
  /** 最近一次 apply 的内部状态；没有 apply 过就是 null。 */
  active: null,
  /** 替换 fetch（传 null 恢复 globalThis.fetch）。 */
  setFetch(fn) {
    fetchOverride = fn === undefined ? null : fn
  },
  /** 替换 `gh auth token`（传 null 恢复真实执行）。 */
  setGhTokenRunner(fn) {
    ghTokenOverride = fn === undefined ? null : fn
  },
  /** 恢复两个外部调用。 */
  resetOverrides() {
    fetchOverride = null
    ghTokenOverride = null
  },
  /** 热重载观察记录（副本）。 */
  reloads() {
    return internals.active === null ? [] : internals.active.reloadEvents.map((event) => ({ ...event }))
  },
}
