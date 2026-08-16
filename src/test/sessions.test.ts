import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  findSessionFiles,
  readSessionRecord,
  listSessions,
  ensureZstd,
  decodeGroupDir,
  projectNameOf,
  readStorageTitles,
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
  // Hyphen-free paths decode exactly.
  assert.equal(decodeGroupDir('--C-Users-user--'), 'C:\\Users\\user')
  assert.equal(decodeGroupDir('--D-user-VSCode-deepsharness--'), 'D:\\user\\VSCode\\deepsharness')
  // The cwd-encoding is lossy for hyphenated names — documented limitation.
  assert.equal(decodeGroupDir('--D-user-VSCode-flow-comet--'), 'D:\\user\\VSCode\\flow\\comet')
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