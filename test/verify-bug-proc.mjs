/**
 * verify-bug-proc.mjs —— 独立复现 process 级捕获（真子进程，不用假 req/res）。
 *
 * 作者 test/bug-check.mjs 也用了真子进程，但只断言 `status !== 0`。
 * 这里把**实际退出码**、监听器顺序、以及"抛回原始值"对其它监听器的影响都测出来。
 *
 * 用法：在仓库根跑 `node test/verify-bug-proc.mjs`      → 父进程跑全部用例
 *       VERIFY_PROC_CHILD=<mode> node ...   → 子进程模式
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)
const T = join(tmpdir(), `_verify-bug-proc-${process.pid}`)

// ---------------------------------------------------------------------------
// 子进程模式
// ---------------------------------------------------------------------------
const MODE = process.env.VERIFY_PROC_CHILD
if (MODE === 'control') {
  // 对照：不用插件，纯粹三个监听器（第二个抛回）—— 看 Node 自己的语义
  const store = process.env.VERIFY_PROC_STORE
  process.on('uncaughtException', () => { writeFileSync(`${store}.A-ran`, 'A-RAN') })
  process.on('uncaughtException', () => { writeFileSync(`${store}.T-ran`, 'T-RAN'); throw new Error('VERIFY-CONTROL-XYZ') })
  process.on('uncaughtException', () => { writeFileSync(`${store}.B-ran`, 'B-RAN') })
  setTimeout(() => { throw new Error('VERIFY-CONTROL-ORIG') }, 0)
  setTimeout(() => { process.exit(0) }, 5000)
} else if (MODE === 'control2' || MODE === 'control3') {
  // 对照 2/3：完全复刻插件 index.js:1560-1563 的做法 —— 摘掉自己 + setImmediate 里抛回
  // control2 = 后面还有别的 uncaughtException 监听器；control3 = 没有别的监听器
  const store = process.env.VERIFY_PROC_STORE
  process.on('uncaughtException', () => { writeFileSync(`${store}.A-ran`, 'A-RAN') })
  const selfRemoving = (error) => {
    writeFileSync(`${store}.T-ran`, 'T-RAN')
    process.removeListener('uncaughtException', selfRemoving)
    setImmediate(() => { throw error })
  }
  process.on('uncaughtException', selfRemoving)
  if (MODE === 'control2') {
    process.on('uncaughtException', () => { writeFileSync(`${store}.B-ran`, 'B-RAN') })
  }
  setTimeout(() => { throw new Error('VERIFY-SELFREMOVE-ORIG') }, 0)
  setTimeout(() => { process.exit(0) }, 5000)
} else if (MODE) {
  const { apply } = await import('../index.js')
  const store = process.env.VERIFY_PROC_STORE
  const side = process.env.VERIFY_PROC_SIDE

  const services = {}
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    on: () => () => {},
    effect: (fn) => { const d = fn(); return d },
    inject: (names, cb) => { for (const n of names) if (services[n] === undefined) return; cb(Object.assign(Object.create(ctx), services)) },
  }

  // 先挂一个"别的插件"的监听器，再看插件的"记录后抛回"会不会把它顶掉
  if (side === 'order') {
    process.on('uncaughtException', () => { writeFileSync(`${store}.A-ran`, 'A-RAN') })
  }
  apply(ctx, { storePath: store, captureProcess: MODE !== 'off' })
  if (side === 'order') {
    process.on('uncaughtException', () => { writeFileSync(`${store}.B-ran`, 'B-RAN') })
  }

  if (MODE === 'uncaught' || MODE === 'off') {
    setTimeout(() => { throw new Error('VERIFY-UNCAUGHT-XYZ') }, 0)
  } else if (MODE === 'rejection') {
    setTimeout(() => { Promise.reject(new Error('VERIFY-REJECTION-XYZ')) }, 0)
  } else if (MODE === 'order') {
    setTimeout(() => { throw new Error('VERIFY-ORDER-XYZ') }, 0)
  }
  // 保持进程活着等定时器
  setTimeout(() => { process.exit(0) }, 5000)
} else {
  // -------------------------------------------------------------------------
  // 父进程
  // -------------------------------------------------------------------------
  mkdirSync(T, { recursive: true })
  const results = []
  function rec(id, detail, verdict, evidence) {
    results.push({ id, detail, verdict, evidence })
    const mark = verdict === 'PASS' ? 'PASS' : verdict === 'INFO' ? 'INFO' : '**FAIL**'
    console.log(`${mark}  ${id}`)
    if (detail) console.log(`        ${detail}`)
    if (evidence !== undefined) console.log(`        ${evidence}`)
  }

  function child(mode, extra = {}) {
    const store = join(T, `${mode}-${Math.random().toString(36).slice(2, 8)}.jsonl`)
    const out = spawnSync(process.execPath, [SELF], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: HERE,
      env: { ...process.env, VERIFY_PROC_CHILD: mode, VERIFY_PROC_STORE: store, ...extra },
    })
    let reports = []
    if (existsSync(store)) {
      reports = readFileSync(store, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    }
    return { store, out, reports }
  }

  console.log('=== process 级捕获：真子进程 ===\n')

  // 1. uncaughtException
  {
    const { out, reports } = child('uncaught')
    const stderr = String(out.stderr)
    const ok = out.status !== 0 && stderr.includes('VERIFY-UNCAUGHT-XYZ') && reports.length === 1 &&
      reports[0].source === 'process' && reports[0].message === 'VERIFY-UNCAUGHT-XYZ' &&
      reports[0].context?.kind === 'uncaughtException'
    rec('P1 uncaughtException：退出码 / stderr / 存储',
      '作者断言 status!==0；这里记录**实际退出码**',
      ok ? 'PASS' : '**FAIL**',
      `实际退出码=${out.status}（signal=${out.signal}）stderr 含原始错误=${stderr.includes('VERIFY-UNCAUGHT-XYZ')} 存储条数=${reports.length} source=${reports[0]?.source} context.kind=${reports[0]?.context?.kind}`)
    console.log(`        stderr 首行=${JSON.stringify(stderr.split('\n')[0])}`)
    console.log(`        stderr 前 6 行=${JSON.stringify(stderr.split('\n').slice(0, 6))}`)
    console.log(`        stderr 是否含 "There was an error while processing"=${stderr.includes('error while processing')}`)
    console.log(`        stderr 是否含原始抛出点(verify-bug-proc.mjs)=${stderr.includes('verify-bug-proc.mjs')}`)
  }

  // 2. unhandledRejection
  {
    const { out, reports } = child('rejection')
    const stderr = String(out.stderr)
    const r = reports.find((x) => x.context?.kind === 'unhandledRejection')
    const ok = out.status !== 0 && stderr.includes('VERIFY-REJECTION-XYZ') && r !== undefined && r.source === 'process'
    rec('P2 unhandledRejection：退出码 / stderr / 存储',
      'Node 默认对 unhandledRejection 是 throw → 非 0 退出',
      ok ? 'PASS' : '**FAIL**',
      `实际退出码=${out.status} stderr 含原始 reason=${stderr.includes('VERIFY-REJECTION-XYZ')} 存储条数=${reports.length} 找到 unhandledRejection 记录=${r !== undefined}`)
  }

  // 3. captureProcess: false
  {
    const { out, reports } = child('off')
    const stderr = String(out.stderr)
    const ok = out.status !== 0 && stderr.includes('VERIFY-UNCAUGHT-XYZ') && reports.length === 0
    rec('P3 captureProcess=false：不记录、但仍非 0 退出并打印原始错误',
      '关掉之后必须完全不影响 Node 默认行为',
      ok ? 'PASS' : '**FAIL**',
      `实际退出码=${out.status} stderr 含原始错误=${stderr.includes('VERIFY-UNCAUGHT-XYZ')} 存储条数=${reports.length}（期望 0）`)
  }

  // 4. 「记录后抛回」对其它 uncaughtException 监听器的影响
  {
    const { store, out } = child('order', { VERIFY_PROC_SIDE: 'order' })
    const stderr = String(out.stderr)
    const aRan = existsSync(`${store}.A-ran`)
    const bRan = existsSync(`${store}.B-ran`)
    rec('P4 插件把原始错误"抛回"是否顶掉后面注册的 uncaughtException 监听器',
      'A 在插件之前注册、B 在插件之后注册；触发顺序应为 A → 插件 → B',
      aRan && bRan ? 'PASS' : '**FAIL**',
      `A(插件前)=${aRan ? '跑了' : '没跑'} B(插件后)=${bRan ? '跑了' : '没跑'} 退出码=${out.status} stderr 含原始错误=${stderr.includes('VERIFY-ORDER-XYZ')} stderr 长度=${stderr.length}`)
    console.log(`        ⚠ 退出码=${out.status}（有别的 uncaughtException 监听器时，抛回并没有让进程死掉）`)
  }

  // 5. 对照：不用插件，纯 Node 三监听器（第二个直接抛回）
  {
    const { store, out } = child('control')
    const stderr = String(out.stderr)
    rec('P5 对照组 A（无插件）：监听器里直接 throw',
      '用来判定 P4 的退出码 0 是 Node 语义还是插件引入的',
      'INFO',
      `A=${existsSync(`${store}.A-ran`)} T=${existsSync(`${store}.T-ran`)} B=${existsSync(`${store}.B-ran`)} 退出码=${out.status} stderr 含 VERIFY-CONTROL-XYZ=${stderr.includes('VERIFY-CONTROL-XYZ')} stderr 长度=${stderr.length}`)
  }

  // 6/7. 对照：复刻插件做法（摘掉自己 + setImmediate 抛回）
  {
    const withOther = child('control2')
    const noOther = child('control3')
    const s2 = String(withOther.out.stderr)
    const s3 = String(noOther.out.stderr)
    rec('P6 对照组 B（无插件，复刻插件做法）：摘掉自己 + setImmediate 抛回，**后面还有别的监听器**',
      '这就是 P4 退出码 0 的根因：抛回被"另一个监听器"接住，Node 默认致命路径不再触发',
      'INFO',
      `A=${existsSync(`${withOther.store}.A-ran`)} T=${existsSync(`${withOther.store}.T-ran`)} B=${existsSync(`${withOther.store}.B-ran`)} 退出码=${withOther.out.status} stderr 长度=${s2.length} stderr 含原始错误=${s2.includes('VERIFY-SELFREMOVE-ORIG')}`)
    rec('P7 对照组 C（无插件，复刻插件做法）：**没有别的监听器**',
      '此时才回到 Node 默认路径：打印 + 非 0 退出（与插件 P1 一致）',
      'INFO',
      `A=${existsSync(`${noOther.store}.A-ran`)} T=${existsSync(`${noOther.store}.T-ran`)} 退出码=${noOther.out.status} stderr 含原始错误=${s3.includes('VERIFY-SELFREMOVE-ORIG')} stderr 长度=${s3.length}`)
  }

  const fails = results.filter((r) => r.verdict.startsWith('**FAIL**'))
  console.log(`\n共 ${results.length} 项：PASS ${results.filter((r) => r.verdict === 'PASS').length} / FAIL ${fails.length} / INFO ${results.filter((r) => r.verdict === 'INFO').length}`)
  for (const f of fails) console.log(`  FAIL  ${f.id}`)
  rmSync(T, { recursive: true, force: true })
  console.log(`\n临时目录已清理：${T} → 还存在=${existsSync(T)}`)
}
