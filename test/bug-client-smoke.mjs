/**
 * bug-client-smoke.mjs — dsh-bug-reporter/client.js 的烟测。
 *
 * 做四件事：
 *   1. 静态检查：无 JSX、loader id 正确、消费的端点清单。
 *   2. 用桩 `window.__ModuleLoader__` + 桩 `react` 载入模块，确认 factory 返回
 *      `{inject, apply}`，且 apply 调了一次 `ctx.slots.inject('settings.section', ...)`。
 *   3. 起一个假的 http 服务，用一个最小 React hooks 运行时真的挂载组件，确认
 *      报告列表、PR 链接、修复信息、未处理条数都渲染出来了。
 *   4. 两条失败路径：宿主返回 `{ok:false}` 时状态行显示原因且不抛异常（不白屏）；
 *      请求未回来就卸载时，不再 setState（卸载防护）。
 *
 * 跑法：在仓库根跑 `node test/bug-client-smoke.mjs`
 */

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'client.js')
const src = readFileSync(CLIENT_PATH, 'utf8')

let failures = 0
function check(name, condition, detail) {
  const ok = Boolean(condition)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─────────────────────────────────────────────────────────────
// 最小 React hooks 运行时（只为烟测存在；行为对齐 React 的 hook 语义）
// ─────────────────────────────────────────────────────────────
function createHarness() {
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
    const changed = !prev || !deps || !prev.deps ||
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
      const changed = !prev || !effect.deps || prev.length !== effect.deps.length ||
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

  /** 渲染到静止：有 setState 就再渲染，直到 quietMs 内没有新变更。 */
  async function settle(options = {}) {
    const quietMs = options.quietMs ?? 80
    const maxPasses = options.maxPasses ?? 60
    let passes = 0
    let lastChange = Date.now()
    while (passes < maxPasses) {
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
        passes += 1
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

// ─────────────────────────────────────────────────────────────
// 渲染树遍历：抽文本与链接
// ─────────────────────────────────────────────────────────────
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
  const anchors = []
  const fields = []
  walk(root, (hit) => {
    if (hit.text) texts.push(hit.text)
    if (hit.element && hit.element.type === 'a') anchors.push(hit.element.props)
    if (hit.element && (hit.element.type === 'input' || hit.element.type === 'textarea')) {
      fields.push({ tag: hit.element.type, ...hit.element.props })
    }
  })
  return { text: texts.join(' '), anchors, fields }
}

/** 找到某个按钮元素（按它的文本内容匹配）。 */
function findButton(root, label) {
  let found = null
  walk(root, (hit) => {
    if (found) return
    const element = hit.element
    if (!element || typeof element.type !== 'function') return
    if (typeof element.props.onClick !== 'function') return
    if (collect(element).text.trim() === label) found = element
  })
  return found
}

// ─────────────────────────────────────────────────────────────
// 假宿主：http 服务 + 桩 require/window
// ─────────────────────────────────────────────────────────────
const STATE = {
  enabled: true,
  captureTools: true,
  captureProcess: true,
  repairEnabled: true,
  repo: 'zuaonew-ops/dsh-bug-reporter',
  tokenRef: 'GITHUB_TOKEN',
  baseBranch: 'main',
  tokenConfigured: true,
  storeFile: 'C:\\Users\\smoke\\.dsh\\bug-reports.jsonl',
  reports: [
    {
      id: 'r1',
      fingerprint: 'fp-smoke-1',
      firstAt: '2026-10-18T01:00:00.000Z',
      lastAt: '2026-10-18T02:30:00.000Z',
      count: 3,
      source: 'tool',
      level: 'error',
      message: 'SMOKE_BUG_MESSAGE_XYZ',
      stack: 'Error: SMOKE_BUG_MESSAGE_XYZ\n    at smoke (client.js:1:1)',
      pluginId: 'dsh-bug-reporter',
      sessionId: 'sess-smoke',
      context: { file: 'C:\\work\\dsh-bug-reporter\\index.js', tool: 'bash' },
      status: 'open',
      fix: {
        path: 'C:\\work\\dsh-bug-reporter\\lib\\fix.mjs',
        appliedAt: '2026-10-18T03:00:00.000Z',
        reloaded: true,
        rev: 7,
      },
      pr: {
        url: 'https://github.com/zuaonew-ops/dsh-bug-reporter/pull/123',
        number: 123,
        repo: 'zuaonew-ops/dsh-bug-reporter',
        branch: 'fix/smoke',
        at: '2026-10-18T03:10:00.000Z',
      },
    },
    {
      id: 'r2',
      fingerprint: 'fp-smoke-2',
      firstAt: '2026-10-18T04:00:00.000Z',
      lastAt: '2026-10-18T04:00:00.000Z',
      count: 1,
      source: 'process',
      level: 'warn',
      message: 'SMOKE_SECOND_BUG',
      stack: null,
      pluginId: '',
      sessionId: '',
      context: null,
      status: 'ignored',
      fix: null,
      pr: null,
    },
  ],
}

let mode = 'ok'
const seenRequests = []
/** task-19：记下 POST 的 body，用来断言总开关发的就是 `{enabled:...}`。 */
const seenBodies = []

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  seenRequests.push(`${req.method} ${url.pathname}`)
  const chunks = []
  req.on('data', (chunk) => {
    chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (raw !== '') seenBodies.push({ method: req.method, path: url.pathname, body: raw })
    const send = (code, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    const respond = () => {
      if (mode === 'fail') {
        send(500, { ok: false, error: { code: 'smoke-fail', message: 'SMOKE_FAIL_REASON' } })
        return
      }
      if (url.pathname === '/bug-reporter/state' && req.method === 'GET') {
        send(200, { ok: true, value: STATE })
        return
      }
      // 真宿主对 POST /state 是「合并后回整份 value」，这里照做，
      // 否则总开关点下去界面不会真的翻到「已关闭」（那是桩的假象，不是客户端的 bug）。
      if (url.pathname === '/bug-reporter/state' && req.method === 'POST') {
        try {
          Object.assign(STATE, JSON.parse(raw))
        } catch {
          /* 坏 body 就当没改 */
        }
        send(200, { ok: true, value: STATE })
        return
      }
      send(200, { ok: true, value: {} })
    }
    if (mode === 'slow') setTimeout(respond, 250)
    else respond()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
console.log(`fake host listening on ${origin}`)

const fetchStub = (input, init) =>
  fetch(String(input).startsWith('http') ? String(input) : origin + String(input), init)

/** 载入 client.js：桩掉 window.__ModuleLoader__ 与 require('react')。 */
function loadModule(harness) {
  let loaded = null
  const windowStub = { __ModuleLoader__: { load(mod) { loaded = mod } } }
  const navigatorStub = { language: 'zh-CN' }
  const requireStub = (name) => {
    if (name === 'react') return harness.React
    throw new Error(`unexpected require(${name})`)
  }
  const run = new Function(
    'window', 'require', 'navigator', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    `${src}\n//# sourceURL=dsh-bug-reporter-client.js`,
  )
  run(windowStub, requireStub, navigatorStub, fetchStub, AbortController, setTimeout, clearTimeout)
  return { loaded, requireStub }
}

// ─────────────────────────────────────────────────────────────
// 1) 静态检查
// ─────────────────────────────────────────────────────────────
console.log('\n--- 1) 静态检查 ---')
const lineCount = src.split('\n').length
const jsxCloser = (src.match(/<\//g) || []).length
const jsxSelfClose = (src.match(/\/>/g) || []).length
const endpoints = [...new Set(src.match(/\/bug-reporter\/[a-z/]+/g) || [])].sort()

console.log(`client.js 行数 = ${lineCount}`)
console.log(`'</' 出现次数 = ${jsxCloser}   '/>' 出现次数 = ${jsxSelfClose}`)
console.log(`源码里出现的端点 = ${endpoints.join(', ')}`)
console.log(`含 AbortController = ${/AbortController/.test(src)}`)

check('无 JSX（没有 </ 与 />）', jsxCloser === 0 && jsxSelfClose === 0)
check('有 AbortController 用法', /AbortController/.test(src))

// ─────────────────────────────────────────────────────────────
// 2) factory / apply 契约
// ─────────────────────────────────────────────────────────────
console.log('\n--- 2) factory / apply ---')
const harnessA = createHarness()
const { loaded, requireStub } = loadModule(harnessA)

check('loader.load 被调用一次', loaded !== null)
check("loader id === 'dsh-bug-reporter'", loaded && loaded.id === 'dsh-bug-reporter',
  `实际 = ${loaded && JSON.stringify(loaded.id)}`)
check('factory 是函数', loaded && typeof loaded.factory === 'function')

const api = loaded.factory(requireStub)
check('factory() 返回对象', api && typeof api === 'object')
check('api.inject 含 slots', Array.isArray(api.inject) && api.inject.includes('slots'),
  `实际 = ${JSON.stringify(api.inject)}`)
check('api.apply 是函数', typeof api.apply === 'function')

const injectCalls = []
const registrations = []
const ctxStub = {
  slots: {
    inject(name, callback) {
      injectCalls.push(name)
      const result = callback()
      registrations.push(result)
      return result
    },
    register(options, Component) {
      return { options, Component }
    },
  },
}
api.apply(ctxStub)

check("apply 调了一次 slots.inject('settings.section', ...)",
  injectCalls.length === 1 && injectCalls[0] === 'settings.section',
  `实际 inject 调用 = ${JSON.stringify(injectCalls)}`)
check('注册了恰好一个 section', registrations.length === 1)

const reg = registrations[0] || { options: {} }
check("注册 id === 'bug-reporter'", reg.options.id === 'bug-reporter',
  `实际 = ${JSON.stringify(reg.options.id)}`)
check('注册 order === 40', reg.options.order === 40, `实际 = ${JSON.stringify(reg.options.order)}`)
check("注册 name === 'settings.section'", reg.options.name === 'settings.section',
  `实际 = ${JSON.stringify(reg.options.name)}`)
const navLabel = typeof reg.options.label === 'function' ? reg.options.label() : undefined
check('label() 返回非空字符串', typeof navLabel === 'string' && navLabel.length > 0,
  `实际 = ${JSON.stringify(navLabel)}`)
check('注册的组件是函数', typeof reg.Component === 'function')

// ─────────────────────────────────────────────────────────────
// 3) 真的挂载：正常数据
// ─────────────────────────────────────────────────────────────
console.log('\n--- 3) 挂载渲染（宿主正常返回） ---')
mode = 'ok'
const harnessB = createHarness()
const modB = loadModule(harnessB)
const apiB = modB.loaded.factory(modB.requireStub)
const regB = (() => {
  let captured = null
  apiB.apply({ slots: { inject: (name, cb) => cb(), register: (o, C) => { captured = { o, C }; return captured } } })
  return captured
})()

const rootOk = await harnessB.mount(regB.C)
const view = collect(rootOk)
console.log(`渲染出的文本长度 = ${view.text.length}`)
console.log(`渲染出的链接 = ${JSON.stringify(view.anchors.map((a) => a.href))}`)
console.log(`渲染错误 = ${JSON.stringify(harnessB.renderErrors)}`)
console.log(`宿主收到的请求 = ${JSON.stringify(seenRequests)}`)

check('挂载无渲染错误', harnessB.renderErrors.length === 0)
check('GET /bug-reporter/state 被请求', seenRequests.includes('GET /bug-reporter/state'))
check('第一条报告 message 出现', view.text.includes('SMOKE_BUG_MESSAGE_XYZ'))
check('第二条报告 message 出现', view.text.includes('SMOKE_SECOND_BUG'))
check('归属插件出现', view.text.includes('dsh-bug-reporter'))
check('空 pluginId 显示「未定位」', view.text.includes('未定位'))
check('出现次数渲染', view.text.includes('出现 3 次'), `含「出现 3 次」= ${view.text.includes('出现 3 次')}`)
check('未处理条数渲染', view.text.includes('未处理 1 条'), `含「未处理 1 条」= ${view.text.includes('未处理 1 条')}`)
check('修复信息渲染（路径 + 热重载 + rev）',
  view.text.includes('已修复：C:\\work\\dsh-bug-reporter\\lib\\fix.mjs') &&
  view.text.includes('热重载=是') && view.text.includes('rev=7'))
check('PR 链接渲染', view.text.includes('PR #123'))
check('PR href 正确',
  view.anchors.some((a) => a.href === 'https://github.com/zuaonew-ops/dsh-bug-reporter/pull/123'),
  JSON.stringify(view.anchors.map((a) => a.href)))
check('tokenConfigured 绿态文案', view.text.includes('已配置凭据'))
check('storeFile 绝对路径渲染', view.text.includes('C:\\Users\\smoke\\.dsh\\bug-reports.jsonl'))
check('repo 输入框 value 正确',
  view.fields.some((f) => f.value === 'zuaonew-ops/dsh-bug-reporter'),
  JSON.stringify(view.fields.map((f) => f.value)))
check('tokenRef 输入框 value 正确',
  view.fields.some((f) => f.value === 'GITHUB_TOKEN'))
check('baseBranch 输入框 value 正确',
  view.fields.some((f) => f.value === 'main'))
const boxes = view.fields.filter((f) => f.type === 'checkbox')
// task-19：`enabled` 从「捕获」分组升格成顶部总开关，分组里只剩 3 个子开关。
check('捕获分组里恰好 3 个子开关复选框且都已勾选',
  boxes.length === 3 && boxes.every((b) => b.checked === true),
  `${boxes.length} 个, checked=${JSON.stringify(boxes.map((b) => b.checked))}`)
check('总开关卡片存在（标题「总开关」）', view.text.includes('总开关'))
check('总开关已开启时显示「已开启」', view.text.includes('已开启'))
check('总开关已开启时按钮是「关闭」', Boolean(findButton(rootOk, '关闭')))
check('总开关说明提到「不再记录」之外的正常态（正在记录）', view.text.includes('正在记录新的 bug 报告'))
check('说明里写清持久化（重启后仍生效）', view.text.includes('重启 DSH 后仍然生效'))
check('说明里没有「卸载」这种错话', !view.text.includes('卸载'))
check('子开关有「跟随总开关」说明', view.text.includes('跟随总开关'))
check('子开关在总开关开启时可用', boxes.every((b) => b.disabled !== true))
check('「恢复默认」按钮存在', Boolean(findButton(rootOk, '恢复默认')))
check('恢复默认说明写明不删报告', view.text.includes('不删除任何报告'))
check('状态行显示已保存', view.text.includes('已保存'))

// 3a) 点总开关「关闭」→ 发 POST {enabled:false}，界面翻到「已关闭」，子开关置灰
const masterOffButton = findButton(rootOk, '关闭')
if (masterOffButton) {
  seenBodies.length = 0
  masterOffButton.props.onClick()
  await harnessB.settle()
  const offBody = seenBodies.find((entry) => entry.method === 'POST' && entry.path === '/bug-reporter/state')
  check('点总开关发的是 POST /bug-reporter/state', Boolean(offBody),
    JSON.stringify(seenBodies))
  check('POST body 就是 {enabled:false}',
    Boolean(offBody) && offBody.body === JSON.stringify({ enabled: false }),
    offBody ? offBody.body : '(没有 POST)')
  const viewOff = collect(harnessB.getRoot())
  check('关掉后显示「已关闭」', viewOff.text.includes('已关闭'))
  check('关掉后按钮变「开启」', Boolean(findButton(harnessB.getRoot(), '开启')))
  check('关掉后说明写清「不再记录新的 bug 报告」', viewOff.text.includes('已停止记录新的 bug 报告'))
  check('关掉后说明写清设置页与已有报告仍可用', viewOff.text.includes('设置页与已有报告照常可用'))
  const boxesOff = viewOff.fields.filter((f) => f.type === 'checkbox')
  check('关掉后 3 个子开关全部置灰',
    boxesOff.length === 3 && boxesOff.every((b) => b.disabled === true),
    `${boxesOff.length} 个, disabled=${JSON.stringify(boxesOff.map((b) => b.disabled))}`)
  check('关掉后子开关的勾选值仍然保留（没被清成 false）',
    boxesOff.every((b) => b.checked === true),
    JSON.stringify(boxesOff.map((b) => b.checked)))

  // 3a-2) 再点「开启」→ 发 POST {enabled:true}
  const masterOnButton = findButton(harnessB.getRoot(), '开启')
  if (masterOnButton) {
    seenBodies.length = 0
    masterOnButton.props.onClick()
    await harnessB.settle()
    const onBody = seenBodies.find((entry) => entry.method === 'POST' && entry.path === '/bug-reporter/state')
    check('再点开启发的是 {enabled:true}',
      Boolean(onBody) && onBody.body === JSON.stringify({ enabled: true }),
      onBody ? onBody.body : '(没有 POST)')
    const viewOn = collect(harnessB.getRoot())
    check('开回来显示「已开启」', viewOn.text.includes('已开启'))
  } else {
    check('关掉后能找到「开启」按钮（用于开回来）', false)
  }
} else {
  check('能找到总开关的「关闭」按钮', false)
}

// 3b) 点「修复」→ 修复面板出现，路径从 report.fix.path 预填
const repairButton = findButton(rootOk, '修复')
check('找到「修复」按钮', Boolean(repairButton))
if (repairButton) {
  repairButton.props.onClick()
  await harnessB.settle()
  const viewRepair = collect(harnessB.getRoot())
  const hasPath = viewRepair.fields.some(
    (f) => f.tag === 'input' && f.value === 'C:\\work\\dsh-bug-reporter\\lib\\fix.mjs')
  const hasTextarea = viewRepair.fields.some((f) => f.tag === 'textarea')
  console.log(`修复面板字段 = ${JSON.stringify(viewRepair.fields.map((f) => [f.tag, f.value]))}`)
  check('修复面板出现：路径预填 + 内容 textarea', hasPath && hasTextarea)
  check('修复面板渲染后无错误', harnessB.renderErrors.length === 0)
}

// ─────────────────────────────────────────────────────────────
// 4) 失败路径：宿主 {ok:false} → 状态行显示原因，不白屏
// ─────────────────────────────────────────────────────────────
console.log('\n--- 4) 失败路径：宿主返回 ok:false ---')
mode = 'fail'
const harnessC = createHarness()
const modC = loadModule(harnessC)
const apiC = modC.loaded.factory(modC.requireStub)
let regC = null
apiC.apply({ slots: { inject: (name, cb) => cb(), register: (o, C) => { regC = { o, C }; return regC } } })
const rootFail = await harnessC.mount(regC.C)
const viewFail = collect(rootFail)
console.log(`失败态文本 = ${JSON.stringify(viewFail.text)}`)
console.log(`渲染错误 = ${JSON.stringify(harnessC.renderErrors)}`)

check('失败时无渲染错误（不白屏）', harnessC.renderErrors.length === 0)
check('状态行显示宿主给的失败原因', viewFail.text.includes('SMOKE_FAIL_REASON'))
check('失败态仍有重试按钮', viewFail.text.includes('重试'))

// ─────────────────────────────────────────────────────────────
// 5) 卸载防护：请求未回来就卸载，之后不再 setState
// ─────────────────────────────────────────────────────────────
console.log('\n--- 5) 卸载防护（慢响应 + 提前卸载） ---')
mode = 'slow'
const harnessD = createHarness()
const modD = loadModule(harnessD)
const apiD = modD.loaded.factory(modD.requireStub)
let regD = null
apiD.apply({ slots: { inject: (name, cb) => cb(), register: (o, C) => { regD = { o, C }; return regD } } })
await harnessD.mount(regD.C, { quietMs: 40 })
harnessD.unmount()
const before = harnessD.lateSetState()
await sleep(500)
const after = harnessD.lateSetState()
console.log(`卸载后 setState 次数 = ${after}（卸载瞬间 = ${before}）`)
console.log(`渲染错误 = ${JSON.stringify(harnessD.renderErrors)}`)

check('卸载后没有 setState', after === 0)
check('卸载过程无错误', harnessD.renderErrors.length === 0)

// ─────────────────────────────────────────────────────────────
server.close()
console.log(`\n结果：${failures === 0 ? 'ALL PASS' : `${failures} 项 FAIL`}`)
process.exitCode = failures === 0 ? 0 : 1
