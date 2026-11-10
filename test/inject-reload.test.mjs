/**
 * 回归测试：注入后刷新必须走 guest 内部（Runtime.evaluate location.reload），
 * 不能用 Page.reload。
 *
 * 背景（实测 Electron 44.7.0 / DSH 0.2.1-rc.5）：在内置浏览器 webview target 上发
 * Page.reload 会把宿主 DSH 页面一起重载 —— 表现是「输入网址后 DSH 闪一下、标签退回
 * 恢复页面」。这条断言锁住修复，防止以后有人把 guest 刷新改回 Page 域命令。
 *
 * 用注入的假 connect/socket 驱动真实 injectToTarget 逻辑，不需要 Electron 进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { injectToTarget } from '../lib/cdp.mjs'

/** 假 socket：记录发送的 CDP 方法，并按方法返回可控结果。 */
function fakeSocket(responses = {}) {
  const listeners = new Map()
  const calls = []
  let nextId = 0
  const socket = {
    calls,
    addEventListener(name, listener) {
      const list = listeners.get(name) || []
      list.push(listener)
      listeners.set(name, list)
    },
    send(text) {
      const message = JSON.parse(text)
      calls.push({ method: message.method, params: message.params })
      const responder = responses[message.method]
      const result = typeof responder === 'function' ? responder(message.params) : responder
      queueMicrotask(() => {
        const payload = result === undefined ? { id: message.id, result: {} } : result
        for (const listener of listeners.get('message') || []) listener({ data: JSON.stringify({ id: message.id, ...payload }) })
      })
    },
    close() {},
  }
  return socket
}

/** Runtime.evaluate 的「文档状态」应答（href + readyState）。 */
const documentState = (href = 'https://example.com/', ready = 'complete') => ({
  result: { result: { type: 'object', value: { href, ready } } },
})

/** 按 expression 分派的 Runtime.evaluate 应答：状态探测 vs 真正刷新。 */
function runtimeEvaluate(readState, onReload) {
  return (params) => {
    if (String(params && params.expression).includes('readyState')) {
      return typeof readState === 'function' ? readState() : readState
    }
    return typeof onReload === 'function' ? onReload() : onReload
  }
}

const target = { id: 'target-1', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://fake' }
const cookies = [
  { name: 'a', value: '1', domain: '.example.com', path: '/' },
  { name: 'b', value: '2', domain: '.example.com', path: '/' },
]

test('注入后刷新走 Runtime.evaluate(location.reload)，绝不发 Page.reload', async () => {
  const socket = fakeSocket({
    'Network.setCookies': { result: {} },
    'Runtime.evaluate': runtimeEvaluate(documentState(), { result: {} }),
  })
  const result = await injectToTarget({ target, cookies, reload: true, connect: async () => socket })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, true)
  assert.equal(result.count, 2)
  const methods = socket.calls.map((call) => call.method)
  assert.deepEqual(methods.slice(0, 2), ['Network.enable', 'Network.setCookies'])
  assert.equal(methods.includes('Page.reload'), false, '不允许发送 Page.reload（会重载宿主 DSH 页面）')
  const reloadCall = socket.calls.find((call) => call.method === 'Runtime.evaluate' && /location\.reload\(\)/.test(String(call.params.expression)))
  assert.ok(reloadCall, '缺少 guest 内部刷新调用')
})

test('reload=false 时不发任何刷新命令', async () => {
  const socket = fakeSocket({ 'Network.setCookies': { result: {} } })
  const result = await injectToTarget({ target, cookies, reload: false, connect: async () => socket })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, false)
  assert.equal(socket.calls.some((call) => call.method === 'Runtime.evaluate'), false)
  assert.equal(socket.calls.some((call) => call.method === 'Page.reload'), false)
})

test('批量写入被拒时退化为逐条 Network.setCookie', async () => {
  const socket = fakeSocket({
    'Network.setCookies': { error: { message: 'batch rejected' } },
    'Network.setCookie': (params) => ({ result: { success: params.name !== 'b' } }),
  })
  const result = await injectToTarget({ target, cookies, reload: false, connect: async () => socket })
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.failed, 1)
})

test('guest 刷新失败不把整次注入判失败', async () => {
  const socket = fakeSocket({
    'Network.setCookies': { result: {} },
    'Runtime.evaluate': runtimeEvaluate(documentState(), { error: { message: 'cannot reload' } }),
  })
  const result = await injectToTarget({ target, cookies, reload: true, connect: async () => socket })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, false)
  assert.equal(result.error, null)
})

// ────────────────────────── DSH 首次导航竞态回归 ──────────────────────────
//
// 背景（实测 Electron 44.7.0 / DSH 0.2.2-rc.1，2026-11-10）：点会话里的链接会在右侧栏新建 Browser 标签。
// DSH 先给 webview 设 `src=about:blank#lease`，dom-ready 后再 `loadURL(目标地址)`；`/json/list` 的
// target.url 在导航开始时就变成目标地址（早于提交），而 `loadURL()` 的 promise 要到 did-finish-load
// 才 resolve。旧实现只按 target.url 判断“已加载页”，于是会在页面还在加载时 `location.reload()`，
// 顶掉 DSH 那次导航 → loadURL 以 ERR_ABORTED 拒绝 → Browser 标签显示「页面加载失败；请刷新重试…」
// （刷新发生在提交前时标签停在 about:blank，只能手动刷新）。
// 修复：刷新前必须确认 guest 已经停在一个真实地址且 `document.readyState === 'complete'`。

test('页面还在加载时先等加载完成，再在 guest 内部刷新', async () => {
  let probes = 0
  const readState = () => {
    probes += 1
    // 前两次探测：导航已开始但页面没加载完；之后加载完成
    return probes <= 2 ? documentState('https://example.com/', 'loading') : documentState()
  }
  const socket = fakeSocket({
    'Network.setCookies': { result: {} },
    'Runtime.evaluate': runtimeEvaluate(readState, { result: {} }),
  })
  const result = await injectToTarget({
    target,
    cookies,
    reload: true,
    connect: async () => socket,
    reloadTimeoutMs: 1500,
    reloadPollMs: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, true, '加载完成后应刷新一次')
  const reloadCalls = socket.calls.filter((call) => call.method === 'Runtime.evaluate' && /location\.reload\(\)/.test(String(call.params.expression)))
  assert.equal(reloadCalls.length, 1, '只刷新一次')
  assert.ok(probes > 2, '刷新前应至少探测过一次加载中的状态')
})

test('guest 仍是 about:blank（首次导航尚未提交）时绝不刷新', async () => {
  const socket = fakeSocket({
    'Network.setCookies': { result: {} },
    'Runtime.evaluate': runtimeEvaluate(documentState('about:blank#lease-1', 'complete'), { result: {} }),
  })
  const result = await injectToTarget({
    target,
    cookies,
    reload: true,
    connect: async () => socket,
    reloadTimeoutMs: 60,
    reloadPollMs: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, false, 'about:blank 阶段刷新会打断 DSH 首次导航')
  assert.equal(socket.calls.some((call) => call.method === 'Runtime.evaluate' && /location\.reload\(\)/.test(String(call.params.expression))), false)
})

test('页面始终加载不完时放弃刷新（超过等待上限也不打断 DSH）', async () => {
  const socket = fakeSocket({
    'Network.setCookies': { result: {} },
    'Runtime.evaluate': runtimeEvaluate(documentState('https://example.com/', 'interactive'), { result: {} }),
  })
  const result = await injectToTarget({
    target,
    cookies,
    reload: true,
    connect: async () => socket,
    reloadTimeoutMs: 60,
    reloadPollMs: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.reloaded, false, '加载没完成就不刷新')
  assert.equal(socket.calls.some((call) => call.method === 'Runtime.evaluate' && /location\.reload\(\)/.test(String(call.params.expression))), false)
})
