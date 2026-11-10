// lib/cookie-source.mjs 测试。
//
// 覆盖：
// 1. 本机真实 Edge / Chrome cookie 库（只读）：解密成功率、字段形状、HttpOnly/domain 分布；
// 2. 合成 profile：用同一套 macOS 加密方案造 DB，验证 readCookies / toCdpCookie /
//    expired / bad-host-hash / too-large / unknown-version 跳过；
// 3. filterCookies / summarize / toCdpCookie 纯函数用例。
//
// 安全红线：不打印、不写入任何真实 cookie 的 name / value；断言只用计数、布尔与形状。
// 合成用例只使用自造的假域名（*.synth.test）与假值。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BROWSERS,
  filterCookies,
  listBrowserCatalog,
  readCookies,
  summarize,
  toCdpCookie,
} from '../lib/cookie-source.mjs';

const IS_DARWIN = process.platform === 'darwin';
const HOME = os.homedir();
const EDGE_COOKIES_DB = path.join(
  HOME,
  'Library',
  'Application Support',
  'Microsoft Edge',
  'Default',
  'Cookies',
);
const CHROME_COOKIES_DB = path.join(
  HOME,
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'Default',
  'Cookies',
);
const CHROME_EPOCH_OFFSET_SECONDS = 11644473600;
const UNDECRYPTABLE_REASONS = new Set(['undecryptable', 'bad-host-hash']);
const KNOWN_SKIP_REASON =
  /^(expired|too-large|undecryptable|bad-host-hash|unknown-version:.+)$/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function skippedToObject(result) {
  return Object.fromEntries(result.skipped.map((entry) => [entry.reason, entry.count]));
}

/** 解密失败条数（不含过期/超大等"解密成功但被过滤"的原因）。 */
function decryptFailureCount(skipped) {
  let failures = 0;
  for (const [reason, count] of Object.entries(skipped)) {
    if (UNDECRYPTABLE_REASONS.has(reason) || reason.startsWith('unknown-version:')) {
      failures += count;
    }
  }
  return failures;
}

function assertKnownSkipReasons(skipped) {
  for (const reason of Object.keys(skipped)) {
    assert.match(reason, KNOWN_SKIP_REASON, `未知的 skipped reason: ${reason}`);
  }
}

/** 合成的 CookieRecord（形状同 lib 的导出契约，值都是假的）。 */
function syntheticRecord(overrides = {}) {
  return {
    hostKey: '.example.com',
    name: 'n',
    value: 'v',
    path: '/',
    expiresUtc: '0',
    expiresUnix: 1893456000,
    secure: false,
    httpOnly: false,
    sameSite: 'Unspecified',
    isPersistent: true,
    topFrameSiteKey: '',
    hasCrossSiteAncestor: false,
    sourceScheme: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 合成 DB：macOS Chrome/Edge 加密方案
// ---------------------------------------------------------------------------

function tryReadKeychainPassword(service) {
  if (!IS_DARWIN) return null;
  try {
    const stdout = execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const password = String(stdout).trim();
    return password || null;
  } catch {
    return null;
  }
}

let syntheticCredentialCache; // undefined=未尝试, null=钥匙串不可用, object={password,key}

function getSyntheticCredential() {
  if (syntheticCredentialCache !== undefined) return syntheticCredentialCache;
  if (!IS_DARWIN) {
    syntheticCredentialCache = null;
    return null;
  }
  const password = tryReadKeychainPassword('Microsoft Edge Safe Storage');
  syntheticCredentialCache = password
    ? {
        password,
        key: crypto.pbkdf2Sync(
          Buffer.from(password, 'utf8'),
          'saltysalt',
          1003,
          16,
          'sha1',
        ),
      }
    : null;
  return syntheticCredentialCache;
}

function chromeTimestamp(unixSeconds) {
  return String(Math.round((unixSeconds + CHROME_EPOCH_OFFSET_SECONDS) * 1e6));
}

function pkcs7Pad(buffer) {
  const paddingLength = 16 - (buffer.length % 16);
  return Buffer.concat([buffer, Buffer.alloc(paddingLength, paddingLength)]);
}

/**
 * 按 Chrome/Edge macOS 方案加密：'v10' + AES-128-CBC(PKCS#7(sha256(hostKey) || value))。
 * hashHostKey 可传错值来构造 bad-host-hash 用例。
 */
function encryptCookie(hostKey, value, key, hashHostKey = hostKey) {
  const plaintext = Buffer.concat([
    crypto.createHash('sha256').update(hashHostKey, 'utf8').digest(),
    Buffer.from(value, 'utf8'),
  ]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  cipher.setAutoPadding(false);
  return Buffer.concat([
    Buffer.from('v10', 'latin1'),
    cipher.update(pkcs7Pad(plaintext)),
    cipher.final(),
  ]);
}

const FULL_COOKIE_SCHEMA = `
CREATE TABLE cookies (
  creation_utc INTEGER NOT NULL DEFAULT 0,
  host_key TEXT NOT NULL DEFAULT '',
  top_frame_site_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  encrypted_value BLOB NOT NULL DEFAULT X'',
  path TEXT NOT NULL DEFAULT '/',
  expires_utc INTEGER NOT NULL DEFAULT 0,
  is_secure INTEGER NOT NULL DEFAULT 0,
  is_httponly INTEGER NOT NULL DEFAULT 0,
  last_access_utc INTEGER NOT NULL DEFAULT 0,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 2,
  source_port INTEGER NOT NULL DEFAULT 443,
  last_update_utc INTEGER NOT NULL DEFAULT 0,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
)`;

// 模拟旧版本：缺少 top_frame_site_key / has_cross_site_ancestor / samesite /
// is_persistent / source_scheme，验证列缺失时 readCookies 的兜底默认值。
const MINIMAL_COOKIE_SCHEMA = `
CREATE TABLE cookies (
  host_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL DEFAULT '',
  encrypted_value BLOB,
  path TEXT NOT NULL DEFAULT '/',
  expires_utc INTEGER NOT NULL DEFAULT 0,
  is_secure INTEGER NOT NULL DEFAULT 0,
  is_httponly INTEGER NOT NULL DEFAULT 0,
  has_expires INTEGER NOT NULL DEFAULT 1
)`;

const FULL_COOKIE_COLUMNS = [
  'host_key',
  'top_frame_site_key',
  'name',
  'value',
  'encrypted_value',
  'path',
  'expires_utc',
  'is_secure',
  'is_httponly',
  'has_expires',
  'is_persistent',
  'samesite',
  'source_scheme',
  'has_cross_site_ancestor',
];

const MINIMAL_COOKIE_COLUMNS = [
  'host_key',
  'name',
  'value',
  'encrypted_value',
  'path',
  'expires_utc',
  'is_secure',
  'is_httponly',
  'has_expires',
];

function createCookieDb(dbPath, schema, columns, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(schema);
    const placeholders = columns.map(() => '?').join(', ');
    const statement = db.prepare(
      `INSERT INTO cookies (${columns.join(', ')}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
      statement.run(...columns.map((column) => (row[column] === undefined ? null : row[column])));
    }
  } finally {
    db.close();
  }
}

function cookieRow(overrides = {}) {
  return {
    host_key: '.example.test',
    top_frame_site_key: '',
    name: 'synth',
    value: '',
    encrypted_value: null,
    path: '/',
    expires_utc: '0',
    is_secure: 1,
    is_httponly: 0,
    has_expires: 1,
    is_persistent: 1,
    samesite: -1,
    source_scheme: 2,
    has_cross_site_ancestor: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 元数据
// ---------------------------------------------------------------------------

test('BROWSERS：导出 Edge / Chrome 元数据', () => {
  assert.equal(Array.isArray(BROWSERS), true);
  assert.deepEqual(
    BROWSERS.map((browser) => browser.id),
    ['edge', 'chrome'],
    'auto 优先级要求 Edge 在前',
  );
  for (const browser of BROWSERS) {
    assert.equal(typeof browser.name, 'string');
    assert.ok(browser.name.length > 0);
    assert.ok(browser.keychainService.includes('Safe Storage'));
    for (const key of ['darwinDataDir', 'winDataDir', 'linuxDataDir']) {
      assert.equal(typeof browser[key], 'string');
      assert.ok(path.isAbsolute(browser[key]), `${browser.id}.${key} 应为绝对路径`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. 真实数据库（只读，断言计数与分布）
// ---------------------------------------------------------------------------

const EDGE_AVAILABLE = IS_DARWIN && fs.existsSync(EDGE_COOKIES_DB);
const CHROME_AVAILABLE = IS_DARWIN && fs.existsSync(CHROME_COOKIES_DB);

function assertCookieRecordShape(cookie) {
  assert.equal(typeof cookie.hostKey, 'string');
  assert.ok(cookie.hostKey.length > 0);
  assert.equal(typeof cookie.name, 'string');
  assert.ok(cookie.name.length > 0);
  assert.equal(typeof cookie.value, 'string');
  assert.equal(typeof cookie.path, 'string');
  assert.equal(typeof cookie.expiresUtc, 'string');
  assert.equal(typeof cookie.expiresUnix, 'number');
  assert.ok(Number.isInteger(cookie.expiresUnix));
  assert.ok(cookie.expiresUnix <= 0 || cookie.expiresUnix * 1000 > Date.now());
  assert.equal(typeof cookie.secure, 'boolean');
  assert.equal(typeof cookie.httpOnly, 'boolean');
  assert.ok(['Unspecified', 'Strict', 'Lax', 'None'].includes(cookie.sameSite));
  assert.equal(typeof cookie.isPersistent, 'boolean');
  assert.equal(typeof cookie.topFrameSiteKey, 'string');
  assert.equal(typeof cookie.hasCrossSiteAncestor, 'boolean');
  assert.equal(typeof cookie.sourceScheme, 'number');
  assert.notEqual(toCdpCookie(cookie), null, '每条记录都应能转成 CDP cookie');
}

test('真实 Edge 库：解密成功率 > 95%、字段齐全', { skip: EDGE_AVAILABLE ? false : '无 Edge cookie 库或非 macOS' }, async (t) => {
  const result = await readCookies({ browserId: 'edge' });
  const skipped = skippedToObject(result);
  const decrypted = result.cookies.length;
  const failures = decryptFailureCount(skipped);
  const successRate = decrypted + failures > 0 ? decrypted / (decrypted + failures) : 0;

  // 只输出计数，不含任何 name / value
  t.diagnostic(
    `Edge: 解出 ${decrypted} 条 / 解密失败 ${failures} 条 / 成功率 ${(successRate * 100).toFixed(2)}% / 跳过 ${JSON.stringify(skipped)} / 耗时 ${result.durationMs}ms`,
  );

  assert.ok(decrypted > 500, `Edge 解出条数应 > 500，实际 ${decrypted}`);
  assert.ok(successRate > 0.95, `Edge 解密成功率应 > 95%，实际 ${(successRate * 100).toFixed(2)}%`);
  assertKnownSkipReasons(skipped);

  assert.ok(result.cookies.some((cookie) => cookie.httpOnly), '应存在 HttpOnly cookie');
  assert.ok(result.cookies.some((cookie) => !cookie.httpOnly), '应存在非 HttpOnly cookie');
  assert.ok(result.cookies.some((cookie) => cookie.hostKey.startsWith('.')), '应存在 domain cookie');
  assert.ok(result.cookies.some((cookie) => !cookie.hostKey.startsWith('.')), '应存在 host-only cookie');

  assert.equal(result.browser, 'edge');
  assert.equal(result.profile, 'Default');
  assert.equal(typeof result.profileName, 'string');
  assert.ok(result.profileName.length > 0);
  assert.ok(result.durationMs >= 0);
  assert.ok(Array.isArray(result.skipped));

  for (const cookie of result.cookies) assertCookieRecordShape(cookie);

  // summarize 与 cookies 自洽
  const summary = summarize(result.cookies, { top: 5 });
  assert.equal(summary.count, result.cookies.length);
  assert.ok(summary.domainCount > 0);
  assert.equal(summary.httpOnly, result.cookies.filter((cookie) => cookie.httpOnly).length);
  assert.equal(summary.secure, result.cookies.filter((cookie) => cookie.secure).length);
  assert.equal(summary.session, result.cookies.filter((cookie) => cookie.expiresUnix <= 0).length);
  assert.equal(summary.topDomains.length, Math.min(5, summary.domainCount));
  for (const item of summary.topDomains) {
    assert.equal(typeof item.domain, 'string');
    assert.ok(item.count > 0);
  }

  // allowlist 后缀匹配在真实数据上也能用（取条数最多的域名，不打印域名之外的任何东西）
  const topDomain = summary.topDomains[0].domain;
  const allowlisted = filterCookies(result.cookies, {
    scope: 'allowlist',
    domains: [topDomain],
    includeSessionCookies: true,
  });
  assert.ok(allowlisted.length >= summary.topDomains[0].count);
  for (const cookie of allowlisted) {
    const host = cookie.hostKey.toLowerCase().replace(/^\.+/, '');
    const base = topDomain.toLowerCase().replace(/^\.+/, '');
    assert.ok(host === base || host.endsWith(`.${base}`), 'allowlist 过滤应只保留后缀匹配的域名');
  }

  const noSession = filterCookies(result.cookies, { scope: 'all', includeSessionCookies: false });
  assert.equal(noSession.length, result.cookies.filter((cookie) => cookie.expiresUnix > 0).length);
});

test('真实 Chrome 库：解密成功率 > 95%', { skip: CHROME_AVAILABLE ? false : '无 Chrome cookie 库或非 macOS' }, async (t) => {
  const result = await readCookies({ browserId: 'chrome' });
  const skipped = skippedToObject(result);
  const decrypted = result.cookies.length;
  const failures = decryptFailureCount(skipped);
  const successRate = decrypted + failures > 0 ? decrypted / (decrypted + failures) : 0;

  t.diagnostic(
    `Chrome: 解出 ${decrypted} 条 / 解密失败 ${failures} 条 / 成功率 ${(successRate * 100).toFixed(2)}% / 跳过 ${JSON.stringify(skipped)} / 耗时 ${result.durationMs}ms`,
  );

  assert.ok(decrypted > 50, `Chrome 解出条数应 > 50，实际 ${decrypted}`);
  assert.ok(successRate > 0.95, `Chrome 解密成功率应 > 95%，实际 ${(successRate * 100).toFixed(2)}%`);
  assertKnownSkipReasons(skipped);
  assert.equal(result.browser, 'chrome');
  assert.equal(result.profile, 'Default');
  for (const cookie of result.cookies) assertCookieRecordShape(cookie);
});

test('listBrowserCatalog：真实目录 / profile / cookie 计数', { skip: IS_DARWIN ? false : '非 macOS' }, async (t) => {
  const catalog = await listBrowserCatalog();
  assert.equal(catalog.length, 2);
  assert.deepEqual(
    catalog.map((browser) => browser.id),
    ['edge', 'chrome'],
  );
  for (const browser of catalog) {
    assert.equal(typeof browser.name, 'string');
    assert.ok(path.isAbsolute(browser.dataDir));
    assert.equal(typeof browser.installed, 'boolean');
    assert.equal(typeof browser.keychainService, 'string');
    assert.equal(typeof browser.keychainAvailable, 'boolean');
    assert.ok(Array.isArray(browser.profiles));
    for (const profile of browser.profiles) {
      assert.equal(typeof profile.id, 'string');
      assert.equal(typeof profile.name, 'string');
      assert.ok(Number.isInteger(profile.cookieCount));
      assert.ok(profile.cookieCount >= 0);
    }
  }

  const edge = catalog.find((browser) => browser.id === 'edge');
  if (edge.installed) {
    assert.equal(edge.profiles[0].id, 'Default', 'Default 应排第一个');
    const defaultProfile = edge.profiles.find((profile) => profile.id === 'Default');
    assert.ok(defaultProfile, 'Edge 应有 Default profile');
    assert.ok(
      defaultProfile.cookieCount > 500,
      `Edge Default 的 cookie 计数应 > 500，实际 ${defaultProfile.cookieCount}`,
    );
  }

  const quick = await listBrowserCatalog({ includeCounts: false });
  for (const browser of quick) {
    for (const profile of browser.profiles) assert.equal(profile.cookieCount, 0);
  }
  t.diagnostic(
    `目录: ${catalog.map((browser) => `${browser.id}=${browser.installed ? 'installed' : 'missing'}/${browser.profiles.length} profiles`).join(' ')}`,
  );
});

test('readCookies：参数校验', { skip: IS_DARWIN ? false : '非 macOS' }, async () => {
  await assert.rejects(() => readCookies({ browserId: 'netscape' }), /未知浏览器/);
  await assert.rejects(
    () => readCookies({ browserId: 'edge', profileId: '../escape' }),
    /profile 名不合法/,
  );
  if (fs.existsSync(EDGE_COOKIES_DB)) {
    await assert.rejects(
      () => readCookies({ browserId: 'edge', profileId: 'NoSuchProfile' }),
      /未找到/,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. 合成 profile：readCookies 端到端（解密 + 跳过计数 + profileName）
// ---------------------------------------------------------------------------

test('合成 profile：解密/过期/坏哈希/超大/v11 跳过与 toCdpCookie 形状', { skip: IS_DARWIN ? false : '非 macOS' }, async (t) => {
  const credential = getSyntheticCredential();
  if (!credential) {
    t.skip('钥匙串不可用，跳过合成 profile 端到端用例');
    return;
  }
  const { password, key } = credential;

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-synth-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const dataDir = path.join(root, 'BrowserData');
  const profileId = 'Synth Profile';
  const profileDir = path.join(dataDir, profileId);
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(
    path.join(dataDir, 'Local State'),
    JSON.stringify({ profile: { info_cache: { [profileId]: { name: '合成配置' } } } }),
  );

  const now = Math.floor(Date.now() / 1000);
  const futureUtc = chromeTimestamp(now + 86400);
  const pastUtc = chromeTimestamp(now - 86400);
  const tooLargeValue = 'x'.repeat(5000);

  const rows = [
    // 正常 domain cookie：future + samesite=Lax + secure + httpOnly
    cookieRow({
      host_key: '.synth.test',
      name: 'synth_domain',
      encrypted_value: encryptCookie('.synth.test', 'domain-value', key),
      path: '/',
      expires_utc: futureUtc,
      is_secure: 1,
      is_httponly: 1,
      is_persistent: 1,
      samesite: 1,
    }),
    // host-only + session（空 value 保留）+ partitioned
    cookieRow({
      host_key: 'hostonly.synth.test',
      name: 'synth_hostonly',
      encrypted_value: encryptCookie('hostonly.synth.test', '', key),
      path: '',
      expires_utc: '0',
      has_expires: 0,
      is_persistent: 0,
      is_secure: 0,
      is_httponly: 0,
      samesite: -1,
      top_frame_site_key: 'https://top.synth.test',
      has_cross_site_ancestor: 1,
    }),
    // 已过期 → skipped expired
    cookieRow({
      host_key: '.gone.synth.test',
      name: 'synth_expired',
      encrypted_value: encryptCookie('.gone.synth.test', 'gone-value', key),
      expires_utc: pastUtc,
    }),
    // host hash 不匹配 → skipped bad-host-hash
    cookieRow({
      host_key: '.badhash.synth.test',
      name: 'synth_badhash',
      encrypted_value: encryptCookie('.badhash.synth.test', 'bad-value', key, 'wrong.synth.test'),
      expires_utc: futureUtc,
    }),
    // value 超过 4096 字节 → skipped too-large
    cookieRow({
      host_key: '.huge.synth.test',
      name: 'synth_huge',
      encrypted_value: encryptCookie('.huge.synth.test', tooLargeValue, key),
      expires_utc: futureUtc,
    }),
    // 未知加密版本 → skipped unknown-version:v11
    cookieRow({
      host_key: '.v11.synth.test',
      name: 'synth_v11',
      encrypted_value: Buffer.concat([Buffer.from('v11', 'latin1'), Buffer.alloc(16, 7)]),
      expires_utc: futureUtc,
    }),
  ];
  createCookieDb(
    path.join(profileDir, 'Cookies'),
    FULL_COOKIE_SCHEMA,
    FULL_COOKIE_COLUMNS,
    rows,
  );

  const result = await readCookies({
    browserId: 'edge',
    profileId,
    dataDir,
    password, // 测试内部注入，避免二次读取钥匙串
  });

  assert.equal(result.browser, 'edge');
  assert.equal(result.profile, profileId);
  assert.equal(result.profileName, '合成配置');
  assert.ok(result.durationMs >= 0);

  // 只剩 2 条有效 cookie，name 集合不含被跳过的合成名字（只出现自造假名）
  assert.equal(result.cookies.length, 2);
  assert.deepEqual(
    result.cookies.map((cookie) => cookie.name).sort(),
    ['synth_domain', 'synth_hostonly'],
  );
  assert.deepEqual(skippedToObject(result), {
    expired: 1,
    'bad-host-hash': 1,
    'too-large': 1,
    'unknown-version:v11': 1,
  });

  const domainCookie = result.cookies.find((cookie) => cookie.name === 'synth_domain');
  assert.equal(domainCookie.hostKey, '.synth.test');
  assert.equal(domainCookie.value, 'domain-value');
  assert.equal(domainCookie.path, '/');
  assert.equal(domainCookie.expiresUtc, futureUtc);
  assert.ok(domainCookie.expiresUnix > now);
  assert.equal(domainCookie.secure, true);
  assert.equal(domainCookie.httpOnly, true);
  assert.equal(domainCookie.sameSite, 'Lax');
  assert.equal(domainCookie.isPersistent, true);
  assert.equal(domainCookie.topFrameSiteKey, '');
  assert.equal(domainCookie.hasCrossSiteAncestor, false);

  const hostOnlyCookie = result.cookies.find((cookie) => cookie.name === 'synth_hostonly');
  assert.equal(hostOnlyCookie.hostKey, 'hostonly.synth.test');
  assert.equal(hostOnlyCookie.value, '', '空值 cookie 应保留');
  assert.equal(hostOnlyCookie.path, '');
  assert.equal(hostOnlyCookie.expiresUnix, -1, 'has_expires=0 时应是 session cookie');
  assert.equal(hostOnlyCookie.secure, false);
  assert.equal(hostOnlyCookie.httpOnly, false);
  assert.equal(hostOnlyCookie.sameSite, 'Unspecified');
  assert.equal(hostOnlyCookie.isPersistent, false);
  assert.equal(hostOnlyCookie.topFrameSiteKey, 'https://top.synth.test');
  assert.equal(hostOnlyCookie.hasCrossSiteAncestor, true);

  // CDP 转换：domain cookie 用 domain + path，带 sameSite / expires
  assert.deepEqual(toCdpCookie(domainCookie), {
    name: 'synth_domain',
    value: 'domain-value',
    secure: true,
    httpOnly: true,
    domain: '.synth.test',
    path: '/',
    sameSite: 'Lax',
    expires: domainCookie.expiresUnix,
  });

  // CDP 转换：host-only 用 url（scheme 由 secure 决定，空 path 补 '/'），session 无 expires，
  // 分区 cookie 带 partitionKey
  assert.deepEqual(toCdpCookie(hostOnlyCookie), {
    name: 'synth_hostonly',
    value: '',
    secure: false,
    httpOnly: false,
    url: 'http://hostonly.synth.test/',
    partitionKey: { topLevelSite: 'https://top.synth.test', hasCrossSiteAncestor: true },
  });

  // 被跳过的条目不应出现在结果里
  const names = new Set(result.cookies.map((cookie) => cookie.name));
  for (const skippedName of ['synth_expired', 'synth_badhash', 'synth_huge', 'synth_v11']) {
    assert.equal(names.has(skippedName), false, `${skippedName} 应被跳过`);
  }
});

test('合成 profile：缺列的旧 schema 也能读取（兜底默认值）', { skip: IS_DARWIN ? false : '非 macOS' }, async (t) => {
  const credential = getSyntheticCredential();
  if (!credential) {
    t.skip('钥匙串不可用，跳过旧 schema 用例');
    return;
  }
  const { password, key } = credential;

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-synth-min-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const dataDir = path.join(root, 'BrowserData');
  const profileDir = path.join(dataDir, 'Default');
  await fsp.mkdir(profileDir, { recursive: true });
  const futureUtc = chromeTimestamp(Math.floor(Date.now() / 1000) + 86400);
  createCookieDb(path.join(profileDir, 'Cookies'), MINIMAL_COOKIE_SCHEMA, MINIMAL_COOKIE_COLUMNS, [
    {
      host_key: '.minimal.test',
      name: 'synth_minimal',
      value: '',
      encrypted_value: encryptCookie('.minimal.test', 'minimal-value', key),
      path: '/',
      expires_utc: futureUtc,
      is_secure: 1,
      is_httponly: 1,
      has_expires: 1,
    },
  ]);

  // profileId 省略 → Default；没有 Local State → profileName 回落为目录名
  const result = await readCookies({ browserId: 'edge', dataDir, password });
  assert.equal(result.profile, 'Default');
  assert.equal(result.profileName, 'Default');
  assert.equal(result.cookies.length, 1);
  assert.deepEqual(skippedToObject(result), {});

  const cookie = result.cookies[0];
  assert.equal(cookie.name, 'synth_minimal');
  assert.equal(cookie.value, 'minimal-value');
  assert.equal(cookie.sameSite, 'Unspecified', '缺 samesite 列应回退 Unspecified');
  assert.equal(cookie.topFrameSiteKey, '', '缺 top_frame_site_key 列应回退空串');
  assert.equal(cookie.hasCrossSiteAncestor, false);
  assert.equal(cookie.isPersistent, true, '缺 is_persistent 列应回退 true');
  assert.equal(cookie.sourceScheme, 2, '缺 source_scheme 列应回退 2');
  assert.ok(cookie.expiresUnix > 0);
});

// ---------------------------------------------------------------------------
// 4. 纯函数：toCdpCookie / filterCookies / summarize
// ---------------------------------------------------------------------------

test('toCdpCookie：domain / host-only / sameSite / session / partitionKey', () => {
  // domain cookie：domain + path + sameSite + expires(秒)
  assert.deepEqual(
    toCdpCookie(
      syntheticRecord({
        hostKey: '.example.com',
        name: 'a',
        value: 'b',
        path: '/x',
        expiresUnix: 1893456000,
        secure: true,
        httpOnly: true,
        sameSite: 'None',
      }),
    ),
    {
      name: 'a',
      value: 'b',
      secure: true,
      httpOnly: true,
      domain: '.example.com',
      path: '/x',
      sameSite: 'None',
      expires: 1893456000,
    },
  );

  // host-only + session：url 形式，无 expires / sameSite，空 value 保留，path 缺省 '/'
  assert.deepEqual(
    toCdpCookie(
      syntheticRecord({
        hostKey: 'example.com',
        name: 'c',
        value: '',
        path: '',
        expiresUnix: -1,
        secure: false,
        httpOnly: false,
        sameSite: 'Unspecified',
      }),
    ),
    {
      name: 'c',
      value: '',
      secure: false,
      httpOnly: false,
      url: 'http://example.com/',
    },
  );

  // host-only + secure：https scheme
  assert.equal(
    toCdpCookie(syntheticRecord({ hostKey: 'example.com', secure: true, path: '/p' })).url,
    'https://example.com/p',
  );

  // 分区 cookie（CHIPS）：partitionKey 形状
  const partitioned = toCdpCookie(
    syntheticRecord({
      hostKey: '.example.com',
      expiresUnix: -1,
      topFrameSiteKey: 'https://top.example.com',
      hasCrossSiteAncestor: true,
      sameSite: 'Lax',
    }),
  );
  assert.deepEqual(partitioned.partitionKey, {
    topLevelSite: 'https://top.example.com',
    hasCrossSiteAncestor: true,
  });
  assert.equal(partitioned.sameSite, 'Lax');
  assert.equal('expires' in partitioned, false);

  // hasCrossSiteAncestor 强制布尔化
  assert.deepEqual(
    toCdpCookie(
      syntheticRecord({
        topFrameSiteKey: 'https://top.example.com',
        hasCrossSiteAncestor: 1,
      }),
    ).partitionKey,
    { topLevelSite: 'https://top.example.com', hasCrossSiteAncestor: true },
  );

  // 非 Unspecified 才输出 sameSite
  assert.equal('sameSite' in toCdpCookie(syntheticRecord({ sameSite: 'Unspecified' })), false);
  // 非正 expiresUnix 不输出
  assert.equal('expires' in toCdpCookie(syntheticRecord({ expiresUnix: 0 })), false);
  assert.equal('expires' in toCdpCookie(syntheticRecord({ expiresUnix: -5 })), false);

  // 非法输入 → null
  assert.equal(toCdpCookie(null), null);
  assert.equal(toCdpCookie(undefined), null);
  assert.equal(toCdpCookie({ hostKey: '.example.com', name: '' }), null);
  assert.equal(toCdpCookie({ hostKey: '', name: 'n' }), null);
});

test('filterCookies：scope=all / allowlist 后缀 / session 开关', () => {
  const cookies = [
    syntheticRecord({ hostKey: '.example.com', name: 'a' }),
    syntheticRecord({ hostKey: 'sub.example.com', name: 'b' }),
    syntheticRecord({ hostKey: '.example.com', name: 'sess', expiresUnix: -1 }),
    syntheticRecord({ hostKey: '.example.org', name: 'c' }),
    syntheticRecord({ hostKey: 'evil-example.com', name: 'd' }),
    syntheticRecord({ hostKey: 'example.com', name: 'e' }),
  ];

  // scope=all（以及 settings 缺省）全保留
  assert.deepEqual(
    filterCookies(cookies, { scope: 'all' }).map((cookie) => cookie.name),
    ['a', 'b', 'sess', 'c', 'd', 'e'],
  );
  assert.equal(filterCookies(cookies).length, cookies.length);

  // allowlist：'.example.com' 只保留后缀匹配（含 host-only 的 example.com 自身）
  assert.deepEqual(
    filterCookies(cookies, { scope: 'allowlist', domains: ['.example.com'] }).map(
      (cookie) => cookie.name,
    ),
    ['a', 'b', 'sess', 'e'],
  );
  // 不带前导 '.' / 大小写不同都等价
  assert.deepEqual(
    filterCookies(cookies, { scope: 'allowlist', domains: ['EXAMPLE.COM'] }).map(
      (cookie) => cookie.name,
    ),
    ['a', 'b', 'sess', 'e'],
  );
  // 后缀边界：evil-example.com 不应命中
  assert.equal(
    filterCookies(cookies, { scope: 'allowlist', domains: ['example.com'] }).some(
      (cookie) => cookie.name === 'd',
    ),
    false,
  );

  // includeSessionCookies=false 去掉 session cookie
  assert.deepEqual(
    filterCookies(cookies, { scope: 'all', includeSessionCookies: false }).map(
      (cookie) => cookie.name,
    ),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.deepEqual(
    filterCookies(cookies, { scope: 'allowlist', domains: ['.example.com'], includeSessionCookies: false }).map(
      (cookie) => cookie.name,
    ),
    ['a', 'b', 'e'],
  );

  // 空 allowlist → 不保留任何 cookie
  assert.equal(filterCookies(cookies, { scope: 'allowlist', domains: [] }).length, 0);
  // 非法 domains 类型不抛错
  assert.equal(filterCookies(cookies, { scope: 'allowlist', domains: 'not-an-array' }).length, 0);
  // 忽略畸形元素，且不修改原数组
  assert.equal(filterCookies([null, undefined, ...cookies], { scope: 'all' }).length, cookies.length);
  assert.equal(cookies.length, 6);
});

test('summarize：条数 / 域名数 / HttpOnly / Secure / session / Top 域名', () => {
  const cookies = [
    syntheticRecord({ hostKey: '.example.com', httpOnly: true, secure: true }),
    syntheticRecord({ hostKey: '.example.com' }),
    syntheticRecord({ hostKey: '.other.test', expiresUnix: -1 }),
    syntheticRecord({ hostKey: 'hostonly.test', secure: true, expiresUnix: -1 }),
    syntheticRecord({ hostKey: 'hostonly.test' }),
  ];

  assert.deepEqual(summarize(cookies), {
    count: 5,
    domainCount: 3,
    httpOnly: 1,
    secure: 2,
    session: 2,
    topDomains: [
      { domain: '.example.com', count: 2 },
      { domain: 'hostonly.test', count: 2 },
      { domain: '.other.test', count: 1 },
    ],
  });

  // top 限制与排序
  const topTwo = summarize(cookies, { top: 2 });
  assert.equal(topTwo.topDomains.length, 2);
  assert.equal(topTwo.topDomains[0].count, 2);
  assert.deepEqual(summarize(cookies, { top: 0 }).topDomains, []);
  assert.equal(summarize(cookies, { top: 100 }).topDomains.length, 3);

  // domain 用 host_key 原样：带前导 '.' 的归到 '.example.com'，与 host-only 变体分别是不同键
  const variants = summarize([
    syntheticRecord({ hostKey: '.example.com' }),
    syntheticRecord({ hostKey: 'example.com' }),
    syntheticRecord({ hostKey: 'example.com' }),
  ]);
  assert.equal(variants.domainCount, 2);
  assert.equal(
    variants.topDomains.find((item) => item.domain === 'example.com').count,
    2,
  );
  assert.equal(
    variants.topDomains.find((item) => item.domain === '.example.com').count,
    1,
  );

  // 空输入 / 畸形输入
  assert.deepEqual(summarize([]), {
    count: 0,
    domainCount: 0,
    httpOnly: 0,
    secure: 0,
    session: 0,
    topDomains: [],
  });
  assert.equal(summarize(null).count, 0);
  assert.equal(summarize([null, undefined]).count, 2);
});
