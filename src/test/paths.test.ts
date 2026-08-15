import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { resolveLocalPath } from '../paths.js'

// Platform-agnostic on purpose: `resolveLocalPath` uses the NATIVE path
// semantics (node:path join/resolve), so every assertion below computes its
// expectation with the same native helpers instead of hard-coding
// Windows-style separators (which would break the suite on POSIX CI).

test('absolute Windows paths pass through unchanged', () => {
  assert.equal(resolveLocalPath('C:\\src\\a.ts', { root: join('ws') }), 'C:\\src\\a.ts')
  assert.equal(resolveLocalPath('C:/src/a.ts'), 'C:/src/a.ts')
})

test('absolute POSIX paths pass through unchanged', () => {
  assert.equal(resolveLocalPath('/home/u/a.ts', { root: join('ws') }), '/home/u/a.ts')
})

test('~ and ~/ paths expand against the home directory', () => {
  const home = join('home', 'u')
  assert.equal(resolveLocalPath('~/src/x.ts', { home }), join(home, 'src', 'x.ts'))
  assert.equal(resolveLocalPath('~', { home }), home)
})

test('relative paths resolve against the workspace root', () => {
  const root = join('ws')
  assert.equal(resolveLocalPath('./src/x.ts', { root }), resolve(root, 'src', 'x.ts'))
  assert.equal(
    resolveLocalPath('../lib/x.ts', { root: join('ws', 'app') }),
    resolve(join('ws', 'app'), '..', 'lib', 'x.ts'),
  )
})

test('relative paths without a workspace root stay untouched', () => {
  assert.equal(resolveLocalPath('./src/x.ts', {}), './src/x.ts')
  assert.equal(resolveLocalPath('./src/x.ts'), './src/x.ts')
})