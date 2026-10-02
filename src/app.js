'use strict';
const fs = require('fs');
const path = require('path');

const { createTmdbClient } = require('./tmdb');
const { createTrending, createGenres, createTagResolver } = require('./media');
const { buildManifest, createCatalog } = require('./catalog');
const { createArtwork } = require('./artwork');
const { ImageStore } = require('./imageStore');
const { errorHandler } = require('./http');
const { registerAddonRoutes } = require('./routes/addon');
const { registerImageRoutes } = require('./routes/images');

/**
 * Build the Express app.
 * `deps` exists for tests: pass `express`, `sdk`, `tmdb`, `now` or `logger` to substitute the real ones.
 */
function createApp(env, deps = {}) {
    const express = deps.express || require('express');
    const { addonBuilder } = deps.sdk || require('stremio-addon-sdk');
    const logger = deps.logger || console;

    const tmdb = deps.tmdb || createTmdbClient({ apiKey: env.tmdbApiKey, logger });
    const genres = createGenres(tmdb, { logger });
    const trending = createTrending({ tmdb, now: deps.now });
    const tags = createTagResolver({ tmdb, now: deps.now, logger });
    const catalog = createCatalog({ tmdb, trending, tags, genres, addonUrl: env.addonUrl });
    const artwork = createArtwork({ tmdb, concurrency: env.renderConcurrency, logger });
    const store = new ImageStore({ dir: env.cacheDir, logger });

    // Stremio SDK: validates the manifest and gives us the manifest/handler interface
    const manifest = buildManifest(env.addonUrl);
    const builder = new addonBuilder(manifest);
    builder.defineCatalogHandler(({ type, extra }) => catalog.getCatalog(type, extra?.config));
    const addonInterface = builder.getInterface();

    const configHtml = fs
        .readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8')
        .replaceAll('{{FAVICON_URL}}', `${env.addonUrl}/favicon.svg`);

    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        next();
    });

    registerAddonRoutes(app, { manifest, addonInterface, configHtml, addonUrl: env.addonUrl });
    registerImageRoutes(app, { store, artwork, trending, tags, logger });
    app.use(errorHandler(logger));

    store.startSweeper();
    genres.ensure(); // warm up; failures are logged and retried on demand

    return { app, store, shutdown: () => store.stop() };
}

module.exports = { createApp };
