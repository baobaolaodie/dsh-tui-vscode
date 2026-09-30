import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime } from '../relative-time.js'

// ADR-004 boundary: the pure module returns compact, l10n-ready duration
// units. The sub-minute bucket is the English key "just now" (the view layer
// wraps it with vscode.l10n.t); m/h/d stay language-neutral like before.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('relativeTime: sub-minute (and clock skew) is the "just now" bucket', () => {
  assert.equal(relativeTime(0, 0), 'just now')
  assert.equal(relativeTime(0, MINUTE - 1), 'just now')
  // Future timestamps keep the legacy guard: negative diff falls into < 1m.
  assert.equal(relativeTime(MINUTE, 0), 'just now')
})

test('relativeTime: minute bucket runs from 1m to 59m', () => {
  assert.equal(relativeTime(0, MINUTE), '1m')
  assert.equal(relativeTime(0, 59 * MINUTE), '59m')
  assert.equal(relativeTime(0, HOUR - 1), '59m')
})

test('relativeTime: hour bucket runs from 1h to 23h', () => {
  assert.equal(relativeTime(0, HOUR), '1h')
  assert.equal(relativeTime(0, 23 * HOUR), '23h')
  assert.equal(relativeTime(0, DAY - 1), '23h')
})

test('relativeTime: day bucket starts at 24h and floors the remainder', () => {
  assert.equal(relativeTime(0, DAY), '1d')
  assert.equal(relativeTime(0, 2 * DAY + 3 * HOUR), '2d')
})

test('relativeTime: now defaults to the wall clock for live callers', () => {
  const now = Date.now()
  assert.equal(relativeTime(now), 'just now')
  assert.equal(relativeTime(now - 5 * MINUTE), '5m')
})
