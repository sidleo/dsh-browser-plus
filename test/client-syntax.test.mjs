import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = path.join(root, 'client.js');
const source = readFileSync(clientPath, 'utf8');

test('client.js：合法 JavaScript（等价 node --check）', () => {
  assert.doesNotThrow(() => new Function(source), 'new Function 编译失败');
  assert.doesNotThrow(() => new vm.Script(source, { filename: clientPath }), 'vm.Script 编译失败');
});

test('client.js：模块骨架与两处 slot 注册正确', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id:\s*'@sidleo3\/dsh-browser-plus'/);
  assert.match(source, /factory:\s*\(\s*require\s*\)\s*=>/);
  assert.match(source, /return\s*\{\s*inject:\s*\[\s*'slots'\s*\]\s*,\s*apply\s*\}/);

  assert.match(source, /slots\.inject\(\s*'settings\.section'/);
  assert.match(
    source,
    /slots\.register\(\s*\{[^}]*name:\s*'settings\.section'[^}]*id:\s*'browser-plus'[^}]*order:\s*65[^}]*label:\s*'浏览器 Cookie 同步'[^}]*\}/,
  );
  assert.match(source, /slots\.inject\(\s*'plugins\.bundle\.config'/);
  assert.match(
    source,
    /slots\.register\(\s*\{[^}]*name:\s*'plugins\.bundle\.config'[^}]*key:\s*'@sidleo3\/dsh-browser-plus'[^}]*\}/,
  );

  assert.match(source, /BrowserPlusPage\s*,\s*\{\s*head:\s*true\s*\}/);
  assert.match(source, /BrowserPlusPage\s*,\s*\{\s*head:\s*false\s*\}/);
  assert.match(source, /function apply\(ctx\)/);
  assert.match(source, /ctx\.get\(\s*'slots'\s*\)/);
});

test('client.js：数据流只走同源 /api/browser-plus 前缀', () => {
  const fetchCalls = source.match(/fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, '期望整个文件只有一处 fetch 调用');
  assert.match(source, /fetch\(\s*'\/api\/browser-plus'\s*\+/, 'fetch 必须以 /api/browser-plus 开头');
  assert.doesNotMatch(source, /fetch\(\s*['"](?!\/api\/browser-plus)/, '存在不是 /api/browser-plus 前缀的 fetch');

  assert.match(source, /api\('\/state\?refresh=1'\)/);
  assert.match(source, /post\('\/settings',\s*\{\s*patch\s*\}\)/);
  assert.match(source, /post\('\/action',\s*\{\s*action\s*\}\)/);
  assert.match(source, /'content-type':\s*'application\/json'/);
});

test('client.js：不含 import/export 语句与 JSX 尖括号标签', () => {
  assert.doesNotMatch(source, /(?:^|\n)\s*import\s/);
  assert.doesNotMatch(source, /(?:^|\n)\s*export\s/);
  assert.doesNotMatch(source, /(?:^|\n)\s*<[A-Za-z][A-Za-z0-9.]*(?:\s[^>]*)?>/);
  assert.doesNotMatch(source, /<\/[A-Za-z][A-Za-z0-9.]*>/);
  assert.doesNotMatch(source, /\breturn\s*<|\b=>\s*</);

  const requires = (source.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || []).map((item) => item.replace(/\s+/g, ''));
  assert.deepEqual(requires, ["require('react')"], '模块表只允许 require("react")');
});

test('client.js：使用 React hooks 与 4 秒静默刷新（含清理）', () => {
  assert.match(source, /React\.useState\(/);
  assert.match(source, /React\.useEffect\(/);
  assert.match(source, /React\.useRef\(/);
  assert.match(source, /const REFRESH_MS = 4000/);
  assert.match(source, /setInterval\(pull,\s*REFRESH_MS\)/);
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /style\[data-browser-plus\]/, '样式只注入一次');
});

test('locale 与 icon：元数据齐全且图标体积合规', () => {
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(readFileSync(path.join(root, 'locale', lang + '.json'), 'utf8'));
    assert.deepEqual(Object.keys(locale), ['meta']);
    assert.deepEqual(Object.keys(locale.meta).sort(), ['description', 'title']);
    assert.equal(typeof locale.meta.title, 'string');
    assert.equal(typeof locale.meta.description, 'string');
    assert.ok(locale.meta.title.length > 0);
    assert.ok(locale.meta.description.length > 0);
  }

  const icon = readFileSync(path.join(root, 'icon.svg'), 'utf8');
  assert.ok(Buffer.byteLength(icon, 'utf8') <= 256 * 1024, '图标不得超过 256KiB');
  assert.match(icon, /<svg[^>]*viewBox="0 0 64 64"/);
  assert.match(icon, /#247bbf|#3f96d4|#1d5f96/, '图标应使用主题蓝色系');
});
