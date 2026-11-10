/**
 * CDP 调试桥：发现本机 DSH 桌面应用的 DevTools 端点，枚举内置浏览器 webview 目标，
 * 并用 Network.setCookies 把目标浏览器的 cookie 写进对应分区。
 *
 * 背景（已实测 Electron 44 / Chromium 152）：
 * - 桌面应用以 --remote-debugging-port=<port> 启动时，内置浏览器（右侧栏 Browser 标签）的
 *   Electron <webview> 会作为 type: "webview" 的 target 出现在 GET /json/list 中，带
 *   webSocketDebuggerUrl；连上去发 Network.setCookies 即可写入该分区（含 HttpOnly）。
 * - 端口可用 0（随机），Chromium 会把实际端口写进 <userDataDir>/DevToolsActivePort。
 * - 分区是进程内存会话：应用重启即清空，所以注入是"每个新 target 一次"的动作。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

const DEFAULT_USER_DATA_DIR = (() => {
  const home = homedir()
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), '@deepseek-ai', 'dsh-desktop')
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), '@deepseek-ai', 'dsh-desktop')
})()

/** 桌面应用 renderer 的 URL 前缀，用来在多个 Electron 应用里识别出 DSH 自己。 */
const APP_TARGET_PREFIX = 'dsh-app://'

export function defaultUserDataDir() {
  return DEFAULT_USER_DATA_DIR
}

function withTimeout(promise, ms, message) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function httpJson(url, timeoutMs = 500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 读取 <userDataDir>/DevToolsActivePort（第一行端口，第二行浏览器 ws 路径）。 */
export async function readActivePort(userDataDir) {
  if (!userDataDir) return null
  try {
    const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')
    const port = Number(String(text).split(/\r?\n/)[0])
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    return null
  } catch {
    return null
  }
}

/** 在已知的 app data 根目录里扫描 DevToolsActivePort 文件，返回候选 {port,userDataDir}。 */
async function scanActivePorts() {
  const roots = []
  const home = homedir()
  if (platform() === 'darwin') roots.push(join(home, 'Library', 'Application Support'))
  else if (platform() === 'win32') roots.push(join(process.env.APPDATA || join(home, 'AppData', 'Roaming')))
  else roots.push(join(process.env.XDG_CONFIG_HOME || join(home, '.config')))
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).slice(0, 400)
    const probes = names.map(async (name) => {
      const dir = join(root, name)
      const port = await readActivePort(dir)
      if (port !== null) found.push({ port, userDataDir: dir, source: 'scan' })
    })
    await Promise.all(probes)
  }
  return found
}

/**
 * 探测一个端口是否是 Electron DevTools 端点。
 * @returns {Promise<{version:string, targets:any[]}|null>}
 */
async function probePort(port, timeoutMs) {
  try {
    const version = await httpJson(`http://127.0.0.1:${port}/json/version`, timeoutMs)
    const browser = String(version && version.Browser ? version.Browser : '')
    const userAgent = String(version && version['User-Agent'] ? version['User-Agent'] : '')
    // Electron 的 /json/version 里 Browser 只报 Chrome/x.y，Electron 版本在 User-Agent 中
    if (!/electron/i.test(`${browser} ${userAgent}`)) return null
    const targets = await httpJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
    if (!Array.isArray(targets)) return null
    return { browser, userAgent, targets }
  } catch {
    return null
  }
}

/**
 * 发现可用的 CDP 桥。
 * @param {{port?:number, userDataDir?:string, timeoutMs?:number}} options
 * @returns {Promise<{available:boolean, port:number|null, source:string|null, version:string|null, userDataDir:string|null, targets:any[], error:string|null, hint:string}>}
 */
export async function discoverBridge(options = {}) {
  const explicitPort = Number.isInteger(options.port) && options.port > 0 ? options.port : 0
  const explicitDir = typeof options.userDataDir === 'string' ? options.userDataDir.trim() : ''
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 500
  const hint = '内置浏览器 Cookie 注入需要桌面版 DSH 以 --remote-debugging-port 启动；详见本插件设置页「桥接状态」。'
  const candidates = []
  const seen = new Set()
  const add = (port, source, userDataDir) => {
    if (!Number.isInteger(port) || port <= 0 || seen.has(port)) return
    seen.add(port)
    candidates.push({ port, source, userDataDir: userDataDir || null })
  }

  add(explicitPort, 'configured')
  if (explicitDir) add(await readActivePort(explicitDir), 'user-data-dir', explicitDir)
  if (!explicitPort && !explicitDir) {
    add(await readActivePort(DEFAULT_USER_DATA_DIR), 'user-data-dir', DEFAULT_USER_DATA_DIR)
    for (const item of await scanActivePorts()) add(item.port, item.source, item.userDataDir)
  }

  for (const candidate of candidates) {
    const probed = await probePort(candidate.port, timeoutMs)
    if (probed === null) continue
    const hasAppTarget = probed.targets.some(
      (target) => typeof target.url === 'string' && target.url.startsWith(APP_TARGET_PREFIX),
    )
    const hasWebview = probed.targets.some((target) => target.type === 'webview')
    // 自动探测必须命中 DSH renderer；显式指定端口时放宽到"任意 Electron（且有 webview 或 DSH target）"
    const accepted = explicitPort || explicitDir ? hasAppTarget || hasWebview : hasAppTarget
    if (!accepted) continue
    const electron = /Electron\/([\w.-]+)/.exec(probed.userAgent)
    return {
      available: true,
      port: candidate.port,
      source: candidate.source,
      version: electron ? `Electron/${electron[1]}` : probed.browser,
      userDataDir: candidate.userDataDir || (await guessUserDataDir(candidate.port)),
      targets: probed.targets,
      error: null,
      hint,
    }
  }
  return {
    available: false,
    port: explicitPort || null,
    source: null,
    version: null,
    userDataDir: explicitDir || DEFAULT_USER_DATA_DIR,
    targets: [],
    error: explicitPort
      ? `端口 ${explicitPort} 没有可用的 Electron DevTools 端点（应用未以该端口启动？）`
      : '未在本机发现 DSH 桌面应用的 DevTools 端点（应用未以 --remote-debugging-port 启动）',
    hint,
  }
}

async function guessUserDataDir(port) {
  const scanned = await scanActivePorts()
  const hit = scanned.find((item) => item.port === port)
  return hit ? hit.userDataDir : null
}

/**
 * 列出 CDP 里的 webview 目标（内置浏览器标签）。
 * @returns {Promise<{id:string,url:string,title:string,parentId:string|null,webSocketDebuggerUrl:string}[]>}
 */
export async function listWebviews(port, timeoutMs = 800) {
  const targets = await httpJson(`http://127.0.0.1:${port}/json/list`, timeoutMs)
  if (!Array.isArray(targets)) return []
  return targets
    .filter((target) => target && target.type === 'webview' && typeof target.webSocketDebuggerUrl === 'string')
    .map((target) => ({
      id: String(target.id || ''),
      url: String(target.url || ''),
      title: String(target.title || ''),
      parentId: target.parentId === undefined ? null : String(target.parentId),
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }))
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {}
      reject(new Error('CDP WebSocket 打开超时'))
    }, timeoutMs)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(socket)
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 连接失败'))
      },
      { once: true },
    )
  })
}

function makeSender(socket, timeoutMs) {
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message && typeof message.id === 'number' && pending.has(message.id)) {
      const settle = pending.get(message.id)
      pending.delete(message.id)
      settle(message)
    }
  })
  return function send(method, params = {}, perCallTimeoutMs = timeoutMs) {
    const requestId = ++id
    return withTimeout(
      new Promise((resolve) => {
        pending.set(requestId, resolve)
        socket.send(JSON.stringify({ id: requestId, method, params }))
      }),
      perCallTimeoutMs,
      `${method} 超时`,
    ).finally(() => pending.delete(requestId))
  }
}

/**
 * 让被浏览页在 guest 内部刷新。
 *
 * 不能用 `Page.reload`：Electron 44 的内置浏览器 `<webview>` 目标上发 Page.reload，
 * 会把**宿主 DSH 页面**一起重载（界面闪一下、Browser 标签退回“恢复页面”检查点）。
 * `Runtime.evaluate('location.reload()')` 只跑在 guest 文档里，命令结束即返回、不占用后续会话。
 * @param send - 已连接的 CDP 发送函数
 * @returns 是否已发出刷新
 */
async function reloadGuest(send) {
  const reloaded = await send('Runtime.evaluate', { expression: 'location.reload()', awaitPromise: false }).catch(() => null)
  return Boolean(reloaded && !reloaded.error)
}

/** 刷新前等待页面加载完成的默认参数：最多等 15s，200ms 一轮；确认完成后缓 200ms 再刷。 */
const RELOAD_SETTLE_TIMEOUT_MS = 15000
const RELOAD_SETTLE_POLL_MS = 200
const RELOAD_SETTLE_GRACE_MS = 200

/**
 * 读取 guest 当前文档的状态（已提交地址 + readyState）。
 * 导航切换执行上下文时 Runtime.evaluate 会报错，这里视为“还没就绪”，返回 null。
 * @param send - 已连接的 CDP 发送函数
 * @returns {Promise<{href:string,ready:string}|null>}
 */
async function readGuestDocument(send) {
  const response = await send('Runtime.evaluate', {
    expression: '({ href: String(location.href), ready: String(document.readyState) })',
    returnByValue: true,
  }).catch(() => null)
  const value = response && response.result && response.result.result && response.result.result.value
  if (!value || typeof value !== 'object') return null
  return { href: String(value.href || ''), ready: String(value.ready || '') }
}

/**
 * 等 guest 真正停在一个加载完成的真实网页上，再在 guest 内部刷新。
 *
 * 为什么必须等：DSH 打开新标签时先给 webview 设 `src=about:blank#lease`，dom-ready 后再
 * `loadURL(目标地址)`；而 `/json/list` 里 target.url 在导航一开始就变成目标地址（早于提交），
 * `loadURL()` 的 promise 要到 load 结束（did-finish-load）才 resolve。此时直接
 * `location.reload()` 会顶掉 DSH 那次仍在进行中的导航，让它的 `loadURL()` 以
 * ERR_ABORTED 拒绝：DSH 只按 `error.code` 判断（IPC 回来的错误丢了 code、只剩 message），
 * 于是 Browser 标签显示「页面加载失败；请刷新重试或在系统浏览器中打开。」；若刷新还发生在
 * 首次导航提交之前，标签会停在 about:blank，只能手动刷新才恢复。
 * @param send - 已连接的 CDP 发送函数
 * @param {{timeoutMs?:number, pollMs?:number, graceMs?:number}} options - 等待参数（测试可覆盖）
 * @returns 是否已发出刷新（页面始终未加载完成时返回 false，宁可不刷也不打断 DSH）
 */
async function reloadWhenSettled(send, { timeoutMs = RELOAD_SETTLE_TIMEOUT_MS, pollMs = RELOAD_SETTLE_POLL_MS, graceMs = RELOAD_SETTLE_GRACE_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await readGuestDocument(send)
    if (state && state.ready === 'complete' && /^https?:\/\//i.test(state.href)) {
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs))
      return reloadGuest(send)
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * 把一个 cookie 列表写进某个 webview 目标的分区。
 * 先尝试批量 Network.setCookies；整批被拒时退化为逐条 Network.setCookie。
 * @param {{target: object, cookies: object[], reload?: boolean, timeoutMs?: number, connect?: (url: string) => Promise<WebSocket>,
 *   reloadTimeoutMs?: number, reloadPollMs?: number}} input
 *   `connect` 只供测试注入假 socket，生产调用省略；`reloadTimeoutMs/reloadPollMs` 仅测试用。
 * @returns {Promise<{id:string,url:string,ok:boolean,count:number,failed:number,reloaded:boolean,error:string|null}>}
 */
export async function injectToTarget({
  target,
  cookies,
  reload = false,
  timeoutMs = 6000,
  connect = openWebSocket,
  reloadTimeoutMs = RELOAD_SETTLE_TIMEOUT_MS,
  reloadPollMs = RELOAD_SETTLE_POLL_MS,
}) {
  const result = {
    id: target.id,
    url: target.url,
    ok: false,
    count: 0,
    failed: 0,
    reloaded: false,
    error: null,
  }
  if (!target || typeof target.webSocketDebuggerUrl !== 'string') {
    result.error = '无效的 webview 目标'
    return result
  }
  if (!Array.isArray(cookies) || cookies.length === 0) {
    result.ok = true
    return result
  }
  let socket
  try {
    socket = await withTimeout(connect(target.webSocketDebuggerUrl, 3000), timeoutMs, 'CDP 连接超时')
    const send = makeSender(socket, 4000)
    const enabled = await send('Network.enable', {})
    if (enabled.error) throw new Error(`Network.enable 失败：${enabled.error.message || 'unknown'}`)
    const batch = await send('Network.setCookies', { cookies }, 15000)
    if (batch.error) {
      // 批量被拒（通常是个别 cookie 字段不合法）：逐条写，失败的跳过
      for (const cookie of cookies) {
        const one = await send('Network.setCookie', cookie).catch(() => null)
        if (one && one.result && one.result.success) result.count += 1
        else result.failed += 1
      }
      if (result.count === 0) throw new Error(`写入全部失败：${batch.error.message || 'unknown'}`)
    } else {
      result.count = cookies.length
    }
    if (reload) {
      result.reloaded = await reloadWhenSettled(send, { timeoutMs: reloadTimeoutMs, pollMs: reloadPollMs })
    }
    result.ok = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  } finally {
    if (socket !== undefined) {
      try {
        socket.close()
      } catch {}
    }
  }
}

export { APP_TARGET_PREFIX }
