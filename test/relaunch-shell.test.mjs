/**
 * 自动桥接重启脚本：生成与 shell 语法校验。
 *
 * 脚本本身会重启应用，测试只校验「生成内容」与「zsh 语法」，
 * 实际重启流程靠 relaunch-result.json 与日志在真实启动时验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildRelaunchScript, RELAUNCH_MAX_ATTEMPTS } from '../lib/relaunch-shell.mjs'

function zshCheck(scriptPath) {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-n', scriptPath], { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

test('buildRelaunchScript：文件名/端口/结果文件正确写入脚本', () => {
  const script = buildRelaunchScript({
    appBundle: '/Applications/DeepSeek Harness.app',
    executableName: 'DeepSeek Harness',
    port: 9222,
    logFile: '/tmp/bp test logs/relaunch.log',
    resultFile: '/tmp/bp test logs/relaunch-result.json',
  })
  assert.match(script, /^#!\/bin\/zsh\n/u)
  assert.match(script, /APP_BIN="\/Applications\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness"/u)
  assert.match(script, /PORT="9222"/u)
  assert.match(script, /LOG="\/tmp\/bp test logs\/relaunch\.log"/u)
  assert.match(script, /RESULT="\/tmp\/bp test logs\/relaunch-result\.json"/u)
  assert.match(script, new RegExp(`MAX_ATTEMPTS=${RELAUNCH_MAX_ATTEMPTS}`, 'u'))
  // 关键行为：直接启动二进制并带端口、退出后等 Host 子进程、失败回退正常启动
  assert.match(script, /--remote-debugging-port="\$PORT"/u)
  assert.match(script, /host_pids\(\)/u)
  assert.match(script, /open -a "\$APP_BUNDLE"/u)
  assert.match(script, /write_result failed port-not-ready/u)
})

test('buildRelaunchScript：zsh 语法通过', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-relaunch-shell-'))
  try {
    const script = buildRelaunchScript({
      appBundle: '/Applications/DeepSeek Harness.app',
      executableName: 'DeepSeek Harness',
      port: 9222,
      logFile: join(dir, 'relaunch.log'),
      resultFile: join(dir, 'relaunch-result.json'),
    })
    const file = join(dir, 'relaunch.command')
    await writeFile(file, script, 'utf8')
    const checked = await zshCheck(file)
    assert.equal(checked.error, null, checked.stderr)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
