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
  selectionLineRange,
} from '../ide/server.js'
import { buildAtMention } from '../at-mention.js'

/** mkdtemp 临时 lockRoot——绝不写真实 ~/.dsh-tui（测试隔离策略）。 */
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

test('buildSelectionChanged carries the editor buffer text and version (protocol 2)', () => {
  const message = JSON.parse(
    JSON.stringify(
      buildSelectionChanged({
        path: 'src/a.ts',
        startLine: 11,
        endLine: 13,
        isEmpty: false,
        text: 'const a = 1\nconst b = 2\nconst c = 3',
        documentVersion: 7,
      }),
    ),
  )
  assert.equal(message.method, 'selection_changed')
  assert.deepEqual(message.params, {
    path: 'src/a.ts',
    startLine: 11,
    endLine: 13,
    isEmpty: false,
    text: 'const a = 1\nconst b = 2\nconst c = 3',
    documentVersion: 7,
  })
  // params 键集合固定（协议字段一览）
  assert.deepEqual(
    Object.keys(message.params).sort(),
    ['documentVersion', 'endLine', 'isEmpty', 'path', 'startLine', 'text'],
  )
})

test('selectionLineRange keeps the last covered line for whole-line selections', () => {
  // 整行选区最典型的三种手势(Shift+Down / 三击选整行 / 拖到左边距)都把 end
  // 停在下一行行首:末覆盖行是 end.line - 1,推原始 end.line 会让 TUI 徽标
  // 比实际附加的正文多算一行。
  assert.deepEqual(
    selectionLineRange({ start: { line: 5, character: 0 }, end: { line: 8, character: 0 } }),
    { startLine: 5, endLine: 7 },
  )
  // 三击选单行:整行 5,收在 (6,0)
  assert.deepEqual(
    selectionLineRange({ start: { line: 5, character: 0 }, end: { line: 6, character: 0 } }),
    { startLine: 5, endLine: 5 },
  )
  // 反向拖选(从 (7,0) 往上到 (5,0)):start/end 已是 VS Code 归一化后的顺序,
  // 覆盖 L5、L6,末覆盖行同样是 6
  assert.deepEqual(
    selectionLineRange({ start: { line: 5, character: 0 }, end: { line: 7, character: 0 } }),
    { startLine: 5, endLine: 6 },
  )
})

test('selectionLineRange keeps end.line when the selection ends mid-line', () => {
  assert.deepEqual(
    selectionLineRange({ start: { line: 5, character: 3 }, end: { line: 7, character: 10 } }),
    { startLine: 5, endLine: 7 },
  )
  assert.deepEqual(
    selectionLineRange({ start: { line: 5, character: 3 }, end: { line: 5, character: 10 } }),
    { startLine: 5, endLine: 5 },
  )
})

test('selectionLineRange leaves an empty selection (start === end) untouched', () => {
  assert.deepEqual(
    selectionLineRange({ start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }),
    { startLine: 4, endLine: 4 },
  )
  assert.deepEqual(
    selectionLineRange({ start: { line: 4, character: 7 }, end: { line: 4, character: 7 } }),
    { startLine: 4, endLine: 4 },
  )
})

test('normalized coordinates agree with the text the wire carries', () => {
  // 契约回归:同一手势下 mention 的行区间必须等于 getText() 的实际行数
  // (v2 推 text 时曾经多一行——footer 徽标 4 行 / transcript 3 行)。
  const range = selectionLineRange({ start: { line: 5, character: 0 }, end: { line: 8, character: 0 } })
  const text = 'L6\nL7\nL8\n' // getText() 对同一选区的返回:含末尾换行
  assert.equal(text.replace(/\n$/, '').split('\n').length, range.endLine - range.startLine + 1)
  assert.equal(buildAtMention('src/a.ts', { isEmpty: false, ...range }), '@src/a.ts#L6-8')
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

test('hello handshake: valid token+version gets hello_ack; wrong token or protocol version is dropped', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({
      token: 'tok-hs',
      lockRoot,
      workspaceFolders: () => ['D:/ws'],
    })
    const env = await server.start()
    const port = Number(env.DSH_TUI_IDE_PORT)

    // ── 错误 token：无 ACK，socket 被关闭，client 不注册 ──────────────────
    const WebSocket = (await import('ws')).WebSocket
    const wrong = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      wrong.on('open', resolve)
      wrong.on('error', reject)
    })
    const wrongFrames: Array<Record<string, unknown>> = []
    let wrongClosed = false
    wrong.on('message', raw => wrongFrames.push(JSON.parse(String(raw))))
    wrong.on('close', () => { wrongClosed = true })
    wrong.send(JSON.stringify({ method: 'ide/hello', params: { token: 'WRONG', protocolVersion: 2 } }))
    for (let waited = 0; !wrongClosed && waited < 1000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(wrongClosed, 'wrong token must be dropped')
    assert.deepEqual(wrongFrames, [], 'wrong token must get no ack frame')
    assert.equal(server.clientCount, 0)

    // ── 协议版本校验：不符 / 缺失一律拒绝（只校验 token 会把 v1 客户端
    //    也放进来，服务端应只服务它讲得了的协议；客户端把「无 ACK」当作
    //    未认证并转向下一候选）──────────────────────────────────────────
    for (const helloParams of [
      { token: 'tok-hs', protocolVersion: 1 },
      { token: 'tok-hs' },
    ]) {
      const stale = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise<void>((resolve, reject) => {
        stale.on('open', resolve)
        stale.on('error', reject)
      })
      const staleFrames: Array<Record<string, unknown>> = []
      let staleClosed = false
      stale.on('message', raw => staleFrames.push(JSON.parse(String(raw))))
      stale.on('close', () => { staleClosed = true })
      stale.send(JSON.stringify({ method: 'ide/hello', params: helloParams }))
      for (let waited = 0; !staleClosed && waited < 1000; waited += 10) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(staleClosed, `hello ${JSON.stringify(helloParams)} must be dropped`)
      assert.deepEqual(staleFrames, [], 'protocol mismatch must get no ack frame')
      assert.equal(server.clientCount, 0)
    }

    // ── 正确 token：第一帧是 hello_ack（版本 + workspaceFolders）──────────
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    const received: Array<Record<string, unknown>> = []
    socket.on('message', raw => {
      received.push(JSON.parse(String(raw)))
    })
    socket.send(JSON.stringify({ method: 'ide/hello', params: { token: 'tok-hs', protocolVersion: 2 } }))
    // 轮询等第一帧（hello_ack）到达，消除时序竞态（本文件既有惯例）
    for (let waited = 0; received.length === 0 && waited < 1000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(received[0].method, 'ide/hello_ack')
    assert.deepEqual(received[0].params, { protocolVersion: 2, workspaceFolders: ['D:/ws'] })
    // ACK 之后 client 才注册
    for (let waited = 0; server.clientCount === 0 && waited < 1000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(server.clientCount, 1)

    const pushed = server.broadcastSelection({
      path: 'src/b.ts',
      startLine: 0,
      endLine: 2,
      isEmpty: false,
      text: 'l1\nl2\nl3',
      documentVersion: 4,
    })
    assert.ok(pushed)

    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(received.length, 2)
    assert.equal(received[1].method, 'selection_changed')
    assert.deepEqual(received[1].params, {
      path: 'src/b.ts',
      startLine: 0,
      endLine: 2,
      isEmpty: false,
      text: 'l1\nl2\nl3',
      documentVersion: 4,
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
      server.broadcastSelection({ path: 'x.ts', startLine: 0, endLine: 0, isEmpty: true, text: '', documentVersion: 1 }),
      false,
    )
    await server.stop()
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('lock file is written owner-only on POSIX (0600 file under 0700 dir)', async () => {
  if (process.platform === 'win32') {
    // Windows 无 POSIX mode 位——权限断言只在 Unix 跑（先例：上游 TUI 的
    // verify-standalone-cache-guard 平台守卫）。
    return
  }
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({ token: 't-perm', lockRoot, workspaceFolders: () => [] })
    const env = await server.start()
    const port = Number(env.DSH_TUI_IDE_PORT)
    const lockPath = join(lockRoot, 'ide', `${port}.lock`)
    const { statSync } = await import('node:fs')
    assert.equal(statSync(lockPath).mode & 0o777, 0o600, 'lock file must be 0600')
    assert.equal(statSync(join(lockRoot, 'ide')).mode & 0o777, 0o700, 'lock dir must be 0700')
    await server.stop()
  } finally {
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('a pre-existing permissive lock dir is tightened to 0700 on start (POSIX)', async () => {
  if (process.platform === 'win32') {
    // Windows 无 POSIX mode 位（同上一测试的平台守卫）。
    return
  }
  const lockRoot = makeLockRoot()
  try {
    const { mkdirSync, chmodSync, statSync } = await import('node:fs')
    const dir = join(lockRoot, IDE_LOCK_DIR_NAME)
    // 模拟旧版本/宽松 umask 留下的目录：mkdirSync 的 mode 只在「创建」时
    // 生效，不会修正已存在的目录——server 必须显式收紧，否则「目录 0700」
    // 只是宣称（单测此前只覆盖新建目录，正是漏掉的场景）。
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)
    assert.equal(statSync(dir).mode & 0o777, 0o755, 'precondition: the dir starts permissive')
    const server = new IdeServer({ token: 't-perm-existing', lockRoot, workspaceFolders: () => [] })
    await server.start()
    assert.equal(statSync(dir).mode & 0o777, 0o700, 'start must tighten an existing dir to 0700')
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
