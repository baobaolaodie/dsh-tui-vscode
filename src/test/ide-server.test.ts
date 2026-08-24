import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  IdeServer,
  IDE_LOCK_DIR_NAME,
  lockFileName,
  buildLockPayload,
  buildSelectionChanged,
  envForSession,
} from '../ide/server.js'

/** mkdtemp 临时 lockRoot——绝不写真实 ~/.dsh-tui（DESIGN §7 隔离策略）。 */
function makeLockRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-ide-lock-'))
}

test('IDE_LOCK_DIR_NAME is the cross-repo contract directory name', () => {
  assert.equal(IDE_LOCK_DIR_NAME, 'ide')
})

test('lockFileName is <port>.lock', () => {
  assert.equal(lockFileName(41234), '41234.lock')
  assert.equal(lockFileName(1), '1.lock')
})

test('buildLockPayload carries port, token, workspaceFolders, pid — nothing else', () => {
  const payload = buildLockPayload({
    port: 40000,
    token: 'tok',
    workspaceFolders: ['D:/repo', 'E:/other'],
    pid: 1234,
  })
  assert.deepEqual(payload, { port: 40000, token: 'tok', workspaceFolders: ['D:/repo', 'E:/other'], pid: 1234 })
  // 坐标 only 契约：lock 里不允许出现选区/文本字段
  const keys = Object.keys(payload).sort()
  assert.deepEqual(keys, ['pid', 'port', 'token', 'workspaceFolders'])
})

test('buildSelectionChanged sends coordinates only (no text content)', () => {
  const message = JSON.parse(
    JSON.stringify(
      buildSelectionChanged({ path: 'src/a.ts', startLine: 11, endLine: 13, isEmpty: false }),
    ),
  )
  assert.equal(message.method, 'selection_changed')
  assert.deepEqual(message.params, { path: 'src/a.ts', startLine: 11, endLine: 13, isEmpty: false })
  // 坐标 only：params 键集合固定，禁止文本泄漏
  assert.deepEqual(Object.keys(message.params).sort(), ['endLine', 'isEmpty', 'path', 'startLine'])
})

test('envForSession uses DSH_TUI_IDE_PORT / DSH_TUI_IDE_TOKEN key names', () => {
  const env = envForSession({ port: 39999, token: 'sec' })
  assert.equal(env.DSH_TUI_IDE_PORT, '39999')
  assert.equal(env.DSH_TUI_IDE_TOKEN, 'sec')
  assert.deepEqual(Object.keys(env).sort(), ['DSH_TUI_IDE_PORT', 'DSH_TUI_IDE_TOKEN'])
})

test('start writes the lock file and stop removes it; start is idempotent', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({
      token: 'tok-abc',
      lockRoot,
      workspaceFolders: () => ['D:/repo'],
    })
    const first = await server.start()
    assert.equal(first.DSH_TUI_IDE_TOKEN, 'tok-abc')
    const port = Number(first.DSH_TUI_IDE_PORT)
    assert.ok(Number.isSafeInteger(port) && port >= 1 && port <= 65535)

    // lock 文件存在且内容与 payload 对齐
    const lockPath = join(lockRoot, 'ide', `${port}.lock`)
    assert.ok(existsSync(lockPath))
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(parsed.port, port)
    assert.equal(parsed.token, 'tok-abc')
    assert.deepEqual(parsed.workspaceFolders, ['D:/repo'])
    assert.ok(Number.isSafeInteger(parsed.pid))

    // 幂等：二次 start 返回同一 env，不重复监听（端口不变即证明）
    const second = await server.start()
    assert.deepEqual(second, first)

    // stop 清 lock、关 server
    await server.stop()
    assert.ok(!existsSync(lockPath))

    // 重启后可再次工作（stop 后状态复位）
    const third = await server.start()
    assert.notEqual(Number(third.DSH_TUI_IDE_PORT), port)
    await server.stop()
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('start failure does not leave a stale lock behind', async () => {
  const lockRoot = makeLockRoot()
  try {
    // 占用 lock 目录路径：mkdirSync 将失败 → start 抛错 → 不得残留 lock
    const ideDir = join(lockRoot, 'ide')
    writeFileSync(ideDir, 'not a directory', 'utf8')
    let thrown: unknown
    const server = new IdeServer({ token: 'b', lockRoot, workspaceFolders: () => [] })
    try {
      await server.start()
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof Error)
    assert.ok(!existsSync(join(ideDir, '1.lock')))
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('broadcastSelection reaches a connected ws client after hello handshake', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({
      token: 'tok-hs',
      lockRoot,
      workspaceFolders: () => ['D:/ws'],
    })
    const env = await server.start()
    const port = Number(env.DSH_TUI_IDE_PORT)

    const WebSocket = (await import('ws')).WebSocket
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    socket.send(JSON.stringify({ method: 'ide/hello', params: { token: 'tok-hs' } }))
    // 握手静默接受：无 ack 帧；轮询等待 server 注册该 client（消除时序竞态）
    for (let waited = 0; server.clientCount === 0 && waited < 1000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(server.clientCount, 1)

    const received: Array<Record<string, unknown>> = []
    socket.on('message', raw => {
      received.push(JSON.parse(String(raw)))
    })

    const pushed = server.broadcastSelection({
      path: 'src/b.ts',
      startLine: 0,
      endLine: 2,
      isEmpty: false,
    })
    assert.ok(pushed)

    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(received.length, 1)
    assert.equal(received[0].method, 'selection_changed')
    assert.deepEqual(received[0].params, {
      path: 'src/b.ts',
      startLine: 0,
      endLine: 2,
      isEmpty: false,
    })

    socket.close()
    await server.stop()
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('broadcastSelection with no clients returns false without throwing', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({ token: 't', lockRoot, workspaceFolders: () => [] })
    await server.start()
    assert.equal(
      server.broadcastSelection({ path: 'x.ts', startLine: 0, endLine: 0, isEmpty: true }),
      false,
    )
    await server.stop()
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('stop is safe to call twice and before start', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({ token: 't2', lockRoot, workspaceFolders: () => [] })
    await server.stop()
    await server.start()
    await server.stop()
    await server.stop()
    assert.ok(true)
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})
