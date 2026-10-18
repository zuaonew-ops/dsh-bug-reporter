#!/usr/bin/env node
/**
 * dsh-bug-reporter 宿主半区（index.js）的桩测。
 *
 * 随仓库分发在 test/ 下（插件源码按 import.meta.url 解析）；所有外部副作用都是假的：
 * - 假 ctx（on / effect / inject 三个能力，服务全缺也不报错）
 * - 假 req / res（Node 的 IncomingMessage / ServerResponse 最小子集）
 * - 假 webServer / credentials / clientModules
 * - 假 fetch（**绝不真的建 PR**）与假 `gh auth token`
 * - 临时目录里的 storePath
 *
 * 用法：在仓库根跑 `node test/bug-check.mjs`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, internals } from '../index.js'

const SELF = fileURLToPath(import.meta.url)

/** Report 的字段名与顺序（契约冻结，客户端半区按它渲染）。 */
const REPORT_KEYS = [
  'id',
  'fingerprint',
  'firstAt',
  'lastAt',
  'count',
  'source',
  'level',
  'message',
  'stack',
  'pluginId',
  'sessionId',
  'context',
  'status',
  'fix',
  'pr',
]

/** `/state` 的字段名与顺序。 */
const STATE_KEYS = [
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

// task-12（「实时更新新版本」）按契约往状态里**追加**的三个键。
// 它们必须排在 STATE_KEYS 之后：原 10 个键的名字与顺序一个字都不能动。
// 注意这是**精确的 13 键全序断言**，不是放松成前缀检查。
const STATE_KEYS_APPENDED = ['updates', 'lastUpdateCheckAt', 'updateLog']
const STATE_KEYS_ALL = [...STATE_KEYS, ...STATE_KEYS_APPENDED]

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`)
}

// ---------------------------------------------------------------------------
// 假 ctx / req / res / webServer
// ---------------------------------------------------------------------------

/**
 * cordis Context 的最小假实现：on / effect / inject。
 * inject 的软依赖语义照实现来 —— 任何一个名字缺失，回调就不跑，且不抛错。
 */
function makeCtx({ services = {} } = {}) {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const ctx = {
    logger: {
      warn: (value) => warnings.push(value),
      error: () => {},
      info: () => {},
      debug: () => {},
    },
    warnings,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      const off = () => {
        const current = listeners.get(name) ?? []
        const index = current.indexOf(fn)
        if (index >= 0) current.splice(index, 1)
      }
      disposers.push(off)
      return off
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(names, callback) {
      for (const name of names) {
        if (services[name] === undefined) return // 软依赖缺失：不跑回调
      }
      const scoped = Object.create(ctx)
      for (const name of names) scoped[name] = services[name]
      callback(scoped)
    },
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    },
  }
  return ctx
}

/** 最小假 IncomingMessage：注册 data/end 之后在微任务里吐出整段 body。 */
function makeReq(method, url, body) {
  const listeners = new Map()
  let flushed = false
  const emit = (name, arg) => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(arg)
  }
  const flush = () => {
    if (flushed) return
    flushed = true
    queueMicrotask(() => {
      if (body !== undefined) emit('data', Buffer.from(body, 'utf8'))
      emit('end')
    })
  }
  return {
    method,
    url,
    // 真请求一定带 content-type：client.js 的 POST 就是 `application/json`。
    // task-15 的 S1 加了「POST 必须 application/json，否则 415」这道闸，假 req 也得照着带，
    // 否则这个文件里所有 POST 用例都会被自己的 415 打死。
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    destroyed: false,
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      if (name === 'data' || name === 'end') flush()
      return this
    },
    destroy() {
      this.destroyed = true
    },
  }
}

/** 最小假 ServerResponse。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      return this
    },
  }
}

/** 假 webServer：只实现 register，并留下路由表。 */
function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** 假 fetch 响应。 */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/** 发一次请求；body 是对象则 JSON 序列化，是字符串则原样当请求体。 */
async function invoke(route, method, path, body) {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const req = makeReq(method, path, raw)
  const res = makeRes()
  await route.handler(req, res)
  let json
  try {
    json = res.body === '' ? undefined : JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

/** 已 boot 但还没 dispose 的假 ctx，每条 check 结束后统一收尾。 */
const liveBoots = []

/**
 * task-15 起 /repair 的允许根来自 `config.repairRoots`（或报告自己的 pluginId 对应包）。
 * runSuite 建好临时根目录后写进这里，boot 用它当默认值。
 */
let REPAIR_ROOT = null

/**
 * 起一个插件实例。返回的 call 直接打 HTTP 契约。
 * 实例会被登记下来，每条 check 跑完统一 dispose（避免 process 监听器累积）。
 */
function boot(config, options = {}) {
  const webServer = options.webServer ?? makeWebServer()
  const services = { ...(options.services ?? {}) }
  if (options.webServer !== null) services.webServer = webServer
  const ctx = makeCtx({ services })
  // task-15 的 /repair 围栏只认「报告所属插件的包」或 config.repairRoots。
  // 这个套件里的报告都是 `POST /report {message}` 造的（没有 pluginId），
  // 所以统一用 repairRoots 把临时根目录显式放行 —— 等价于「运维自己指定可改的根」。
  // task-19：设置现在是**持久化**的，每个用例必须有自己的 settingsPath，
  // 否则同一轮里前面的用例写下的 enabled/repairEnabled/repo 会污染后面的用例。
  // 默认按 storePath 派生一份，用例显式传 settingsPath 时以它为准。
  const derived = {}
  if (typeof config.storePath === 'string' && config.storePath !== '') {
    derived.settingsPath = `${config.storePath}.settings.json`
  }
  if (REPAIR_ROOT !== null) derived.repairRoots = [REPAIR_ROOT]
  apply(ctx, { ...derived, ...config })
  liveBoots.push(ctx)
  const route = webServer.routes.find((item) => item.path === '/bug-reporter')
  return {
    ctx,
    webServer,
    services,
    route,
    call: (method, path, body) => {
      if (route === undefined) throw new Error('插件没有注册 /bug-reporter 路由')
      return invoke(route, method, path, body)
    },
  }
}

// ---------------------------------------------------------------------------
// 子进程场景：process 级捕获必须「只记录，绝不吞掉」
// ---------------------------------------------------------------------------

if (process.env.BUG_CHECK_CHILD) {
  const mode = process.env.BUG_CHECK_CHILD
  const file = process.env.BUG_CHECK_STORE
  // 故意不给任何服务：证明 process 级捕获不依赖软依赖。
  const ctx = makeCtx({ services: {} })
  // task-19：设置是持久化的，必须给这个子进程一份**自己的**设置文件，
  // 否则它会读到同一轮里别的用例写下的 enabled:false 之类，捕获就静默不记了。
  apply(ctx, { storePath: file, settingsPath: `${file}.settings.json`, captureProcess: true })
  process.stdout.write(`child-armed:${mode}\n`)
  setTimeout(() => {
    if (mode === 'uncaught') throw new Error('BUG-CHECK-UNCAUGHT')
    Promise.reject(new Error('BUG-CHECK-REJECTION'))
  }, 10)
} else {
  await runSuite()
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

async function runSuite() {
  const ROOT = mkdtempSync(join(tmpdir(), 'bug-check-'))
  REPAIR_ROOT = ROOT
  let seq = 0
  const storeFile = (tag) => {
    seq += 1
    return join(ROOT, `${tag}-${seq}.jsonl`)
  }

  const results = []
  const section = (title) => process.stdout.write(`\n${title}\n`)

  async function check(name, fn) {
    try {
      await fn()
      results.push({ name, ok: true })
      process.stdout.write(`  \u2713 ${name}\n`)
    } catch (error) {
      results.push({ name, ok: false, error })
      process.stdout.write(`  \u2717 ${name}\n      ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      // 每条 check 收尾：把这一条里 boot 出来的实例全 dispose，
      // 免得 process 监听器一直累积（真实宿主里一行只 apply 一次）。
      while (liveBoots.length > 0) {
        const ctx = liveBoots.pop()
        try {
          ctx.dispose()
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  const readReports = (file) => {
    const text = readFileSync(file, 'utf8')
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line))
  }

  process.stdout.write(`dsh-bug-reporter 宿主半区桩测\n临时目录：${ROOT}\n`)

  // -------------------------------------------------------------------------
  section('[1] 配置校验')

  await check('未知 config 键抛错并点名', () => {
    let threw = null
    try {
      apply(makeCtx({ services: {} }), { nope: 1 })
    } catch (error) {
      threw = error
    }
    assert(threw !== null, '未知键必须抛错')
    assert(threw.message.includes('nope'), `错误信息必须点名未知键，实际：${threw.message}`)
    assert(threw.message.includes('dsh-bug-reporter'), '错误信息必须带插件名')
  })

  await check('非法类型抛错（enabled/maxReports/repo/updateCheckMs）', () => {
    for (const bad of [{ enabled: 'yes' }, { updateCheckMs: 'x' }, { maxReports: 0 }, { repo: 5 }, { captureTools: 1 }]) {
      let threw = null
      try {
        apply(makeCtx({ services: {} }), bad)
      } catch (error) {
        threw = error
      }
      assert(threw !== null, `非法配置必须抛错：${JSON.stringify(bad)}`)
    }
  })

  await check('config 为 null/undefined 时用默认值', () => {
    assertDeepEqual(internals.resolveConfig(undefined), internals.DEFAULTS, '默认值')
    assertDeepEqual(internals.resolveConfig(null), internals.DEFAULTS, '默认值')
    // task-17：order 已从 DEFAULTS 删掉（它从来没有被任何代码读取过）。
    // task-19：新增 settingsPath，合法 config 键 14 → 15 个。
    assertEqual(Object.keys(internals.DEFAULTS).length, 15, '合法 config 键个数')
    assertEqual(internals.DEFAULTS.order, undefined, 'order 已删除')
    assertEqual(internals.DEFAULTS.tokenRef, 'GITHUB_TOKEN', 'tokenRef 默认值')
    assertEqual(internals.DEFAULTS.maxReports, 500, 'maxReports 默认值')
  })

  await check('config 非法结构（数组/标量）抛错', () => {
    for (const bad of [[], 3, 'x']) {
      let threw = null
      try {
        internals.resolveConfig(bad)
      } catch (error) {
        threw = error
      }
      assert(threw !== null, `非法结构必须抛错：${JSON.stringify(bad)}`)
    }
  })

  // -------------------------------------------------------------------------
  section('[2] 软依赖全缺失')

  await check('webServer/credentials/clientModules 全缺 → 不抛错', () => {
    const file = storeFile('soft')
    const ctx = makeCtx({ services: {} })
    let threw = null
    try {
      apply(ctx, { storePath: file })
    } catch (error) {
      threw = error
    }
    assert(threw === null, `软依赖全缺时不能抛错：${threw && threw.message}`)
    assertEqual(ctx.warnings.length, 0, '不应产生告警')
  })

  await check('软依赖全缺时事件捕获照常工作，Report 形状正确', () => {
    const file = storeFile('soft-capture')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file })
    ctx.emit('agent/error', { agent: { id: 'sess-1' }, turn: 3, step: 4, error: new Error('软依赖缺失也能抓') })
    const reports = readReports(file)
    assertEqual(reports.length, 1, '报告条数')
    const report = reports[0]
    assertDeepEqual(Object.keys(report), REPORT_KEYS, 'Report 字段名与顺序')
    assertEqual(report.source, 'agent/error', 'source')
    assertEqual(report.level, 'error', 'level')
    assertEqual(report.message, '软依赖缺失也能抓', 'message')
    assertEqual(report.sessionId, 'sess-1', 'sessionId')
    assertDeepEqual(report.context, { turn: 3, step: 4 }, 'context')
    assertEqual(report.status, 'open', 'status')
    assertEqual(report.fix, null, 'fix')
    assertEqual(report.pr, null, 'pr')
    assertEqual(report.count, 1, 'count')
    assertEqual(typeof report.fingerprint, 'string', 'fingerprint 类型')
    assertEqual(report.fingerprint.length, 16, 'fingerprint 长度')
    assert(typeof report.stack.includes('at '), 'stack 应该带帧')
  })

  await check('缺少某一个软依赖（只有 webServer）也不抛错', () => {
    const file = storeFile('soft-one')
    const ctx = makeCtx({ services: { webServer: makeWebServer() } })
    let threw = null
    try {
      apply(ctx, { storePath: file })
    } catch (error) {
      threw = error
    }
    assert(threw === null, `只缺 credentials/clientModules 时不能抛错：${threw && threw.message}`)
  })

  // -------------------------------------------------------------------------
  section('[3] GET/POST /state')

  await check('GET /state 形状、tokenConfigured=true、reports 新→旧', async () => {
    const file = storeFile('state')
    const credentials = {
      resolve: async (ref) => (ref === 'GITHUB_TOKEN' ? { value: 'tok', source: 'env' } : undefined),
    }
    const app = boot(
      { storePath: file, repo: 'o/r', tokenRef: 'GITHUB_TOKEN' },
      { services: { credentials } },
    )
    const first = await app.call('POST', '/bug-reporter/report', { message: '第一条' })
    await app.call('POST', '/bug-reporter/report', { message: '第二条' })
    const res = await app.call('GET', '/bug-reporter/state')
    assertEqual(res.status, 200, '状态码')
    assertEqual(res.json.ok, true, 'ok')
    assertDeepEqual(Object.keys(res.json.value), STATE_KEYS_ALL, 'state 字段名与顺序')
    assertEqual(res.json.value.enabled, true, 'enabled')
    assertEqual(res.json.value.captureTools, true, 'captureTools')
    assertEqual(res.json.value.captureProcess, true, 'captureProcess')
    assertEqual(res.json.value.repairEnabled, true, 'repairEnabled')
    assertEqual(res.json.value.repo, 'o/r', 'repo')
    assertEqual(res.json.value.tokenRef, 'GITHUB_TOKEN', 'tokenRef')
    assertEqual(res.json.value.baseBranch, '', 'baseBranch')
    assertEqual(res.json.value.tokenConfigured, true, 'tokenConfigured')
    assertEqual(res.json.value.storeFile, file, 'storeFile')
    assertEqual(res.json.value.reports.length, 2, 'reports 条数')
    assertEqual(res.json.value.reports[0].message, '第二条', 'reports 最新在前')
    assertEqual(res.json.value.reports[1].message, '第一条', 'reports 次新')
    assertEqual(res.json.value.reports[0].id, first.json.value.report.id === undefined ? '' : res.json.value.reports[0].id, 'id 存在')
    assert(res.headers['content-type'].startsWith('application/json'), 'content-type')
  })

  await check('tokenConfigured=false（resolve 返回 undefined）', async () => {
    const app = boot({ storePath: storeFile('state-notoken') }, { services: { credentials: { resolve: async () => undefined } } })
    const res = await app.call('GET', '/bug-reporter/state')
    assertEqual(res.status, 200, '状态码')
    assertEqual(res.json.value.tokenConfigured, false, 'tokenConfigured')
  })

  await check('tokenConfigured=false（credentials.resolve 抛错也不抛）', async () => {
    const credentials = {
      resolve: async () => {
        throw new Error('凭据服务炸了')
      },
    }
    const app = boot({ storePath: storeFile('state-throw') }, { services: { credentials } })
    const res = await app.call('GET', '/bug-reporter/state')
    assertEqual(res.status, 200, '状态码')
    assertEqual(res.json.value.tokenConfigured, false, 'tokenConfigured')
  })

  await check('tokenConfigured=false（credentials 缺失）', async () => {
    const app = boot({ storePath: storeFile('state-nocred') })
    const res = await app.call('GET', '/bug-reporter/state')
    assertEqual(res.json.value.tokenConfigured, false, 'tokenConfigured')
  })

  await check('POST /state 改设置并回整份 value', async () => {
    const app = boot({ storePath: storeFile('state-post') })
    const res = await app.call('POST', '/bug-reporter/state', {
      enabled: false,
      captureTools: false,
      captureProcess: false,
      repairEnabled: false,
      repo: 'x/y',
      tokenRef: 'T2',
      baseBranch: 'dev',
    })
    assertEqual(res.status, 200, '状态码')
    assertDeepEqual(Object.keys(res.json.value), STATE_KEYS_ALL, 'state 字段名')
    assertEqual(res.json.value.enabled, false, 'enabled')
    assertEqual(res.json.value.captureTools, false, 'captureTools')
    assertEqual(res.json.value.captureProcess, false, 'captureProcess')
    assertEqual(res.json.value.repairEnabled, false, 'repairEnabled')
    assertEqual(res.json.value.repo, 'x/y', 'repo')
    assertEqual(res.json.value.tokenRef, 'T2', 'tokenRef')
    assertEqual(res.json.value.baseBranch, 'dev', 'baseBranch')
  })

  await check('POST /state 忽略未知键、类型不对 400', async () => {
    const app = boot({ storePath: storeFile('state-patch') })
    const ok = await app.call('POST', '/bug-reporter/state', { nope: 1, tokenRef: 'T3' })
    assertEqual(ok.status, 200, '未知键应忽略')
    assertEqual(ok.json.value.tokenRef, 'T3', 'tokenRef')
    const bad = await app.call('POST', '/bug-reporter/state', { enabled: 'yes' })
    assertEqual(bad.status, 400, '类型不对状态码')
    assertEqual(bad.json.ok, false, 'ok')
    assertEqual(bad.json.error.code, 'invalid-state', 'error.code')
    assertEqual(typeof bad.json.error.message, 'string', 'error.message')
  })

  await check('运行时 enabled=false 停止捕获，改回 true 恢复', async () => {
    const file = storeFile('gate')
    const app = boot({ storePath: file })
    await app.call('POST', '/bug-reporter/state', { enabled: false })
    app.ctx.emit('agent/error', { agent: { id: 's' }, turn: 1, step: 1, error: new Error('不该被抓') })
    assertEqual(existsSync(file), false, 'enabled=false 时不应写文件')
    await app.call('POST', '/bug-reporter/state', { enabled: true })
    app.ctx.emit('agent/error', { agent: { id: 's' }, turn: 1, step: 1, error: new Error('该被抓') })
    const reports = readReports(file)
    assertEqual(reports.length, 1, '报告条数')
    assertEqual(reports[0].message, '该被抓', 'message')
  })

  // -------------------------------------------------------------------------
  section('[4] /report 增删改清 + 去重')

  await check('POST /report 建报告，字段与默认值正确', async () => {
    const file = storeFile('report')
    const app = boot({ storePath: file })
    const res = await app.call('POST', '/bug-reporter/report', {
      message: '炸了',
      stack: 'Error: 炸了\n    at a (a.js:1:1)',
      context: { k: 1 },
    })
    assertEqual(res.status, 200, '状态码')
    const report = res.json.value.report
    assertDeepEqual(Object.keys(report), REPORT_KEYS, 'Report 字段名')
    assertEqual(report.source, 'manual', 'source 默认 manual')
    assertEqual(report.level, 'error', 'level 默认 error')
    assertEqual(report.pluginId, null, 'pluginId 默认 null')
    assertEqual(report.sessionId, null, 'sessionId 默认 null')
    assertDeepEqual(report.context, { k: 1 }, 'context')
    assertEqual(report.count, 1, 'count')
    assertEqual(readReports(file).length, 1, '已落盘')
  })

  await check('去重：同指纹累加 count、更新 lastAt、firstAt 不变', async () => {
    const file = storeFile('dedup')
    const app = boot({ storePath: file })
    const stack = 'Error: 炸了\n    at a (a.js:1:1)\n    at b (b.js:2:2)\n    at c (c.js:3:3)'
    const first = await app.call('POST', '/bug-reporter/report', { message: '炸了', stack })
    const second = await app.call('POST', '/bug-reporter/report', { message: '炸了', stack })
    const a = first.json.value.report
    const b = second.json.value.report
    assertEqual(b.id, a.id, '同指纹必须复用 id')
    assertEqual(b.count, 2, 'count 累加')
    assertEqual(b.firstAt, a.firstAt, 'firstAt 不变')
    assert(b.lastAt >= a.lastAt, 'lastAt 应更新')
    assertEqual(readReports(file).length, 1, '文件里只有一条')
  })

  await check('指纹只取 stack 前 3 帧（第 4 帧不同也算同一条）', () => {
    const base = 'Error: x\n    at a (a.js:1:1)\n    at b (b.js:2:2)\n    at c (c.js:3:3)\n    at d (d.js:4:4)'
    const other = 'Error: x\n    at a (a.js:1:1)\n    at b (b.js:2:2)\n    at c (c.js:3:3)\n    at zzz (z.js:9:9)'
    const different = 'Error: x\n    at q (q.js:0:0)\n    at b (b.js:2:2)\n    at c (c.js:3:3)'
    assertEqual(internals.fingerprintOf('x', base), internals.fingerprintOf('x', other), '第 4 帧不应影响指纹')
    assert(internals.fingerprintOf('x', base) !== internals.fingerprintOf('x', different), '第 1 帧不同必须换指纹')
    assert(internals.fingerprintOf('x', base) !== internals.fingerprintOf('y', base), 'message 不同必须换指纹')
    assertEqual(internals.fingerprintOf('x', ''), internals.fingerprintOf('x', undefined), '无 stack 时一致')
  })

  await check('report/update 改状态；非法 status 400；未知 id 404', async () => {
    const app = boot({ storePath: storeFile('update') })
    const created = await app.call('POST', '/bug-reporter/report', { message: '要改的' })
    const id = created.json.value.report.id
    const ok = await app.call('POST', '/bug-reporter/report/update', { id, status: 'ignored' })
    assertEqual(ok.status, 200, '状态码')
    assertEqual(ok.json.value.report.status, 'ignored', 'status')
    const bad = await app.call('POST', '/bug-reporter/report/update', { id, status: 'bogus' })
    assertEqual(bad.status, 400, '非法 status')
    assertEqual(bad.json.error.code, 'invalid-status', 'error.code')
    const missing = await app.call('POST', '/bug-reporter/report/update', { id: 'nope', status: 'open' })
    assertEqual(missing.status, 404, '未知 id')
    assertEqual(missing.json.error.code, 'not-found', 'error.code')
    const noId = await app.call('POST', '/bug-reporter/report/update', { status: 'open' })
    assertEqual(noId.status, 400, '缺 id')
  })

  await check('report/delete 删一条；未知 id 404', async () => {
    const file = storeFile('delete')
    const app = boot({ storePath: file })
    const created = await app.call('POST', '/bug-reporter/report', { message: '要删的' })
    const id = created.json.value.report.id
    const res = await app.call('POST', '/bug-reporter/report/delete', { id })
    assertEqual(res.status, 200, '状态码')
    assertDeepEqual(res.json.value, { deleted: true }, 'value')
    assertEqual(readReports(file).length, 0, '已从磁盘删掉')
    const again = await app.call('POST', '/bug-reporter/report/delete', { id })
    assertEqual(again.status, 404, '再删一次 404')
  })

  await check('report/clear 清空并回条数', async () => {
    const file = storeFile('clear')
    const app = boot({ storePath: file })
    await app.call('POST', '/bug-reporter/report', { message: 'a' })
    await app.call('POST', '/bug-reporter/report', { message: 'b' })
    await app.call('POST', '/bug-reporter/report', { message: 'c' })
    const res = await app.call('POST', '/bug-reporter/report/clear', {})
    assertEqual(res.status, 200, '状态码')
    assertEqual(res.json.value.cleared, 3, 'cleared')
    assertEqual(readReports(file).length, 0, '磁盘已空')
    const empty = await app.call('POST', '/bug-reporter/report/clear', {})
    assertEqual(empty.json.value.cleared, 0, '空表 clear 回 0')
  })

  await check('POST /report 结构校验（缺 message / 空 message / 非法 source）', async () => {
    const app = boot({ storePath: storeFile('report-bad') })
    for (const bad of [{}, { message: '' }, { message: '   ' }, { message: 'x', source: 'nope' }]) {
      const res = await app.call('POST', '/bug-reporter/report', bad)
      assertEqual(res.status, 400, `应 400：${JSON.stringify(bad)}`)
      assertEqual(res.json.ok, false, 'ok')
    }
    const badType = await app.call('POST', '/bug-reporter/report', { message: 'x', stack: 5 })
    assertEqual(badType.status, 400, 'stack 类型不对')
  })

  await check('maxReports 裁剪：只留最新 N 条', async () => {
    const file = storeFile('trim')
    const app = boot({ storePath: file, maxReports: 3 })
    for (const message of ['m1', 'm2', 'm3', 'm4']) {
      await app.call('POST', '/bug-reporter/report', { message })
    }
    const state = await app.call('GET', '/bug-reporter/state')
    const messages = state.json.value.reports.map((report) => report.message)
    assertDeepEqual(messages, ['m4', 'm3', 'm2'], 'reports 只留最新 3 条')
    assertEqual(readReports(file).length, 3, '磁盘也是 3 行')
  })

  await check('JSONL 往返：重开插件能读回 fix/pr 字段', async () => {
    const file = storeFile('roundtrip')
    const app = boot({ storePath: file })
    const created = await app.call('POST', '/bug-reporter/report', { message: '往返' })
    const id = created.json.value.report.id
    await app.call('POST', '/bug-reporter/report/update', { id, status: 'fixed' })
    const again = boot({ storePath: file })
    const state = await again.call('GET', '/bug-reporter/state')
    assertEqual(state.json.value.reports.length, 1, '读回条数')
    assertEqual(state.json.value.reports[0].status, 'fixed', 'status 往返')
    assertEqual(state.json.value.reports[0].id, id, 'id 往返')
  })

  // -------------------------------------------------------------------------
  section('[5] /repair')

  await check('repair 写文件 + rebuilt 调用 + 状态变 fixed', async () => {
    const file = storeFile('repair')
    const pkgDir = join(ROOT, 'pkg-ok')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fake-plugin', dsh: { client: { platform: 'web' } } }),
      'utf8',
    )
    const target = join(pkgDir, 'client.js')
    writeFileSync(target, 'OLD', 'utf8')
    const rebuiltCalls = []
    const clientModules = {
      rebuilt: (id) => {
        rebuiltCalls.push(id)
        return 'deadbeef1234'
      },
      clientPath: () => target,
    }
    const app = boot({ storePath: file }, { services: { clientModules } })
    const created = await app.call('POST', '/bug-reporter/report', { message: '要修的' })
    const id = created.json.value.report.id
    const res = await app.call('POST', '/bug-reporter/repair', { id, path: target, content: 'NEW-CONTENT' })
    assertEqual(res.status, 200, '状态码')
    assertEqual(readFileSync(target, 'utf8'), 'NEW-CONTENT', '文件已原子替换')
    assertEqual(existsSync(`${target}.bug-reporter.tmp`), false, 'tmp 不残留')
    assertDeepEqual(rebuiltCalls, ['fake-plugin'], 'rebuilt 收到归属包名')
    assertEqual(res.json.value.fix.path, resolve(target), 'fix.path 是绝对路径')
    assertEqual(res.json.value.fix.reloaded, true, 'fix.reloaded')
    assertEqual(res.json.value.fix.rev, 'deadbeef1234', 'fix.rev')
    assertEqual(typeof res.json.value.fix.appliedAt, 'string', 'fix.appliedAt')
    assertDeepEqual(Object.keys(res.json.value.fix), ['path', 'appliedAt', 'reloaded', 'rev'], 'fix 字段名')
    assertEqual(res.json.value.report.status, 'fixed', 'report.status')
    assertDeepEqual(res.json.value.report.fix, res.json.value.fix, 'report.fix')
    const persisted = readReports(file)[0]
    assertEqual(persisted.status, 'fixed', '落盘的 status')
    assertEqual(persisted.fix.rev, 'deadbeef1234', '落盘的 rev')
  })

  await check('repair 新建目录里的文件（mkdir 递归）', async () => {
    const file = storeFile('repair-mkdir')
    const target = join(ROOT, 'pkg-ok', 'deep', 'nested', 'x.js')
    const app = boot({ storePath: file })
    const created = await app.call('POST', '/bug-reporter/report', { message: '新目录' })
    const res = await app.call('POST', '/bug-reporter/repair', {
      id: created.json.value.report.id,
      path: target,
      content: 'X',
    })
    assertEqual(res.status, 200, '状态码')
    assertEqual(readFileSync(target, 'utf8'), 'X', '文件已写入')
  })

  await check('归属包没有 dsh.client → 不调 rebuilt，reloaded=false', async () => {
    const file = storeFile('repair-noclient')
    const pkgDir = join(ROOT, 'pkg-noclient')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'plain-pkg' }), 'utf8')
    const target = join(pkgDir, 'x.js')
    writeFileSync(target, 'OLD', 'utf8')
    const rebuiltCalls = []
    const app = boot({ storePath: file }, { services: { clientModules: { rebuilt: (id) => (rebuiltCalls.push(id), 'rev') } } })
    const created = await app.call('POST', '/bug-reporter/report', { message: '没有 client' })
    const res = await app.call('POST', '/bug-reporter/repair', {
      id: created.json.value.report.id,
      path: target,
      content: 'NEW',
    })
    assertEqual(res.json.value.fix.reloaded, false, 'reloaded')
    assertEqual(res.json.value.fix.rev, null, 'rev')
    assertDeepEqual(rebuiltCalls, [], 'rebuilt 不应被调用')
  })

  await check('clientModules 缺失 → reloaded=false 但仍写文件', async () => {
    const file = storeFile('repair-nomod')
    const pkgDir = join(ROOT, 'pkg-ok')
    const target = join(pkgDir, 'other.js')
    writeFileSync(target, 'OLD', 'utf8')
    const app = boot({ storePath: file })
    const created = await app.call('POST', '/bug-reporter/report', { message: '没有 clientModules' })
    const res = await app.call('POST', '/bug-reporter/repair', {
      id: created.json.value.report.id,
      path: target,
      content: 'NEW2',
    })
    assertEqual(res.status, 200, '状态码')
    assertEqual(readFileSync(target, 'utf8'), 'NEW2', '文件已写')
    assertEqual(res.json.value.fix.reloaded, false, 'reloaded')
  })

  await check('rebuilt 返回 undefined → reloaded=false', async () => {
    const file = storeFile('repair-norev')
    const pkgDir = join(ROOT, 'pkg-ok')
    const target = join(pkgDir, 'third.js')
    writeFileSync(target, 'OLD', 'utf8')
    const app = boot({ storePath: file }, { services: { clientModules: { rebuilt: () => undefined } } })
    const created = await app.call('POST', '/bug-reporter/report', { message: 'rebuilt 没回 rev' })
    const res = await app.call('POST', '/bug-reporter/repair', {
      id: created.json.value.report.id,
      path: target,
      content: 'NEW3',
    })
    assertEqual(res.json.value.fix.reloaded, false, 'reloaded')
    assertEqual(res.json.value.fix.rev, null, 'rev')
  })

  await check('repairEnabled=false → 403 repair-disabled', async () => {
    const file = storeFile('repair-disabled')
    const app = boot({ storePath: file, repairEnabled: false })
    const created = await app.call('POST', '/bug-reporter/report', { message: 'x' })
    const res = await app.call('POST', '/bug-reporter/repair', {
      id: created.json.value.report.id,
      path: join(ROOT, 'nope.js'),
      content: 'X',
    })
    assertEqual(res.status, 403, '状态码')
    assertEqual(res.json.error.code, 'repair-disabled', 'error.code')
    assertEqual(existsSync(join(ROOT, 'nope.js')), false, '不应写文件')
  })

  await check('repair 缺 path / 缺 content → 400；未知 id → 404', async () => {
    const file = storeFile('repair-bad')
    const app = boot({ storePath: file })
    const created = await app.call('POST', '/bug-reporter/report', { message: 'x' })
    const id = created.json.value.report.id
    const noPath = await app.call('POST', '/bug-reporter/repair', { id, content: 'X' })
    assertEqual(noPath.status, 400, '缺 path')
    const noContent = await app.call('POST', '/bug-reporter/repair', { id, path: join(ROOT, 'a.js') })
    assertEqual(noContent.status, 400, '缺 content')
    const badId = await app.call('POST', '/bug-reporter/repair', { id: 'nope', path: join(ROOT, 'b.js'), content: 'X' })
    assertEqual(badId.status, 404, '未知 id')
    assertEqual(existsSync(join(ROOT, 'b.js')), false, '未知 id 不应写文件')
  })

  await check('findOwningPackage 取最近的含 name 的 package.json', () => {
    const outer = join(ROOT, 'nest', 'outer')
    const inner = join(outer, 'inner', 'deep')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer', dsh: { client: {} } }), 'utf8')
    writeFileSync(join(outer, 'inner', 'package.json'), JSON.stringify({ dsh: { client: {} } }), 'utf8')
    const found = internals.findOwningPackage(join(inner, 'x.js'))
    assert(found !== null, '应该找到归属包')
    assertEqual(found.name, 'outer', '应跳过没有 name 的 package.json')
    assertEqual(found.hasClient, true, 'hasClient')
  })

  // -------------------------------------------------------------------------
  section('[6] /submit')

  await check('submit 无 token → 401 no-token，且不调 fetch', async () => {
    const file = storeFile('submit-notoken')
    let fetchCalls = 0
    internals.setFetch(async () => {
      fetchCalls += 1
      throw new Error('不该真的发请求')
    })
    internals.setGhTokenRunner(async () => undefined)
    try {
      const app = boot({ storePath: file, repo: 'o/r' }, { services: { credentials: { resolve: async () => undefined } } })
      const created = await app.call('POST', '/bug-reporter/report', { message: '要提的' })
      const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
      assertEqual(res.status, 401, '状态码')
      assertEqual(res.json.ok, false, 'ok')
      assertEqual(res.json.error.code, 'no-token', 'error.code')
      assertEqual(fetchCalls, 0, '不应发任何 GitHub 请求')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit 走 gh auth token 兜底', async () => {
    const file = storeFile('submit-gh')
    const urls = []
    internals.setGhTokenRunner(async () => 'gh-token')
    internals.setFetch(async (url, init) => {
      urls.push(`${init.method} ${url}`)
      if (url.endsWith('/repos/o/r')) return jsonResponse(200, { default_branch: 'main' })
      if (url.includes('/git/ref/heads/')) return jsonResponse(200, { object: { sha: 'sha1' } })
      if (url.endsWith('/git/refs')) return jsonResponse(201, {})
      if (url.includes('/contents/')) return jsonResponse(201, {})
      if (url.endsWith('/pulls')) return jsonResponse(201, { html_url: 'https://github.com/o/r/pull/1', number: 1 })
      return jsonResponse(500, { message: `未预期 ${url}` })
    })
    try {
      const app = boot({ storePath: file, repo: 'o/r' }, { services: { credentials: { resolve: async () => undefined } } })
      const created = await app.call('POST', '/bug-reporter/report', { message: 'gh 兜底' })
      const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
      assertEqual(res.status, 200, '状态码')
      assertEqual(urls.length, 5, '5 次 REST 调用')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit happy path：5 步 REST、分支名、文件路径、PR 正文', async () => {
    const file = storeFile('submit-ok')
    const calls = []
    internals.setFetch(async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) })
      if (init.method === 'GET' && url.endsWith('/repos/o/r')) return jsonResponse(200, { default_branch: 'main' })
      if (init.method === 'GET' && url.endsWith('/git/ref/heads/main')) return jsonResponse(200, { object: { sha: 'abc123' } })
      if (init.method === 'POST' && url.endsWith('/git/refs')) return jsonResponse(201, { ref: 'refs/heads/x' })
      if (init.method === 'PUT' && url.includes('/contents/')) return jsonResponse(201, { content: {} })
      if (init.method === 'POST' && url.endsWith('/pulls')) {
        return jsonResponse(201, { html_url: 'https://github.com/o/r/pull/7', number: 7 })
      }
      return jsonResponse(500, { message: `未预期 ${init.method} ${url}` })
    })
    try {
      const app = boot(
        { storePath: file, repo: 'o/r' },
        { services: { credentials: { resolve: async () => ({ value: 'tok', source: 'store' }) } } },
      )
      const created = await app.call('POST', '/bug-reporter/report', {
        message: '提交这条',
        stack: 'Error: 提交这条\n    at a (a.js:1:1)',
        context: { turn: 1 },
      })
      const id = created.json.value.report.id
      const fingerprint = created.json.value.report.fingerprint
      const res = await app.call('POST', '/bug-reporter/submit', { id })
      assertEqual(res.status, 200, '状态码')

      assertEqual(calls.length, 5, '5 次调用')
      assertEqual(calls[0].method, 'GET', '1) GET')
      assertEqual(calls[0].url, 'https://api.github.com/repos/o/r', '1) url')
      assertEqual(calls[1].method, 'GET', '2) GET')
      assertEqual(calls[1].url, 'https://api.github.com/repos/o/r/git/ref/heads/main', '2) url')
      assertEqual(calls[2].method, 'POST', '3) POST')
      assertEqual(calls[2].url, 'https://api.github.com/repos/o/r/git/refs', '3) url')
      assertEqual(calls[3].method, 'PUT', '4) PUT')
      assert(calls[3].url.startsWith('https://api.github.com/repos/o/r/contents/bug-reports/'), `4) url：${calls[3].url}`)
      assert(/\/contents\/bug-reports\/\d{8}-\d{6}-[a-z0-9-]+\.md$/.test(calls[3].url), `4) 文件名形状：${calls[3].url}`)
      assertEqual(calls[4].method, 'POST', '5) POST')
      assertEqual(calls[4].url, 'https://api.github.com/repos/o/r/pulls', '5) url')

      assertEqual(calls[0].headers.authorization, 'Bearer tok', 'Authorization 头')
      const branch = `bug-report/${fingerprint.slice(0, 12)}`
      assertDeepEqual(calls[2].body, { ref: `refs/heads/${branch}`, sha: 'abc123' }, '3) 建分支 body')
      assertEqual(calls[3].body.branch, branch, '4) 提交到新分支')
      assertEqual(typeof calls[3].body.message, 'string', '4) commit message')
      const markdown = Buffer.from(calls[3].body.content, 'base64').toString('utf8')
      assert(markdown.includes('提交这条'), 'PR 正文含 message')
      assert(markdown.includes('at a (a.js:1:1)'), 'PR 正文含 stack')
      assert(markdown.includes('"turn": 1'), 'PR 正文含 context')
      assert(markdown.includes('次数: 1'), 'PR 正文含次数')
      assert(markdown.includes('首次:'), 'PR 正文含首次时间')
      assert(markdown.includes('最近:'), 'PR 正文含最近时间')
      assertEqual(calls[4].body.head, branch, '5) head')
      assertEqual(calls[4].body.base, 'main', '5) base')
      assertEqual(calls[4].body.body, markdown, '5) PR 正文 = 提交的文件内容')
      assert(calls[4].body.title.startsWith('[bug-reporter]'), `5) 标题：${calls[4].body.title}`)

      assertDeepEqual(Object.keys(res.json.value), ['report', 'pr'], 'submit value 字段名')
      assertEqual(res.json.value.pr.url, 'https://github.com/o/r/pull/7', 'pr.url')
      assertEqual(res.json.value.pr.number, 7, 'pr.number')
      assertEqual(res.json.value.pr.repo, 'o/r', 'pr.repo')
      assertEqual(res.json.value.pr.branch, branch, 'pr.branch')
      assertEqual(typeof res.json.value.pr.at, 'string', 'pr.at')
      assertDeepEqual(Object.keys(res.json.value.pr), ['url', 'number', 'repo', 'branch', 'at'], 'pr 字段名')
      assertDeepEqual(res.json.value.report.pr, res.json.value.pr, 'report.pr')

      const state = await app.call('GET', '/bug-reporter/state')
      assertEqual(state.json.value.reports[0].pr.number, 7, 'pr 已落盘')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit 已修的报告：PR 正文带 fix 说明', async () => {
    const file = storeFile('submit-fixed')
    const pkgDir = join(ROOT, 'pkg-ok')
    const target = join(pkgDir, 'client.js')
    writeFileSync(target, 'OLD', 'utf8')
    let pullsBody = null
    internals.setFetch(async (url, init) => {
      if (init.method === 'GET' && url.endsWith('/repos/o/r')) return jsonResponse(200, { default_branch: 'main' })
      if (url.includes('/git/ref/heads/')) return jsonResponse(200, { object: { sha: 'sha1' } })
      if (url.endsWith('/git/refs')) return jsonResponse(201, {})
      if (url.includes('/contents/')) return jsonResponse(201, {})
      if (url.endsWith('/pulls')) {
        pullsBody = JSON.parse(init.body).body
        return jsonResponse(201, { html_url: 'https://github.com/o/r/pull/9', number: 9 })
      }
      return jsonResponse(500, { message: '未预期' })
    })
    try {
      const app = boot(
        { storePath: file, repo: 'o/r' },
        {
          services: {
            credentials: { resolve: async () => ({ value: 'tok', source: 'store' }) },
            clientModules: { rebuilt: () => 'rev123' },
          },
        },
      )
      const created = await app.call('POST', '/bug-reporter/report', { message: '先修再提' })
      const id = created.json.value.report.id
      await app.call('POST', '/bug-reporter/repair', { id, path: target, content: 'FIXED' })
      const res = await app.call('POST', '/bug-reporter/submit', { id })
      assertEqual(res.status, 200, '状态码')
      assert(pullsBody.includes('## 修复'), 'PR 正文含修复小节')
      assert(pullsBody.includes(resolve(target)), 'PR 正文含 fix.path')
      assert(pullsBody.includes('rev123'), 'PR 正文含 fix.rev')
      assert(pullsBody.includes('整文件替换'), 'PR 正文含 diff 说明')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit 用请求体 repo / baseBranch 覆盖设置', async () => {
    const file = storeFile('submit-override')
    const urls = []
    internals.setFetch(async (url, init) => {
      urls.push(url)
      if (init.method === 'GET' && url.endsWith('/repos/a/b')) return jsonResponse(200, { default_branch: 'main' })
      if (url.includes('/git/ref/heads/dev')) return jsonResponse(200, { object: { sha: 'sha1' } })
      if (url.endsWith('/git/refs')) return jsonResponse(201, {})
      if (url.includes('/contents/')) return jsonResponse(201, {})
      if (url.endsWith('/pulls')) return jsonResponse(201, { html_url: 'u', number: 2 })
      return jsonResponse(500, { message: `未预期 ${url}` })
    })
    try {
      const app = boot(
        { storePath: file, repo: 'o/r' },
        { services: { credentials: { resolve: async () => ({ value: 'tok', source: 's' }) } } },
      )
      const created = await app.call('POST', '/bug-reporter/report', { message: '覆盖' })
      const res = await app.call('POST', '/bug-reporter/submit', {
        id: created.json.value.report.id,
        repo: 'a/b',
        baseBranch: 'dev',
      })
      assertEqual(res.status, 200, '状态码')
      assertEqual(res.json.value.pr.repo, 'a/b', 'pr.repo 用请求体')
      assert(urls.includes('https://api.github.com/repos/a/b'), '用了请求体的 repo')
      assert(urls.includes('https://api.github.com/repos/a/b/git/ref/heads/dev'), '用了请求体的 baseBranch')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit 缺 repo → 400 no-repo', async () => {
    const file = storeFile('submit-norepo')
    internals.setFetch(async () => jsonResponse(500, { message: '不该发请求' }))
    try {
      const app = boot({ storePath: file }, { services: { credentials: { resolve: async () => ({ value: 'tok', source: 's' }) } } })
      const created = await app.call('POST', '/bug-reporter/report', { message: '没有仓库' })
      const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
      assertEqual(res.status, 400, '状态码')
      assertEqual(res.json.error.code, 'no-repo', 'error.code')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('submit 未知 id → 404', async () => {
    const app = boot({ storePath: storeFile('submit-badid'), repo: 'o/r' })
    const res = await app.call('POST', '/bug-reporter/submit', { id: 'nope' })
    assertEqual(res.status, 404, '状态码')
    assertEqual(res.json.error.code, 'not-found', 'error.code')
  })

  await check('GitHub 错误映射：401/403→401、404→404、其他→502', async () => {
    const cases = [
      { status: 403, expectStatus: 401, expectCode: 'github-unauthorized' },
      { status: 401, expectStatus: 401, expectCode: 'github-unauthorized' },
      { status: 404, expectStatus: 404, expectCode: 'repo-not-found' },
      { status: 500, expectStatus: 502, expectCode: 'github-error' },
    ]
    for (const item of cases) {
      const file = storeFile(`submit-err-${item.status}`)
      internals.setFetch(async () => jsonResponse(item.status, { message: `GitHub 说 ${item.status}` }))
      try {
        const app = boot(
          { storePath: file, repo: 'o/r' },
          { services: { credentials: { resolve: async () => ({ value: 'tok', source: 's' }) } } },
        )
        const created = await app.call('POST', '/bug-reporter/report', { message: '错误映射' })
        const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
        assertEqual(res.status, item.expectStatus, `HTTP ${item.status} → 我们的状态码`)
        assertEqual(res.json.error.code, item.expectCode, `HTTP ${item.status} → 错误码`)
        assertEqual(res.json.error.message, `GitHub 说 ${item.status}`, 'error.message 带 GitHub 原文')
      } finally {
        internals.resetOverrides()
      }
    }
  })

  await check('分支已存在（422）→ 复用，继续走完', async () => {
    const file = storeFile('submit-422')
    let pulls = 0
    internals.setFetch(async (url, init) => {
      if (init.method === 'GET' && url.endsWith('/repos/o/r')) return jsonResponse(200, { default_branch: 'main' })
      if (url.includes('/git/ref/heads/')) return jsonResponse(200, { object: { sha: 'sha1' } })
      if (url.endsWith('/git/refs')) return jsonResponse(422, { message: 'Reference already exists' })
      if (url.includes('/contents/')) return jsonResponse(201, {})
      if (url.endsWith('/pulls')) {
        pulls += 1
        return jsonResponse(201, { html_url: 'u', number: 3 })
      }
      return jsonResponse(500, { message: '未预期' })
    })
    try {
      const app = boot(
        { storePath: file, repo: 'o/r' },
        { services: { credentials: { resolve: async () => ({ value: 'tok', source: 's' }) } } },
      )
      const created = await app.call('POST', '/bug-reporter/report', { message: '分支已存在' })
      const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
      assertEqual(res.status, 200, '状态码')
      assertEqual(pulls, 1, '仍然开了 PR')
    } finally {
      internals.resetOverrides()
    }
  })

  await check('fetch 抛错 → 502 github-error（不冒泡）', async () => {
    const file = storeFile('submit-net')
    internals.setFetch(async () => {
      throw new Error('网络断了')
    })
    try {
      const app = boot(
        { storePath: file, repo: 'o/r' },
        { services: { credentials: { resolve: async () => ({ value: 'tok', source: 's' }) } } },
      )
      const created = await app.call('POST', '/bug-reporter/report', { message: '网络' })
      const res = await app.call('POST', '/bug-reporter/submit', { id: created.json.value.report.id })
      assertEqual(res.status, 502, '状态码')
      assertEqual(res.json.error.code, 'github-error', 'error.code')
      assert(res.json.error.message.includes('网络断了'), 'message 带上原因')
    } finally {
      internals.resetOverrides()
    }
  })

  // -------------------------------------------------------------------------
  section('[7] 其他事件捕获')

  await check('tools/result：isError 才记，context 带 tool/code/file', () => {
    const file = storeFile('tools')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file })
    ctx.emit(
      'tools/result',
      { name: 'read', arguments: { path: 'D:/x/y.js' }, agent: { id: 'sess-t' } },
      { isError: true, error: { message: 'ENOENT', info: { code: 'not-found' } } },
    )
    ctx.emit('tools/result', { name: 'read', agent: { id: 'sess-t' } }, { isError: false })
    ctx.emit('tools/result', { name: 'read', agent: { id: 'sess-t' } }, {})
    const reports = readReports(file)
    assertEqual(reports.length, 1, '只有 isError 才记')
    assertEqual(reports[0].source, 'tools/result', 'source')
    assertEqual(reports[0].message, '工具 read 执行失败：ENOENT', 'message')
    assertEqual(reports[0].sessionId, 'sess-t', 'sessionId')
    assertEqual(reports[0].context.tool, 'read', 'context.tool')
    assertEqual(reports[0].context.code, 'not-found', 'context.code')
    assertEqual(reports[0].context.file, 'D:/x/y.js', 'context.file（给修复面板预填）')
  })

  await check('captureTools=false → 工具失败不记', () => {
    const file = storeFile('tools-off')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file, captureTools: false })
    ctx.emit('tools/result', { name: 'read' }, { isError: true, error: { message: 'x' } })
    assertEqual(existsSync(file), false, '不应写文件')
  })

  await check('api-session/error 与 agent-loop/config-start-failed', () => {
    const file = storeFile('events')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file })
    ctx.emit('api-session/error', 'sess-a', '会话在 turn 位之外炸了')
    ctx.emit('agent-loop/config-start-failed', { sessionId: 'sess-b', error: new Error('配置启动失败') })
    const reports = readReports(file)
    assertEqual(reports.length, 2, '两条')
    const api = reports.find((report) => report.source === 'api-session/error')
    const loop = reports.find((report) => report.source === 'agent-loop/config-start-failed')
    assert(api !== undefined, 'api-session/error 记录存在')
    assert(loop !== undefined, 'agent-loop/config-start-failed 记录存在')
    assertEqual(api.message, '会话在 turn 位之外炸了', 'api message')
    assertEqual(api.sessionId, 'sess-a', 'api sessionId')
    assertEqual(loop.message, '配置启动失败', 'loop message')
    assertEqual(loop.sessionId, 'sess-b', 'loop sessionId')
  })

  await check('agent/error 的 error 为空也不抛', () => {
    const file = storeFile('events-empty')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file })
    ctx.emit('agent/error', {})
    ctx.emit('agent/error', undefined)
    ctx.emit('api-session/error', undefined, undefined)
    const reports = readReports(file)
    assertEqual(reports.length, 2, '两条（undefined 的 error 与 undefined 的 message 指纹不同）')
    assert(reports.every((report) => report.message !== ''), 'message 不应为空串')
  })

  await check('hmr/reload 只观察、不产生报告', () => {
    const file = storeFile('hmr')
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: file })
    ctx.emit('hmr/reload', new Map([[{ name: 'dsh-bug-reporter' }, {}], [{ name: 'other' }, {}]]))
    const reloads = internals.reloads()
    assertEqual(reloads.length, 1, '记录 1 次')
    assertDeepEqual(reloads[0].ids, ['dsh-bug-reporter', 'other'], 'ids')
    assertEqual(existsSync(file), false, '热重载不应产生报告')
    ctx.emit('hmr/reload', 'not-a-map')
    assertEqual(internals.reloads().length, 2, '非 Map 也不抛')
  })

  // -------------------------------------------------------------------------
  section('[8] process 级捕获')

  await check('captureProcess=false → 不挂监听器', () => {
    const before = process.listeners('uncaughtException').length
    const beforeRej = process.listeners('unhandledRejection').length
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: storeFile('proc-off'), captureProcess: false })
    assertEqual(process.listeners('uncaughtException').length, before, '不应新增 uncaughtException 监听器')
    assertEqual(process.listeners('unhandledRejection').length, beforeRej, '不应新增 unhandledRejection 监听器')
  })

  await check('captureProcess=true → 挂上，dispose 后摘掉', () => {
    const before = process.listeners('uncaughtException').length
    const beforeRej = process.listeners('unhandledRejection').length
    const ctx = makeCtx({ services: {} })
    apply(ctx, { storePath: storeFile('proc-on'), captureProcess: true })
    assertEqual(process.listeners('uncaughtException').length, before + 1, 'uncaughtException 监听器')
    assertEqual(process.listeners('unhandledRejection').length, beforeRej + 1, 'unhandledRejection 监听器')
    ctx.dispose()
    assertEqual(process.listeners('uncaughtException').length, before, 'dispose 后摘掉 uncaughtException')
    assertEqual(process.listeners('unhandledRejection').length, beforeRej, 'dispose 后摘掉 unhandledRejection')
  })

  await check('运行时 POST /state captureProcess=false 摘掉监听器', async () => {
    const before = process.listeners('uncaughtException').length
    const app = boot({ storePath: storeFile('proc-toggle') })
    assertEqual(process.listeners('uncaughtException').length, before + 1, '先挂上')
    await app.call('POST', '/bug-reporter/state', { captureProcess: false })
    assertEqual(process.listeners('uncaughtException').length, before, '关掉后摘除')
    await app.call('POST', '/bug-reporter/state', { captureProcess: true })
    assertEqual(process.listeners('uncaughtException').length, before + 1, '再开回来')
    app.ctx.dispose()
    assertEqual(process.listeners('uncaughtException').length, before, '收尾摘除')
  })

  await check('uncaughtException：记录 + 进程仍非 0 退出 + 原始错误照样打印', () => {
    const file = storeFile('proc-uncaught')
    const child = spawnSync(process.execPath, [SELF], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, BUG_CHECK_CHILD: 'uncaught', BUG_CHECK_STORE: file },
    })
    assert(child.error === undefined, `子进程启动失败：${child.error && child.error.message}`)
    assert(child.status !== 0, `进程必须非 0 退出，实际 status=${child.status}`)
    assert(
      String(child.stderr).includes('BUG-CHECK-UNCAUGHT'),
      `stderr 必须仍然打印原始错误（未被吞掉），实际：${JSON.stringify(String(child.stderr).slice(0, 400))}`,
    )
    const reports = readReports(file)
    assertEqual(reports.length, 1, '记了 1 条')
    assertEqual(reports[0].source, 'process', 'source')
    assertEqual(reports[0].message, 'BUG-CHECK-UNCAUGHT', 'message')
    assertEqual(reports[0].context.kind, 'uncaughtException', 'context.kind')
  })

  await check('unhandledRejection：记录 + 进程仍非 0 退出 + 原始 reason 照样打印', () => {
    const file = storeFile('proc-rejection')
    const child = spawnSync(process.execPath, [SELF], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, BUG_CHECK_CHILD: 'rejection', BUG_CHECK_STORE: file },
    })
    assert(child.error === undefined, `子进程启动失败：${child.error && child.error.message}`)
    assert(child.status !== 0, `进程必须非 0 退出，实际 status=${child.status}`)
    assert(
      String(child.stderr).includes('BUG-CHECK-REJECTION'),
      `stderr 必须仍然打印原始 reason，实际：${JSON.stringify(String(child.stderr).slice(0, 400))}`,
    )
    const reports = readReports(file)
    const rejection = reports.find((report) => report.context !== null && report.context.kind === 'unhandledRejection')
    assert(rejection !== undefined, '必须记下 unhandledRejection')
    assertEqual(rejection.source, 'process', 'source')
    assertEqual(rejection.message, 'BUG-CHECK-REJECTION', 'message')
  })

  // -------------------------------------------------------------------------
  section('[9] HTTP 协议层')

  await check('未知路径 404；方法不对 405', async () => {
    const app = boot({ storePath: storeFile('http') })
    const notFound = await app.call('GET', '/bug-reporter/nope')
    assertEqual(notFound.status, 404, '未知路径')
    assertEqual(notFound.json.error.code, 'not-found', 'error.code')
    for (const [method, path] of [
      ['GET', '/bug-reporter/report'],
      ['GET', '/bug-reporter/repair'],
      ['PUT', '/bug-reporter/state'],
      ['DELETE', '/bug-reporter/state'],
      ['PATCH', '/bug-reporter/submit'],
    ]) {
      const res = await app.call(method, path)
      assertEqual(res.status, 405, `${method} ${path} 应 405`)
      assertEqual(res.json.error.code, 'method-not-allowed', `${method} ${path} error.code`)
    }
  })

  await check('坏 JSON / 非对象 body → 400', async () => {
    const app = boot({ storePath: storeFile('http-bad') })
    const badJson = await app.call('POST', '/bug-reporter/state', 'not json at all')
    assertEqual(badJson.status, 400, '坏 JSON')
    assertEqual(badJson.json.error.code, 'bad-json', 'error.code')
    const array = await app.call('POST', '/bug-reporter/report', '[1,2,3]')
    assertEqual(array.status, 400, '数组 body')
    const scalar = await app.call('POST', '/bug-reporter/report', '42')
    assertEqual(scalar.status, 400, '标量 body')
    const empty = await app.call('POST', '/bug-reporter/report', '')
    assertEqual(empty.status, 400, '空 body 当 {} → 缺 message')
  })

  await check('请求体超过 1 MiB → 413 body-too-large', async () => {
    const app = boot({ storePath: storeFile('http-big') })
    const res = await app.call('POST', '/bug-reporter/report', 'x'.repeat((1 << 20) + 10))
    assertEqual(res.status, 413, '状态码')
    assertEqual(res.json.ok, false, 'ok')
    assertEqual(res.json.error.code, 'body-too-large', 'error.code')
  })

  await check('响应统一信封与 no-store', async () => {
    const app = boot({ storePath: storeFile('http-env') })
    const res = await app.call('GET', '/bug-reporter/state')
    assertEqual(res.json.ok, true, 'ok')
    assert(res.json.value !== undefined, 'value')
    assertEqual(res.headers['cache-control'], 'no-store', 'cache-control')
    const err = await app.call('GET', '/bug-reporter/nope')
    assertEqual(err.json.ok, false, 'ok=false')
    assertEqual(typeof err.json.error.code, 'string', 'error.code')
    assertEqual(typeof err.json.error.message, 'string', 'error.message')
  })

  // -------------------------------------------------------------------------
  section('[10] 源码硬边界')

  await check('index.js 不 import @deepseek-ai/*，无 process.exit，不碰 systemPrompt', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^\s*(?:import|export)[^\n]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    assertDeepEqual(imports, ['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path'], 'import 列表')
    assert(!/@deepseek-ai/.test(imports.join(',')), '不得 import @deepseek-ai/*')
    assert(!/process\.exit\s*\(/.test(source), '不得调用 process.exit')
    assert(!/process\.exitCode/.test(source), '不得改 process.exitCode')
    assert(!/systemPrompt/.test(source), '宿主半区不需要 system prompt section')
    assert(source.includes("'uncaughtException'"), '必须处理 uncaughtException')
    assert(source.includes("'unhandledRejection'"), '必须处理 unhandledRejection')
    assert(source.includes("ctx.inject(['webServer']"), 'webServer 必须是 ctx.inject 软依赖')
    assert(source.includes("ctx.inject(['credentials']"), 'credentials 必须是 ctx.inject 软依赖')
    assert(source.includes("ctx.inject(['clientModules']"), 'clientModules 必须是 ctx.inject 软依赖')
  })

  await check('index.js 里 uncaughtException 处理函数会摘掉自己再抛回原始值', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    const block = source.slice(source.indexOf('const onUncaught ='), source.indexOf('const onRejection ='))
    assert(block.includes("process.removeListener('uncaughtException', onUncaught)"), '必须摘掉自己')
    assert(/setImmediate\(\(\) => \{\s*throw error\s*\}\)/.test(block), '必须把原始值抛回去')
  })

  // -------------------------------------------------------------------------
  const failed = results.filter((item) => !item.ok)
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} 通过${failed.length === 0 ? '' : `，失败 ${failed.length} 条`}\n`,
  )
  for (const item of failed) {
    process.stdout.write(`  \u2717 ${item.name}\n      ${item.error instanceof Error ? item.error.stack : String(item.error)}\n`)
  }

  if (ROOT.startsWith(tmpdir())) rmSync(ROOT, { recursive: true, force: true })
  process.exitCode = failed.length === 0 ? 0 : 1
}
