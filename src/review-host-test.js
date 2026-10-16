'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { changeHint, reviewDiff } = require('./precise-review-core');
async function waitFor(predicate, label) {
    const start = Date.now();
    while (!await predicate()) {
        if (Date.now() - start > 10000) throw Error(`Timeout: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
}
async function bounded(operation, label) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${label}`)), 5000); })]); }
    finally { clearTimeout(timer); }
}
const command = (id, ...args) => bounded(vscode.commands.executeCommand(id, ...args), id);
async function run() {
    const api = await vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode').activate();
    const review = api.getEditReviewTestBridge(), transactions = api.getEditTransactionsTestBridge();
    const owner = {}, root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await review.ready;
    const terminal = vscode.window.createTerminal({ name: 'DeepSeek' });
    review.trackTerminal(terminal);
    const result = { version: vscode.version, inferenceRequested: false, onlyFixtureFiles: true, status: 'running', checks: [] };
    const evidence = path.join(root, 'host-result.json');
    const checkpoint = label => { result.phase = label; syncFs.writeFileSync(evidence, JSON.stringify(result, null, 2)); console.log('REVIEW_HOST_PHASE', label); };
    let sequence = 0;
    const aiWrite = async (file, after) => {
        let before = null;
        try { before = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const uri = vscode.Uri.file(file), doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString() && !d.isClosed);
        if (doc && before !== null) await waitFor(() => review.documentSnapshot(doc) === before && !doc.isDirty, 'editor synchronized before next tool');
        const op = { operationId: `fixture-${++sequence}`, tool: 'write', path: file, before, after, identity: { callId: `tool-${sequence}`, sessionId: 'isolated' } };
        const ack = await transactions.begin(owner, op);
        assert.equal(ack.mode, 'stable');
        await fs.writeFile(file, after, 'utf8');
        await transactions.end(owner, { ...op, ticket: ack.ticket, success: true });
        if (doc) await waitFor(() => review.documentSnapshot(doc) === after, 'editor synchronized after tool');
        return review.ledger.get(file);
    };
    const lensesFor = async uri => {
        let lenses;
        await waitFor(async () => { lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri); return lenses?.some(l => l.command?.command === 'dsh-tui-vscode.editKeep'); }, 'real review provider');
        return lenses;
    };
    const executeLens = lens => { assert.ok(lens?.command); return command(lens.command.command, ...lens.command.arguments); };
    try {
        const file = path.join(root, 'review-fixture.js'), uri = vscode.Uri.file(file);
        let editor = await vscode.window.showTextDocument(uri, { preview: false });
        const before = await fs.readFile(file, 'utf8');
        const after = before.replace('old a', 'new a').replace('old b', 'new b').replace('old c', 'new c');
        checkpoint('ordinary writes are not AI');
        const ordinary = path.join(root, 'ordinary.txt');
        await fs.writeFile(ordinary, 'ordinary script\n');
        await review.onFsEvent(vscode.Uri.file(ordinary), 'create');
        assert.equal(review.ledger.get(ordinary), null);
        await fs.writeFile(ordinary, 'Git or another editor\n');
        await review.onFsEvent(vscode.Uri.file(ordinary), 'change');
        assert.equal(review.ledger.get(ordinary), null);
        result.checks.push('DeepSeek terminal open: ordinary create/change never marked AI');

        checkpoint('actual generated controls and unchanged save');
        const entry = await aiWrite(file, after);
        assert.equal(entry.before, before); assert.equal(entry.provenance, 'file-tool-v1');
        let lenses = await lensesFor(uri);
        const firstKeep = lenses.find(l => l.command.command === 'dsh-tui-vscode.editKeep' && !l.command.arguments[1]?.file);
        await editor.document.save();
        await executeLens(firstKeep);
        const kept = before.replace('old a', 'new a').replace('old b', 'new b');
        assert.equal(review.ledger.get(file).before, kept);
        const staleUndo = lenses.find(l => l.command.command === 'dsh-tui-vscode.editUndo' && !l.command.arguments[1]?.file);
        await executeLens(staleUndo);
        assert.equal(await fs.readFile(file, 'utf8'), after);
        lenses = await lensesFor(uri);
        await executeLens(lenses.find(l => l.command.command === 'dsh-tui-vscode.editUndo' && !l.command.arguments[1]?.file));
        assert.equal(await fs.readFile(file, 'utf8'), kept); assert.equal(review.ledger.get(file), null);
        result.checks.push('Actual CodeLens Keep survives no-change save; stale Undo refused; fresh Undo preserves kept block and exact CRLF/EOF');

        checkpoint('Keep then later tool Undo');
        await aiWrite(file, kept.replace('old c', 'later c'));
        await executeLens((await lensesFor(uri)).find(l => l.command.command === 'dsh-tui-vscode.editUndo' && l.command.arguments[1]?.file));
        assert.equal(await fs.readFile(file, 'utf8'), kept);
        result.checks.push('Second tool transaction after Keep: generated Undo works');

        checkpoint('non-overlapping user edit rebased; overlap paused');
        await aiWrite(file, kept.replace('old c', 'AI c'));
        const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(2, 0), '// user note\r\n');
        assert.ok(await vscode.workspace.applyEdit(edit)); assert.ok(await editor.document.save());
        const rebased = review.ledger.get(file);
        assert.equal(rebased.userTouched, false); assert.ok(rebased.before.includes('// user note'));
        const userSaved = editor.document.getText();
        await executeLens((await lensesFor(uri)).find(l => l.command.command === 'dsh-tui-vscode.editUndo' && !l.command.arguments[1]?.file));
        assert.equal(await fs.readFile(file, 'utf8'), userSaved.replace('AI c', 'old c'));
        await aiWrite(file, editor.document.getText().replace('old c', 'overlap AI'));
        const old = (await lensesFor(uri)).find(l => l.command.command === 'dsh-tui-vscode.editUndo' && !l.command.arguments[1]?.file);
        const originalText = editor.document.getText();
        const overlap = new vscode.WorkspaceEdit();
        const line = originalText.split(/\r?\n/).findIndex(s => s.includes('overlap AI'));
        overlap.replace(uri, new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length), 'const c = "user overlap";');
        assert.ok(await vscode.workspace.applyEdit(overlap)); assert.ok(await editor.document.save());
        assert.equal(review.ledger.get(file).userTouched, true);
        const mixed = await fs.readFile(file, 'utf8'); await executeLens(old); assert.equal(await fs.readFile(file, 'utf8'), mixed);
        const paused = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
        assert.equal(paused.some(l => l.command?.command === 'dsh-tui-vscode.editUndo'), false);
        await command('dsh-tui-vscode.editKeep', file); assert.equal(await fs.readFile(file, 'utf8'), mixed);
        result.checks.push('Disjoint user edit preserved and excluded from AI diff; overlapping user edit pauses controls and stale action never overwrites it');

        checkpoint('complete removed lines and actual hover links');
        const deletedText = path.join(root, 'deleted-lines.txt'), deletedUri = vscode.Uri.file(deletedText);
        const long = Array.from({ length: 8 }, (_, i) => `旧稿第${i + 1}行：完整旧文本，不能截断`).join('\r\n');
        await fs.writeFile(deletedText, `start\r\n${long}\r\nend`);
        await aiWrite(deletedText, 'start\r\nend');
        editor = await vscode.window.showTextDocument(deletedUri, { preview: false });
        await waitFor(() => editor.document.getText() === 'start\r\nend', 'deletion editor');
        await review.showDiff(deletedText, true);
        const originalUri = vscode.Uri.parse(`dsh-edit-review:original?side=before&f=${encodeURIComponent(deletedText)}`);
        const original = await vscode.workspace.openTextDocument(originalUri);
        assert.ok(original.getText().includes(long));
        const deletion = review.ledger.get(deletedText), h = reviewDiff(deletion.before, deletion.after).hunks[0];
        const hover = review.hunkHover(deletion, h).value;
        const match = hover.match(/command:dsh-tui-vscode\.editUndo\?([^)]*)/);
        assert.ok(match); const args = JSON.parse(decodeURIComponent(match[1]));
        await command('dsh-tui-vscode.editUndo', ...args);
        assert.equal(await fs.readFile(deletedText, 'utf8'), `start\r\n${long}\r\nend`);
        result.checks.push('8 full Chinese removed lines retained in native diff; original hover Undo arguments restore exact CRLF');

        checkpoint('create, BOM and save participant safety');
        const created = path.join(root, 'created.txt'), createdUri = vscode.Uri.file(created);
        await aiWrite(created, 'accepted\r\nremaining\r\n');
        const createdEditor = await vscode.window.showTextDocument(createdUri, { preview: false });
        createdEditor.selection = new vscode.Selection(0, 0, 0, 0);
        await command('dsh-tui-vscode.editKeepLine'); assert.equal(review.ledger.get(created).kind, 'modify');
        await command('dsh-tui-vscode.editUndo', created); assert.equal(await fs.readFile(created, 'utf8'), 'accepted\r\n');
        const bom = path.join(root, 'bom.txt'); await aiWrite(bom, '\uFEFFBOM changed\r\n');
        await command('dsh-tui-vscode.editUndo', bom); assert.equal(await fs.readFile(bom, 'utf8'), '\uFEFFBOM changed\r\n'); assert.ok(review.ledger.get(bom));
        await command('dsh-tui-vscode.editKeep', bom);
        const format = path.join(root, 'batch-a.txt'), formatUri = vscode.Uri.file(format);
        await aiWrite(format, 'formatter input\n');
        await vscode.window.showTextDocument(formatUri, { preview: false });
        const formatHint = changeHint(review.ledger.get(format), reviewDiff(review.ledger.get(format).before, review.ledger.get(format).after).hunks[0]);
        const participant = vscode.workspace.onWillSaveTextDocument(e => { if (e.document.uri.fsPath === format) e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), '// formatter\n')])); });
        try { await command('dsh-tui-vscode.editUndo', format, formatHint); } finally { participant.dispose(); }
        assert.equal(review.ledger.get(format).conflict, 'save-participant');
        assert.equal(await fs.readFile(format, 'utf8'), '// formatter\nbatch A original\n');
        await command('dsh-tui-vscode.editKeep', format);
        result.checks.push('Partial new-file Keep preserves existence; BOM Undo refused; save participant mismatch retains original and explicit conflict');

        checkpoint('shutdown persists unresolved original');
        const pending = path.join(root, 'batch-b.txt'); await aiWrite(pending, 'shutdown pending\n');
        const decision = review.withPath(pending, async () => { await new Promise(r => setTimeout(r, 50)); review.ledger.get(pending).userTouched = true; });
        await review.shutdown(); await decision;
        const stored = JSON.parse(await fs.readFile(review.storeFile(), 'utf8')).entries.find(e => e.path === pending);
        assert.equal(stored.before, 'batch B original'); assert.equal(stored.after, 'shutdown pending\n'); assert.equal(stored.provenance, 'file-tool-v1');
        result.checks.push('Awaited shutdown preserves queued review and verified provenance');
        result.status = 'passed'; checkpoint('complete');
    } catch (error) { result.status = 'failed'; result.error = String(error.stack ?? error); checkpoint(`failed: ${result.phase}`); throw error; }
    finally { terminal.dispose(); syncFs.writeFileSync(evidence, JSON.stringify(result, null, 2)); }
}
module.exports = { run };
