/**
 * dsh-bug-reporter — 浏览器半区。
 *
 * 在「设置」左侧导航里注册一页（slot `settings.section`），用来查看运行时抓到的
 * bug 报告，并对单条报告执行：标记状态、写文件修复（宿主会热重载生效）、提交成
 * GitHub PR、删除，以及全部清空。数据由宿主半区通过 `/bug-reporter/*` 提供，
 * 本文件只做读写与渲染。
 *
 * 形态说明：这是一个手写的浏览器模块，走 `window.__ModuleLoader__.load` 的惰性
 * 工厂协议，`react` 从浏览器模块表里 `require`。没有构建步骤，因此不用 JSX，
 * 全部用 `React.createElement`（别名 `h`）。
 *
 * 主题色一律用 `--dsw-alias-*` / `--dsw-specific-*` 里已核实的 token，不发明新名字。
 *
 * @module dsh-bug-reporter/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-bug-reporter',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * 宿主半区暴露的端点（与 index.js 的路由前缀对齐）。
     * 统一返回 `{ok:true, value}` 或 `{ok:false, error:{code, message}}`。
     */
    const ROUTE = {
      state: '/bug-reporter/state',
      update: '/bug-reporter/report/update',
      remove: '/bug-reporter/report/delete',
      clear: '/bug-reporter/report/clear',
      repair: '/bug-reporter/repair',
      submit: '/bug-reporter/submit',
      // task-12：版本更新
      updateCheck: '/bug-reporter/update/check',
      updateApply: '/bug-reporter/update/apply',
      updateIgnore: '/bug-reporter/update/ignore',
      // task-19：「恢复默认」——清空持久化设置、回到 cordis.patch.yml
      settingsReset: '/bug-reporter/settings/reset',
    }

    /**
     * 界面文案。自带一份字典而不是走客户端 locale 服务：那个 `bind()` 的返回
     * 签名没有实测过，不想拿一个猜的 API 去换一个不确定的失败点。语言按浏览器
     * 偏好选，缺键回落到中文。
     */
    const DICT = {
      zh: {
        nav: 'Bug 报告',
        intro: '运行时捕获的错误会出现在这里。可以写文件修复（宿主热重载生效），也可以直接提交成 GitHub PR。',
        openCount: (n) => `未处理 ${n} 条`,
        master: '总开关',
        masterOn: '已开启',
        masterOff: '已关闭',
        masterOnHint: '正在记录新的 bug 报告。',
        masterOffHint: '已停止记录新的 bug 报告。设置页与已有报告照常可用；重新打开会立刻恢复记录。',
        masterEnable: '开启',
        masterDisable: '关闭',
        followMaster: '跟随总开关：总开关关掉后这三项不再生效。',
        persistHint: '界面里的改动会自动保存，重启 DSH 后仍然生效（优先于 cordis.patch.yml）。',
        resetSettings: '恢复默认',
        resetSettingsHint: '清空界面保存的设置，回到 cordis.patch.yml 的值。只重置设置，不删除任何报告。',
        confirmReset: '确定恢复默认设置？界面里改过的值会被清空并回到 cordis.patch.yml。报告不会被删除。',
        confirmResetYes: '确定恢复默认',
        capture: '捕获开关',
        enabled: '启用捕获',
        captureTools: '记录工具执行失败',
        captureProcess: '监听未捕获异常 / 未处理 Promise',
        repairEnabled: '允许写文件修复（热重载）',
        settings: '设置',
        repo: '目标仓库（owner/name）',
        repoPlaceholder: '例如 zuaonew-ops/dsh-bug-reporter',
        tokenRef: '凭据名（GitHub token）',
        baseBranch: '基分支',
        baseBranchPlaceholder: '留空用目标仓库默认分支',
        tokenOk: '已配置凭据',
        tokenMissing: '未配置凭据',
        tokenHint: '在宿主的凭据配置里补一条同名凭据即可。',
        storeFile: '报告存储文件',
        reports: '报告列表',
        clearAll: '全部清空',
        confirmClear: (n) => `确定清空全部 ${n} 条报告？此操作不可撤销。`,
        confirmYes: '确定清空',
        cancel: '取消',
        empty: '还没抓到 bug —— 出问题时这里会自动出现',
        level: '级别',
        source: '来源',
        count: (n) => `出现 ${n} 次`,
        plugin: '归属插件',
        pluginNone: '未定位',
        session: '会话',
        fingerprint: '指纹',
        firstAt: '首次',
        lastAt: '最近',
        expand: '展开详情',
        collapse: '收起详情',
        stack: '调用栈',
        context: '上下文',
        none: '（无）',
        statusOpen: '未处理',
        statusFixed: '已修复',
        statusIgnored: '已忽略',
        submitPr: '提交为 PR',
        repair: '修复',
        repairTitle: '写文件修复：填绝对路径与新内容，保存后宿主热重载',
        repairPath: '文件绝对路径',
        repairPathPlaceholder: 'D:\\ai aegit\\deepseek\\dsh-bug-reporter\\index.js',
        repairContent: '新的文件内容',
        repairContentPlaceholder: '粘贴修复后的完整文件内容…',
        repairApply: '写入并热重载',
        repairCancel: '取消修复',
        repairNeedPath: '请先填文件绝对路径',
        markFixed: '标记已修',
        ignore: '忽略',
        reopen: '重新打开',
        remove: '删除',
        fixedAs: (path, reloaded, rev) => `已修复：${path}，热重载=${reloaded} rev=${rev}`,
        reloadYes: '是',
        reloadNo: '否',
        prLabel: 'PR',
        updates: '可用更新',
        updatesEmpty: '没有可用更新',
        updatesNever: '还没检查过',
        updatesLastCheck: (at) => `上次检查：${at}`,
        checkNow: '立即检查更新',
        colInstalled: '已装',
        colLatest: '最新',
        kindPatch: '修订',
        kindMinor: '次版本',
        kindMajor: '主版本',
        updateApply: '更新',
        updateIgnore: '忽略',
        updateUnignore: '取消忽略',
        ignoredTitle: '已忽略的更新',
        updateLogTitle: '更新记录',
        logApplied: '已应用',
        logRestart: '需重启生效',
        logFailed: '失败',
        logSkipped: '已跳过',
        loading: '载入中…',
        saving: '保存中…',
        saved: '已保存',
        error: '操作失败',
        retry: '重试',
        netFail: '网络请求失败',
        badJson: '响应不是合法 JSON，',
        yes: '是',
        no: '否',
      },
      en: {
        nav: 'Bug reports',
        intro: 'Errors captured at runtime show up here. You can fix them by writing a file (the host hot-reloads it) or submit them as a GitHub PR.',
        openCount: (n) => `${n} open`,
        master: 'Master switch',
        masterOn: 'ON',
        masterOff: 'OFF',
        masterOnHint: 'New bug reports are being recorded.',
        masterOffHint: 'New bug reports are no longer recorded. This settings page and existing reports still work; turning it back on resumes recording immediately.',
        masterEnable: 'Turn on',
        masterDisable: 'Turn off',
        followMaster: 'Follows the master switch: these three have no effect while it is off.',
        persistHint: 'Changes made here are saved automatically and survive a DSH restart (they take priority over cordis.patch.yml).',
        resetSettings: 'Restore defaults',
        resetSettingsHint: 'Clear the settings saved from this page and go back to cordis.patch.yml. Resets settings only - never deletes reports.',
        confirmReset: 'Restore default settings? Values changed here will be cleared and cordis.patch.yml takes over again. Reports are not deleted.',
        confirmResetYes: 'Restore defaults',
        capture: 'Capture',
        enabled: 'Enable capture',
        captureTools: 'Record failed tool calls',
        captureProcess: 'Watch uncaught exceptions / unhandled rejections',
        repairEnabled: 'Allow file repairs (hot reload)',
        settings: 'Settings',
        repo: 'Target repo (owner/name)',
        repoPlaceholder: 'e.g. zuaonew-ops/dsh-bug-reporter',
        tokenRef: 'Credential name (GitHub token)',
        baseBranch: 'Base branch',
        baseBranchPlaceholder: 'Empty = the repo default branch',
        tokenOk: 'Credential configured',
        tokenMissing: 'No credential',
        tokenHint: 'Add a credential with this name in the host credential store.',
        storeFile: 'Report store file',
        reports: 'Reports',
        clearAll: 'Clear all',
        confirmClear: (n) => `Clear all ${n} reports? This cannot be undone.`,
        confirmYes: 'Clear all',
        cancel: 'Cancel',
        empty: 'No bugs captured yet - they will show up here automatically',
        level: 'Level',
        source: 'Source',
        count: (n) => `seen ${n}x`,
        plugin: 'Plugin',
        pluginNone: 'not located',
        session: 'Session',
        fingerprint: 'Fingerprint',
        firstAt: 'First',
        lastAt: 'Last',
        expand: 'Show details',
        collapse: 'Hide details',
        stack: 'Stack',
        context: 'Context',
        none: '(none)',
        statusOpen: 'Open',
        statusFixed: 'Fixed',
        statusIgnored: 'Ignored',
        submitPr: 'Submit as PR',
        repair: 'Fix',
        repairTitle: 'Write a file fix: absolute path + new content; the host hot-reloads after saving',
        repairPath: 'Absolute file path',
        repairPathPlaceholder: 'D:\\ai aegit\\deepseek\\dsh-bug-reporter\\index.js',
        repairContent: 'New file content',
        repairContentPlaceholder: 'Paste the full repaired file content...',
        repairApply: 'Write and hot reload',
        repairCancel: 'Cancel fix',
        repairNeedPath: 'Fill in the absolute file path first',
        markFixed: 'Mark fixed',
        ignore: 'Ignore',
        reopen: 'Reopen',
        remove: 'Delete',
        fixedAs: (path, reloaded, rev) => `Fixed: ${path}, hot reload=${reloaded} rev=${rev}`,
        reloadYes: 'yes',
        reloadNo: 'no',
        prLabel: 'PR',
        updates: 'Available updates',
        updatesEmpty: 'No updates available',
        updatesNever: 'never checked',
        updatesLastCheck: (at) => `Last checked: ${at}`,
        checkNow: 'Check for updates',
        colInstalled: 'installed',
        colLatest: 'latest',
        kindPatch: 'patch',
        kindMinor: 'minor',
        kindMajor: 'major',
        updateApply: 'Update',
        updateIgnore: 'Ignore',
        updateUnignore: 'Unignore',
        ignoredTitle: 'Ignored updates',
        updateLogTitle: 'Update log',
        logApplied: 'applied',
        logRestart: 'restart required',
        logFailed: 'failed',
        logSkipped: 'skipped',
        loading: 'Loading...',
        saving: 'Saving...',
        saved: 'Saved',
        error: 'Action failed',
        retry: 'Retry',
        netFail: 'Network request failed',
        badJson: 'Response was not valid JSON, ',
        yes: 'yes',
        no: 'no',
      },
    }

    const LANG = (
      (typeof navigator !== 'undefined' && navigator.language) ||
      'zh'
    ).toLowerCase().startsWith('zh')
      ? 'zh'
      : 'en'

    /** 取一条文案；带函数的值按参数调用。 */
    function t(key, ...args) {
      const value = DICT[LANG][key] ?? DICT.zh[key]
      return typeof value === 'function' ? value(...args) : value
    }

    /** 已核实的主题 token，不发明新名字。 */
    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    /** 报告级别 → 颜色。 */
    const LEVEL_COLOR = {
      error: TOKEN.error,
      fatal: TOKEN.error,
      warn: TOKEN.warn,
      warning: TOKEN.warn,
      info: TOKEN.dim,
      debug: TOKEN.dim,
    }

    /** 报告状态 → 徽章文案与颜色。 */
    const STATUS_META = {
      open: { key: 'statusOpen', color: TOKEN.warn },
      fixed: { key: 'statusFixed', color: TOKEN.success },
      ignored: { key: 'statusIgnored', color: TOKEN.idle },
    }

    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      font: 'inherit',
      fontSize: 13,
      padding: '5px 8px',
      marginTop: 4,
      color: TOKEN.text,
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 6,
    }

    const PRE_STYLE = {
      margin: 0,
      padding: '6px 8px',
      background: TOKEN.nested,
      border: `1px solid ${TOKEN.border}`,
      borderRadius: 6,
      fontSize: 11,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 220,
      overflow: 'auto',
    }

    /** POST 的 fetch 选项。 */
    function post(body) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    }

    /** 任意值 → 可读错误文本。 */
    function errText(error) {
      return String((error && error.message) || error)
    }

    /** ISO 时间 → 本地化文本；非法值原样返回。 */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return date.toLocaleString()
      } catch (error) {
        return date.toISOString()
      }
    }

    /** 上下文对象 → 缩进 JSON；字符串原样。 */
    function safeJson(value) {
      if (value === null || value === undefined) return t('none')
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value, null, 2)
      } catch (error) {
        return String(value)
      }
    }

    /**
     * 统一请求：解包 `{ok, value}` 信封，失败抛 Error（message 优先用宿主给的）。
     * 网络层与 JSON 解析都单独 try/catch，任何失败都变成可展示的 Error，不冒泡成白屏。
     */
    async function request(path, options) {
      let response
      try {
        response = await fetch(path, options)
      } catch (error) {
        throw new Error(`${t('netFail')}: ${errText(error)}`)
      }
      let envelope
      try {
        envelope = await response.json()
      } catch (error) {
        throw new Error(`${t('badJson')}HTTP ${response.status}`)
      }
      if (!envelope || envelope.ok !== true) {
        const detail = envelope && envelope.error && (envelope.error.message || envelope.error.code)
        throw new Error(detail ? String(detail) : `HTTP ${response.status}`)
      }
      return envelope.value
    }

    /** 一个小图标按钮（展开/删除这类）。 */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        'aria-label': props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          flex: '0 0 auto',
          width: 26,
          height: 26,
          lineHeight: '22px',
          padding: 0,
          fontSize: 13,
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.35 : 1,
          color: props.danger ? TOKEN.error : TOKEN.dim,
          background: 'transparent',
          border: `1px solid ${TOKEN.border}`,
          borderRadius: 6,
          font: 'inherit',
        },
      }, props.children)
    }

    /** 一个文字按钮。 */
    function Button(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          flex: '0 0 auto',
          padding: '4px 10px',
          fontSize: 12,
          font: 'inherit',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.4 : 1,
          color: props.primary ? '#fff' : props.danger ? TOKEN.error : TOKEN.text,
          background: props.primary ? TOKEN.brand : 'transparent',
          border: `1px solid ${props.primary ? TOKEN.brand : TOKEN.border}`,
          borderRadius: 6,
        },
      }, props.children)
    }

    /** 状态徽章。 */
    function Badge(props) {
      return h('span', {
        style: {
          flex: '0 0 auto',
          padding: '1px 7px',
          fontSize: 11,
          lineHeight: '16px',
          color: props.color,
          border: `1px solid ${props.color}`,
          borderRadius: 999,
        },
      }, props.children)
    }

    /** 设置页主体。 */
    function BugReporterSection() {
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [expanded, setExpanded] = React.useState('')
      const [repairId, setRepairId] = React.useState('')
      const [repairPath, setRepairPath] = React.useState('')
      const [repairText, setRepairText] = React.useState('')
      const [confirmClear, setConfirmClear] = React.useState(false)
      const [confirmReset, setConfirmReset] = React.useState(false)

      // 当前状态的镜像：变更函数从 ref 读，避免在 setState 更新器里做副作用
      // （StrictMode 下更新器可能被调用两次，那样会重复发请求）。
      const current = React.useRef(null)
      const timer = React.useRef(null)
      const alive = React.useRef(true)
      const inflight = React.useRef(null)

      /** 拉一次全量状态。卸载后到达的响应直接丢弃，不再 setState。 */
      const load = React.useCallback(() => {
        setStatus('loading')
        setMessage('')
        if (inflight.current) {
          try {
            inflight.current.abort()
          } catch (error) {
            // 老实现不支持 abort 也无所谓，下面还有 alive 守卫。
          }
        }
        let controller = null
        if (typeof AbortController === 'function') {
          controller = new AbortController()
        }
        inflight.current = controller
        return request(ROUTE.state, controller ? { signal: controller.signal } : undefined)
          .then((value) => {
            if (!alive.current) return
            current.current = value
            setData(value)
            setStatus('saved')
            setMessage('')
          })
          .catch((error) => {
            if (!alive.current) return
            setStatus('error')
            setMessage(errText(error))
          })
      }, [])

      React.useEffect(() => {
        alive.current = true
        load()
        return () => {
          alive.current = false
          if (timer.current) clearTimeout(timer.current)
          if (inflight.current) {
            try {
              inflight.current.abort()
            } catch (error) {
              // 卸载时的 abort 失败无需处理。
            }
          }
        }
      }, [load])

      /** 只改本地镜像，不发请求。 */
      const patchLocal = React.useCallback((patch) => {
        const base = current.current
        if (!base) return
        const next = { ...base, ...patch }
        current.current = next
        setData(next)
      }, [])

      /** 用新数组替换报告列表。 */
      const setReports = React.useCallback((reports) => {
        const base = current.current
        if (!base) return
        const next = { ...base, reports }
        current.current = next
        setData(next)
      }, [])

      /** 按 id 合并一条报告（宿主返回的 report 覆盖本地同 id 项）。 */
      const mergeReport = React.useCallback((report) => {
        const base = current.current
        if (!base || !report || !report.id) return
        const reports = base.reports.map((item) => (item.id === report.id ? { ...item, ...report } : item))
        setReports(reports)
      }, [setReports])

      /** 宿主如果直接回了整份状态，就整份采纳。 */
      const adopt = React.useCallback((value) => {
        if (value && Array.isArray(value.reports)) {
          current.current = value
          setData(value)
          return true
        }
        return false
      }, [])

      /**
       * 保存设置。开关类立刻发；文本框走 400ms 防抖，连点合并成一次。
       * POST /state 的返回形状没有约定，所以本地先乐观更新，宿主回了整份状态才覆盖。
       */
      const saveState = React.useCallback((patch, immediate) => {
        setStatus('saving')
        setMessage('')
        if (timer.current) clearTimeout(timer.current)
        const send = () => {
          request(ROUTE.state, post(patch))
            .then((value) => {
              if (!alive.current) return
              adopt(value)
              setStatus('saved')
              setMessage('')
            })
            .catch((error) => {
              if (!alive.current) return
              setStatus('error')
              setMessage(errText(error))
            })
        }
        if (immediate) {
          send()
        } else {
          timer.current = setTimeout(send, 400)
        }
      }, [adopt])

      /** 改一个设置项：本地先变，再发保存。 */
      const changeSetting = React.useCallback((patch, immediate) => {
        patchLocal(patch)
        saveState(patch, immediate)
      }, [patchLocal, saveState])

      /**
       * 跑一个报告操作：进行中禁用按钮、状态行显示进度，失败只写状态行。
       * 任何异常都被 catch 住，不会变成白屏。
       */
      const runAction = React.useCallback((label, work) => {
        setBusy(label)
        setStatus('saving')
        setMessage('')
        Promise.resolve()
          .then(work)
          .then((value) => {
            if (!alive.current) return
            adopt(value)
            setBusy('')
            setStatus('saved')
            setMessage('')
          })
          .catch((error) => {
            if (!alive.current) return
            setBusy('')
            setStatus('error')
            setMessage(errText(error))
          })
      }, [adopt])

      /** 标记 已修 / 忽略 / 重新打开。 */
      const actUpdate = React.useCallback((report, nextStatus) => {
        runAction(`update:${report.id}`, async () => {
          const value = await request(ROUTE.update, post({ id: report.id, status: nextStatus }))
          mergeReport((value && value.report) || { ...report, status: nextStatus })
          return value
        })
      }, [runAction, mergeReport])

      /** 删除一条。 */
      const actDelete = React.useCallback((report) => {
        runAction(`delete:${report.id}`, async () => {
          const value = await request(ROUTE.remove, post({ id: report.id }))
          const base = current.current
          if (base) setReports(base.reports.filter((item) => item.id !== report.id))
          if (expanded === report.id) setExpanded('')
          if (repairId === report.id) setRepairId('')
          return value
        })
      }, [runAction, setReports, expanded, repairId])

      /** 全部清空（调用前已经过一次确认）。 */
      const actClear = React.useCallback(() => {
        runAction('clear', async () => {
          const value = await request(ROUTE.clear, post({}))
          setReports([])
          setConfirmClear(false)
          setExpanded('')
          setRepairId('')
          return value
        })
      }, [runAction, setReports])

      /**
       * 恢复默认（task-19，调用前已经过一次确认）：清空持久化设置、回到 cordis.patch.yml。
       * 宿主返回整份 /state value，`adopt` 会把界面上的值一起刷新回来。**报告一条不动。**
       */
      const actResetSettings = React.useCallback(() => {
        runAction('reset-settings', async () => {
          const value = await request(ROUTE.settingsReset, post({}))
          setConfirmReset(false)
          return value
        })
      }, [runAction, setConfirmReset])

      /** 写文件修复并热重载。 */
      const actRepair = React.useCallback((report) => {
        const path = repairPath.trim()
        if (!path) {
          setStatus('error')
          setMessage(t('repairNeedPath'))
          return
        }
        runAction(`repair:${report.id}`, async () => {
          const value = await request(ROUTE.repair, post({ id: report.id, path, content: repairText }))
          mergeReport((value && value.report) || { ...report, status: 'fixed', fix: value && value.fix })
          setRepairId('')
          return value
        })
      }, [runAction, mergeReport, repairPath, repairText])

      /** 提交成 PR。仓库/基分支按契约可选覆盖，填了才带。 */
      const actSubmit = React.useCallback((report) => {
        runAction(`submit:${report.id}`, async () => {
          const body = { id: report.id }
          const repo = String((current.current && current.current.repo) || '').trim()
          const baseBranch = String((current.current && current.current.baseBranch) || '').trim()
          if (repo) body.repo = repo
          if (baseBranch) body.baseBranch = baseBranch
          const value = await request(ROUTE.submit, post(body))
          mergeReport((value && value.report) || { ...report, pr: value && value.pr })
          return value
        })
      }, [runAction, mergeReport])

      /** task-12：立刻检查一次有没有新版本。宿主回的是一整份状态。 */
      const actCheckUpdates = React.useCallback(() => {
        runAction('update-check', async () => request(ROUTE.updateCheck, post({})))
      }, [runAction])

      /** task-12：手动装某个包的最新版（不受 autoUpdate 限制）。 */
      const actApplyUpdate = React.useCallback((moduleName) => {
        runAction(`update-apply:${moduleName}`, async () => request(ROUTE.updateApply, post({ moduleName })))
      }, [runAction])

      /** task-12：忽略 / 取消忽略某个版本（同一参数再发一次即取消）。 */
      const actIgnoreUpdate = React.useCallback((moduleName, version) => {
        runAction(`update-ignore:${moduleName}`, async () =>
          request(ROUTE.updateIgnore, post({ moduleName, version })),
        )
      }, [runAction])

      /** 打开修复面板：路径能从报告里猜就预填。 */
      const openRepair = React.useCallback((report) => {
        const context = (report && report.context) || {}
        const guess =
          (report && report.fix && report.fix.path) ||
          context.file ||
          context.path ||
          context.filePath ||
          ''
        setRepairId(report.id)
        setRepairPath(String(guess || ''))
        setRepairText('')
      }, [])

      if (status === 'loading' && !data) {
        return h('div', { style: { padding: '16px 20px', color: TOKEN.dim } }, t('loading'))
      }

      if (!data) {
        return h('div', { style: { padding: '16px 20px', color: TOKEN.error } },
          h('div', null, `${t('error')}: ${message}`),
          h('button', {
            type: 'button',
            onClick: load,
            style: {
              marginTop: 8, padding: '4px 12px', cursor: 'pointer', font: 'inherit',
              color: TOKEN.text, background: TOKEN.surface,
              border: `1px solid ${TOKEN.border}`, borderRadius: 6,
            },
          }, t('retry')),
        )
      }

      const reports = Array.isArray(data.reports) ? data.reports : []
      const openCount = reports.filter((report) => report.status === 'open').length
      const rows = []

      // ── 头部：未处理条数
      rows.push(h('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 10px' },
      },
        h('span', { style: { fontSize: 13, color: TOKEN.dim, flex: '1 1 auto' } }, t('intro')),
        h(Badge, { color: openCount > 0 ? TOKEN.warn : TOKEN.dim }, t('openCount', openCount)),
      ))

      // ── 总开关（task-19）：单独一张卡片，放在最上面。
      // 两态用已核实的 token（success / idle），不发明新 token。
      // 只描述「不再记录新报告」，**不说**会卸载插件 —— 那是 cordis.patch.yml 的 enabled:false。
      const masterOn = data.enabled !== false
      rows.push(h('div', {
        key: 'master',
        style: {
          margin: '0 0 14px', padding: '10px 12px', background: TOKEN.surface,
          border: `1px solid ${masterOn ? TOKEN.success : TOKEN.border}`, borderRadius: 8,
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        },
      },
        h('div', { style: { flex: '1 1 180px', minWidth: 0 } },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
          },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.dim } }, t('master')),
            h(Badge, { color: masterOn ? TOKEN.success : TOKEN.idle },
              masterOn ? t('masterOn') : t('masterOff')),
          ),
          h('div', { style: { fontSize: 12, color: TOKEN.text } },
            masterOn ? t('masterOnHint') : t('masterOffHint')),
          h('div', { style: { fontSize: 11, color: TOKEN.dim, marginTop: 4 } }, t('persistHint')),
        ),
        h(Button, {
          primary: !masterOn,
          disabled: busy !== '',
          onClick: () => changeSetting({ enabled: !masterOn }, true),
        }, masterOn ? t('masterDisable') : t('masterEnable')),
      ))

      // ── 捕获开关：改动立刻保存
      rows.push(h('div', {
        key: 'capture',
        style: {
          margin: '0 0 14px', padding: '10px 12px', background: TOKEN.surface,
          border: `1px solid ${TOKEN.border}`, borderRadius: 8,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.dim, marginBottom: 6 } }, t('capture')),
        ...[
          ['captureTools', 'captureTools'],
          ['captureProcess', 'captureProcess'],
          ['repairEnabled', 'repairEnabled'],
        ].map(([field, labelKey]) => h('label', {
          key: field,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0',
            cursor: masterOn ? 'pointer' : 'default',
            opacity: masterOn ? 1 : 0.45,
          },
        },
          h('input', {
            type: 'checkbox',
            checked: data[field] !== false,
            // 总开关关掉时三个子开关置灰（值仍然保留，开回来即恢复）。
            disabled: busy !== '' || !masterOn,
            onChange: () => changeSetting({ [field]: data[field] === false }, true),
          }),
          h('span', null, t(labelKey)),
        )),
        h('div', { style: { fontSize: 11, color: TOKEN.dim, marginTop: 6 } }, t('followMaster')),
      ))

      // ── 设置区
      rows.push(h('div', {
        key: 'settings',
        style: {
          margin: '0 0 14px', padding: '10px 12px', background: TOKEN.surface,
          border: `1px solid ${TOKEN.border}`, borderRadius: 8,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.dim, marginBottom: 6 } }, t('settings')),

        h('label', { style: { display: 'block', fontSize: 12, color: TOKEN.dim } }, t('repo'),
          h('input', {
            type: 'text',
            value: data.repo || '',
            placeholder: t('repoPlaceholder'),
            spellCheck: false,
            disabled: busy !== '',
            onChange: (event) => changeSetting({ repo: event.target.value }, false),
            style: INPUT_STYLE,
          }),
        ),

        h('label', { style: { display: 'block', fontSize: 12, color: TOKEN.dim, marginTop: 8 } }, t('tokenRef'),
          h('input', {
            type: 'text',
            value: data.tokenRef || '',
            placeholder: 'GITHUB_TOKEN',
            spellCheck: false,
            disabled: busy !== '',
            onChange: (event) => changeSetting({ tokenRef: event.target.value }, false),
            style: INPUT_STYLE,
          }),
        ),

        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
        },
          h(Badge, { color: data.tokenConfigured ? TOKEN.success : TOKEN.warn },
            data.tokenConfigured ? t('tokenOk') : t('tokenMissing')),
          data.tokenConfigured
            ? null
            : h('span', { style: { fontSize: 11, color: TOKEN.dim } }, t('tokenHint')),
        ),

        h('label', { style: { display: 'block', fontSize: 12, color: TOKEN.dim, marginTop: 8 } }, t('baseBranch'),
          h('input', {
            type: 'text',
            value: data.baseBranch || '',
            placeholder: t('baseBranchPlaceholder'),
            spellCheck: false,
            disabled: busy !== '',
            onChange: (event) => changeSetting({ baseBranch: event.target.value }, false),
            style: INPUT_STYLE,
          }),
        ),

        data.storeFile
          ? h('div', {
            style: { marginTop: 8, fontSize: 11, color: TOKEN.dim, wordBreak: 'break-all' },
          }, `${t('storeFile')}: ${data.storeFile}`)
          : null,

        // ── 恢复默认（task-19）：清掉持久化设置、回到 cordis.patch.yml。不删报告。
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginTop: 10, paddingTop: 10, borderTop: `1px solid ${TOKEN.border}`,
          },
        },
          h('span', { style: { flex: '1 1 200px', fontSize: 11, color: TOKEN.dim } }, t('resetSettingsHint')),
          h(Button, {
            disabled: busy !== '',
            onClick: () => setConfirmReset(true),
          }, t('resetSettings')),
        ),

        confirmReset
          ? h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8,
              padding: '8px 10px', background: TOKEN.overlay,
              border: `1px solid ${TOKEN.borderStrong}`, borderRadius: 6,
            },
          },
            h('span', { style: { flex: '1 1 auto', fontSize: 12, color: TOKEN.text } }, t('confirmReset')),
            h(Button, { onClick: actResetSettings, disabled: busy !== '', danger: true }, t('confirmResetYes')),
            h(Button, { onClick: () => setConfirmReset(false), disabled: busy !== '' }, t('cancel')),
          )
          : null,
      ))

      // ── 报告列表
      rows.push(h('div', {
        key: 'list-head',
        style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px' },
      },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.dim, flex: '1 1 auto' } }, t('reports')),
        reports.length > 0
          ? h(Button, { onClick: () => setConfirmClear(true), disabled: busy !== '' }, t('clearAll'))
          : null,
      ))

      if (confirmClear) {
        rows.push(h('div', {
          key: 'confirm-clear',
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 10px',
            padding: '8px 10px', background: TOKEN.overlay,
            border: `1px solid ${TOKEN.borderStrong}`, borderRadius: 6,
          },
        },
          h('span', { style: { flex: '1 1 auto', fontSize: 12, color: TOKEN.text } },
            t('confirmClear', reports.length)),
          h(Button, { onClick: actClear, disabled: busy !== '', danger: true }, t('confirmYes')),
          h(Button, { onClick: () => setConfirmClear(false), disabled: busy !== '' }, t('cancel')),
        ))
      }

      if (reports.length === 0) {
        rows.push(h('div', {
          key: 'empty',
          style: {
            padding: '18px 12px', textAlign: 'center', fontSize: 12, color: TOKEN.dim,
            background: TOKEN.surface, border: `1px dashed ${TOKEN.borderStrong}`, borderRadius: 8,
          },
        }, t('empty')))
      }

      for (const report of reports) {
        const statusMeta = STATUS_META[report.status] || STATUS_META.open
        const isExpanded = expanded === report.id
        const isRepairing = repairId === report.id
        const isOpen = report.status === 'open'
        const locked = busy !== ''

        rows.push(h('div', {
          key: report.id,
          style: {
            margin: '0 0 10px', padding: '10px 12px', background: TOKEN.surface,
            border: `1px solid ${TOKEN.border}`, borderRadius: 8,
          },
        },
          // 第一行：级别 / 来源 / 次数 / 状态 / 时间
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 },
          },
            h('span', {
              style: {
                fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                textTransform: 'uppercase', color: LEVEL_COLOR[report.level] || TOKEN.dim,
              },
            }, String(report.level || 'error')),
            report.source ? h('span', { style: { fontSize: 11, color: TOKEN.dim } }, String(report.source)) : null,
            h('span', { style: { fontSize: 11, color: TOKEN.dim } }, t('count', report.count ?? 1)),
            h(Badge, { color: statusMeta.color }, t(statusMeta.key)),
            h('span', {
              style: { marginLeft: 'auto', fontSize: 11, color: TOKEN.dim },
            }, `${t('firstAt')} ${formatTime(report.firstAt)} · ${t('lastAt')} ${formatTime(report.lastAt)}`),
          ),

          // 消息
          h('div', {
            style: { fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
          }, String(report.message || '')),

          // 归属 / 会话 / 指纹
          h('div', {
            style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 11, color: TOKEN.dim },
          },
            h('span', null, `${t('plugin')}: ${report.pluginId || t('pluginNone')}`),
            report.sessionId ? h('span', null, `${t('session')}: ${report.sessionId}`) : null,
            report.fingerprint ? h('span', null, `${t('fingerprint')}: ${report.fingerprint}`) : null,
          ),

          // 修复结果
          report.fix
            ? h('div', { style: { marginTop: 6, fontSize: 11, color: TOKEN.success, wordBreak: 'break-all' } },
              t('fixedAs',
                String(report.fix.path || ''),
                report.fix.reloaded ? t('reloadYes') : t('reloadNo'),
                report.fix.rev === null || report.fix.rev === undefined ? '—' : String(report.fix.rev)))
            : null,

          // PR 链接
          report.pr && report.pr.url
            ? h('div', { style: { marginTop: 6, fontSize: 11 } },
              h('a', {
                href: String(report.pr.url),
                target: '_blank',
                rel: 'noreferrer',
                style: { color: TOKEN.brand, wordBreak: 'break-all' },
              }, `${t('prLabel')} #${report.pr.number ?? '?'} ${report.pr.repo || ''}`.trim()),
            )
            : null,

          // 操作按钮
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
            h(Button, { onClick: () => actSubmit(report), disabled: locked, primary: true }, t('submitPr')),
            h(Button, { onClick: () => openRepair(report), disabled: locked }, t('repair')),
            isOpen ? h(Button, { onClick: () => actUpdate(report, 'fixed'), disabled: locked }, t('markFixed')) : null,
            isOpen ? h(Button, { onClick: () => actUpdate(report, 'ignored'), disabled: locked }, t('ignore')) : null,
            isOpen ? null : h(Button, { onClick: () => actUpdate(report, 'open'), disabled: locked }, t('reopen')),
            h(IconButton, {
              title: isExpanded ? t('collapse') : t('expand'),
              disabled: locked,
              onClick: () => setExpanded(isExpanded ? '' : report.id),
            }, isExpanded ? '\u25be' : '\u25b8'),
            h(IconButton, {
              title: t('remove'),
              danger: true,
              disabled: locked,
              onClick: () => actDelete(report),
            }, '\u00d7'),
          ),

          // 展开：stack + context
          isExpanded
            ? h('div', {
              style: {
                marginTop: 8, padding: '8px 10px', background: TOKEN.overlay,
                border: `1px solid ${TOKEN.border}`, borderRadius: 6,
              },
            },
              h('div', { style: { fontSize: 11, fontWeight: 600, color: TOKEN.dim, marginBottom: 4 } }, t('stack')),
              h('pre', { style: PRE_STYLE }, String(report.stack || t('none'))),
              h('div', {
                style: { fontSize: 11, fontWeight: 600, color: TOKEN.dim, margin: '8px 0 4px' },
              }, t('context')),
              h('pre', { style: PRE_STYLE }, safeJson(report.context)),
            )
            : null,

          // 展开：修复面板
          isRepairing
            ? h('div', {
              style: {
                marginTop: 8, padding: '8px 10px', background: TOKEN.nested,
                border: `1px solid ${TOKEN.borderStrong}`, borderRadius: 6,
              },
            },
              h('div', {
                style: { fontSize: 11, fontWeight: 600, color: TOKEN.dim, marginBottom: 4 },
              }, t('repairTitle')),
              h('label', { style: { display: 'block', fontSize: 11, color: TOKEN.dim } }, t('repairPath'),
                h('input', {
                  type: 'text',
                  value: repairPath,
                  placeholder: t('repairPathPlaceholder'),
                  spellCheck: false,
                  disabled: locked,
                  onChange: (event) => setRepairPath(event.target.value),
                  style: INPUT_STYLE,
                }),
              ),
              h('label', {
                style: { display: 'block', fontSize: 11, color: TOKEN.dim, marginTop: 8 },
              }, t('repairContent'),
                h('textarea', {
                  value: repairText,
                  rows: 6,
                  spellCheck: false,
                  disabled: locked,
                  placeholder: t('repairContentPlaceholder'),
                  onChange: (event) => setRepairText(event.target.value),
                  style: { ...INPUT_STYLE, resize: 'vertical', fontFamily: 'monospace' },
                }),
              ),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                h(Button, { onClick: () => actRepair(report), disabled: locked, primary: true }, t('repairApply')),
                h(Button, { onClick: () => setRepairId(''), disabled: locked }, t('repairCancel')),
              ),
            )
            : null,
        ))
      }

      // ── 可用更新（task-12；老宿主不返回 updates 时按空数组处理）
      const updateItems = Array.isArray(data.updates) ? data.updates : []
      const visibleUpdates = updateItems.filter((item) => item.ignored !== true)
      const ignoredItems = updateItems.filter((item) => item.ignored === true)
      const updateLog = Array.isArray(data.updateLog) ? data.updateLog : []
      const KIND_LABEL = { patch: t('kindPatch'), minor: t('kindMinor'), major: t('kindMajor') }
      const RESULT_LABEL = {
        applied: t('logApplied'),
        'restart-required': t('logRestart'),
        failed: t('logFailed'),
        skipped: t('logSkipped'),
      }

      rows.push(h('div', {
        key: 'updates-head',
        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0 8px' },
      },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: TOKEN.dim, flex: '1 1 auto' } }, t('updates')),
        h('span', { style: { fontSize: 11, color: TOKEN.dim } },
          data.lastUpdateCheckAt
            ? t('updatesLastCheck', formatTime(data.lastUpdateCheckAt))
            : t('updatesNever')),
        h(Button, { onClick: actCheckUpdates, disabled: busy !== '' }, t('checkNow')),
      ))

      if (visibleUpdates.length === 0) {
        rows.push(h('div', {
          key: 'updates-empty',
          style: { margin: '0 0 12px', fontSize: 12, color: TOKEN.dim, opacity: 0.8 },
        }, t('updatesEmpty')))
      }

      for (const item of visibleUpdates) {
        const kindColor = item.kind === 'major'
          ? TOKEN.error
          : item.kind === 'minor' ? TOKEN.warn : TOKEN.idle
        rows.push(h('div', {
          key: `up-${item.moduleName}`,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            margin: '0 0 6px', padding: '8px 10px', background: TOKEN.surface,
            border: `1px solid ${TOKEN.border}`, borderRadius: 8,
          },
        },
          h('span', {
            style: { flex: '1 1 160px', fontSize: 13, wordBreak: 'break-all' },
          }, String(item.moduleName || '')),
          h('span', { style: { fontSize: 11, color: TOKEN.dim } },
            `${t('colInstalled')} ${item.installed || '?'}`),
          h('span', { style: { fontSize: 11, color: TOKEN.brand } }, `→ ${t('colLatest')} ${item.latest || '?'}`),
          h(Badge, { color: kindColor }, KIND_LABEL[item.kind] || String(item.kind || '')),
          h(Button, {
            onClick: () => actApplyUpdate(item.moduleName),
            disabled: busy !== '',
            primary: true,
          }, t('updateApply')),
          h(Button, {
            onClick: () => actIgnoreUpdate(item.moduleName, item.latest),
            disabled: busy !== '',
          }, t('updateIgnore')),
        ))
      }

      if (ignoredItems.length > 0) {
        rows.push(h('div', {
          key: 'updates-ignored-title',
          style: { margin: '6px 0 4px', fontSize: 11, fontWeight: 600, color: TOKEN.dim },
        }, t('ignoredTitle')))
        for (const item of ignoredItems) {
          rows.push(h('div', {
            key: `up-ignored-${item.moduleName}`,
            style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 6px', opacity: 0.7 },
          },
            h('span', {
              style: { flex: '1 1 160px', fontSize: 12, color: TOKEN.dim, wordBreak: 'break-all' },
            }, `${item.moduleName} ${item.installed || '?'} → ${item.latest || '?'}`),
            h(Button, {
              onClick: () => actIgnoreUpdate(item.moduleName, item.latest),
              disabled: busy !== '',
            }, t('updateUnignore')),
          ))
        }
      }

      if (updateLog.length > 0) {
        rows.push(h('div', {
          key: 'updates-log-title',
          style: { margin: '6px 0 4px', fontSize: 11, fontWeight: 600, color: TOKEN.dim },
        }, t('updateLogTitle')))
        // 只显示最近 5 条；restart-required 要如实显示出来。
        updateLog.slice(-5).reverse().forEach((entry, index) => {
          const result = String(entry.result || '')
          const color = result === 'applied'
            ? TOKEN.success
            : result === 'restart-required' ? TOKEN.warn : result === 'failed' ? TOKEN.error : TOKEN.dim
          rows.push(h('div', {
            key: `update-log-${index}`,
            style: { margin: '0 0 3px', fontSize: 11, color: TOKEN.dim, wordBreak: 'break-word' },
          },
            h('span', { style: { color } }, RESULT_LABEL[result] || result),
            ` ${entry.moduleName || '?'} ${entry.from || '?'}→${entry.to || '?'} ${formatTime(entry.at)}`,
            entry.detail ? ` (${entry.detail})` : '',
          ))
        })
      }

      // ── 状态行
      const statusColor = status === 'error'
        ? TOKEN.error
        : status === 'saved' ? TOKEN.success : TOKEN.dim
      const statusText = status === 'error'
        ? `${t('error')}: ${message}`
        : busy !== '' ? `${t('saving')} ${busy}` : status === 'saving' ? t('saving') : t('saved')

      rows.push(h('div', {
        key: 'status',
        style: { marginTop: 12, fontSize: 12, color: statusColor, wordBreak: 'break-word' },
      }, statusText))

      return h('div', {
        style: {
          padding: '16px 20px 24px',
          color: TOKEN.text,
          font: 'inherit',
          fontSize: 13,
        },
      }, ...rows)
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        // slots.inject 会等 `settings.section` 的声明落到 ledger 上再执行回调，
        // 所以设置外壳还没挂载时也不会注册失败。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'bug-reporter',
          order: 40,
          label: () => t('nav'),
        }, BugReporterSection))
      },
    }
  },
})
