# dsh-browser-plus · 内置浏览器 Cookie 同步

> 让 DSH 内置浏览器（右侧栏 **Browser** 标签）直接带上你 Chrome / Edge 的登录态：
> 不用在内置浏览器里重复登录，也不会因为"二次登录"把你自己浏览器的会话挤下线。

## 它解决什么问题

DSH 桌面端的内置浏览器是 Electron `<webview>`，每个工作区使用**进程内内存分区**：
cookie/登录态不落盘、应用重启即清空，因此每次都要重新登录；而很多站点点对点单会话，
在内置浏览器里重新登录会把用户自己浏览器里的登录踢掉。

本插件把用户自用浏览器的 cookie 数据库读出来（解密），再通过**本机 CDP 调试桥**批量写进
内置浏览器对应分区（**包含 HttpOnly**），于是内置浏览器打开网页时就是已登录状态。

## 前提：调试端口（全自动，用户无需任何操作）

插件通过 Electron 的 DevTools 协议访问内置浏览器的 webview 分区，这要求桌面版 DSH 在启动时
带上 `--remote-debugging-port`（只监听 127.0.0.1，不会暴露到局域网）。调试端口只能在 Electron
进程启动瞬间打开，运行中补开只能整应用重启，所以插件在每次启动后自检一次并自动处理：

- **正常启动 DSH 即可，不用脚本、不用点击、不用改启动方式**：若本次启动没带调试端口，插件会自动
  以带端口的方式重启一次（窗口关掉约 3~6 秒后自动回来，日志 `$DSH_HOME/browser-plus/relaunch.log`），
  之后内置浏览器第一次打开就是登录态。
- **重启流程**（脚本在 `lib/relaunch-shell.mjs`）：优雅 quit → 等主进程和 Host 子进程都退出 →
  等 Chromium 单例锁释放 → **直接执行应用二进制**并带 `--remote-debugging-port`（本机实测最可靠，
  `open --args` 在应用未完全退出时会被忽略）→ 轮询端口验证 → 失败清理后重试（最多 3 次）。
- **失败也绝不让你没应用可用**：3 次仍失败时回退为「正常启动 DSH」，本实例照常可用，下次启动会再自动尝试。
- **防循环**：重启前写标记 `$DSH_HOME/browser-plus/auto-bridge.json`，脚本把本次结果写到
  `relaunch-result.json`。上次 `ok` 时 10 分钟内不再自动重启；上次 `failed`（新实例仍没有端口）
  则 1 分钟后允许重试；连续失败 3 次后进入 30 分钟长冷却，冷却过后的下一次启动会再自动尝试。
  设置页「正常启动时自动启用桥接」可关闭。CLI/headless Host（父进程不是 `.app`）永不触发。
- 因为代价是"每次未带端口的启动都会自动重启一次"，**不要**用替身 App 改 Dock 图标的方式绕过：
  macOS 上运行中的应用会在 Dock 运行区多出一个相同的图标（实测），体验更差。

排障：若设置页仍显示「未连接」，先看 `$DSH_HOME/browser-plus/relaunch.log` 与
`relaunch-result.json` 的最后结果；确认实例是否带端口：`ps -ww -o command= -p <主进程 pid>`
看是否含 `--remote-debugging-port`，或 `curl -s http://127.0.0.1:9222/json/version`。

## 使用方法

1. 安装本插件：
   ```bash
   # npm 版（发布后）
   dsh plugin --profile <profile> add @sidleo3/dsh-browser-plus
   # 或本地开发版（改源码即时生效）
   dsh plugin --profile <profile> add link:/abs/path/to/dsh-browser-plus
   ```
   装完把 `@sidleo3/dsh-browser-plus` 加进该 profile `package.json` 的 `dsh.profile.bundles`。
2. 正常启动 DSH 即可（未带端口时插件会自动重启一次，无需任何操作）。
3. 打开 设置 → **浏览器 Cookie 同步**：
   - **Cookie 来源**：选择 Edge 或 Chrome（自动 / 手动），选择 profile（多用户配置时）；
   - **共享范围**：默认共享全部 cookie；也可以只允许指定域名（每行一个，如 `.example.com`）；
   - 勾选「自动注入」：内置浏览器每新开一个标签，插件会在 1~2 秒内注入并（按需）刷新页面。
4. 在右侧栏打开 **Browser** 标签，访问目标站点——应已是登录态。
5. 需要时点「立即同步并注入」重新读取浏览器最新 cookie（例如你刚在自己的浏览器里重新登录过）。

配置项说明：

| 设置 | 默认 | 说明 |
|---|---|---|
| `browser` | `auto` | `auto` 优先 Edge，其次 Chrome |
| `profile` | `Default` | 浏览器多用户配置的目录名 |
| `scope` / `domains` | `all` / 空 | 共享全部，或按域名后缀白名单共享 |
| `autoInject` | 开 | 新开 Browser 标签自动注入 |
| `autoBridge` | 开 | 正常启动且无调试端口时，自动带端口重启一次（无手动操作） |
| `includeSessionCookies` | 开 | 是否包含会话 cookie（expires=0） |
| `cdpPort` | 0 | 0 = 自动发现；也可写死端口（如 9222） |
| `userDataDir` | 空 | Electron userDataDir；空 = 自动发现 |
| `reloadAfterInject` | 开 | 首次注入后刷新一次以应用登录态；刷新前会等页面加载完成（最多 15s），不打断 DSH 的首次导航 |
| `refreshSeconds` | 60 | 自动注入时重新读取浏览器 cookie 库的最小间隔 |

## agent 用法

插件注册了 `browser_plus` 工具（不含任何 cookie 名值）：

- `browser_plus({ action: "status" })`：CDP 桥 / cookie 来源 / 自动注入状态；
- `browser_plus({ action: "sync" })`：重读用户浏览器 cookie 并注入当前所有内置浏览器标签；
- `browser_plus({ action: "domains" })`：按域名汇总同步范围内的 cookie 条数（只给域名与数量）。

## 安全

- Cookie 只在 Host 进程内存中解密，经 `127.0.0.1` 的 DevTools 端口写入内置浏览器的内存分区；
  **不写日志、不上传网络、不进 agent 上下文**，设置页只显示计数与域名。
- 调试端口等价于"本机任意进程可控制 DSH 窗口"，只建议在自己机器上临时使用；不需要时正常启动 DSH 即可关闭。
- 浏览器 cookie 数据库只读：插件复制到临时目录后读取，不改动、不写入浏览器数据。
- 共享范围建议按需收紧（白名单），敏感站点（银行等）不要纳入。

## 已知限制

- **仅 macOS 支持解密**。Chrome/Edge 在 macOS 上使用 `v10` + AES-128-CBC（钥匙串取密钥）；
  Windows 使用 DPAPI/app-bound 方案，本版本未实现（结构上预留了平台分支）。
- 内置浏览器分区是进程内内存会话：**DSH 重启后需要重新注入**（插件会在新标签出现时自动做）。
- 个别 cookie 会被 Chromium 静默拒收（如 `SameSite=None` 但非 Secure、超大 value），通常少于 1%。
- 注入后刷新页面走 guest 内部的 `location.reload()`，**不要**用 CDP 的 `Page.reload`：在 Electron 44 的内置浏览器
  webview target 上发 Page.reload 会把宿主 DSH 页面一起重载（界面闪一下、Browser 标签退回「恢复页面」检查点）。
- 刷新必须等页面加载完成（`document.readyState === 'complete'` 且已停在真实 http(s) 地址上）再发：
  DSH 新开 Browser 标签时先 `src=about:blank#lease`、dom-ready 后 `loadURL(目标地址)`，而 `/json/list`
  的 target.url 早于提交就变成目标地址。此时抢先 `location.reload()` 会顶掉 DSH 那次导航，让它的
  `loadURL()` 以 ERR_ABORTED 拒绝——DSH 只按 `error.code` 判断（webview IPC 回来的错误丢了 code），
  于是 Browser 标签显示「页面加载失败；请刷新重试或在系统浏览器中打开。」，刷新发生在提交前时标签还会
  停在 about:blank。页面 15s 内没加载完就放弃本次刷新（宁可不刷也不打断 DSH）。
- 浏览器数据库在浏览器写入的瞬间可能短暂不一致（复制读取 + WAL 重试已覆盖常见情况）。
- 若目标站点在每次请求时轮换会话 token，"两处同时使用"仍可能互相顶号——这是站点策略，插件无法规避。
- 桌面端必须带调试端口启动；插件默认会在启动时自动带端口重启一次来满足该前提（可关闭）。
  Web 版 DSH（在用户自己浏览器里打开）不需要本插件。

## 开发

```bash
node --test          # 单元测试 + 本机 Electron 调试桥 E2E（无桥时自动 skip）
```

结构：

```
index.js              Host 半：设置/HTTP API/agent 工具/自动注入循环
lib/cookie-source.mjs Chrome/Edge 发现 + 解密 + 过滤 + CDP 参数转换
lib/cdp.mjs           调试桥发现 + webview target 枚举 + Network.setCookies
lib/settings.mjs      设置持久化（$DSH_HOME/browser-plus/settings.json）
client.js             浏览器半：设置页（Settings → 浏览器 Cookie 同步 / 插件页）
```
