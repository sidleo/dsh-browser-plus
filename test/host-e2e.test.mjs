/**
 * Host 半端到端测试：
 * - 用 mock ctx 装配 index.js（工具 + HTTP 路由），验证 state / settings / action 契约；
 * - 若本机存在测试用 Electron 调试端口（默认 9333，环境变量 BP_PROBE_PORT 可覆盖），
 *   真正走一遍 "读取用户 Edge cookie → 通过 CDP 注入 webview 分区"，并在 CDP 里核对结果。
 *
 * 测试不会读取/打印任何 cookie 的 name/value，只断言数量与布尔形状。
 * 没有探测到调试桥时该用例自动 skip，不影响其余测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'
import { discoverBridge, listWebviews } from '../lib/cdp.mjs'

const PROBE_PORT = Number(process.env.BP_PROBE_PORT || 9333)

// ────────────────────────── mock ctx / req / res ──────────────────────────

function createHostContext() {
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  const collect = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  const webCtx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    effect: (fn) => collect(fn()),
  }
  const ctx = {
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('webServer')) callback(webCtx)
    },
    effect: (fn) => collect(fn()),
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return {
    ctx,
    routes,
    tools,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {}
      }
    },
  }
}

function fakeRequest(url, body) {
  const listeners = new Map()
  const req = {
    url,
    on(event, callback) {
      listeners.set(event, callback)
      return req
    },
  }
  setImmediate(() => {
    if (body !== undefined && listeners.has('data')) listeners.get('data')(Buffer.from(JSON.stringify(body)))
    if (listeners.has('end')) listeners.get('end')()
  })
  return req
}

function fakeResponse() {
  return {
    code: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.code = code
      Object.assign(this.headers, headers || {})
    },
    end(text) {
      this.body = text
    },
  }
}

async function callRoute(routes, path, { body } = {}) {
  const lookup = path.split('?')[0]
  const handler = routes.get(lookup)
  assert.equal(typeof handler, 'function', `路由未注册：${path}`)
  const req = fakeRequest(path, body)
  const res = fakeResponse()
  await handler(req, res)
  return { status: res.code || 200, json: res.body ? JSON.parse(res.body) : null }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ────────────────────────── CDP 断言辅助 ──────────────────────────

async function withCdpSocket(webSocketDebuggerUrl, callback) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 3000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('CDP 连接失败'))
      },
      { once: true },
    )
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message && typeof message.id === 'number' && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const requestId = ++id
      pending.set(requestId, resolve)
      socket.send(JSON.stringify({ id: requestId, method, params }))
    })
  try {
    return await callback(send)
  } finally {
    try {
      socket.close()
    } catch {}
  }
}

async function allCookiesInTarget(webSocketDebuggerUrl) {
  return withCdpSocket(webSocketDebuggerUrl, async (send) => {
    await send('Network.enable')
    const response = await send('Network.getAllCookies')
    return (response.result && response.result.cookies) || []
  })
}

// ────────────────────────── 用例 ──────────────────────────

test('settings：读写、校验、默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-settings-'))
  try {
    const host = createHostContext()
    apply(host.ctx, { settingsDir: dir })
    await wait(30)
    const state = await callRoute(host.routes, '/api/browser-plus/state')
    assert.equal(state.json.ok, true)
    assert.equal(state.json.settings.scope, 'all')
    assert.equal(state.json.settings.autoInject, true)

    const bad = await callRoute(host.routes, '/api/browser-plus/settings', {
      body: { patch: { scope: 'nope', cdpPort: 70000, refreshSeconds: 1 } },
    })
    assert.equal(bad.json.ok, false)
    assert.match(bad.json.error, /共享范围|cdpPort|refreshSeconds/)

    const good = await callRoute(host.routes, '/api/browser-plus/settings', {
      body: { patch: { scope: 'allowlist', domains: ['.example.com', 'foo.test'], cdpPort: 0, refreshSeconds: 30 } },
    })
    assert.equal(good.json.ok, true)
    assert.deepEqual(good.json.settings.domains, ['.example.com', 'foo.test'])

    const reloaded = await callRoute(host.routes, '/api/browser-plus/state')
    assert.equal(reloaded.json.settings.scope, 'allowlist')
    assert.equal(reloaded.json.settings.refreshSeconds, 30)
    host.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Host E2E：读取用户浏览器 Cookie → 注入 Electron webview 分区', async (t) => {
  const bridge = await discoverBridge({ port: PROBE_PORT })
  if (!bridge.available) {
    t.skip(`未探测到端口 ${PROBE_PORT} 上的 Electron 调试桥（跳过 CDP E2E）`)
    return
  }
  const webviewsBefore = await listWebviews(PROBE_PORT)
  if (webviewsBefore.length === 0) {
    t.skip(`端口 ${PROBE_PORT} 上没有 webview 目标（跳过 CDP E2E）`)
    return
  }

  const dir = await mkdtemp(join(tmpdir(), 'bp-e2e-'))
  const host = createHostContext()
  try {
    apply(host.ctx, { settingsDir: dir })
    await wait(30)

    // 1) 指定浏览器 + 调试端口 + 关闭自动注入（测试里手动触发）
    const saved = await callRoute(host.routes, '/api/browser-plus/settings', {
      body: { patch: { browser: 'edge', cdpPort: PROBE_PORT, autoInject: false, scope: 'all' } },
    })
    assert.equal(saved.json.ok, true, saved.json.error)

    // 2) 读状态：桥可用、cookie jar 已读取（真实 Edge 库 > 500 条、存在 HttpOnly）
    const state = await callRoute(host.routes, '/api/browser-plus/state?refresh=1')
    assert.equal(state.json.ok, true)
    assert.equal(state.json.bridge.available, true, state.json.bridge.error)
    assert.ok(state.json.jar.count > 500, `jar.count=${state.json.jar.count}`)
    assert.ok(state.json.jar.domainCount > 10)
    assert.ok(state.json.jar.httpOnly > 0)
    assert.ok(Array.isArray(state.json.jar.topDomains) && state.json.jar.topDomains.length > 0)

    // 3) 同步并注入
    const synced = await callRoute(host.routes, '/api/browser-plus/action', { body: { action: 'sync' } })
    assert.equal(synced.json.ok, true, synced.json.error)
    assert.ok(synced.json.state.lastInject.targets.length >= 1)
    assert.ok(synced.json.state.lastInject.count > 500)

    // 4) 到 CDP 分区里核对：数量对得上、含 HttpOnly
    const webviews = await listWebviews(PROBE_PORT)
    assert.ok(webviews.length >= 1)
    const cookies = await allCookiesInTarget(webviews[0].webSocketDebuggerUrl)
    // CDP 会静默拒收个别不合规的 cookie（例如 SameSite=None 但非 Secure），允许 1% 以内差异
    const floor = Math.floor(state.json.jar.count * 0.99)
    assert.ok(
      cookies.length >= floor,
      `分区里 ${cookies.length} 条，少于 jar 的 ${state.json.jar.count} 条的 99%（${floor}）`,
    )
    assert.ok(cookies.some((cookie) => cookie.httpOnly === true), '分区里缺少 HttpOnly cookie')

    // 5) agent 工具：status / domains（不得包含 cookie 名值）
    const tool = host.tools.get('browser_plus')
    assert.ok(tool, 'browser_plus 工具未注册')
    const status = await tool.execute({ action: 'status' })
    assert.match(status.text, /CDP 桥：可用/)
    assert.match(status.text, /Cookie：\d+ 条/)
    const domains = await tool.execute({ action: 'domains' })
    assert.match(domains.text, /Top/)
    assert.doesNotMatch(domains.text, /=/, 'domains 输出不应包含 cookie 名值')
  } finally {
    host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
