'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { reviewDiff, changeHint } = require('./precise-review-core');
async function waitFor(predicate, message) {
    const start = Date.now();
    while (!await predicate()) {
        if (Date.now() - start > 10000) throw Error(`Timeout: ${message}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
async function bounded(operation, message, timeout = 5000) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${message}`)), timeout); }),
        ]);
    } finally { clearTimeout(timer); }
}
const command = (id, ...args) => bounded(vscode.commands.executeCommand(id, ...args), id);
async function run() {
    const extension = vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode');
    assert.ok(extension);
    const api = await extension.activate();
    const review = api.getEditReviewTestBridge();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(root, 'review-fixture.js');
    const uri = vscode.Uri.file(file);
    const before = 'const a = "old a";\r\nconst b = "old b";\r\n// unchanged\r\nconst c = "old c";';
    const after = before.replace('old a','new a').replace('old b','new b').replace('old c','new c');
    await review.ready;
    await review.prepareSession();
    const terminal = vscode.window.createTerminal({ name: 'DeepSeek' });
    review.trackTerminal(terminal);
    const result = { version: vscode.version, inferenceRequested: false, onlyFixtureFiles: true, status: 'running', phases: [] };
    const evidence = path.join(root, 'host-result.json');
    const checkpoint = phase => {
        result.phase = phase;
        result.phases.push({ phase, at: new Date().toISOString() });
        syncFs.writeFileSync(evidence + '.tmp', JSON.stringify(result, null, 2));
        syncFs.renameSync(evidence + '.tmp', evidence);
        console.log('REVIEW_HOST_PHASE', phase);
    };
    checkpoint('watcher and per-change decisions');
    try {
        let editor = await vscode.window.showTextDocument(uri, { preview: false });
        await fs.writeFile(file, after);
        await waitFor(() => review.ledger.get(file)?.after === after, 'filesystem watcher records change');
        result.watcherCapturedExactOriginal = review.ledger.get(file).before === before;
        assert.equal(result.watcherCapturedExactOriginal, true);
        await waitFor(() => editor.document.getText() === after, 'editor reload');
        const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
        assert.ok(Array.isArray(lenses) && lenses.every(lens => lens.range && lens.command));
        result.flatCodeLenses = lenses.length;
        assert.ok(lenses.filter(l => l.command.command === 'dsh-tui-vscode.editUndo' && l.command.arguments.length === 2 && !l.command.arguments[1]?.file).length === 2);
        result.eachHunkHasKeepUndo = true;
        await review.showDiff(file, true);
        const originalUri = vscode.Uri.parse(`dsh-edit-review:original?side=before&f=${encodeURIComponent(file)}`);
        const original = await vscode.workspace.openTextDocument(originalUri);
        assert.equal(original.getText(), before);
        editor = await vscode.window.showTextDocument(uri, { preview: false });
        editor.selection = new vscode.Selection(0,0,0,0);
        await command('dsh-tui-vscode.editKeepLine');
        const keptOne = before.replace('old a','new a');
        assert.equal(review.ledger.get(file).before, keptOne);
        await waitFor(() => original.getText() === keptOne, 'live original side refresh');
        result.keepOneLineUpdatesDiffBaseline = true;
        editor.selection = new vscode.Selection(1,0,1,0);
        await command('dsh-tui-vscode.editUndoLine');
        const fixed = after.replace('new b','old b');
        assert.equal(await fs.readFile(file,'utf8'), fixed);
        assert.equal(review.ledger.get(file).after, fixed);
        result.undoOneAdjacentLinePreservesOthers = true;
        result.exactCRLFAndNoFinalNewline = !fixed.endsWith('\n') && fixed.includes('\r\n');
        const entry = review.ledger.get(file);
        const h = reviewDiff(entry.before, entry.after).hunks.at(-1);
        await command('dsh-tui-vscode.editUndo', file, changeHint(entry,h));
        assert.equal(await fs.readFile(file,'utf8'), keptOne);
        assert.equal(review.ledger.get(file), null);
        result.undoOtherHunkPreservesKeptLine = true;
        checkpoint('fast rewrite after user save');
        // Save then rewrite within the old 2-second suppression window.
        const trace = [];
        const oldProcess = review.processFsEvent.bind(review);
        review.processFsEvent = async (uri, kind) => {
            const initial = review.settled.get(file);
            const entryBefore = review.ledger.get(file)?.after;
            await oldProcess(uri, kind);
            if (uri.fsPath === file) trace.push({kind, initial, final: review.settled.get(file), entryBefore, entryAfter:review.ledger.get(file)?.after, session:review.sessionActive()});
        };
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri,new vscode.Position(0,0),'// user save\r\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await editor.document.save();
        await new Promise(resolve=>setTimeout(resolve,600));
        const saved = editor.document.getText();
        const next = saved.replace('old c','updated c');
        await fs.writeFile(file,next);
        const afterEvidence = async predicate => {
            await waitFor(predicate, 'fast rewrite after user save');
        };
        try { await afterEvidence(() => review.ledger.get(file)?.after === next); }
        catch (error) {
            result.debug = { trace, entry: review.ledger.get(file), baseline: review.settled.get(file), docText: editor.document.getText(), isDirty: editor.document.isDirty, session: review.sessionActive(), self: review.selfMarks.get(file), save: review.saveMarks.get(file) };
            throw error;
        }
        result.fastRewriteNotHiddenBySaveShield = true;
        await waitFor(() => editor.document.getText() === next, 'editor reload after save');
        await command('dsh-tui-vscode.editUndo', file);
        assert.equal(await fs.readFile(file,'utf8'), saved);
        result.wholeFileUndo = true;
        await new Promise(resolve => setTimeout(resolve, 600));
        await fs.writeFile(file,next);
        await waitFor(() => review.ledger.get(file)?.after === next, 'second fast rewrite after undo');
        await waitFor(() => editor.document.getText() === next, 'editor reload second');
        checkpoint('user edit protection and stale command completion');
        const pending = new vscode.WorkspaceEdit();
        pending.insert(uri, new vscode.Position(0,0), '// later user edit\r\n');
        assert.ok(await vscode.workspace.applyEdit(pending));
        await editor.document.save();
        assert.equal(review.ledger.get(file).userTouched, true);
        const mixed = editor.document.getText();
        const stale = changeHint(review.ledger.get(file), reviewDiff(review.ledger.get(file).before,review.ledger.get(file).after).hunks[0]);
        await command('dsh-tui-vscode.editUndo',file,stale);
        assert.equal(await fs.readFile(file,'utf8'), mixed);
        result.userEditsBlockPerHunkUndo = true;
        const dirty = new vscode.WorkspaceEdit();
        dirty.insert(uri, new vscode.Position(0, 0), '// unsaved user buffer\r\n');
        assert.ok(await vscode.workspace.applyEdit(dirty));
        assert.equal(editor.document.isDirty, true);
        await command('dsh-tui-vscode.editUndo', file);
        assert.equal(await fs.readFile(file, 'utf8'), mixed);
        assert.ok(editor.document.getText().startsWith('// unsaved user buffer'));
        assert.equal(editor.document.isDirty, true);
        result.dirtyUserBufferBlocksWholeUndo = true;
        assert.ok(await editor.document.save());
        const mixedSaved = editor.document.getText();
        await command('dsh-tui-vscode.editKeepAll');
        assert.equal(review.entries().length,0);
        assert.equal(await fs.readFile(file,'utf8'), mixedSaved);
        result.keepAll = true;
        checkpoint('new file acceptance and deleted file restoration');
        // New creation is classified correctly, acceptance does not modify disk.
        const created = path.join(root,'created.txt');
        await fs.writeFile(created,'new file\n');
        await waitFor(()=>review.ledger.get(created)?.kind==='create','new file');
        await command('dsh-tui-vscode.editKeep',created);
        assert.equal(await fs.readFile(created,'utf8'),'new file\n');
        result.newFileKeep = true;
        // Deleted originals remain available and file-level Undo recreates exact text.
        const deleted = path.join(root,'deleted.txt');
        await fs.unlink(deleted);
        await waitFor(()=>review.ledger.get(deleted)?.kind==='delete','deleted file');
        await command('dsh-tui-vscode.editUndo',deleted);
        assert.equal(await fs.readFile(deleted,'utf8'),'delete original\r\n');
        result.deletedFileRestored = true;
        checkpoint('new file partial acceptance');
        const partial = path.join(root, 'partial.txt');
        const partialUri = vscode.Uri.file(partial);
        await fs.writeFile(partial, 'accepted\r\nremaining\r\n');
        await waitFor(() => review.ledger.get(partial)?.kind === 'create', 'new file for partial acceptance');
        const partialEditor = await vscode.window.showTextDocument(partialUri, { preview: false });
        partialEditor.selection = new vscode.Selection(0, 0, 0, 0);
        await command('dsh-tui-vscode.editKeepLine');
        assert.equal(review.ledger.get(partial).kind, 'modify');
        assert.equal(review.ledger.get(partial).before, 'accepted\r\n');
        await command('dsh-tui-vscode.editUndo', partial);
        assert.equal(await fs.readFile(partial, 'utf8'), 'accepted\r\n');
        assert.equal(review.ledger.get(partial), null);
        result.partialNewFileUndoPreservesAcceptedExistence = true;
        checkpoint('stale controls and batch undo');
        const batchA = path.join(root, 'batch-a.txt');
        const batchB = path.join(root, 'batch-b.txt');
        await fs.writeFile(batchA, 'batch A new\n');
        await waitFor(() => review.ledger.get(batchA)?.after === 'batch A new\n', 'batch A');
        const oldFileHint = review.fileHint(review.ledger.get(batchA));
        await fs.writeFile(batchA, 'batch A newer\n');
        await waitFor(() => review.ledger.get(batchA)?.after === 'batch A newer\n', 'batch A rewrite');
        await command('dsh-tui-vscode.editUndo', batchA, oldFileHint);
        await command('dsh-tui-vscode.editKeep', batchA, oldFileHint);
        assert.equal(await fs.readFile(batchA, 'utf8'), 'batch A newer\n');
        assert.ok(review.ledger.get(batchA));
        result.staleFileControlsDoNotChangeOrAcceptNewWrites = true;
        await fs.writeFile(batchB, 'batch B new');
        await waitFor(() => review.ledger.get(batchB)?.after === 'batch B new', 'batch B');
        await command('dsh-tui-vscode.editUndoAll');
        assert.equal(await fs.readFile(batchA, 'utf8'), 'batch A original\n');
        assert.equal(await fs.readFile(batchB, 'utf8'), 'batch B original');
        assert.equal(review.entries().length, 0);
        result.batchUndoRestoresMultipleFiles = true;
        checkpoint('UTF-8 BOM document and disk round trip');
        const bom = path.join(root, 'bom.txt');
        const bomUri = vscode.Uri.file(bom);
        const bomDoc = await vscode.workspace.openTextDocument(bomUri);
        await review.onFsEvent(bomUri, 'change');
        assert.equal(review.ledger.get(bom), null);
        const bomSave = new vscode.WorkspaceEdit();
        bomSave.insert(bomUri, new vscode.Position(0, 0), 'user BOM save\r\n');
        assert.ok(await vscode.workspace.applyEdit(bomSave));
        assert.ok(await bomDoc.save());
        await review.onFsEvent(bomUri, 'change');
        assert.equal(review.ledger.get(bom), null);
        assert.ok(review.saveMarks.get(bom).text.startsWith('\uFEFF'));
        result.bomUserSaveDoesNotCreatePhantomReview = true;
        const bomSaved = await fs.readFile(bom, 'utf8');
        await fs.writeFile(bom, '\uFEFFBOM changed\r\n');
        await waitFor(() => review.ledger.get(bom)?.after === '\uFEFFBOM changed\r\n', 'BOM watcher');
        await waitFor(() => bomDoc.getText().includes('BOM changed'), 'BOM reload');
        result.bomDocumentTextIncludesPreamble = bomDoc.getText().startsWith('\uFEFF');
        const bomEntry = review.ledger.get(bom);
        assert.equal(bomEntry.before, bomSaved);
        await command('dsh-tui-vscode.editUndo', bom, changeHint(bomEntry, reviewDiff(bomEntry.before, bomEntry.after).hunks[0]));
        // VS Code strips the UTF-8 BOM from TextDocument.getText(). Until the
        // encoding-aware write path is implemented, the mismatch must refuse
        // restoration rather than remove/duplicate a disk preamble.
        assert.equal(await fs.readFile(bom, 'utf8'), '\uFEFFBOM changed\r\n');
        assert.ok(review.ledger.get(bom));
        result.bomModelPreambleMismatchRejectedSafely = true;
        await command('dsh-tui-vscode.editUndo', bom);
        assert.equal(await fs.readFile(bom, 'utf8'), '\uFEFFBOM changed\r\n');
        assert.ok(review.ledger.get(bom));
        await command('dsh-tui-vscode.editKeep', bom);
        checkpoint('save participant mutation retains original review');
        const formatUri = vscode.Uri.file(batchA);
        const formatDoc = await vscode.workspace.openTextDocument(formatUri);
        await fs.writeFile(batchA, 'batch A formatter input\n');
        await waitFor(() => review.ledger.get(batchA)?.after === 'batch A formatter input\n', 'formatter input watcher');
        await waitFor(() => formatDoc.getText() === 'batch A formatter input\n', 'formatter input editor');
        const formatEntry = review.ledger.get(batchA);
        const formatHint = changeHint(formatEntry, reviewDiff(formatEntry.before, formatEntry.after).hunks[0]);
        const participant = vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.fsPath === batchA) event.waitUntil(Promise.resolve([
                vscode.TextEdit.insert(new vscode.Position(0, 0), '// formatter participant\n'),
            ]));
        });
        try { await command('dsh-tui-vscode.editUndo', batchA, formatHint); }
        finally { participant.dispose(); }
        assert.equal(await fs.readFile(batchA, 'utf8'), '// formatter participant\nbatch A original\n');
        assert.equal(review.ledger.get(batchA)?.before, 'batch A original\n');
        assert.equal(review.ledger.get(batchA)?.after, '// formatter participant\nbatch A original\n');
        assert.equal(review.ledger.get(batchA)?.userTouched, true);
        result.saveParticipantMismatchRetainsOriginalReview = true;
        await command('dsh-tui-vscode.editKeep', batchA);
        assert.equal(review.entries().length, 0);
        checkpoint('awaited shutdown persists queued pending review');
        await fs.writeFile(batchB, 'shutdown pending\n');
        await waitFor(() => review.ledger.get(batchB)?.after === 'shutdown pending\n', 'shutdown pending fixture');
        const pendingDecision = review.withPath(batchB, async () => {
            await new Promise(resolve => setTimeout(resolve, 80));
            review.ledger.get(batchB).userTouched = true;
        });
        await bounded(review.shutdown(), 'awaited review shutdown');
        await pendingDecision;
        const persisted = JSON.parse(await fs.readFile(review.storeFile(), 'utf8'));
        const persistedEntry = persisted.entries.find(entry => entry.path === batchB);
        assert.equal(persistedEntry.before, 'batch B original');
        assert.equal(persistedEntry.after, 'shutdown pending\n');
        assert.equal(persistedEntry.userTouched, true);
        result.awaitedShutdownPersistsQueuedDecision = true;
        result.status = 'passed';
        checkpoint('complete');
    } catch (error) {
        result.status = 'failed';
        result.error = String(error.stack ?? error);
        checkpoint(`failed: ${result.phase}`);
        throw error;
    } finally {
        terminal.dispose();
        syncFs.writeFileSync(evidence + '.tmp', JSON.stringify(result, null, 2));
        syncFs.renameSync(evidence + '.tmp', evidence);
    }
    console.log('REVIEW_HOST_RESULT',JSON.stringify(result));
}
module.exports = { run };
