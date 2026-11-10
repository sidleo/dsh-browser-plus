# dsh-browser-plus · 实现契约（内部）

> 目标：DSH 内置浏览器（右侧栏 Browser 标签，Electron `<webview>`）没有用户 Chrome/Edge 的登录态，
> 每次重启都要重新登录；部分站点单点登录，重新登录会把用户自己浏览器的会话踢下线。
> 本插件读取用户 Chrome/Edge 的 cookie 数据库（解密），并通过 **CDP 桥**把它们批量写入内置浏览器
> 各 webview 分区（`Network.setCookies`，含 HttpOnly），实现界面内免登录。
>
> 关键前提（已实测，Electron 44.7.0 / Chrome 152 / DSH 0.2.1-rc.5）：
> 1. `~/Library/Application Support/Google/Chrome/<Profile>/Cookies` 与 Edge 同构；macOS 上为
>    `v10` + AES-128-CBC + PBKDF2-SHA1(password, "saltysalt", 1003, 16) + IV=16 空格；
>    明文 = 32 字节 SHA256(host_key) + value + PKCS7 padding。
> 2. 只有当 DSH 桌面应用以 `--remote-debugging-port=<port>` 启动时，插件才能通过 CDP 注入；
>    webview 客体会出现在 `http://127.0.0.1:<port>/json/list`（`type: "webview"`），
>    带 `webSocketDebuggerUrl`，`Network.setCookies` 可写入含 HttpOnly 的 cookie。
> 3. 端口可用 `--remote-debugging-port=0` 随机；Chromium 会把实际端口写进
>    `<userDataDir>/DevToolsActivePort`（第一行端口，第二行 `/devtools/browser/...`）。
>    真实应用 userDataDir（macOS）：`~/Library/Application Support/@deepseek-ai/dsh-desktop`。
> 4. 分区是进程内内存会话（重启即丢），所以注入是对"每个新 webview target"的事件式动作，
>    不是持久化写盘。

## 代码布局（所有文件位于本工作区，包名 `@sidleo3/dsh-browser-plus`）

| 文件 | 归属 | 说明 |
|---|---|---|
| `package.json` / `cordis.patch.yml` / `README.md` | Lead | manifest、bundle 行、文档 |
| `index.js` | Lead | Host 半：Config、设置存储、HTTP 路由、agent 工具、自动注入循环 |
| `lib/cdp.mjs` | Lead | CDP 桥发现 + webview target 枚举 + 注入 |
| `lib/settings.mjs` | Lead | 设置 JSON 持久化（`$DSH_HOME/browser-plus/settings.json`） |
| `lib/cookie-source.mjs` | **cookie-core** | 浏览器/配置目录发现、Cookie DB 复制、解密、过滤、CDP 转换、汇总 |
| `test/cookie-source.test.mjs` | **cookie-core** | 针对真实 Chrome/Edge 数据库的只读测试 + 合成用例 |
| `client.js` | **client-page** | 浏览器半：设置页（Settings → Browser Plus + 插件页）、纯 JS、`__ModuleLoader__` 格式 |
| `locale/en.json` `locale/zh.json` | **client-page** | 插件显示元数据 `meta.title` / `meta.description` |
| `icon.svg` | **client-page** | 原创图标（≤256KiB，主题色） |
| `test/client-syntax.test.mjs` | **client-page** | `node --check client.js` + 关键字符串存在性自检 |

约束：**不引入任何 npm 依赖**；只用 Node 内置模块（`node:crypto`、`node:fs/promises`、`node:child_process`、
`node:os`、`node:path`、`node:sqlite` 动态 import）与浏览器全局；`client.js` 只能 `require('react')`
（模块表种子词），其余用 `document`/`fetch`/`window`。
安全红线：**cookie 的 name/value 永不出现在 HTTP 响应之外的地方**——不写日志、不进 agent 工具输出、
不进错误消息；测试用例不得把真实 cookie value 写进仓库或输出。

## 数据契约

### CookieRecord（cookie-source 输出）
```js
{
  hostKey: '.example.com',        // Chrome cookies.host_key；以 '.' 开头 = domain cookie
  name: 'SRCHD',
  value: 'AF=NOFORM',             // 解密后明文 value
  path: '/',                      // path 列，可能为空串
  expiresUtc: '13453718236226348',// 原始字符串（超出 JS safe int，SQL 里 CAST AS TEXT）
  expiresUnix: 1770000000,        // 秒；<=0 表示 session cookie
  secure: true, httpOnly: false,
  sameSite: 'Unspecified'|'Strict'|'Lax'|'None',   // samesite 列 -1/0/1/2
  isPersistent: true,
  topFrameSiteKey: '',            // 非空 = partitioned (CHIPS)
  hasCrossSiteAncestor: false,
  sourceScheme: 2,                // 0/1/2，仅作过滤参考
}
```

### 设置（Host 持久化，默认值见下；`GET state` 返回合并后的权威值）
```js
{
  browser: 'auto'|'edge'|'chrome',   // auto：优先 edge，其次 chrome
  profile: '',                       // '' = 该浏览器的 Default 配置
  scope: 'all'|'allowlist',
  domains: [],                       // allowlist：'.example.com' 或 'example.com'（后缀匹配）
  autoInject: true,                  // 轮询新 webview target 自动注入
  autoBridge: true,                  // 启动自检：桌面应用无调试端口时自动带端口重启一次（见下）
  includeSessionCookies: true,
  cdpPort: 0,                        // 0 = 自动发现
  userDataDir: '',                   // '' = 自动（真实桌面应用默认路径）
  reloadAfterInject: true,           // 首次注入后 reload 一次；必须等页面加载完成再刷（见 lib/cdp.mjs）
  refreshSeconds: 60,                // 自动注入时 jar 重读间隔（DB mtime 变化才真正重读）
}
```

### 启动自检：自动启用调试端口（autoBridge）

Electron 的 `--remote-debugging-port` 只能在应用启动时打开；插件拿不到 Electron session，所以
「内置浏览器免登录」必须以调试端口启动。为了让用户正常启动也能用，Host 半在启动后自检一次：

1. 读宿主父进程命令行：`ps -ww -o command= -p <process.ppid>`。Host 的父进程就是 Electron 主进程，
   其命令行形如 `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness [--remote-debugging-port=N]`。
   用 `parseHostParentCommand()` 解析出 `isDesktopApp / hasDebugPort / appBundle / executableName`。
2. 决策（`planAutoBridge()`，纯函数、有单测）：
   - 非 macOS / `settings.autoBridge !== true` / 父进程不是 `.app` 桌面应用 → `skip`；
   - 命令行已有 `--remote-debugging-port` → `reset`（清重启标记，不动）；
   - 确认是桌面应用且无端口、且最近 `AUTO_BRIDGE_GUARD_MS`（10 分钟）内没有重启过 → `relaunch`。
3. `relaunch`：脚本由 `lib/relaunch-shell.mjs` 的 `buildRelaunchScript()` 生成并 detached 执行。
   流程：优雅 `osascript quit` → 等主进程与 Host 子进程都退出（超时 TERM → KILL）→ 等端口释放 →
   `sleep 2` 等 Chromium 单例锁释放 → **直接执行应用二进制**
   `nohup <bin> --remote-debugging-port=<port>`（`open --args` 在应用未完全退出时会被忽略，不用）→
   轮询端口验证，失败清理重试（最多 `RELAUNCH_MAX_ATTEMPTS`=3 次）→ 仍失败则回退 `open -a <bundle>`
   正常启动 DSH（保证用户有应用可用）。
   重启前把 `{attempts,lastAt,port,outcome}` 写入 `$DSH_HOME/browser-plus/auto-bridge.json`；
   脚本结果（ok/failed + detail）写入 `relaunch-result.json`。
   决策补充：上次 `failed` 时 1 分钟后允许重试；连续失败 3 次进入 30 分钟长冷却，
   冷却结束后的冷启动重新获得一次机会（`cooldown-expired`）。
4. 自检在 `apply` 后延迟 `AUTO_BRIDGE_DELAY_MS`（700ms）执行一次（`setTimeout().unref()`），
   结果放在 state.autoBridge，供设置页/`browser_plus status` 展示。

安全性：只有确认「父进程是 DSH 桌面应用」且其命令行**没有**端口时才重启；CLI/headless Host
（父进程不是 .app）永不触发；标记文件保证同一窗口内最多重启一次。

### Host HTTP API（注册在 `webServer`，客户端同源 `fetch`；全部返回 JSON，`ok:false` 带 `error`）
- `GET /api/browser-plus/state?refresh=1`
  → 完整状态：
  ```js
  { ok:true,
    platform: { os:'darwin', supported:true, keychain:'ok'|'denied'|'unknown', note:'' },
    settings: {...},
    bridge: { available, port, source:'configured'|'user-data-dir'|'scan'|null, version, userDataDir,
              targets:[{id,url,title}], checkedAt, error, hint },
    browsers: [ { id:'edge', name:'Microsoft Edge', installed:true, dataDir, keychainService,
                  keychainAvailable, profiles:[{id:'Default', name:'用户配置 1', cookieCount:1107}] } ],
    activeSource: { browser, profile, label },
    jar: { loaded, count, domainCount, httpOnly, secure, session, browser, profile, loadedAt,
           durationMs, topDomains:[{domain,count}], error },
    lastInject: { at, ok, count, targets:[{id,url,ok,count,reloaded,error}], error },
    autoBridge: { enabled, action:'pending'|'already-ported'|'skip'|'relaunching'|'failed'|'error',
                  reason, attempts, lastAt, port, error, lastOutcome:'ok'|'failed'|null, maxAttempts },
    host: null | { isDesktopApp, hasDebugPort, debugPort, appBundle, executableName } }
  ```
- `POST /api/browser-plus/settings`，body `{ patch: {…部分设置…} }` → `{ ok, settings }`
  （校验：browser/scope 枚举、domains 字符串数组、cdpPort 0..65535、refreshSeconds 10..3600）
- `POST /api/browser-plus/action`，body `{ action }`：
  - `sync`：重读 jar（强制）→ 若桥可用注入所有 webview（未注入过的 target 且是真实 URL 时 reload；等页面加载完成后再刷）
  - `inject`：用现有 jar 注入
  - `rescan`：清缓存、重新发现桥与浏览器目录
  → `{ ok, message, state }`

### agent 工具 `browser_plus`
- 参数：`{ action: 'status'|'sync'|'domains', cdpPort?: number }`（`cdpPort` 仅用于本次调用的桥发现覆盖）
- 输出纯文本（`{ schema:{type:'object',properties:{text:{type:'string'}},required:['text']}, render }`）。
- `status`：桥状态 / 当前来源 / jar 计数 / 是否开启自动注入 / 启用桥的命令提示。
- `sync`：执行一次"重读+注入"，返回计数与每个 target 的结果（**不含 cookie 名值**）。
- `domains`：返回计数最多的域名（最多 30 个，形如 `.example.com 23 条`），**不含 cookie 名值**。

## lib/cookie-source.mjs 导出（cookie-core 实现）
```js
export const BROWSERS = [ /* {id,name,keychainService, darwinDataDir, winDataDir, linuxDataDir} */ ]
export async function listBrowserCatalog(opts?)      // → [{id,name,installed,dataDir,keychainService,keychainAvailable,profiles:[{id,name,cookieCount}]}]
export async function readCookies(opts?)             // → { browser, profile, profileName, cookies:[CookieRecord], skipped:[{reason,count}], durationMs }
export function filterCookies(cookies, settings)     // → CookieRecord[]
export function toCdpCookie(record)                  // → Network.CookieParam | null
export function summarize(cookies, { top = 20 })     // → { count, domainCount, httpOnly, secure, session, topDomains:[{domain,count}] }
```
- `listBrowserCatalog` 通过 `Local State` 的 `profile.info_cache` 读 profile 显示名，目录扫描兜底；
  profile 的 cookie 计数用"复制 DB + `select count(*)`"时也要能容忍浏览器运行中（可只读复制，忽略计数失败）。
- `readCookies` 必须：temp 目录复制 `Cookies` / `Cookies-wal` / `Cookies-shm` → `node:sqlite` 读取 →
  解密 → 校验 32 字节 host hash（`sha256(hostKey)`）→ 丢弃过期/无法解密条目并计数到 `skipped` →
  清理 temp 目录。macOS keychain 通过 `/usr/bin/security find-generic-password -w -s <service>` 取密码，
  单进程内缓存。`process.platform !== 'darwin'` 时返回明确错误（v1 仅支持 macOS 解密）。
- `filterCookies`：按 settings.scope/domains/includeSessionCookies。
- `toCdpCookie`：
  - host-only（hostKey 不以 '.' 开头）→ `{ name, value, url: `${secure?'https':'http'}://${hostKey}${path||'/'}`, secure, httpOnly, sameSite?, expires?, partitionKey? }`
  - domain cookie → `{ name, value, domain: hostKey, path: path||'/', … }`
  - `sameSite` 仅当非 'Unspecified' 时带上；`expires` 仅当 `expiresUnix>0`；
    `topFrameSiteKey` 非空时带 `partitionKey:{ topLevelSite, hasCrossSiteAncestor }`。
- 路径默认 `/`；value 为空串的 cookie 保留（有些站点用空值）。

## lib/cdp.mjs 导出（Lead 实现，client-page 不需要）
```js
export async function discoverBridge({ port=0, userDataDir='', timeoutMs=500 }={})
  // → { available, port, source, version, userDataDir, targets, error }
export async function listWebviews(port, timeoutMs=800)   // → [{id,url,title,webSocketDebuggerUrl,parentId}]
export async function injectToTarget({ target, cookies, reload=false, timeoutMs=6000, connect=openWebSocket })
  // → { id, url, ok, count, failed, reloaded, error }
  // reload 必须走 guest 内部 `Runtime.evaluate('location.reload()')`；
  // 不能用 CDP `Page.reload`——Electron 44 的 webview target 上它会把宿主 DSH 页面一起重载
  // （症状：输入网址后 DSH 闪一下、Browser 标签退回「恢复页面」）。
  // reload 前必须等 guest 真正停在一个加载完成的真实 http(s) 文档上（readyState==='complete'），
  // 否则会顶掉 DSH 打开新标签时的首次 `loadURL()`，使它以 ERR_ABORTED 拒绝并在 Browser 标签
  // 显示「页面加载失败；请刷新重试…」（DSH 只按 error.code 判断，webview IPC 回来的错误丢了 code）。
  // `connect` 仅测试注入用（fake socket），生产调用省略。
```

## client.js（浏览器半）实现契约
- 格式（照抄 `~/.dsh/profiles/desktop/node_modules/@sidleo3/dsh-wiki/lib/client.js` 的骨架）：
  ```js
  window.__ModuleLoader__.load({
    id: '@sidleo3/dsh-browser-plus',
    factory: (require) => {
      const React = require('react');
      const e = React.createElement;
      // ...组件...
      function apply(ctx) {
        const slots = ctx.get('slots'); if (!slots) return;
        injectStyles();
        slots.inject('settings.section', () => slots.register({ name:'settings.section', id:'browser-plus', order:65, label:'浏览器 Cookie 同步' }, () => e(BrowserPlusPage, { head:true })));
        slots.inject('plugins.bundle.config', () => slots.register({ name:'plugins.bundle.config', key:'@sidleo3/dsh-browser-plus' }, () => e(BrowserPlusPage, { head:false })));
      }
      return { inject: ['slots'], apply };
    },
  });
  ```
- 页面（`BrowserPlusPage`，`head` 决定是否画标题）：
  1. **桥接状态卡**：`bridge.available`
     - 可用：绿点 + `CDP 已连接 · 端口 <port> · 当前 <targets.length> 个浏览标签`，列出 target URL（最多 5 条）。
     - 不可用：橙色说明 + `state.autoBridge` 的自检状态——插件会在 DSH 启动时自动带端口重启一次，
       无需任何手动操作；失败时本实例保持可用、下次启动自动重试。只有"重新检测"按钮（action rescan），
       页面不提供任何手动重启/复制命令/启动器入口。
  2. **Cookie 来源**：浏览器下拉（只列 installed）+ profile 下拉（显示 cookie 数）；
     "重新扫描"按钮；展示 `activeSource.label` 与 keychain 状态（denied 时提示"请在系统钥匙串弹窗中允许"）。
  3. **共享范围**：单选 全部 cookie / 仅指定域名（`scope`），allowlist 用 textarea（每行一个域名）；
     勾选 `includeSessionCookies`、`autoInject`、`reloadAfterInject`；数字输入 `refreshSeconds`（10–3600）；
     "保存设置"按钮（POST settings，成功后刷新 state）。
  4. **状态与操作**：jar 摘要（条数/域名数/HttpOnly/会话 cookie/读取耗时/来源/时间）；
     "立即同步并注入"（action sync）、"仅注入"（action inject）；展示 `lastInject` 逐 target 结果与时间；
     `jar.error` / `lastInject.error` 红色显示。
  5. 底部安全提示：cookie 只注入本机内置浏览器分区；调试端口仅监听 127.0.0.1，用完可退出 DSH 重启关闭；
     插件不写日志、不暴露 cookie 值。
- 交互细节：`busy` 状态禁用按钮；错误显示在对应卡片；首屏 `GET state`，之后每 4s 静默刷新（页面卸载清理定时器）；
  不引入任何组件库、不 import DSH primitives；样式全部自带 `bp-` 前缀 class + `--dsw-alias-*` 主题 token；
  CSS 通过 `<style data-browser-plus>` 注入一次。
- 文案：中文界面即可（用户为中文）；`locale/en.json`、`locale/zh.json` 只放 `meta.title`/`meta.description`。

## 目录/环境提示
- 工作区：本仓库根目录
- 参考实现（可读不可改）：`~/.dsh/profiles/desktop/node_modules/@sidleo3/dsh-wiki/lib/client.js`（整页示例）、
  `~/.dsh/profiles/desktop/node_modules/@sidleo3/dsh-wiki/wiki.mjs`（Host 路由/工具/日志写法）、
  `/tmp/dshapp/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js`（内置浏览器 webview 的实现，
  元素带 `data-sidebar-browser-frame="webview"`，`about:blank#<lease>` 引导）。
- 真实 cookie 库：`~/Library/Application Support/Google/Chrome/Default/Cookies`（153 条）、
  `~/Library/Application Support/Microsoft Edge/Default/Cookies`（1107 条）。**只读**，不要写入/删除。
- 验证命令：`node --check client.js`、`node --test test/`。不要运行 `plugin_manager`、不要重启 DSH。
