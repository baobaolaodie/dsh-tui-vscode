'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EditTransactions } = require('../edit-transaction-core');
async function fixture(fn) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tx-')); const file = path.join(root, 'f.txt'); await fs.writeFile(file, 'old\r\n'); const commits = [], released = []; const tx = new EditTransactions({ validatePath: async () => { }, commit: async (o) => commits.push(o), release: o => released.push(o) }); try {
    await fn({ tx, file, commits, released });
}
finally {
    await tx.shutdown();
    await fs.rm(root, { recursive: true, force: true });
} }
const input = file => ({ operationId: 'op1', tool: 'edit', path: file, before: 'old\r\n', after: 'AI\r\n', identity: { callId: 'call1' } });
test('ready precedes mutation; authenticated completion commits exact snapshots', () => fixture(async ({ tx, file, commits, released }) => {
    const owner = {};
    const p = input(file), r = await tx.begin(owner, p);
    assert.equal(commits.length, 0);
    await fs.writeFile(file, p.after);
    await tx.end(owner, { ...p, ticket: r.ticket, success: true });
    assert.equal(commits[0].before, 'old\r\n');
    assert.equal(commits[0].after, 'AI\r\n');
    assert.equal(released.length, 1);
}));
test('a stolen operation ID or ticket cannot complete another socket transaction', () => fixture(async ({ tx, file, commits }) => {
    const owner = {};
    const p = input(file), r = await tx.begin(owner, p);
    await fs.writeFile(file, p.after);
    await assert.rejects(tx.end({}, { ...p, ticket: r.ticket, success: true }), /Unknown/);
    await assert.rejects(tx.end(owner, { ...p, ticket: 'wrong', success: true }), /Unknown/);
    assert.equal(commits.length, 0);
    await tx.end(owner, { ...p, ticket: r.ticket, success: true });
}));
test('unverified shell, malformed text, duplicate and parallel same-path operations fail closed', () => fixture(async ({ tx, file }) => {
    const owner = {}, p = input(file);
    await assert.rejects(tx.begin(owner, { ...p, tool: 'bash' }), /Invalid/);
    await assert.rejects(tx.begin(owner, { ...p, after: '\0' }), /Invalid/);
    await tx.begin(owner, p);
    await assert.rejects(tx.begin(owner, p), /Duplicate/);
    await assert.rejects(tx.begin({}, { ...p, operationId: 'op2' }), /concurrent/);
}));
test('external disk rewrite and different tool result do not enter AI ledger', () => fixture(async ({ tx, file, commits }) => {
    const owner = {}, p = input(file);
    let r = await tx.begin(owner, p);
    await fs.writeFile(file, 'other writer\n');
    await assert.rejects(tx.end(owner, { ...p, ticket: r.ticket, success: true }), /changed after/);
    assert.equal(tx.operations.size, 0);
    assert.equal(commits.length, 0);
    await fs.writeFile(file, p.before);
    r = await tx.begin(owner, p);
    await fs.writeFile(file, p.after);
    await assert.rejects(tx.end(owner, { ...p, ticket: r.ticket, success: true, after: 'not expected' }), /differs/);
    assert.equal(commits.length, 0);
}));
test('dirty editors, mismatched before and changed while capturing reject without altering file', () => fixture(async ({ tx, file }) => {
    const p = input(file);
    tx.options.document = () => ({ isDirty: true, text: p.before });
    await assert.rejects(tx.begin({}, p), /Save/);
    delete tx.options.document;
    await assert.rejects(tx.begin({}, { ...p, before: 'not old' }), /Pre-edit/);
    tx.options.before = async () => fs.writeFile(file, 'concurrent');
    await assert.rejects(tx.begin({}, p), /during capture/);
    assert.equal(await fs.readFile(file, 'utf8'), 'concurrent');
}));
test('disconnect releases pending operation and future begin can proceed', () => fixture(async ({ tx, file, released }) => {
    const owner = {};
    await tx.begin(owner, input(file));
    await tx.disconnect(owner);
    assert.equal(tx.paths.size, 0);
    assert.equal(released.length, 1);
    await tx.begin({}, input(file));
}));
test('native completion finishes once; failed mutation cancels once without stable commit', () => fixture(async ({ tx, file, commits }) => {
    let completed = 0, canceled = 0;
    tx.options.nativeBegin = async () => ({ complete: async () => completed++, cancel: async () => canceled++ });
    const owner = {}, p = input(file);
    let r = await tx.begin(owner, p);
    assert.equal(r.mode, 'native');
    await fs.writeFile(file, p.after);
    await tx.end(owner, { ...p, ticket: r.ticket, success: true });
    assert.equal(completed, 1);
    assert.equal(commits.length, 0);
    await fs.writeFile(file, p.before);
    r = await tx.begin(owner, p);
    await assert.rejects(tx.end(owner, { ...p, ticket: r.ticket, success: false }));
    assert.equal(canceled, 1);
}));
