'use strict';
const path = require('path');

/**
 * Read and validate configuration once, at startup, so a typo shows up as a clear error
 * instead of as "undefined/favicon.svg" in the manifest and 401s from TMDB.
 */
function loadEnv(env = process.env) {
    const problems = [];

    const tmdbApiKey = (env.TMDB_API_KEY || '').trim();
    if (!tmdbApiKey) problems.push('TMDB_API_KEY is not set');

    const addonUrl = (env.ADDON_URL || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(addonUrl)) {
        problems.push('ADDON_URL must be an absolute http(s) URL, e.g. https://addon.example.com');
    }

    const imageFormat = (env.IMAGE_FORMAT || 'jpg').trim().toLowerCase();
    if (imageFormat !== 'jpg' && imageFormat !== 'png') problems.push('IMAGE_FORMAT must be "jpg" or "png"');

    if (problems.length) throw new Error(`Invalid environment:\n - ${problems.join('\n - ')}`);

    return {
        tmdbApiKey,
        addonUrl,
        port: Number(env.PORT) || 7000,
        // Same folder as before (next to server.js) unless CACHE_DIR points elsewhere, e.g. a Docker volume
        cacheDir: env.CACHE_DIR ? path.resolve(env.CACHE_DIR) : path.resolve(__dirname, '..', 'image-cache'),
        renderConcurrency: Number(env.RENDER_CONCURRENCY) || 4,
        // Format of the artwork URLs the catalog and configure page hand out. Both extensions are always served.
        imageFormat,
    };
}

module.exports = { loadEnv };
