/**
 * browser-plus · Host 半
 *
 * 作用：把用户自用浏览器（Chrome / Edge）的登录 Cookie，通过本机 DevTools 调试桥
 * 注入 DSH 内置浏览器（右侧栏 Browser 标签的 Electron <webview> 分区），实现免登录。
 *
 * 组成：
 * - 设置存储（lib/settings.mjs，$DSH_HOME/browser-plus/settings.json）
 * - Cookie 读取（lib/cookie-source.mjs，macOS 钥匙串 + AES-128-CBC 解密）
 * - CDP 桥（lib/cdp.mjs，发现端口 / 枚举 webview target / Network.setCookies）
 * - 自动注入循环：只要应用以 --remote-debugging-port 启动，就为每个新出现的 webview
 *   目标注入一次（分区是进程内内存会话，应用重启后需要重新注入）。
 * - 浏览器半设置页的 HTTP API（/api/browser-plus/*）与 agent 工具 browser_plus。
 *
 * 安全：cookie 的 name/value 只在 Host 内部流转，写进 webview 分区为止；
 * 不写日志、不进 agent 工具输出、不进错误消息。
 */
import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'

import { discoverBridge, listWebviews, injectToTarget } from './lib/cdp.mjs'
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './lib/settings.mjs'
import { buildRelaunchScript } from './lib/relaunch-shell.mjs'
import { filterCookies, listBrowserCatalog, readCookies, summarize, toCdpCookie } from './lib/cookie-source.mjs'
import {
  AUTO_BRIDGE_GUARD_MS,
  AUTO_BRIDGE_MAX_ATTEMPTS,
  clearAutoBridgeMarker,
  clearRelaunchResult,
  parseHostParentCommand,
  planAutoBridge,
  readAutoBridgeMarker,
  readRelaunchResult,
  RELAUNCH_RESULT_FILE,
  writeAutoBridgeMarker,
} from './lib/auto-bridge.mjs'

export const name = 'browser-plus'
export const inject = ['tools']

const API_PREFIX = '/api/browser-plus'
/** 自动注入轮询间隔 */
const POLL_MS = 1500
/** 启动后多久做「自动启用调试端口」自检（尽早做，让重启尽量发生在窗口就绪前） */
const AUTO_BRIDGE_DELAY_MS = 700
/** 桥不可用时的重试间隔（避免扫描风暴） */
const DISCOVER_RETRY_MS = 15000
/** 浏览器目录清单缓存时长 */
const CATALOG_TTL_MS = 30000

export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {}
  const appName = typeof options.appName === 'string' && options.appName.trim() ? options.appName.trim() : 'DeepSeek Harness'

  /** @type {any} */
  const runtime = {
    settings: null,
    settingsDir: '',
    catalog: { at: 0, browsers: [], error: null },
    jar: {
      loaded: false,
      cookies: [],
      cdpCookies: [],
      summary: null,
      loadedAt: 0,
      durationMs: 0,
      browser: null,
      profile: null,
      profileName: null,
      filterKey: '',
      error: null,
    },
    bridge: {
      available: false,
      port: null,
      source: null,
      version: null,
      userDataDir: null,
      targets: [],
      checkedAt: 0,
      error: null,
      hint: '',
    },
    lastInject: { at: 0, ok: null, count: 0, targets: [], error: null },
    /** 启动自检：自动以调试端口重启（结果供设置页/工具展示） */
    autoBridge: { enabled: null, action: 'pending', reason: null, attempts: 0, lastAt: null, port: null, error: null, checked: false },
    /** 宿主父进程（桌面应用）识别结果，懒加载 */
    parentInfo: null,
    /** targetId → { url, at }，记录本进程已注入过的 webview 目标 */
    injected: new Map(),
    lastDiscoverAt: 0,
    jarBusy: null,
    injecting: false,
  }

  const log = (message) => {
    try {
      console.error(`[browser-plus] ${message}`)
    } catch {}
  }

  const settingsReady = (async () => {
    const loaded = await loadSettings(options)
    runtime.settings = loaded.settings
    runtime.settingsDir = loaded.dir
  })().catch((error) => {
    runtime.settings = { ...DEFAULT_SETTINGS }
    log(`设置读取失败，使用默认值：${error && error.message ? error.message : String(error)}`)
  })

  async function ensureSettings() {
    if (runtime.settings === null) await settingsReady
    return runtime.settings
  }

  function filterKeyOf(settings) {
    return JSON.stringify([
      settings.browser,
      settings.profile,
      settings.scope,
      settings.domains,
      settings.includeSessionCookies,
    ])
  }

  /** 从目录清单里选出当前要共享的浏览器与 profile。 */
  function pickSource(settings, browsers) {
    const installed = browsers.filter((item) => item && item.installed)
    if (installed.length === 0) return null
    let browser = null
    if (settings.browser === 'auto') {
      browser = installed.find((item) => item.id === 'edge') || installed.find((item) => item.id === 'chrome') || installed[0]
    } else {
      browser = installed.find((item) => item.id === settings.browser) || null
    }
    if (browser === null) return null
    const profiles = Array.isArray(browser.profiles) ? browser.profiles : []
    const wanted = settings.profile || 'Default'
    const profile =
      profiles.find((item) => item.id === wanted) ||
      profiles.find((item) => item.id === 'Default') ||
      profiles[0] ||
      null
    if (profile === null) {
      return { browser: browser.id, profile: wanted, label: browser.name, browserName: browser.name, profileName: wanted }
    }
    return {
      browser: browser.id,
      profile: profile.id,
      label: `${browser.name} · ${profile.name || profile.id}`,
      browserName: browser.name,
      profileName: profile.name || profile.id,
    }
  }

  async function ensureCatalog(force = false) {
    const now = Date.now()
    if (!force && now - runtime.catalog.at < CATALOG_TTL_MS && runtime.catalog.browsers.length > 0) {
      return runtime.catalog.browsers
    }
    try {
      runtime.catalog.browsers = await listBrowserCatalog()
      runtime.catalog.at = Date.now()
      runtime.catalog.error = null
    } catch (error) {
      runtime.catalog.error = error instanceof Error ? error.message : String(error)
    }
    return runtime.catalog.browsers
  }

  /** 读取（或复用）cookie jar；force 时强制重读浏览器数据库。 */
  async function ensureJar(force = false) {
    const settings = await ensureSettings()
    const filterKey = filterKeyOf(settings)
    const fresh =
      runtime.jar.loaded &&
      runtime.jar.filterKey === filterKey &&
      Date.now() - runtime.jar.loadedAt < Math.max(10, settings.refreshSeconds) * 1000
    if (!force && fresh) return runtime.jar
    if (runtime.jarBusy !== null) return runtime.jarBusy
    runtime.jarBusy = (async () => {
      const started = Date.now()
      const previous = runtime.jar
      try {
        const browsers = await ensureCatalog(false)
        const source = pickSource(settings, browsers)
        if (source === null) throw new Error('未找到可用的浏览器数据目录（Chrome / Edge 未安装或从未使用？）')
        const payload = await readCookies({ browserId: source.browser, profileId: source.profile })
        const cookies = filterCookies(payload.cookies, settings)
        runtime.jar = {
          loaded: true,
          cookies,
          cdpCookies: cookies.map(toCdpCookie).filter((cookie) => cookie !== null),
          summary: summarize(cookies),
          loadedAt: Date.now(),
          durationMs: Date.now() - started,
          browser: payload.browser,
          profile: payload.profile,
          profileName: payload.profileName || source.profileName,
          filterKey,
          error: null,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        runtime.jar = { ...previous, error: message }
      } finally {
        runtime.jarBusy = null
      }
      return runtime.jar
    })()
    return runtime.jarBusy
  }

  function webviewSummaries(targets) {
    return (Array.isArray(targets) ? targets : []).map((target) => ({
      id: String(target.id || ''),
      url: String(target.url || ''),
      title: String(target.title || ''),
    }))
  }

  /** 发现 CDP 桥（force=false 时若已有可用桥只刷新 target 列表）。 */
  async function refreshBridge(force = false) {
    const settings = await ensureSettings()
    const override = Number.isInteger(runtime.cdpPortOverride) ? runtime.cdpPortOverride : 0
    // 桥不可用时 UI 会每几秒轮询一次状态：5 秒内复用上次探测结果，避免反复扫描
    if (!force && !runtime.bridge.available && runtime.lastDiscoverAt > 0 && Date.now() - runtime.lastDiscoverAt < 5000) {
      return runtime.bridge
    }
    if (!force && runtime.bridge.available) {
      try {
        const webviews = await listWebviews(runtime.bridge.port)
        runtime.bridge.targets = webviewSummaries(webviews)
        runtime.bridge.checkedAt = Date.now()
        return runtime.bridge
      } catch (error) {
        runtime.bridge.available = false
        runtime.bridge.error = error instanceof Error ? error.message : String(error)
      }
    }
    const discovered = await discoverBridge({ port: override || settings.cdpPort, userDataDir: settings.userDataDir })
    runtime.bridge = {
      available: discovered.available,
      port: discovered.port,
      source: discovered.source,
      version: discovered.version,
      userDataDir: discovered.userDataDir,
      targets: webviewSummaries(discovered.targets),
      checkedAt: Date.now(),
      error: discovered.error,
      hint: discovered.hint,
    }
    runtime.lastDiscoverAt = Date.now()
    return runtime.bridge
  }

  /** 把当前 jar 注入到指定 webview 目标；reload 规则由调用方决定。 */
  async function injectTargets(webviews, settings) {
    const jar = runtime.jar
    const results = []
    for (const target of webviews) {
      const firstTime = !runtime.injected.has(target.id)
      const realUrl = Boolean(target.url) && target.url !== 'about:blank' && !target.url.startsWith('about:')
      // target.url 可能只是 DSH 首次导航的“待提交地址”，injectToTarget 内部还会等 guest
      // 真正加载完成（readyState==='complete'）后才刷新，避免打断 DSH 的 loadURL。
      const reload = firstTime && settings.reloadAfterInject && realUrl
      const result = await injectToTarget({ target, cookies: jar.cdpCookies, reload })
      results.push(result)
      if (result.ok) runtime.injected.set(target.id, { url: target.url, at: Date.now() })
    }
    return results
  }

  function summarizeInjectResults(results) {
    const ok = results.length > 0 && results.every((result) => result.ok)
    runtime.lastInject = {
      at: Date.now(),
      ok,
      count: runtime.jar.cdpCookies.length,
      targets: results,
      error: ok ? null : results.find((result) => !result.ok)?.error || '注入失败',
    }
    return runtime.lastInject
  }

  /** 手动"同步并注入"：强制重读 cookie 数据库，再注入所有现存 webview。 */
  async function syncAndInject() {
    const settings = await ensureSettings()
    await ensureJar(true)
    if (runtime.jar.error && runtime.jar.cdpCookies.length === 0) {
      return { ok: false, error: runtime.jar.error, targets: [] }
    }
    const bridge = await refreshBridge(runtime.bridge.available ? false : true)
    if (!bridge.available) {
      runtime.lastInject = { at: Date.now(), ok: false, count: runtime.jar.cdpCookies.length, targets: [], error: bridge.error }
      return { ok: false, error: bridge.error, targets: [] }
    }
    let webviews = []
    try {
      webviews = await listWebviews(bridge.port)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), targets: [] }
    }
    runtime.injecting = true
    let results = []
    try {
      results = await injectTargets(webviews, settings)
    } finally {
      runtime.injecting = false
    }
    const summary = summarizeInjectResults(results)
    return { ok: summary.ok, error: summary.error, targets: results }
  }

  /** 自动注入循环：桥可用时，为每个新出现的 webview 目标注入一次。 */
  async function tick() {
    const settings = await ensureSettings()
    if (!settings.autoInject || runtime.injecting) return
    if (!runtime.bridge.available) {
      if (Date.now() - runtime.lastDiscoverAt < DISCOVER_RETRY_MS) return
      await refreshBridge(true)
      if (!runtime.bridge.available) return
    }
    let webviews = []
    try {
      webviews = await listWebviews(runtime.bridge.port)
    } catch (error) {
      runtime.bridge.available = false
      runtime.bridge.error = error instanceof Error ? error.message : String(error)
      return
    }
    runtime.bridge.targets = webviewSummaries(webviews)
    runtime.bridge.checkedAt = Date.now()
    const alive = new Set(webviews.map((target) => target.id))
    for (const id of [...runtime.injected.keys()]) if (!alive.has(id)) runtime.injected.delete(id)
    const freshTargets = webviews.filter((target) => !runtime.injected.has(target.id))
    if (freshTargets.length === 0) return
    const jar = await ensureJar(false)
    if (!jar.loaded || jar.cdpCookies.length === 0) return
    runtime.injecting = true
    try {
      const results = await injectTargets(freshTargets, settings)
      summarizeInjectResults(results)
    } finally {
      runtime.injecting = false
    }
  }

  /** 生成自动桥接重启脚本（脚本主体在 lib/relaunch-shell.mjs，可单测）。 */
  function relaunchShell({ logFile, port, appBundle, executableName }) {
    const bundle = appBundle || `/Applications/${appName}.app`
    const executable = executableName || appName
    const settingsDir = runtime.settingsDir || dirname(logFile)
    return buildRelaunchScript({
      appBundle: bundle,
      executableName: executable,
      port,
      logFile,
      resultFile: join(settingsDir, RELAUNCH_RESULT_FILE),
    })
  }

  /** 以带调试端口的方式自动重启 DSH（脱离父进程执行，应用退出后脚本继续）。 */
  async function relaunchWithBridge(overrides = {}) {
    const settings = await ensureSettings()
    const port = settings.cdpPort > 0 ? settings.cdpPort : 9222
    const logFile = join(runtime.settingsDir || '.', 'relaunch.log')
    // 清掉旧结果，避免下次启动把上一轮的成功/失败当成这一轮的
    await clearRelaunchResult(runtime.settingsDir || '.').catch(() => {})
    const script = relaunchShell({
      logFile,
      port,
      appBundle: overrides.appBundle,
      executableName: overrides.executableName,
    })
    try {
      const child = spawn('/bin/zsh', ['-c', script], { detached: true, stdio: 'ignore', cwd: homedir() })
      child.unref()
      return {
        ok: true,
        port,
        logPath: logFile,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  /**
   * 读取宿主父进程（Electron 主进程）的命令行，识别它是否 DSH 桌面应用、启动时是否带调试端口。
   * 这是「自动带端口重启」的唯一判据：只有确认父进程是桌面应用且没有端口时才重启，
   * 命令行在系统里由进程自己持有，不依赖端口探测（避免端口就绪慢导致误重启）。
   * @returns {Promise<{isDesktopApp: boolean, hasDebugPort: boolean, port: number|null, appBundle: string|null, executableName: string|null, command: string}>}
   */
  async function detectHostParent() {
    if (runtime.parentInfo !== null) return runtime.parentInfo
    const pid = Number(process.ppid)
    const command = await new Promise((resolve) => {
      if (!Number.isInteger(pid) || pid <= 1) return resolve('')
      execFile('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        resolve(error ? '' : String(stdout || ''))
      })
    })
    runtime.parentInfo = { ...parseHostParentCommand(command), command: String(command).trim().slice(0, 500) }
    return runtime.parentInfo
  }

  /**
   * 启动自检：DSH 桌面应用若没带 `--remote-debugging-port` 启动，自动带端口重启一次，
   * 让用户正常启动也能用内置浏览器免登录，无需手动点按钮或换启动器。
   * 通过 `$DSH_HOME/browser-plus/auto-bridge.json` 防抖，避免反复重启。
   */
  async function runAutoBridge() {
    if (runtime.autoBridge.checked === true) return
    runtime.autoBridge.checked = true
    try {
      const settings = await ensureSettings()
      const parent = await detectHostParent()
      const storedMarker = await readAutoBridgeMarker(runtime.settingsDir)
      // 上一次重启脚本写过结果文件（ok/failed）：比标记新时把结果合并进来，
      // 让「上次失败」可以在 1 分钟后重试，而不是傻等 10 分钟。
      const lastResult = await readRelaunchResult(runtime.settingsDir)
      const marker =
        lastResult !== null && (storedMarker === null || lastResult.at >= (storedMarker.lastAt || 0))
          ? { ...(storedMarker || { attempts: 0, lastAt: 0, port: null }), outcome: lastResult.outcome, resultAt: lastResult.at }
          : storedMarker
      const outcome = marker && marker.outcome ? marker.outcome : null
      const plan = planAutoBridge({ platform: platform(), settings, parent, marker, now: Date.now() })
      if (plan.action === 'reset') {
        await clearAutoBridgeMarker(runtime.settingsDir)
        await clearRelaunchResult(runtime.settingsDir).catch(() => {})
        runtime.autoBridge = { ...runtime.autoBridge, enabled: settings.autoBridge === true, action: 'already-ported', reason: plan.reason, attempts: 0, lastAt: plan.lastAt, lastOutcome: outcome, maxAttempts: AUTO_BRIDGE_MAX_ATTEMPTS }
        log('调试端口已在启动参数中，自动桥接无需重启')
        return
      }
      if (plan.action === 'skip') {
        runtime.autoBridge = { ...runtime.autoBridge, enabled: settings.autoBridge === true, action: 'skip', reason: plan.reason, attempts: plan.attempts, lastAt: plan.lastAt, lastOutcome: outcome, maxAttempts: AUTO_BRIDGE_MAX_ATTEMPTS }
        if (plan.reason === 'recent-attempt') {
          const failed = outcome === 'failed'
          log(
            failed
              ? `自动桥接：上次自动重启未把调试端口带起来（${Math.round((Date.now() - (plan.lastAt || 0)) / 1000)}s 前）；本实例保持现状，下次启动会自动重试`
              : `自动桥接：最近 ${Math.round(AUTO_BRIDGE_GUARD_MS / 60000)} 分钟内已尝试过重启，跳过以避免循环`,
          )
        }
        if (plan.reason === 'max-attempts') {
          log(`自动桥接：连续 ${AUTO_BRIDGE_MAX_ATTEMPTS} 次未成功，进入长冷却；之后的下一次启动会再自动尝试`)
        }
        return
      }
      // relaunch：先确认可以从父进程路径重新启动它（避免「只退出、没重开」）
      const appBundle = parent.appBundle
      const executableName = parent.executableName
      if (typeof appBundle !== 'string' || typeof executableName !== 'string') {
        runtime.autoBridge = { ...runtime.autoBridge, enabled: true, action: 'skip', reason: 'no-app-path', attempts: plan.attempts, lastAt: plan.lastAt }
        log('自动桥接：无法从父进程识别 DSH 应用路径，跳过自动重启')
        return
      }
      try {
        await stat(join(appBundle, 'Contents', 'MacOS', executableName))
      } catch {
        runtime.autoBridge = { ...runtime.autoBridge, enabled: true, action: 'skip', reason: 'app-path-missing', attempts: plan.attempts, lastAt: plan.lastAt }
        log(`自动桥接：应用路径不存在（${appBundle}），跳过自动重启`)
        return
      }
      const port = settings.cdpPort > 0 ? settings.cdpPort : 9222
      const marked = await writeAutoBridgeMarker(runtime.settingsDir, {
        attempts: plan.attempts,
        lastAt: plan.lastAt,
        port,
        outcome: null,
      })
      if (!marked) {
        // 防循环标记写不进去就不重启：宁可本次不启用，也不能变成每次启动都重启
        runtime.autoBridge = { ...runtime.autoBridge, enabled: true, action: 'skip', reason: 'marker-write-failed', attempts: plan.attempts, lastAt: plan.lastAt }
        log('自动桥接：无法写入防循环标记，跳过自动重启')
        return
      }
      runtime.autoBridge = {
        ...runtime.autoBridge,
        enabled: true,
        action: 'relaunching',
        reason: plan.reason,
        attempts: plan.attempts,
        lastAt: plan.lastAt,
        port,
        lastOutcome: outcome,
        maxAttempts: AUTO_BRIDGE_MAX_ATTEMPTS,
        error: null,
      }
      log(`未检测到调试端口：自动以 --remote-debugging-port=${port} 重启 DSH（第 ${plan.attempts} 次）`)
      const result = await relaunchWithBridge({ appBundle, executableName })
      if (!result.ok) {
        runtime.autoBridge = { ...runtime.autoBridge, action: 'failed', error: result.error || '重启命令执行失败' }
        log(`自动桥接重启失败：${result.error || '未知原因'}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.autoBridge = { ...runtime.autoBridge, action: 'error', error: message }
      log(`自动桥接自检失败：${message}`)
    }
  }

  function jarState() {
    const jar = runtime.jar
    return {
      loaded: jar.loaded,
      count: jar.summary ? jar.summary.count : 0,
      domainCount: jar.summary ? jar.summary.domainCount : 0,
      httpOnly: jar.summary ? jar.summary.httpOnly : 0,
      secure: jar.summary ? jar.summary.secure : 0,
      session: jar.summary ? jar.summary.session : 0,
      topDomains: jar.summary ? jar.summary.topDomains : [],
      browser: jar.browser,
      profile: jar.profile,
      profileName: jar.profileName,
      loadedAt: jar.loadedAt || null,
      durationMs: jar.durationMs,
      error: jar.error,
    }
  }

  function bridgeState() {
    const bridge = runtime.bridge
    return {
      available: bridge.available,
      port: bridge.port,
      source: bridge.source,
      version: bridge.version,
      userDataDir: bridge.userDataDir,
      targets: bridge.targets,
      checkedAt: bridge.checkedAt || null,
      error: bridge.error,
      hint: bridge.hint,
    }
  }

  function platformState() {
    const os = platform()
    const jarError = runtime.jar.error || ''
    const keychain =
      /keychain|钥匙串|security/i.test(jarError) ? 'denied' : runtime.jar.loaded ? 'ok' : 'unknown'
    return {
      os,
      supported: os === 'darwin',
      keychain,
      note:
        os === 'darwin'
          ? ''
          : '当前版本只支持在 macOS 上解密 Chrome/Edge 的 Cookie（Windows 需另接 DPAPI，暂未实现）。',
    }
  }

  async function getState({ refresh = false } = {}) {
    const settings = await ensureSettings()
    const browsers = await ensureCatalog(refresh)
    await refreshBridge(refresh)
    if (refresh || !runtime.jar.loaded) await ensureJar(refresh)
    const source = pickSource(settings, browsers)
    return {
      ok: true,
      platform: platformState(),
      settings,
      browsers,
      activeSource: source,
      bridge: bridgeState(),
      jar: jarState(),
      lastInject: runtime.lastInject,
      autoBridge: runtime.autoBridge,
      host: runtime.parentInfo === null
        ? null
        : {
            isDesktopApp: runtime.parentInfo.isDesktopApp,
            hasDebugPort: runtime.parentInfo.hasDebugPort,
            debugPort: runtime.parentInfo.port,
            appBundle: runtime.parentInfo.appBundle,
            executableName: runtime.parentInfo.executableName,
          },
    }
  }

  // ───────────────────────────── HTTP API（浏览器半设置页） ─────────────────────────────

  function jsonResponse(res, body, code = 200) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    } catch {}
  }

  async function readJsonBody(req) {
    const chunks = []
    await new Promise((resolve) => {
      if (typeof req.on !== 'function') return resolve()
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
      req.on('end', resolve)
      req.on('error', resolve)
    })
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  const handleState = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || ''))
      jsonResponse(res, await getState({ refresh }))
    } catch (error) {
      jsonResponse(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  const handleSettings = async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : body
      const result = await saveSettings(options, patch)
      if (result.errors.length > 0) {
        jsonResponse(res, { ok: false, error: result.errors.join('；'), settings: result.settings }, 400)
        return
      }
      runtime.settings = result.settings
      runtime.settingsDir = result.dir
      // 设置页切换「自动启用桥接」后立即反映到状态里（真正的重启自检只在应用启动时跑一次）
      const autoBridgeOn = result.settings.autoBridge === true
      runtime.autoBridge = { ...runtime.autoBridge, enabled: autoBridgeOn }
      if (!autoBridgeOn) runtime.autoBridge = { ...runtime.autoBridge, action: 'skip', reason: 'disabled' }
      else if (runtime.autoBridge.reason === 'disabled') runtime.autoBridge = { ...runtime.autoBridge, action: 'pending', reason: null }
      // 过滤条件/端口可能变化：让 jar 下次重新过滤读取，并让桥按新端口重新发现
      runtime.jar.filterKey = ''
      runtime.bridge = {
        available: false,
        port: null,
        source: null,
        version: null,
        userDataDir: null,
        targets: [],
        checkedAt: 0,
        error: null,
        hint: runtime.bridge.hint,
      }
      runtime.lastDiscoverAt = 0
      jsonResponse(res, { ok: true, settings: runtime.settings })
    } catch (error) {
      jsonResponse(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  const handleAction = async (req, res) => {
    try {
      const body = await readJsonBody(req)
      const action = String(body.action || '')
      if (action === 'sync') {
        const result = await syncAndInject()
        jsonResponse(res, { ok: result.ok, message: result.ok ? `已注入 ${runtime.jar.cdpCookies.length} 条 Cookie` : result.error, state: await getState({}) })
        return
      }
      if (action === 'inject') {
        const settings = await ensureSettings()
        await ensureJar(false)
        const bridge = await refreshBridge(runtime.bridge.available ? false : true)
        if (!bridge.available) {
          jsonResponse(res, { ok: false, error: bridge.error, state: await getState({}) })
          return
        }
        const webviews = await listWebviews(bridge.port)
        runtime.injecting = true
        let results = []
        try {
          results = await injectTargets(webviews, settings)
        } finally {
          runtime.injecting = false
        }
        const summary = summarizeInjectResults(results)
        jsonResponse(res, { ok: summary.ok, message: summary.ok ? `已注入 ${results.length} 个标签` : summary.error, state: await getState({}) })
        return
      }
      if (action === 'rescan') {
        runtime.catalog.at = 0
        runtime.lastDiscoverAt = 0
        runtime.bridge.checkedAt = 0
        jsonResponse(res, { ok: true, message: '已重新扫描', state: await getState({ refresh: true }) })
        return
      }
      jsonResponse(res, { ok: false, error: `未知 action：${action || '(空)'}` }, 400)
    } catch (error) {
      jsonResponse(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    const register = (path, handler) => webCtx.effect(() => webServer.register({ kind: 'exact', path, handler }))
    register(`${API_PREFIX}/state`, handleState)
    register(`${API_PREFIX}/settings`, handleSettings)
    register(`${API_PREFIX}/action`, handleAction)
    log('HTTP API 已注册：/api/browser-plus/{state,settings,action}')
  })

  // ───────────────────────────── agent 工具 ─────────────────────────────

  const textOutput = () => ({
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : '') }],
  })

  function statusText(state) {
    const lines = []
    const bridge = state.bridge
    lines.push(
      bridge.available
        ? `CDP 桥：可用 · 端口 ${bridge.port} · ${bridge.targets.length} 个内置浏览器标签（${bridge.version || 'Electron'}）`
        : `CDP 桥：未启用 — ${bridge.error || '未知原因'}`,
    )
    if (!bridge.available) {
      lines.push('自动启用：插件会在 DSH 启动时自动带调试端口重启一次（无需任何操作）；失败会在下次启动自动重试。')
      lines.push('日志：$DSH_HOME/browser-plus/relaunch.log')
    }
    const jar = state.jar
    lines.push(
      jar.loaded
        ? `Cookie：${jar.count} 条 / ${jar.domainCount} 个域名（HttpOnly ${jar.httpOnly}，会话 ${jar.session}）· 来源 ${state.activeSource ? state.activeSource.label : '未知'}`
        : `Cookie：尚未读取${jar.error ? `（${jar.error}）` : ''}`,
    )
    lines.push(`自动注入：${state.settings.autoInject ? '开' : '关'}｜共享范围：${state.settings.scope === 'all' ? '全部域名' : `指定 ${state.settings.domains.length} 个域名`}`)
    const auto = state.autoBridge
    if (auto) {
      const actionLabels = {
        pending: '等待自检',
        'already-ported': '启动参数已带调试端口',
        skip: `跳过（${auto.reason || '未知原因'}）`,
        relaunching: `已自动带端口重启（第 ${auto.attempts} 次）`,
        failed: `自动重启失败（${auto.error || '未知原因'}）`,
        error: `自检失败（${auto.error || '未知原因'}）`,
      }
      lines.push(
        `自动启用桥接：${auto.enabled === false ? '关' : '开'}｜${actionLabels[auto.action] || auto.action}` +
          (auto.port ? `｜端口 ${auto.port}` : ''),
      )
      if (auto.action === 'skip' && auto.reason === 'recent-attempt') {
        lines.push('（最近自动重启过，本次跳过以避免循环；下次启动会自动重试）')
      }
    }
    if (state.lastInject && state.lastInject.at) {
      lines.push(
        `上次注入：${new Date(state.lastInject.at).toLocaleString()} · ${state.lastInject.ok ? '成功' : `失败（${state.lastInject.error}）`} · ${state.lastInject.targets.length} 个标签`,
      )
    }
    return lines.join('\n')
  }

  ctx.tools.register({
    name: 'browser_plus',
    description: [
      'Browser Plus：管理「把用户 Chrome/Edge 的登录 Cookie 注入 DSH 内置浏览器」的桥接。',
      'status：CDP 桥 / cookie 来源 / 自动注入状态（不含任何 cookie 名值）；',
      'sync：重读用户浏览器 Cookie 并注入当前所有内置浏览器标签；',
      'domains：列出同步范围内 cookie 最多的域名（只给域名与条数）。',
      '只在用户要求"免登录 / 共享 cookie / 内置浏览器登录态"时使用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'sync', 'domains'], description: '要执行的动作' },
        cdpPort: { type: 'number', description: '仅本次调用使用的 CDP 端口覆盖（调试用，通常省略）' },
      },
      required: ['action'],
    },
    output: textOutput(),
    async execute(args) {
      try {
        const action = String((args && args.action) || 'status')
        const portOverride = Number(args && args.cdpPort)
        runtime.cdpPortOverride = Number.isInteger(portOverride) && portOverride > 0 ? portOverride : undefined
        try {
          if (action === 'sync') {
            const result = await syncAndInject()
            const state = await getState({})
            const lines = [result.ok ? `已同步并注入：${runtime.jar.cdpCookies.length} 条 Cookie → ${result.targets.length} 个标签` : `注入失败：${result.error}`]
            for (const item of result.targets) {
              lines.push(`- ${item.ok ? '✓' : '✗'} ${item.url || item.id}${item.reloaded ? '（已刷新页面）' : ''}${item.ok ? '' : `：${item.error}`}`)
            }
            lines.push('', statusText(state))
            return { text: lines.join('\n') }
          }
          if (action === 'domains') {
            await ensureJar(false)
            if (!runtime.jar.loaded) return { text: `Cookie 尚未读取：${runtime.jar.error || '未知原因'}` }
            const top = runtime.jar.summary ? runtime.jar.summary.topDomains : []
            const lines = [`同步范围内共 ${runtime.jar.summary.count} 条 Cookie / ${runtime.jar.summary.domainCount} 个域名，Top ${top.length}：`]
            for (const item of top) lines.push(`- ${item.domain}  ${item.count} 条`)
            return { text: lines.join('\n') }
          }
          const state = await getState({ refresh: false })
          return { text: statusText(state) }
        } finally {
          runtime.cdpPortOverride = undefined
        }
      } catch (error) {
        return { text: `browser_plus 执行失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  // ───────────────────────────── 自动注入循环 ─────────────────────────────

  ctx.effect(() => {
    let stopped = false
    const run = async () => {
      if (stopped) return
      try {
        await tick()
      } catch (error) {
        log(`自动注入循环错误：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const timer = setInterval(run, POLL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    run()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'browser-plus:auto-inject')

  // 启动自检：正常启动（未带调试端口）时自动带端口重启，用户无需手动点击/换启动器。
  settingsReady
    .then(() => {
      const timer = setTimeout(() => {
        void runAutoBridge()
      }, AUTO_BRIDGE_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
    })
    .catch((error) => {
      log(`自动桥接调度失败：${error instanceof Error ? error.message : String(error)}`)
    })

  void settingsReady
}
