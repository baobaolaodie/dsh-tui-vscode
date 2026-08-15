import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocalPath } from '../paths.js'

test('absolute Windows paths pass through unchanged', () => {
  assert.equal(resolveLocalPath('C:\\src\\a.ts', { root: 'C:\\ws' }), 'C:\\src\\a.ts')
  assert.equal(resolveLocalPath('C:/src/a.ts'), 'C:/src/a.ts')
})

test('absolute POSIX paths pass through unchanged', () => {
  assert.equal(resolveLocalPath('/home/u/a.ts', { root: '/ws' }), '/home/u/a.ts')
})

test('~ and ~/ paths expand against the home directory', () => {
  const home = 'C:\\Users\\u'
  assert.equal(resolveLocalPath('~/src/x.ts', { home }), 'C:\\Users\\u\\src\\x.ts')
  assert.equal(resolveLocalPath('~', { home }), 'C:\\Users\\u')
})

test('relative paths resolve against the workspace root', () => {
  assert.equal(
    resolveLocalPath('./src/x.ts', { root: 'C:\\ws' }),
    'C:\\ws\\src\\x.ts',
  )
  assert.equal(resolveLocalPath('../lib/x.ts', { root: 'C:\\ws\\app' }), 'C:\\ws\\lib\\x.ts')
})

test('relative paths without a workspace root stay untouched', () => {
  assert.equal(resolveLocalPath('./src/x.ts', {}), './src/x.ts')
  assert.equal(resolveLocalPath('./src/x.ts'), './src/x.ts')
})