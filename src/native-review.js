'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const nodePath = require('node:path');
const OWNERSHIP_KEY = 'nativeReview.ownedPaths.v1';
const { NativeReviewSession } = require('./native-review-core');
const PARTICIPANT = 'dsh-tui-vscode.nativeReview';
const START = 'dsh-tui-vscode.nativeReviewStart';
const CURRENT = 'dsh-tui-vscode.nativeReviewCurrent';
const OPEN = 'dsh-tui-vscode.nativeReviewOpen';
const FINISH = 'dsh-tui-vscode.nativeReviewFinish';
const STATUS = 'dsh-tui-vscode.nativeReviewStatus';
const RELEASE = 'dsh-tui-vscode.nativeReviewRelease';
const RELEASE_CURRENT = 'dsh-tui-vscode.nativeReviewReleaseCurrent';
const SHOW = 'dsh-tui-vscode.nativeReviewShow';
class NativeReview {
    constructor(context, legacy) {
        this.legacy = legacy;
        this.session = new NativeReviewSession();
        this.workspaceState = context.workspaceState;
        this.persistence = Promise.resolve();
        this.epoch = 0;
        const restored = this.workspaceState?.get(OWNERSHIP_KEY, []);
        if (Array.isArray(restored)) {
            for (const path of restored.slice(0, 1000)) {
                if (typeof path !== 'string' || !nodePath.isAbsolute(path)) continue;
                if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) continue;
                this.session.owned.add(process.platform === 'win32' ? path.toLowerCase() : path);
            }
        }
        this.pending = null;
        this.disposed = false;
        this.lastEvidence = { participantRegistered: false, externalEditAvailable: null, snapshotReady: false };
        this.output = vscode.window.createOutputChannel('dsh-tui Native Review');
        context.subscriptions.push(this.output);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
        this.status.command = SHOW;
        this.status.tooltip = 'Show VS Code native Keep / Undo review controls';
        context.subscriptions.push(this.status);
        legacy.nativeReview = this;
        if (typeof vscode.chat?.createChatParticipant === 'function') {
            try {
                this.participant = vscode.chat.createChatParticipant(PARTICIPANT, (request, chatContext, response, token) => this.handle(request, response, token));
                this.participant.iconPath = new vscode.ThemeIcon('diff');
                context.subscriptions.push(this.participant);
                this.lastEvidence.participantRegistered = true;
            } catch (error) { this.log(error); }
        }
        context.subscriptions.push(
            vscode.commands.registerCommand(START, () => this.start()),
            vscode.commands.registerCommand(CURRENT, uri => this.startCurrent(uri)),
            vscode.commands.registerCommand(OPEN, () => this.startOpen()),
            vscode.commands.registerCommand(FINISH, () => this.finish()),
            vscode.commands.registerCommand(STATUS, () => this.showStatus()),
            vscode.commands.registerCommand(RELEASE, uri => this.releaseResolved(uri)),
            vscode.commands.registerCommand(RELEASE_CURRENT, uri => {
                const selected = uri?.scheme ? uri : vscode.window.activeTextEditor?.document.uri;
                if (!selected || !this.owns(selected.fsPath)) { void vscode.window.showWarningMessage('Open a native-tracked file first.'); return; }
                return this.releaseResolved(selected);
            }),
            vscode.commands.registerCommand(SHOW, uri => this.showReview(uri)),
            this
        );
        this.refreshStatus();
    }
    refreshStatus() {
        if (this.disposed) { this.status.hide(); return; }
        if (this.pending || this.session.active) {
            this.status.command = FINISH;
            this.status.text = this.lastEvidence.snapshotReady && this.session.active
                ? '$(checklist) Finish native review' : '$(sync~spin) Native review: starting';
            this.status.tooltip = 'External-edit callback started; this alone does not prove a native snapshot exists. Finish tracking before Keep / Undo. Do not manually edit selected files.';
            this.status.show();
        } else if (this.session.owned.size) {
            this.status.command = SHOW;
            this.status.text = `$(diff) Review tracked files (${this.session.owned.size})`;
            this.status.tooltip = 'Open VS Code native review. Tracked-file count does not mean unresolved-change count. After Keep / Undo and saving, return files to ordinary tracking explicitly.';
            this.status.show();
        } else this.status.hide();
    }
    async showReview(target) {
        if (this.disposed) return;
        const active = vscode.window.activeTextEditor?.document.uri;
        let uri = target?.scheme ? target : active;
        if (target?.scheme && (target.scheme !== 'file' || !this.owns(target.fsPath)))
            return vscode.window.showWarningMessage('This file is not managed by native review.');
        if (!uri || uri.scheme !== 'file' || !this.owns(uri.fsPath)) {
            const paths = [...this.session.owned];
            if (!paths.length) return vscode.window.showInformationMessage('No native-tracked files. Start tracking before asking dsh-tui to edit.');
            if (paths.length === 1) uri = vscode.Uri.file(paths[0]);
            else {
                const picked = await vscode.window.showQuickPick(paths.map(path => ({ label: nodePath.basename(path), description: path, path })), { title: 'Review a native-tracked file' });
                if (!picked) return;
                uri = vscode.Uri.file(picked.path);
            }
        }
        if (this.disposed || !this.owns(uri.fsPath)) return;
        try {
            await vscode.window.showTextDocument(uri, { preview: false });
            await vscode.commands.executeCommand('chatEditor.action.reviewChanges');
        } catch (error) {
            this.log(error);
            return vscode.window.showWarningMessage(`Native review controls could not open: ${error.message}. Ownership and file contents are unchanged.`);
        }
    }
    log(value) { this.output.appendLine(`[${new Date().toISOString()}] ${String(value?.stack ?? value)}`); }
    persistOwnership() {
        const paths = [...this.session.owned];
        if (!this.workspaceState) return Promise.resolve();
        const next = this.persistence.then(() => this.workspaceState.update(OWNERSHIP_KEY, paths));
        this.lastPersistence = next;
        this.persistence = next.catch(error => this.log(`Ownership persistence failed: ${error.message}`));
        return next;
    }
    owns(path) { return this.session.owns(path); }
    async validateResources(resources) {
        if (resources.length < 1 || resources.length > 100) throw Error('Please select 1–100 existing text files.');
        for (const uri of resources) {
            if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) throw Error('Only files in the current workspace can be reviewed.');
            if (this.legacy.excluded(uri.fsPath)) throw Error(`Excluded file: ${uri.fsPath}`);
            if (this.legacy.ledger.get(uri.fsPath)) throw Error(`Resolve the previous pending edit first: ${uri.fsPath}`);
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type !== vscode.FileType.File || stat.size > 256 * 1024) throw Error(`Not a small regular text file: ${uri.fsPath}`);
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc.isDirty) throw Error(`Save your own changes first: ${uri.fsPath}`);
            if (doc.getText().includes('\u0000')) throw Error(`Binary/UTF-16 file is not supported: ${uri.fsPath}`);
        }
    }
    async startCurrent(target) {
        const uri = target?.scheme ? target : vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== 'file')
            return vscode.window.showWarningMessage('Open an existing workspace file first.');
        return this.start([uri]);
    }
    async startOpen() {
        const unique = new Map();
        for (const group of vscode.window.tabGroups?.all ?? []) {
            for (const tab of group.tabs) {
                if (!(tab.input instanceof vscode.TabInputText)) continue;
                const uri = tab.input.uri;
                if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri) || this.legacy.excluded(uri.fsPath)) continue;
                const key = process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
                unique.set(key, uri);
            }
        }
        if (!unique.size) return vscode.window.showWarningMessage('Open the workspace text files you want to review first.');
        return this.start([...unique.values()]);
    }
    async start(selectedResources) {
        if (this.launching || this.releasing) return vscode.window.showInformationMessage('Native review is already starting, tracking, or returning files.');
        this.launching = true;
        try { return await this.startOnce(selectedResources); }
        finally { this.launching = false; }
    }
    async startOnce(selectedResources) {
        if (this.disposed) return;
        if (!this.participant) return vscode.window.showWarningMessage('Native review is unavailable: VS Code chat participant registration failed. Existing review remains unchanged.');
        if (this.pending || this.session.active) return vscode.window.showInformationMessage('Native review is already starting or tracking.');
        const epoch = this.epoch;
        const resources = selectedResources ?? await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'Track these files with native review' });
        if (!resources) return;
        const consent = await vscode.window.showWarningMessage('Experimental native tracking makes selected editors read-only until Finish. It observes all writes to these files, and Keep / Undo becomes available after Finish. Use the stable AI Edits view for automatic live review. Continue?', { modal: true }, 'Start native tracking');
        if (consent !== 'Start native tracking') return;
        try { await this.validateResources(resources); }
        catch (error) { return vscode.window.showWarningMessage(error.message); }
        if (this.disposed || epoch !== this.epoch || this.pending || this.session.active) return;
        this.lastEvidence.snapshotReady = false;
        delete this.lastEvidence.error;
        this.pending = { resources, nonce: crypto.randomUUID(), epoch };
        const nonce = this.pending.nonce;
        // No proposal flags, no model API call, no on-disk restoration/replay.
        this.launchTimer = setTimeout(() => {
            if (this.pending?.nonce !== nonce || this.session.active) return;
            this.pending = null;
            this.refreshStatus();
            this.log('Native review launch timed out before participant invocation.');
            void vscode.window.showWarningMessage('Native review did not start. Chat setup or the selected chat provider may be unavailable. No file was changed.');
        }, 20000);
        this.refreshStatus();
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'edit', query: `@dsh-review /track ${nonce}`, isPartialQuery: false,
            });
        } catch (error) {
            clearTimeout(this.launchTimer);
            this.pending = null;
            this.refreshStatus();
            this.log(error);
            void vscode.window.showWarningMessage(`Native review could not open: ${error.message}. No file was changed.`);
        }
    }
    /** One verified tool call, not the lifetime of a terminal. This awaits
     * the actual externalEdit callback before allowing the tool to write. */
    async beginOperation(operation) {
        if (!this.participant || this.disposed || this.pending || this.session.active || this.launching) return null;
        if (this.legacy.ledger.get(operation.path)) return null;
        let readyResolve, readyReject, doneResolve;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const done = new Promise(resolve => { doneResolve = resolve; });
        const pending = {
            resources: [vscode.Uri.file(operation.path)], nonce: crypto.randomUUID(), epoch: this.epoch,
            automatic: true, operation, readyResolve, readyReject, doneResolve, canceled: false, error: null,
        };
        this.pending = pending;
        const timer = setTimeout(() => {
            pending.canceled = true;
            if (this.pending === pending) this.pending = null;
            pending.readyReject(Error('Native snapshot unavailable before tool execution'));
            this.session.finish(); this.refreshStatus();
        }, 5000);
        try {
            if (pending.canceled) throw Error('Native operation canceled before request');
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'edit', query: `@dsh-review /track ${pending.nonce}`, isPartialQuery: false,
            });
            await ready;
            clearTimeout(timer);
            return {
                complete: async () => {
                    // Disk publication alone does not mean the editor model
                    // has observed it. End streaming only after that reload,
                    // otherwise a delayed reload becomes a non-AI/user edit.
                    const doc = await vscode.workspace.openTextDocument(pending.resources[0]);
                    const start = Date.now();
                    const expected = operation.after.replaceAll('\r\n', '\n');
                    while (this.legacy.documentSnapshot(doc).replaceAll('\r\n', '\n') !== expected) {
                        if (pending.canceled || pending.error || Date.now() - start > 5000) throw Error('Native editor did not synchronize the tool result');
                        await new Promise(resolve => setTimeout(resolve, 25));
                    }
                    // The public TextDocument event precedes the workbench's
                    // async file reload/diff observer. Keep the capture open
                    // for that observer to settle before ending the request.
                    await new Promise(resolve => setTimeout(resolve, 300));
                    this.session.finish(); await done; if (pending.error) throw Error(pending.error);
                },
                cancel: async () => { pending.canceled = true; this.session.finish(); await done; },
            };
        } catch (error) {
            clearTimeout(timer);
            if (this.pending === pending) this.pending = null;
            this.log(`Automatic native review unavailable: ${error.message}`);
            if (this.owns(operation.path)) throw error;
            return null;
        }
    }
    async handleAutomatic(pending, response, token) {
        let canceled = false;
        const subscription = token.onCancellationRequested(() => { canceled = true; this.session.finish(); });
        try {
            if (token.isCancellationRequested || pending.canceled || this.disposed || pending.epoch !== this.epoch) throw Error('Native request canceled');
            await this.legacy.assertSafePath(pending.operation.path);
            const doc = await vscode.workspace.openTextDocument(pending.resources[0]);
            if (doc.isDirty || this.legacy.documentSnapshot(doc) !== pending.operation.before) throw Error('Editor differs from prepared tool mutation');
            if (pending.canceled || this.disposed || pending.epoch !== this.epoch) throw Error('Native snapshot preparation expired');
            await this.session.run(response, pending.resources, async () => {
                if (pending.canceled) { this.session.finish(); throw Error('Native snapshot preparation expired'); }
                await this.persistOwnership();
                if (canceled || pending.canceled || this.disposed) { this.session.finish(); throw Error('Native snapshot canceled'); }
                this.lastEvidence.snapshotReady = true;
                this.legacy.refreshAll(); this.legacy.bar?.refresh();
                pending.readyResolve();
            });
            this.lastEvidence.automaticCompleted = true;
        } catch (error) {
            pending.error = error.message;
            pending.readyReject(error);
            this.lastEvidence.error = error.message;
            this.log(error);
        } finally {
            subscription.dispose();
            pending.doneResolve();
            this.refreshStatus(); this.legacy.refreshAll(); this.legacy.bar?.refresh();
        }
        return {};
    }
    async handle(request, response, token) {
        this.lastEvidence.externalEditAvailable = typeof response.externalEdit === 'function';
        const pending = this.pending;
        const epoch = pending?.epoch ?? this.epoch;
        if (!pending || request.command !== 'track' || request.prompt.trim() !== pending.nonce) {
            response.markdown('Use **dsh-tui: Start native file review (experimental)** from the command palette before asking dsh-tui to change selected files. This participant never calls a language model.');
            return {};
        }
        clearTimeout(this.launchTimer);
        this.pending = null;
        if (pending.automatic) return this.handleAutomatic(pending, response, token);
        this.lastEvidence.externalEditAvailable = typeof response.externalEdit === 'function';
        const cancellation = token.onCancellationRequested(() => this.session.finish());
        try {
            if (token.isCancellationRequested) return {};
            await this.validateResources(pending.resources);
            this.lastEvidence.snapshotReady = false;
            delete this.lastEvidence.error;
            if (token.isCancellationRequested || this.disposed || epoch !== this.epoch) return {};
            await this.session.run(response, pending.resources, async () => {
                await this.persistOwnership();
                if (token.isCancellationRequested || this.disposed || epoch !== this.epoch) { this.session.finish(); return; }
                this.lastEvidence.snapshotReady = true;
                this.legacy.refreshAll();
                this.legacy.bar?.refresh();
                this.refreshStatus();
                this.log(`Snapshot ready for ${pending.resources.length} files. Waiting for external changes; no baseline replay.`);
                response.markdown('VS Code has entered the external-edit callback. This signal alone does not verify native review state. Ask **dsh-tui in its existing terminal** to change the selected files, then click **Finish native review**. Selected editors can be read-only while tracking; complete native diff and Keep / Undo are available after Finish. No model is called by this participant.');
                this.status.tooltip = 'Native review ready. Ask dsh-tui to edit selected files, then click here to finish tracking.';
            });
            response.markdown('Tracking finished. Review the selected files using VS Code’s native review controls. If no native controls appear, this compatibility experiment has not passed visual verification.');
        } catch (error) {
            this.lastEvidence.error = error.message;
            this.log(error);
            response.markdown(`Native review is unavailable: ${error.message}. No file was restored or replayed. Existing pending edits remain untouched.`);
        } finally {
            cancellation.dispose();
            this.refreshStatus();
            this.legacy.refreshAll();
        }
        return {};
    }
    finish() {
        this.epoch++;
        clearTimeout(this.launchTimer);
        if (this.pending) {
            if (this.pending.automatic) { this.pending.canceled = true; this.pending.readyReject(Error('Native review finished before snapshot')); }
            this.pending = null;
            this.refreshStatus();
            return;
        }
        if (!this.session.finish()) void vscode.window.showInformationMessage('No active native tracking to finish.');
    }
    async releaseResolved(target) {
        if (this.disposed || this.releasing) return;
        if (this.launching || this.session.active || this.pending)
            return vscode.window.showWarningMessage('Finish native tracking first.');
        this.releasing = true;
        try { return await this.releaseResolvedOnce(target); }
        finally { this.releasing = false; this.refreshStatus(); }
    }
    async releaseResolvedOnce(target) {
        const epoch = this.epoch;
        const paths = target?.scheme === 'file'
            ? [...this.session.owned].filter(path => path === (process.platform === 'win32' ? target.fsPath.toLowerCase() : target.fsPath))
            : [...this.session.owned];
        if (!paths.length) { void vscode.window.showInformationMessage('No files owned by native review.'); return; }
        const confirmed = await vscode.window.showWarningMessage('Only continue after every selected native change has been kept or undone. This returns these files to ordinary tracking; it does not resolve native edits for you.', { modal: true }, 'All native changes resolved');
        if (confirmed !== 'All native changes resolved' || this.disposed || epoch !== this.epoch) return;
        const docs = [], missing = [];
        const isMissing = error => error?.code === 'ENOENT' || error?.code === 'FileNotFound';
        for (const path of paths) {
            try {
                if (vscode.workspace.fs?.stat) await vscode.workspace.fs.stat(vscode.Uri.file(path));
                docs.push(await vscode.workspace.openTextDocument(vscode.Uri.file(path)));
            }
            catch (error) {
                if (!isMissing(error)) { this.log(error); void vscode.window.showWarningMessage('Could not open every selected tracked file. Native ownership was retained.'); return; }
                // Confirm absence through the filesystem, not just editor state.
                try { await vscode.workspace.fs.stat(vscode.Uri.file(path)); return; }
                catch (statError) { if (!isMissing(statError)) { this.log(statError); return; } }
                const open = vscode.workspace.textDocuments?.find(doc => doc.uri.fsPath === path && !doc.isClosed);
                if (open?.isDirty) { void vscode.window.showWarningMessage('Save or resolve the missing file\'s editor buffer first. Native ownership was retained.'); return; }
                missing.push(path);
            }
        }
        if (this.disposed || epoch !== this.epoch || this.session.active || this.pending) return;
        if (docs.some(doc => doc.isDirty)) { void vscode.window.showWarningMessage('Save the resolved files first. Native ownership was retained.'); return; }
        if (missing.length) {
            const label = 'Stop protecting missing files';
            const answer = await vscode.window.showWarningMessage(`${missing.length} selected file(s) are missing. Native deletion review is unsupported. This stops native ownership without restoring files or resolving native edits. Continue?`, { modal: true }, label);
            if (answer !== label || this.disposed || epoch !== this.epoch) return;
            for (const path of missing) {
                try { await vscode.workspace.fs.stat(vscode.Uri.file(path)); void vscode.window.showWarningMessage('A missing file reappeared. Native ownership was retained; review again.'); return; }
                catch (error) { if (!isMissing(error)) { this.log(error); return; } }
            }
        }
        if (docs.some(doc => doc.isDirty) || this.disposed || epoch !== this.epoch) return;
        const previousOwned = new Set(this.session.owned);
        this.session.release(paths);
        try { await this.persistOwnership(); }
        catch (error) {
            this.session.owned = previousOwned;
            return vscode.window.showWarningMessage('Could not save review ownership. Native ownership was retained.');
        }
        for (const doc of docs) this.legacy.settled.set(doc.uri.fsPath, this.legacy.documentSnapshot?.(doc) ?? doc.getText());
        for (const path of missing) this.legacy.settled.delete(path);
        this.legacy.refreshAll();
        this.legacy.bar?.refresh();
        this.log(`Returned ${paths.length} resolved files to ordinary tracking.`);
    }
    showStatus() {
        this.log(JSON.stringify({ ...this.lastEvidence, active: this.session.active, ownedFiles: this.session.owned.size }));
        this.output.show(true);
    }
    shutdown() {
        this.dispose();
        return this.lastPersistence ?? this.persistence;
    }
    dispose() {
        if (this.disposed) return;
        this.epoch++;
        this.disposed = true;
        clearTimeout(this.launchTimer);
        if (this.pending?.automatic) { this.pending.canceled = true; this.pending.readyReject(Error('Native review disposed')); }
        this.pending = null;
        this.session.finish();
        this.status.hide();
    }
}
module.exports = { NativeReview };
