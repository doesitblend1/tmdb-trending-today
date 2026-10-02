'use strict';
const { createLimiter, createSingleFlight, MemoryCache, deepFreeze } = require('./util');

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';
const IMAGE_FILE = /^\/[\w.-]+$/;

class TmdbError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'TmdbError';
        this.status = status;
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(header) {
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : null;
}

/**
 * Thin TMDB v3 client. Everything that talks to TMDB goes through here, so the rules live in one place:
 *  - every request has a timeout, and 429 / 5xx / network errors are retried with backoff
 *  - identical concurrent requests share one round trip
 *  - successful JSON is cached for `ttlMs`, and served stale (up to `staleMs`) if TMDB is failing
 *  - cached JSON is deep-frozen: callers can't mutate data other requests are using
 *  - the API key never appears in errors or log lines
 */
function createTmdbClient({
    apiKey,
    fetchImpl = globalThis.fetch,
    ttlMs = 10 * 60_000,
    staleMs = 6 * 3_600_000,
    maxEntries = 2000,
    timeoutMs = 8000,
    retries = 2,
    maxConcurrent = 16,
    maxConcurrentImages = 8,
    sleep = defaultSleep,
    logger = console,
} = {}) {
    if (!apiKey) throw new Error('createTmdbClient: apiKey is required');

    const cache = new MemoryCache({ ttlMs, staleMs, maxEntries });
    const flights = createSingleFlight();
    const apiLimit = createLimiter(maxConcurrent);
    const imageLimit = createLimiter(maxConcurrentImages);

    async function fetchJson(url) {
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (attempt > 0) await sleep(lastError?.retryAfterMs ?? Math.min(300 * 3 ** (attempt - 1), 5000));
            try {
                const res = await fetchImpl(url, {
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: { accept: 'application/json' },
                });
                if (res.ok) return await res.json();
                lastError = new TmdbError(`TMDB responded ${res.status}`, res.status);
                lastError.retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
                if (res.status !== 429 && res.status < 500) throw lastError; // other 4xx: retrying won't help
            } catch (err) {
                if (err instanceof TmdbError && err.status !== 429 && err.status < 500) throw err;
                lastError = err; // network error, timeout, 429, 5xx: try again
            }
        }
        throw lastError;
    }

    /** GET a v3 endpoint, e.g. json('/movie/603', { append_to_response: 'images' }). */
    async function json(path, params = {}) {
        if (typeof path !== 'string' || !path.startsWith('/') || /[?#\\]|\.\./.test(path)) {
            throw new TmdbError('Invalid TMDB path', 400);
        }
        const url = new URL(API_BASE + path);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        url.searchParams.sort();
        const key = url.pathname + url.search; // no api key in the cache key

        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        return flights.run(key, async () => {
            try {
                url.searchParams.set('api_key', apiKey);
                const data = deepFreeze(await apiLimit(() => fetchJson(url)));
                cache.set(key, data);
                return data;
            } catch (err) {
                const stale = err.status === 404 ? undefined : cache.getStale(key);
                if (stale !== undefined) {
                    logger.warn?.(`TMDB unavailable for ${path} (${err.status || err.name}); serving stale copy`);
                    return stale;
                }
                throw err;
            }
        });
    }

    const imageUrl = (size, filePath) => `${IMAGE_BASE}/${size}${filePath}`;

    /** Download an image from TMDB's CDN. */
    async function image(size, filePath) {
        if (!IMAGE_FILE.test(filePath || '')) throw new TmdbError('Invalid image path', 400);
        return imageLimit(async () => {
            const res = await fetchImpl(imageUrl(size, filePath), { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) throw new TmdbError(`Image CDN responded ${res.status}`, res.status);
            return Buffer.from(await res.arrayBuffer());
        });
    }

    return { json, image, imageUrl, cache };
}

module.exports = { createTmdbClient, TmdbError };
