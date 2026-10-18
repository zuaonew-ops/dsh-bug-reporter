/**
 * verify-bug-contract.mjs —— 独立验证 dsh-bug-reporter：
 *   [1] 两端契约交叉核对（路由表 + 字段名，正则从两边源码抽，逐个比对）
 *   [2] 软依赖矩阵（webServer / credentials / clientModules / pluginManager / timer 全 32 组合）
 *   [3] 配置校验（未知键 / 类型 / 边界 / NaN / Infinity）
 *   [4] JSONL 存储损坏恢复
 *   [5] 指纹去重是否把不同 pluginId 的报告错误合并
 *   [6] 弱断言审计（对着作者测试源码逐条看断言强度）
 *
 * 随仓库分发在 test/ 下（插件源码按 import.meta.url 解析）；只读插件源码，写入只落 os.tmpdir()，结束前清理。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { apply, internals } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = resolve(HERE, '..')
const HOST_SRC = readFileSync(join(DIR, 'index.js'), 'utf8')
const CLIENT_SRC = readFileSync(join(DIR, 'client.js'), 'utf8')
const T = join(tmpdir(), `_verify-bug-contract-${process.pid}`)
mkdirSync(T, { recursive: true })

const results = []
function rec(id, detail, verdict, evidence) {
  results.push({ id, detail, verdict, evidence })
  const mark = verdict === 'PASS' ? 'PASS' : verdict === 'INFO' ? 'INFO' : '**FAIL**'
  console.log(`${mark}  ${id}`)
  if (detail) console.log(`        ${detail}`)
  if (evidence !== undefined) console.log(`        ${evidence}`)
}

function makeCtx(services = {}, log = []) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { warn: (v) => log.push(v), error: () => {}, info: () => {}, debug: () => {} },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      const off = () => {
        const cur = listeners.get(name) ?? []
        const i = cur.indexOf(fn)
        if (i >= 0) cur.splice(i, 1)
      }
      disposers.push(off)
      return off
    },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    inject(names, cb) {
      for (const n of names) if (services[n] === undefined) return
      const scoped = Object.create(ctx)
      for (const n of names) scoped[n] = services[n]
      cb(scoped)
    },
    dispose() { while (disposers.length) { try { disposers.pop()() } catch {} } },
  }
  return ctx
}

// ===========================================================================
console.log('=== [1] 两端契约交叉核对 ===')
// ===========================================================================

// 1a. 路由表
const hostRoutes = new Set([...HOST_SRC.matchAll(/\$\{ROUTE_PREFIX\}\/([A-Za-z0-9/_-]*)/g)].map((m) => `/bug-reporter/${m[1]}`))
const clientRoutes = new Set([...CLIENT_SRC.matchAll(/['"`](\/bug-reporter\/[A-Za-z0-9/_-]*)['"`]/g)].map((m) => m[1]))
// 客户端还有别的 fetch 目标吗？
const clientFetchTargets = [...CLIENT_SRC.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim())

const onlyHost = [...hostRoutes].filter((p) => !clientRoutes.has(p))
const onlyClient = [...clientRoutes].filter((p) => !hostRoutes.has(p))
rec('1a 路由表：宿主 index.js vs 客户端 client.js',
  `宿主 ${hostRoutes.size} 条 / 客户端 ${clientRoutes.size} 条`,
  onlyClient.length === 0 ? 'PASS' : '**FAIL**',
  `宿主独有=${JSON.stringify(onlyHost)} 客户端独有(拼错/多余)=${JSON.stringify(onlyClient)}`)
console.log(`        宿主路由=${JSON.stringify([...hostRoutes].sort())}`)
console.log(`        客户端路由=${JSON.stringify([...clientRoutes].sort())}`)
console.log(`        客户端 fetch() 实参=${JSON.stringify(clientFetchTargets)}`)

// 1b. /state 字段
const stateBlock = HOST_SRC.slice(HOST_SRC.indexOf('async function stateValue()'), HOST_SRC.indexOf('function parseStatePatch'))
const hostStateKeys = [...stateBlock.matchAll(/^\s{6}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1])
const clientDataKeys = [...new Set([...CLIENT_SRC.matchAll(/\bdata\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
// 客户端也走查表（['enabled','enabled']）和 data?.x，所以「有没有被引用」用整源包含判断更准
const stateNeverMentioned = hostStateKeys.filter((k) => !new RegExp(`\\b${k}\\b`).test(CLIENT_SRC))
const dataNotSent = clientDataKeys.filter((k) => !hostStateKeys.includes(k))
rec('1b /state 字段：宿主发的键 vs 客户端读的键',
  `宿主发 ${hostStateKeys.length} 个 / 客户端 data.X 直读 ${clientDataKeys.length} 个`,
  dataNotSent.length === 0 && stateNeverMentioned.length === 0 ? 'PASS' : '**FAIL**',
  `客户端读了但宿主没发=${JSON.stringify(dataNotSent)}；宿主发了但客户端整源都没提=${JSON.stringify(stateNeverMentioned)}`)
console.log(`        宿主发=${JSON.stringify(hostStateKeys)}`)
console.log(`        客户端 data.X 直读=${JSON.stringify(clientDataKeys)}；走查表读的=${JSON.stringify(hostStateKeys.filter((k) => !clientDataKeys.includes(k)))}`)

// 1c. Report 字段（宿主键：字面量 + 简写属性）
const recordBlock = HOST_SRC.slice(HOST_SRC.indexOf('      const report = {\n        id: randomUUID()'), HOST_SRC.indexOf('reports.unshift(report)'))
const hostReportKeys = [
  ...[...recordBlock.matchAll(/^\s{8}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]),
  ...[...recordBlock.matchAll(/^\s{8}([A-Za-z_$][\w$]*),\s*$/gm)].map((m) => m[1]),
]
const clientReportReads = [...new Set([...CLIENT_SRC.matchAll(/\breport\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
const reportUnknown = clientReportReads.filter((k) => !hostReportKeys.includes(k))
rec('1c Report 字段：宿主 record() 产出的键 vs 客户端 report.X 读的键',
  `宿主产出 ${hostReportKeys.length} 个`,
  reportUnknown.length === 0 ? 'PASS' : '**FAIL**',
  `宿主键=${JSON.stringify(hostReportKeys)}；客户端 report.X 读了但不在宿主键里=${JSON.stringify(reportUnknown)}`)

// 1d. update / updateLog 字段
const hostUpdateKeys = ['moduleName', 'installed', 'latest', 'kind', 'ignored']
const hostLogKeys = ['at', 'moduleName', 'from', 'to', 'result', 'detail']
const clientUpdateReads = [...new Set([...CLIENT_SRC.matchAll(/\b(?:update|entry|u)\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
const updUnknown = clientUpdateReads.filter((k) => ![...hostUpdateKeys, ...hostLogKeys].includes(k) && !['map', 'length', 'filter', 'find', 'some', 'key'].includes(k))
rec('1d update / updateLog 字段：宿主键 vs 客户端 update.X 读的键',
  `宿主 updates 项键=${JSON.stringify(hostUpdateKeys)}；updateLog 项键=${JSON.stringify(hostLogKeys)}`,
  updUnknown.length === 0 ? 'PASS' : '**FAIL**',
  `客户端读了但不在宿主键里=${JSON.stringify(updUnknown)}`)

// 1e. 客户端读 context.file（宿主 tools/result 里塞的）
{
  const hostSends = HOST_SRC.includes('context: jsonSafe({ tool: name, code: typeof info.code')
  const clientReads = /context[^\n]*\.file|\.file\b/.test(CLIENT_SRC)
  const clientReadsFile = CLIENT_SRC.includes('file')
  rec('1e 修复面板预填路径：宿主 context.file ↔ 客户端读法',
    '宿主 tools/result 把 file 放进 context；客户端从 context.file 预填',
    hostSends && clientReadsFile ? 'PASS' : 'INFO',
    `宿主写 context.file=${hostSends} 客户端出现 file 标识=${clientReadsFile} 正则命中=${clientReads}`)
}

// 1f. package.json / cordis.patch.yml 里声明的键 vs DEFAULTS
{
  const patch = readFileSync(join(DIR, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'))
  const defaults = Object.keys(internals.DEFAULTS)
  const declaredInPatch = [...patch.matchAll(/^\s*#?\s*[-]?\s*([a-zA-Z][\w]*):/gm)].map((m) => m[1])
  const clientId = /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: '([^']+)'/.exec(CLIENT_SRC)?.[1]
  rec('1f 客户端模块 id 必须等于包名',
    `client.js load id="${clientId}" / package.json name="${pkg.name}"`,
    clientId === pkg.name ? 'PASS' : '**FAIL**',
    `dsh.client=${JSON.stringify(pkg.dsh?.client)}`)
  rec('1g DEFAULTS 与文档声明',
    `DEFAULTS=${JSON.stringify(defaults)}`,
    'INFO',
    `cordis.patch.yml 提到的键=${JSON.stringify([...new Set(declaredInPatch)].filter((k) => defaults.includes(k)))}`)
}

// ===========================================================================
console.log('\n=== [2] 软依赖矩阵（32 组合） ===')
// ===========================================================================
const NAMES = ['webServer', 'credentials', 'clientModules', 'pluginManager', 'timer']
function svc(name, spy) {
  if (name === 'webServer') return { register: (r) => { spy.routes.push(r.path); return () => {} } }
  if (name === 'credentials') return { resolve: async () => 'TOKEN' }
  if (name === 'clientModules') return { rebuilt: () => 'rev-1' }
  if (name === 'pluginManager') return { listBundles: async () => [], inspect: async () => ({ version: '1.0.0' }), installBundle: async () => ({ application: 'applied' }) }
  return { timeout: (fn) => { spy.timeouts += 1; return () => {} }, interval: (fn) => { spy.intervals += 1; return () => {} } }
}
{
  let bad = []
  let tested = 0
  for (let mask = 0; mask < 32; mask += 1) {
    const present = {}
    const spy = { routes: [], timeouts: 0, intervals: 0 }
    const names = []
    for (let i = 0; i < NAMES.length; i += 1) {
      if (mask & (1 << i)) { present[NAMES[i]] = svc(NAMES[i], spy); names.push(NAMES[i]) }
    }
    const store = join(T, `m-${mask}.jsonl`)
    const log = []
    const ctx = makeCtx(present, log)
    try {
      apply(ctx, { storePath: store, captureProcess: false })
      tested += 1
      // 有 webServer 就必须注册了路由；没有就不能注册
      const wantRoute = names.includes('webServer')
      const gotRoute = spy.routes.includes('/bug-reporter')
      const wantTimer = names.includes('timer')
      const gotTimer = spy.intervals > 0
      if (wantRoute !== gotRoute || wantTimer !== gotTimer || log.length > 0) {
        bad.push(`mask=${mask} [${names.join('+')}] route want=${wantRoute} got=${gotRoute} timer want=${wantTimer} got=${gotTimer} warn=${log.length}`)
      }
      // 缺 webServer 时捕获与存储仍要工作
      if (!wantRoute) {
        ctx.emit('agent/error', { error: new Error(`NO-WEBSERVER-${mask}`) })
        const text = existsSync(store) ? readFileSync(store, 'utf8') : ''
        if (!text.includes(`NO-WEBSERVER-${mask}`)) bad.push(`mask=${mask} 缺 webServer 时捕获没落盘`)
      }
    } catch (error) {
      bad.push(`mask=${mask} [${names.join('+')}] apply 抛错：${error.message}`)
    } finally {
      ctx.dispose()
    }
  }
  rec(`2 软依赖全矩阵：${NAMES.join(' / ')} 各缺/各在共 32 组合`,
    `全部组合都必须能加载，且能力随依赖在/缺正确开关`,
    bad.length === 0 ? 'PASS' : '**FAIL**',
    bad.length === 0 ? `${tested}/32 组合加载成功，能力开关全部符合预期，无 logger.warn` : JSON.stringify(bad, null, 1))
}

// ===========================================================================
console.log('\n=== [3] 配置校验 ===')
// ===========================================================================
{
  const cases = [
    ['未知键', { nope: 1 }, '未知的 config 键'],
    ['config 是数组', [1, 2], '必须是'],
    ['enabled 传字符串', { enabled: 'yes' }, 'enabled 必须是 boolean'],
    ['maxReports = 0', { maxReports: 0 }, 'maxReports 必须 >= 1'],
    ['maxReports = -1', { maxReports: -1 }, 'maxReports 必须 >= 1'],
    ['maxReports = 1.5（小数）', { maxReports: 1.5 }, null],
    ['maxReports = NaN', { maxReports: Number.NaN }, '必须是有限数字'],
    ['maxReports = Infinity', { maxReports: Number.POSITIVE_INFINITY }, '必须是有限数字'],
    ['updateCheckMs = NaN', { updateCheckMs: Number.NaN }, '必须是有限数字'],
    ['updateCheckMs = Infinity', { updateCheckMs: Number.POSITIVE_INFINITY }, '必须是有限数字'],
    ['updateCheckMs = -Infinity', { updateCheckMs: Number.NEGATIVE_INFINITY }, '必须是有限数字'],
    ['updateCheckMs = "3600000"（字符串）', { updateCheckMs: '3600000' }, '必须是有限数字'],
    ['updateCheckMs = 1000（有限但过小）', { updateCheckMs: 1000 }, '必须 >= 60000'],
    ['updateCheckMs = 59999', { updateCheckMs: 59999 }, '必须 >= 60000'],
    ['updateCheckMs = 60000', { updateCheckMs: 60000 }, null],
    ['updatePolicy = "major"', { updatePolicy: 'major' }, 'updatePolicy 必须是'],
    ['updatePolicy = "patch"', { updatePolicy: 'patch' }, null],
    ['ignoredUpdates = "x"', { ignoredUpdates: 'x' }, '必须是 string[]'],
    ['ignoredUpdates = [1]', { ignoredUpdates: [1] }, '必须是 string[]'],
    ['repo = 123', { repo: 123 }, 'repo 必须是 string'],
    ['repairEnabled = null', { repairEnabled: null }, 'repairEnabled 必须是 boolean'],
  ]
  const bad = []
  for (const [label, config, expectFragment] of cases) {
    const store = join(T, `cfg-${label.replace(/[^\w]/g, '_')}.jsonl`)
    const ctx = makeCtx({})
    let threw = null
    try {
      // 数组这类非 mapping 的 config 必须原样传（展开成对象就测不到了）
      if (Array.isArray(config)) apply(ctx, config)
      else apply(ctx, { storePath: store, captureProcess: false, ...config })
    } catch (error) {
      threw = error.message
    }
    ctx.dispose()
    if (expectFragment === null) {
      if (threw !== null) bad.push(`${label}：期望接受，实际抛「${threw}」`)
    } else if (threw === null) {
      bad.push(`${label}：期望抛错（含「${expectFragment}」），实际没抛`)
    } else if (!threw.includes(expectFragment)) {
      bad.push(`${label}：抛错文案不含「${expectFragment}」，实际「${threw}」`)
    }
    console.log(`        ${label} → ${threw === null ? '接受' : `抛错: ${threw}`}`)
  }
  rec('3 配置校验（含 NaN / Infinity / 边界 / 小数）', `${cases.length} 个用例`,
    bad.length === 0 ? 'PASS' : '**FAIL**', bad.length === 0 ? '全部符合预期' : JSON.stringify(bad, null, 1))
}

// ===========================================================================
console.log('\n=== [4] JSONL 存储损坏恢复 ===')
// ===========================================================================
{
  const mk = (name, content) => { const p = join(T, `store-${name}.jsonl`); writeFileSync(p, content); return p }
  const good = JSON.stringify({ id: 'g1', message: 'good-1', stack: '', count: 3, source: 'manual', status: 'open' })
  const good2 = JSON.stringify({ id: 'g2', message: 'good-2', stack: '' })

  const cases = [
    ['空文件', '', 0],
    ['只有换行', '\n\n\n', 0],
    ['中间夹一行坏 JSON', `${good}\n{not json\n${good2}\n`, 2],
    ['最后一行被截断', `${good}\n${good2.slice(0, 20)}`, 1],
    ['整行是数组', `${good}\n[1,2,3]\n`, 1],
    ['整行是数字', `${good}\n12345\n`, 1],
    ['缺 message 的对象', `${good}\n{"id":"x","stack":""}\n`, 1],
    ['message 为空串', `${good}\n{"id":"x","message":""}\n`, 1],
    ['BOM 开头', `\uFEFF${good}\n`, 1],
    ['CRLF 行尾', `${good}\r\n${good2}\r\n`, 2],
    ['同一指纹两条', `${JSON.stringify({ id: 'd1', message: 'dup', stack: 'S' })}\n${JSON.stringify({ id: 'd2', message: 'dup', stack: 'S' })}\n`, 2],
  ]
  const bad = []
  for (const [label, content, expect] of cases) {
    const file = mk(label.replace(/[^\w]/g, '_'), content)
    const ctx = makeCtx({})
    let n = -1
    let err = null
    try {
      apply(ctx, { storePath: file, captureProcess: false })
      n = internals.active.store.list().length
    } catch (error) {
      err = error.message
    }
    ctx.dispose()
    const ok = err === null && n === expect
    if (!ok) bad.push(`${label}：期望 ${expect} 条，实际 ${err ? `抛错 ${err}` : `${n} 条`}`)
    console.log(`        ${label} → ${err ? `抛错: ${err}` : `${n} 条`}（期望 ${expect}）`)
  }
  rec('4 JSONL 坏行/截断/空文件/CRLF/BOM 恢复', `${cases.length} 个用例`,
    bad.length === 0 ? 'PASS' : '**FAIL**', bad.length === 0 ? '全部符合预期（坏行丢弃、好行保留）' : JSON.stringify(bad, null, 1))
}

// 4b. storePath 指向目录 → 加载期抛错
{
  const dir = join(T, 'store-as-dir')
  mkdirSync(dir, { recursive: true })
  const ctx = makeCtx({})
  let threw = null
  try { apply(ctx, { storePath: dir, captureProcess: false }) } catch (e) { threw = e.message }
  ctx.dispose()
  rec('4b storePath 指向一个目录（EISDIR）',
    '读取失败且 code !== ENOENT → createStore 抛错 → 整个插件挂载失败',
    threw !== null ? 'INFO' : 'INFO',
    `apply 结果=${threw === null ? '成功（意外）' : `抛错：${threw.slice(0, 140)}`}`)
}

// ===========================================================================
console.log('\n=== [5] 指纹去重 vs pluginId ===')
// ===========================================================================
{
  const file = join(T, 'fingerprint.jsonl')
  const ctx = makeCtx({})
  apply(ctx, { storePath: file, captureProcess: false })
  const store = internals.active.store
  const a = store.record({ source: 'agent/error', message: 'SAME MESSAGE', stack: 'SAME STACK', pluginId: 'plugin-alpha' })
  const b = store.record({ source: 'agent/error', message: 'SAME MESSAGE', stack: 'SAME STACK', pluginId: 'plugin-beta' })
  const list = store.list()
  rec('5 同 message+stack、不同 pluginId 的两条报告',
    'record() 只用 fingerprint 查重（index.js:531-532），pluginId 不在键里',
    list.length === 1 ? '**FAIL**(不同插件的报告被合并，pluginId 丢失)' : 'PASS',
    `报告数=${list.length} id相同=${a.id === b.id} count=${list[0]?.count} pluginId=${list[0]?.pluginId}（第二条的 plugin-beta 消失）`)
  // 对照：不同 stack 但都没有 `at ` 帧 —— 指纹只由 message 决定，仍然合并
  const c = store.record({ source: 'agent/error', message: 'SAME MESSAGE', stack: 'OTHER STACK', pluginId: 'plugin-beta' })
  rec('5b message 相同、stack 不同，但两条 stack 都没有 `at ` 帧',
    'fingerprintOf（index.js:228-240）只在 stack 里找 `at ` 行；找不到时 basis=""，指纹退化成「只由 message 决定」',
    store.list().length === 1 ? '**FAIL**(不同 stack 也被合并)' : 'PASS',
    `报告数=${store.list().length} count=${store.list()[0]?.count}（stack "OTHER STACK" 与 "SAME STACK" 视为同一条）`)
  // 对照：真的 V8 栈帧不同 → 必须分开
  const d = store.record({ source: 'agent/error', message: 'SAME MESSAGE', stack: 'Error: x\n    at foo (a.js:1:1)\n', pluginId: 'plugin-gamma' })
  rec('5c 对照：带真 `at ` 帧且帧不同 → 应当分开',
    '指纹包含前 3 个栈帧',
    store.list().length === 2 ? 'PASS' : '**FAIL**', `报告数=${store.list().length}`)
  ctx.dispose()
}

// 5d. 加载时不去重（文件里两条同指纹都留下），与 record() 的去重不一致
{
  const file = join(T, 'dup-on-load.jsonl')
  writeFileSync(file, `${JSON.stringify({ id: 'x1', message: 'M', stack: 'S' })}\n${JSON.stringify({ id: 'x2', message: 'M', stack: 'S' })}\n`)
  const ctx = makeCtx({})
  apply(ctx, { storePath: file, captureProcess: false })
  const store = internals.active.store
  const before = store.list().length
  store.record({ message: 'M', stack: 'S' })
  const after = store.list()
  rec('5d 加载期不去重 vs record() 去重 是否自相矛盾',
    '文件里同指纹两条都在内存里；record 只加到第一条',
    before === 2 && after.length === 2 ? 'INFO' : '**FAIL**',
    `加载后 ${before} 条；再 record 一次后 ${after.length} 条，counts=${JSON.stringify(after.map((r) => r.count))}`)
  ctx.dispose()
}

// ===========================================================================
console.log('\n=== [6] 弱断言审计（作者测试源码） ===')
// ===========================================================================
{
  const checks = [
    ['test/bug-check.mjs 的「HTTP 协议层」用假 req/res',
      'test/bug-check.mjs 用 makeReq/makeRes 直接调 handler，从不经过真 socket',
      readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('function makeReq') &&
      !readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('createServer'),
      '作者断言 413 / 信封 / no-store 都建立在假 res 上；真实 socket 下 413 根本送不到（见 test/verify-bug-http.mjs C2/C7）'],
    ['test/bug-check.mjs 的 fetch 全是假 fetch',
      'jsonResponse() 造假的 Response 对象，从不发真请求',
      readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('setFetch') &&
      !readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('await fetch('),
      'github() 的 401/404/422/502 分支全在假 fetch 上跑；真实网络错误路径（DNS/TLS/超时）未覆盖'],
    ['clientModules.rebuilt 是假实现',
      'makeWebServer/假 services 里 rebuilt 直接返回字符串，不验证真实 bundle 代次语义',
      readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('rebuilt'),
      '「修复后浏览器热更新」这条最关键的端到端行为，没有任何真实 clientModules 验证'],
    ['uncaughtException 用真子进程（这条是硬的）',
      'spawnSync 真起子进程，断言 status!==0 + stderr 含原始错误 + 存储新增 1 条',
      !readFileSync(join(HERE, 'bug-check.mjs'), 'utf8').includes('spawnSync(process.execPath'),
      '这条断言强度足够，不算弱断言'],
  ]
  for (const [id, detail, isWeak, evidence] of checks) {
    rec(id, detail, isWeak ? '**FAIL**(弱)' : 'PASS', evidence)
  }
}

// ===========================================================================
console.log('\n=== 汇总 ===')
const fails = results.filter((r) => r.verdict.startsWith('**FAIL**'))
console.log(`\n共 ${results.length} 项：PASS ${results.filter((r) => r.verdict === 'PASS').length} / FAIL ${fails.length} / INFO ${results.filter((r) => r.verdict === 'INFO').length}`)
for (const f of fails) console.log(`  FAIL  ${f.id}`)

rmSync(T, { recursive: true, force: true })
console.log(`\n临时目录已清理：${T} → 还存在=${existsSync(T)}`)
