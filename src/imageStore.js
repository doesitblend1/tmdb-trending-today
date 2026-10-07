'use strict';
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { MemoryCache } = require('./util');

const HOUR = 3_600_000;

/**
 * Generated-image cache.
 *  - memory: LRU capped by total bytes (not entry count, PNGs vary a lot in size)
 *  - disk:   one file per key, written atomically (temp file + rename) so a reader never sees a half-written PNG
 *  - sweep(): deletes expired files and, if the folder is still over budget, the oldest ones
 */
class ImageStore {
    constructor({ dir, ttlMs = 24 * HOUR, maxMemoryBytes = 96 * 1024 * 1024, maxDiskBytes = 1024 * 1024 * 1024, now = Date.now, logger = console }) {
        this.dir = dir;
        this.ttlMs = ttlMs;
        this.maxDiskBytes = maxDiskBytes;
        this.now = now;
        this.logger = logger;
        this.memory = new MemoryCache({ ttlMs, maxBytes: maxMemoryBytes, sizeOf: (buf) => buf.length, now });
        this.timers = [];
        this.dirReady = null;
    }

    fileFor(key, ext = 'png') {
        return path.join(this.dir, `${crypto.createHash('sha256').update(key).digest('hex')}.${ext}`);
    }

    ensureDir() {
        this.dirReady ??= fsp.mkdir(this.dir, { recursive: true });
        return this.dirReady;
    }

    /** @returns {Promise<Buffer|null>} `ext` is the file extension on disk ('png' or 'jpg'); the key should already encode the format. */
    async get(key, ext = 'png') {
        const hit = this.memory.get(key);
        if (hit) return hit;
        try {
            const file = this.fileFor(key, ext);
            const stat = await fsp.stat(file);
            if (this.now() - stat.mtimeMs > this.ttlMs) return null;
            const buffer = await fsp.readFile(file);
            this.memory.set(key, buffer);
            return buffer;
        } catch {
            return null;
        }
    }

    /** Never rejects: a failing disk must not fail the request that already has its image. */
    async set(key, buffer, ext = 'png') {
        this.memory.set(key, buffer);
        const file = this.fileFor(key, ext);
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
            await this.ensureDir();
            await fsp.writeFile(tmp, buffer);
            await fsp.rename(tmp, file);
        } catch (err) {
            this.logger.error('Image cache write failed:', err.message);
            await fsp.rm(tmp, { force: true }).catch(() => {});
        }
    }

    /** Remove expired entries, then trim oldest-first down to the disk budget. Returns how many files were removed. */
    async sweep() {
        let names;
        try { names = await fsp.readdir(this.dir); } catch { return 0; }

        const files = [];
        for (const name of names) {
            if (!/\.(png|jpg|tmp)$/.test(name)) continue; // only touch our own files
            const file = path.join(this.dir, name);
            try {
                const stat = await fsp.stat(file);
                if (stat.isFile()) files.push({ file, mtime: stat.mtimeMs, size: stat.size, tmp: name.endsWith('.tmp') });
            } catch { /* vanished between readdir and stat */ }
        }

        const t = this.now();
        let removed = 0;
        const remove = async (f) => { if (await fsp.rm(f.file, { force: true }).then(() => true, () => false)) removed++; };

        const keep = [];
        for (const f of files) {
            const maxAge = f.tmp ? HOUR : this.ttlMs; // leftover temp files are garbage after an hour
            if (t - f.mtime > maxAge) await remove(f);
            else keep.push(f);
        }

        let total = keep.reduce((sum, f) => sum + f.size, 0);
        keep.sort((a, b) => a.mtime - b.mtime);
        for (const f of keep) {
            if (total <= this.maxDiskBytes) break;
            await remove(f);
            total -= f.size;
        }
        return removed;
    }

    startSweeper({ everyMs = HOUR, firstAfterMs = 10_000 } = {}) {
        const run = () => this.sweep().catch((err) => this.logger.error('Image cache sweep failed:', err.message));
        const first = setTimeout(run, firstAfterMs);
        const repeat = setInterval(run, everyMs);
        first.unref();
        repeat.unref();
        this.timers.push(first, repeat);
    }

    stop() {
        for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
        this.timers = [];
    }
}

module.exports = { ImageStore };
