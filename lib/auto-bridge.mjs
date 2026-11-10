/**
 * 启动时自动启用 CDP 桥：判断当前 DSH 桌面实例是否缺少调试端口，
 * 以及在哪种情况下自动以 `--remote-debugging-port` 重新启动应用。
 *
 * 背景：Electron 的调试端口只能在应用启动时打开；插件拿不到 Electron session，
 * 所以「内置浏览器免登录」必须以调试端口启动应用。为了让用户正常启动也能用，
 * 这里在 DSH 启动后自检一次：如果确认是桌面应用、且启动参数里没有调试端口，
 * 就自动退出并带端口重开（用户无感，最多一次短暂重启）。
 *
 * 防抖：重启标记写到 `$DSH_HOME/browser-plus/auto-bridge.json`。
 * 若最近 GUARD 时间内已经尝试过重启（典型情况：被重启出来的新实例仍然没有端口，
 * 或刚失败过），就不再重启，避免无限循环；超过 GUARD 后的下一次正常启动会再试。
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 同一窗口内不重复自动重启的时间窗（毫秒）。 */
export const AUTO_BRIDGE_GUARD_MS = 10 * 60_000

/** 失败后允许重试的最小间隔（毫秒）：上一次重启没把端口带起来时，不必等满 GUARD。 */
export const AUTO_BRIDGE_RETRY_AFTER_MS = 60_000

/** 最多自动尝试次数（含失败重试）。超过后进入长冷却，而不是永远不再自动启用。 */
export const AUTO_BRIDGE_MAX_ATTEMPTS = 3

/** 连续失败达到上限后的长冷却时间：冷却期过了的下一次冷启动仍会自动再试一次。 */
export const AUTO_BRIDGE_LONG_COOLDOWN_MS = 30 * 60_000

/** 最近一次重启结果文件（由 relaunch shell 写入）。 */
export const RELAUNCH_RESULT_FILE = 'relaunch-result.json'

/** 自动重启标记文件名。 */
export const AUTO_BRIDGE_MARKER_FILE = 'auto-bridge.json'

/**
 * 纯决策函数：给定平台、设置、宿主父进程信息与上次重启标记，返回动作。
 *
 * - `reset`：应用已经带调试端口（或已在端口上），清掉上次标记即可；
 * - `skip`：不重启（平台不支持 / 设置关闭 / 不是桌面应用 / 刚尝试过且上次未必失败）；
 * - `relaunch`：确认缺少调试端口，自动带端口重启（上次结果 `failed` 时一分钟即可重试，
 *   最多 AUTO_BRIDGE_MAX_ATTEMPTS 次）。
 *
 * @param {{
 *   platform: string,
 *   settings: { autoBridge?: boolean } | null | undefined,
 *   parent: { isDesktopApp?: boolean, hasDebugPort?: boolean } | null | undefined,
 *   marker: { attempts?: number, lastAt?: number } | null | undefined,
 *   now: number,
 * }} input
 * @returns {{action: 'reset'|'skip'|'relaunch', reason: string, attempts: number, lastAt: number|null}}
 */
export function planAutoBridge({ platform, settings, parent, marker, now }) {
  const attempts = marker && Number.isFinite(marker.attempts) ? marker.attempts : 0
  const lastAt = marker && Number.isFinite(marker.lastAt) ? marker.lastAt : null
  if (platform !== 'darwin') return { action: 'skip', reason: 'platform', attempts, lastAt }
  if (!settings || settings.autoBridge !== true) return { action: 'skip', reason: 'disabled', attempts, lastAt }
  if (!parent || parent.isDesktopApp !== true) return { action: 'skip', reason: 'not-desktop', attempts, lastAt }
  if (parent.hasDebugPort === true) return { action: 'reset', reason: 'debug-port-present', attempts, lastAt }
  const outcome = marker && typeof marker.outcome === 'string' ? marker.outcome : null
  if (lastAt !== null && now - lastAt < AUTO_BRIDGE_GUARD_MS) {
    // 上一次自动重启「确认失败」（新实例仍没有端口）→ 隔一分钟后允许重试，不必等满 GUARD；
    // 但总尝试次数有上限，避免重启循环。
    const failedRecently = outcome === 'failed' && now - lastAt >= AUTO_BRIDGE_RETRY_AFTER_MS
    if (failedRecently && attempts < AUTO_BRIDGE_MAX_ATTEMPTS) {
      return { action: 'relaunch', reason: 'retry-after-failure', attempts: attempts + 1, lastAt: now }
    }
    return { action: 'skip', reason: 'recent-attempt', attempts, lastAt }
  }
  // 连续失败达到上限：进入长冷却（30 分钟），冷却过后的冷启动会再自动试一次。
  if (outcome === 'failed' && attempts >= AUTO_BRIDGE_MAX_ATTEMPTS && lastAt !== null && now - lastAt < AUTO_BRIDGE_LONG_COOLDOWN_MS) {
    return { action: 'skip', reason: 'max-attempts', attempts, lastAt }
  }
  if (outcome === 'failed' && attempts >= AUTO_BRIDGE_MAX_ATTEMPTS) {
    // 长冷却结束：重新给一次机会（失败次数从 0 重新累计，避免计数器永远卡死）。
    return { action: 'relaunch', reason: 'cooldown-expired', attempts: 1, lastAt: now }
  }
  return { action: 'relaunch', reason: 'missing-debug-port', attempts: attempts + 1, lastAt: now }
}

/**
 * 读取上次自动重启标记。
 * @param {string} dir - 设置目录（$DSH_HOME/browser-plus）
 * @returns {Promise<{attempts: number, lastAt: number, port: number|null} | null>}
 */
export async function readAutoBridgeMarker(dir) {
  try {
    const text = await readFile(join(dir, AUTO_BRIDGE_MARKER_FILE), 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      attempts: Number.isFinite(parsed.attempts) ? parsed.attempts : 0,
      lastAt: Number.isFinite(parsed.lastAt) ? parsed.lastAt : 0,
      port: Number.isFinite(parsed.port) ? parsed.port : null,
      outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null,
      resultAt: Number.isFinite(parsed.resultAt) ? parsed.resultAt : null,
    }
  } catch {
    return null
  }
}

/**
 * 写入自动重启标记（重启前调用）。
 * @param {string} dir - 设置目录
 * @param {{attempts: number, lastAt: number, port?: number|null}} marker
 */
export async function writeAutoBridgeMarker(dir, marker) {
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, AUTO_BRIDGE_MARKER_FILE),
      `${JSON.stringify(
        {
          attempts: marker.attempts,
          lastAt: marker.lastAt,
          port: marker.port ?? null,
          outcome: marker.outcome ?? null,
          resultAt: marker.resultAt ?? null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 清除自动重启标记（确认端口已启用，或测试用）。
 * @param {string} dir - 设置目录
 */
export async function clearAutoBridgeMarker(dir) {
  try {
    await unlink(join(dir, AUTO_BRIDGE_MARKER_FILE))
    return true
  } catch {
    return false
  }
}

/**
 * 从宿主进程的父进程命令行里识别桌面应用与调试端口。
 *
 * @param {string} command - `ps -ww -o command= -p <ppid>` 的输出
 * @returns {{isDesktopApp: boolean, hasDebugPort: boolean, port: number|null, appBundle: string|null, executableName: string|null}}
 */
export function parseHostParentCommand(command) {
  const text = String(command || '').trim()
  if (!text) return { isDesktopApp: false, hasDebugPort: false, port: null, appBundle: null, executableName: null }
  // 应用名可以含空格（如 DeepSeek Harness）：取 /Contents/MacOS/ 到第一个「空格+-」参数之前的整段
  const match = /^(.*?\.app)\/Contents\/MacOS\/(.+?)(?=\s+-|$)/u.exec(text)
  const appBundle = match ? match[1] : null
  const executableName = match ? match[2] : null
  const portMatch = /--remote-debugging-port(?:=|\s+)(\d+)/u.exec(text)
  const hasDebugPort = portMatch !== null
  return {
    // 归一化：必须像 DSH 桌面应用（有 .app 包 + MacOS 可执行文件）
    isDesktopApp: appBundle !== null && executableName !== null,
    hasDebugPort,
    port: hasDebugPort ? Number(portMatch[1]) : null,
    appBundle,
    executableName,
  }
}

/**
 * 读取 relaunch shell 写入的最近一次重启结果。
 * 结果比标记新时由调用方合并进 marker.outcome（用于"失败后允许重试"）。
 *
 * @param {string} dir - 设置目录（$DSH_HOME/browser-plus）
 * @returns {Promise<{outcome: 'ok'|'failed', at: number, port: number|null, detail: string|null} | null>}
 */
export async function readRelaunchResult(dir) {
  try {
    const text = await readFile(join(dir, RELAUNCH_RESULT_FILE), 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.outcome !== 'ok' && parsed.outcome !== 'failed') return null
    const at = Number.isFinite(parsed.at) ? parsed.at : 0
    return {
      outcome: parsed.outcome,
      at: at > 1e12 ? at : at * 1000,
      port: Number.isFinite(parsed.port) ? parsed.port : null,
      detail: typeof parsed.detail === 'string' ? parsed.detail : null,
    }
  } catch {
    return null
  }
}

/**
 * 清除最近重启结果文件。
 * @param {string} dir - 设置目录
 */
export async function clearRelaunchResult(dir) {
  try {
    await unlink(join(dir, RELAUNCH_RESULT_FILE))
    return true
  } catch {
    return false
  }
}
