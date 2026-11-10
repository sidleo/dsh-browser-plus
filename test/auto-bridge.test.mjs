/**
 * 自动启用桥接：决策逻辑 / 父进程命令行解析 / 重启标记读写。
 *
 * 背景：Electron 的调试端口只能在应用启动时打开，所以「正常启动 DSH 也能用内置浏览器免登录」
 * 需要在启动时自检一次：确认是桌面应用且启动参数没有 `--remote-debugging-port` 时，
 * 自动带端口重启。这里锁住判断与防循环逻辑（避免误重启 / 反复重启）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  AUTO_BRIDGE_GUARD_MS,
  AUTO_BRIDGE_LONG_COOLDOWN_MS,
  AUTO_BRIDGE_MAX_ATTEMPTS,
  AUTO_BRIDGE_RETRY_AFTER_MS,
  clearAutoBridgeMarker,
  clearRelaunchResult,
  parseHostParentCommand,
  planAutoBridge,
  readAutoBridgeMarker,
  readRelaunchResult,
  writeAutoBridgeMarker,
} from '../lib/auto-bridge.mjs'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/settings.mjs'

const NOW = 1_790_000_000_000
const desktopParent = (hasDebugPort) => ({ isDesktopApp: true, hasDebugPort })

test('planAutoBridge：正常启动（无端口）→ 自动重启', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: null,
    now: NOW,
  })
  assert.equal(plan.action, 'relaunch')
  assert.equal(plan.attempts, 1)
  assert.equal(plan.lastAt, NOW)
})

test('planAutoBridge：已带调试端口 → 清标记，不再重启', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(true),
    marker: { attempts: 2, lastAt: NOW - 1000 },
    now: NOW,
  })
  assert.equal(plan.action, 'reset')
})

test('planAutoBridge：设置关闭 / 非桌面应用 / 非 macOS → 跳过', () => {
  assert.equal(
    planAutoBridge({ platform: 'darwin', settings: { autoBridge: false }, parent: desktopParent(false), marker: null, now: NOW }).action,
    'skip',
  )
  assert.equal(
    planAutoBridge({ platform: 'darwin', settings: { autoBridge: true }, parent: { isDesktopApp: false }, marker: null, now: NOW }).action,
    'skip',
  )
  assert.equal(
    planAutoBridge({ platform: 'linux', settings: { autoBridge: true }, parent: desktopParent(false), marker: null, now: NOW }).action,
    'skip',
  )
})

test('planAutoBridge：刚尝试过重启（防循环）→ 跳过', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: 1, lastAt: NOW - 60_000 },
    now: NOW,
  })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'recent-attempt')
})

test('planAutoBridge：上次自动重启失败 → 一分钟后允许重试', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: 1, lastAt: NOW - AUTO_BRIDGE_RETRY_AFTER_MS - 1, outcome: 'failed' },
    now: NOW,
  })
  assert.equal(plan.action, 'relaunch')
  assert.equal(plan.reason, 'retry-after-failure')
  assert.equal(plan.attempts, 2)
})

test('planAutoBridge：失败但刚发生（<1 分钟）→ 仍跳过', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: 1, lastAt: NOW - 5_000, outcome: 'failed' },
    now: NOW,
  })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'recent-attempt')
})

test('planAutoBridge：失败次数达到上限 → 冷却期内跳过', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: AUTO_BRIDGE_MAX_ATTEMPTS, lastAt: NOW - AUTO_BRIDGE_GUARD_MS - 1, outcome: 'failed' },
    now: NOW,
  })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'max-attempts')
})

test('planAutoBridge：长冷却结束 → 重新自动尝试一次（失败计数重置）', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: AUTO_BRIDGE_MAX_ATTEMPTS, lastAt: NOW - AUTO_BRIDGE_LONG_COOLDOWN_MS - 1, outcome: 'failed' },
    now: NOW,
  })
  assert.equal(plan.action, 'relaunch')
  assert.equal(plan.reason, 'cooldown-expired')
  assert.equal(plan.attempts, 1)
})

test('planAutoBridge：超过防循环时间窗 → 允许再次尝试', () => {
  const plan = planAutoBridge({
    platform: 'darwin',
    settings: { autoBridge: true },
    parent: desktopParent(false),
    marker: { attempts: 1, lastAt: NOW - AUTO_BRIDGE_GUARD_MS - 1 },
    now: NOW,
  })
  assert.equal(plan.action, 'relaunch')
  assert.equal(plan.attempts, 2)
})

test('parseHostParentCommand：识别桌面应用与调试端口', () => {
  const withoutPort = parseHostParentCommand('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
  assert.equal(withoutPort.isDesktopApp, true)
  assert.equal(withoutPort.executableName, 'DeepSeek Harness')
  assert.equal(withoutPort.appBundle, '/Applications/DeepSeek Harness.app')
  assert.equal(withoutPort.hasDebugPort, false)

  const withPort = parseHostParentCommand(
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --remote-debugging-port=9222',
  )
  assert.equal(withPort.hasDebugPort, true)
  assert.equal(withPort.port, 9222)

  const spaced = parseHostParentCommand(
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --remote-debugging-port 9333 --foo',
  )
  assert.equal(spaced.hasDebugPort, true)
  assert.equal(spaced.port, 9333)
})

test('parseHostParentCommand：非桌面应用（node / CLI Host）不触发', () => {
  for (const command of ['', '/usr/local/bin/node /path/to/dsh-host.js', '/bin/sh -c x']) {
    const parsed = parseHostParentCommand(command)
    assert.equal(parsed.isDesktopApp, false, command)
    assert.equal(parsed.hasDebugPort, false, command)
  }
})

test('重启标记：写入 / 读取 / 清除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-auto-bridge-'))
  try {
    assert.equal(await readAutoBridgeMarker(dir), null)
    assert.equal(await writeAutoBridgeMarker(dir, { attempts: 1, lastAt: NOW, port: 9222 }), true)
    const marker = await readAutoBridgeMarker(dir)
    assert.deepEqual(marker, { attempts: 1, lastAt: NOW, port: 9222, outcome: null, resultAt: null })
    assert.equal(
      await writeAutoBridgeMarker(dir, { attempts: 2, lastAt: NOW + 1, port: 9222, outcome: 'failed', resultAt: NOW + 1 }),
      true,
    )
    assert.equal((await readAutoBridgeMarker(dir)).outcome, 'failed')
    assert.equal(await clearAutoBridgeMarker(dir), true)
    assert.equal(await readAutoBridgeMarker(dir), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('重启结果文件：读取（秒级时间戳）/ 清除 / 非法内容忽略', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-relaunch-result-'))
  try {
    const { writeFile } = await import('node:fs/promises')
    assert.equal(await readRelaunchResult(dir), null)
    await writeFile(join(dir, 'relaunch-result.json'), JSON.stringify({ outcome: 'ok', at: 1_790_000_000, port: 9222, detail: 'launched' }))
    const ok = await readRelaunchResult(dir)
    assert.equal(ok.outcome, 'ok')
    assert.equal(ok.at, 1_790_000_000_000)
    await writeFile(join(dir, 'relaunch-result.json'), JSON.stringify({ outcome: 'failed', at: NOW, port: 9222, detail: 'port-not-ready' }))
    assert.equal((await readRelaunchResult(dir)).outcome, 'failed')
    await writeFile(join(dir, 'relaunch-result.json'), 'not json')
    assert.equal(await readRelaunchResult(dir), null)
    assert.equal(await clearRelaunchResult(dir), true)
    assert.equal(await readRelaunchResult(dir), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('设置：autoBridge 默认开启且可关闭', () => {
  assert.equal(DEFAULT_SETTINGS.autoBridge, true)
  assert.equal(normalizeSettings({}, DEFAULT_SETTINGS).value.autoBridge, true)
  assert.equal(normalizeSettings({ autoBridge: false }, DEFAULT_SETTINGS).value.autoBridge, false)
  assert.equal(normalizeSettings({ autoBridge: 'yes' }, DEFAULT_SETTINGS).value.autoBridge, false)
})
