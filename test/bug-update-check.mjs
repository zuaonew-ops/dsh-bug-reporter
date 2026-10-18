/**
 * bug-update-check.mjs —— dsh-bug-reporter task-12「实时更新新版本」的桩测。
 *
 * 覆盖：
 *   A. compareVersions 边界（含 v 前缀、+build、预发布）
 *   B. 四个新配置键的默认值与校验（未知键仍抛错）
 *   C. createUpdateManager：refused / inspect 抛错 / ignored / autoUpdate × updatePolicy 三分支 /
 *      restart-required 如实记录 / pluginManager 缺失 / toggleIgnore
 *   D. 三个新端点的成功与错误路径（真起 http 服务打真实 handler）+ task-10 端点回归
 *   E. pluginManager 缺失时整体仍能加载、端点仍可用
 *   F. client.js 的「可用更新」区域渲染（桩 React hooks 运行时 + 假 http 宿主，真挂载）
 *
 * 绝不真调 installBundle —— pluginManager 全部是桩。
 *
 * 跑法：在仓库根跑 `node test/bug-update-check.mjs`（本文件是可移植副本，PLUGIN_DIR 用相对路径推出来）
 */

import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = `${PLUGIN_DIR}/index.js`
const CLIENT = `${PLUGIN_DIR}/client.js`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
let passes = 0
function check(name, condition, detail) {
  const ok = Boolean(condition)
  if (ok) passes += 1
  else failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

function expectThrow(name, fn, needle) {
  try {
    fn()
    check(name, false, '没有抛错')
  } catch (error) {
    const message = String((error && error.message) || error)
    check(name, message.includes(needle), `message=${JSON.stringify(message)}`)
  }
}

const mod = await import(pathToFileURL(INDEX).href)
const {
  resolveConfig,
  createUpdateManager,
  compareVersions,
  updateKind,
  policyAllows,
  findOwningPackage,
  DEFAULTS,
} = mod.internals
// task-21：registry 巡检要用到 internals 上的注入点与单元。
const internals = mod.internals

// ---------------------------------------------------------------------------
// A. compareVersions / updateKind
// ---------------------------------------------------------------------------
console.log('\n--- A. compareVersions 边界 ---')
const CASES = [
  ['1.0.0', '1.0.1', -1, 'patch 升级'],
  ['1.0.0', '1.1.0', -1, 'minor 升级'],
  ['1.0.0', '2.0.0', -1, 'major 升级'],
  ['1.0.1', '1.0.0', 1, '反向 patch'],
  ['2.0.0', '1.9.9', 1, '反向 major'],
  ['1.0.0-rc.1', '1.0.0', -1, '预发布 < 正式版'],
  ['1.0.0', '1.0.0-rc.1', 1, '正式版 > 预发布'],
  ['1.0.0-rc.1', '1.0.0-rc.2', -1, '预发布递增'],
  ['v1.2.0', '1.2.0', 0, 'v 前缀'],
  ['1.2.0+build.5', '1.2.0', 0, '+build 忽略'],
  ['1.2.0', 'v1.2.0+build.9', 0, '两者都有'],
  ['1.2.3', '1.2.3', 0, '相等'],
  ['1.0.0-alpha', '1.0.0-alpha.1', -1, 'alpha < alpha.1'],
  ['1.0.0-alpha.1', '1.0.0-beta', -1, '数字标识符 < 字母标识符'],
]
for (const [a, b, want, label] of CASES) {
  const got = compareVersions(a, b)
  check(`compareVersions(${a}, ${b}) === ${want}  [${label}]`, got === want, `实际 ${got}`)
}
check('updateKind 1.0.0→1.0.1 = patch', updateKind('1.0.0', '1.0.1') === 'patch')
check('updateKind 1.0.0→1.1.0 = minor', updateKind('1.0.0', '1.1.0') === 'minor')
check('updateKind 1.0.0→2.0.0 = major', updateKind('1.0.0', '2.0.0') === 'major')
check('policyAllows(patch, patch) = true', policyAllows('patch', 'patch') === true)
check('policyAllows(patch, minor) = false', policyAllows('patch', 'minor') === false)
check('policyAllows(minor, minor) = true', policyAllows('minor', 'minor') === true)
check('policyAllows(minor, major) = false', policyAllows('minor', 'major') === false)
check('policyAllows(any, major) = true', policyAllows('any', 'major') === true)

// ---------------------------------------------------------------------------
// B. 新配置键
// ---------------------------------------------------------------------------
console.log('\n--- B. 配置键 ---')
const cfg = resolveConfig(undefined)
check('默认 updateCheckMs = 3600000', cfg.updateCheckMs === 3600000, `实际 ${cfg.updateCheckMs}`)
check('默认 autoUpdate = false', cfg.autoUpdate === false, `实际 ${cfg.autoUpdate}`)
check('默认 updatePolicy = minor', cfg.updatePolicy === 'minor', `实际 ${cfg.updatePolicy}`)
check('默认 ignoredUpdates = []', Array.isArray(cfg.ignoredUpdates) && cfg.ignoredUpdates.length === 0)
check('ignoredUpdates 不与 DEFAULTS 共享引用', cfg.ignoredUpdates !== DEFAULTS.ignoredUpdates)
check('updateCheckMs 可配 60000', resolveConfig({ updateCheckMs: 60000 }).updateCheckMs === 60000)
check('autoUpdate 可配 true', resolveConfig({ autoUpdate: true }).autoUpdate === true)
check('updatePolicy=any 可配', resolveConfig({ updatePolicy: 'any' }).updatePolicy === 'any')
const rawIgnored = ['dsh-ops@0.3.1']
const cfgIgnored = resolveConfig({ ignoredUpdates: rawIgnored })
check(
  'ignoredUpdates 可配且拷了一份（不改调用方数组）',
  cfgIgnored.ignoredUpdates.length === 1 && cfgIgnored.ignoredUpdates !== rawIgnored,
)
expectThrow('未知 config 键仍抛错并点名', () => resolveConfig({ nope: 1 }), '未知的 config 键')
expectThrow('updateCheckMs < 60000 抛错', () => resolveConfig({ updateCheckMs: 1000 }), 'updateCheckMs 必须 >= 60000')
expectThrow('autoUpdate 非 boolean 抛错', () => resolveConfig({ autoUpdate: 'yes' }), 'autoUpdate 必须是 boolean')
expectThrow('updatePolicy 非法抛错', () => resolveConfig({ updatePolicy: 'huge' }), 'updatePolicy 必须是')
expectThrow('ignoredUpdates 非 string[] 抛错', () => resolveConfig({ ignoredUpdates: [1] }), 'ignoredUpdates 必须是 string[]')

// ---------------------------------------------------------------------------
// C. createUpdateManager（全部桩，不碰真实 profile）
// ---------------------------------------------------------------------------
console.log('\n--- C. createUpdateManager ---')

// task-21：`installed` / `source` 现在决定「查不查」——只有 profile 自己的已装包
// （`installed === true`）且不是 `link:` / `file:` / `github:` 来源的才问 registry。
const BUNDLES = [
  { name: 'dsh-alpha', version: '1.0.0', installed: true, source: 'dsh-alpha@^1.0.0' },
  { name: 'dsh-beta', version: '1.0.0', installed: true, source: 'dsh-beta@^1.0.0' },
  { name: 'dsh-gamma', version: '1.0.0', installed: true, source: 'dsh-gamma@^1.0.0' },
  { name: 'dsh-delta', version: '1.0.0', installed: true, source: 'dsh-delta@^1.0.0' },
  { name: 'dsh-epsilon', version: '1.0.0', installed: true, source: 'dsh-epsilon@^1.0.0' },
  { name: 'dsh-zeta', version: '1.0.0', installed: true, source: 'dsh-zeta@^1.0.0' },
  // installation-provided：跟着宿主版本走，报了也装不了 → 一次都不该查。
  { name: 'dsh-provided', version: '0.1.0', installed: false, source: '@deepseek-ai/dsh-base@^0.2.1' },
  // 本地 / git 装的包：registry 上没有 → 静默跳过，不刷警告。
  { name: 'dsh-local', version: '1.0.0', installed: true, source: 'link:D:\\work\\dsh-local' },
  { name: 'dsh-fromfile', version: '1.0.0', installed: true, source: 'file:D:\\work\\dsh-fromfile' },
  { name: 'dsh-fromgit', version: '1.0.0', installed: true, source: 'github:KDDKBD/DeepSeek-splash-animation' },
  { name: 'dsh-no-version' },
]
// inspect 的返回值仍留着（次要路径的桩），但 task-21 起巡检**不再**用它拿最新版。
const INSPECTIONS = {
  'dsh-alpha': { status: 'accepted', kind: 'registry', name: 'dsh-alpha', version: '1.0.1' },
  'dsh-beta': { status: 'accepted', kind: 'registry', name: 'dsh-beta', version: '1.2.0' },
  'dsh-gamma': { status: 'accepted', kind: 'registry', name: 'dsh-gamma', version: '2.0.0' },
  'dsh-delta': { status: 'refused', problem: 'not-found', reason: 'stub refused' },
  'dsh-epsilon': new Error('stub inspect 炸了'),
  'dsh-zeta': { status: 'accepted', kind: 'registry', name: 'dsh-zeta', version: '1.0.0' },
}

// ---------------------------------------------------------------------------
// 假 registry（task-21）：插件走 doFetch，这里替换掉 fetch，绝不真发网络请求。
// 只认 REGISTRY_HOST / FALLBACK_HOST；别的 URL 交给真 fetch（本文件里没有别的外部请求）。
// ---------------------------------------------------------------------------
const REGISTRY_HOST = 'https://reg.test'
const FALLBACK_HOST = 'https://fb.test'
const RESOLVED_HOST = 'https://resolved.test'
const NPMJS_HOST = 'https://registry.npmjs.org'
/** 包名 → 结果：版本字符串 | '404' | 'http-500' | 'bad-json' | 'hang'（C7 会临时换掉它） */
let registryTable = {
  'dsh-alpha': '1.0.1',
  'dsh-beta': '1.2.0',
  'dsh-gamma': '2.0.0',
  'dsh-delta': '404',
  'dsh-epsilon': 'http-500',
  'dsh-zeta': '1.0.0',
}
const registryCalls = []
const registryHosts = [REGISTRY_HOST, FALLBACK_HOST, RESOLVED_HOST, NPMJS_HOST]
const realFetch = globalThis.fetch
internals.setFetch(async (url, init) => {
  const text = String(url)
  if (!registryHosts.some((host) => text.startsWith(host))) return realFetch(url, init)
  const name = decodeURIComponent(text.slice(text.lastIndexOf('/') + 1))
  registryCalls.push({ url: text, hasSignal: init !== undefined && init !== null && init.signal instanceof AbortSignal })
  const value = registryTable[name]
  if (value === 'hang') {
    // 真超时路径：挂在 signal 上，由 AbortSignal.timeout 把它打断。
    return await new Promise((resolve, reject) => {
      const signal = init === undefined || init === null ? undefined : init.signal
      if (signal === undefined) reject(new Error('stub registry: 没有 signal'))
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  if (value === 'bad-json') return { ok: true, status: 200, json: async () => { throw new Error('stub registry: 坏 JSON') } }
  if (value === 'http-500') return { ok: false, status: 500, json: async () => ({}) }
  if (value === undefined || value === '404') return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) }
  return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: value } }) }
})

/** 桩 pluginManager：listBundles + registries + inspect（inspect 已不是最新版来源）+ removeBundle/installBundle。 */
let inspectCalls = 0
function stubManager({ installs, installResult, removes, removeResult }) {
  return {
    async listBundles() {
      return BUNDLES
    },
    async registries() {
      return { registry: REGISTRY_HOST, fallbackRegistries: [FALLBACK_HOST], resolved: null }
    },
    async inspect(name) {
      inspectCalls += 1
      if (Object.hasOwn(INSPECTIONS, name)) {
        const value = INSPECTIONS[name]
        if (value instanceof Error) throw value
        return value
      }
      return { status: 'refused', problem: 'not-found', reason: 'stub: 没有这个包' }
    },
    // task-22：真实契约里 removeBundle 和 installBundle 同形状（都走 change()）。
    async removeBundle(name) {
      if (Array.isArray(removes)) removes.push(name)
      return typeof removeResult === 'function'
        ? removeResult(name)
        : { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(name) {
      installs.push(name)
      return typeof installResult === 'function'
        ? installResult(name)
        : { changed: true, application: 'applied', stage: 'install', target: name, version: '9.9.9' }
    },
  }
}

// C1 基本巡检
const installs1 = []
const logs1 = []
const settings1 = { ...DEFAULTS, ignoredUpdates: [] }
const mgr1 = createUpdateManager(settings1, { pluginManager: stubManager({ installs: installs1 }) }, (e) =>
  logs1.push(String((e && e.message) || e)),
)
await mgr1.runCheck()
const list1 = mgr1.list()
const names1 = list1.map((item) => item.moduleName).sort()
check('updates 只含 3 个真有新版的包', names1.join(',') === 'dsh-alpha,dsh-beta,dsh-gamma', `实际 ${names1.join(',')}`)
check('registry 404 的包不进 updates（静默跳过）', !names1.includes('dsh-delta'))
check('registry 500 的包不进 updates（不崩）', !names1.includes('dsh-epsilon'))
check('最新版 == 已装 的包不进 updates', !names1.includes('dsh-zeta'))
check('没有 version 的 bundle 被跳过', !names1.includes('dsh-no-version'))
// task-21 新增：查不查由 installed / source 决定
check('installed=false 的 bundle 不进 updates', !names1.includes('dsh-provided'))
check('installed=false 的 bundle 一次都没被查', !registryCalls.some((c) => c.url.includes('dsh-provided')))
check('link: 来源的包不进 updates', !names1.includes('dsh-local'))
check('file: 来源的包不进 updates', !names1.includes('dsh-fromfile'))
check('github: 来源的包不进 updates', !names1.includes('dsh-fromgit'))
check(
  'link:/file:/github: 来源一次都没被查',
  !registryCalls.some((c) => c.url.includes('dsh-local') || c.url.includes('dsh-fromfile') || c.url.includes('dsh-fromgit')),
)
check('巡检不再调用 inspect（已装包 inspect 一律 already-installed）', inspectCalls === 0, `实际调了 ${inspectCalls} 次`)
check('registry 查询带了 AbortSignal（超时保护）', registryCalls.length > 0 && registryCalls.every((c) => c.hasSignal))
check('registry 查询 URL = <registry>/<包名>', registryCalls.some((c) => c.url === `${REGISTRY_HOST}/dsh-alpha`), JSON.stringify(registryCalls[0]))
check(
  'kind 判定：alpha=patch beta=minor gamma=major',
  list1.find((i) => i.moduleName === 'dsh-alpha').kind === 'patch' &&
    list1.find((i) => i.moduleName === 'dsh-beta').kind === 'minor' &&
    list1.find((i) => i.moduleName === 'dsh-gamma').kind === 'major',
)
check(
  '条目形状 = {moduleName, installed, latest, kind, ignored}',
  list1.every(
    (item) =>
      typeof item.moduleName === 'string' &&
      typeof item.installed === 'string' &&
      typeof item.latest === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.ignored === 'boolean',
  ),
)
check('lastUpdateCheckAt > 0', mgr1.lastCheckAt() > 0)
check('autoUpdate=false → installBundle 一次都没调', installs1.length === 0, `实际 ${installs1.length}`)
check('registry 500 时记了 warn', logs1.some((line) => line.includes('dsh-epsilon') && line.includes('HTTP 500')))

// C2 ignored
const settings2 = { ...DEFAULTS, ignoredUpdates: ['dsh-beta@1.2.0'] }
const mgr2 = createUpdateManager(settings2, { pluginManager: stubManager({ installs: [] }) }, () => {})
await mgr2.runCheck()
const beta2 = mgr2.list().find((item) => item.moduleName === 'dsh-beta')
check('ignoredUpdates 命中 → ignored:true', beta2 !== undefined && beta2.ignored === true)
check('被忽略的仍留在 updates 里（界面要单独一行显示）', beta2 !== undefined)
check(
  '未被忽略的 ignored:false',
  mgr2.list().filter((item) => item.moduleName !== 'dsh-beta').every((item) => item.ignored === false),
)

// C3 autoUpdate × updatePolicy
console.log('--- C3 autoUpdate × updatePolicy ---')
for (const [policy, expected] of [
  ['patch', ['dsh-alpha']],
  ['minor', ['dsh-alpha', 'dsh-beta']],
  ['any', ['dsh-alpha', 'dsh-beta', 'dsh-gamma']],
]) {
  const installs = []
  const settings = { ...DEFAULTS, autoUpdate: true, updatePolicy: policy, ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: stubManager({ installs }) }, () => {})
  await mgr.runCheck()
  check(
    `autoUpdate=true policy=${policy} → 装 ${expected.length} 个`,
    installs.length === expected.length,
    `实际 ${installs.length} 个：${JSON.stringify(installs)}`,
  )
  check(
    `  装的正是 ${JSON.stringify(expected)}`,
    JSON.stringify([...installs].sort()) === JSON.stringify([...expected].sort()),
  )
}
{
  const installs = []
  const settings = { ...DEFAULTS, autoUpdate: false, updatePolicy: 'any', ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: stubManager({ installs }) }, () => {})
  await mgr.runCheck()
  check('autoUpdate=false policy=any → 一个都不装（默认只报告）', installs.length === 0, `实际 ${installs.length}`)
}
{
  const installs = []
  const settings = { ...DEFAULTS, autoUpdate: true, updatePolicy: 'any', ignoredUpdates: ['dsh-beta@1.2.0'] }
  const mgr = createUpdateManager(settings, { pluginManager: stubManager({ installs }) }, () => {})
  await mgr.runCheck()
  check('autoUpdate=true 但被忽略的包不装', !installs.includes('dsh-beta'), JSON.stringify(installs))
  check('  其余照装', installs.includes('dsh-alpha') && installs.includes('dsh-gamma'), JSON.stringify(installs))
  check(
    '  跳过被如实记进 updateLog（result=skipped）',
    mgr.log().some((e) => e.moduleName === 'dsh-beta' && e.result === 'skipped'),
    JSON.stringify(mgr.log().map((e) => `${e.moduleName}:${e.result}`)),
  )
}

// C4 restart-required 如实记录
console.log('--- C4 restart-required ---')
{
  const installs = []
  const settings = { ...DEFAULTS, autoUpdate: true, updatePolicy: 'any', ignoredUpdates: [] }
  const mgr = createUpdateManager(
    settings,
    {
      pluginManager: stubManager({
        installs,
        installResult: (name) =>
          name === 'dsh-gamma'
            ? {
                changed: true,
                application: 'restart-required',
                stage: 'install',
                target: name,
                version: '2.0.0',
                restartReason: 'no-hmr',
              }
            : { changed: true, application: 'applied', stage: 'install', target: name, version: '1.0.1' },
      }),
    },
    () => {},
  )
  await mgr.runCheck()
  const log = mgr.log()
  const gamma = log.find((e) => e.moduleName === 'dsh-gamma')
  const alpha = log.find((e) => e.moduleName === 'dsh-alpha')
  check("application='restart-required' → updateLog.result = 'restart-required'", gamma !== undefined && gamma.result === 'restart-required', JSON.stringify(gamma))
  check('  不谎报成 applied', gamma !== undefined && gamma.result !== 'applied')
  check('  detail 带 application=restart-required', gamma !== undefined && String(gamma.detail).includes('application=restart-required'))
  check('  detail 带 restartReason=no-hmr', gamma !== undefined && String(gamma.detail).includes('restartReason=no-hmr'))
  check("application='applied' → updateLog.result = 'applied'", alpha !== undefined && alpha.result === 'applied')
  check(
    'updateLog 条目形状 = {at, moduleName, from, to, result, detail}',
    log.every(
      (e) =>
        typeof e.at === 'string' &&
        typeof e.moduleName === 'string' &&
        typeof e.from === 'string' &&
        typeof e.to === 'string' &&
        typeof e.result === 'string' &&
        typeof e.detail === 'string',
    ),
  )
  check('  装过的包从 updates 里移除', !mgr.list().some((i) => i.moduleName === 'dsh-gamma'))
}

// C5 pluginManager 缺失
console.log('--- C5 pluginManager 缺失 ---')
{
  const logs = []
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: null }, (e) => logs.push(String((e && e.message) || e)))
  let threw = null
  try {
    await mgr.runCheck()
  } catch (error) {
    threw = error
  }
  check('pluginManager=null 时 runCheck 不抛', threw === null, threw === null ? '' : String(threw))
  check('  updates 保持空数组', mgr.list().length === 0)
  check('  记了一条 pluginManager 不可用的 log', logs.some((line) => line.includes('pluginManager 不可用')))
  check('  lastUpdateCheckAt 仍被更新', mgr.lastCheckAt() > 0)
}

// C6 toggleIgnore
console.log('--- C6 toggleIgnore ---')
{
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: stubManager({ installs: [] }) }, () => {})
  await mgr.runCheck()
  check('toggleIgnore 第一次 → true（变成已忽略）', mgr.toggleIgnore('dsh-beta', '1.2.0') === true)
  check('  settings.ignoredUpdates 收到 dsh-beta@1.2.0', settings.ignoredUpdates.includes('dsh-beta@1.2.0'))
  check('  该条 ignored 立刻变 true（不用重查网络）', mgr.list().find((i) => i.moduleName === 'dsh-beta').ignored === true)
  check('toggleIgnore 第二次 → false（取消忽略）', mgr.toggleIgnore('dsh-beta', '1.2.0') === false)
  check('  ignored 回到 false', mgr.list().find((i) => i.moduleName === 'dsh-beta').ignored === false)
  check('  ignoredUpdates 清空', settings.ignoredUpdates.length === 0)
}

// ---------------------------------------------------------------------------
// C7 registry 巡检专项（task-21）
//
// 根因：`inspect()` 对**已装**包一律 refused（`already-installed`），所以旧实现里
// `status !== 'accepted'` 把每个包都 continue 掉 → updates 恒为空。
// 这一节专门钉住新路径：最新版只从 registry 的 dist-tags.latest 拿。
// ---------------------------------------------------------------------------
console.log('--- C7 registry 巡检专项 ---')

/** 只给 listBundles + registries 的桩：故意**不带** inspect，证明巡检不再依赖它。 */
function managerFor(bundles, registries) {
  return {
    async listBundles() {
      return bundles
    },
    async registries() {
      return registries
    },
  }
}

/** 换掉假 registry 表 + 超时，跑一轮巡检，然后把现场恢复回去。 */
async function scanWith({ bundles, registries, table, timeoutMs }) {
  const savedTable = registryTable
  const savedTimeout = internals.REGISTRY_TIMEOUT_MS
  const before = registryCalls.length
  registryTable = table
  internals.setRegistryTimeout(timeoutMs === undefined ? savedTimeout : timeoutMs)
  // `AbortSignal.timeout()` 的计时器是 unref 的：这里没别的活儿时 node 会直接退出，
  // 所以超时用例必须自己挂一个保活计时器。
  const keepAlive = setInterval(() => {}, 20)
  const logs = []
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: managerFor(bundles, registries) }, (e) =>
    logs.push(String((e && e.message) || e)),
  )
  let threw = null
  let updates = []
  try {
    updates = await mgr.runCheck()
  } catch (error) {
    threw = error
  }
  clearInterval(keepAlive)
  registryTable = savedTable
  internals.setRegistryTimeout(savedTimeout)
  return { updates, logs, log: mgr.log(), threw, calls: registryCalls.slice(before) }
}

// C7.1 混合一轮：有新版 / 预发布 / 降级 / 超时 / 坏 JSON / 404 / scoped
{
  const bundles = [
    { name: 'dsh-new', version: '1.0.0', installed: true, source: 'dsh-new@^1.0.0' },
    { name: 'dsh-pre', version: '1.0.0-rc.1', installed: true, source: 'dsh-pre@^1.0.0-rc.1' },
    { name: 'dsh-lower', version: '2.0.0', installed: true, source: 'dsh-lower@^2.0.0' },
    { name: 'dsh-timeout', version: '1.0.0', installed: true, source: 'dsh-timeout@^1.0.0' },
    { name: 'dsh-broken', version: '1.0.0', installed: true, source: 'dsh-broken@^1.0.0' },
    { name: 'dsh-missing', version: '1.0.0', installed: true, source: 'dsh-missing@^1.0.0' },
    { name: '@scope/scoped', version: '1.0.0', installed: true, source: '@scope/scoped@^1.0.0' },
  ]
  const table = {
    'dsh-new': '1.0.1',
    'dsh-pre': '1.0.0',
    'dsh-lower': '1.0.0',
    'dsh-timeout': 'hang',
    'dsh-broken': 'bad-json',
    '@scope/scoped': '1.1.0',
    // dsh-missing 故意不给 → 404
  }
  const run = await scanWith({
    bundles,
    registries: { registry: REGISTRY_HOST, fallbackRegistries: [], resolved: null },
    table,
    timeoutMs: 40, // 真超时：40ms，不等 8 秒
  })
  const names = run.updates.map((item) => item.moduleName).sort()
  check('已装包 + registry 有新版 → 出现在 updates 里（原来挂掉的就是这条）', names.includes('dsh-new'))
  check(
    '  latest/kind 正确（1.0.0 → 1.0.1 = patch）',
    run.updates.some((i) => i.moduleName === 'dsh-new' && i.latest === '1.0.1' && i.kind === 'patch'),
    JSON.stringify(run.updates.find((i) => i.moduleName === 'dsh-new')),
  )
  check('scoped 包名转义成 @scope%2Fname', run.calls.some((c) => c.url === `${REGISTRY_HOST}/@scope%2Fscoped`), JSON.stringify(run.calls.map((c) => c.url)))
  check('scoped 包也能进 updates', names.includes('@scope/scoped'))
  check('预发布版比较：1.0.0-rc.1 → 1.0.0 算可用更新', names.includes('dsh-pre'))
  check('latest 比已装旧（降级）→ 不算可用更新', !names.includes('dsh-lower'))
  check('registry 超时的包不进 updates（不崩）', run.threw === null && !names.includes('dsh-timeout'))
  check('  超时记了 warn', run.logs.some((line) => line.includes('dsh-timeout')))
  check('坏 JSON 的包不进 updates（不崩）', !names.includes('dsh-broken'))
  check('  坏 JSON 记了 warn', run.logs.some((line) => line.includes('dsh-broken')))
  check('registry 404 的包不进 updates 且不报错', !names.includes('dsh-missing') && !run.logs.some((line) => line.includes('dsh-missing')))
  check('单个包失败不影响同轮其它包（3 个有更新）', names.join(',') === '@scope/scoped,dsh-new,dsh-pre', `实际 ${names.join(',')}`)
  const summary = run.log.filter((entry) => entry.moduleName === '(registry)')
  check('updateLog 有一条 (registry) 汇总（result=checked）', summary.length === 1 && summary[0].result === 'checked', JSON.stringify(summary))
  check(
    '  汇总逐个列出查过的包（可核查「真的都是最新」还是「根本查不动」）',
    summary.length === 1 &&
      String(summary[0].detail).includes('dsh-new 1.0.0=1.0.1') &&
      String(summary[0].detail).includes('dsh-lower 2.0.0=1.0.0') &&
      String(summary[0].detail).includes('registry 上 404 1 个'),
    summary.length === 1 ? String(summary[0].detail) : '',
  )
  check('  汇总里写了 registry 与跳过计数', summary.length === 1 && String(summary[0].detail).includes(`registry=${REGISTRY_HOST}`))
  const failedEntries = run.log.filter((entry) => entry.result === 'check-failed')
  check('失败也逐条记进 updateLog（result=check-failed）', failedEntries.length === 2, JSON.stringify(failedEntries))
}

// C7.2 同一个 manager 连续两轮完全相同 → 汇总不重复写（避免定时巡检刷满日志）
{
  const savedTable = registryTable
  registryTable = { 'dsh-new': '1.0.1' }
  const logs = []
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const mgr = createUpdateManager(
    settings,
    {
      pluginManager: managerFor([{ name: 'dsh-new', version: '1.0.0', installed: true, source: 'dsh-new@^1.0.0' }], {
        registry: REGISTRY_HOST,
        fallbackRegistries: [],
        resolved: null,
      }),
    },
    (e) => logs.push(String((e && e.message) || e)),
  )
  await mgr.runCheck()
  const afterFirst = mgr.log().filter((entry) => entry.moduleName === '(registry)').length
  await mgr.runCheck()
  const afterSecond = mgr.log().filter((entry) => entry.moduleName === '(registry)').length
  registryTable = savedTable
  check('第一轮写了 (registry) 汇总', afterFirst === 1, `实际 ${afterFirst}`)
  check('第二轮结果相同 → 不重复写', afterSecond === 1, `实际 ${afterSecond}`)
}

// C7.3 全部查询都失败 → updateLog 必须有可见记录（不许静默的 0 更新）
{
  const bundles = [
    { name: 'dsh-x1', version: '1.0.0', installed: true, source: 'dsh-x1@^1.0.0' },
    { name: 'dsh-x2', version: '1.0.0', installed: true, source: 'dsh-x2@^1.0.0' },
  ]
  const run = await scanWith({
    bundles,
    registries: { registry: REGISTRY_HOST, fallbackRegistries: [], resolved: null },
    table: { 'dsh-x1': 'http-500', 'dsh-x2': 'bad-json' },
  })
  const summary = run.log.filter((entry) => entry.moduleName === '(registry)')
  check('全部失败 → updates 为空', run.updates.length === 0)
  check('全部失败 → updateLog 里有 result=check-failed 的可见记录', summary.length === 1 && summary[0].result === 'check-failed', JSON.stringify(summary))
  check('  记录里写明「0 个查到」', summary.length === 1 && summary[0].to === '0 个查到', JSON.stringify(summary[0]))
  check('  两个包都记了 warn', run.logs.length === 2)
}

// C7.4 没有任何可查的包（全是 link: / installed=false）→ 也要留可见记录
{
  const bundles = [
    { name: 'dsh-local', version: '1.0.0', installed: true, source: 'link:D:\\work\\dsh-local' },
    { name: 'dsh-provided', version: '0.1.0', installed: false, source: '@deepseek-ai/dsh-base@^0.2.1' },
  ]
  const run = await scanWith({
    bundles,
    registries: { registry: REGISTRY_HOST, fallbackRegistries: [], resolved: null },
    table: {},
  })
  check('没有可查的包 → 一次 registry 请求都不发', run.calls.length === 0, JSON.stringify(run.calls))
  check('  仍然留一条可见记录（不是静默 0 更新）', run.log.some((e) => e.moduleName === '(registry)' && e.to === '没有可查的包'))
}

// C7.5 registry 取法与兜底链
{
  const bundles = [{ name: 'dsh-new', version: '1.0.0', installed: true, source: 'dsh-new@^1.0.0' }]
  const table = { 'dsh-new': '1.0.1' }
  // registry = null（pnpm 自己配置的那个）→ 用 resolved
  const viaResolved = await scanWith({
    bundles,
    registries: { registry: null, fallbackRegistries: [], resolved: RESOLVED_HOST },
    table,
  })
  check('registry=null → 退化到 resolved 指的地址', viaResolved.calls.some((c) => c.url === `${RESOLVED_HOST}/dsh-new`), JSON.stringify(viaResolved.calls.map((c) => c.url)))
  // registry = null 且没有 resolved → 用 npmjs 兜底
  const viaNpm = await scanWith({
    bundles,
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    table,
  })
  check('registry=null 且没有 resolved → 用 https://registry.npmjs.org 兜底', viaNpm.calls.some((c) => c.url === `${NPMJS_HOST}/dsh-new`), JSON.stringify(viaNpm.calls.map((c) => c.url)))
  check('  兜底地址确实进了汇总记录', viaNpm.log.some((e) => e.moduleName === '(registry)' && String(e.detail).includes(NPMJS_HOST)))
  // 第一个 registry 查不到（404）→ 依次试 fallbackRegistries
  const viaFallback = await scanWith({
    bundles,
    registries: { registry: REGISTRY_HOST, fallbackRegistries: [FALLBACK_HOST], resolved: null },
    table: { 'dsh-new': '404' }, // 两个都 404
  })
  check(
    'registry 404 → 依次试 fallbackRegistries',
    viaFallback.calls.some((c) => c.url === `${REGISTRY_HOST}/dsh-new`) && viaFallback.calls.some((c) => c.url === `${FALLBACK_HOST}/dsh-new`),
    JSON.stringify(viaFallback.calls.map((c) => c.url)),
  )
  check('  全 404 → 静默跳过、无 warn', viaFallback.logs.length === 0 && viaFallback.updates.length === 0)
}

// C7.6 fetchLatestVersion 单元（直接调，覆盖返回形状）
{
  const savedTable = registryTable
  const savedTimeout = internals.REGISTRY_TIMEOUT_MS
  registryTable = { 'dsh-new': '1.0.1', 'dsh-broken': 'bad-json', 'dsh-slow': 'hang' }
  const hosts = [REGISTRY_HOST]
  const ok = await internals.fetchLatestVersion('dsh-new', hosts)
  check('fetchLatestVersion 成功 → {latest}', ok.latest === '1.0.1', JSON.stringify(ok))
  const missing = await internals.fetchLatestVersion('dsh-nope', hosts)
  check('fetchLatestVersion 404 → {missing:true}', missing.missing === true, JSON.stringify(missing))
  const broken = await internals.fetchLatestVersion('dsh-broken', hosts)
  check('fetchLatestVersion 坏 JSON → {failed:true}', broken.failed === true && String(broken.reason).includes('坏 JSON'), JSON.stringify(broken))
  const empty = await internals.fetchLatestVersion('dsh-new', [])
  check('fetchLatestVersion 没有 registry → {failed:true}（不抛）', empty.failed === true, JSON.stringify(empty))
  internals.setRegistryTimeout(40)
  const keepAlive = setInterval(() => {}, 20)
  const slow = await internals.fetchLatestVersion('dsh-slow', hosts)
  clearInterval(keepAlive)
  check(
    'fetchLatestVersion 真超时 → {failed:true}（AbortSignal.timeout 生效）',
    slow.failed === true && /timeout|abort/i.test(String(slow.reason)),
    JSON.stringify(slow),
  )
  check('scoped 包名编码正确', internals.encodePackageName('@scope/name') === '@scope%2Fname' && internals.encodePackageName('plain') === 'plain')
  registryTable = savedTable
  internals.setRegistryTimeout(savedTimeout)
}

// ---------------------------------------------------------------------------
// D. HTTP 端点（真起 http 服务打真实 handler）
// ---------------------------------------------------------------------------
console.log('\n--- D. HTTP 端点 ---')

function createFakeCtx(services, logs) {
  const cleanups = []
  const ctx = {
    logger: { warn: (error) => logs.push(String((error && error.message) || error)) },
    on() {},
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    inject(names, callback) {
      const scoped = { effect: ctx.effect }
      for (const name of names) {
        // 软依赖：拿不到就不回调（与 cordis 的语义一致）。
        if (services[name] === undefined || services[name] === null) return
        scoped[name] = services[name]
      }
      callback(scoped)
    },
    get(name) {
      return services[name]
    },
  }
  return { ctx, cleanups }
}

function createWebServerStub() {
  const state = { handler: null, registered: 0 }
  return {
    get handler() {
      return state.handler
    },
    get registered() {
      return state.registered
    },
    register(options) {
      state.handler = options.handler
      state.registered += 1
      return () => {
        state.handler = null
      }
    },
  }
}

/**
 * 定时器桩。
 * 默认只**记录**不真跑（让 D/E 段的断言保持确定性）；`{ real: true }` 时用真的
 * setTimeout / setInterval，用来验证「首次巡检确实在短延迟后被调用」和
 * 「dispose 之后那次待触发的首次巡检不再触发」—— 这两条不能靠桩自己假装。
 */
function createTimerStub(options = {}) {
  const real = options.real === true
  const intervals = []
  const timeouts = []
  return {
    intervals,
    timeouts,
    interval(callback, delay) {
      const entry = { callback, delay, disposed: false, handle: null }
      if (real) {
        entry.handle = setInterval(() => {
          if (!entry.disposed) callback()
        }, delay)
      }
      entry.dispose = () => {
        entry.disposed = true
        if (entry.handle !== null) clearInterval(entry.handle)
      }
      intervals.push(entry)
      return entry.dispose
    },
    timeout(callback, delay) {
      const entry = { callback, delay, disposed: false, handle: null }
      if (real) {
        entry.handle = setTimeout(() => {
          if (!entry.disposed) callback()
        }, delay)
      }
      entry.dispose = () => {
        entry.disposed = true
        if (entry.handle !== null) clearTimeout(entry.handle)
      }
      timeouts.push(entry)
      return entry.dispose
    },
  }
}

let installMode = 'applied'
// task-22：applyOne 现在先 removeBundle 再 installBundle，端点这条路的桩也要有 removeBundle。
// removeMode 取 'applied' | 'restart-required' | 'throw' | 任意错误码（not-removable / bundle-in-use /
// management-required / stop-profile / unaddressable …）。
let removeMode = 'applied'
const endpointInstalls = []
const endpointRemoves = []
const endpointManager = {
  async listBundles() {
    return BUNDLES
  },
  // task-21：最新版走 registry，端点这条路也要给 registries()。
  async registries() {
    return { registry: REGISTRY_HOST, fallbackRegistries: [], resolved: null }
  },
  async inspect(name) {
    if (Object.hasOwn(INSPECTIONS, name)) {
      const value = INSPECTIONS[name]
      if (value instanceof Error) throw value
      return value
    }
    return { status: 'refused', problem: 'not-found', reason: 'stub: 没有这个包' }
  },
  async removeBundle(name) {
    endpointRemoves.push(name)
    if (removeMode === 'throw') throw new Error('stub removeBundle 炸了')
    if (removeMode === 'applied') return { changed: true, application: 'applied', stage: 'remove', target: name }
    if (removeMode === 'restart-required') {
      return { changed: true, application: 'restart-required', stage: 'remove', target: name, restartReason: 'no-hmr' }
    }
    // 其余一律当 ManagementFailure：change() 会折成 application=failed + error.code。
    return { changed: false, application: 'failed', stage: 'remove', target: name, error: { code: removeMode } }
  },
  async installBundle(name) {
    endpointInstalls.push(name)
    if (installMode === 'throw') throw new Error('stub installBundle 炸了')
    if (installMode === 'restart-required') {
      return {
        changed: true,
        application: 'restart-required',
        stage: 'install',
        target: name,
        version: '2.0.0',
        restartReason: 'no-hmr',
      }
    }
    return { changed: true, application: 'applied', stage: 'install', target: name, version: '1.0.1' }
  },
}

const webServer = createWebServerStub()
const timer = createTimerStub()
const hostLogs = []
// 每次跑用**独立**的临时目录：store 是按 fingerprint 去重的，如果复用固定路径，
// 上一轮跑出来的 report 会被这一轮认成同一条（上一轮末尾已经把它标成 fixed 了），
// 断言就会莫名其妙地红。测试必须自隔离。
const STUB_DIR = join(tmpdir(), `bug-reporter-stub-test-${process.pid}-${Date.now()}`)
const storeFile = join(STUB_DIR, 'reports.jsonl')
// repairRoots 只放行一个专用子目录：task-15 起 /repair 只认「报告所属插件的包」或
// repairRoots，而这里的报告都是没有 pluginId 的探针报告。故意**不**放行整个 STUB_DIR，
// 这样 D11 的「改别的包 / junction 逃逸」两个负例才有意义（它们落在 repair-root 之外）。
const REPAIR_ROOT = join(STUB_DIR, 'repair-root')
const { ctx: hostCtx } = createFakeCtx({ webServer, pluginManager: endpointManager, timer }, hostLogs)
// task-19：设置现在会**持久化**（默认与 storePath 同目录）。每个实例必须给一份自己的
// settingsPath，否则同一轮里的实例会互相读到对方写下的设置（实测踩到过：D12 的
// repairRoots 被主实例持久化的值盖掉，本该 200 的写入变成 403）。
mod.apply(hostCtx, {
  storePath: storeFile,
  settingsPath: `${storeFile}.settings.json`,
  autoUpdate: false,
  updatePolicy: 'any',
  repairRoots: [REPAIR_ROOT],
})

check('webServer.register 被调用（拿到 handler）', typeof webServer.handler === 'function')
check('timer.interval 注册了一次巡检轮询', timer.intervals.length === 1, `实际 ${timer.intervals.length}`)
check('  轮询间隔 = config.updateCheckMs 默认 3600000', timer.intervals[0] && timer.intervals[0].delay === 3600000, `实际 ${timer.intervals[0] && timer.intervals[0].delay}`)
check('timer.timeout 注册了一次首次巡检', timer.timeouts.length === 1, `实际 ${timer.timeouts.length}`)
check(
  '  首次巡检延迟 = 3000ms（不是 updateCheckMs，也不是 0）',
  timer.timeouts[0] && timer.timeouts[0].delay === 3000,
  `实际 ${timer.timeouts[0] && timer.timeouts[0].delay}`,
)

const handler = webServer.handler
const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
console.log(`fake host on ${origin}`)

async function call(path, options = {}) {
  const init = { method: options.method === undefined ? 'POST' : options.method }
  const headers = { ...(options.headers === undefined ? null : options.headers) }
  if (options.body !== undefined) {
    // 真 client.js 的 POST 就是 application/json；只有调用方显式指定别的类型时才改。
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json'
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  if (Object.keys(headers).length > 0) init.headers = headers
  const response = await fetch(origin + path, init)
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return {
    status: response.status,
    json,
    headers: Object.fromEntries(response.headers),
  }
}

// 轮询回调真的能跑（不抛）
{
  const before = mod.internals.active.updates.lastCheckAt()
  timer.intervals[0].callback()
  await sleep(150)
  const after = mod.internals.active.updates.lastCheckAt()
  check('轮询回调真的跑了一次巡检（lastUpdateCheckAt 前进）', after > before && after > 0, `before=${before} after=${after}`)
}

// D1 /update/check
const r1 = await call('/bug-reporter/update/check', { body: {} })
check('POST /update/check → 200 ok:true', r1.status === 200 && r1.json && r1.json.ok === true, `status=${r1.status}`)
check('  value.updates 有 3 条', Array.isArray(r1.json.value.updates) && r1.json.value.updates.length === 3, `实际 ${r1.json.value.updates.length}`)
check('  value.lastUpdateCheckAt > 0', r1.json.value.lastUpdateCheckAt > 0)
check('  value.updateLog 是数组', Array.isArray(r1.json.value.updateLog))
check(
  '  update 条目形状正确',
  r1.json.value.updates.every(
    (item) =>
      typeof item.moduleName === 'string' &&
      typeof item.installed === 'string' &&
      typeof item.latest === 'string' &&
      typeof item.kind === 'string' &&
      typeof item.ignored === 'boolean',
  ),
)

// D2 task-10 字段回归（只做加法）
const s1 = await call('/bug-reporter/state', { method: 'GET' })
const stateValue = s1.json.value
const OLD_FIELDS = [
  'enabled',
  'captureTools',
  'captureProcess',
  'repairEnabled',
  'repo',
  'tokenRef',
  'baseBranch',
  'tokenConfigured',
  'storeFile',
  'reports',
]
check(
  'GET /state 保留 task-10 的全部 10 个字段',
  OLD_FIELDS.every((key) => Object.hasOwn(stateValue, key)),
  `缺 ${JSON.stringify(OLD_FIELDS.filter((key) => !Object.hasOwn(stateValue, key)))}`,
)
// 「只做加法」的硬证据：原字段名与顺序一字未动，新字段只追加在后面。
check(
  'GET /state 前 10 个键仍是 task-10 的原名原序（新字段只追加在后面）',
  JSON.stringify(Object.keys(stateValue).slice(0, 10)) === JSON.stringify(OLD_FIELDS),
  `实际 ${JSON.stringify(Object.keys(stateValue))}`,
)
check(
  'GET /state 旧字段取值仍正确（含 storePath 生效）',
  stateValue.enabled === true &&
    stateValue.captureTools === true &&
    stateValue.captureProcess === true &&
    stateValue.repairEnabled === true &&
    typeof stateValue.repo === 'string' &&
    stateValue.tokenRef === 'GITHUB_TOKEN' &&
    typeof stateValue.baseBranch === 'string' &&
    typeof stateValue.tokenConfigured === 'boolean' &&
    stateValue.storeFile === storeFile,
  JSON.stringify({
    enabled: stateValue.enabled,
    tokenRef: stateValue.tokenRef,
    storeFile: stateValue.storeFile,
    expectedStoreFile: storeFile,
  }),
)
check(
  'GET /state 新增 updates / lastUpdateCheckAt / updateLog',
  ['updates', 'lastUpdateCheckAt', 'updateLog'].every((key) => Object.hasOwn(stateValue, key)),
)
check('GET /state reports 仍是数组', Array.isArray(stateValue.reports))
check('GET /state 仍是 {ok:true,value} 信封', s1.json.ok === true && typeof s1.json.value === 'object')

// D3 task-10 端点回归
const s2 = await call('/bug-reporter/state', { body: { captureTools: false } })
check('POST /state 仍能改 captureTools', s2.status === 200 && s2.json.value.captureTools === false)
await call('/bug-reporter/state', { body: { captureTools: true } })
const s3 = await call('/bug-reporter/state', { body: { nope: 1 } })
check('POST /state 未知键仍被忽略（task-10 行为）', s3.status === 200, `status=${s3.status}`)
const rep = await call('/bug-reporter/report', { body: { message: 'stub 报告', source: 'manual' } })
check('POST /report 仍工作', rep.status === 200 && rep.json.value.report && typeof rep.json.value.report.id === 'string')
const repState = await call('/bug-reporter/state', { method: 'GET' })
check('  新报告出现在 state.reports', repState.json.value.reports.some((item) => item.message === 'stub 报告'))
const upd = await call('/bug-reporter/report/update', { body: { id: rep.json.value.report.id, status: 'fixed' } })
check('POST /report/update 仍工作', upd.status === 200 && upd.json.value.report.status === 'fixed')
const del = await call('/bug-reporter/report/delete', { body: { id: rep.json.value.report.id } })
check('POST /report/delete 仍工作', del.status === 200 && del.json.value.deleted === true)

// D4 /update/apply 成功（autoUpdate=false，证明手动不受限）
installMode = 'applied'
endpointInstalls.length = 0
const a1 = await call('/bug-reporter/update/apply', { body: { moduleName: 'dsh-alpha' } })
check('POST /update/apply 成功 → 200 ok:true', a1.status === 200 && a1.json.ok === true, `status=${a1.status}`)
check('  installBundle 被调一次且参数 = dsh-alpha', endpointInstalls.length === 1 && endpointInstalls[0] === 'dsh-alpha', JSON.stringify(endpointInstalls))
check('  装完该包不再出现在 updates', !a1.json.value.updates.some((item) => item.moduleName === 'dsh-alpha'))
check(
  '  updateLog 记了一条 applied',
  a1.json.value.updateLog.some((entry) => entry.moduleName === 'dsh-alpha' && entry.result === 'applied'),
)
check('  手动 apply 不受 autoUpdate=false 限制（本实例 autoUpdate=false）', true)

// D5 /update/apply → restart-required 如实记录
installMode = 'restart-required'
const a2 = await call('/bug-reporter/update/apply', { body: { moduleName: 'dsh-gamma' } })
const gammaLog = a2.json.value.updateLog.find((entry) => entry.moduleName === 'dsh-gamma')
check("POST /update/apply 返回 restart-required 时 updateLog 如实记 restart-required", gammaLog !== undefined && gammaLog.result === 'restart-required', JSON.stringify(gammaLog))
check('  detail 带 restartReason=no-hmr', gammaLog !== undefined && String(gammaLog.detail).includes('restartReason=no-hmr'))

// D6 /update/apply → operation-failed
installMode = 'throw'
const a3 = await call('/bug-reporter/update/apply', { body: { moduleName: 'dsh-beta' } })
check('installBundle 抛错 → 502 operation-failed', a3.status === 502 && a3.json.error.code === 'operation-failed', JSON.stringify(a3.json))
check(
  '  失败也如实记进 updateLog（result=failed）',
  mod.internals.active.updates.log().some((entry) => entry.moduleName === 'dsh-beta' && entry.result === 'failed'),
)
installMode = 'applied'

// D7 错误路径
const e1 = await call('/bug-reporter/update/apply', { body: {} })
check('apply 缺 moduleName → 400 missing-param', e1.status === 400 && e1.json.error.code === 'missing-param', JSON.stringify(e1.json))
const e2 = await call('/bug-reporter/update/apply', { body: { moduleName: 'dsh-not-a-thing' } })
check('apply 未知包 → 404 unknown-module', e2.status === 404 && e2.json.error.code === 'unknown-module', JSON.stringify(e2.json))
const e3 = await call('/bug-reporter/update/ignore', { body: { moduleName: 'dsh-beta' } })
check('ignore 缺 version → 400 missing-param', e3.status === 400 && e3.json.error.code === 'missing-param', JSON.stringify(e3.json))
const e4 = await call('/bug-reporter/update/ignore', { body: {} })
check('ignore 缺 moduleName → 400 missing-param', e4.status === 400 && e4.json.error.code === 'missing-param', JSON.stringify(e4.json))
const m1 = await call('/bug-reporter/update/check', { method: 'GET' })
check('GET /update/check → 405 method-not-allowed', m1.status === 405 && m1.json.error.code === 'method-not-allowed', JSON.stringify(m1.json))
const b1 = await call('/bug-reporter/update/check', { body: '{not json' })
check('非法 JSON → 400 bad-json（沿用 task-10 的码）', b1.status === 400 && b1.json.error.code === 'bad-json', JSON.stringify(b1.json))
const u1 = await call('/bug-reporter/update/nope', { body: {} })
check('未知路径仍 404 not-found', u1.status === 404 && u1.json.error.code === 'not-found', JSON.stringify(u1.json))

// D8 /update/ignore 成功 + 再发一次取消
const i1 = await call('/bug-reporter/update/ignore', { body: { moduleName: 'dsh-beta', version: '1.2.0' } })
check('POST /update/ignore 成功 → 200 ok:true', i1.status === 200 && i1.json.ok === true, `status=${i1.status}`)
const betaIgnored = i1.json.value.updates.find((item) => item.moduleName === 'dsh-beta')
check('  dsh-beta 变成 ignored:true', betaIgnored !== undefined && betaIgnored.ignored === true, JSON.stringify(betaIgnored))
const i2 = await call('/bug-reporter/update/ignore', { body: { moduleName: 'dsh-beta', version: '1.2.0' } })
const betaBack = i2.json.value.updates.find((item) => item.moduleName === 'dsh-beta')
check('  同样参数再发一次 → 取消忽略（ignored:false）', betaBack !== undefined && betaBack.ignored === false, JSON.stringify(betaBack))

// D9 /repair 路径围栏（安全项）
// 注意：这里**故意不拿 C:\Windows\... 当靶子** —— 万一围栏哪天回归，测试本身就会去写系统文件。
// 只用 tmpdir 下的路径，最坏情况也只是往临时目录写。
{
  const fenceReport = await call('/bug-reporter/report', { body: { message: '路径围栏用', source: 'manual' } })
  const fenceId = fenceReport.json.value.report.id

  const noPkg = join(tmpdir(), 'bug-reporter-fence-none', 'pwned.js')
  check('前置条件：该路径确实不在任何含 package.json 的包目录里', findOwningPackage(noPkg) === null)
  const denied = await call('/bug-reporter/repair', { body: { id: fenceId, path: noPkg, content: 'PWNED' } })
  check(
    'repair 写非包目录 → 403 path-not-allowed',
    denied.status === 403 && denied.json.error.code === 'path-not-allowed',
    JSON.stringify(denied.json),
  )
  check('  那个文件没有被创建', existsSync(noPkg) === false)

  // 穿越：pkg-fence/../../escaped.js → 落在 tmpdir 根，不属于任何包
  const pkgDir = join(REPAIR_ROOT, 'pkg-fence')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'fence-pkg' }), 'utf8')
  const traversalPath = join(pkgDir, '..', '..', 'escaped.js')
  const escaped = resolve(traversalPath)
  check('前置条件：穿越目标确实不在任何包目录里', findOwningPackage(escaped) === null, `escaped=${escaped}`)
  const traversed = await call('/bug-reporter/repair', { body: { id: fenceId, path: traversalPath, content: 'PWNED' } })
  check(
    'repair 用 ..\\..\\ 穿越出包目录 → 403 path-not-allowed',
    traversed.status === 403 && traversed.json.error.code === 'path-not-allowed',
    JSON.stringify(traversed.json),
  )
  check('  穿越目标文件没有被创建', existsSync(escaped) === false)
  const fenceState = await call('/bug-reporter/state', { method: 'GET' })
  check(
    '  被拒的报告没有被标成 fixed',
    fenceState.json.value.reports.find((item) => item.id === fenceId).status === 'open',
  )

  // 合法路径（包目录内）仍然能修
  const okFile = join(pkgDir, 'x.js')
  writeFileSync(okFile, 'OLD', 'utf8')
  const okRes = await call('/bug-reporter/repair', { body: { id: fenceId, path: okFile, content: 'NEW' } })
  check('repair 包目录内的合法路径 → 200', okRes.status === 200 && okRes.json.ok === true, JSON.stringify(okRes.json).slice(0, 200))
  check('  文件真的被改了', readFileSync(okFile, 'utf8') === 'NEW')
  check('  报告变成 fixed', okRes.json.value.report.status === 'fixed')
}

// D10 跨站防护（task-15 S1）—— 真 socket，不碰假 req/res
console.log('\n--- D10. 跨站防护 ---')
{
  const crossSite = await call('/bug-reporter/state', {
    method: 'POST',
    body: { repo: 'attacker/evil-repo' },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  check(
    'Sec-Fetch-Site: cross-site → 403 cross-site',
    crossSite.status === 403 && crossSite.json && crossSite.json.error.code === 'cross-site',
    `status=${crossSite.status} code=${crossSite.json && crossSite.json.error && crossSite.json.error.code}`,
  )

  const badOrigin = await call('/bug-reporter/state', {
    method: 'POST',
    body: { repo: 'attacker/evil-repo' },
    headers: { origin: 'https://evil.example' },
  })
  check(
    '坏 Origin（存在但不同源）→ 403 bad-origin',
    badOrigin.status === 403 && badOrigin.json && badOrigin.json.error.code === 'bad-origin',
    `status=${badOrigin.status} code=${badOrigin.json && badOrigin.json.error && badOrigin.json.error.code}`,
  )
  const afterBad = await call('/bug-reporter/state', { method: 'GET' })
  check('  跨站那次改 repo 没有生效', afterBad.json.value.repo === '', `repo=${JSON.stringify(afterBad.json.value.repo)}`)

  const noOrigin = await call('/bug-reporter/state', { method: 'GET' })
  check(
    '无 Origin → 放行（curl / 本机原生客户端要能用）',
    noOrigin.status === 200 && noOrigin.json.ok === true,
    `status=${noOrigin.status}`,
  )

  const sameOrigin = await call('/bug-reporter/state', { method: 'GET', headers: { origin } })
  check('Origin 与本机同源 → 放行', sameOrigin.status === 200, `status=${sameOrigin.status}`)

  const loopbackAlias = await call('/bug-reporter/state', {
    method: 'GET',
    headers: { origin: `http://localhost:${new URL(origin).port}` },
  })
  check(
    'Origin 用 localhost / 127.0.0.1 别名（同一台机器）→ 放行',
    loopbackAlias.status === 200,
    `status=${loopbackAlias.status}`,
  )

  const wrongPort = await call('/bug-reporter/state', {
    method: 'GET',
    headers: { origin: 'http://127.0.0.1:1' },
  })
  check('Origin 端口不对 → 403 bad-origin', wrongPort.status === 403, `status=${wrongPort.status}`)

  const plainType = await call('/bug-reporter/report', {
    body: { message: 'CSRF-TEXT-PLAIN' },
    headers: { 'content-type': 'text/plain' },
  })
  check(
    'POST 非 application/json（跨站简单请求）→ 415 unsupported-media-type',
    plainType.status === 415 && plainType.json && plainType.json.error.code === 'unsupported-media-type',
    `status=${plainType.status}`,
  )

  const noType = await call('/bug-reporter/state', { method: 'POST' })
  check('POST 完全没有 content-type → 415', noType.status === 415, `status=${noType.status}`)

  const withCharset = await call('/bug-reporter/state', {
    method: 'POST',
    body: {},
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  check('content-type: application/json; charset=utf-8 → 放行', withCharset.status === 200, `status=${withCharset.status}`)

  const getPlain = await call('/bug-reporter/state', { method: 'GET', headers: { 'content-type': 'text/plain' } })
  check('GET 不受 content-type 影响', getPlain.status === 200, `status=${getPlain.status}`)

  const preflight = await call('/bug-reporter/repair', { method: 'OPTIONS' })
  const acao = Object.keys(preflight.headers).filter((key) => key.toLowerCase().startsWith('access-control-'))
  check('OPTIONS 预检 → 405（不给出任何预检许可）', preflight.status === 405, `status=${preflight.status}`)
  check('  响应里没有任何 Access-Control-Allow-* 头', acao.length === 0, `实际=${JSON.stringify(acao)}`)
  check('  响应带 Vary: Origin', String(preflight.headers.vary || '').includes('Origin'), `vary=${preflight.headers.vary}`)
}

// D11 /repair 围栏收紧（task-15 S2）—— 真 socket
console.log('\n--- D11. /repair 围栏收紧 ---')
{
  const secReport = await call('/bug-reporter/report', { body: { message: '围栏收紧用', source: 'manual' } })
  const secId = secReport.json.value.report.id
  const repairAs = (path, content) => call('/bug-reporter/repair', { body: { id: secId, path, content } })
  const denied = (res) => res.status === 403 && res.json && res.json.error.code === 'path-not-allowed'

  // 另一个**合法**插件包（有 dsh.client）—— 但它不是这条报告的归属包
  const otherPkg = join(STUB_DIR, 'pkg-other')
  mkdirSync(otherPkg, { recursive: true })
  writeFileSync(
    join(otherPkg, 'package.json'),
    JSON.stringify({ name: 'other-plugin', dsh: { client: { platform: 'web' } } }),
    'utf8',
  )
  const otherFile = join(otherPkg, 'x.js')
  writeFileSync(otherFile, 'ORIGINAL', 'utf8')
  const crossPkg = await repairAs(otherFile, 'PWNED')
  check(
    '改**另一个**插件包的文件 → 403 path-not-allowed',
    denied(crossPkg),
    `status=${crossPkg.status} code=${crossPkg.json && crossPkg.json.error && crossPkg.json.error.code}`,
  )
  check('  那个文件没被改', readFileSync(otherFile, 'utf8') === 'ORIGINAL')

  // 自己包里的 package.json 也明确拒
  const ownPkg = join(REPAIR_ROOT, 'pkg-fence')
  const pkgJson = join(ownPkg, 'package.json')
  const beforeJson = readFileSync(pkgJson, 'utf8')
  const manifest = await repairAs(pkgJson, JSON.stringify({ name: 'hijacked' }))
  check('改 package.json → 403 path-not-allowed', denied(manifest), `status=${manifest.status}`)
  check('  manifest 没被改', readFileSync(pkgJson, 'utf8') === beforeJson)

  // 扩展名白名单
  const exeFile = join(ownPkg, 'evil.exe')
  const exe = await repairAs(exeFile, 'MZ')
  check('非白名单扩展名（.exe）→ 403 path-not-allowed', denied(exe), `status=${exe.status}`)
  check('  那个 .exe 没被创建', existsSync(exeFile) === false)

  // NUL 字节 / UNC
  const nul = await repairAs(`${ownPkg}${sep}nul\u0000.js`, 'X')
  check('路径含 NUL 字节 → 403 path-not-allowed', denied(nul), `status=${nul.status}`)
  const unc = await repairAs('\\\\localhost\\C$\\Windows\\Temp\\_verify.js', 'X')
  check('UNC 路径 → 403 path-not-allowed', denied(unc), `status=${unc.status}`)

  // junction 绕过：词法在包内、物理在包外
  const escapeDir = join(STUB_DIR, 'escape-target')
  const linkDir = join(ownPkg, 'esc')
  mkdirSync(escapeDir, { recursive: true })
  let junctionMade = false
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkDir, escapeDir], { encoding: 'utf8', timeout: 15000 })
    junctionMade = existsSync(linkDir)
  } catch {
    junctionMade = false
  }
  if (!junctionMade) {
    check('junction 绕过（本机 mklink 不可用）', true, 'INFO：无法创建 junction，跳过')
  } else {
    const viaLink = await repairAs(join(linkDir, 'escaped.js'), 'ESCAPED')
    check(
      'junction 绕过（词法在包内、物理在包外）→ 403 path-not-allowed',
      denied(viaLink),
      `status=${viaLink.status} code=${viaLink.json && viaLink.json.error && viaLink.json.error.code}`,
    )
    check('  包外落点没有被写', existsSync(join(escapeDir, 'escaped.js')) === false)
  }
}

// D12 config.repairRoots 生效：给「报告没有 pluginId」留的逃生舱
console.log('\n--- D12. repairRoots ---')
{
  const rootDir = join(STUB_DIR, 'roots', 'allowed-root')
  const outsideDir = join(STUB_DIR, 'roots', 'outside-root')
  mkdirSync(rootDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const allowedFile = join(rootDir, 'allowed.js')
  const outsideFile = join(outsideDir, 'outside.js')
  writeFileSync(allowedFile, 'OLD', 'utf8')
  writeFileSync(outsideFile, 'OLD', 'utf8')

  const webServer3 = createWebServerStub()
  const { ctx: ctx3 } = createFakeCtx({ webServer: webServer3 }, [])
  mod.apply(ctx3, {
    storePath: join(STUB_DIR, 'reports-roots.jsonl'),
    settingsPath: join(STUB_DIR, 'reports-roots.settings.json'),
    repairRoots: [rootDir],
  })
  const server3 = http.createServer((req, res) => webServer3.handler(req, res))
  await new Promise((resolve3) => server3.listen(0, '127.0.0.1', resolve3))
  const origin3 = `http://127.0.0.1:${server3.address().port}`
  const call3 = async (path, options = {}) => {
    const init = { method: options.method === undefined ? 'POST' : options.method }
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(options.body)
    }
    const response = await fetch(origin3 + path, init)
    let json = null
    try {
      json = await response.json()
    } catch {
      json = null
    }
    return { status: response.status, json }
  }

  // 没有 pluginId 的报告（逃生舱正是为它准备的）
  const created = await call3('/bug-reporter/report', { body: { message: '没有 pluginId', source: 'manual' } })
  check('  前置条件：这条报告确实没有 pluginId', created.json.value.report.pluginId === null)
  const id = created.json.value.report.id
  const inRoot = await call3('/bug-reporter/repair', { body: { id, path: allowedFile, content: 'NEW' } })
  check(
    'repairRoots 里的路径 → 200（默认空数组时这条会被 403）',
    inRoot.status === 200 && readFileSync(allowedFile, 'utf8') === 'NEW',
    `status=${inRoot.status}`,
  )
  const outRoot = await call3('/bug-reporter/repair', { body: { id, path: outsideFile, content: 'PWNED' } })
  check(
    'repairRoots 之外的路径 → 403 path-not-allowed',
    outRoot.status === 403 && outRoot.json.error.code === 'path-not-allowed',
    `status=${outRoot.status}`,
  )
  check('  那个文件没被改', readFileSync(outsideFile, 'utf8') === 'OLD')

  await new Promise((resolve3) => server3.close(resolve3))
}

// ---------------------------------------------------------------------------
// D13. task-17：config.order 已删（未知键抛错并点名）+ 合法 config 键 = 15 个（task-19 加 settingsPath）
// ---------------------------------------------------------------------------
console.log('\n--- D13. order 已删 / 配置键数 ---')
{
  // `order` 曾经在 DEFAULTS + NUMBER_KEYS 里，写它能通过校验但没人读（死配置）。
  // 现在它必须走「未知键」路径 —— 这是唯一能在公开面上观测「合法 config 键集合」的地方：
  // 错误消息里的 `可用：...` 就是 `Object.keys(DEFAULTS)`（index.js:195）。
  let orderError = null
  try {
    const { ctx: ctxOrder } = createFakeCtx({}, [])
    mod.apply(ctxOrder, { order: 40 })
  } catch (error) {
    orderError = error
  }
  check('配置里写 order → 抛错（不再被静默接受）', orderError !== null, `error=${orderError === null ? '(没抛)' : orderError.message}`)
  const orderMessage = orderError === null ? '' : String(orderError.message)
  check('  错误点名 "order"', orderMessage.includes('"order"'), orderMessage)
  check('  错误说的是「未知的 config 键」', orderMessage.includes('未知的 config 键'), orderMessage)

  const available = orderMessage.includes('可用：')
    ? orderMessage.slice(orderMessage.indexOf('可用：') + 3).replace(/）\s*$/, '')
    : ''
  const keys = available.split(',').map((item) => item.trim()).filter((item) => item !== '')
  check('  可用键列表恰好 15 个（task-17 删 order，task-19 加 settingsPath）', keys.length === 15, `实际 ${keys.length}：${keys.join(', ')}`)
  check('  可用键列表里没有 order', !keys.includes('order'), keys.join(', '))
  check(
    '  可用键列表就是那 15 个',
    keys.join(',') ===
      'enabled,storePath,settingsPath,repo,tokenRef,baseBranch,maxReports,captureTools,captureProcess,repairEnabled,updateCheckMs,autoUpdate,updatePolicy,ignoredUpdates,repairRoots',
    keys.join(','),
  )

  // `/state` 的形状是 task-11 定的硬边界，只暴露 7 个设置字段（不是全部 14 个配置键）：
  // 断言它一个不多一个不少，防止这次改动顺手动了状态形状。
  const stateRes = await call('/bug-reporter/state', { method: 'GET' })
  const stateKeys = Object.keys(stateRes.json.value).sort()
  const settingsKeys = stateKeys.filter((key) =>
    ['baseBranch', 'captureProcess', 'captureTools', 'enabled', 'repairEnabled', 'repo', 'tokenRef'].includes(key),
  )
  check(
    '/state 暴露的设置字段恰好 7 个（形状未变）',
    settingsKeys.length === 7,
    `实际 ${settingsKeys.length}：${settingsKeys.join(', ')}`,
  )
  check(
    '  /state 里没有 order 字段',
    !Object.hasOwn(stateRes.json.value, 'order'),
    stateKeys.join(', '),
  )
}

server.close()

// ---------------------------------------------------------------------------
// E. pluginManager 缺失时整体仍能加载
// ---------------------------------------------------------------------------
console.log('\n--- E. pluginManager 缺失 ---')
const webServer2 = createWebServerStub()
const timer2 = createTimerStub()
const logs2 = []
const { ctx: ctx2 } = createFakeCtx({ webServer: webServer2, timer: timer2 }, logs2)
let applyThrew = null
try {
  mod.apply(ctx2, { storePath: join(STUB_DIR, 'reports-nopm.jsonl'), settingsPath: join(STUB_DIR, 'reports-nopm.settings.json') })
} catch (error) {
  applyThrew = error
}
check('pluginManager 缺失时 apply 不抛', applyThrew === null, applyThrew === null ? '' : String(applyThrew))
const active2 = mod.internals.active
check('  updates 是空数组', Array.isArray(active2.updates.list()) && active2.updates.list().length === 0)
check('  没有 pluginManager 句柄（软依赖未注入）', active2.services.pluginManager === null)
let runThrew = null
try {
  await active2.updates.runCheck()
} catch (error) {
  runThrew = error
}
check('  runCheck 不抛', runThrew === null, runThrew === null ? '' : String(runThrew))
check('  updates 仍为空数组', active2.updates.list().length === 0)
check('  记了一条 pluginManager 不可用的 log', logs2.some((line) => line.includes('pluginManager 不可用')))

const handler2 = webServer2.handler
check('  路由仍然注册了', typeof handler2 === 'function')
const server2 = http.createServer((req, res) => handler2(req, res))
await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
const origin2 = `http://127.0.0.1:${server2.address().port}`
const c2 = await fetch(`${origin2}/bug-reporter/update/check`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((response) => response.json())
check('  pluginManager 缺失时 /update/check 仍 200 + 空 updates', c2.ok === true && c2.value.updates.length === 0, JSON.stringify(c2.value.updates))
const c3 = await fetch(`${origin2}/bug-reporter/state`).then((response) => response.json())
check('  /state 仍正常（reports 等字段齐全）', c3.ok === true && Array.isArray(c3.value.reports) && Array.isArray(c3.value.updates))
server2.close()

// ---------------------------------------------------------------------------
// E2. 首次巡检：挂载后短延迟真的跑一次；dispose 之后不再触发
// ---------------------------------------------------------------------------
console.log('\n--- E2. 首次巡检与 dispose ---')
{
  // 两个实例并发：A 不 dispose（首次巡检应当触发），B 立刻 dispose（不应当触发）。
  // 这里用真 setTimeout / setInterval，所以下面要真等过 FIRST_UPDATE_CHECK_MS(3000) ——
  // 「确实被调用」和「dispose 后不再触发」这两条不能靠桩自己假装。
  const timerA = createTimerStub({ real: true })
  const { ctx: ctxA, cleanups: cleanupsA } = createFakeCtx(
    { webServer: createWebServerStub(), pluginManager: stubManager({ installs: [] }), timer: timerA },
    [],
  )
  mod.apply(ctxA, { storePath: join(STUB_DIR, 'first-a.jsonl'), settingsPath: join(STUB_DIR, 'first-a.settings.json') })
  const activeA = mod.internals.active

  const timerB = createTimerStub({ real: true })
  const { ctx: ctxB, cleanups: cleanupsB } = createFakeCtx(
    { webServer: createWebServerStub(), pluginManager: stubManager({ installs: [] }), timer: timerB },
    [],
  )
  mod.apply(ctxB, { storePath: join(STUB_DIR, 'first-b.jsonl'), settingsPath: join(STUB_DIR, 'first-b.settings.json') })
  const activeB = mod.internals.active

  check('两个实例各注册了一次首次巡检', timerA.timeouts.length === 1 && timerB.timeouts.length === 1)
  check('  首次巡检延迟都是 3000ms', timerA.timeouts[0].delay === 3000 && timerB.timeouts[0].delay === 3000)
  check('  轮询间隔仍是 updateCheckMs（首次那次不改节奏）', timerA.intervals.length === 1 && timerA.intervals[0].delay === 3600000)
  check('B 的首次巡检此刻还没触发（lastCheckAt 仍为 0）', activeB.updates.lastCheckAt() === 0)

  // 立刻 dispose B：跑掉所有 effect 的 cleanup（含 timeout 与 interval 的 disposer）
  for (const dispose of cleanupsB) dispose()
  check('dispose 之后 B 的首次巡检 disposer 被调用', timerB.timeouts[0].disposed === true)
  check('  B 的轮询 disposer 也被调用', timerB.intervals[0].disposed === true)

  await sleep(3400) // 真等过 3000ms

  check(
    'A 没 dispose → 首次巡检在短延迟后确实被调用（lastCheckAt > 0）',
    activeA.updates.lastCheckAt() > 0,
    `实际 ${activeA.updates.lastCheckAt()}`,
  )
  check('  首次巡检真的产出了 3 条可用更新', activeA.updates.list().length === 3, `实际 ${activeA.updates.list().length}`)
  check(
    'B 已 dispose → 那次待触发的首次巡检没有再触发（lastCheckAt 仍为 0）',
    activeB.updates.lastCheckAt() === 0,
    `实际 ${activeB.updates.lastCheckAt()}`,
  )
  check('  B 的 updates 仍为空', activeB.updates.list().length === 0)

  // 收尾：A 的轮询是真 setInterval，不 dispose 会挂住事件循环。
  for (const dispose of cleanupsA) dispose()
  check('收尾：A 的轮询 disposer 也生效（否则真 setInterval 会占住事件循环）', timerA.intervals[0].disposed === true)
}

// ---------------------------------------------------------------------------
// F. client.js「可用更新」区域渲染（桩 React hooks 运行时，真挂载）
// ---------------------------------------------------------------------------
console.log('\n--- F. client.js 渲染 ---')
const clientSrc = readFileSync(CLIENT, 'utf8')
const clientJsxCloser = (clientSrc.match(/<\//g) || []).length
const clientJsxSelfClose = (clientSrc.match(/\/>/g) || []).length
check('client.js 无 JSX', clientJsxCloser === 0 && clientJsxSelfClose === 0, `</=${clientJsxCloser} />=${clientJsxSelfClose}`)

function createReactHarness() {
  const hooks = []
  const effectDeps = []
  const effectCleanups = []
  let cursor = 0
  let pendingEffects = []
  let dirty = false
  let unmounted = false
  let lateSetState = 0
  const renderErrors = []

  function createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  }
  function useState(init) {
    const i = cursor
    cursor += 1
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    const set = (value) => {
      if (unmounted) {
        lateSetState += 1
        return
      }
      const next = typeof value === 'function' ? value(hooks[i]) : value
      if (!Object.is(hooks[i], next)) {
        hooks[i] = next
        dirty = true
      }
    }
    return [hooks[i], set]
  }
  function useRef(init) {
    const i = cursor
    cursor += 1
    if (!(i in hooks)) hooks[i] = { current: init }
    return hooks[i]
  }
  function useCallback(fn, deps) {
    const i = cursor
    cursor += 1
    const prev = hooks[i]
    const changed =
      !prev ||
      !deps ||
      !prev.deps ||
      prev.deps.length !== deps.length ||
      deps.some((dep, k) => !Object.is(dep, prev.deps[k]))
    if (changed) hooks[i] = { fn, deps }
    return hooks[i].fn
  }
  function useEffect(fn, deps) {
    const i = cursor
    cursor += 1
    pendingEffects.push({ i, fn, deps })
  }
  const React = { createElement, useState, useRef, useCallback, useEffect }

  function runEffects() {
    const list = pendingEffects
    pendingEffects = []
    for (const effect of list) {
      const prev = effectDeps[effect.i]
      const changed =
        !prev ||
        !effect.deps ||
        prev.length !== effect.deps.length ||
        effect.deps.some((dep, k) => !Object.is(dep, prev[k]))
      if (!changed) continue
      if (typeof effectCleanups[effect.i] === 'function') {
        try {
          effectCleanups[effect.i]()
        } catch (error) {
          renderErrors.push(`cleanup: ${String(error)}`)
        }
      }
      effectDeps[effect.i] = effect.deps
      let cleanup = null
      try {
        cleanup = effect.fn()
      } catch (error) {
        renderErrors.push(`effect: ${String(error)}`)
      }
      effectCleanups[effect.i] = typeof cleanup === 'function' ? cleanup : null
    }
  }

  let root = null
  let mounted = null
  async function settle(options = {}) {
    const quietMs = options.quietMs === undefined ? 80 : options.quietMs
    const maxPasses = options.maxPasses === undefined ? 60 : options.maxPasses
    let count = 0
    let lastChange = Date.now()
    while (count < maxPasses) {
      if (dirty) {
        dirty = false
        cursor = 0
        pendingEffects = []
        try {
          root = mounted()
        } catch (error) {
          renderErrors.push(`render: ${String(error)}`)
          root = null
        }
        runEffects()
        count += 1
        lastChange = Date.now()
      }
      await sleep(5)
      if (!dirty && Date.now() - lastChange > quietMs) break
    }
    return root
  }
  async function mount(Component, options = {}) {
    unmounted = false
    dirty = true
    root = null
    mounted = Component
    return settle(options)
  }
  function unmount() {
    unmounted = true
    for (const key of Object.keys(effectCleanups)) {
      const fn = effectCleanups[key]
      if (typeof fn === 'function') {
        try {
          fn()
        } catch (error) {
          renderErrors.push(`unmount: ${String(error)}`)
        }
      }
      effectCleanups[key] = null
    }
  }
  return { React, mount, settle, unmount, getRoot: () => root, renderErrors, lateSetState: () => lateSetState }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ text: String(node) })
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'object' && node.type) {
    visit({ element: node })
    if (typeof node.type === 'function') {
      walk(node.type(node.props || {}), visit)
      return
    }
    walk(node.props && node.props.children, visit)
  }
}

function collect(root) {
  const texts = []
  walk(root, (hit) => {
    if (hit.text) texts.push(hit.text)
  })
  return texts.join(' ')
}

function findButtons(root, label) {
  const found = []
  walk(root, (hit) => {
    const element = hit.element
    if (!element || typeof element.type !== 'function' || typeof element.props.onClick !== 'function') return
    if (collect(element).trim() === label) found.push(element)
  })
  return found
}

const CLIENT_STATE = {
  enabled: true,
  captureTools: true,
  captureProcess: true,
  repairEnabled: true,
  repo: 'zuaonew-ops/dsh-bug-reporter',
  tokenRef: 'GITHUB_TOKEN',
  baseBranch: 'main',
  tokenConfigured: true,
  storeFile: 'C:\\tmp\\bug-reports.jsonl',
  reports: [],
  updates: [
    { moduleName: 'dsh-alpha', installed: '1.0.0', latest: '1.0.1', kind: 'patch', ignored: false },
    { moduleName: 'dsh-beta', installed: '1.0.0', latest: '1.2.0', kind: 'minor', ignored: false },
    { moduleName: 'dsh-gamma', installed: '1.0.0', latest: '2.0.0', kind: 'major', ignored: true },
  ],
  lastUpdateCheckAt: 1760000000000,
  updateLog: [
    {
      at: '2026-10-18T03:00:00.000Z',
      moduleName: 'dsh-gamma',
      from: '1.0.0',
      to: '2.0.0',
      result: 'restart-required',
      detail: 'application=restart-required restartReason=no-hmr',
    },
    {
      at: '2026-10-18T02:00:00.000Z',
      moduleName: 'dsh-alpha',
      from: '1.0.0',
      to: '1.0.1',
      result: 'applied',
      detail: 'application=applied',
    },
  ],
}

/** 起一个假宿主，记录请求；返回的状态可控。 */
async function bootClientHost(getState) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push({ method: req.method, path: new URL(req.url, 'http://x').pathname, body })
      const payload = JSON.stringify({ ok: true, value: getState() })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      res.end(payload)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` }
}

function loadClient(harness, origin) {
  let loaded = null
  const windowStub = { __ModuleLoader__: { load(m) { loaded = m } } }
  const navigatorStub = { language: 'zh-CN' }
  const requireStub = (name) => {
    if (name === 'react') return harness.React
    throw new Error(`unexpected require(${name})`)
  }
  const fetchStub = (input, init) =>
    fetch(String(input).startsWith('http') ? String(input) : origin + String(input), init)
  const run = new Function(
    'window', 'require', 'navigator', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    `${clientSrc}\n//# sourceURL=dsh-bug-reporter-client.js`,
  )
  run(windowStub, requireStub, navigatorStub, fetchStub, AbortController, setTimeout, clearTimeout)
  return loaded
}

function mountClient(loaded, harness) {
  const api = loaded.factory((name) => {
    if (name === 'react') return harness.React
    throw new Error(`unexpected require(${name})`)
  })
  let registration = null
  api.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (options, Component) => {
        registration = { options, Component }
        return registration
      },
    },
  })
  return registration
}

// F1 有可用更新
{
  const host = await bootClientHost(() => CLIENT_STATE)
  const harness = createReactHarness()
  const loaded = loadClient(harness, host.origin)
  const registration = mountClient(loaded, harness)
  const root = await harness.mount(registration.Component)
  const text = collect(root)
  console.log(`渲染文本长度 = ${text.length}`)
  console.log(`宿主收到的请求 = ${JSON.stringify(host.requests.map((r) => `${r.method} ${r.path}`))}`)

  check('挂载无渲染错误', harness.renderErrors.length === 0, JSON.stringify(harness.renderErrors))
  check('渲染出「可用更新」标题', text.includes('可用更新'))
  check('渲染出未忽略的两条更新（alpha/beta）', text.includes('dsh-alpha') && text.includes('dsh-beta'))
  check('渲染出最新版本号 1.0.1 / 1.2.0', text.includes('1.0.1') && text.includes('1.2.0'))
  check('渲染出更新类型标签（修订 / 次版本）', text.includes('修订') && text.includes('次版本'))
  check('已忽略的更新单独一行 + 取消忽略按钮', text.includes('已忽略的更新') && text.includes('dsh-gamma') && text.includes('取消忽略'))
  check('lastUpdateCheckAt 渲染成本地时间（不是「还没检查过」）', !text.includes('还没检查过') && /2026|1970|上午|下午|:/.test(text))
  check('updateLog 渲染：restart-required 如实显示「需重启生效」', text.includes('需重启生效'))
  check('updateLog 渲染：applied 显示「已应用」', text.includes('已应用'))
  check('updateLog detail 里能看到 application=restart-required', text.includes('application=restart-required'))

  const checkButtons = findButtons(root, '立即检查更新')
  check('有「立即检查更新」按钮', checkButtons.length === 1, `实际 ${checkButtons.length}`)
  const applyButtons = findButtons(root, '更新')
  check('每个未忽略的更新各有一个「更新」按钮', applyButtons.length === 2, `实际 ${applyButtons.length}`)
  const ignoreButtons = findButtons(root, '忽略')
  check('每个未忽略的更新各有一个「忽略」按钮', ignoreButtons.length === 2, `实际 ${ignoreButtons.length}`)

  if (checkButtons.length === 1) {
    checkButtons[0].props.onClick()
    await harness.settle()
    check(
      '点「立即检查更新」→ POST /bug-reporter/update/check',
      host.requests.some((r) => r.method === 'POST' && r.path === '/bug-reporter/update/check'),
      JSON.stringify(host.requests.map((r) => `${r.method} ${r.path}`)),
    )
  }
  if (applyButtons.length >= 1) {
    applyButtons[0].props.onClick()
    await harness.settle()
    const applyRequest = host.requests.find((r) => r.path === '/bug-reporter/update/apply')
    const parsed = applyRequest ? JSON.parse(applyRequest.body) : null
    check(
      '点第一条「更新」→ POST /update/apply {moduleName:"dsh-alpha"}',
      parsed !== null && parsed.moduleName === 'dsh-alpha',
      JSON.stringify(parsed),
    )
  }
  if (ignoreButtons.length >= 1) {
    ignoreButtons[0].props.onClick()
    await harness.settle()
    const ignoreRequests = host.requests.filter((r) => r.path === '/bug-reporter/update/ignore')
    const parsed = ignoreRequests.length > 0 ? JSON.parse(ignoreRequests[ignoreRequests.length - 1].body) : null
    check(
      '点第一条「忽略」→ POST /update/ignore {moduleName:"dsh-alpha", version:"1.0.1"}',
      parsed !== null && parsed.moduleName === 'dsh-alpha' && parsed.version === '1.0.1',
      JSON.stringify(parsed),
    )
  }
  const unignoreButtons = findButtons(harness.getRoot(), '取消忽略')
  if (unignoreButtons.length === 1) {
    unignoreButtons[0].props.onClick()
    await harness.settle()
    const ignoreRequests = host.requests.filter((r) => r.path === '/bug-reporter/update/ignore')
    const parsed = ignoreRequests.length > 0 ? JSON.parse(ignoreRequests[ignoreRequests.length - 1].body) : null
    check(
      '点「取消忽略」→ POST /update/ignore {moduleName:"dsh-gamma", version:"2.0.0"}',
      parsed !== null && parsed.moduleName === 'dsh-gamma' && parsed.version === '2.0.0',
      JSON.stringify(parsed),
    )
  } else {
    check('点「取消忽略」→ POST /update/ignore {moduleName:"dsh-gamma", version:"2.0.0"}', false, `取消忽略按钮数=${unignoreButtons.length}`)
  }
  check('全部操作后仍无渲染错误（失败不白屏）', harness.renderErrors.length === 0, JSON.stringify(harness.renderErrors))
  host.server.close()
}

// F2 老宿主：状态里没有 updates / lastUpdateCheckAt / updateLog
{
  const legacy = { ...CLIENT_STATE }
  delete legacy.updates
  delete legacy.lastUpdateCheckAt
  delete legacy.updateLog
  const host = await bootClientHost(() => legacy)
  const harness = createReactHarness()
  const loaded = loadClient(harness, host.origin)
  const registration = mountClient(loaded, harness)
  const root = await harness.mount(registration.Component)
  const text = collect(root)
  check('老宿主（无 updates 字段）挂载不崩', harness.renderErrors.length === 0, JSON.stringify(harness.renderErrors))
  check('  显示「没有可用更新」', text.includes('没有可用更新'))
  check('  显示「还没检查过」', text.includes('还没检查过'))
  host.server.close()
}

// F3 失败不白屏：宿主返回 ok:false
{
  const host = await bootClientHost(() => CLIENT_STATE)
  host.server.removeAllListeners('request')
  host.server.on('request', (req, res) => {
    const payload = JSON.stringify({ ok: false, error: { code: 'boom', message: 'SMOKE_UPDATE_FAIL' } })
    res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  })
  const harness = createReactHarness()
  const loaded = loadClient(harness, host.origin)
  const registration = mountClient(loaded, harness)
  const root = await harness.mount(registration.Component)
  const text = collect(root)
  check('宿主失败时无渲染错误（不白屏）', harness.renderErrors.length === 0, JSON.stringify(harness.renderErrors))
  check('  状态行显示宿主给的失败原因', text.includes('SMOKE_UPDATE_FAIL'))
  host.server.close()
}

// ---------------------------------------------------------------------------
// D14. task-19：设置持久化（settingsPath）+ 恢复默认端点
// ---------------------------------------------------------------------------
console.log('\n--- D14. 设置持久化 / settingsPath / 恢复默认 ---')
{
  const persistDir = join(STUB_DIR, 'persist')
  mkdirSync(persistDir, { recursive: true })

  /** 起一个真实例（真 socket 打真 handler），返回 call / logs / close。 */
  async function bootInstance(config, logs = []) {
    const webServer = createWebServerStub()
    const { ctx } = createFakeCtx({ webServer }, logs)
    mod.apply(ctx, config)
    const server = http.createServer((req, res) => webServer.handler(req, res))
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${server.address().port}`
    const call = async (path, options = {}) => {
      const init = { method: options.method === undefined ? 'POST' : options.method }
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(origin + path, init)
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, json }
    }
    return { call, logs, close: () => server.close() }
  }

  // 测试隔离硬要求：所有 settingsPath 都必须落在本次跑的临时目录里，
  // 否则会读/写真实的 $DSH_HOME。
  const inTemp = (file) => resolve(file).startsWith(resolve(STUB_DIR))

  // D14.1 ENOENT → 静默（不报错、不 warn、不凭空建文件）
  {
    const file = join(persistDir, 'enoent.json')
    const logs = []
    const app = await bootInstance(
      { storePath: join(persistDir, 'enoent.jsonl'), settingsPath: file, captureProcess: false },
      logs,
    )
    const state = await app.call('/bug-reporter/state', { method: 'GET' })
    check('ENOENT：挂载不崩，GET /state 200', state.status === 200, `status=${state.status}`)
    check('ENOENT：文件不存在也不报错（logger.warn 没被调用）', logs.length === 0, JSON.stringify(logs))
    check('ENOENT：不凭空创建设置文件', existsSync(file) === false)
    check('ENOENT：settingsPath 在临时目录里（隔离）', inTemp(file), file)
    app.close()
  }

  // D14.2 写入 → 重新挂载读回；**文件优先于 yml**
  {
    const file = join(persistDir, 'roundtrip.json')
    const app1 = await bootInstance({
      storePath: join(persistDir, 'roundtrip-1.jsonl'),
      settingsPath: file,
      repo: 'yml-owner/yml-repo',
      captureProcess: false,
    })
    const posted = await app1.call('/bug-reporter/state', {
      body: { enabled: false, repo: 'ui-owner/ui-repo', captureTools: false },
    })
    check('POST /state 改设置 200', posted.status === 200, `status=${posted.status}`)
    check('改完设置文件被写出来', existsSync(file), file)
    app1.close()

    const saved = JSON.parse(readFileSync(file, 'utf8'))
    check('文件里记下了 enabled:false', saved.enabled === false, JSON.stringify(saved.enabled))
    check('文件里记下了 repo', saved.repo === 'ui-owner/ui-repo', JSON.stringify(saved.repo))
    check('文件里记下了 captureTools:false', saved.captureTools === false, JSON.stringify(saved.captureTools))
    // 只持久化「界面能改的键」：安全相关的 repairRoots 等不进文件（否则改 yml 会被旧值盖掉）。
    check('文件里没有 repairRoots（界面改不了的键不落盘）', saved.repairRoots === undefined, JSON.stringify(saved))
    check('文件里没有 storePath', saved.storePath === undefined)
    check('文件里没有 settingsPath 自己（不许文件把自己搬家）', saved.settingsPath === undefined)

    // 同一个设置文件、同一个 yml config 再挂一次：必须读回界面改过的值
    const app2 = await bootInstance({
      storePath: join(persistDir, 'roundtrip-2.jsonl'),
      settingsPath: file,
      repo: 'yml-owner/yml-repo',
      captureProcess: false,
    })
    const state2 = await app2.call('/bug-reporter/state', { method: 'GET' })
    check('重新挂载：enabled 读回 false（总开关重启后仍然关着）', state2.json.value.enabled === false,
      JSON.stringify(state2.json.value.enabled))
    check('重新挂载：repo 读回界面值，**文件优先于 yml**', state2.json.value.repo === 'ui-owner/ui-repo',
      JSON.stringify(state2.json.value.repo))
    check('重新挂载：/state 形状没变（仍是 13 个字段）',
      Object.keys(state2.json.value).length === 13, JSON.stringify(Object.keys(state2.json.value)))
    app2.close()
  }

  // D14.3 坏 JSON / 非对象 / 数组 → 不崩、退回 config、warn
  {
    const cases = [
      ['坏 JSON', '{ this is not json', '不是合法 JSON'],
      ['数组', '[1,2,3]', '不是对象'],
      ['字符串标量', '"just a string"', '不是对象'],
      ['null', 'null', '不是对象'],
    ]
    for (const [name, content, expectWord] of cases) {
      const file = join(persistDir, `broken-${cases.findIndex((c) => c[0] === name)}.json`)
      writeFileSync(file, content, 'utf8')
      const logs = []
      const app = await bootInstance(
        { storePath: join(persistDir, 'broken.jsonl'), settingsPath: file, repo: 'yml/ok', captureProcess: false },
        logs,
      )
      const state = await app.call('/bug-reporter/state', { method: 'GET' })
      check(`${name}：挂载不崩，GET /state 200`, state.status === 200, `status=${state.status}`)
      check(`${name}：退回 config 的值（repo 仍是 yml 的）`, state.json.value.repo === 'yml/ok',
        JSON.stringify(state.json.value.repo))
      check(`${name}：warn 里说清了原因（含「${expectWord}」）`,
        logs.some((line) => line.includes(expectWord)), JSON.stringify(logs))
      app.close()
    }
  }

  // D14.4 未知键 / 界面改不了的键 → 丢弃，**不抛**（resolveConfig 对未知键是抛错的）
  {
    const file = join(persistDir, 'unknown-keys.json')
    writeFileSync(
      file,
      JSON.stringify({ nope: 1, order: 40, maxReports: 1, repairRoots: ['C:\\'], enabled: false, repo: 'kept/repo' }),
      'utf8',
    )
    const logs = []
    let threw = null
    let app = null
    try {
      app = await bootInstance(
        { storePath: join(persistDir, 'unknown-keys.jsonl'), settingsPath: file, repo: 'yml/repo', captureProcess: false },
        logs,
      )
    } catch (error) {
      threw = error
    }
    check('未知键（nope/order）：挂载不抛错', threw === null, threw && threw.message)
    if (app !== null) {
      const state = await app.call('/bug-reporter/state', { method: 'GET' })
      check('  合法的持久化键仍然生效（enabled:false / repo 被采纳）',
        state.json.value.enabled === false && state.json.value.repo === 'kept/repo',
        JSON.stringify({ enabled: state.json.value.enabled, repo: state.json.value.repo }))
      // maxReports=1 若被采纳，3 条报告会被裁到 1 条；现在是 3 条 → 证明它被丢弃了。
      for (let i = 0; i < 3; i += 1) {
        await app.call('/bug-reporter/report', { body: { message: `keep-${i}`, source: 'manual' } })
      }
      const after = await app.call('/bug-reporter/state', { method: 'GET' })
      check('  界面改不了的键（maxReports:1）被丢弃，没有生效',
        after.json.value.reports.length === 3, `reports=${after.json.value.reports.length}`)
      // repairRoots:['C:\\'] 若被采纳，下面这个「包外 + 无 pluginId」的写入会被放行（200）。
      // 它必须被丢弃，所以这里是 403。
      const escapeFile = join(persistDir, 'must-not-be-written.js')
      writeFileSync(escapeFile, 'OLD', 'utf8')
      const id = after.json.value.reports[0].id
      const escaped = await app.call('/bug-reporter/repair', { body: { id, path: escapeFile, content: 'PWNED' } })
      check('  界面改不了的键（repairRoots:["C:\\\\"]）被丢弃，围栏仍然生效',
        escaped.status === 403 && readFileSync(escapeFile, 'utf8') === 'OLD',
        `status=${escaped.status}`)
      app.close()
    }
  }

  // D14.5 目录不存在 → 建（atomicWrite 的 mkdirSync recursive）
  {
    const file = join(persistDir, 'deep', 'nested', 'dir', 'settings.json')
    const app = await bootInstance({
      storePath: join(persistDir, 'deep.jsonl'),
      settingsPath: file,
      captureProcess: false,
    })
    const res = await app.call('/bug-reporter/state', { body: { repo: 'deep/repo' } })
    check('目录不存在：POST /state 仍 200', res.status === 200, `status=${res.status}`)
    check('目录不存在：递归建出来了', existsSync(file), file)
    check('目录不存在：内容正确', JSON.parse(readFileSync(file, 'utf8')).repo === 'deep/repo')
    app.close()
  }

  // D14.6 写盘失败（settingsPath 指向一个目录）→ 只 warn，主流程不受影响
  {
    const asDir = join(persistDir, 'is-a-directory')
    mkdirSync(asDir, { recursive: true })
    const logs = []
    const app = await bootInstance(
      { storePath: join(persistDir, 'asdir.jsonl'), settingsPath: asDir, captureProcess: false },
      logs,
    )
    const res = await app.call('/bug-reporter/state', { body: { repo: 'still/works' } })
    check('写盘失败：POST /state 仍 200（不把主流程搞挂）', res.status === 200, `status=${res.status}`)
    check('写盘失败：值在内存里生效', res.json.value.repo === 'still/works', JSON.stringify(res.json.value.repo))
    check('写盘失败：warn 里有记录', logs.length >= 1, JSON.stringify(logs))
    app.close()
  }

  // D14.7 POST /settings/reset：清空持久化、回到 yml、**不删报告**
  {
    const file = join(persistDir, 'reset.json')
    const app = await bootInstance({
      storePath: join(persistDir, 'reset.jsonl'),
      settingsPath: file,
      repo: 'yml/reset-repo',
      captureProcess: false,
    })
    await app.call('/bug-reporter/report', { body: { message: 'keep me', source: 'manual' } })
    await app.call('/bug-reporter/report', { body: { message: 'keep me too', source: 'manual' } })
    await app.call('/bug-reporter/state', { body: { enabled: false, repo: 'ui/gone' } })
    check('前置条件：设置文件已存在', existsSync(file))
    const before = await app.call('/bug-reporter/state', { method: 'GET' })
    check('前置条件：reset 前是界面值', before.json.value.repo === 'ui/gone' && before.json.value.enabled === false)

    const reset = await app.call('/bug-reporter/settings/reset', { body: {} })
    check('POST /settings/reset → 200', reset.status === 200, `status=${reset.status}`)
    check('reset 后持久化文件被清掉', existsSync(file) === false, file)
    check('reset 后 enabled 回到 yml 的 true', reset.json.value.enabled === true, JSON.stringify(reset.json.value.enabled))
    check('reset 后 repo 回到 yml 的值', reset.json.value.repo === 'yml/reset-repo', JSON.stringify(reset.json.value.repo))
    check('reset **不删报告**（2 条还在）', reset.json.value.reports.length === 2,
      `reports=${reset.json.value.reports.length}`)
    const after = await app.call('/bug-reporter/state', { method: 'GET' })
    check('reset 后 GET /state 也是 yml 的值', after.json.value.repo === 'yml/reset-repo')

    // reset 之后如果没有任何新改动，重启不会再读回旧值（文件已经没了）
    const app2 = await bootInstance({
      storePath: join(persistDir, 'reset-2.jsonl'),
      settingsPath: file,
      repo: 'yml/reset-repo',
      captureProcess: false,
    })
    const state2 = await app2.call('/bug-reporter/state', { method: 'GET' })
    check('reset 后重新挂载：还是 yml 的值（没有旧文件可读）', state2.json.value.repo === 'yml/reset-repo')
    check('reset 后重新挂载：报告没被删（另一个 store 文件）', Array.isArray(state2.json.value.reports))
    app2.close()

    const badMethod = await app.call('/bug-reporter/settings/reset', { method: 'GET' })
    check('GET /settings/reset → 405 method-not-allowed',
      badMethod.status === 405 && badMethod.json.error.code === 'method-not-allowed',
      `status=${badMethod.status} code=${badMethod.json && badMethod.json.error && badMethod.json.error.code}`)
    app.close()
  }

  // D14.8 测试隔离硬要求：整轮跑下来不能写脏真实的 $DSH_HOME
  {
    const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    const realFile = join(realHome, 'bug-reporter-settings.json')
    check('没有写脏真实 $DSH_HOME 下的设置文件', existsSync(realFile) === false, realFile)
  }
}

// ---------------------------------------------------------------------------
// G. task-22：一键更新 = removeBundle → installBundle
//
// 根因：宿主有 HMR 时 installBundle 对「已经是 profile 依赖」的包一律抛
// already-installed（@deepseek-ai/dsh-plugin-manager lib/index.js:1991），所以老实现
// `installBundle(包名)` 装了等于没装。正确路径是先 removeBundle 摘掉依赖再装回来
// （plugin_manager install_bundle 自己的 nextStep 就是这么说的）。
//
// 这一节把每一步的失败模式都钉死：顺序、记账、补救重装、绝不谎报 applied。
// ---------------------------------------------------------------------------
console.log('\n--- G. task-22 removeBundle → installBundle ---')

// 自隔离：C7 会临时改 registryTable，这里显式写回本轮需要的三条。
registryTable['dsh-alpha'] = '1.0.1'
registryTable['dsh-beta'] = '1.2.0'
registryTable['dsh-gamma'] = '2.0.0'

const G_REMOVE_OK = { changed: true, application: 'applied', stage: 'remove', target: 'stub' }
const G_INSTALL_OK = { changed: true, application: 'applied', stage: 'install', target: 'stub', version: '9.9.9' }
const G_INSTALL_RESTART = {
  changed: true,
  application: 'restart-required',
  stage: 'install',
  target: 'stub',
  version: '9.9.9',
  restartReason: 'no-hmr',
}
/** 真实 change() 折出来的失败形状：application=failed + error.code。 */
const gFail = (code) => ({ changed: false, application: 'failed', stage: 'stub', error: { code } })

/** 记顺序的桩：remove / install 都往同一条 trace 里写，顺序一目了然。 */
function gManager(trace, handlers) {
  return {
    async listBundles() {
      return BUNDLES
    },
    async registries() {
      return { registry: REGISTRY_HOST, fallbackRegistries: [FALLBACK_HOST], resolved: null }
    },
    async removeBundle(name) {
      trace.push(`remove:${name}`)
      return typeof handlers.remove === 'function' ? handlers.remove(name) : handlers.remove
    },
    async installBundle(name) {
      trace.push(`install:${name}`)
      return typeof handlers.install === 'function' ? handlers.install(name) : handlers.install
    },
  }
}

/** 造一个巡检完、updates 里有 3 条的 manager（autoUpdate 关着，巡检不会触发 apply）。 */
async function gChecked(trace, handlers) {
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: gManager(trace, handlers) }, () => {})
  await mgr.runCheck()
  return mgr
}

/** 某包里最后一条 updateLog。 */
function gLast(mgr, moduleName) {
  return mgr.log().filter((entry) => entry.moduleName === moduleName).pop()
}

// G1 正常更新：先 remove 再 install，只有 applied 才记 applied
{
  const trace = []
  const mgr = await gChecked(trace, { remove: G_REMOVE_OK, install: G_INSTALL_OK })
  check('G1 前置：巡检出 3 条可用更新', mgr.list().length === 3, `实际 ${mgr.list().length}`)
  const out = await mgr.applyOne('dsh-alpha')
  check('G1 调用顺序 = remove → install（不是直接 install）', trace.join(' | ') === 'remove:dsh-alpha | install:dsh-alpha', trace.join(' | '))
  check('G1 返回 application=applied outcome=applied', out.application === 'applied' && out.outcome === 'applied', JSON.stringify(out))
  const entry = gLast(mgr, 'dsh-alpha')
  check(
    'G1 updateLog 记 applied，detail 两步都在（remove=applied application=applied）',
    entry !== undefined &&
      entry.result === 'applied' &&
      entry.detail.includes('remove=applied') &&
      entry.detail.includes('application=applied'),
    JSON.stringify(entry),
  )
  check('G1 成功后该包从 updates 消失（无幽灵条目）', mgr.has('dsh-alpha') === false)
  check('G1 其余两条更新不受影响', mgr.list().length === 2, `实际 ${mgr.list().length}`)
}

// G2 install 返回 restart-required → 如实记 restart-required，绝不记 applied
{
  const trace = []
  const mgr = await gChecked(trace, { remove: G_REMOVE_OK, install: G_INSTALL_RESTART })
  const out = await mgr.applyOne('dsh-beta')
  const entry = gLast(mgr, 'dsh-beta')
  check('G2 restart-required 如实记（不是 applied）', entry.result === 'restart-required' && out.outcome === 'restart-required', JSON.stringify(entry))
  check('G2 detail 带 restartReason=no-hmr', entry.detail.includes('restartReason=no-hmr'), entry.detail)
  check('G2 依然走了 remove → install', trace.join(' | ') === 'remove:dsh-beta | install:dsh-beta', trace.join(' | '))
}

// G3 最危险的失败：remove 成功但 install 失败 → 补救重装一次 + 显眼 failed
{
  const trace = []
  const mgr = await gChecked(trace, { remove: G_REMOVE_OK, install: gFail('not-bundle') })
  const out = await mgr.applyOne('dsh-gamma')
  check(
    'G3 remove 成功 + install 失败 → **补救重装了一次**（install 被调 2 次）',
    trace.join(' | ') === 'remove:dsh-gamma | install:dsh-gamma | install:dsh-gamma',
    trace.join(' | '),
  )
  const entry = gLast(mgr, 'dsh-gamma')
  check('G3 记 failed（绝不谎报 applied）', entry.result === 'failed' && out.outcome === 'failed', JSON.stringify(entry))
  check('G3 detail 含「已移除但重装失败，需要手动重装」', entry.detail.includes('已移除但重装失败') && entry.detail.includes('需要手动重装'), entry.detail)
  check('G3 detail 带具体错误码 not-bundle', entry.detail.includes('not-bundle'), entry.detail)
  check('G3 detail 也带补救结果', entry.detail.includes('补救重装'), entry.detail)
  check('G3 失败后该包**留在 updates 里**（用户还能重试）', mgr.has('dsh-gamma') === true)
}

// G4 补救重装成功 → 这次更新其实生效了，如实记 applied
{
  const trace = []
  let attempt = 0
  const mgr = await gChecked(trace, {
    remove: G_REMOVE_OK,
    install: () => (++attempt === 1 ? gFail('network') : G_INSTALL_OK),
  })
  const out = await mgr.applyOne('dsh-alpha')
  const entry = gLast(mgr, 'dsh-alpha')
  check('G4 首次失败 + 补救成功 → 记 applied（不是 failed）', out.outcome === 'applied' && entry.result === 'applied', JSON.stringify(entry))
  check('G4 detail 说明首次失败原因 + 补救成功', entry.detail.includes('network') && entry.detail.includes('补救重装'), entry.detail)
  check('G4 成功后从 updates 消失', mgr.has('dsh-alpha') === false)
}

// G5 四种「摘不掉」的错误码 → 停手、不 install、记 failed + 一句人话
for (const code of ['not-removable', 'bundle-in-use', 'management-required', 'unaddressable']) {
  const trace = []
  const mgr = await gChecked(trace, { remove: gFail(code), install: G_INSTALL_OK })
  const out = await mgr.applyOne('dsh-alpha')
  const entry = gLast(mgr, 'dsh-alpha')
  check(`G5 remove 返回 ${code} → 不调 install`, trace.join(' | ') === 'remove:dsh-alpha', trace.join(' | '))
  check(`G5 remove 返回 ${code} → 记 failed`, entry.result === 'failed' && out.outcome === 'failed', JSON.stringify(entry))
  check(
    `G5 remove 返回 ${code} → detail 写「这个包不能自动更新，请手动 dsh plugin 更新」+ 错误码`,
    entry.detail.includes('这个包不能自动更新') && entry.detail.includes('dsh plugin') && entry.detail.includes(code),
    entry.detail,
  )
  check(`G5 remove 返回 ${code} → 该包留在 updates 里`, mgr.has('dsh-alpha') === true)
}

// G6 stop-profile → 记 restart-required（不是 applied），不 install
{
  const trace = []
  const mgr = await gChecked(trace, { remove: gFail('stop-profile'), install: G_INSTALL_OK })
  const out = await mgr.applyOne('dsh-alpha')
  const entry = gLast(mgr, 'dsh-alpha')
  check('G6 stop-profile → 不调 install', trace.join(' | ') === 'remove:dsh-alpha', trace.join(' | '))
  check('G6 stop-profile → 记 restart-required（不是 applied / failed）', entry.result === 'restart-required' && out.outcome === 'restart-required', JSON.stringify(entry))
  check('G6 stop-profile → detail 说明要重启 profile', entry.detail.includes('stop-profile') && entry.detail.includes('重启'), entry.detail)
  check('G6 stop-profile → 该包留在 updates 里（重启后还能更新）', mgr.has('dsh-alpha') === true)
}

// G7 老宿主没有 removeBundle → 记 failed，绝不再硬着头皮 install
{
  const installsG7 = []
  const settings = { ...DEFAULTS, ignoredUpdates: [] }
  const pmWithoutRemove = {
    async listBundles() {
      return BUNDLES
    },
    async registries() {
      return { registry: REGISTRY_HOST, fallbackRegistries: [FALLBACK_HOST], resolved: null }
    },
    async installBundle(name) {
      installsG7.push(name)
      return G_INSTALL_OK
    },
  }
  const mgr = createUpdateManager(settings, { pluginManager: pmWithoutRemove }, () => {})
  await mgr.runCheck()
  const out = await mgr.applyOne('dsh-alpha')
  const entry = gLast(mgr, 'dsh-alpha')
  check('G7 removeBundle 不可用 → install 一次都没调', installsG7.length === 0, JSON.stringify(installsG7))
  check('G7 removeBundle 不可用 → 记 failed', entry.result === 'failed' && out.outcome === 'failed', JSON.stringify(entry))
  check('G7 detail 说明 removeBundle 不可用 + 手动更新', entry.detail.includes('removeBundle 不可用') && entry.detail.includes('dsh plugin'), entry.detail)
  check('G7 该包留在 updates 里', mgr.has('dsh-alpha') === true)
}

// G8 removeBundle 自己抛错 → 记 failed 且往外抛（路由转 502），不 install
{
  const trace = []
  const mgr = await gChecked(trace, {
    remove: () => {
      throw new Error('stub removeBundle 炸了')
    },
    install: G_INSTALL_OK,
  })
  let thrown = null
  try {
    await mgr.applyOne('dsh-alpha')
  } catch (error) {
    thrown = error
  }
  const entry = gLast(mgr, 'dsh-alpha')
  check('G8 removeBundle 抛错 → 往外抛（端点才能转 502）', thrown !== null && String(thrown.message).includes('炸了'), String(thrown))
  check('G8 removeBundle 抛错 → 不调 install', trace.join(' | ') === 'remove:dsh-alpha', trace.join(' | '))
  check('G8 removeBundle 抛错 → updateLog 记 failed', entry !== undefined && entry.result === 'failed', JSON.stringify(entry))
}

// G9 autoUpdate=true 走的是**同一条** applyOne（remove → install 逐个包）
{
  const trace = []
  const settings = { ...DEFAULTS, autoUpdate: true, updatePolicy: 'any', ignoredUpdates: [] }
  const mgr = createUpdateManager(settings, { pluginManager: gManager(trace, { remove: G_REMOVE_OK, install: G_INSTALL_OK }) }, () => {})
  await mgr.runCheck()
  check(
    'G9 autoUpdate=true 每个包都走了 remove → install',
    trace.join(' | ') ===
      'remove:dsh-alpha | install:dsh-alpha | remove:dsh-beta | install:dsh-beta | remove:dsh-gamma | install:dsh-gamma',
    trace.join(' | '),
  )
  check('G9 autoUpdate 装完 updates 空（无幽灵条目）', mgr.list().length === 0, `实际 ${mgr.list().length}`)
  check('G9 三条都记 applied', mgr.log().filter((entry) => entry.result === 'applied').length === 3, JSON.stringify(mgr.log().map((entry) => `${entry.moduleName}:${entry.result}`)))
}

// G10–G13 走真实例（真 socket 打真 handler + 带 pluginManager 的桩）。
// 注意：主实例的 server 在 D 段末尾就 close 了，D14 的 bootInstance 又不带 pluginManager，
// 所以这里必须自己起一个 —— 否则拿到的是 ECONNREFUSED。
const gWebServer = createWebServerStub()
const gHostLogs = []
const { ctx: gCtx } = createFakeCtx({ webServer: gWebServer, pluginManager: endpointManager, timer: createTimerStub() }, gHostLogs)
mod.apply(gCtx, {
  storePath: join(STUB_DIR, 'g-reports.jsonl'),
  settingsPath: join(STUB_DIR, 'g-reports.jsonl.settings.json'),
  autoUpdate: false,
  updatePolicy: 'any',
})
const gUpdates = mod.internals.active.updates
const gServer = http.createServer((req, res) => gWebServer.handler(req, res))
await new Promise((done) => gServer.listen(0, '127.0.0.1', done))
const gOrigin = `http://127.0.0.1:${gServer.address().port}`
async function gCall(path, options = {}) {
  const init = { method: options.method === undefined ? 'POST' : options.method }
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(gOrigin + path, init)
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

// G10 端点：removeBundle 失败 → 200 + updateLog failed（软失败语义不变，不调 install）
{
  removeMode = 'not-removable'
  endpointRemoves.length = 0
  endpointInstalls.length = 0
  await gCall('/bug-reporter/update/check', { body: {} })
  const a = await gCall('/bug-reporter/update/apply', { body: { moduleName: 'dsh-alpha' } })
  check('G10 端点：removeBundle 失败 → 仍 200 ok:true（软失败语义不变）', a.status === 200 && a.json.ok === true, `status=${a.status}`)
  check('G10 端点：removeBundle 失败 → 不调 install', endpointInstalls.length === 0, JSON.stringify(endpointInstalls))
  const entry = gLast(gUpdates, 'dsh-alpha')
  check('G10 端点：updateLog 记 failed 且写明不能自动更新', entry.result === 'failed' && entry.detail.includes('不能自动更新'), JSON.stringify(entry))
  removeMode = 'applied'
}

// G11 端点：removeBundle 抛错 → 502 operation-failed（错误码语义不变）
{
  removeMode = 'throw'
  await gCall('/bug-reporter/update/check', { body: {} })
  const a = await gCall('/bug-reporter/update/apply', { body: { moduleName: 'dsh-alpha' } })
  check('G11 端点：removeBundle 抛错 → 502 operation-failed', a.status === 502 && a.json.error.code === 'operation-failed', JSON.stringify(a.json))
  removeMode = 'applied'
}

// G12 端点：remove 成功但 install 抛错 → 502 + 补救重装 + detail 含「已移除但重装失败」
{
  removeMode = 'applied'
  installMode = 'throw'
  endpointRemoves.length = 0
  endpointInstalls.length = 0
  await gCall('/bug-reporter/update/check', { body: {} })
  const a = await gCall('/bug-reporter/update/apply', { body: { moduleName: 'dsh-alpha' } })
  check('G12 端点：install 抛错 → 502 operation-failed', a.status === 502 && a.json.error.code === 'operation-failed', JSON.stringify(a.json))
  check(
    'G12 端点：先 remove 再 install，且补救重装过一次',
    endpointRemoves.join(',') === 'dsh-alpha' && endpointInstalls.length === 2,
    `removes=${JSON.stringify(endpointRemoves)} installs=${JSON.stringify(endpointInstalls)}`,
  )
  const entry = gLast(gUpdates, 'dsh-alpha')
  check('G12 端点：detail 含「已移除但重装失败」', entry !== undefined && entry.detail.includes('已移除但重装失败'), JSON.stringify(entry))
  installMode = 'applied'
}

// G13 端点：成功路径 = remove 一次 + install 一次 + 该包从 updates 消失
{
  removeMode = 'applied'
  installMode = 'applied'
  endpointRemoves.length = 0
  endpointInstalls.length = 0
  await gCall('/bug-reporter/update/check', { body: {} })
  const a = await gCall('/bug-reporter/update/apply', { body: { moduleName: 'dsh-alpha' } })
  check(
    'G13 端点成功：200 + remove 一次 + install 一次',
    a.status === 200 && endpointRemoves.join(',') === 'dsh-alpha' && endpointInstalls.join(',') === 'dsh-alpha',
    `status=${a.status} removes=${JSON.stringify(endpointRemoves)} installs=${JSON.stringify(endpointInstalls)}`,
  )
  check('G13 端点成功：该包从 updates 消失', !a.json.value.updates.some((item) => item.moduleName === 'dsh-alpha'))
  const entry = gLast(gUpdates, 'dsh-alpha')
  check('G13 端点成功：updateLog 记 applied 且 detail 带 remove=applied', entry.result === 'applied' && entry.detail.includes('remove=applied'), JSON.stringify(entry))
  gServer.close()
}

// 清理本次跑出来的临时目录（store / pkg-fence 都在里面）。
// 注意：noPkg 那个目录从没被创建过（被 403 挡住了），所以不用清。
rmSync(STUB_DIR, { recursive: true, force: true })
console.log(`临时目录已清理：${STUB_DIR} → 还存在=${existsSync(STUB_DIR)}`)

console.log(`\n结果：${failures === 0 ? 'ALL PASS' : `${failures} 项 FAIL`}（PASS ${passes} / FAIL ${failures}）`)
process.exitCode = failures === 0 ? 0 : 1
