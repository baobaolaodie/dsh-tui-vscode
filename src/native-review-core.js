'use strict';
// No filesystem writes, no host injection, no baseline replay.
const keyOf = path => process.platform === 'win32' ? path.toLowerCase() : path;
class NativeReviewSession {
    constructor() {
        this.current = null;
        this.owned = new Set();
    }
    get active() { return this.current !== null; }
    owns(path) { return typeof path === 'string' && this.owned.has(keyOf(path)); }
    finish() {
        if (!this.current || this.current.finishing) return false;
        this.current.finishing = true;
        this.current.release();
        return true;
    }
    release(paths) {
        if (this.active) throw Error('Finish native tracking before releasing files');
        for (const path of paths) this.owned.delete(keyOf(path));
    }
    async run(response, resources, onReady = () => {}) {
        if (this.active) throw Error('Native review is already running');
        if (typeof response?.externalEdit !== 'function') throw Error('Native response.externalEdit is unavailable in this VS Code');
        if (!Array.isArray(resources) || resources.length < 1 || resources.length > 100) throw Error('Select 1 to 100 existing text files');
        if (resources.some(uri => typeof uri?.fsPath !== 'string' || !uri.fsPath)) throw Error('Invalid resource path');
        const seen = new Set();
        const unique = resources.filter(uri => {
            const key = keyOf(uri.fsPath);
            if (seen.has(key)) return false;
            seen.add(key); return true;
        });
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        const current = { release, finishing: false, ready: false };
        this.current = current;
        try {
            return await response.externalEdit(unique, async () => {
                // The real VS Code snapshot start has completed before this callback.
                if (current.finishing) return;
                for (const uri of unique) this.owned.add(keyOf(uri.fsPath));
                current.ready = true;
                await onReady();
                await wait;
            });
        } finally {
            current.release();
            if (this.current === current) this.current = null;
        }
    }
}
module.exports = { NativeReviewSession };
