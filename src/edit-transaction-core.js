'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./precise-review-core');
const MAX_BYTES = 256 * 1024;
const keyOf = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const text = v => v === null || typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= MAX_BYTES && !v.includes('\0');
const allowed = new Set(['write', 'edit', 'str_replace_editor']);
/** Authenticated transport is outside this class. Bind every operation to
 * its socket owner and immutable path/before/expected-after snapshots. */
class EditTransactions {
    constructor(options) {
        this.options = options;
        this.operations = new Map();
        this.paths = new Map();
    }
    async read(file) {
        try {
            const st = await fs.lstat(file);
            if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES)
                throw Error('Unsupported file');
            const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await fs.readFile(file));
            if (!text(value))
                throw Error('Unsupported text');
            return value;
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return null;
            throw e;
        }
    }
    async begin(owner, input) {
        if (!input || typeof input.operationId !== 'string' || input.operationId.length > 100 || !allowed.has(input.tool)
            || typeof input.path !== 'string' || !path.isAbsolute(input.path) || !text(input.before) || !text(input.after)
            || input.after === null || !input.identity || typeof input.identity.callId !== 'string')
            throw Error('Invalid edit transaction');
        const key = keyOf(input.path);
        if (this.operations.has(input.operationId) || this.paths.has(key))
            throw Error('Duplicate or concurrent file transaction');
        const operation = { ...input, owner, key, ticket: randomUUID(), mode: 'stable', native: null };
        this.operations.set(input.operationId, operation);
        this.paths.set(key, operation);
        operation.timer = setTimeout(() => void this.cancel(operation, 'transaction timed out').catch(() => { }), 30000);
        try {
            await this.options.validatePath(input.path);
            if (await this.read(input.path) !== input.before)
                throw Error('Pre-edit file changed');
            const doc = this.options.document?.(input.path);
            if (doc && (doc.isDirty || doc.text !== input.before))
                throw Error('Save or synchronize editor changes before tracking');
            await this.options.before?.(operation);
            if (this.operations.get(input.operationId) !== operation)
                throw Error('Transaction canceled');
            if (this.options.nativeBegin && input.before !== null && !input.before.startsWith('\uFEFF')) {
                operation.native = await this.options.nativeBegin(operation);
                if (operation.native)
                    operation.mode = 'native';
            }
            if (this.operations.get(input.operationId) !== operation)
                throw Error('Transaction canceled before capture');
            if (await this.read(input.path) !== input.before)
                throw Error('Pre-edit file changed during capture');
            return { ticket: operation.ticket, mode: operation.mode, beforeHash: digest(operation.before) };
        }
        catch (e) {
            await this.cancel(operation, e.message);
            throw e;
        }
    }
    async end(owner, input) {
        const operation = this.operations.get(input?.operationId);
        if (!operation || operation.owner !== owner || operation.ticket !== input.ticket)
            throw Error('Unknown edit transaction');
        try {
            if (input.success !== true)
                throw Error('File tool did not complete successfully');
            clearTimeout(operation.timer);
            if (input.path !== operation.path || input.before !== operation.before || input.after !== operation.after)
                throw Error('Tool result differs from prepared mutation');
            await this.options.validatePath(operation.path);
            if (await this.read(operation.path) !== operation.after)
                throw Error('File changed after tool mutation');
            const doc = this.options.document?.(operation.path);
            if (doc?.isDirty)
                throw Error('User buffer changed during tool mutation');
            if (this.operations.get(operation.operationId) !== operation)
                throw Error('Transaction disconnected before commit');
            if (operation.native)
                await operation.native.complete();
            else
                await this.options.commit(operation);
            return { mode: operation.mode };
        }
        catch (error) {
            await operation.native?.cancel(error.message);
            throw error;
        }
        finally {
            this.release(operation);
        }
    }
    release(operation) {
        clearTimeout(operation.timer);
        if (this.operations.get(operation.operationId) === operation)
            this.operations.delete(operation.operationId);
        if (this.paths.get(operation.key) === operation)
            this.paths.delete(operation.key);
        this.options.release?.(operation);
    }
    async cancel(operation, reason) {
        if (!operation || this.operations.get(operation.operationId) !== operation)
            return;
        this.release(operation);
        await operation.native?.cancel(reason);
    }
    async disconnect(owner) { await Promise.all([...this.operations.values()].filter(o => o.owner === owner).map(o => this.cancel(o, 'bridge disconnected'))); }
    async shutdown() { await Promise.all([...this.operations.values()].map(o => this.cancel(o, 'extension stopped'))); }
}
module.exports = { EditTransactions, MAX_BYTES, keyOf };
