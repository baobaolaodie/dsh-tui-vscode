'use strict';
/**
 * Unit tests for the workspace path and file policy (data layer, no vscode).
 * Run: node --test out/test/safe-path.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    assertInside, buildExcludeMatcher, DEFAULT_EXCLUDE_GLOBS, isInside, SafePathError,
} = require('../safe-path');

/** Build a throw-away root/outside pair; returns absolute paths. */
async function fixture(t) {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safe-path-'));
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(root, 'a.txt'), 'inside');
    await fsp.writeFile(path.join(outside, 'b.txt'), 'outside');
    t.after(() => fsp.rm(base, { recursive: true, force: true }).catch(() => {}));
    return { base, root, outside };
}

async function assertCode(promise, code) {
    await assert.rejects(promise, error => {
        assert.ok(error instanceof SafePathError, `expected SafePathError, got ${error && error.name}`);
        assert.equal(error.code, code);
        return true;
    });
}

test('a regular file inside the workspace root is accepted', async (t) => {
    const { root } = await fixture(t);
    const file = path.join(root, 'a.txt');
    const result = await assertInside(file, [root]);
    assert.equal(result.path, await fsp.realpath(file));
    assert.equal(result.requested, path.resolve(file));
    assert.equal(result.root, await fsp.realpath(root));
    assert.equal(result.exists, true);
    assert.equal(result.size, 'inside'.length);
});

test('a missing file inside the root is accepted (create / restore target)', async (t) => {
    const { root } = await fixture(t);
    const result = await assertInside(path.join(root, 'sub', 'new.txt'), [root]);
    assert.ok(result.path.endsWith(path.join('sub', 'new.txt')));
    assert.equal(result.exists, false);
    assert.equal(result.size, 0);
});

test('a file outside every root is refused', async (t) => {
    const { root, outside } = await fixture(t);
    await assertCode(assertInside(path.join(outside, 'b.txt'), [root]), 'outside-workspace');
});

test('a relative path, a missing root list and a directory are refused', async (t) => {
    const { root } = await fixture(t);
    await assertCode(assertInside('relative.txt', [root]), 'not-absolute');
    await assertCode(assertInside(path.join(root, 'a.txt'), []), 'no-workspace-root');
    await assertCode(assertInside(root, [root]), 'not-a-file');
});

test('version-control metadata and dependency trees are protected', async (t) => {
    const { root } = await fixture(t);
    await fsp.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await fsp.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
    await fsp.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await fsp.writeFile(path.join(root, '.git', 'objects', 'ab'), 'x');
    await assertCode(assertInside(path.join(root, 'node_modules', 'pkg', 'index.js'), [root]), 'protected-directory');
    await assertCode(assertInside(path.join(root, '.git', 'objects', 'ab'), [root]), 'protected-directory');
});

test('a symlinked file is refused even when it points inside the root', async (t) => {
    const { root } = await fixture(t);
    const link = path.join(root, 'link.txt');
    try {
        await fsp.symlink(path.join(root, 'a.txt'), link, 'file');
    }
    catch (error) {
        if (['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'EPROTO', 'EOPNOTSUPP'].includes(error.code)) return t.skip('symlinks unavailable');
        throw error;
    }
    await assertCode(assertInside(link, [root]), 'symbolic-link');
});

test('a directory link that escapes the workspace is refused', async (t) => {
    const { root, outside } = await fixture(t);
    const link = path.join(root, 'escape');
    try {
        await fsp.symlink(outside, link, 'dir');
    }
    catch (error) {
        if (['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'EPROTO', 'EOPNOTSUPP'].includes(error.code)) return t.skip('symlinks unavailable');
        throw error;
    }
    await assertCode(assertInside(path.join(link, 'b.txt'), [root]), 'outside-workspace');
});

test('a workspace opened through a symlink still accepts its real children', async (t) => {
    const { root, base } = await fixture(t);
    const linkRoot = path.join(base, 'workspace-link');
    try {
        await fsp.symlink(root, linkRoot, 'dir');
    }
    catch (error) {
        if (['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'EPROTO', 'EOPNOTSUPP'].includes(error.code)) return t.skip('symlinks unavailable');
        throw error;
    }
    const result = await assertInside(path.join(linkRoot, 'a.txt'), [linkRoot]);
    assert.equal(result.path, await fsp.realpath(path.join(root, 'a.txt')));
    // The caller's path is preserved for the ledger key: the editor and the
    // tool notification both name the file through the link they were given.
    assert.equal(result.requested, path.resolve(path.join(linkRoot, 'a.txt')));
    assert.equal(result.root, await fsp.realpath(root));
});

test('the lexical pre-filter accepts inside paths and rejects outside ones', async (t) => {
    const { root, outside } = await fixture(t);
    assert.equal(isInside(path.join(root, 'a.txt'), [root]), true);
    assert.equal(isInside(path.join(outside, 'b.txt'), [root]), false);
    assert.equal(isInside('relative.txt', [root]), false);
    assert.equal(isInside(path.join(root, 'a.txt'), []), false);
});

test('the lexical pre-filter does not confuse a "..foo" segment with a parent hop', async (t) => {
    const { root } = await fixture(t);
    assert.equal(isInside(path.join(root, '..foo', 'x.js'), [root]), true);
    assert.equal(isInside(path.join(root, '..'), [root]), false);
});

test('the lexical pre-filter folds case on Windows only', { skip: process.platform !== 'win32' }, async (t) => {
    const { root } = await fixture(t);
    assert.equal(isInside(path.join(root, 'A.TXT'), [root.toUpperCase()]), true);
});

test('the default exclusion matcher covers dependency, build, binary and temp paths', () => {
    const excluded = buildExcludeMatcher();
    assert.equal(excluded(path.join('/w', 'node_modules', 'pkg', 'index.js')), true);
    assert.equal(excluded(path.join('/w', '.git', 'objects', 'ab')), true);
    assert.equal(excluded(path.join('/w', 'dist', 'app.js')), true);
    assert.equal(excluded(path.join('/w', 'build', 'out.js')), true);
    assert.equal(excluded(path.join('/w', '.vscode', 'settings.json')), true);
    assert.equal(excluded(path.join('/w', 'src', 'index.ts')), false);
    assert.equal(excluded(path.join('/w', 'notes.txt')), false);
    assert.equal(excluded(path.join('/w', 'logo.png')), true);
    assert.equal(excluded(path.join('/w', 'archive.zip')), true);
    assert.equal(excluded(path.join('/w', 'report.xlsx')), true);
    assert.equal(excluded(path.join('/w', 'file.tmp')), true);
    assert.equal(excluded(path.join('/w', 'file.tmpdir')), true);
    assert.equal(excluded(path.join('/w', '.file.swp')), true);
    assert.equal(excluded(path.join('/w', 'backup~')), true);
    assert.equal(excluded(''), true);
});

test('default globs match absolute paths on every platform', () => {
    const excluded = buildExcludeMatcher();
    // POSIX absolute path: the leading '/' must not defeat the '**/' prefix.
    assert.equal(excluded('/home/dev/project/node_modules/pkg/index.js'), true);
    assert.equal(excluded('/home/dev/project/src/index.ts'), false);
    assert.deepEqual(DEFAULT_EXCLUDE_GLOBS.includes('**/node_modules/**'), true);
});

test('a configured glob list replaces the defaults but binary/temp rules stay', () => {
    const excluded = buildExcludeMatcher(['**/vendor/**']);
    assert.equal(excluded(path.join('/w', 'vendor', 'lib.js')), true);
    assert.equal(excluded(path.join('/w', 'node_modules', 'pkg', 'index.js')), false);
    assert.equal(excluded(path.join('/w', 'logo.png')), true);
});

test('a ".git" file (linked worktree / submodule) is refused like a directory', async (t) => {
    const { root } = await fixture(t);
    const gitFile = path.join(root, '.git');
    await fsp.writeFile(gitFile, 'gitdir: ../x');
    await assertCode(assertInside(gitFile, [root]), 'protected-directory');
});

test('a protected directory cannot be bypassed by the workspace folder order', async (t) => {
    const { root } = await fixture(t);
    const deps = path.join(root, 'node_modules');
    const pkg = path.join(deps, 'pkg');
    await fsp.mkdir(pkg, { recursive: true });
    const file = path.join(pkg, 'index.js');
    await fsp.writeFile(file, 'x');
    // The dependency tree is inside the workspace even when it is also opened
    // as its own workspace folder; the answer must not depend on root order.
    await assertCode(assertInside(file, [root, deps]), 'protected-directory');
    await assertCode(assertInside(file, [deps, root]), 'protected-directory');
});

test('a path whose parent is a regular file is refused', async (t) => {
    const { root } = await fixture(t);
    const target = path.join(root, 'a.txt', 'new.txt');
    await assertCode(assertInside(target, [root]), 'not-a-file');
});

test('a dangling link is refused instead of treated as a missing tail', async (t) => {
    const { root } = await fixture(t);
    const link = path.join(root, 'dangling');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    try {
        await fsp.symlink(path.join(root, 'missing-dir'), link, kind);
    }
    catch (error) {
        if (['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'EPROTO', 'EOPNOTSUPP', 'ENOENT'].includes(error.code)) return t.skip('links unavailable');
        throw error;
    }
    await assertCode(assertInside(path.join(link, 'x.txt'), [root]), 'symbolic-link');
});

test('a relative workspace root is ignored rather than resolved against cwd', async () => {
    await assertCode(assertInside(path.join('/w', 'f.txt'), ['relative-root']), 'no-workspace-root');
});

test('default globs match UNC paths', () => {
    const excluded = buildExcludeMatcher();
    assert.equal(excluded('\\\\server\\share\\ws\\node_modules\\pkg\\index.js'), true);
    assert.equal(excluded('\\\\server\\share\\ws\\dist\\app.js'), true);
    assert.equal(excluded('\\\\server\\share\\ws\\src\\index.ts'), false);
});

test('a hard-linked target is refused', async (t) => {
    const { root } = await fixture(t);
    const original = path.join(root, 'a.txt');
    const linked = path.join(root, 'hardlink.txt');
    try {
        await fsp.link(original, linked);
    }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS', 'EXDEV', 'EINVAL'].includes(error.code)) return t.skip('hard links unavailable');
        throw error;
    }
    await assertCode(assertInside(original, [root]), 'hard-link');
});
