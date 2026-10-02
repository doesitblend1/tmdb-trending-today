'use strict';
const { parseUserConfig } = require('./userConfig');
const { CATALOG_SIZE } = require('./media');

function buildManifest(addonUrl) {
    return {
        id: 'com.trending.custom',
        version: '2.1.0',
        name: 'TMDB Top Today',
        description: 'Customizable Stremio catalogs for top trending TMDB content with optional graphic tags and ranked posters.',
        logo: `${addonUrl}/favicon.svg`,
        behaviorHints: { configurable: true, configurationRequired: true, configurationURL: `${addonUrl}/configure` },
        resources: ['catalog'],
        types: ['movie', 'series'],
        idPrefixes: ['tmdb:'],
        catalogs: [
            { id: 'top_movies_today', type: 'movie', name: 'Top Movies Today' },
            { id: 'top_shows_today', type: 'series', name: 'Top Shows Today' },
        ],
    };
}

const CATALOG_CACHE_SECONDS = 900;

let languageNames = null;
try { languageNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* ICU without DisplayNames */ }

function languageName(code) {
    try { return languageNames ? languageNames.of(code) : code.toUpperCase(); } catch { return code.toUpperCase(); }
}

/** URL of a generated poster/backdrop; the parameter order is part of the public URL format. */
function artUrl(addonUrl, kind, tmdbId, { type, tag, rank, lang, logos }) {
    const q = new URLSearchParams({ type, tag, rank: String(rank), lang, logos: logos ? '1' : '0' });
    return `${addonUrl}/${kind}/${tmdbId}.png?${q}`;
}

function createCatalog({ tmdb, trending, tags, genres, addonUrl }) {
    async function getCatalog(type, rawConfig = {}) {
        const cfg = parseUserConfig(rawConfig);
        const tmdbType = type === 'series' ? 'tv' : 'movie';

        const [genreMap, entries] = await Promise.all([
            genres.ensure(),
            trending.list({ type, langs: cfg.listLangs, digitalOnly: cfg.digitalOnly }),
        ]);
        // Only the titles that will be shown need details and tags
        const top = entries.slice(0, CATALOG_SIZE);

        const details = await Promise.all(top.map(({ item }) =>
            tmdb.json(`/${tmdbType}/${item.id}`, {
                append_to_response: 'external_ids,images',
                include_image_language: `${item.original_language},en,null`,
            }).catch(() => null)));

        const wantTags = cfg.posterTags || cfg.backdropTags;
        const tagList = await Promise.all(top.map(({ item, releases }, i) => {
            if (!wantTags) return 'none';
            if (type === 'movie') return tags.movieTag(item.id, releases);
            return details[i] ? tags.seriesTag(item.id, details[i]) : 'none';
        }));

        const metas = top.map(({ item }, index) => {
            const rank = index + 1;
            const d = details[index];
            const tag = tagList[index];
            const imdbId = d?.imdb_id || d?.external_ids?.imdb_id;

            const logos = d?.images?.logos || [];
            const logoLanguage = cfg.posterLanguage === 'null' ? null : cfg.posterLanguage;
            const titleLogo = logos.find((l) => l.iso_639_1 === logoLanguage)
                || logos.find((l) => l.iso_639_1 === item.original_language)
                || logos.find((l) => l.iso_639_1 === 'en')
                || logos[0];

            // Posters (also used for "landscape" cards) follow the poster settings; the background follows the backdrop settings.
            const posterArt = {
                type,
                tag: cfg.posterTags ? tag : 'none',
                rank: cfg.posterRanked ? rank : 'none',
                lang: cfg.posterLanguage,
                logos: cfg.posterLogos,
            };
            let portraitPoster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
            if (cfg.posterRanked || cfg.posterTags || cfg.posterLogos || cfg.posterLanguage !== 'en') {
                portraitPoster = artUrl(addonUrl, 'poster', item.id, posterArt);
            }
            const landscapePoster = artUrl(addonUrl, 'backdrop', item.id, posterArt);

            const backdropArt = artUrl(addonUrl, 'backdrop', item.id, {
                type,
                tag: cfg.backdropTags ? tag : 'none',
                rank: cfg.backdropRanked ? rank : 'none',
                lang: cfg.backdropLanguage,
                logos: cfg.backdropLogos,
            });
            const landscape = cfg.posterShape === 'landscape';
            const background = backdropArt;

            const itemGenres = (item.genre_ids || []).map((g) => genreMap.get(g)).filter(Boolean);
            if (cfg.listLangs.length === 1 && cfg.listLangs[0] === 'non-en' && item.original_language) {
                const name = languageName(item.original_language);
                if (name && !itemGenres.includes(name)) itemGenres.unshift(name);
            }

            return {
                id: imdbId || `tmdb:${item.id}`,
                _tmdbId: item.id,
                name: item.title || item.name,
                type,
                posterShape: landscape ? 'landscape' : 'poster',
                genres: itemGenres,
                description: item.overview || '',
                ...(titleLogo?.file_path ? { logo: `https://image.tmdb.org/t/p/original${titleLogo.file_path}` } : {}),
                background,
                poster: landscape ? landscapePoster : portraitPoster,
            };
        });

        return { metas, cacheMaxAge: CATALOG_CACHE_SECONDS };
    }

    return { getCatalog };
}

module.exports = { buildManifest, createCatalog, CATALOG_CACHE_SECONDS, artUrl };
