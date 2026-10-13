import test from 'node:test'
import assert from 'node:assert/strict'
import { getVsixFileName } from './vsix-artifact.mjs'

test('review build has a distinct artifact name from the standard release', () => {
  assert.equal(
    getVsixFileName({ name: 'dsh-tui-vscode', version: '0.7.6' }),
    'dsh-tui-vscode-0.7.6-edit-review.vsix',
  )
})

test('artifact name follows future manifest versions without changing the suffix', () => {
  assert.equal(
    getVsixFileName({ name: 'dsh-tui-vscode', version: '0.7.7' }),
    'dsh-tui-vscode-0.7.7-edit-review.vsix',
  )
})

test('artifact naming does not modify the extension identity', () => {
  const manifest = Object.freeze({ name: 'dsh-tui-vscode', version: '0.7.6', publisher: 'baobaolaodie' })
  getVsixFileName(manifest)
  assert.deepEqual(manifest, { name: 'dsh-tui-vscode', version: '0.7.6', publisher: 'baobaolaodie' })
})
