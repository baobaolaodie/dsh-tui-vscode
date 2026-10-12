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
            vscode.commands.registerCommand(RELEASE, () => this.releaseResolved()),
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
            this.pending = null;
            this.refreshStatus();
            return;
        }
        if (!this.session.finish()) void vscode.window.showInformationMessage('No active native tracking to finish.');
    }
    async releaseResolved() {
        if (this.disposed || this.releasing) return;
        if (this.launching || this.session.active || this.pending)
            return vscode.window.showWarningMessage('Finish native tracking first.');
        this.releasing = true;
        try { return await this.releaseResolvedOnce(); }
        finally { this.releasing = false; this.refreshStatus(); }
    }
    async releaseResolvedOnce() {
        const epoch = this.epoch;
        const paths = [...this.session.owned];
        if (!paths.length) return vscode.window.showInformationMessage('No files owned by native review.');
        const confirmed = await vscode.window.showWarningMessage('Only continue after every selected native change has been kept or undone. This returns these files to ordinary tracking; it does not resolve native edits for you.', { modal: true }, 'All native changes resolved');
        if (confirmed !== 'All native changes resolved' || this.disposed || epoch !== this.epoch) return;
        let docs;
        try { docs = await Promise.all(paths.map(path => vscode.workspace.openTextDocument(vscode.Uri.file(path)))); }
        catch (error) {
            this.log(error);
            return vscode.window.showWarningMessage('Could not open every tracked file. Native ownership was retained.');
        }
        if (this.disposed || epoch !== this.epoch || this.session.active || this.pending) return;
        if (docs.some(doc => doc.isDirty))
            return vscode.window.showWarningMessage('Save the resolved files first. Native ownership was retained.');
        const previousOwned = new Set(this.session.owned);
        this.session.release(paths);
        try { await this.persistOwnership(); }
        catch (error) {
            this.session.owned = previousOwned;
            return vscode.window.showWarningMessage('Could not save review ownership. Native ownership was retained.');
        }
        for (const doc of docs) this.legacy.settled.set(doc.uri.fsPath, doc.getText());
        this.legacy.refreshAll();
        this.legacy.bar?.refresh();
        this.log(`Returned ${paths.length} resolved files to ordinary tracking.`);
    }
    showStatus() {
        this.log(JSON.stringify({ ...this.lastEvidence, active: this.session.active, ownedFiles: this.session.owned.size }));
        this.output.show(true);
    }
    dispose() {
        this.epoch++;
        this.disposed = true;
        clearTimeout(this.launchTimer);
        this.pending = null;
        this.session.finish();
        this.status.hide();
    }
}
module.exports = { NativeReview };
