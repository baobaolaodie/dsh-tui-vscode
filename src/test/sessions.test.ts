import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import * as zstd from '@bokuweb/zstd-wasm'
import {
  findSessionFiles,
  readSessionRecord,
  readSessionSummary,
  listSessions,
  ensureZstd,
  decodeSessionLog,
  decodeGroupDir,
  projectNameOf,
  sessionCwdMatches,
  sessionLabel,
  pathBase,
  appendSessionTitle,
  deleteSessionLog,
  readStorageTitles,
  readStorageMeta,
} from '../sessions.js'

before(async () => {
  await ensureZstd()
})

function makeSession(
  root: string,
  id: string,
  lines: string[],
  compressed = false,
): string {
  const dir = join(root, 'sessions', '--group--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, compressed ? 'session.jsonl.zstd' : 'session.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** Write a multi-frame zstd log: each `chunk` becomes its own frame. */
function makeMultiFrameSession(root: string, id: string, chunks: string[][]): string {
  const dir = join(root, 'sessions', '--group--', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  const frames = chunks.map(chunk =>
    Buffer.from(zstd.compress(Buffer.from(chunk.join('\n') + '\n', 'utf8'), 3)),
  )
  writeFileSync(file, Buffer.concat(frames))
  return file
}

test('decodeSessionLog decodes concatenated zstd frames (the persistence format)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-multiframe-'))
  try {
    const id = 'multi-1'
    // A whole-buffer decompress fails on this (code -70); frame-by-frame
    // must recover every chunk. The TUI appends one frame per durable flush.
    const file = makeMultiFrameSession(root, id, [
      [JSON.stringify({ type: 'session', version: 0, id, cwd: 'C:\\ws', createdAt: 1000 })],
      [JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '第一条' }] } })],
      [JSON.stringify({ type: 'session/title', seq: 1, data: { title: '多帧标题' } })],
    ])
    const text = decodeSessionLog(file).toString('utf8')
    assert.match(text, /多帧标题/)
    assert.match(text, /第一条/)
    assert.match(text, /C:\\\\ws|C:\\ws/)
    const rec = readSessionRecord(file)
    assert.equal(rec?.title, '多帧标题')
    assert.equal(rec?.cwd, 'C:\\ws')
    assert.equal(rec?.hasPrompt, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decodeSessionLog tolerates a corrupt mid-file frame and resyncs the tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tornframe-'))
  try {
    const id = 'torn-1'
    const dir = join(root, 'sessions', '--group--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    const frame0 = Buffer.from(
      zstd.compress(Buffer.from(JSON.stringify({ type: 'session', version: 0, id, cwd: '/ws', createdAt: 1 }) + '\n', 'utf8'), 3),
    )
    const frameTail = Buffer.from(
      zstd.compress(Buffer.from(JSON.stringify({ type: 'session/title', seq: 5, data: { title: '尾部标题' } }) + '\n', 'utf8'), 3),
    )
    const garbage = Buffer.from('NOT-A-ZSTD-FRAME-AT-ALL', 'utf8')
    writeFileSync(file, Buffer.concat([frame0, garbage, frameTail]))
    const text = decodeSessionLog(file).toString('utf8')
    assert.match(text, /"type":"session"/)
    assert.match(text, /尾部标题/)
    const rec = readSessionRecord(file)
    assert.equal(rec?.title, '尾部标题')
    assert.equal(rec?.cwd, '/ws')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionRecord parses origin and only counts human prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-human-'))
  try {
    const id = 'human-1'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, origin: 'subagent', parentSession: 'par-1', cwd: '/ws', createdAt: 1 }),
      // Not human-typed: must NOT produce a title fallback nor hasPrompt.
      JSON.stringify({ type: 'user/message', seq: 0, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '注入的指令' }] } }),
      JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真人消息' }] } }),
    ])
    const rec = readSessionRecord(file)
    assert.equal(rec?.origin, 'subagent')
    assert.equal(rec?.parent, 'par-1')
    assert.equal(rec?.title, '真人消息') // only the human message stands in
    assert.equal(rec?.hasPrompt, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionRecord hasPrompt: boot-only log is false, unknown log stays true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prompt-'))
  try {
    const id = 'prompt-1'
    const bootOnly = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: '/ws', createdAt: 1 }),
      JSON.stringify({ type: 'permission/preset', seq: 0, data: { preset: 'ask' } }),
      JSON.stringify({ type: 'activity/status', seq: 1, data: { phase: 'idle' } }),
    ])
    assert.equal(readSessionRecord(bootOnly)?.hasPrompt, false)
    // An inbox splice carrying the human prompt counts too.
    const spliced = makeSession(root, 'prompt-2', [
      JSON.stringify({ type: 'session', version: 0, id: 'prompt-2', cwd: '/ws', createdAt: 1 }),
      JSON.stringify({ type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-turn', inserted: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'splice 里的消息' }] }] } }),
    ])
    const rec = readSessionRecord(spliced)
    assert.equal(rec?.hasPrompt, true)
    assert.equal(rec?.title, 'splice 里的消息')
    // A readable-but-garbage plain log read to the end with no prompt → false
    // (same as the TUI: the whole log was seen and held nothing).
    writeFileSync(bootOnly, 'not json at all\n')
    assert.equal(readSessionRecord(bootOnly)?.hasPrompt, false)
    // An UNDECOMPRESSABLE zstd log is unknowable → stays true (never hide
    // what we cannot read — a real conversation must not vanish).
    writeFileSync(bootOnly, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, ...Buffer.from('GARBAGE-FRAME')]))
    assert.equal(readSessionRecord(bootOnly)?.hasPrompt, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decodeSessionLog decodes gzip and single-frame zstd logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-enc-'))
  try {
    const gzDir = join(root, 'sessions', '--group--', 'gz-1')
    mkdirSync(gzDir, { recursive: true })
    const gzFile = join(gzDir, 'session.jsonl.gz')
    const gzBody = JSON.stringify({ type: 'session', version: 0, id: 'gz-1', cwd: '/gz', createdAt: 1 }) + '\n'
    writeFileSync(gzFile, gzipSync(Buffer.from(gzBody, 'utf8')))
    assert.match(decodeSessionLog(gzFile).toString('utf8'), /"cwd":"\/gz"/)

    // A REAL single-frame zstd log (makeMultiFrameSession compresses).
    const one = makeMultiFrameSession(root, 'one-1', [
      [
        JSON.stringify({ type: 'session', version: 0, id: 'one-1', cwd: '/one', createdAt: 1 }),
        JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '单帧消息' }] } }),
      ],
    ])
    const rec = readSessionRecord(one)
    assert.equal(rec?.title, '单帧消息')
    assert.equal(rec?.cwd, '/one')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decodeSessionLog: every frame failing to decode throws (unknown, never empty)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-alldead-'))
  try {
    const id = 'alldead-1'
    const dir = join(root, 'sessions', '--group--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    // A structurally complete frame (frameEnd walks it fine) whose payload
    // bytes are corrupted → decompress fails for the ONLY frame.
    const good = Buffer.from(
      zstd.compress(Buffer.from(JSON.stringify({ type: 'session', id, cwd: '/w' }) + '\n', 'utf8'), 3),
    )
    const bad = Buffer.from(good)
    bad[8] = bad[8]! ^ 0xff // flip a payload byte (frame header untouched)
    writeFileSync(file, bad)
    assert.throws(() => decodeSessionLog(file))
    // The tolerant record keeps hasPrompt=true: a log we cannot read must
    // never be classified as a boot-only artifact.
    assert.equal(readSessionRecord(file)?.hasPrompt, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionSummary: windowed read matches the full read on small logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win-'))
  try {
    const id = 'win-1'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, origin: 'subagent', parentSession: 'p-1', cwd: 'C:\\ws', createdAt: 1000 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '窗口消息' }] } }),
      JSON.stringify({ type: 'session/title', seq: 1, data: { title: '窗口标题' } }),
    ])
    const full = readSessionRecord(file)
    const windowed = readSessionSummary(file)
    assert.deepEqual(windowed, full)
    // Plain (non-zstd) legacy logs fall back to the full-read path.
    const plain = makeSession(root, 'win-2', [
      JSON.stringify({ type: 'session', version: 0, id: 'win-2', cwd: '/w', createdAt: 1 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '明文消息' }] } }),
    ])
    assert.equal(readSessionSummary(plain)?.title, '明文消息')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionSummary: big log — header from head, current title from tail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-big-'))
  try {
    const id = 'big-1'
    const dir = join(root, 'sessions', '--group--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    // Frame 0: session header. Frames 1..N: a >64 KB body of unrelated
    // events (assistant chunks), so the head window cannot cover the log.
    // Final frame: the CURRENT title — lives in the tail window only.
    const headerFrame = Buffer.from(zstd.compress(
      Buffer.from(JSON.stringify({ type: 'session', version: 0, id, cwd: '/big', createdAt: 42 }) + '\n', 'utf8'), 3))
    // High-entropy payloads (base64 of random bytes barely compresses) so
    // the fixture reliably exceeds the 64 KB head window.
    const rand = (): string => randomBytes(192).toString('base64')
    const body: string[] = []
    for (let i = 0; i < 600; i++) {
      body.push(JSON.stringify({ type: 'assistant/chunk', seq: i, data: { chunk: { type: 'text-delta', text: rand() } } }))
    }
    const bodyFrame = Buffer.from(zstd.compress(Buffer.from(body.join('\n') + '\n', 'utf8'), 3))
    const titleFrame = Buffer.from(zstd.compress(
      Buffer.from(JSON.stringify({ type: 'session/title', seq: 999, data: { title: '尾部当前标题' } }) + '\n', 'utf8'), 3))
    writeFileSync(file, Buffer.concat([headerFrame, bodyFrame, titleFrame]))
    assert.ok(statSync(file).size > 64 * 1024, 'fixture must exceed the head window')

    const summary = readSessionSummary(file)
    assert.equal(summary?.id, id)
    assert.equal(summary?.cwd, '/big')
    assert.equal(summary?.createdAt, 42)
    assert.equal(summary?.title, '尾部当前标题') // tail wins
    assert.equal(summary?.eventTitle, '尾部当前标题')
    assert.equal(summary?.hasPrompt, true) // log larger than the window
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionSummary: corrupt mid-window frame does not hide later frames', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-winbad-'))
  try {
    const id = 'winbad-1'
    const dir = join(root, 'sessions', '--group--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    const frame0 = Buffer.from(
      zstd.compress(Buffer.from(JSON.stringify({ type: 'session', version: 0, id, cwd: '/wb', createdAt: 7 }) + '\n', 'utf8'), 3),
    )
    // Structurally invalid bytes between frames: the forward walk stops on
    // them, and the windowed read must resume at the next magic — the frames
    // after a corrupt one hold real events (prompt, title).
    const garbage = Buffer.from('GARBAGE-NOT-A-FRAME-AT-ALL-0123456789', 'utf8')
    const frame2 = Buffer.from(
      zstd.compress(
        Buffer.from(
          JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '坏帧后的消息' }] } }) + '\n' +
          JSON.stringify({ type: 'session/title', seq: 1, data: { title: '坏帧后的标题' } }) + '\n',
          'utf8',
        ),
        3,
      ),
    )
    writeFileSync(file, Buffer.concat([frame0, garbage, frame2]))
    assert.ok(statSync(file).size < 64 * 1024, 'fixture must fit the head window')
    const summary = readSessionSummary(file)
    assert.equal(summary?.title, '坏帧后的标题')
    assert.equal(summary?.hasPrompt, true)
    assert.equal(summary?.cwd, '/wb')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessions uses windowed reads; filtered-out sessions still listed right', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-winfilter-'))
  try {
    const id = 'wf-1'
    const dir = join(root, 'sessions', '--group--', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl.zstd')
    const headerFrame = Buffer.from(zstd.compress(
      Buffer.from(JSON.stringify({ type: 'session', version: 0, id, cwd: 'D:\\ws', createdAt: 10 }) + '\n', 'utf8'), 3))
    const rand = (): string => randomBytes(192).toString('base64')
    const body: string[] = []
    for (let i = 0; i < 600; i++) {
      body.push(JSON.stringify({ type: 'assistant/chunk', seq: i, data: { chunk: { type: 'text-delta', text: rand() } } }))
    }
    const bodyFrame = Buffer.from(zstd.compress(Buffer.from(body.join('\n') + '\n', 'utf8'), 3))
    const titleFrame = Buffer.from(zstd.compress(
      Buffer.from(JSON.stringify({ type: 'session/title', seq: 999, data: { title: '大日志标题' } }) + '\n', 'utf8'), 3))
    writeFileSync(file, Buffer.concat([headerFrame, bodyFrame, titleFrame]))

    // In-workspace → tail read happens, title resolves.
    const inWs = await listSessions(root, { workspaceDirs: ['D:/ws'] })
    assert.equal(inWs.find(s => s.id === id)?.title, '大日志标题')
    // Out-of-workspace → head-only record is enough to exclude it.
    const outWs = await listSessions(root, { workspaceDirs: ['D:/elsewhere'] })
    assert.ok(!outWs.some(s => s.id === id))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sessionLabel: title → cwd basename → placeholder (separator-agnostic)', () => {
  const rec = (over: Partial<Parameters<typeof sessionLabel>[0]>): Parameters<typeof sessionLabel>[0] => ({
    id: 'x', hasPrompt: true, file: '/f', ...over,
  })
  assert.equal(sessionLabel(rec({ title: ' 标题 ' })), '标题')
  assert.equal(sessionLabel(rec({ title: '   ' })), '未命名会话')
  assert.equal(sessionLabel(rec({})), '未命名会话')
  // Windows-style cwd resolves even on POSIX hosts.
  assert.equal(sessionLabel(rec({ cwd: 'D:\\LongYinHaHa\\VSCode\\deepsharness\\dsh-tui-vscode' })), 'dsh-tui-vscode')
  assert.equal(sessionLabel(rec({ cwd: 'D:\\a\\b\\' })), 'b')
  assert.equal(pathBase(''), undefined)
  assert.equal(pathBase('/'), undefined)
})

test('sessionCwdMatches: exact, descendant, container boundaries, case folding', () => {
  // Exact and normalization (backslashes, trailing slash, case on win32).
  assert.equal(sessionCwdMatches('D:\\ws', 'd:/ws', true), true)
  assert.equal(sessionCwdMatches('D:/ws', 'D:/ws', false), true)
  assert.equal(sessionCwdMatches('D:/ws', 'D:/ws/', false), true)
  // Pre-upgrade subdirectory sessions belong to the workspace root.
  assert.equal(sessionCwdMatches('D:/ws', 'D:/ws/sub', false), true)
  assert.equal(sessionCwdMatches('D:/ws', 'D:/ws/sub/deeper', false), true)
  // A PARENT directory is a different workspace: opening the subdirectory
  // must not pull in the parent's sessions (the TUI's reverse rule is for
  // its live-session anchor, not for a workspace-folder anchor).
  assert.equal(sessionCwdMatches('D:/ws/sub', 'D:/ws', false), false)
  // Siblings and unrelated trees never match.
  assert.equal(sessionCwdMatches('D:/ws', 'D:/other', false), false)
  assert.equal(sessionCwdMatches('D:/ws', 'D:/ws2', false), false)
  // Container boundaries: HOME and drive roots are nobody's workspace —
  // only an exact match passes, so ~ never matches every session on disk.
  const home = homedir()
  assert.equal(sessionCwdMatches(home, join(home, 'some-project'), false), false)
  assert.equal(sessionCwdMatches(home, home, false), true)
  assert.equal(sessionCwdMatches('C:', 'C:/ws', false), false)
  assert.equal(sessionCwdMatches('C:', 'C:', false), true)
  assert.equal(sessionCwdMatches('//server/share', '//server/share/x', false), false)
  assert.equal(sessionCwdMatches('//server/share', '//server/share', false), true)
  assert.equal(sessionCwdMatches('//?/C:', '//?/C:/x', false), false)
  // Empty recorded cwd never matches.
  assert.equal(sessionCwdMatches('D:/ws', '', false), false)
})

test('listSessions filters by workspace, hides empty sessions and subagent runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-filter-'))
  try {
    // In-workspace conversation with a title.
    makeSession(root, 'in-1', [
      JSON.stringify({ type: 'session', id: 'in-1', cwd: 'D:\\ws', createdAt: 300 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '属于工作区' }] } }),
    ])
    // In-workspace SUBDIRECTORY session (pre-upgrade launches) — stays listed.
    makeSession(root, 'in-sub', [
      JSON.stringify({ type: 'session', id: 'in-sub', cwd: 'D:\\ws\\sub', createdAt: 200 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '子目录会话' }] } }),
    ])
    // Other workspace — filtered out.
    makeSession(root, 'other', [
      JSON.stringify({ type: 'session', id: 'other', cwd: 'D:\\elsewhere', createdAt: 400 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '别的项目' }] } }),
    ])
    // In-workspace boot-only session — hidden by hideEmpty.
    makeSession(root, 'empty', [
      JSON.stringify({ type: 'session', id: 'empty', cwd: 'D:\\ws', createdAt: 100 }),
      JSON.stringify({ type: 'permission/preset', seq: 0, data: { preset: 'ask' } }),
    ])
    // In-workspace sub-agent run — hidden by hideSubagents.
    makeSession(root, 'sub', [
      JSON.stringify({ type: 'session', id: 'sub', origin: 'subagent', cwd: 'D:\\ws', createdAt: 50 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '派遣消息' }] } }),
    ])
    const list = await listSessions(root, {
      workspaceDirs: ['D:/ws'],
      hideEmpty: true,
      hideSubagents: true,
    })
    const ids = list.map(s => s.id)
    assert.deepEqual(ids, ['in-1', 'in-sub']) // MRU/created desc
    // Without options the full tree comes back (backward compatible).
    assert.equal((await listSessions(root)).length, 5)
    // hideEmpty alone keeps subagent runs (they have prompts).
    const noEmpty = await listSessions(root, { hideEmpty: true })
    assert.ok(noEmpty.some(s => s.id === 'sub'))
    assert.ok(!noEmpty.some(s => s.id === 'empty'))
    // hideSubagents alone keeps boot-only sessions.
    const noSub = await listSessions(root, { hideSubagents: true })
    assert.ok(noSub.some(s => s.id === 'empty'))
    assert.ok(!noSub.some(s => s.id === 'sub'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readStorageMeta: ledger cwd and blank flag back up undecodable/empty logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stor2-'))
  try {
    const storages = join(root, 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'session_projcache.json'),
      JSON.stringify({
        unit: { name: 'session_projcache', version: 3 },
        tables: {
          sessions: {
            'sess-a': {
              identity: { createdAt: 1, cwd: 'D:\\ledger\\cwd' },
              rows: { sessionListMetadata: { ver: 1, seq: 1, val: { blank: true } } },
            },
            'sess-b': {
              identity: { createdAt: 1, cwd: 'D:\\ledger\\cwd' },
              rows: { sessionListMetadata: { ver: 1, seq: 1, val: { blank: false } } },
            },
          },
        },
      }),
    )
    const meta = readStorageMeta(root)
    assert.equal(meta.cwds['sess-a'], 'D:\\ledger\\cwd')
    assert.equal(meta.blanks['sess-a'], true)
    assert.equal(meta.blanks['sess-b'], undefined)
    assert.equal(meta.titles['sess-a'], undefined)

    // A log with no cwd header picks up the ledger identity.cwd; the blank
    // flag marks it empty so hideEmpty drops it.
    const logA = join(root, 'sessions', '--group--', 'sess-a')
    mkdirSync(logA, { recursive: true })
    writeFileSync(join(logA, 'session.jsonl'), JSON.stringify({ type: 'session', id: 'sess-a', createdAt: 1 }) + '\n')
    const listed = await listSessions(root, { workspaceDirs: ['D:/ledger/cwd'], hideEmpty: true })
    assert.deepEqual(listed.map(s => s.id), [])
    const unfiltered = await listSessions(root)
    const recA = unfiltered.find(s => s.id === 'sess-a')
    assert.equal(recA?.cwd, 'D:\\ledger\\cwd')
    assert.equal(recA?.hasPrompt, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionRecord parses header, last title wins, user message fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sess-'))
  try {
    const id = 'abc-123'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: 'C:\\ws', createdAt: 1000 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我看看这个' }] } }),
      JSON.stringify({ type: 'session/title', seq: 1, data: { title: '自动标题' } }),
      JSON.stringify({ type: 'session/title', seq: 2, data: { title: '/rename 后的标题' } }),
    ])
    const rec = readSessionRecord(file)
    assert.equal(rec?.id, id)
    assert.equal(rec?.cwd, 'C:\\ws')
    assert.equal(rec?.createdAt, 1000)
    // LAST session/title wins
    assert.equal(rec?.title, '/rename 后的标题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionRecord falls back to first user message text', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sess-'))
  try {
    const id = 'def-456'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: '/ws' }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '排查构建问题' }] } }),
      JSON.stringify({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '第二条' }] } }),
    ])
    assert.equal(readSessionRecord(file)?.title, '排查构建问题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSessionRecord tolerates missing/garbage events; undecodable logs still list', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sess-'))
  try {
    const id = 'ghi-789'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: '/x' }),
      'not json at all',
      JSON.stringify({ type: 'third-party/event', seq: 1, data: { whatever: 1 } }),
    ])
    const rec = readSessionRecord(file)
    assert.equal(rec?.id, id)
    assert.equal(rec?.title, undefined)
    assert.equal(rec?.project, 'x') // project derived from cwd '/x'
    // Undecodable content → tolerant fallback: id from the session dir,
    // project from the group dir, createdAt from the file mtime.
    writeFileSync(file, '\x00\x01\x02broken')
    const tolerant = readSessionRecord(file, '--D-user-VSCode-deepsharness--')
    assert.equal(tolerant?.id, 'ghi-789')
    assert.equal(tolerant?.project, 'deepsharness')
    assert.ok(typeof tolerant?.createdAt === 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decodeGroupDir and projectNameOf derive project short names', () => {
  // Hyphen-free paths decode exactly (separator follows the host OS).
  assert.equal(decodeGroupDir('--C-Users-user--'), join('C:', 'Users', 'user'))
  assert.equal(decodeGroupDir('--D-user-VSCode-deepsharness--'), join('D:', 'user', 'VSCode', 'deepsharness'))
  // The cwd-encoding is lossy for hyphenated names — documented limitation.
  assert.equal(decodeGroupDir('--D-user-VSCode-flow-comet--'), join('D:', 'user', 'VSCode', 'flow', 'comet'))
  assert.equal(decodeGroupDir('not-encoded'), undefined)
  // cwd wins over the group dir.
  assert.equal(projectNameOf('d:\\repo\\my-app', '--D-x--'), 'my-app')
  // group-dir fallback when cwd is missing.
  assert.equal(projectNameOf(undefined, '--D-user-VSCode-deepsharness--'), 'deepsharness')
  assert.equal(projectNameOf(undefined, '--C-Users-user--'), 'user')
  assert.equal(projectNameOf(undefined, undefined), undefined)
})

test('findSessionFiles and listSessions walk the DSH tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-'))
  try {
    makeSession(root, 'a-1', [JSON.stringify({ type: 'session', id: 'a-1', createdAt: 100 })])
    makeSession(root, 'b-2', [JSON.stringify({ type: 'session', id: 'b-2', createdAt: 200 })])
    const files = findSessionFiles(root)
    assert.equal(files.length, 2)
    const list = await listSessions(root)
    assert.equal(list.length, 2)
    // most recently created first
    assert.equal(list[0].id, 'b-2')
    assert.equal(list[1].id, 'a-1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findSessionFiles ignores empty dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
  try {
    mkdirSync(join(root, 'sessions', '--g--', 'no-log'), { recursive: true })
    assert.deepEqual(findSessionFiles(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readStorageTitles reads the dsh-storage ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stor-'))
  try {
    const storages = join(root, 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'session_projcache.json'),
      JSON.stringify({
        unit: { name: 'session_projcache', version: 3 },
        tables: {
          sessions: {
            'sess-a': { rows: { title: { ver: 1, seq: 1, val: 'Web 显示的标题' } } },
            'sess-b': { rows: { title: { ver: 1, seq: 1, val: null } } },
            'sess-c': { rows: {} },
          },
        },
      }),
    )
    const titles = readStorageTitles(root)
    assert.equal(titles['sess-a'], 'Web 显示的标题')
    assert.equal(titles['sess-b'], undefined)
    assert.equal(titles['sess-c'], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessions title precedence: event > storage > first user message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prec-'))
  try {
    // sess-e: has a session/title event — event wins over storage.
    makeSession(root, 'sess-e', [
      JSON.stringify({ type: 'session', id: 'sess-e', cwd: '/w', createdAt: 300 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '原始消息' }] } }),
      JSON.stringify({ type: 'session/title', seq: 1, data: { title: '事件标题' } }),
    ])
    // sess-s: no event title, but a storage title — storage wins over the
    // first user message (matching the web list).
    makeSession(root, 'sess-s', [
      JSON.stringify({ type: 'session', id: 'sess-s', cwd: '/w', createdAt: 200 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '原始消息' }] } }),
    ])
    // sess-u: nothing — falls back to the user message.
    makeSession(root, 'sess-u', [
      JSON.stringify({ type: 'session', id: 'sess-u', cwd: '/w', createdAt: 100 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '唯一消息' }] } }),
    ])
    const storages = join(root, 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(
      join(storages, 'session_projcache.json'),
      JSON.stringify({
        tables: {
          sessions: {
            'sess-e': { rows: { title: { val: 'Storage 标题' } } },
            'sess-s': { rows: { title: { val: 'Storage 标题' } } },
          },
        },
      }),
    )
    const list = await listSessions(root)
    const byId = Object.fromEntries(list.map(s => [s.id, s]))
    assert.equal(byId['sess-e'].title, '事件标题')
    assert.equal(byId['sess-s'].title, 'Storage 标题')
    assert.equal(byId['sess-u'].title, '唯一消息')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('empty-string dshHome falls back to $DSH_HOME (config default is "")', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-emptyhome-'))
  try {
    makeSession(root, 'e-1', [
      JSON.stringify({ type: 'session', version: 0, id: 'e-1', cwd: '/w', createdAt: 1 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '回退会话' }] } }),
    ])
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      // The extension passes the configured dshHome ('' when unset) — it
      // must resolve like an absent override, never as the relative path
      // 'sessions' (which does not exist and would hide every session).
      const list = await listSessions('')
      assert.ok(list.some(s => s.id === 'e-1'), 'empty-string dshHome must fall back to $DSH_HOME')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendSessionTitle appends a zstd frame; last title wins on read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rename-'))
  try {
    const id = 'ren-1'
    const file = makeMultiFrameSession(root, id, [
      [JSON.stringify({ type: 'session', version: 0, id, cwd: '/w', createdAt: 1 })],
      [JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '原始消息' }] } })],
      [JSON.stringify({ type: 'session/title', seq: 1, data: { title: '自动标题' } })],
    ])
    assert.equal(appendSessionTitle(file, '右键重命名'), 'appended')
    const rec = readSessionRecord(file)
    assert.equal(rec?.title, '右键重命名')
    assert.equal(rec?.eventTitle, '右键重命名')
    // The appended frame decodes as part of the multi-frame chain.
    assert.match(decodeSessionLog(file).toString('utf8'), /右键重命名/)
    // Renaming again continues the seq (maxSeq + 1) and still wins.
    assert.equal(appendSessionTitle(file, '再次重命名'), 'appended')
    assert.equal(readSessionRecord(file)?.title, '再次重命名')
    // Absent log → unavailable.
    assert.equal(appendSessionTitle(join(root, 'nope.jsonl.zstd'), 'x'), 'unavailable')
    // A NON-zstd log cannot take a new frame — refused, not corrupted.
    const plain = makeSession(root, 'ren-2', [
      JSON.stringify({ type: 'session', version: 0, id: 'ren-2', cwd: '/w', createdAt: 1 }),
      JSON.stringify({ type: 'session/title', seq: 1, data: { title: '明文标题' } }),
    ])
    assert.equal(appendSessionTitle(plain, 'x'), 'unavailable')
    assert.equal(readSessionRecord(plain)?.title, '明文标题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleteSessionLog removes the session dir and refuses out-of-root paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-del-'))
  try {
    const id = 'del-1'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: '/w', createdAt: 1 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '待删会话' }] } }),
    ])
    assert.equal(findSessionFiles(root).length, 1)
    assert.equal(deleteSessionLog(file, root), 'deleted')
    assert.equal(findSessionFiles(root).length, 0)
    // Deleting again → unavailable (the dir is gone).
    assert.equal(deleteSessionLog(file, root), 'unavailable')
    // A path OUTSIDE the sessions root is refused — the containment check
    // must hold even without any symlink in play.
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'not a session')
    assert.equal(deleteSessionLog(outside, root), 'unavailable')
    assert.ok(statSync(outside).isFile())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleteSessionLog containment is case-insensitive on Windows (vscode.Uri fsPath lowercases the drive)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delcase-'))
  try {
    const id = 'delc-1'
    const file = makeSession(root, id, [
      JSON.stringify({ type: 'session', version: 0, id, cwd: '/w', createdAt: 1 }),
      JSON.stringify({ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '大小写会话' }] } }),
    ])
    // vscode.Uri.file(...).fsPath on Windows normalizes the drive letter to
    // lower case while $DSH_HOME keeps its original case — the containment
    // test must treat them as the same path (and stay case-SENSITIVE on
    // POSIX, where filesystems are case-sensitive).
    const caseSwapped = file.replace(/^([A-Za-z]):/, m => (m === m.toUpperCase() ? m.toLowerCase() : m.toUpperCase()))
    const expected = process.platform === 'win32' ? 'deleted' : 'unavailable'
    assert.equal(deleteSessionLog(caseSwapped, root), expected)
    if (expected === 'deleted') {
      assert.ok(!existsSync(join(root, 'sessions', '--group--', id)))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})