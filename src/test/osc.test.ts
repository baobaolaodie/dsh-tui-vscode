import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OscScanner } from '../osc.js'

test('plain text and CSI pass through untouched', () => {
  const { clean, events } = new OscScanner().scan('hello \x1b[31mred\x1b[0m world')
  assert.equal(clean, 'hello \x1b[31mred\x1b[0m world')
  assert.deepEqual(events, [])
})

test('OSC 52 clipboard set is stripped and reported', () => {
  const { clean, events } = new OscScanner().scan('before\x1b]52;c;aGVsbG8=\x07after')
  assert.equal(clean, 'beforeafter')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'clipboard')
  assert.equal(events[0].payload, 'c;aGVsbG8=')
})

test('OSC 11 background query is stripped and reported', () => {
  const { clean, events } = new OscScanner().scan('\x1b]11;?\x07x')
  assert.equal(clean, 'x')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'backgroundQuery')
})

test('OSC 0 title is stripped and reported', () => {
  const { clean, events } = new OscScanner().scan('\x1b]0;my title\x07body')
  assert.equal(clean, 'body')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'title')
  assert.equal(events[0].payload, 'my title')
})

test('OSC 8 hyperlinks are kept for xterm rendering', () => {
  const raw = '\x1b]8;;http://x\x07link text\x1b]8;;\x07'
  const { clean, events } = new OscScanner().scan(raw)
  assert.equal(clean, raw)
  assert.deepEqual(events, [])
})

test('unknown OSC is stripped silently', () => {
  const { clean, events } = new OscScanner().scan('a\x1b]9;4;0;\x07b')
  assert.equal(clean, 'ab')
  assert.deepEqual(events, [])
})

test('sequences split across chunks are reassembled', () => {
  const scanner = new OscScanner()
  const first = scanner.scan('ab\x1b]52;c;aGVs')
  assert.equal(first.clean, 'ab')
  assert.deepEqual(first.events, [])
  const second = scanner.scan('bG8=\x07cd')
  assert.equal(second.clean, 'cd')
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].kind, 'clipboard')
})

test('ST-terminated OSC is handled like BEL-terminated', () => {
  const { clean, events } = new OscScanner().scan('\x1b]0;title\x1b\\body')
  assert.equal(clean, 'body')
  assert.equal(events[0].kind, 'title')
})