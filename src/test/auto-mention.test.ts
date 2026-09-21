import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMentionForSnapshot,
  decideAutoInsert,
  shouldBroadcastSelection,
} from '../auto-mention.js'

// ---------- 门控:默认关闭 ----------
test('disabled setting always skips, even with selection and terminal', () => {
  const result = decideAutoInsert({
    enabled: false,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 11, endLine: 13 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'skip', reason: 'disabled' })
})

// ---------- 门控:空选区 ----------
test('empty selection is skipped (no auto-inject on mere clicks)', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: false,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 0, endLine: 0 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'skip', reason: 'no-selection' })
})

test('cursor-only movement never triggers even when enabled', () => {
  // 模拟:用户点击/移动光标(空选区),不应注入
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: false,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 5, endLine: 5 },
    lastInserted: '...',
  })
  assert.equal(result.action, 'skip')
})

// ---------- 门控:无运行中会话 ----------
test('no running terminal is skipped silently (no clipboard, no toast)', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: false,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 11, endLine: 13 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'skip', reason: 'no-terminal' })
})

// ---------- 去重 ----------
test('identical selection right after an insert is deduplicated', () => {
  const mention = '@D:/repo/src/a.ts#L12-14'
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 11, endLine: 13 },
    lastInserted: mention,
  })
  assert.deepEqual(result, { action: 'skip', reason: 'duplicate' })
})

test('same path but different range is NOT a duplicate (new mention)', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 11, endLine: 13 },
    lastInserted: '@D:/repo/src/a.ts#L12',
  })
  assert.equal(result.action, 'insert')
  assert.equal(result.mention, '@D:/repo/src/a.ts#L12-14')
})

// ---------- 推送判定:去重只挡「键入回退」 ----------
// 两次手势的行区间归一化后可能相同而正文不同(先把末尾拖到 (7,1),再拖成整行):
// mention 相同 → decideAutoInsert 判 duplicate → 若拿它挡推送,TUI 会停在上一次
// 的正文上。推送是幂等状态更新,不受去重约束。
test('duplicate still broadcasts to the IDE channel (dedupe only gates typing)', () => {
  assert.equal(shouldBroadcastSelection({ action: 'skip', reason: 'duplicate' }), true)
  assert.equal(shouldBroadcastSelection({ action: 'insert', mention: '@a.ts#L2' }), true)
})

test('no-terminal still broadcasts (the terminal gate only gates typing)', () => {
  // 手动启动(lock 扫描发现)的 dsh-tui 没有扩展自己创建的终端,却是一等订阅者:
  // 拿 no-terminal 挡推送会让该路径收不到任何非空选区,而空选区的清除通知又
  // 照常发出——两条路径自相矛盾。终端门禁只属于键入回退。
  assert.equal(shouldBroadcastSelection({ action: 'skip', reason: 'no-terminal' }), true)
})

test('disabled / no-selection never broadcast', () => {
  for (const reason of ['disabled', 'no-selection'] as const) {
    assert.equal(shouldBroadcastSelection({ action: 'skip', reason }), false)
  }
})

// ---------- 正常注入:mention 构造 ----------
test('multi-line selection produces @abs/path L1-2 (0-based → 1-based)', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 0, endLine: 1 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@D:/repo/src/a.ts#L1-2' })
})

test('single-line selection uses a single line number', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: '/home/me/src/a.ts', startLine: 11, endLine: 11 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@/home/me/src/a.ts#L12' })
})

test('windows backslash path is normalized to forward slashes before insert', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'C:\\Users\\me\\repo\\src\\a.ts', startLine: 2, endLine: 4 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@C:/Users/me/repo/src/a.ts#L3-5' })
})

// ---------- 路径含空白 → 双引号形式 ----------
test('path with whitespace uses the double-quoted mention form', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/My Some/a file.ts', startLine: 0, endLine: 1 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@"D:/My Some/a file.ts"#L1-2' })
})

// ---------- 反转选区(reversed) ----------
test('reversed selection still uses start..end in ascending order', () => {
  // VS Code 的 selection.start/end 已经是规范序;即使 isReversed,start<end
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/src/a.ts', startLine: 5, endLine: 9 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@D:/repo/src/a.ts#L6-10' })
})

// ---------- buildMentionForSnapshot 边界 ----------
test('buildMentionForSnapshot passes through POSIX path unchanged', () => {
  assert.equal(
    buildMentionForSnapshot({ path: '/home/me/a.ts', startLine: 0, endLine: 0 }),
    '@/home/me/a.ts#L1',
  )
})

test('buildMentionForSnapshot normalizes backslashes', () => {
  assert.equal(
    buildMentionForSnapshot({ path: 'C:\\repo\\b.ts', startLine: 12, endLine: 12 }),
    '@C:/repo/b.ts#L13',
  )
})

// ---------- 组合门控:在边界下的全判定 ----------
test('same selection after switching back is deduplicated only against last insert', () => {
  // 用户选中 A 段 → 注入;切走 → 切回 A 段:lastInserted 仍是 A,所以去重跳过
  const first = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/a.ts', startLine: 0, endLine: 2 },
    lastInserted: undefined,
  })
  assert.equal(first.action, 'insert')
  const again = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/a.ts', startLine: 0, endLine: 2 },
    lastInserted: first.mention,
  })
  assert.deepEqual(again, { action: 'skip', reason: 'duplicate' })
})

test('first-selection-insert is never a duplicate', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/a.ts', startLine: 3, endLine: 5 },
    lastInserted: undefined,
  })
  assert.equal(result.action, 'insert')
})

test('selection boundary at last line (0-based) maps to itself as 1-based', () => {
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/z.ts', startLine: 99, endLine: 99 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@D:/repo/z.ts#L100' })
})

test('multi-cursor: report uses the primary selection only (start/end of primary)', () => {
  // onDidChangeTextEditorSelection 的 editor.selection 是主选区,这里固定它
  const result = decideAutoInsert({
    enabled: true,
    hasSelection: true,
    hasTerminal: true,
    snapshot: { path: 'D:/repo/m.ts', startLine: 20, endLine: 22 },
    lastInserted: undefined,
  })
  assert.deepEqual(result, { action: 'insert', mention: '@D:/repo/m.ts#L21-23' })
})
