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
  selectionFingerprint,
  selectionLineRange,
} from '../ide/server.js'
import type { SelectionBroadcast } from '../ide/server.js'
import { buildAtMention } from '../at-mention.js'

/** mkdtemp 临时 lockRoot——绝不写真实 ~/.dsh-tui（测试隔离策略）。 */
function makeLockRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-ide-lock-'))
}

/** 轮询等待条件成立（沿用本文件既有的 10ms 轮询惯例，不猜固定延迟）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  for (let waited = 0; !predicate() && waited < timeoutMs; waited += 10) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 负向断言用的收敛窗：ack 之后服务端在同一轮事件循环里决定是否补推。 */
async function settle(ms = 100): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** 一个非空选区帧；replay 断言逐字段比对它。 */
function selection(overrides: Partial<SelectionBroadcast> = {}): SelectionBroadcast {
  return {
    path: 'src/replay.ts',
    startLine: 2,
    endLine: 4,
    isEmpty: false,
    text: 'const a = 1\nconst b = 2\nconst c = 3',
    documentVersion: 9,
    ...overrides,
  }
}

/** 连接一个已认证的 protocol-2 客户端，并收集它收到的全部帧（ack 最先）。 */
async function connectAuthenticated(
  server: IdeServer,
  token: string,
): Promise<{ socket: import('ws').WebSocket; frames: Array<Record<string, unknown>> }> {
  const port = server.port
  assert.ok(port !== undefined, 'server must be started before a client connects')
  const WebSocket = (await import('ws')).WebSocket
  const socket = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Array<Record<string, unknown>> = []
  socket.on('message', raw => {
    frames.push(JSON.parse(String(raw)))
  })
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve)
    socket.on('error', reject)
  })
  socket.send(JSON.stringify({ method: 'ide/hello', params: { token, protocolVersion: 2 } }))
  await waitUntil(() => frames.length > 0)
  return { socket, frames }
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
    // 断言可观测状态，而不是 join(ideDir, '1.lock')——ideDir 本身是个**文件**，
    // 那个路径在任何情况下都不存在，旧断言恒真、检测不到半启动的实例
    // （issue #21 第 8 条）。失败必须留下：没有运行中的 server、没有对外 env、
    // 没有已注册的客户端。
    assert.equal(server.running, false, 'failed start must not leave a running server')
    assert.equal(server.port, undefined, 'failed start must not advertise an env')
    assert.equal(server.clientCount, 0, 'failed start must not have registered clients')
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

test('a socket that never completes the handshake is terminated at the deadline', async () => {
  const lockRoot = makeLockRoot()
  try {
    const server = new IdeServer({
      token: 'tok-idle',
      lockRoot,
      workspaceFolders: () => [],
      // Short deadline keeps the test fast; production defaults to 10s.
      handshakeTimeoutMs: 60,
    })
    const env = await server.start()
    const port = Number(env.DSH_TUI_IDE_PORT)
    const WebSocket = (await import('ws')).WebSocket
    const idle = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      idle.on('open', resolve)
      idle.on('error', reject)
    })
    // Say nothing. Such a socket is never added to `sockets`, so stop() would
    // not terminate it and `wss.close()`'s callback would never fire — the
    // deadline is what keeps a silent local peer from hanging shutdown.
    let closed = false
    idle.on('close', () => { closed = true })
    for (let waited = 0; !closed && waited < 2000; waited += 10) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(closed, 'an unauthenticated socket must be terminated at the handshake deadline')
    assert.equal(server.clientCount, 0)
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

test('replays the most recent non-empty selection right after hello_ack (AC-7)', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-replay'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => ['D:/ws'] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const selectionFrame = selection()
    // 无客户端时广播返回 false（既有语义不变），但帧必须被记住，供稍后连上的
    // 客户端恢复徽标与可附加状态。
    assert.equal(server.broadcastSelection(selectionFrame), false, 'no clients means no delivery')
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    const frames = connected.frames
    await waitUntil(() => frames.length >= 2)
    assert.deepEqual(frames.map(frame => frame.method), ['ide/hello_ack', 'selection_changed'])
    assert.deepEqual(frames[1].params, selectionFrame)
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('does not replay a frame whose fingerprint is suppressed — a duplicate broadcast must not un-suppress it (AC-8)', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-suppress'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const typed = selection()
    assert.equal(server.broadcastSelection(typed), false)
    // 扩展确实把这一帧敲成了 @mention 回退 → 抑制该指纹。
    server.markReplaySuppressed(selectionFingerprint(typed))
    // shouldBroadcastSelection 对 duplicate 也返回 true：同一帧的重复广播不得
    // 抹掉抑制（这正是 ADR-009 弃用布尔标记的原因）。
    assert.equal(server.broadcastSelection(typed), false)
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    const frames = connected.frames
    await settle()
    assert.deepEqual(frames.map(frame => frame.method), ['ide/hello_ack'])
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('an empty selection clears the remembered frame, so a later client gets no replay', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-empty'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    assert.equal(server.broadcastSelection(selection()), false)
    assert.equal(
      server.broadcastSelection(selection({ startLine: 0, endLine: 0, isEmpty: true, text: '' })),
      false,
    )
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    const frames = connected.frames
    await settle()
    assert.deepEqual(frames.map(frame => frame.method), ['ide/hello_ack'])
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('a different frame is still replayed while another fingerprint is suppressed', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-different'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const suppressed = selection()
    const current = selection({ startLine: 6, endLine: 8, documentVersion: 10 })
    server.broadcastSelection(suppressed)
    server.markReplaySuppressed(selectionFingerprint(suppressed))
    server.broadcastSelection(current)
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    const frames = connected.frames
    await waitUntil(() => frames.length >= 2)
    assert.deepEqual(frames.map(frame => frame.method), ['ide/hello_ack', 'selection_changed'])
    assert.deepEqual(frames[1].params, current)
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('stop clears the remembered selection and the suppression fingerprint', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-stop-replay'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  const sockets: Array<{ close(): void }> = []
  try {
    await server.start()
    const frame = selection()
    server.broadcastSelection(frame)
    server.markReplaySuppressed(selectionFingerprint(frame))
    await server.stop()

    // ① 记忆被清：重启后的服务器在新客户端连上时不补推旧帧。
    await server.start()
    const afterMemoryReset = await connectAuthenticated(server, token)
    sockets.push(afterMemoryReset.socket)
    await settle()
    assert.deepEqual(afterMemoryReset.frames.map(frame => frame.method), ['ide/hello_ack'])
    afterMemoryReset.socket.close()
    await waitUntil(() => server.clientCount === 0)

    // ② 抑制指纹被清：重新广播同一帧后，新客户端应当收到补推（若 stop 没清
    //    指纹，这一帧会被永久抑制）。
    assert.equal(server.broadcastSelection(frame), false)
    const afterSuppressionReset = await connectAuthenticated(server, token)
    sockets.push(afterSuppressionReset.socket)
    await waitUntil(() => afterSuppressionReset.frames.length >= 2)
    assert.deepEqual(afterSuppressionReset.frames.map(frame => frame.method), [
      'ide/hello_ack',
      'selection_changed',
    ])
    assert.deepEqual(afterSuppressionReset.frames[1].params, frame)
    afterSuppressionReset.socket.close()
  } finally {
    for (const s of sockets) {
      try { s.close() } catch { /* already closed */ }
    }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('selectionFingerprint separates frames that differ only in the selected text', () => {
  // path / line range / document version identical: only the text differs. The
  // typed-fallback suppression must not swallow the newer frame.
  const a = selection()
  const b = selection({ text: 'const a = 1\nconst b = 2\nconst c = 4' })
  assert.equal(a.path, b.path)
  assert.equal(a.startLine, b.startLine)
  assert.equal(a.endLine, b.endLine)
  assert.equal(a.documentVersion, b.documentVersion)
  assert.notEqual(selectionFingerprint(a), selectionFingerprint(b))
  // Same frame twice is the duplicate case the suppression exists for.
  assert.equal(selectionFingerprint(a), selectionFingerprint({ ...a }))
})

test('a typed frame stays suppressed when the selection moves away and comes back', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-retype'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const typed = selection()
    server.broadcastSelection(typed)
    server.markReplaySuppressed(selectionFingerprint(typed))
    // Moving the selection elsewhere does not remove the @mention that was
    // already typed into the terminal input.
    server.broadcastSelection(selection({ startLine: 6, endLine: 8, text: 'elsewhere' }))
    // Back on the same lines: replaying now would attach the same lines twice.
    server.broadcastSelection(typed)
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    await settle()
    assert.deepEqual(connected.frames.map(frame => frame.method), ['ide/hello_ack'])
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('retractSelection forgets the frame for the closed path and clears connected clients', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-retract'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const frame = selection({ path: 'src/closed.ts' })
    assert.equal(server.broadcastSelection(frame), false, 'no clients means no delivery')
    // A connected client sees the retraction as an empty frame, so a badge for
    // the closed file does not survive the close.
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    await waitUntil(() => connected.frames.length >= 2)
    assert.deepEqual(connected.frames.map(f => f.method), ['ide/hello_ack', 'selection_changed'])
    assert.equal(server.retractSelection(frame.path), true, 'connected client receives the retraction')
    await waitUntil(() => connected.frames.length >= 3)
    const retracted = connected.frames[2].params as Record<string, unknown>
    assert.equal(retracted.isEmpty, true)
    assert.equal(retracted.path, 'src/closed.ts')
    // Nothing is remembered any more: a later client gets no replay.
    const later = await connectAuthenticated(server, token)
    socket = later.socket
    await settle()
    assert.deepEqual(later.frames.map(f => f.method), ['ide/hello_ack'])
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})

test('retractSelection leaves the remembered frame alone when another file closes', async () => {
  const lockRoot = makeLockRoot()
  const token = 'tok-retract-other'
  const server = new IdeServer({ token, lockRoot, workspaceFolders: () => [] })
  let socket: { close(): void } | undefined
  try {
    await server.start()
    const kept = selection({ path: 'src/open.ts' })
    assert.equal(server.broadcastSelection(kept), false)
    assert.equal(server.retractSelection('src/other.ts'), false, 'a different path must not retract')
    const connected = await connectAuthenticated(server, token)
    socket = connected.socket
    await waitUntil(() => connected.frames.length >= 2)
    assert.deepEqual(connected.frames.map(f => f.method), ['ide/hello_ack', 'selection_changed'])
    assert.deepEqual(connected.frames[1].params, kept)
  } finally {
    try { socket?.close() } catch { /* already closed */ }
    await server.stop()
    rmSync(lockRoot, { recursive: true, force: true })
  }
})
