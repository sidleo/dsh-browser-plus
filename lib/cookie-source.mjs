// Chrome/Edge Cookie 数据源：浏览器/profile 发现、Cookie DB 复制读取、macOS 解密、
// 过滤、CDP 转换与汇总。
//
// 安全红线（见 CONTRACT.md）：
// - 本模块不写任何日志；
// - 错误信息里不出现 cookie 的 name / value；
// - 只读真实浏览器数据库（复制到临时目录后读取，绝不写入原库）。
//
// macOS 解密方案（实测）：
//   encrypted_value = 'v10' + AES-128-CBC(PKCS#7(sha256(host_key) || value))
//   key = PBKDF2-HMAC-SHA1(keychain 密码, 'saltysalt', 1003, 16)，IV = 16 个 0x20。
//
// 导出（严格按 CONTRACT.md）：
//   BROWSERS / listBrowserCatalog / readCookies / filterCookies / toCdpCookie / summarize

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PLATFORM = process.platform;
const IS_DARWIN = PLATFORM === 'darwin';
const HOME = os.homedir();

// Chrome/Edge 时间戳：1601-01-01 起的微秒
const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;
const MICROS_PER_SECOND = 1e6;

// CDP Network.CookieParam.value 上限 4096 字节，超过的 cookie 直接跳过并计数
const MAX_COOKIE_VALUE_BYTES = 4096;

// macOS Safe Storage 派生参数（实测 Chrome 152 / Edge）
const KEYCHAIN_SALT = 'saltysalt';
const KEYCHAIN_ITERATIONS = 1003;
const KEYCHAIN_KEY_LENGTH = 16;
const AES_IV = Buffer.alloc(16, 0x20);
const ENCRYPTED_PREFIX_V10 = 'v10';

const SUPPORTED_PLATFORM_NOTE = 'cookie 解密目前仅支持 macOS（Chrome/Edge Safe Storage，v10 + AES-128-CBC）';

// Windows 下 Chrome/Edge 的 user data 根目录位于 %LOCALAPPDATA%
const WINDOWS_LOCAL_APP_DATA =
  typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA
    ? process.env.LOCALAPPDATA
    : path.join(HOME, 'AppData', 'Local');

/**
 * 支持的浏览器。顺序即 browser: 'auto' 的优先级：先 Edge，再 Chrome。
 * @type {Array<{id:string,name:string,keychainService:string,darwinDataDir:string,winDataDir:string,linuxDataDir:string}>}
 */
export const BROWSERS = [
  {
    id: 'edge',
    name: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    darwinDataDir: path.join(HOME, 'Library', 'Application Support', 'Microsoft Edge'),
    winDataDir: path.join(WINDOWS_LOCAL_APP_DATA, 'Microsoft', 'Edge', 'User Data'),
    linuxDataDir: path.join(HOME, '.config', 'microsoft-edge'),
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    darwinDataDir: path.join(HOME, 'Library', 'Application Support', 'Google', 'Chrome'),
    winDataDir: path.join(WINDOWS_LOCAL_APP_DATA, 'Google', 'Chrome', 'User Data'),
    linuxDataDir: path.join(HOME, '.config', 'google-chrome'),
  },
];

// 进程内缓存：keychain 条目存在性（不影响钥匙串 ACL，不会弹授权框）
const keychainExistsCache = new Map();
// 进程内缓存：keychain 密码（Promise，失败时清掉以便下次重试）
const keychainPasswordCache = new Map();

function browserDataDirForPlatform(browser) {
  if (PLATFORM === 'darwin') return browser.darwinDataDir;
  if (PLATFORM === 'win32') return browser.winDataDir;
  return browser.linuxDataDir;
}

function findBrowserById(id) {
  return BROWSERS.find((browser) => browser.id === id) || null;
}

function asString(value) {
  return value == null ? '' : String(value);
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function bumpCounter(counters, reason) {
  counters.set(reason, (counters.get(reason) || 0) + 1);
}

async function fileExists(target) {
  if (!target) return false;
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(target) {
  if (!target) return false;
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 读取 <dataDir>/Local State 里的 profile.info_cache（目录名 → 显示名）。
 * @returns {Promise<Map<string,string>>}
 */
async function readProfileInfoCache(dataDir) {
  const result = new Map();
  if (!dataDir) return result;
  const localState = await readJsonFile(path.join(dataDir, 'Local State'));
  const infoCache = localState && localState.profile && localState.profile.info_cache;
  if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return result;
  for (const [dirName, info] of Object.entries(infoCache)) {
    if (typeof dirName !== 'string' || !dirName) continue;
    const displayName =
      info && typeof info.name === 'string' && info.name.trim() ? info.name.trim() : dirName;
    result.set(dirName, displayName);
  }
  return result;
}

/** profile 目录下的 cookie 数据库路径（旧版在 profile/Cookies，新版可能在 profile/Network/Cookies）。 */
async function findCookieDbFile(profilePath) {
  const candidates = [path.join(profilePath, 'Cookies'), path.join(profilePath, 'Network', 'Cookies')];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * 列出某个浏览器数据目录下的 profile：Local State 优先，目录扫描兜底（存在 Cookies 的目录）。
 * Default 排在第一位。
 */
async function listProfiles(dataDir) {
  const profiles = [];
  const seen = new Set();

  const infoCache = await readProfileInfoCache(dataDir);
  for (const [id, name] of infoCache.entries()) {
    if (!(await directoryExists(path.join(dataDir, id)))) continue;
    seen.add(id);
    profiles.push({ id, name });
  }

  let entries = [];
  try {
    entries = await fs.readdir(dataDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const discovered = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !seen.has(entry.name))
      .map(async (entry) => {
        const dbPath = await findCookieDbFile(path.join(dataDir, entry.name));
        if (dbPath) discovered.push({ id: entry.name, name: entry.name });
      }),
  );
  discovered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  profiles.push(...discovered);

  const defaultIndex = profiles.findIndex((profile) => profile.id === 'Default');
  if (defaultIndex > 0) profiles.unshift(profiles.splice(defaultIndex, 1)[0]);
  return profiles;
}

/**
 * 把 Cookies / Cookies-wal / Cookies-shm 复制到临时目录，避免与正在运行的浏览器抢锁。
 * @param {string} dbPath 真实数据库路径（只读源）
 * @param {boolean} includeWal 是否带上 WAL/SHM（不一致时可退回只复制主库重试）
 */
async function copyCookieDbToTemp(dbPath, includeWal = true) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-'));
  const dest = path.join(tmpDir, 'Cookies');
  try {
    await fs.copyFile(dbPath, dest);
    if (includeWal) {
      for (const suffix of ['-wal', '-shm']) {
        try {
          await fs.copyFile(dbPath + suffix, dest + suffix);
        } catch {
          // 浏览器没在运行时通常没有这两个文件
        }
      }
    }
    return { tmpDir, dest };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

let sqliteModulePromise = null;
function loadSqlite() {
  if (!sqliteModulePromise) sqliteModulePromise = import('node:sqlite');
  return sqliteModulePromise;
}

/**
 * 在临时副本上执行只读查询；WAL 副本偶发不一致时退回"只复制主库"再试一次。
 * @template T
 * @param {string} dbPath
 * @param {(db: import('node:sqlite').DatabaseSync) => T} work
 * @returns {Promise<T>}
 */
async function withCookiesDbCopy(dbPath, work) {
  const { DatabaseSync } = await loadSqlite();
  let lastError = null;
  for (const includeWal of [true, false]) {
    let tmpDir = null;
    try {
      const copy = await copyCookieDbToTemp(dbPath, includeWal);
      tmpDir = copy.tmpDir;
      const db = new DatabaseSync(copy.dest);
      try {
        return await work(db);
      } finally {
        try {
          db.close();
        } catch {
          // 关闭失败不影响读取结果
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const detail = lastError && lastError.message ? lastError.message : 'unknown error';
  throw new Error(`读取 cookie 数据库失败：${dbPath}（${detail}）`);
}

// 只需要这些列；旧版数据库可能缺列，用列存在性检测 + SQL 兜底默认值。
const COOKIE_DB_FIELDS = [
  { name: 'host_key', fallback: "''" },
  { name: 'name', fallback: "''" },
  { name: 'value', fallback: "''" },
  { name: 'encrypted_value', fallback: 'NULL' },
  { name: 'path', fallback: "''" },
  { name: 'expires_utc', fallback: "'0'", castText: true },
  { name: 'is_secure', fallback: '0' },
  { name: 'is_httponly', fallback: '0' },
  { name: 'has_expires', fallback: '1' },
  { name: 'is_persistent', fallback: '1' },
  { name: 'samesite', fallback: '-1' },
  { name: 'source_scheme', fallback: '2' },
  { name: 'top_frame_site_key', fallback: "''" },
  { name: 'has_cross_site_ancestor', fallback: '0' },
];

// expires_utc 超出 JS 安全整数，必须 CAST 成 TEXT 读出来
function buildCookieSelectSql(db) {
  let columns;
  try {
    columns = db.prepare('PRAGMA table_info(cookies)').all();
  } catch {
    columns = [];
  }
  if (!columns.length) throw new Error('不是 Chrome/Edge 的 cookie 数据库（缺少 cookies 表）');
  const available = new Set(columns.map((column) => asString(column.name)));
  const selects = COOKIE_DB_FIELDS.map((field) => {
    if (!available.has(field.name)) return `${field.fallback} AS ${field.name}`;
    return field.castText ? `CAST(${field.name} AS TEXT) AS ${field.name}` : field.name;
  });
  return `SELECT ${selects.join(', ')} FROM cookies`;
}

async function readCookieRows(dbPath) {
  return withCookiesDbCopy(dbPath, (db) => db.prepare(buildCookieSelectSql(db)).all());
}

/** profile 的 cookie 条数：复制 DB + count(*)；浏览器占用/损坏时容忍失败返回 0。 */
async function countCookiesSafe(dbPath) {
  try {
    return await withCookiesDbCopy(dbPath, (db) => {
      const row = db.prepare('SELECT count(*) AS count FROM cookies').get();
      return toInteger(row && row.count, 0);
    });
  } catch {
    return 0;
  }
}

/**
 * 钥匙串条目是否存在。只用属性查询（不带 -w），不会触发钥匙串授权弹窗。
 * 真正的密码读取见 readKeychainPassword。
 */
async function isKeychainItemAvailable(service) {
  if (!IS_DARWIN || !service) return false;
  if (keychainExistsCache.has(service)) return keychainExistsCache.get(service);
  let available = false;
  try {
    await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', service], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    available = true;
  } catch {
    available = false;
  }
  keychainExistsCache.set(service, available);
  return available;
}

/**
 * 从 macOS 钥匙串读取 Safe Storage 密码（进程内缓存）。
 * 注意：这是明文密码，只在内存里用于派生 AES key，绝不外传/记录。
 */
function readKeychainPassword(service) {
  const cached = keychainPasswordCache.get(service);
  if (cached) return cached;
  if (!IS_DARWIN) {
    return Promise.reject(new Error(SUPPORTED_PLATFORM_NOTE));
  }
  const promise = execFileAsync(
    '/usr/bin/security',
    ['find-generic-password', '-w', '-s', service],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024 },
  )
    .then(({ stdout }) => {
      const password = asString(stdout).trim();
      if (!password) throw new Error(`钥匙串条目 “${service}” 的密码为空`);
      return password;
    })
    .catch((error) => {
      keychainPasswordCache.delete(service);
      const detail =
        error && error.code === 'ETIMEDOUT'
          ? '请求超时（可能需要在系统钥匙串弹窗中允许访问）'
          : asString((error && (error.stderr || error.message)) || '未知错误').trim();
      throw new Error(`无法从 macOS 钥匙串读取 “${service}” 的密码：${detail}`);
    });
  keychainPasswordCache.set(service, promise);
  return promise;
}

function deriveKey(password) {
  return crypto.pbkdf2Sync(
    Buffer.from(asString(password), 'utf8'),
    KEYCHAIN_SALT,
    KEYCHAIN_ITERATIONS,
    KEYCHAIN_KEY_LENGTH,
    'sha1',
  );
}

function printableVersion(version) {
  return /^[\x20-\x7e]{1,3}$/.test(version) ? version : `0x${Buffer.from(version).toString('hex')}`;
}

/**
 * 解密一条 macOS Chrome/Edge encrypted_value。
 * @returns {{ok:true, value:Buffer} | {ok:false, reason:string}} reason ∈
 *   'undecryptable' | 'bad-host-hash' | `unknown-version:<v>`
 */
function decryptCookieValue(encryptedValue, hostKey, key) {
  const blob = Buffer.isBuffer(encryptedValue) ? encryptedValue : Buffer.from(encryptedValue);
  if (blob.length < 4) return { ok: false, reason: 'undecryptable' };
  const version = blob.subarray(0, 3).toString('latin1');
  if (version !== ENCRYPTED_PREFIX_V10) {
    return { ok: false, reason: `unknown-version:${printableVersion(version)}` };
  }
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, AES_IV);
    decipher.setAutoPadding(false);
    plaintext = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    return { ok: false, reason: 'undecryptable' };
  }
  const padLength = plaintext.length ? plaintext[plaintext.length - 1] : 0;
  if (!padLength || padLength > 16 || padLength > plaintext.length) {
    return { ok: false, reason: 'undecryptable' };
  }
  for (let index = plaintext.length - padLength; index < plaintext.length; index += 1) {
    if (plaintext[index] !== padLength) return { ok: false, reason: 'undecryptable' };
  }
  const payload = plaintext.subarray(0, plaintext.length - padLength);
  if (payload.length < 32) return { ok: false, reason: 'undecryptable' };
  const expectedHash = crypto.createHash('sha256').update(hostKey, 'utf8').digest();
  if (!crypto.timingSafeEqual(payload.subarray(0, 32), expectedHash)) {
    return { ok: false, reason: 'bad-host-hash' };
  }
  return { ok: true, value: payload.subarray(32) };
}

/** cookies.samesite 列：-1 Unspecified / 0 None / 1 Lax / 2 Strict */
function sameSiteName(rawValue) {
  switch (toInteger(rawValue, -1)) {
    case 0:
      return 'None';
    case 1:
      return 'Lax';
    case 2:
      return 'Strict';
    default:
      return 'Unspecified';
  }
}

function normalizeProfileId(rawValue) {
  const profileId = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!profileId) return 'Default';
  if (profileId === '.' || profileId === '..' || /[\\/\0]/.test(profileId)) {
    throw new Error(`profile 名不合法：${profileId}`);
  }
  return profileId;
}

async function resolveBrowser(requestedId, dataDirOverride) {
  const requested = typeof requestedId === 'string' && requestedId ? requestedId : 'auto';
  if (requested !== 'auto') {
    const browser = findBrowserById(requested);
    if (!browser) {
      throw new Error(
        `未知浏览器：${requested}（可选：${BROWSERS.map((item) => item.id).join(' / ')} / auto）`,
      );
    }
    return browser;
  }
  // auto：优先 Edge，其次 Chrome；测试用 dataDir 覆盖时不需要探测安装状态
  if (typeof dataDirOverride === 'string' && dataDirOverride) return BROWSERS[0];
  for (const browser of BROWSERS) {
    if (await directoryExists(browserDataDirForPlatform(browser))) return browser;
  }
  throw new Error('未找到已安装的 Microsoft Edge 或 Google Chrome');
}

/**
 * 浏览器/profile 目录发现。
 * @param {{includeCounts?: boolean}} [opts] includeCounts=false 时不做 cookie 计数（默认 true）
 * @returns {Promise<Array<{id:string,name:string,installed:boolean,dataDir:string,keychainService:string,keychainAvailable:boolean,profiles:Array<{id:string,name:string,cookieCount:number}>}>>}
 */
export async function listBrowserCatalog(opts = {}) {
  const includeCounts = !opts || opts.includeCounts !== false;
  const catalog = [];
  for (const browser of BROWSERS) {
    const dataDir = browserDataDirForPlatform(browser);
    const installed = await directoryExists(dataDir);
    const profiles = installed ? await listProfiles(dataDir) : [];
    const withCounts = await Promise.all(
      profiles.map(async (profile) => {
        let cookieCount = 0;
        if (includeCounts) {
          const dbPath = await findCookieDbFile(path.join(dataDir, profile.id));
          if (dbPath) cookieCount = await countCookiesSafe(dbPath);
        }
        return { id: profile.id, name: profile.name, cookieCount };
      }),
    );
    catalog.push({
      id: browser.id,
      name: browser.name,
      installed,
      dataDir,
      keychainService: browser.keychainService,
      keychainAvailable: await isKeychainItemAvailable(browser.keychainService),
      profiles: withCounts,
    });
  }
  return catalog;
}

/**
 * 读取并解密某个浏览器 profile 的 cookie（macOS）。
 *
 * @param {object} [opts]
 * @param {string} [opts.browserId='auto'] 'edge' | 'chrome' | 'auto'（auto：优先 Edge 再 Chrome）
 * @param {string} [opts.profileId=''] profile 目录名；空串 = Default
 * @param {string} [opts.browser] 兼容别名（settings.browser）
 * @param {string} [opts.profile] 兼容别名（settings.profile）
 * @param {string} [opts.dataDir] 内部/测试用：覆盖浏览器数据目录
 * @param {string} [opts.password] 内部/测试用：直接提供钥匙串密码，跳过 Keychain 读取
 * @returns {Promise<{browser:string,profile:string,profileName:string,cookies:Array<object>,skipped:Array<{reason:string,count:number}>,durationMs:number}>}
 */
export async function readCookies(opts = {}) {
  const startedAt = Date.now();
  if (!IS_DARWIN) throw new Error(`${SUPPORTED_PLATFORM_NOTE}（当前平台：${PLATFORM}）`);

  const requestedBrowser =
    typeof opts.browserId === 'string' && opts.browserId
      ? opts.browserId
      : typeof opts.browser === 'string' && opts.browser
        ? opts.browser
        : 'auto';
  const browser = await resolveBrowser(requestedBrowser, opts.dataDir);
  const dataDir =
    typeof opts.dataDir === 'string' && opts.dataDir
      ? path.resolve(opts.dataDir)
      : browserDataDirForPlatform(browser);
  const rawProfileId = opts.profileId ?? opts.profile ?? '';
  const profileId = normalizeProfileId(typeof rawProfileId === 'string' ? rawProfileId : '');
  const dbPath = await findCookieDbFile(path.join(dataDir, profileId));
  if (!dbPath) {
    throw new Error(
      `未找到 ${browser.name} 的 cookie 数据库（profile: ${profileId}，目录: ${dataDir}）`,
    );
  }

  const password =
    typeof opts.password === 'string' && opts.password
      ? opts.password
      : await readKeychainPassword(browser.keychainService);
  const key = deriveKey(password);

  const infoCache = await readProfileInfoCache(dataDir);
  const profileName = infoCache.get(profileId) || profileId;

  const rows = await readCookieRows(dbPath);
  const cookies = [];
  const skippedCounters = new Map();
  const nowUnix = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    const hostKey = asString(row.host_key);
    const name = asString(row.name);
    const pathValue = asString(row.path);
    const encryptedValue = row.encrypted_value;

    // encrypted_value 优先；个别平台/旧库可能把明文放在 value 列
    const encryptedBuffer =
      encryptedValue == null
        ? null
        : Buffer.isBuffer(encryptedValue)
          ? encryptedValue
          : Buffer.from(encryptedValue);
    let value;
    if (encryptedBuffer && encryptedBuffer.length > 0) {
      const decrypted = decryptCookieValue(encryptedBuffer, hostKey, key);
      if (!decrypted.ok) {
        bumpCounter(skippedCounters, decrypted.reason);
        continue;
      }
      if (decrypted.value.length > MAX_COOKIE_VALUE_BYTES) {
        bumpCounter(skippedCounters, 'too-large');
        continue;
      }
      value = decrypted.value.toString('utf8');
    } else {
      value = asString(row.value);
      if (Buffer.byteLength(value, 'utf8') > MAX_COOKIE_VALUE_BYTES) {
        bumpCounter(skippedCounters, 'too-large');
        continue;
      }
    }

    const expiresUtcText = asString(row.expires_utc) || '0';
    const hasExpires = toInteger(row.has_expires, 1) !== 0;
    const expiresUtcNumber = Number(expiresUtcText);
    let expiresUnix = -1;
    if (hasExpires && Number.isFinite(expiresUtcNumber) && expiresUtcNumber > 0) {
      const computed = Math.floor(expiresUtcNumber / MICROS_PER_SECOND - CHROME_EPOCH_OFFSET_SECONDS);
      // <=0 视为 session（契约：expiresUnix <= 0 表示 session cookie）
      expiresUnix = computed > 0 ? computed : -1;
    }
    if (expiresUnix > 0 && expiresUnix < nowUnix) {
      bumpCounter(skippedCounters, 'expired');
      continue;
    }

    cookies.push({
      hostKey,
      name,
      value,
      path: pathValue,
      expiresUtc: expiresUtcText,
      expiresUnix,
      secure: toInteger(row.is_secure, 0) !== 0,
      httpOnly: toInteger(row.is_httponly, 0) !== 0,
      sameSite: sameSiteName(row.samesite),
      isPersistent: toInteger(row.is_persistent, 1) !== 0,
      topFrameSiteKey: asString(row.top_frame_site_key),
      hasCrossSiteAncestor: toInteger(row.has_cross_site_ancestor, 0) !== 0,
      sourceScheme: toInteger(row.source_scheme, 2),
    });
  }

  return {
    browser: browser.id,
    profile: profileId,
    profileName,
    cookies,
    skipped: [...skippedCounters.entries()].map(([reason, count]) => ({ reason, count })),
    durationMs: Date.now() - startedAt,
  };
}

function normalizeAllowDomains(domains) {
  if (!Array.isArray(domains)) return [];
  const normalized = [];
  for (const item of domains) {
    if (typeof item !== 'string') continue;
    const base = item
      .trim()
      .toLowerCase()
      .replace(/^\.+/, '')
      .replace(/\.+$/, '');
    if (base) normalized.push(base);
  }
  return normalized;
}

function matchesAllowedDomains(hostKey, allowedDomains) {
  const host = asString(hostKey).toLowerCase().replace(/^\.+/, '');
  if (!host) return false;
  return allowedDomains.some((base) => host === base || host.endsWith(`.${base}`));
}

/**
 * 按设置过滤 cookie。
 * @param {Array<object>} cookies
 * @param {{scope?:'all'|'allowlist',domains?:string[],includeSessionCookies?:boolean}} [settings]
 * @returns {Array<object>}
 */
export function filterCookies(cookies, settings = {}) {
  const list = Array.isArray(cookies) ? cookies : [];
  const scope = settings && settings.scope === 'allowlist' ? 'allowlist' : 'all';
  const includeSession = !(settings && settings.includeSessionCookies === false);
  const allowedDomains = scope === 'allowlist' ? normalizeAllowDomains(settings && settings.domains) : [];
  return list.filter((cookie) => {
    if (!cookie || typeof cookie !== 'object') return false;
    if (!includeSession && !(Number(cookie.expiresUnix) > 0)) return false;
    if (scope === 'allowlist') return matchesAllowedDomains(cookie.hostKey, allowedDomains);
    return true;
  });
}

/**
 * CookieRecord → CDP Network.CookieParam。
 * - host-only（hostKey 不以 '.' 开头）用 url；domain cookie 用 domain + path
 * - sameSite 仅在非 Unspecified 时输出；expires 仅在 expiresUnix > 0 时输出（秒）
 * - topFrameSiteKey 非空时输出 partitionKey
 * @param {object} record
 * @returns {object|null}
 */
export function toCdpCookie(record) {
  if (!record || typeof record !== 'object') return null;
  const name = asString(record.name);
  const hostKey = asString(record.hostKey);
  if (!name || !hostKey) return null;

  const value = asString(record.value);
  const cookiePath = asString(record.path) || '/';
  const secure = record.secure === true;
  const httpOnly = record.httpOnly === true;
  const cookie = { name, value, secure, httpOnly };

  if (hostKey.startsWith('.')) {
    cookie.domain = hostKey;
    cookie.path = cookiePath;
  } else {
    cookie.url = `${secure ? 'https' : 'http'}://${hostKey}${cookiePath}`;
  }

  if (record.sameSite && record.sameSite !== 'Unspecified') cookie.sameSite = record.sameSite;
  const expiresUnix = Number(record.expiresUnix);
  if (Number.isFinite(expiresUnix) && expiresUnix > 0) cookie.expires = Math.floor(expiresUnix);
  if (record.topFrameSiteKey) {
    cookie.partitionKey = {
      topLevelSite: record.topFrameSiteKey,
      hasCrossSiteAncestor: Boolean(record.hasCrossSiteAncestor),
    };
  }
  return cookie;
}

/**
 * cookie 汇总：条数、域名数、HttpOnly/Secure/session 数、Top 域名。
 * @param {Array<object>} cookies
 * @param {{top?:number}} [options]
 * @returns {{count:number,domainCount:number,httpOnly:number,secure:number,session:number,topDomains:Array<{domain:string,count:number}>}}
 */
export function summarize(cookies, options = {}) {
  const list = Array.isArray(cookies) ? cookies : [];
  const topOption = Number(options && options.top);
  const top = Number.isFinite(topOption) ? Math.max(0, Math.floor(topOption)) : 20;

  const domainCounts = new Map();
  let httpOnly = 0;
  let secure = 0;
  let session = 0;

  for (const cookie of list) {
    if (!cookie || typeof cookie !== 'object') continue;
    if (cookie.httpOnly) httpOnly += 1;
    if (cookie.secure) secure += 1;
    if (!(Number(cookie.expiresUnix) > 0)) session += 1;
    const domain = asString(cookie.hostKey);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }

  const topDomains = [...domainCounts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
    .slice(0, top);

  return { count: list.length, domainCount: domainCounts.size, httpOnly, secure, session, topDomains };
}
