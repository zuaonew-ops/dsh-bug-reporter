/**
 * verify-bug-http.mjs —— 独立验证：把 dsh-bug-reporter 的 HTTP 处理器挂到**真 socket** 上，
 * 用真 fetch + 真 curl 攻击它。作者的自测用的是假 req/res，从不经过真实 HTTP 层。
 *
 * 随仓库分发在 test/ 下（插件源码按 import.meta.url 解析）；不修改任何插件源文件；
 */
import { createServer } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'

const T = join(tmpdir(), `_verify-bug-http-${process.pid}`)
const STORE = join(T, 'store', 'reports.jsonl')
const PKG_A = join(T, 'pkg-a')          // 「本插件的包」
const PKG_B = join(T, 'pkg-b')          // 「另一个插件的包」
const ESCAPE = join(T, 'escape-target') // 包外目录（junction 的目标）
const LINK = join(PKG_A, 'esc')         // 包内的 junction

mkdirSync(join(T, 'store'), { recursive: true })
mkdirSync(PKG_A, { recursive: true })
mkdirSync(PKG_B, { recursive: true })
mkdirSync(ESCAPE, { recursive: true })
writeFileSync(join(PKG_A, 'package.json'), JSON.stringify({ name: 'verify-pkg-a', version: '1.0.0', dsh: { client: { platform: 'web' } } }))
writeFileSync(join(PKG_B, 'package.json'), JSON.stringify({ name: 'verify-pkg-b', version: '1.0.0' }))
writeFileSync(join(PKG_A, 'a.txt'), 'original-a\n')

const results = []
function rec(id, detail, verdict, evidence) {
  results.push({ id, detail, verdict, evidence })
  const mark = verdict === 'PASS' ? 'PASS' : verdict === 'INFO' ? 'INFO' : '**FAIL**'
  console.log(`${mark}  ${id}`)
  if (detail) console.log(`        ${detail}`)
  if (evidence !== undefined) console.log(`        ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`)
}

// ---------------------------------------------------------------------------
// 假 ctx（照 cordis 语义：inject 缺名字就不跑回调）
// ---------------------------------------------------------------------------
function makeCtx(services = {}) {
  const listeners = new Map()
  const disposers = []
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
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
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    inject(names, cb) {
      for (const n of names) if (services[n] === undefined) return
      const scoped = Object.create(ctx)
      for (const n of names) scoped[n] = services[n]
      cb(scoped)
    },
    dispose() {
      while (disposers.length) { try { disposers.pop()() } catch {} }
    },
  }
  return ctx
}

// 真实 webServer：把 handler 记下来
let HANDLER = null
const webServer = {
  register(route) {
    if (route.path === '/bug-reporter') HANDLER = route.handler
    return () => { HANDLER = null }
  },
}

const ctx = makeCtx({ webServer })
apply(ctx, { storePath: STORE, captureProcess: false })

if (HANDLER === null) {
  console.error('FATAL: 插件没有注册 /bug-reporter 路由')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 真 socket
// ---------------------------------------------------------------------------
const server = createServer((req, res) => { HANDLER(req, res) })
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
console.log(`\n真实 HTTP 监听：${BASE}\n`)

async function raw(method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) init.body = body
  try {
    const res = await fetch(`${BASE}${path}`, init)
    const text = await res.text()
    return { status: res.status, text, headers: Object.fromEntries(res.headers) }
  } catch (error) {
    // 连接被对端 destroy → undici 抛 SocketError，没有任何响应
    return {
      status: `SOCKET-CLOSED(${error?.cause?.code ?? error?.code ?? 'ERR'})`,
      text: `<no HTTP response: ${error?.cause?.message ?? error.message}>`,
      headers: {},
    }
  }
}

const CURL = 'C:\\Windows\\System32\\curl.exe'
/** 必须异步：execFileSync 会阻塞事件循环，本进程内的 HTTP 服务就永远答不上 curl。 */
function curl(args) {
  return new Promise((done) => {
    execFile(CURL, args, { encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => {
      if (error) {
        done(`CURL-ERROR code=${error.code} killed=${error.killed} stdout=${String(stdout || '')} stderr=${String(stderr || '')}`)
      } else {
        done(String(stdout))
      }
    })
  })
}

// ===========================================================================
console.log('=== A. 认证 / Origin / CSRF ===')
// ===========================================================================

// A1: 完全裸请求，无任何认证头
{
  const out = await curl(['-s', '-i', `${BASE}/bug-reporter/state`])
  const firstLine = out.split('\n')[0].trim()
  const hasState = out.includes('"reports"')
  rec('A1 裸 curl 读 /state（无 Cookie / 无 Token / 无自定义头）',
    `curl -s -i ${BASE}/bug-reporter/state`,
    firstLine.includes('200') && hasState ? '**FAIL**(无认证即可读) ' : 'PASS',
    `status="${firstLine}" 含reports=${hasState} 前120字=${JSON.stringify(out.slice(0, 120))}`)
}

// A2: 恶意 Origin + text/plain（CORS 简单请求，浏览器不预检）
{
  const body = JSON.stringify({ message: 'CSRF-PROBE-A2', source: 'manual' })
  const out = await curl(['-s', '-i', '-X', 'POST', `${BASE}/bug-reporter/report`,
    '-H', 'Origin: https://evil.example', '-H', 'Referer: https://evil.example/x',
    '-H', 'content-type: text/plain', '--data-binary', body])
  const firstLine = out.split('\n')[0].trim()
  const created = out.includes('CSRF-PROBE-A2')
  rec('A2 恶意 Origin + text/plain POST /report（CORS 简单请求）',
    '无预检即可送达；处理器不校验 content-type / Origin / Referer',
    created ? '**FAIL**(跨站可写报告)' : 'PASS',
    `status="${firstLine}" 写入成功=${created}`)
}

// A3: 跨站清空全部报告（不需要 id）
{
  const before = (await raw('GET', '/bug-reporter/state')).text
  const nBefore = JSON.parse(before).value.reports.length
  const out = await curl(['-s', '-i', '-X', 'POST', `${BASE}/bug-reporter/report/clear`,
    '-H', 'Origin: https://evil.example', '-H', 'content-type: text/plain', '--data-binary', '{}'])
  const firstLine = out.split('\n')[0].trim()
  const nAfter = JSON.parse((await raw('GET', '/bug-reporter/state')).text).value.reports.length
  rec('A3 恶意 Origin + text/plain POST /report/clear（跨站数据销毁，无需 id）',
    `报告数 ${nBefore} → ${nAfter}`,
    nBefore > 0 && nAfter === 0 ? '**FAIL**(跨站可清空)' : 'PASS',
    `status="${firstLine}" cleared=${out.includes('"cleared"')}`)
}

// A4: 跨站改设置（repo 指向攻击者仓库）
{
  const out = await curl(['-s', '-i', '-X', 'POST', `${BASE}/bug-reporter/state`,
    '-H', 'Origin: https://evil.example', '-H', 'content-type: text/plain',
    '--data-binary', JSON.stringify({ repo: 'attacker/evil-repo', baseBranch: 'pwn' })])
  const firstLine = out.split('\n')[0].trim()
  const state = JSON.parse((await raw('GET', '/bug-reporter/state')).text).value
  rec('A4 恶意 Origin + text/plain POST /state（跨站改 repo/baseBranch，无需 id）',
    `repo=${state.repo} baseBranch=${state.baseBranch}`,
    state.repo === 'attacker/evil-repo' ? '**FAIL**(跨站可改设置)' : 'PASS',
    `status="${firstLine}"`)
}

// A5: 有没有任何 Host / Origin / Referer 校验？
{
  const noOrigin = await curl(['-s', '-o', 'NUL', '-w', '%{http_code}', '-X', 'POST', `${BASE}/bug-reporter/report`,
    '-H', 'content-type: application/json', '--data-binary', JSON.stringify({ message: 'A5-no-origin' })])
  const badHost = await curl(['-s', '-o', 'NUL', '-w', '%{http_code}', '-X', 'POST', `${BASE}/bug-reporter/report`,
    '-H', 'Host: evil.example', '-H', 'content-type: application/json', '--data-binary', JSON.stringify({ message: 'A5-bad-host' })])
  const secFetch = await curl(['-s', '-o', 'NUL', '-w', '%{http_code}', '-X', 'POST', `${BASE}/bug-reporter/report`,
    '-H', 'Sec-Fetch-Site: cross-site', '-H', 'content-type: application/json', '--data-binary', JSON.stringify({ message: 'A5-cross-site' })])
  rec('A5 无 Origin / 伪造 Host / Sec-Fetch-Site: cross-site 是否被拦',
    '三者全部被接受 = 无任何来源校验',
    (noOrigin === '200' && badHost === '200' && secFetch === '200') ? '**FAIL**(无来源校验)' : 'PASS',
    `no-Origin=${noOrigin} bad-Host=${badHost} cross-site=${secFetch}`)
}

// ===========================================================================
console.log('\n=== B. /repair 路径围栏残余范围 ===')
// ===========================================================================

async function newReport(message) {
  const r = await raw('POST', '/bug-reporter/report', {
    body: JSON.stringify({ message, source: 'manual' }),
    headers: { 'content-type': 'application/json' },
  })
  return JSON.parse(r.text).value.report.id
}

const rid = await newReport('VERIFY-FENCE-PROBE')

async function repair(path, content) {
  const r = await raw('POST', '/bug-reporter/repair', {
    body: JSON.stringify({ id: rid, path, content }),
    headers: { 'content-type': 'application/json' },
  })
  let json = null
  try { json = JSON.parse(r.text) } catch {}
  return { status: r.status, code: json?.error?.code, text: r.text }
}

// B1: C:\Windows 下（无 package.json 祖先）
{
  const target = 'C:\\Windows\\Temp\\_verify-fence-probe.txt'
  const out = await repair(target, 'SHOULD-NOT-EXIST')
  const wrote = existsSync(target)
  if (wrote) rmSync(target, { force: true })
  rec('B1 /repair → C:\\Windows\\Temp\\…（包目录外）',
    `path=${target}`,
    out.status === 403 && out.code === 'path-not-allowed' && !wrote ? 'PASS' : '**FAIL**',
    `status=${out.status} code=${out.code} 文件被创建=${wrote}`)
}

// B2: ..\..\ 穿越 —— 从 pkg-a 穿到 pkg-b
{
  const traversal = join(PKG_A, '..', 'pkg-b', 'traversed.txt')
  const out = await repair(traversal, 'TRAVERSED-OK')
  const landed = join(PKG_B, 'traversed.txt')
  const wrote = existsSync(landed)
  const content = wrote ? readFileSync(landed, 'utf8') : ''
  rec('B2 /repair 用 ..\\..\\ 穿越出本包，落进**另一个包**',
    `path=${traversal} → 实际落到 ${landed}`,
    out.status === 200 && wrote ? '**FAIL**(穿越未被拦，围栏只管"有没有 package.json")' : 'PASS',
    `status=${out.status} code=${out.code} 落盘=${wrote} 内容=${JSON.stringify(content)}`)
  if (wrote) rmSync(landed, { force: true })
}

// B3: 直接指向另一个包的源码文件（跨包覆写）
{
  const target = join(PKG_B, 'a.txt')
  writeFileSync(target, 'original-b\n')
  const out = await repair(target, 'OVERWRITTEN-BY-OTHER-PACKAGE')
  const content = readFileSync(target, 'utf8')
  rec('B3 /repair 覆写**另一个包**的文件（不属于任何报告的归属包）',
    `path=${target}`,
    out.status === 200 && content.includes('OVERWRITTEN') ? '**FAIL**(跨包任意文件覆写被放行)' : 'PASS',
    `status=${out.status} 覆写后内容=${JSON.stringify(content)}`)
}

// B4: 连 package.json 本身也能被覆写（无扩展名白名单）
{
  const target = join(PKG_B, 'package.json')
  const before = readFileSync(target, 'utf8')
  const out = await repair(target, JSON.stringify({ name: 'verify-pkg-b', version: '9.9.9', dsh: { client: { platform: 'web' } } }))
  const after = readFileSync(target, 'utf8')
  rec('B4 /repair 覆写 package.json（无扩展名白名单，能改 manifest）',
    `path=${target}`,
    out.status === 200 && after !== before ? '**FAIL**(manifest 可被改写)' : 'PASS',
    `status=${out.status} version 现在=${JSON.parse(after).version}`)
  writeFileSync(target, before)
}

// B5: junction（目录符号链接）绕过 —— 词法路径在包内，物理落点在包外
{
  let made = false
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', LINK, ESCAPE], { encoding: 'utf8', timeout: 15000 })
    made = existsSync(LINK)
  } catch (error) {
    made = false
  }
  if (!made) {
    rec('B5 junction 绕过（词法在包内、物理在包外）', '本机无法创建 junction，跳过', 'INFO', '')
  } else {
    const target = join(LINK, 'escaped.txt')
    const out = await repair(target, 'ESCAPED-VIA-JUNCTION')
    const physical = join(ESCAPE, 'escaped.txt')
    const wrote = existsSync(physical)
    rec('B5 junction 绕过：path 词法在 pkg-a 内，实际写到包外 escape-target',
      `path=${target} → 物理落点 ${physical}`,
      out.status === 200 && wrote ? '**FAIL**(围栏是词法的，junction 直接绕过)' : 'PASS',
      `status=${out.status} 包外落盘=${wrote} 内容=${wrote ? JSON.stringify(readFileSync(physical, 'utf8')) : '—'}`)
    if (wrote) rmSync(physical, { force: true })
  }
}

// B6: UNC 路径
{
  const target = '\\\\localhost\\C$\\Windows\\Temp\\_verify-unc-probe.txt'
  const out = await repair(target, 'UNC')
  const wrote = existsSync(target)
  if (wrote) rmSync(target, { force: true })
  rec('B6 /repair → UNC 路径 \\\\localhost\\C$\\…',
    `path=${target}`,
    out.status === 403 ? 'PASS' : 'INFO',
    `status=${out.status} code=${out.code} 落盘=${wrote}`)
}

// B7: 8.3 短名
{
  const out = await repair('C:\\PROGRA~1\\_verify-83.txt', 'SHORT')
  rec('B7 /repair → 8.3 短名 C:\\PROGRA~1\\…',
    '探测短名是否绕过围栏',
    out.status === 403 ? 'PASS' : 'INFO',
    `status=${out.status} code=${out.code}`)
}

// B8: 包内正常写入（对照：确认围栏不是"一律拒绝"）
{
  const target = join(PKG_A, 'a.txt')
  const out = await repair(target, 'legit-fix')
  const content = readFileSync(target, 'utf8')
  rec('B8 对照组：/repair 写自己包内文件应当成功',
    `path=${target}`,
    out.status === 200 && content === 'legit-fix' ? 'PASS' : '**FAIL**',
    `status=${out.status} 内容=${JSON.stringify(content)} reloaded=${out.text.includes('"reloaded":true')}`)
}

// ===========================================================================
console.log('\n=== C. 对抗性输入（真 HTTP） ===')
// ===========================================================================

// C1: message 空串 / 非字符串
{
  const empty = await raw('POST', '/bug-reporter/report', { body: JSON.stringify({ message: '' }), headers: { 'content-type': 'application/json' } })
  const num = await raw('POST', '/bug-reporter/report', { body: JSON.stringify({ message: 12345 }), headers: { 'content-type': 'application/json' } })
  const nul = await raw('POST', '/bug-reporter/report', { body: JSON.stringify({ message: null }), headers: { 'content-type': 'application/json' } })
  rec('C1 /report 的 message 空串 / 数字 / null',
    '都应当 400 invalid-report',
    empty.status === 400 && num.status === 400 && nul.status === 400 ? 'PASS' : '**FAIL**',
    `empty=${empty.status} number=${num.status} null=${nul.status}`)
}

// C2: message 超长（>1MiB 上限）—— 关键：413 到底有没有送达客户端？
{
  const big = 'x'.repeat(1024 * 1024 + 100)
  const out = await raw('POST', '/bug-reporter/report', { body: JSON.stringify({ message: big }), headers: { 'content-type': 'application/json' } })
  const got413 = out.status === 413 && out.text.includes('body-too-large')
  rec('C2 /report message 超过 1 MiB（真 socket）',
    'readBody 超限后调 req.destroy()，413 响应是否还能送达？',
    got413 ? 'PASS' : '**FAIL**(客户端拿不到 413，只有连接被重置)',
    `实际 status=${out.status} body=${out.text.slice(0, 120)}`)
}

// C3: 刚好 1 MiB 边界内
{
  const just = 'y'.repeat(1024 * 1024 - 200)
  const out = await raw('POST', '/bug-reporter/report', { body: JSON.stringify({ message: just }), headers: { 'content-type': 'application/json' } })
  const ok = out.status === 200
  if (ok) {
    // 清掉这条巨型报告，免得撑爆后续
    await raw('POST', '/bug-reporter/report/clear', { body: '{}', headers: { 'content-type': 'application/json' } })
  }
  rec('C3 /report message 接近但小于 1 MiB', '期望 200 接受（并已清空）',
    ok ? 'PASS' : 'INFO', `status=${out.status}`)
}

// C4: 分块传输（无 content-length）
{
  const res = await fetch(`${BASE}/bug-reporter/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'CHUNKED-BODY-PROBE' }))); c.close() },
    }),
    duplex: 'half',
  })
  const text = await res.text()
  rec('C4 chunked 传输（无 Content-Length）', '真实分块 body 是否被正确读取',
    res.status === 200 && text.includes('CHUNKED-BODY-PROBE') ? 'PASS' : '**FAIL**',
    `status=${res.status}`)
}

// C5: 非 UTF-8 body（GBK 字节）
{
  const gbk = Buffer.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x22, 0xd6, 0xd0, 0xce, 0xc4, 0x22, 0x7d]) // {"message":"中文"} in GBK
  const out = await fetch(`${BASE}/bug-reporter/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: gbk })
  const text = await out.text()
  rec('C5 非 UTF-8（GBK）body', 'UTF-8 强解会把 GBK 字节变成替换字符',
    out.status === 200 ? 'INFO' : 'INFO',
    `status=${out.status} 存下的 message=${JSON.stringify(JSON.parse(text)?.value?.report?.message)}`)
}

// C6: /submit 的 repo = ../../etc（必须不发真请求）
{
  await raw('POST', '/bug-reporter/state', { body: JSON.stringify({ repo: '../../etc' }), headers: { 'content-type': 'application/json' } })
  const freshId = await newReport('VERIFY-SUBMIT-PROBE') // C3 的 clear 已经把 rid 删了
  const out = await raw('POST', '/bug-reporter/submit', { body: JSON.stringify({ id: freshId }), headers: { 'content-type': 'application/json' } })
  rec('C6 /submit repo="../../etc"', '无 token 时应 401 no-token（证明没有真打 GitHub）',
    out.status === 401 && out.text.includes('no-token') ? 'PASS' : 'INFO',
    `status=${out.status} body=${out.text.slice(0, 160)}`)
}

// C7: /repair 的 content 超大
{
  const big = 'z'.repeat(1024 * 1024 + 100)
  const out = await raw('POST', '/bug-reporter/repair', { body: JSON.stringify({ id: rid, path: join(PKG_A, 'a.txt'), content: big }), headers: { 'content-type': 'application/json' } })
  rec('C7 /repair content 超过 1 MiB（真 socket）', '期望 413；实测看响应是否送达',
    out.status === 413 ? 'PASS' : '**FAIL**(同 C2：只有连接重置)',
    `实际 status=${out.status} body=${out.text.slice(0, 120)}`)
}

// C8: 未知路径 / 方法
{
  const unknown = await raw('GET', '/bug-reporter/nope')
  const method = await raw('GET', '/bug-reporter/repair')
  const options = await raw('OPTIONS', '/bug-reporter/repair')
  rec('C8 未知路径 / 方法 / OPTIONS 预检',
    'OPTIONS 若 405 且无 CORS 头，则跨站只能走"简单请求"',
    unknown.status === 404 && method.status === 405 ? 'PASS' : '**FAIL**',
    `unknown=${unknown.status} GET-repair=${method.status} OPTIONS=${options.status} ACAO=${JSON.stringify(options.headers['access-control-allow-origin'] ?? null)}`)
}

// ===========================================================================
console.log('\n=== D. 状态与副作用 ===')
// ===========================================================================

// D1: 围栏是否校验"目标属于报告归属的插件"？—— 看它是否读报告里的 fix 路径
{
  const state = JSON.parse((await raw('GET', '/bug-reporter/state')).text).value
  const report = state.reports.find((r) => r.id === rid)
  rec('D1 报告里是否记录"允许被修的文件路径"白名单',
    'handleRepair 只校验 package.json 祖先，不比对报告内容',
    report && report.fix && report.fix.path ? 'INFO' : 'INFO',
    `报告 fix.path=${report?.fix?.path ?? 'null'}（来自请求体，不是白名单）`)
}

// D2: 关掉 repairEnabled 之后（对照：证明开关有效）
{
  await raw('POST', '/bug-reporter/state', { body: JSON.stringify({ repairEnabled: false }), headers: { 'content-type': 'application/json' } })
  const off = await repair(join(PKG_A, 'a.txt'), 'should-be-blocked')
  await raw('POST', '/bug-reporter/state', { body: JSON.stringify({ repairEnabled: true }), headers: { 'content-type': 'application/json' } })
  rec('D2 repairEnabled=false 时 /repair 被拒（403 repair-disabled）',
    '证明开关本身有效（但默认是 true）',
    off.status === 403 && off.code === 'repair-disabled' ? 'PASS' : '**FAIL**',
    `status=${off.status} code=${off.code}`)
}

// ===========================================================================
console.log('\n=== E. 汇总 ===')
const fails = results.filter((r) => r.verdict.startsWith('**FAIL**'))
const infos = results.filter((r) => r.verdict === 'INFO')
console.log(`\n共 ${results.length} 项：PASS ${results.length - fails.length - infos.length} / FAIL ${fails.length} / INFO ${infos.length}`)
for (const f of fails) console.log(`  FAIL  ${f.id}`)

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------
ctx.dispose()
await new Promise((ok) => server.close(ok))
try { rmSync(T, { recursive: true, force: true }) } catch {}
console.log(`\n临时目录已清理：${T} → 还存在=${existsSync(T)}`)
process.exit(0)
