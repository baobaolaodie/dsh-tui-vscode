import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAtMention, normalizeMentionPath, relativeToWorkspace } from '../at-mention.js'

// 回归锁(issue #21 第 3 条):大小写折叠只应发生在不区分大小写的平台上。
// 旧实现无条件 toLowerCase(),在 Linux 上会把 /work/Repo/a.ts 当成 /work/repo
// 工作区内的文件,产出指向**另一个文件**的相对引用。
test('relativeToWorkspace folds case only when the platform does', () => {
  // 区分大小写(Linux 语义):仅大小写不同不算工作区内 → 兜底原路径
  assert.equal(relativeToWorkspace('/work/Repo/a.ts', '/work/repo', false), '/work/Repo/a.ts')
  // 不区分大小写(Windows/macOS 语义):视作工作区内 → 相对化,且保留原有大小写
  assert.equal(relativeToWorkspace('/work/Repo/a.ts', '/work/repo', true), 'a.ts')
  // 精确匹配在两种模式下都相对化
  assert.equal(relativeToWorkspace('/work/repo/a.ts', '/work/repo', false), 'a.ts')
})

// ---------- 相对路径 + #L 行区间 ----------

test('multi-line selection emits workspace-relative path with #L range (0-based → 1-based)', () => {
  assert.equal(
    buildAtMention('D:/repo/src/a.ts', { isEmpty: false, startLine: 11, endLine: 13 }, 'D:/repo'),
    '@src/a.ts#L12-14',
  )
})

test('single-line selection emits a single #L number (1-based)', () => {
  assert.equal(
    buildAtMention('D:/repo/src/a.ts', { isEmpty: false, startLine: 11, endLine: 11 }, 'D:/repo'),
    '@src/a.ts#L12',
  )
})

test('path outside the workspace root falls back to absolute with #L kept', () => {
  assert.equal(
    buildAtMention('D:/other/b.ts', { isEmpty: false, startLine: 3, endLine: 5 }, 'D:/repo'),
    '@D:/other/b.ts#L4-6',
  )
})

test('empty selection references the bare relative path without a line range', () => {
  assert.equal(
    buildAtMention('D:/repo/src/a.ts', { isEmpty: true, startLine: 0, endLine: 0 }, 'D:/repo'),
    '@src/a.ts',
  )
})

test('without workspaceRoot the absolute path is kept and still carries #L', () => {
  assert.equal(
    buildAtMention('D:/repo/src/a.ts', { isEmpty: false, startLine: 0, endLine: 1 }, undefined),
    '@D:/repo/src/a.ts#L1-2',
  )
})

test('path containing whitespace uses the double-quoted mention form with glued #L', () => {
  assert.equal(
    buildAtMention('D:/repo/my dir/a.ts', { isEmpty: false, startLine: 2, endLine: 4 }, 'D:/repo'),
    '@"my dir/a.ts"#L3-5',
  )
})

// ---------- Windows 归一化与根匹配稳健性 ----------

test('backslash fsPaths are normalized against the workspace root (Windows)', () => {
  assert.equal(
    buildAtMention('D:\\repo\\src\\a.ts', { isEmpty: false, startLine: 11, endLine: 13 }, 'D:\\repo'),
    '@src/a.ts#L12-14',
  )
})

// 大小写漂移只在**文件系统不区分大小写**的宿主上成立——那里 `d:/repo` 与
// `D:/Repo` 确实是同一个目录。Linux 上它们是两个目录，不该相对化；那正是
// issue #21 第 3 条修掉的误判，所以这条断言只在 win32/darwin 上执行。
test(
  'workspace root matching ignores case while preserving the path casing (case-insensitive hosts)',
  { skip: process.platform !== 'win32' && process.platform !== 'darwin' },
  () => {
    assert.equal(
      buildAtMention('D:/Repo/SRC/a.ts', { isEmpty: false, startLine: 0, endLine: 1 }, 'd:/repo'),
      '@SRC/a.ts#L1-2',
    )
  },
)

test('trailing slash on the workspace root still relativizes', () => {
  assert.equal(
    buildAtMention('D:/repo/src/a.ts', { isEmpty: false, startLine: 0, endLine: 0 }, 'D:/repo/'),
    '@src/a.ts#L1',
  )
})

// ---------- 无 workspaceRoot 的既有契约(调用方自行归一化,路径原样直通) ----------

test('relative path passes through unchanged when no workspaceRoot is given', () => {
  assert.equal(
    buildAtMention('src/session.ts', { isEmpty: false, startLine: 0, endLine: 2 }),
    '@src/session.ts#L1-3',
  )
})

test('empty selection with whitespace path keeps the double-quoted bare form', () => {
  assert.equal(
    buildAtMention('src/my file.ts', { isEmpty: true, startLine: 0, endLine: 0 }),
    '@"src/my file.ts"',
  )
})

test('absolute forward-slash mention survives the dsh-tui cwd-independent path', () => {
  const path = normalizeMentionPath('D:\\repo\\src\\a.ts')
  assert.equal(
    buildAtMention(path, { isEmpty: false, startLine: 11, endLine: 13 }),
    '@D:/repo/src/a.ts#L12-14',
  )
})

// ---------- normalizeMentionPath(行为不变,回归守护) ----------

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
