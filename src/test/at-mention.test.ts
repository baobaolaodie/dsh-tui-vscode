import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAtMention, normalizeMentionPath } from '../at-mention.js'

test('empty selection references the whole file', () => {
  assert.equal(
    buildAtMention('src/session.ts', { isEmpty: true, startLine: 0, endLine: 0 }),
    '@src/session.ts',
  )
})

test('single-line selection on the first line (0-based 0 → 1-based 1)', () => {
  assert.equal(
    buildAtMention('src/index.ts', { isEmpty: false, startLine: 0, endLine: 0 }),
    '@src/index.ts L1',
  )
})

test('single-line selection uses one line number (1-based)', () => {
  assert.equal(
    buildAtMention('src/session.ts', { isEmpty: false, startLine: 11, endLine: 11 }),
    '@src/session.ts L12',
  )
})

test('two-line selection uses compact range 1-2', () => {
  assert.equal(
    buildAtMention('src/index.ts', { isEmpty: false, startLine: 0, endLine: 1 }),
    '@src/index.ts L1-2',
  )
})

test('multi-line selection uses start-end range (1-based)', () => {
  assert.equal(
    buildAtMention('src/session.ts', { isEmpty: false, startLine: 11, endLine: 13 }),
    '@src/session.ts L12-14',
  )
})

test('windows-style backslash path is passed through as typed (extension normalizes first)', () => {
  assert.equal(
    buildAtMention('src\\session.ts', { isEmpty: false, startLine: 0, endLine: 2 }),
    '@src\\session.ts L1-3',
  )
})

test('path containing whitespace uses the double-quoted mention form …', () => {
  assert.equal(
    buildAtMention('src/my file.ts', { isEmpty: true, startLine: 0, endLine: 0 }),
    '@"src/my file.ts"',
  )
  assert.equal(
    buildAtMention('src/my file.ts', { isEmpty: false, startLine: 0, endLine: 1 }),
    '@"src/my file.ts" L1-2',
  )
})

test('normalizeMentionPath converts backslashes to forward slashes (Windows)', () => {
  assert.equal(
    normalizeMentionPath('C:\\Users\\me\\repo\\src\\a.ts'),
    'C:/Users/me/repo/src/a.ts',
  )
})

test('normalizeMentionPath keeps POSIX and already-forward paths unchanged', () => {
  assert.equal(normalizeMentionPath('/home/me/repo/src/a.ts'), '/home/me/repo/src/a.ts')
  assert.equal(normalizeMentionPath('D:/repo/src/a.ts'), 'D:/repo/src/a.ts')
})

test('absolute forward-slash mention survives the dsh-tui cwd-independent path', () => {
  const path = normalizeMentionPath('D:\\repo\\src\\a.ts')
  assert.equal(
    buildAtMention(path, { isEmpty: false, startLine: 11, endLine: 13 }),
    '@D:/repo/src/a.ts L12-14',
  )
})
