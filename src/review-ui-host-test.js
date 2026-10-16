'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const output = path.join(root, 'ui-result.json'), marker = path.join(root, 'visual-next.json');
    const result = { version: vscode.version, status: 'running', inferenceRequested: false, phases: [] };
    const write = phase => { result.phase = phase; result.phases.push(phase); fs.writeFileSync(output, JSON.stringify(result, null, 2)); };
    const wait = async () => { const start = Date.now(); while (!fs.existsSync(marker)) {
        if (Date.now() - start > 20000)
            throw Error('UI observer timeout');
        await new Promise(r => setTimeout(r, 50));
    } fs.unlinkSync(marker); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // The real flow carries the TOOL's path text, which may differ in casing
    // from VS Code's document path (e.g. an uppercase drive letter). Keep that
    // shape here so path-keying regressions fail this UI test.
    const caseVariant = (p) => process.platform === 'win32' ? p.replace(/^([a-z]):/, m => m.toUpperCase()) : p;
    try {
        const api = await vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode').activate();
        const review = api.getEditReviewTestBridge(), tx = api.getEditTransactionsTestBridge();
        await review.ready;
        const file = path.join(root, 'ui.txt'), uri = vscode.Uri.file(file);
        const old = 'old one\r\nseparator one\r\nseparator two\r\nold two';
        const after = 'new one\r\nseparator one\r\nseparator two\r\nnew two';
        fs.writeFileSync(file, old);
        await vscode.window.showTextDocument(uri);
        const owner = {}, op = { operationId: 'ui1', tool: 'write', path: caseVariant(file), before: old, after, identity: { callId: 'ui1' } };
        const ack = await tx.begin(owner, op);
        assert.equal(ack.mode, 'stable');
        fs.writeFileSync(file, after);
        await tx.end(owner, { ...op, ticket: ack.ticket, success: true });
        const editor = await vscode.window.showTextDocument(uri);
        await sleep(300);
        await vscode.commands.executeCommand('notifications.clearAll');
        for (const theme of ['Default Dark+', 'Default Light+', 'Default High Contrast']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
            await sleep(400);
            write(`inline-${theme}`);
            await wait();
        }
        write('click-keep-first');
        await wait();
        for (let i = 0; review.ledger.get(file)?.before === old && i < 100; i++)
            await sleep(30);
        assert.equal(review.ledger.get(file).before, old.replace('old one', 'new one'));
        assert.equal(fs.readFileSync(file, 'utf8'), after);
        await sleep(300);
        write('click-undo-second');
        await wait();
        const expected = old.replace('old one', 'new one');
        for (let i = 0; fs.readFileSync(file, 'utf8') !== expected && i < 100; i++)
            await sleep(30);
        assert.equal(fs.readFileSync(file, 'utf8'), expected);
        assert.equal(editor.document.getText(), expected);
        assert.equal(review.ledger.get(file), null);
        result.actualPointerKeepUndo = true;
        const deleted = path.join(root, 'deleted.txt'), deletedUri = vscode.Uri.file(deleted);
        const long = Array.from({ length: 8 }, (_, i) => `旧稿第${i + 1}行：完整中文删除内容`).join('\r\n');
        const before = `start\r\n${long}\r\nend`, newText = 'start\r\nend';
        fs.writeFileSync(deleted, before);
        const op2 = { ...op, operationId: 'ui2', path: caseVariant(deleted), before, after: newText, identity: { callId: 'ui2' } };
        const ack2 = await tx.begin(owner, op2);
        fs.writeFileSync(deleted, newText);
        await tx.end(owner, { ...op2, ticket: ack2.ticket, success: true });
        for (const theme of ['Default Dark+', 'Default Light+', 'Default High Contrast']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
            await review.showDiff(deleted);
            await sleep(700);
            write(`diff-${theme}`);
            await wait();
        }
        await vscode.window.showTextDocument(deletedUri);
        await vscode.commands.executeCommand('dsh-tui-vscode.editUndo', deleted);
        assert.equal(fs.readFileSync(deleted, 'utf8'), before);
        result.completeChineseDeletionRestore = true;
        result.status = 'passed';
        write('complete');
    }
    catch (e) {
        result.status = 'failed';
        result.error = e.stack || String(e);
        write('failed');
        throw e;
    }
}
module.exports = { run };
