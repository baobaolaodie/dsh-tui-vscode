import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findSessionFiles, readSessionRecord, listSessions, ensureZstd } from '../sessions.js'

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

test('readSessionRecord tolerates missing/garbage events', () => {
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
    // Undecodable file → undefined
    writeFileSync(file, '\x00\x01\x02broken')
    assert.equal(readSessionRecord(file), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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