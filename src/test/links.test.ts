import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripAnsiWithMap, findFileLinks } from '../links.js'

test('stripAnsiWithMap removes CSI sequences and keeps the index map', () => {
  const { text, index } = stripAnsiWithMap('\x1b[31mred\x1b[0m plain')
  assert.equal(text, 'red plain')
  assert.deepEqual(index, [5, 6, 7, 12, 13, 14, 15, 16, 17])
})

test('stripAnsiWithMap strips OSC sequences as well', () => {
  const { text } = stripAnsiWithMap('\x1b]0;title\x07hello')
  assert.equal(text, 'hello')
})

test('stripAnsiWithMap strips OSC 8 hyperlink wrappers', () => {
  // '\x1b]8;;http://x\x07' is 14 chars; the link text starts at raw index 14.
  const { text, index } = stripAnsiWithMap('\x1b]8;;http://x\x07~/a.ts\x1b]8;;\x07')
  assert.equal(text, '~/a.ts')
  assert.deepEqual(index, [14, 15, 16, 17, 18, 19])
})

test('no links in plain prose', () => {
  assert.deepEqual(findFileLinks('this is a normal sentence with a / slash and words'), [])
})

test('empty, whitespace-only and pure-ANSI lines produce no links', () => {
  assert.deepEqual(findFileLinks(''), [])
  assert.deepEqual(findFileLinks('   '), [])
  assert.deepEqual(findFileLinks('\x1b[0m\x1b[2K'), [])
})

test('multiple links in one line are all reported in order', () => {
  const links = findFileLinks('see C:\\x\\y.ts:1 then /home/u/z.ts:2 end')
  assert.equal(links.length, 2)
  assert.equal(links[0].path, 'C:\\x\\y.ts')
  assert.equal(links[0].line, 1)
  assert.equal(links[1].path, '/home/u/z.ts')
  assert.equal(links[1].line, 2)
  assert.ok(links[0].end <= links[1].start)
})

test('Windows absolute path with line and column', () => {
  const links = findFileLinks('error in C:\\src\\a.ts:12:3 here')
  assert.equal(links.length, 1)
  assert.deepEqual(links[0], {
    start: 9,
    end: 9 + 'C:\\src\\a.ts:12:3'.length,
    path: 'C:\\src\\a.ts',
    line: 12,
    column: 3,
  })
})

test('POSIX absolute path with line only', () => {
  const links = findFileLinks('see /home/user/a.ts:42 for details')
  assert.equal(links.length, 1)
  assert.deepEqual(links[0], {
    start: 4,
    end: 4 + '/home/user/a.ts:42'.length,
    path: '/home/user/a.ts',
    line: 42,
    column: undefined,
  })
})

test('relative ./ path without line suffix', () => {
  const links = findFileLinks('check ./src/x.ts for the impl')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, './src/x.ts')
  assert.equal(links[0].line, undefined)
})

test('URLs are not treated as file paths', () => {
  assert.deepEqual(findFileLinks('see https://example.com/x and http://a.b/c'), [])
})

test('ANSI-colored path is linked with offsets into the raw line', () => {
  const raw = '\x1b[32m~/src/x.ts:1\x1b[0m done'
  const links = findFileLinks(raw)
  assert.equal(links.length, 1)
  assert.equal(links[0].path, '~/src/x.ts')
  assert.equal(links[0].line, 1)
  // '\x1b[32m' is 5 chars: the link must start at raw index 5 and end after
  // '~/src/x.ts:1' (12 chars) plus the 5-char prefix.
  assert.equal(links[0].start, 5)
  assert.equal(links[0].end, 5 + 12)
})

test('inline code like (a / b) does not produce a link', () => {
  assert.deepEqual(findFileLinks('if (a / b) then'), [])
  assert.deepEqual(findFileLinks('if (x/2) then'), [])
})

test('CJK sentence punctuation is not included in the path', () => {
  const links = findFileLinks('看 /home/u/a.ts，然后')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, '/home/u/a.ts')
})

test('overlapping candidates collapse to one link', () => {
  const links = findFileLinks('win C:/a/b.ts:1 end')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, 'C:/a/b.ts')
  assert.equal(links[0].line, 1)
})