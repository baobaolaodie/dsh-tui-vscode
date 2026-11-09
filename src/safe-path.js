'use strict';
/**
 * safe-path — workspace path and file policy for every review write.
 *
 * The review feature writes files (Undo restores the original, deletes a
 * created file) and later trusts paths that arrive from another process (the
 * dsh-TUI edit signal). Both decisions must rest on filesystem facts and a
 * shared file policy, not on string prefixes:
 *   - containment: is this path a regular file inside one of the open
 *     workspace folders, with any directory link resolved and still inside
 *     (the file itself may never be a link)?
 *   - exclusions: is it a build/dependency directory, a binary format, or a
 *     write-machinery temp name that must never become a review entry?
 *
 * Containment is asynchronous because it needs `realpath()`: a workspace may
 * be opened through a symlink and a directory inside it may still link
 * outside. Exclusions are pure string checks. Both live here, and only here,
 * so the presentation layer (Undo / Keep) and the attribution layer (trusting
 * a tool notification) cannot drift apart.
 *
 * Pure Node (no `vscode` import): the host passes the workspace roots and the
 * user's exclude globs in. The text shape of a review entry is a separate
 * contract in `review-text.js`.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * Directories under a workspace root that a review never writes into:
 * version-control metadata, dependency trees and build caches. They are not
 * the user's source and a misplaced restore there can corrupt a repository.
 */
const PROTECTED_DIRS = Object.freeze(['.git', '.hg', '.svn', 'node_modules']);

/** Default `editReview.exclude` globs (the setting overrides this list). */
const DEFAULT_EXCLUDE_GLOBS = Object.freeze([
    '**/node_modules/**', '**/.git/**', '**/.svn/**', '**/.hg/**',
    '**/dist/**', '**/build/**', '**/__pycache__/**', '**/.vscode/**',
]);

/** Binary formats that can never be reviewed as text (lower-case extensions). */
const BINARY_EXTENSIONS = Object.freeze([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.psd',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.zst', '.zstd',
    '.zip', '.7z', '.gz', '.tar', '.rar', '.pdf', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov', '.sqlite', '.db', '.pdb', '.lib',
    '.obj', '.class', '.jar', '.map', '.lnk', '.url',
].map(ext => ext.toLowerCase()));

/**
 * Write-machinery temp names (atomic-write artifacts like `x~RF123.TMP` /
 * `.x.1234.<uuid>.tmpdir`, editor swap files). Their create/delete events are
 * noise, never real AI edits.
 */
const TEMP_NAME_RE = /\.tmp(dir)?$|\.temp$|\.sw[px]$|~$|~\$/i;

/** Stable reasons a caller can branch on instead of matching messages. */
class SafePathError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SafePathError';
        this.code = code;
    }
}

function foldCase(value) {
    return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
}

function requireAbsolute(value, label) {
    if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
        throw new SafePathError('not-absolute', `${label} must be an absolute path`);
    }
    return path.resolve(value);
}

/** Slash-normalised path for glob matching (globs are written with '/'). */
function normalizeSlashes(target) {
    return target.replace(/\\/g, '/');
}

/** Tiny glob → RegExp (supports '*' and '**'), matched case-insensitively. */
function globToRegex(glob) {
    let source = '';
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                index++;
                if (glob[index + 1] === '/') {
                    index++;
                    source += '(?:[^/]+/)*';
                }
                else {
                    source += '.*';
                }
            }
            else {
                source += '[^/]*';
            }
        }
        else if (char === '?') {
            source += '[^/]';
        }
        else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    // '**/x/**' style globs are matched against ABSOLUTE paths too, so any
    // leading separator run must be allowed (a POSIX path starts with '/',
    // a Windows UNC path with '//', a drive path with 'C:').
    return new RegExp('^' + (glob.startsWith('**/') ? '/*' : '') + source + '$', 'i');
}

/**
 * Build the predicate that decides whether a path is outside the review's
 * scope: user exclude globs, binary extensions, and write-machinery temp
 * names. The presentation layer passes the configured globs; the attribution
 * layer passes the defaults (or the same configured value) so both see the
 * same set.
 * @param {string[]} [globs] `editReview.exclude` style globs
 * @returns {(target: string) => boolean} true when the path must not be reviewed
 */
function buildExcludeMatcher(globs = DEFAULT_EXCLUDE_GLOBS) {
    const patterns = (Array.isArray(globs) ? globs : DEFAULT_EXCLUDE_GLOBS)
        .filter(glob => typeof glob === 'string' && glob.length > 0)
        .map(globToRegex);
    return target => {
        if (typeof target !== 'string' || target.length === 0) return true;
        const normalised = normalizeSlashes(target);
        if (patterns.some(pattern => pattern.test(normalised))) return true;
        if (BINARY_EXTENSIONS.includes(path.extname(target).toLowerCase())) return true;
        return TEMP_NAME_RE.test(path.basename(target));
    };
}

/**
 * Lexical containment test: true when `target` lies inside one of `roots`.
 * No filesystem access, so it is a cheap pre-filter; `assertInside` is the
 * authoritative check (symlinks and missing parents can only be judged there).
 */
function isInside(target, roots) {
    if (typeof target !== 'string' || !path.isAbsolute(target) || !Array.isArray(roots)) return false;
    const resolved = foldCase(path.resolve(target));
    for (const root of roots) {
        if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
        const relative = path.relative(foldCase(path.resolve(root)), resolved);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
        return true;
    }
    return false;
}

/**
 * Resolve `target` to the real path the filesystem would touch, allowing
 * missing tails (create and restore targets do not exist yet).
 *
 * A directory link is followed (the workspace itself may be opened through
 * one); a dangling link is still a link and is refused. Files are never
 * written through a link, which is what the caller checks separately.
 * @returns {Promise<{path: string, tailLength: number, realAncestor: string}>}
 *   `tailLength` is how many trailing components did not exist; a non-zero
 *   value means `realAncestor` must be a directory.
 */
async function realTargetPath(target) {
    const tail = [];
    let probe = target;
    for (;;) {
        try {
            const real = await fsp.realpath(probe);
            return {
                path: tail.length === 0 ? real : path.join(real, ...tail),
                tailLength: tail.length,
                realAncestor: real,
            };
        }
        catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
                throw new SafePathError('unreadable', `cannot resolve ${probe}`);
            }
            // `realpath` follows a link; a dangling link surfaces as ENOENT
            // while `lstat` still sees the link itself.
            const dangling = await fsp.lstat(probe).catch(() => null);
            if (dangling && dangling.isSymbolicLink()) {
                throw new SafePathError('symbolic-link', 'review cannot write through a symbolic link');
            }
            const parent = path.dirname(probe);
            if (parent === probe) throw new SafePathError('unreadable', `cannot resolve ${target}`);
            tail.unshift(path.basename(probe));
            probe = parent;
        }
    }
}

/**
 * Assert that `target` is a regular file (or a not-yet-existing file) inside
 * one of `roots`, resolved against the real filesystem (a directory link is
 * followed but must stay inside the workspace; the file itself may not be a
 * link), outside `PROTECTED_DIRS` and version-control metadata (directory or
 * `.git`-style file), and not hard-linked to another file (writing a
 * hard-linked target would also modify the outside copy).
 *
 * This is a best-effort check: Node exposes no `openat`-style primitive, so
 * the host must write immediately after validation, through the returned
 * `requested` path, and re-validate if it had to wait or re-open.
 *
 * @param {string} target absolute path to inspect
 * @param {string[]} roots absolute workspace folder paths
 * @returns {Promise<{path: string, requested: string, root: string,
 *   exists: boolean, size: number}>} `path` is the filesystem-real path (use
 *   it for reading); `requested` is the caller's path with missing segments as
 *   given (use it as the ledger key and write target — the editor and the tool
 *   notification both name the file the way the user does, and the ledger must
 *   not silently rewrite a path through a symlinked directory).
 * @throws {SafePathError} with `code`:
 *   `not-absolute` | `no-workspace-root` | `outside-workspace` |
 *   `symbolic-link` | `not-a-file` | `hard-link` | `protected-directory` |
 *   `unreadable`
 */
async function assertInside(target, roots) {
    const resolved = requireAbsolute(target, 'target');
    const rootList = (Array.isArray(roots) ? roots : [])
        .filter(root => typeof root === 'string' && root.length > 0 && path.isAbsolute(root));
    if (rootList.length === 0) {
        throw new SafePathError('no-workspace-root', 'no workspace folder is open');
    }

    // A review never writes *through* a link: the file at this exact path must
    // be a regular file (or not exist yet — create/restore targets).
    let stat = null;
    try {
        stat = await fsp.lstat(resolved);
    }
    catch (error) {
        if (error.code === 'ENOTDIR') throw new SafePathError('not-a-file', 'a parent of the target is not a directory');
        if (error.code !== 'ENOENT') throw new SafePathError('unreadable', `cannot inspect ${resolved}`);
    }
    if (stat && stat.isSymbolicLink()) {
        throw new SafePathError('symbolic-link', 'review cannot write through a symbolic link');
    }
    if (stat && !stat.isFile()) {
        throw new SafePathError('not-a-file', 'review only writes regular files');
    }
    // A hard link shares the inode with another path: rewriting this file would
    // rewrite the outside copy through a link the realpath check cannot see.
    if (stat && stat.nlink > 1) {
        throw new SafePathError('hard-link', 'review cannot write a hard-linked file');
    }

    const resolvedTarget = await realTargetPath(resolved);
    const realTarget = resolvedTarget.path;
    if (resolvedTarget.tailLength > 0) {
        const ancestor = await fsp.stat(resolvedTarget.realAncestor).catch(() => null);
        if (!ancestor || !ancestor.isDirectory()) {
            throw new SafePathError('not-a-file', 'a parent of the target is not a directory');
        }
    }
    // Version-control metadata can also be a FILE: linked worktrees and
    // submodules keep a `.git` file with a `gitdir:` pointer. Writing it
    // breaks the checkout just like writing inside a `.git` directory.
    if (['.git', '.hg', '.svn'].includes(foldCase(path.basename(realTarget)))) {
        throw new SafePathError('protected-directory', 'review cannot write version-control metadata');
    }

    // The most specific workspace folder owns the file, but EVERY containing
    // folder must agree that the relative path is reviewable: otherwise the
    // answer would depend on the order workspace folders are stored in.
    let owner = null;
    for (const root of rootList) {
        let realRoot;
        try {
            realRoot = await fsp.realpath(root);
        }
        catch {
            continue;
        }
        const relative = path.relative(realRoot, realTarget);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            continue;
        }
        // Only the directory segments matter, not the file name itself.
        for (const segment of relative.split(path.sep).slice(0, -1)) {
            if (PROTECTED_DIRS.includes(foldCase(segment))) {
                throw new SafePathError('protected-directory', `review cannot write inside "${segment}"`);
            }
        }
        if (!owner || realRoot.length > owner.length) owner = realRoot;
    }
    if (!owner) throw new SafePathError('outside-workspace', 'review is restricted to the open workspace folders');
    return {
        path: realTarget,
        requested: resolved,
        root: owner,
        exists: stat !== null,
        size: stat ? stat.size : 0,
    };
}

module.exports = {
    BINARY_EXTENSIONS,
    DEFAULT_EXCLUDE_GLOBS,
    PROTECTED_DIRS,
    SafePathError,
    TEMP_NAME_RE,
    assertInside,
    buildExcludeMatcher,
    globToRegex,
    isInside,
    normalizeSlashes,
};
