"use strict";
/**
 * Stable review surfaces for verified file-tool transactions. Watchers keep
 * ordinary baselines current; terminal lifetime is never edit provenance.
 * Complete removed lines are available in the native VS Code diff editor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditReview = void 0;
const vscode = require("vscode");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const edit_review_core_1 = require("./edit-review-core");
const precise = require("./precise-review-core");
const { deletedTextDecoration } = require('./review-decoration');
const fsp = node_fs_1.promises;
const { randomUUID } = require('node:crypto');
/** Case-folded map key for paths that arrive from both the tool and VS Code. */
const reviewPathKey = (path) => (0, edit_review_core_1.canonicalPathKey)(path);
const SCHEME = 'dsh-edit-review';
const KEEP_CMD = 'dsh-tui-vscode.editKeep';
const UNDO_CMD = 'dsh-tui-vscode.editUndo';
const KEEP_ALL_CMD = 'dsh-tui-vscode.editKeepAll';
const UNDO_ALL_CMD = 'dsh-tui-vscode.editUndoAll';
const DIFF_CMD = 'dsh-tui-vscode.editShowDiff';
const NEXT_CMD = 'dsh-tui-vscode.editNextHunk';
const PREV_CMD = 'dsh-tui-vscode.editPrevHunk';
const KEEP_LINE_CMD = 'dsh-tui-vscode.editKeepLine';
const UNDO_LINE_CMD = 'dsh-tui-vscode.editUndoLine';
const TRUSTED_CMDS = [KEEP_CMD, UNDO_CMD, DIFF_CMD];
// ---- knobs ----------------------------------------------------------------
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_TOTAL = 48 * 1024 * 1024;
const MARK_TTL_MS = 2000; // how long an editor save / self write shields a path
const DOC_SETTLE_MS = 800;
const PERSIST_DEBOUNCE_MS = 500;
const MAX_DECORATED_HUNKS = 200;
const GHOST_SEP = ' \u23CE '; // visual "line break" inside collapsed old text
const GHOST_MAX_CHARS = 160;
const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.psd',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.zst', '.zstd',
    '.zip', '.7z', '.gz', '.tar', '.rar', '.pdf', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov', '.sqlite', '.db', '.pdb', '.lib',
    '.obj', '.class', '.jar', '.map', '.lnk', '.url',
]);
const DEFAULT_EXCLUDE = [
    '**/node_modules/**', '**/.git/**', '**/.svn/**', '**/.hg/**',
    '**/dist/**', '**/build/**', '**/__pycache__/**', '**/.vscode/**',
];
/**
 * Write-machinery temp names (atomic-write artifacts like `x~RF123.TMP` /
 * `.x.1234.<uuid>.tmpdir`, editor swap files). Their create/delete events are
 * noise, never real AI edits.
 */
const TEMP_NAME_RE = /\.tmp(dir)?$|\.temp$|\.sw[px]$|~$|~\$/i;
// ---------------------------------------------------------------------------
/** Tiny glob → RegExp (supports '*' and '**'), matched case-insensitively. */
function globToRegex(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    re += '(?:[^/]+/)*';
                }
                else {
                    re += '.*';
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$', 'i');
}
function normalizeSlashes(p) {
    return p.replace(/\\/g, '/');
}
/** Join same-line old fragments into one readable strikethrough run. */
function joinGhostParts(parts) {
    let out = '';
    for (const part of parts) {
        if (!out)
            out = part;
        else if (part.startsWith(' ') || /^[,.;:!?)\]}]/.test(part) || out.endsWith(' '))
            out += part;
        else
            out += ' ' + part;
    }
    return out;
}
function isDirPrunable(name) {
    // Hidden dirs, package/build caches, and AppData (huge per-user program
    // data: it would eat the whole scan budget in a home-dir workspace).
    return name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name === 'AppData';
}
/** Command link for a trusted hover message; `hint` pins one edit (hunk). */
function cmdLink(command, arg, label, hint) {
    const args = encodeURIComponent(JSON.stringify(hint ? [arg, hint] : [arg]));
    return `[${label}](command:${command}?${args})`;
}
class EditReview {
    constructor(context, options) {
        this.disposed = false;
        this.settled = new Map();
        this.cursor = new Map();
        this.selfMarks = new Map();
        this.saveMarks = new Map();
        this.docTimers = new Map();
        this.persistTimer = null;
        this.treeView = null;
        this.pendingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 19);
        this.pendingStatus.command = 'dsh-tui-vscode.editShowPending';
        context.subscriptions.push(this.pendingStatus, vscode.commands.registerCommand('dsh-tui-vscode.editShowPending', async () => {
            const entries = this.entries();
            const choice = await vscode.window.showQuickPick(entries.map(e => ({ label: node_path_1.basename(e.path), description: this.describe(e), detail: e.path, path: e.path })), { title: 'Pending dsh-tui edits' });
            if (choice) await this.showDiff(choice.path);
        }));
        this.fileQueues = new Map();
        this.writingPaths = new Set();
        this.persistence = Promise.resolve();
        this.observedDuringScan = new Set();
        this.directoryInventory = new Map();
        this.contentEmitter = new vscode.EventEmitter();
        this.context = context;
        this.terminalName = options?.terminalName ?? 'DeepSeek';
        this.trackedTerminals = new Set();
        context.subscriptions.push(vscode.window.onDidCloseTerminal(t => this.trackedTerminals.delete(t)));
        this.ledger = new edit_review_core_1.EditLedger();
        this.excludeRegexes = [];
        // Use the active VS Code theme's diff colors; no private renderer access.
        this.decor = {
            added: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
                gutterIconPath: vscode.Uri.file(node_path_1.join(context.extensionPath, 'media', 'edit-review-added.svg')),
                gutterIconSize: 'contain',
                overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),
            removed: vscode.window.createTextEditorDecorationType({
                gutterIconPath: vscode.Uri.file(node_path_1.join(context.extensionPath, 'media', 'edit-review-removed.svg')),
                gutterIconSize: 'contain',
                overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),
            // core's char-insert: the stronger green on CHANGED WORDS only
            // (#9ccc2c40 = insertedTextBackground).
            insSpan: vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            }),
            // attachment carrier for the red strikethrough ghosts (no chrome).
            ghost: vscode.window.createTextEditorDecorationType({}),
        };
        this.reloadExcludePatterns();
        // ---- tree view (sidebar "AI Edits") --------------------------------
        const tree = new PendingTreeProvider(this);
        this.treeView = vscode.window.registerTreeDataProvider('dsh-tui-vscode.editReview', tree);
        context.subscriptions.push(this.treeView);
        // ---- original-image provider for the side-by-side comparison -------
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
            onDidChange: this.contentEmitter.event,
            provideTextDocumentContent: (uri) => this.provideOriginalContent(uri),
        }));
        // ---- commands ------------------------------------------------------
        context.subscriptions.push(vscode.commands.registerCommand(KEEP_CMD, (target, hint) => this.withPath(this.resolvePath(target), () => this.keep(target, hint))), vscode.commands.registerCommand(UNDO_CMD, (target, hint) => this.withPath(this.resolvePath(target), () => this.undo(target, hint))), vscode.commands.registerCommand(KEEP_ALL_CMD, () => this.keepAll()), vscode.commands.registerCommand(UNDO_ALL_CMD, () => this.undoAll()), vscode.commands.registerCommand(DIFF_CMD, (target) => this.showDiff(this.resolvePath(target))), vscode.commands.registerCommand(NEXT_CMD, (path) => this.gotoHunk(this.resolvePath(path), +1)), vscode.commands.registerCommand(PREV_CMD, (path) => this.gotoHunk(this.resolvePath(path), -1)));
        context.subscriptions.push(vscode.commands.registerCommand(KEEP_LINE_CMD, () => this.decideLine(false)), vscode.commands.registerCommand(UNDO_LINE_CMD, () => this.decideLine(true)), this.contentEmitter);
        // ---- review bar (twin of core's chat-editing-editor-overlay) --------
        this.bar = new ReviewBarProvider(this);
        context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.bar), this.bar);
        // ---- observation ---------------------------------------------------
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.watcher = watcher;
        watcher.onDidCreate((uri) => void this.onFsEvent(uri, 'create').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        watcher.onDidChange((uri) => void this.onFsEvent(uri, 'change').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        watcher.onDidDelete((uri) => void this.onFsEvent(uri, 'delete').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        context.subscriptions.push(watcher);
        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((doc) => {
            // Open editors are prime edit targets: capture their buffers right
            // away so the baseline exists even when the bounded startup scan
            // never reached the file.
            if (doc.uri.scheme === 'file' && !this.settled.has(doc.uri.fsPath) && !this.ledger.get(doc.uri.fsPath))
                this.settled.set(doc.uri.fsPath, this.documentSnapshot(doc));
        }), vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme !== 'file')
                return;
            const snapshot = this.documentSnapshot(doc);
            if (!this.writingPaths?.has(doc.uri.fsPath)) this.observeUserText(doc.uri.fsPath, snapshot);
            this.saveMarks.set(doc.uri.fsPath, { expires: Date.now() + MARK_TTL_MS, text: snapshot });
            if (!this.ledger.get(doc.uri.fsPath)) this.settled.set(doc.uri.fsPath, snapshot);
            this.scheduleDocSettle(doc.uri.fsPath);
        }), vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.scheme !== 'file')
                return;
            if (e.document.isDirty && e.contentChanges.length && !this.writingPaths?.has(e.document.uri.fsPath))
                this.observeUserText(e.document.uri.fsPath, this.documentSnapshot(e.document));
            this.bar?.refresh();
            this.refreshAll();
            this.scheduleDocSettle(e.document.uri.fsPath);
        }), vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()), vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()), vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('dsh-tui-vscode.editReview.exclude')
                || e.affectsConfiguration('dsh-tui-vscode.editReview.enabled')) {
                this.reloadExcludePatterns();
                this.refreshAll();
            }
        }));
        this.unsub = this.ledger.onChange(() => {
            this.refreshAll();
            this.bar?.refresh();
            for (const doc of vscode.workspace.textDocuments) {
                if (doc.uri.scheme === SCHEME) this.contentEmitter.fire(doc.uri);
            }
            this.schedulePersist();
        });
        // ---- capture open buffers, restore pending state, warm the cache -----
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.uri.scheme === 'file')
                this.settled.set(doc.uri.fsPath, this.documentSnapshot(doc));
        }
        this.ready = Promise.all([this.loadState(), this.warmScan()]).then(() => { this.observedDuringScan = null; });
        this.refreshAll();
        // VS Code can coalesce external events around an editor save. Check open
        // and pending paths as a bounded fallback, without adopting a new baseline.
        this.pollTimer = setInterval(() => {
            if (this.disposed || !this.enabled() || !this.sessionActive() || this.polling) return;
            this.polling = true;
            const paths = new Set(vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && !d.isClosed).map(d => d.uri.fsPath));
            for (const e of this.entries()) paths.add(e.path);
            void Promise.all([...paths].slice(0, 200).map(path => this.onFsEvent(vscode.Uri.file(path), 'change')))
                .catch(error => console.error('[dsh-tui-vscode] Review poll failed:', error))
                .finally(() => { this.polling = false; });
        }, 750);
    }
    shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.closing = true;
        clearInterval(this.pollTimer);
        for (const timer of this.docTimers.values()) clearTimeout(timer);
        this.docTimers.clear();
        for (const timer of this.fsRetries?.values() ?? []) clearTimeout(timer);
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = null;
        const pending = [...this.fileQueues.values()];
        this.shutdownPromise = (async () => {
            await this.ready;
            await Promise.allSettled(pending);
            await this.flushState();
        })();
        return this.shutdownPromise;
    }
    dispose() {
        if (this.disposed) return;
        void this.shutdown().catch(error => console.error('[dsh-tui-vscode] Review shutdown failed:', error));
        this.disposed = true;
        this.unsub?.();
        this.decor.added.dispose();
        this.decor.insSpan.dispose();
        this.decor.ghost.dispose();
        this.decor.removed.dispose();
    }
    // Mirror provably independent user edits into BOTH snapshots. Overlap is
    // explicit conflict, not an additional AI change or permanent save latch.
    observeUserText(path, current) {
        const entry = this.ledger.get(path);
        if (!entry || this.nativeReview?.owns(path) || this.activeTransactions?.has(reviewPathKey(path))) return;
        if (current === entry.after) {
            if (entry.userTouched && entry.conflict !== 'save-participant') { entry.userTouched = false; delete entry.conflict; this.ledger.emit(); }
            return;
        }
        const rebased = entry.beforeMissing ? { conflict: true } : precise.rebaseUserEdit(entry.before, entry.after, current);
        if (rebased.conflict) {
            entry.userTouched = true; entry.conflict = 'overlap-or-external'; this.ledger.emit();
            return;
        }
        entry.before = rebased.before; entry.after = rebased.after;
        entry.userTouched = false; delete entry.conflict;
        this.ledger.emit();
    }
    reviewSnapshot(entry, doc) {
        return !!entry && !entry.userTouched && !entry.beforeMissing && entry.kind !== 'delete'
            && !this.activeTransactions?.has(reviewPathKey(entry.path)) && !this.bomUnsupported(entry) && !doc.isDirty && doc.getText() === entry.after;
    }
    // ---- settings ----------------------------------------------------------
    enabled() {
        return vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.enabled', true);
    }
    reloadExcludePatterns() {
        const globs = vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.exclude', DEFAULT_EXCLUDE);
        this.excludeRegexes = (Array.isArray(globs) ? globs : DEFAULT_EXCLUDE)
            .filter((g) => typeof g === 'string' && g.length > 0)
            .map(globToRegex);
    }
    excluded(path) {
        const norm = normalizeSlashes(path);
        if (this.excludeRegexes.some((re) => re.test(norm)))
            return true;
        if (BINARY_EXT.has(node_path_1.extname(path).toLowerCase()))
            return true;
        if (TEMP_NAME_RE.test(node_path_1.basename(path)))
            return true;
        return false;
    }
    documentSnapshot(doc) {
        // The model omits the UTF-8 encoding BOM; disk snapshots do not. Retain
        // exactly one encoding preamble for baseline/save-shield comparisons.
        const text = doc.getText();
        let fd;
        try {
            fd = node_fs_1.openSync(doc.uri.fsPath, 'r');
            const prefix = Buffer.alloc(3);
            const count = node_fs_1.readSync(fd, prefix, 0, 3, 0);
            return count === 3 && prefix.equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' + text : text;
        } catch { return text; }
        finally { if (fd !== undefined) node_fs_1.closeSync(fd); }
    }
    // ---- settled-state cache ----------------------------------------------
    scheduleDocSettle(path) {
        const prev = this.docTimers.get(path);
        if (prev)
            clearTimeout(prev);
        this.docTimers.set(path, setTimeout(() => {
            this.docTimers.delete(path);
            void this.refreshSettled(path);
        }, DOC_SETTLE_MS));
    }
    async refreshSettled(path) {
        if (this.ledger.get(path) || this.activeTransactions?.has(reviewPathKey(path))) return;
        const generation = this.settled.get(path);
        try {
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
            if (doc && !doc.isClosed) {
                this.settled.set(path, this.documentSnapshot(doc));
                return;
            }
            const st = await fsp.lstat(path);
            if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
            const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fsp.readFile(path));
            if (!this.ledger.get(path) && !this.activeTransactions?.has(reviewPathKey(path)) && this.settled.get(path) === generation && !text.includes('\u0000')) this.settled.set(path, text);
        }
        catch {
            this.settled.delete(path);
        }
    }
    /**
     * Warm the baseline cache once at activation: bounded walk of the
     * workspace folders (skips hidden dirs / node_modules / binaries / big
     * files). Best-effort — a missed file only means that ONE file falls back
     * to "original not captured" if the AI edits it before you touch it.
     */
    async warmScan() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        let files = 0;
        let bytes = 0;
        for (const folder of folders) {
            const root = folder.uri.fsPath;
            const queue = [root];
            while (queue.length > 0 && files < MAX_SCAN_FILES && bytes < MAX_SCAN_TOTAL) {
                // BFS (shift, not pop): shallow files are captured first, so a
                // small budget still covers the files nearest the workspace
                // root instead of diving into one deep subtree.
                const dir = queue.shift();
                let names;
                try {
                    names = await fsp.readdir(dir, { withFileTypes: true });
                }
                catch {
                    continue;
                }
                this.directoryInventory.set(dir, new Set(names.map(ent => ent.name)));
                for (const ent of names) {
                    if (files >= MAX_SCAN_FILES || bytes >= MAX_SCAN_TOTAL)
                        break;
                    const full = node_path_1.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        if (!isDirPrunable(ent.name) && !this.excluded(full))
                            queue.push(full);
                        continue;
                    }
                    if (!ent.isFile() || this.excluded(full))
                        continue;
                    try {
                        const st = await fsp.stat(full);
                        if (st.size > MAX_FILE_BYTES)
                            continue;
                        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fsp.readFile(full));
                        if (text.includes('\u0000'))
                            continue; // binary sniff
                        if (!this.observedDuringScan.has(full) && !this.settled.has(full) && !this.ledger.get(full)) this.settled.set(full, text);
                        files++;
                        bytes += st.size;
                    }
                    catch {
                        // unreadable file: skip silently
                    }
                }
            }
        }
    }
    async prepareSession() {
        await this.ready;
        if (this.sessionActive()) return;
        // Refresh known disk baselines before launching, never after an observed write.
        for (const path of this.settled.keys()) {
            if (!this.ledger.get(path) && !this.nativeReview?.owns(path)) await this.refreshSettled(path);
        }
    }
    // ---- event classification ---------------------------------------------
    pruneMarks(now) {
        for (const [p, exp] of this.selfMarks)
            if (exp.expires < now)
                this.selfMarks.delete(p);
        for (const [p, exp] of this.saveMarks)
            if (exp.expires < now)
                this.saveMarks.delete(p);
    }
    trackTerminal(terminal) { this.trackedTerminals.add(terminal); }
    sessionActive() {
        return vscode.window.terminals.some(t => this.trackedTerminals.has(t) || t.name === this.terminalName);
    }
    async onFsEvent(uri, kind) {
        if (this.disposed || !this.enabled() || uri.scheme !== 'file')
            return;
        this.observedDuringScan?.add(uri.fsPath);
        return this.withPath(uri.fsPath, () => this.processFsEvent(uri, kind));
    }
    async withPath(path, operation) {
        if (!path || this.closing) return;
        const prior = this.fileQueues.get(path) ?? this.ready ?? Promise.resolve();
        const next = prior.catch(() => {}).then(operation);
        this.fileQueues.set(path, next);
        try { return await next; }
        finally { if (this.fileQueues.get(path) === next) this.fileQueues.delete(path); }
    }
    async processFsEvent(uri, kind) {
        if (this.disposed || !this.enabled() || uri.scheme !== 'file') return;
        const path = uri.fsPath;
        if (this.nativeReview?.owns(path)) { this.scheduleDocSettle(path); return; }
        if (this.excluded(path) || !vscode.workspace.getWorkspaceFolder(uri)) return;
        let after = null;
        try {
            const st = await fsp.lstat(path);
            if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return;
            after = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fsp.readFile(path));
            if (after.includes('\u0000')) return;
            // Atomic replace can report delete/create after the final path exists again.
            kind = this.settled.has(path) || this.ledger.get(path) ? 'change' : kind === 'create' ? 'create' : 'change';
        } catch (error) {
            if (error.code !== 'ENOENT') return;
            kind = 'delete';
        }
        if (kind === 'delete' && !this.settled.has(path) && !this.ledger.get(path)) return;
        this.pruneMarks(Date.now());
        const own = this.selfMarks.get(path), save = this.saveMarks.get(path);
        // Shield only the exact saved content, not all subsequent writes for 2s.
        if (this.activeTransactions?.has(reviewPathKey(path))) return;
        if ((own && own.text === after) || (save && save.text === after)) return;
        // An external filesystem event is not an AI tool transaction. Do not
        // create/extend AI entries even when a DeepSeek terminal is running.
        const existing = this.ledger.get(path);
        if (existing) {
            if (after !== existing.after) this.observeUserText(path, after);
        } else if (after === null) this.settled.delete(path);
        else this.settled.set(path, after);
        const inventory = this.directoryInventory.get(node_path_1.dirname(path));
        if (after === null) inventory?.delete(node_path_1.basename(path));
        else inventory?.add(node_path_1.basename(path));
    }
    scheduleFsRetry(uri) {
        if (!this.fsRetries) this.fsRetries = new Map();
        const path = uri.fsPath;
        if (this.fsRetries.has(path)) return;
        const timer = setTimeout(() => {
            this.fsRetries.delete(path);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path && !d.isClosed);
            if (!this.disposed && !doc?.isDirty) void this.onFsEvent(uri, 'change');
        }, 250);
        this.fsRetries.set(path, timer);
    }
    beginVerifiedTransaction(operation) {
        if (!this.activeTransactions) this.activeTransactions = new Map();
        this.activeTransactions.set(reviewPathKey(operation.path), operation);
        const existing = this.ledger.get(operation.path);
        const beforeMissing = existing ? existing.beforeMissing : false;
        const before = existing ? existing.before : operation.before;
        if (existing && (existing.userTouched || existing.after !== operation.before)) {
            existing.userTouched = true;
            existing.conflict ??= 'transaction-before-mismatch';
            this.ledger.emit();
            return false;
        }
        if (!this.verifiedBegins) this.verifiedBegins = new Map();
        this.verifiedBegins.set(reviewPathKey(operation.path), { ...operation, before, beforeMissing, previouslyPending: !!existing });
        return true;
    }
    endVerifiedTransaction(operation) {
        this.activeTransactions?.delete(reviewPathKey(operation.path));
        const begin = this.verifiedBegins?.get(reviewPathKey(operation.path));
        this.verifiedBegins?.delete(reviewPathKey(operation.path));
        if (!begin) return null;
        if (begin.before === operation.after) {
            this.ledger.remove(operation.path);
            this.settled.set(operation.path, operation.after);
            return null;
        }
        // A new verified edit must not relabel an older unverified span.
        const entry = this.ledger.record(operation.path, operation.before === null ? 'create' : 'modify', begin.before, begin.beforeMissing, operation.after, 'file-tool-v1');
        if (entry && entry.provenance === 'file-tool-v1') { entry.userTouched = false; delete entry.conflict; this.ledger.emit(); }
        if (entry && !begin.previouslyPending && vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.autoShowDiff', true)) {
            void this.showDiff(operation.path, true)?.catch(error => console.error('[dsh-tui-vscode] Cannot open review:', error));
        }
        if (operation.after === null) this.settled.delete(operation.path); else this.settled.set(operation.path, operation.after);
        return entry;
    }
    cancelVerifiedTransaction(operation) { this.activeTransactions?.delete(reviewPathKey(operation.path)); this.verifiedBegins?.delete(reviewPathKey(operation.path)); }
    // ---- persistence (pending state survives a window reload) --------------
    storeFile() {
        const base = this.context.storageUri;
        return base ? node_path_1.join(base.fsPath, 'edit-review-pending.json') : null;
    }
    schedulePersist() {
        if (this.closing || this.disposed) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.flushState().catch(() => {}); }, PERSIST_DEBOUNCE_MS);
    }
    flushState() {
        const file = this.storeFile();
        if (!file) return Promise.resolve();
        const state = JSON.stringify(this.ledger.toJSON());
        const next = this.persistence.then(async () => {
            await fsp.mkdir(node_path_1.dirname(file), { recursive: true });
            const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
            try {
                await fsp.writeFile(temp, state, 'utf8');
                await fsp.rename(temp, file);
            } finally { await fsp.unlink(temp).catch(() => {}); }
        });
        this.persistence = next.catch(error => console.error('[dsh-tui-vscode] Review storage failed:', error));
        return next;
    }
    async loadState() {
        const file = this.storeFile();
        if (!file)
            return;
        try {
            let contents;
            try { contents = await fsp.readFile(file, 'utf8'); }
            catch (error) {
                if (error.code !== 'ENOENT' || !this.context.globalStorageUri) throw error;
                contents = await fsp.readFile(node_path_1.join(this.context.globalStorageUri.fsPath, 'edit-review-pending.json'), 'utf8');
            }
            const raw = JSON.parse(contents);
            this.ledger.load(raw);
            // Drop noise captured by older builds (temp names, binary blobs):
            // unreviewable by design, and their payloads bloat the ledger.
            for (const e of this.ledger.list()) {
                if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(e.path)) || this.excluded(e.path)
                    || (e.after ?? '').length > MAX_FILE_BYTES || (e.before ?? '').length > MAX_FILE_BYTES
                    || TEMP_NAME_RE.test(node_path_1.basename(e.path))
                    || (e.after ?? '').includes('\u0000')
                    || (e.before ?? '').includes('\u0000'))
                    this.ledger.remove(e.path);
            }
            this.refreshAll();
        }
        catch {
            // no previous state (or unreadable): start clean
        }
    }
    // ---- UI refresh --------------------------------------------------------
    refreshAll() {
        if (this.disposed)
            return;
        for (const editor of vscode.window.visibleTextEditors)
            this.decorateEditor(editor);
        const active = vscode.window.activeTextEditor;
        const path = active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath : null;
        void vscode.commands.executeCommand('setContext', 'dshEditReview.activePending', !!(path && !this.nativeReview?.owns(path) && this.ledger.get(path)));
        const entries = this.entries();
        void vscode.commands.executeCommand('setContext', 'dshEditReview.hasPending', entries.length > 0);
        if (entries.length) { this.pendingStatus.text = `$(diff) dsh: ${entries.length} pending`; this.pendingStatus.show(); }
        else this.pendingStatus.hide();
    }
    isDiffEditor(editor) {
        if (typeof vscode.TabInputTextDiff !== 'function') return false;
        return (vscode.window.tabGroups?.all ?? []).some(group =>
            group.viewColumn === editor.viewColumn && group.activeTab?.input instanceof vscode.TabInputTextDiff
            && group.activeTab.input.modified.toString() === editor.document.uri.toString());
    }
    decorateEditor(editor) {
        if (!editor || editor.document.uri.scheme !== 'file') {
            return;
        }
        const entry = this.ledger.get(editor.document.uri.fsPath);
        const empty = [];
        if (this.isDiffEditor(editor) || !this.reviewSnapshot(entry, editor.document) || this.nativeReview?.owns(editor.document.uri.fsPath)) {
            editor.setDecorations(this.decor.added, empty);
            editor.setDecorations(this.decor.insSpan, empty);
            editor.setDecorations(this.decor.ghost, empty);
            editor.setDecorations(this.decor.removed, empty);
            return;
        }
        const { hunks } = precise.reviewDiff(entry.before ?? '', entry.after);
        const added = [];
        const insSpan = [];
        const ghost = [];
        const removed = [];
        const maxLine = Math.max(editor.document.lineCount - 1, 0);
        for (const h of hunks.slice(0, MAX_DECORATED_HUNKS)) {
            const hover = this.hunkHover(entry, h);
            if (h.kind === 'removed') {
                // Pure deletion: red margin bar on the gap anchor + the gone
                // lines as a red strikethrough ghost. Bar and ghost are
                // SEPARATE entries on a 1-char-wide range — an empty range or
                // one bad attachment must never cancel the other signal.
                const anchor = Math.max(0, Math.min(h.startLine, maxLine));
                const anchorRange = new vscode.Range(anchor, 0, anchor, 1);
                removed.push({ range: anchorRange, hoverMessage: hover });
                ghost.push(deletedTextDecoration(anchorRange, this.ghostText(h.removedTexts)));
                continue;
            }
            // Inserted / rewritten lines — element-level marks:
            // whole-line green (line-insert) on every live line; for a rewrite
            // the CHANGED ELEMENTS get the stronger green (char-insert) and the
            // replaced elements ride along as red strikethrough ghosts AT THEIR
            // ORIGINAL POSITION. Element-level, not per-character: a small edit
            // inside a word highlights the whole word (git-diff-like), never a
            // single-character shard (`holds` -> `s`, `VA1-3` -> `-3`).
            const start = Math.max(0, Math.min(h.startLine, maxLine));
            const count = Math.max(h.lineCount, 1);
            // Line counts often differ (a delete inside a rewritten block).
            // Align by content so each old line pairs with the line it really
            // became; leftovers render as their own struck/inserted text.
            const alignment = (0, edit_review_core_1.pairLines)(h.removedTexts, h.addedTexts);
            const oldIndexByNew = new Map(alignment.pairs.map(p => [p.newIndex, p.oldIndex]));
            for (let j = 0; j < count; j++) {
                const line = Math.min(start + j, maxLine);
                added.push({ range: new vscode.Range(line, 0, line, 0), hoverMessage: hover });
                const oldIndex = oldIndexByNew.get(j);
                if (oldIndex !== undefined) {
                    const oldLine = h.removedTexts[oldIndex];
                    const newLine = h.addedTexts[j] ?? '';
                    // One ghost entry per anchor column: several old fragments
                    // attaching to the same spot must read as one red strike
                    // string in original order, not as overlapping piles
                    // (attachment order at equal positions is not controllable).
                    const ghostsByAnchor = new Map();
                    for (const e of (0, edit_review_core_1.elementChanges)(oldLine, newLine)) {
                        const colStart = Math.max(0, Math.min(e.nStart, newLine.length));
                        const colEnd = Math.max(colStart, Math.min(e.nEnd, newLine.length));
                        if (colEnd > colStart)
                            insSpan.push({ range: new vscode.Range(line, colStart, line, colEnd), hoverMessage: hover });
                        if (e.oEnd > e.oStart) {
                            const entry = ghostsByAnchor.get(colStart) ?? { end: colEnd, texts: [] };
                            entry.end = Math.max(entry.end, colEnd, colStart + 1);
                            entry.texts.push({ at: e.oStart, text: oldLine.slice(e.oStart, e.oEnd) });
                            ghostsByAnchor.set(colStart, entry);
                        }
                    }
                    for (const [colStart, entry] of [...ghostsByAnchor].sort((a, b) => a[0] - b[0])) {
                        entry.texts.sort((a, b) => a.at - b.at);
                        // A space keeps the struck old text from fusing with the
                        // live text that starts exactly at the anchor column.
                        const glued = colStart < newLine.length && newLine[colStart] !== ' ';
                        ghost.push(deletedTextDecoration(
                            new vscode.Range(line, colStart, line, entry.end),
                            this.ghostText([joinGhostParts(entry.texts.map(t => t.text)) + (glued ? ' ' : '')]),
                        ));
                    }
                }
            }
            if (alignment.unpairedOld.length) {
                const line = Math.min(start + Math.max(count - 1, 0), maxLine);
                ghost.push(deletedTextDecoration(
                    new vscode.Range(line, 0, line, 1), this.ghostText(alignment.unpairedOld.map(i => h.removedTexts[i])),
                ));
            }
        }
        this.setSafe(editor, this.decor.added, added);
        this.setSafe(editor, this.decor.insSpan, insSpan);
        this.setSafe(editor, this.decor.ghost, ghost);
        this.setSafe(editor, this.decor.removed, removed);
    }
    /** One bad decoration batch must never take the others down with it. */
    setSafe(editor, type, opts) {
        try {
            editor.setDecorations(type, opts);
        }
        catch (err) {
            console.error('[dsh-tui-vscode] edit-review decoration batch skipped:', err);
        }
    }
    /** Short red preview only; the native diff/editor shows full old lines. */
    ghostText(texts) {
        const joined = texts.join(GHOST_SEP);
        return {
            contentText: joined.length > GHOST_MAX_CHARS
                ? joined.slice(0, GHOST_MAX_CHARS - 1) + '\u2026'
                : joined,
            // Minimal, validator-safe styling — exactly the two properties the
            // style whitelist inside VS Code core accepts for attachments
            // (color + text-decoration; `text-decoration` must be the bare
            // `line-through`). Red TEXT on purpose: it is the one red signal
            // that cannot silently vanish the way an attachment background can.
            color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
            textDecoration: 'line-through',
        };
    }
    hunkHover(entry, h) {
        const ms = new vscode.MarkdownString();
        ms.isTrusted = { enabledCommands: TRUSTED_CMDS };
        const hint = precise.changeHint(entry, h);
        const source = entry.provenance === 'file-tool-v1' ? 'AI edit pending: {0}' : 'Source-unverified change: {0}';
        ms.appendMarkdown(`**${vscode.l10n.t(source, (0, edit_review_core_1.formatCounts)(h.added, h.removed))}**\n\n`);
        // Per-edit decisions — Copilot's hover flow: this change can be kept
        // or undone "without affecting other edits in the file".
        ms.appendMarkdown(`${cmdLink(KEEP_CMD, entry.path, vscode.l10n.t('Keep this change'), hint)} \u00b7 `
            + `${cmdLink(UNDO_CMD, entry.path, vscode.l10n.t('Undo this change'), hint)} \u00b7 `
            + `${cmdLink(DIFF_CMD, entry.path, vscode.l10n.t('Compare with original'))}`);
        // The hover is a readable old-text preview, not a view zone. Full
        // deleted lines are available through Compare with original.
        if (h.removedTexts.length > 0) {
            ms.appendMarkdown('\n\n');
            ms.appendText(h.removedTexts.join(' ⏎ ').slice(0, 160));
        }
        return ms;
    }
    // ---- original-image provider & comparison ------------------------------
    provideOriginalContent(uri) {
        try {
            const params = new URLSearchParams(uri.query);
            const path = params.get('f') ?? '';
            const side = params.get('side') ?? 'before';
            const entry = this.ledger.get(path);
            if (side === 'after')
                return entry?.after ?? '';
            return entry?.before ?? '';
        }
        catch {
            return '';
        }
    }
    showDiff(path, preserveFocus = false) {
        if (path && this.nativeReview?.owns(path)) return this.nativeReview.showReview(vscode.Uri.file(path));
        const entry = path ? this.ledger.get(path) : null;
        if (!path || !entry) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        if (entry.beforeMissing) return this.warn("Cannot compare: the pre-edit original was not captured.");
        const q = `f=${encodeURIComponent(path)}`;
        const left = vscode.Uri.parse(`${SCHEME}:original?side=before&${q}`);
        // Right side is the real file when it still exists (so the review tab
        // shows live content); for a deleted file both sides go virtual.
        const right = (0, node_fs_1.existsSync)(path)
            ? vscode.Uri.file(path)
            : vscode.Uri.parse(`${SCHEME}:original?side=after&${q}`);
        const name = node_path_1.basename(path);
        return vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t('Original \u2194 AI edit: {0}', name), { preview: true, preserveFocus })
            .then(() => this.alignDiffView(right));
    }
    /**
     * Review comparisons should LOOK like the VS Code diff the user asked for:
     * stacked red/green rows (inline view). `vscode.diff` cannot take a view
     * mode, so right after opening we align VS Code's own diff view mode with
     * the `diffEditor.setViewMode.*` command — the exact command behind the
     * diff editor's Inline View button. Delayed a beat so the editor exists.
     */
    alignDiffView(modified) {
        const mode = vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.diffView', 'inline');
        if (mode !== 'inline' && mode !== 'sideBySide')
            return;
        setTimeout(() => {
            if (this.disposed || this.closing)
                return;
            try {
                const config = vscode.workspace.getConfiguration('diffEditor', modified);
                const current = config.get('renderSideBySide', true);
                const spaceLimited = config.get('useInlineViewWhenSpaceIsLimited', true);
                const settled = mode === 'inline' ? current === false : current === true && spaceLimited === false;
                if (settled)
                    return;
                const command = mode === 'inline' ? 'diffEditor.setViewMode.inline' : 'diffEditor.setViewMode.sideBySide';
                void Promise.resolve(vscode.commands.executeCommand(command, modified)).catch(() => { });
            }
            catch {
                // Older hosts may not expose the diff view-mode commands; the
                // comparison still opens with VS Code's own default layout.
            }
        }, 350);
    }
    // ---- Keep / Undo -------------------------------------------------------
    resolvePath(target) {
        if (typeof target === 'string')
            return target;
        if (target instanceof vscode.Uri)
            return target.fsPath;
        if (target && typeof target === 'object') {
            if (typeof target.path === 'string' && !target.scheme)
                return target.path;
            if (target.resourceUri instanceof vscode.Uri)
                return target.resourceUri.fsPath;
        }
        const active = vscode.window.activeTextEditor;
        return active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath : null;
    }
    async assertSafePath(path) {
        const uri = vscode.Uri.file(path);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || this.excluded(path)) throw Error('Review is restricted to workspace text files.');
        const root = await fsp.realpath(folder.uri.fsPath);
        const parent = await fsp.realpath(node_path_1.dirname(path));
        const relative = node_path_1.relative(root, parent);
        if (relative === '..' || relative.startsWith('..' + node_path_1.sep) || node_path_1.isAbsolute(relative)) throw Error('Review cannot follow a directory link outside the workspace.');
        try { if ((await fsp.lstat(path)).isSymbolicLink()) throw Error('Review cannot restore through a symbolic link.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    async writeContent(path, text, expected) {
        if (expected !== undefined) await this.assertSafePath(path);
        this.writingPaths?.add(path);
        try { return await this.writeContentNow(path, text, expected); }
        finally { this.writingPaths?.delete(path); }
    }
    async writeContentNow(path, text, expected) {
        this.selfMarks.set(path, { expires: Date.now() + MARK_TTL_MS, text });
        const uri = vscode.Uri.file(path);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
        if (expected !== undefined && expected !== null) {
            const disk = await fsp.readFile(path, 'utf8');
            if (disk !== expected || (doc && (doc.isDirty || doc.getText() !== expected))) throw Error('File changed during review. No restoration was applied.');
        }
        if (expected === null) {
            await fsp.writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
            if (!doc || doc.isClosed) { this.settled.set(path, text); return; }
        }
        if (doc && !doc.isClosed) {
            const lastLine = Math.max(doc.lineCount - 1, 0);
            const lastCol = doc.lineAt(lastLine).text.length;
            const we = new vscode.WorkspaceEdit();
            we.replace(uri, new vscode.Range(0, 0, lastLine, lastCol), text);
            if (!await vscode.workspace.applyEdit(we))
                throw new Error('VS Code refused the edit; pending review was retained.');
            if (!await doc.save())
                throw new Error('The restored content could not be saved; pending review was retained.');
        }
        else {
            await fsp.writeFile(path, text, { encoding: 'utf8', flag: 'w' });
        }
        const actual = await fsp.readFile(path, 'utf8');
        if (actual !== text || (doc && doc.getText() !== text)) {
            const entry = this.ledger.get(path);
            if (entry) {
                entry.userTouched = true;
                entry.conflict = 'save-participant';
                this.ledger.setAfter(path, actual);
            }
            throw Error('Saving changed the file (possibly a save participant). Exact Undo did not complete; the original was retained and the current file requires review.');
        }
        this.settled.set(path, text);
    }
    async applyPlan(entry, action, expected) {
        const path = entry.path;
        if (action === 'restore-content') {
            await this.writeContent(path, entry.before ?? '', expected);
        }
        else if (action === 'restore-file') {
            await this.writeContent(path, entry.before ?? '', expected);
        }
        else if (action === 'delete-file') {
            await this.assertSafePath(path);
            this.selfMarks.set(path, { expires: Date.now() + MARK_TTL_MS, text: null });
            if (expected !== undefined && await fsp.readFile(path, 'utf8') !== expected) throw Error('File changed during review. Deletion was refused.');
            await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
            this.settled.delete(path);
        }
        this.ledger.remove(path);
        vscode.window.setStatusBarMessage(vscode.l10n.t('Undid {0}: restored the pre-edit original', node_path_1.basename(path)), 4000);
    }
    // ---- per-edit Keep / Undo (Copilot: "without affecting other edits") -----
    async readCurrent(path) {
        this.directoryInventory?.get(node_path_1.dirname(path))?.add(node_path_1.basename(path));
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path);
        if (doc && !doc.isClosed)
            return doc.getText();
        try {
            return await fsp.readFile(path, 'utf8');
        }
        catch {
            return '';
        }
    }
    warn(message) {
        // Informational refusal is complete; a non-modal notification must not
        // hold the per-path decision/watcher queue until it is dismissed.
        void vscode.window.showWarningMessage(message);
    }
    staleWarning() {
        return this.warn('This control refers to an earlier review snapshot. Use the current AI Edits controls. If user edits overlap the change, save them and choose Keep current file or explicitly confirmed Undo file; no change was applied.');
    }
    bomUnsupported(entry, current) {
        // TextDocument omits the encoding BOM. Until it is tracked separately,
        // never feed a disk preamble through WorkspaceEdit or recreate it.
        return [entry?.before, entry?.after, current].some(text => typeof text === 'string' && text.startsWith('\uFEFF'));
    }
    async safeCurrent(entry) {
        if (this.bomUnsupported(entry) || entry.conflict === 'save-participant' || this.activeTransactions?.has(reviewPathKey(entry.path))) return null;
        try { await this.assertSafePath(entry.path); } catch { return null; }
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === entry.path && !d.isClosed);
        if (doc?.isDirty) return null;
        try {
            const disk = await fsp.readFile(entry.path, 'utf8');
            if (this.ledger.get(entry.path) !== entry || disk !== entry.after || (doc && doc.getText() !== disk)) return null;
            if (entry.userTouched) { entry.userTouched = false; delete entry.conflict; }
            return disk;
        } catch { return null; }
    }
    async decideLine(undo) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') return;
        const path = editor.document.uri.fsPath;
        if (this.nativeReview?.owns(path)) return this.nativeReview.showReview(editor.document.uri);
        const entry = this.ledger.get(path);
        if (!entry || entry.beforeMissing || entry.kind === 'delete') return;
        const current = await this.safeCurrent(entry);
        if (current === null) return this.staleWarning();
        const line = editor.selection.active.line;
        const changes = precise.reviewDiff(entry.before ?? '', current, true).hunks.filter(h => h.startLine === line);
        let h = changes[0];
        if (changes.length > 1) {
            const selected = await vscode.window.showQuickPick(changes.map((h, i) => ({ label: `${i + 1}: ${h.removedTexts[0] ?? '(insertion)'} → ${h.addedTexts[0] ?? '(deletion)'}`, h })), { title: 'Choose the individual line change' });
            h = selected?.h;
        }
        if (!h) return vscode.window.showInformationMessage('No pending line change at the cursor. For deleted lines choose their surviving-line anchor.');
        const hint = precise.changeHint(entry, h, true);
        return this.withPath(path, () => undo ? this.undoHunk(path, hint) : this.keepHunk(path, hint));
    }
    async keepHunk(path, hint) {
        const entry = this.ledger.get(path);
        if (!entry || entry.beforeMissing) return this.staleWarning();
        const current = await this.safeCurrent(entry);
        const h = current === null ? null : precise.resolveChange(entry, current, hint);
        if (!h) return this.staleWarning();
        const before = precise.keepChange(entry.before ?? '', h);
        this.ledger.rebaseBefore(path, before);
        if (before === current) { this.ledger.keep(path); this.settled.set(path, current); }
        this.bar?.refresh();
        vscode.window.setStatusBarMessage(vscode.l10n.t('Kept this change in {0}', node_path_1.basename(path)), 3000);
    }
    async undoHunk(path, hint) {
        const entry = this.ledger.get(path);
        if (!entry || entry.beforeMissing) return this.staleWarning();
        const current = await this.safeCurrent(entry);
        const h = current === null ? null : precise.resolveChange(entry, current, hint);
        if (!h) return this.staleWarning();
        const fixed = precise.undoChange(current, h);
        try { await this.writeContent(path, fixed, current); }
        catch (error) { return this.warn(error.message); }
        this.ledger.setAfter(path, fixed);
        if (entry.kind !== 'create' && entry.before === fixed) this.ledger.remove(path);
        this.bar?.refresh();
        vscode.window.setStatusBarMessage(vscode.l10n.t('Undid this change in {0}', node_path_1.basename(path)), 3000);
    }
    /** Review-bar navigation: jump between pending edits (overlay ▲▼). */
    async gotoHunk(path, dir) {
        const entry = path ? this.ledger.get(path) : null;
        if (!path || !entry)
            return;
        const text = await this.readCurrent(path);
        const { hunks } = precise.reviewDiff(entry.before ?? '', text);
        if (hunks.length === 0)
            return;
        const cur = this.cursor.get(path) ?? 0;
        const next = (((cur + dir) % hunks.length) + hunks.length) % hunks.length;
        this.cursor.set(path, next);
        this.bar?.refresh();
        const target = hunks[next];
        let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === path);
        if (!editor)
            editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
        const line = Math.max(0, Math.min(target.startLine, Math.max(editor.document.lineCount - 1, 0)));
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    fileHint(entry) { return { file: true, id: entry.id, beforeHash: precise.digest(entry.before), afterHash: precise.digest(entry.after) }; }
    matchesFileHint(path, hint) {
        const entry = this.ledger.get(path);
        return entry && entry.id === hint.id && precise.digest(entry.before) === hint.beforeHash && precise.digest(entry.after) === hint.afterHash;
    }
    async keep(target, hint) {
        const path = this.resolvePath(target);
        if (path && this.activeTransactions?.has(reviewPathKey(path))) return this.warn('AI tool edit is still running. Review becomes available when the tool finishes.');
        if (path && this.nativeReview?.owns(path)) return this.nativeReview.showReview(vscode.Uri.file(path));
        if (!path || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) return;
        const fileHint = hint?.file ? hint : target?.reviewHint;
        if (fileHint) {
            if (!this.matchesFileHint(path, fileHint)) return this.staleWarning();
            hint = undefined;
        }
        if (path && hint)
            return this.keepHunk(path, hint);
        const entry = path ? this.ledger.get(path) : null;
        if (!entry) { void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file')); return; }
        const beforeHash = precise.digest(entry.before), afterHash = precise.digest(entry.after);
        let current = null;
        try { current = await fsp.readFile(path, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') return this.warn(error.message); }
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path && !d.isClosed);
        // Keep never writes. Only here a disk BOM may be compared with the
        // model's logical text, not inserted into an editor or restored.
        const modelMatches = !doc || current !== null && (doc.getText() === current || current.startsWith('\uFEFF') && doc.getText() === current.slice(1));
        if (doc?.isDirty || !modelMatches) return this.warn('Save or resolve editor changes before Keep. The pending review was retained.');
        if (this.ledger.get(path) !== entry || precise.digest(entry.before) !== beforeHash || precise.digest(entry.after) !== afterHash) return this.staleWarning();
        // Whole-file Keep never writes. A conflicted (paused) review accepts the
        // current file as-is, so later/overlapping edits must not block it.
        if (!entry.userTouched && current !== entry.after) return this.staleWarning();
        this.ledger.keep(path);
        if (current === null) this.settled.delete(path);
        else this.settled.set(path, current);
        vscode.window.setStatusBarMessage(vscode.l10n.t('Kept {0}', node_path_1.basename(path)), 3000);
    }
    async undo(target, hint) {
        const path = this.resolvePath(target);
        if (path && this.activeTransactions?.has(reviewPathKey(path))) return this.warn('AI tool edit is still running. Review becomes available when the tool finishes.');
        if (path && this.nativeReview?.owns(path)) return this.nativeReview.showReview(vscode.Uri.file(path));
        if (!path || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) return;
        const fileHint = hint?.file ? hint : target?.reviewHint;
        if (fileHint) {
            if (!this.matchesFileHint(path, fileHint)) return this.staleWarning();
            hint = undefined;
        }
        if (path && hint)
            return this.undoHunk(path, hint);
        const entry = path ? this.ledger.get(path) : null;
        if (!path || !entry) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        let currentExists = false;
        let currentText = null;
        try {
            currentText = await fsp.readFile(path, 'utf8');
            currentExists = true;
        }
        catch (error) {
            if (error.code !== 'ENOENT') return this.warn(error.message);
            currentExists = false;
        }
        if (this.bomUnsupported(entry, currentText)) return this.warn('Undo for UTF-8 BOM files is not supported yet. No restoration was applied; use version control.');
        // A conflicted review goes to the confirmation prompt below instead of
        // the misleading "out of date" warning (the modal guards the restore).
        if (fileHint && !entry.userTouched && currentText !== entry.after) return this.staleWarning();
        const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path && !d.isClosed);
        if (doc?.isDirty || (doc && currentExists && doc.getText() !== currentText)) {
            return this.warn('Save or resolve your editor changes before Undo. No user edits were overwritten.');
        }
        const expectedAfter = entry.after, expectedBefore = entry.before;
        const plan = (0, edit_review_core_1.planUndo)(entry, currentExists, currentText);
        if (plan.action === 'drop') { this.ledger.remove(path); return; }
        if (plan.action === 'blocked') return this.warn('The pre-edit original was not captured; Undo is unavailable. Use version control.');
        const action = plan.action === 'confirm' ? plan.fallback : plan.action;
        if (plan.action === 'confirm' || action === 'delete-file') {
            const label = 'Confirm Undo';
            const message = action === 'delete-file' ? 'Undo removes this newly created file (using the recycle bin when supported). Continue?' : 'The file changed after the captured edit. Restore the original and discard later disk changes?';
            if (await vscode.window.showWarningMessage(message, { modal: true }, label) !== label) return;
        }
        if (this.ledger.get(path) !== entry || entry.after !== expectedAfter || entry.before !== expectedBefore) return this.staleWarning();
        let latest = null;
        try { latest = await fsp.readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') return this.warn(error.message); }
        if (latest !== currentText || doc?.isDirty) return this.staleWarning();
        try { await this.applyPlan(entry, action, currentText); }
        catch (error) { return this.warn(error.message); }
    }
    async keepAll() {
        const paths = this.entries().map((e) => e.path);
        if (paths.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        for (const p of paths)
            await this.withPath(p, () => this.keep(p));
    }
    async undoAll() {
        const paths = this.entries().map((e) => e.path);
        if (paths.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        for (const p of paths)
            await this.withPath(p, () => this.undo(p));
    }
    // ---- tree --------------------------------------------------------------
    entries() {
        return this.ledger.list().filter(entry => !this.nativeReview?.owns(entry.path) && !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.path)));
    }
    describe(entry) {
        if (entry.beforeMissing)
            return vscode.l10n.t('original not captured');
        const { addedLines, removedLines } = precise.reviewDiff(entry.before ?? '', entry.after ?? '');
        const warning = this.bomUnsupported(entry) ? ' · BOM: Undo unavailable' : entry.userTouched ? ' · overlapping/later edits: resolve first' : '';
        const provenance = entry.provenance === 'file-tool-v1' ? '' : ' · source unverified';
        const kind = entry.kind === 'create' ? ` ${vscode.l10n.t('new')}` : entry.kind === 'delete' ? ` ${vscode.l10n.t('deleted')}` : '';
        return `${(0, edit_review_core_1.formatCounts)(addedLines, removedLines)}${kind}${warning}${provenance}`;
    }
}
exports.EditReview = EditReview;
/** Sidebar tree: one row per pending file, click = compare with original. */
class PendingTreeProvider {
    constructor(owner) {
        this.owner = owner;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        owner.ledger.onChange(() => this.emitter.fire());
    }
    getTreeItem(entry) {
        const item = new vscode.TreeItem(node_path_1.basename(entry.path));
        item.id = entry.path;
        item.description = this.owner.describe(entry);
        item.tooltip = `${entry.path}\n${this.owner.describe(entry)}`;
        item.contextValue = 'dshEdit';
        item.iconPath = new vscode.ThemeIcon(entry.kind === 'create' ? 'new-file' : entry.kind === 'delete' ? 'trash' : 'edit');
        item.command = { command: DIFF_CMD, title: '', arguments: [entry.path] };
        return item;
    }
    getChildren() {
        return this.owner.entries().map(entry => ({ ...entry, reviewHint: this.owner.fileHint(entry) }));
    }
    dispose() {
        this.emitter.dispose();
    }
}
/**
 * The review bar — the plugin-level twin of Copilot's
 * `chat-editing-editor-overlay` (that floating widget is core-internal;
 * verified zero extension entry points, so it cannot be mounted from an
 * extension). Same shape and semantics: ▲▼ navigation across the edits of the
 * file + Keep / Undo for the CURRENT edit + file-level actions, docked as a
 * code-lens row on the first line.
 */
class ReviewBarProvider {
    constructor(owner) {
        this.owner = owner;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this.emitter.event;
        owner.ledger.onChange(() => this.emitter.fire());
    }
    refresh() {
        this.emitter.fire();
    }
    provideCodeLenses(doc) {
        const entry = this.owner.ledger.get(doc.uri.fsPath);
        if (!entry || this.owner.nativeReview?.owns(entry.path)) return [];
        if (!this.owner.reviewSnapshot(entry, doc)) {
            if (!entry)
                return [];
            const at = new vscode.Range(0, 0, 0, 0);
            const lenses = [new vscode.CodeLens(at, {
                title: entry.userTouched
                    ? vscode.l10n.t('Review paused: overlapping or later edits · Compare original')
                    : vscode.l10n.t('Review synchronizing · Compare original'),
                command: DIFF_CMD, arguments: [entry.path],
            })];
            // Whole-file Keep never writes: accepting the current file is the
            // safe way out of a review that later/overlapping edits paused.
            if (entry.userTouched)
                lenses.push(new vscode.CodeLens(at, {
                    title: `$(check) ${vscode.l10n.t('Keep (accept current file)')}`,
                    command: KEEP_CMD, arguments: [entry.path],
                }));
            return lenses;
        }
        const { hunks } = precise.reviewDiff(entry.before ?? '', entry.after);
        if (hunks.length === 0)
            return [];
        const path = entry.path;
        if (this.owner.nativeReview?.owns(path))
            return [];
        const cur = Math.min(this.owner.cursor.get(path) ?? 0, hunks.length - 1);
        this.owner.cursor.set(path, cur);
        const at = new vscode.Range(0, 0, 0, 0);
        const lens = (title, command, args, range = at) => new vscode.CodeLens(range, { title, command, arguments: args });
        const result = [
            lens('$(chevron-up)', PREV_CMD, [path]),
            lens('$(chevron-down)', NEXT_CMD, [path]),
            lens(`$(check-all) ${vscode.l10n.t('Keep')} file`, KEEP_CMD, [path, this.owner.fileHint(entry)]),
            lens(`$(undo) ${vscode.l10n.t('Undo')} file`, UNDO_CMD, [path, this.owner.fileHint(entry)]),
            lens(`$(compare) ${vscode.l10n.t('Compare with original')}`, DIFF_CMD, [path]),
        ];
        for (const [i, h] of hunks.slice(0, MAX_DECORATED_HUNKS).entries()) {
            const line = Math.max(0, Math.min(h.startLine, doc.lineCount - 1));
            const range = new vscode.Range(line, 0, line, 0);
            const hint = precise.changeHint(entry, h);
            result.push(lens(`${i + 1}/${hunks.length} · ${vscode.l10n.t('Keep this change')}`, KEEP_CMD, [path, hint], range),
                lens(vscode.l10n.t('Undo this change'), UNDO_CMD, [path, hint], range));
        }
        return result;
    }
    dispose() {
        this.emitter.dispose();
    }
}
