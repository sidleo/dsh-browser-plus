/**
 * 设置持久化：$DSH_HOME/browser-plus/settings.json（默认 ~/.dsh/browser-plus/settings.json）。
 *
 * 页面（浏览器半）通过 Host HTTP API 读写设置；cordis 配置只作为部署级覆盖：
 *   - config.settingsDir：覆盖存储目录
 *   - config.defaults：覆盖内置默认值（只读，不写回）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_SETTINGS = Object.freeze({
  /** 'auto' | 'edge' | 'chrome'；auto = 优先 Edge，其次 Chrome */
  browser: 'auto',
  /** '' = 该浏览器的 Default 配置；否则是 profile 目录名（如 'Profile 1'） */
  profile: '',
  /** 'all' | 'allowlist' */
  scope: 'all',
  /** allowlist 域名（'.example.com' 或 'example.com'，后缀匹配） */
  domains: [],
  /** 轮询新 webview target 自动注入 */
  autoInject: true,
  /**
   * 启动时自动检查调试端口：桌面应用若没带 --remote-debugging-port 启动，
   * 自动退出并带端口重开（用户正常启动也能免登录，无需手动点击）。
   */
  autoBridge: true,
  /** 是否同步会话 cookie（expires_utc=0） */
  includeSessionCookies: true,
  /** 0 = 自动发现 CDP 端口；否则强制该端口 */
  cdpPort: 0,
  /** '' = 自动（桌面应用默认 userDataDir）；否则指定 Electron userDataDir */
  userDataDir: '',
  /** 已加载页首次注入后 reload 一次 */
  reloadAfterInject: true,
  /** 自动模式下 jar 重读间隔（秒，10..3600） */
  refreshSeconds: 60,
})

const LIMITS = {
  refreshSeconds: [10, 3600],
  cdpPort: [0, 65535],
}

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** @param {string} dir */
export function settingsFile(dir) {
  return join(dir, 'settings.json')
}

/** 存储目录：config.settingsDir > $DSH_HOME/browser-plus */
export function resolveSettingsDir(config) {
  const override = config && typeof config.settingsDir === 'string' ? config.settingsDir.trim() : ''
  if (override) return expandHome(override)
  return join(dshHome(), 'browser-plus')
}

export function expandHome(value) {
  const text = String(value || '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 校验并规范化部分设置；返回 { value, errors }（errors 为空 = 可保存）。 */
export function normalizeSettings(patch, base = DEFAULT_SETTINGS) {
  const errors = []
  const value = { ...DEFAULT_SETTINGS, ...(base && typeof base === 'object' ? base : {}) }
  if (patch === undefined || patch === null) return { value, errors }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    return { value, errors: ['settings patch must be an object'] }
  }
  if ('browser' in patch) {
    const browser = String(patch.browser || '')
    if (!['auto', 'edge', 'chrome'].includes(browser)) errors.push(`不支持的浏览器：${browser || '(空)'}`)
    else value.browser = browser
  }
  if ('profile' in patch) value.profile = String(patch.profile || '').trim()
  if ('scope' in patch) {
    const scope = String(patch.scope || '')
    if (!['all', 'allowlist'].includes(scope)) errors.push(`不支持的共享范围：${scope || '(空)'}`)
    else value.scope = scope
  }
  if ('domains' in patch) {
    const raw = Array.isArray(patch.domains) ? patch.domains : String(patch.domains || '').split(/\s+/)
    const domains = raw
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
    if (domains.length > 200) errors.push('域名列表过长（≤200 条）')
    // 轻量校验：允许字母/数字/点/连字符（可带前导 '.'）；明显异常项拒绝保存
    const invalid = domains.filter((item) => item.length > 253 || !/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(item))
    if (invalid.length > 0) errors.push(`域名格式不支持：${invalid.slice(0, 3).join('、')}`)
    value.domains = [...new Set(domains)]
  }
  for (const key of ['autoInject', 'autoBridge', 'includeSessionCookies', 'reloadAfterInject']) {
    if (key in patch) value[key] = patch[key] === true
  }
  if ('cdpPort' in patch) {
    const port = Number(patch.cdpPort)
    if (!Number.isInteger(port) || port < LIMITS.cdpPort[0] || port > LIMITS.cdpPort[1]) {
      errors.push('cdpPort 需为 0..65535 的整数')
    } else value.cdpPort = port
  }
  if ('userDataDir' in patch) value.userDataDir = expandHome(String(patch.userDataDir || ''))
  if ('refreshSeconds' in patch) {
    const seconds = Number(patch.refreshSeconds)
    if (!Number.isInteger(seconds) || seconds < LIMITS.refreshSeconds[0] || seconds > LIMITS.refreshSeconds[1]) {
      errors.push(`refreshSeconds 需为 ${LIMITS.refreshSeconds[0]}..${LIMITS.refreshSeconds[1]} 的整数`)
    } else value.refreshSeconds = seconds
  }
  return { value, errors }
}

/** 读取设置（文件缺失/损坏时回落到默认值；config.defaults 作为第二层默认）。 */
export async function loadSettings(config) {
  const dir = resolveSettingsDir(config)
  const deployDefaults = config && config.defaults && typeof config.defaults === 'object' ? config.defaults : {}
  const base = normalizeSettings(deployDefaults, DEFAULT_SETTINGS).value
  let stored = {}
  try {
    const text = await readFile(settingsFile(dir), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
  } catch {
    stored = {}
  }
  const { value } = normalizeSettings(stored, base)
  return { settings: value, dir }
}

/** 合并并持久化部分设置；返回 { settings, errors, dir }。 */
export async function saveSettings(config, patch) {
  const dir = resolveSettingsDir(config)
  const current = await loadSettings(config)
  const { value, errors } = normalizeSettings(patch, current.settings)
  if (errors.length > 0) return { settings: current.settings, errors, dir }
  await mkdir(dir, { recursive: true })
  await writeFile(settingsFile(dir), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return { settings: value, errors: [], dir }
}

export { clone }
