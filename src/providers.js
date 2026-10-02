'use strict';

const clean = (str) => (str ? str.toLowerCase().replace(/\+/g, 'plus').replace(/\s+/g, '') : '');

// Broadcast/cable networks -> the streaming service that carries them
const NETWORK_TO_PROVIDER = Object.freeze({
    hbo: 'max', cbs: 'paramount', nbc: 'peacock',
    fx: 'hulu', abc: 'hulu', fox: 'hulu',
    amc: 'amc', showtime: 'paramount', 'the cw': 'max', bbc: 'britbox',
});

// Preference order when several flat-rate providers carry a title
const TOP_TIERS = ['netflix', 'max', 'disney', 'hulu', 'apple', 'paramount', 'peacock',
    'crunchyroll', 'mgm', 'starz', 'showtime', 'amc', 'amazon'];

const isChannelStore = (name) =>
    (name.includes('amazon') && name.includes('channel')) ||
    (name.includes('roku') && name.includes('premium')) ||
    (name.includes('apple') && name.includes('channel'));

/**
 * Pick the logo to show in the corner of the artwork.
 * @param {'tv'|'movie'} tmdbType
 * @param {object} details TMDB details, with the watch-providers payload under 'watch/providers'
 * @returns {{path: string, isNetwork: boolean}|null}
 */
function resolveProviderLogoInfo(tmdbType, details) {
    const us = details['watch/providers']?.results?.US;

    // Skip "channel"/"store-within-a-store" versions of a service
    const flatrate = (us?.flatrate || []).filter((p) => !isChannelStore(clean(p.provider_name)));
    const network = tmdbType === 'tv' ? details.networks?.[0] : null;

    // 1. TV: the streaming service that matches the original network
    if (network && flatrate.length > 0) {
        const key = (network.name || '').toLowerCase();
        const target = Object.hasOwn(NETWORK_TO_PROVIDER, key) ? NETWORK_TO_PROVIDER[key] : clean(network.name);
        if (target) {
            const matched = flatrate.find((p) => {
                const name = clean(p.provider_name);
                return name.includes(target) || target.includes(name);
            });
            if (matched) return { path: matched.logo_path, isNetwork: false };
        }
    }

    // 2. Otherwise the best-ranked flat-rate provider
    if (flatrate.length > 0) {
        let best = null;
        let bestIdx = Infinity;
        for (const p of flatrate) {
            const idx = TOP_TIERS.findIndex((t) => clean(p.provider_name).includes(t));
            if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = p; }
        }
        if (!best) best = flatrate.find((p) => !clean(p.provider_name).includes('amazon')) || flatrate[0];
        return { path: best.logo_path, isNetwork: false };
    }

    // 3. Fall back to the raw network logo
    if (network) return { path: network.logo_path, isNetwork: true };
    return null;
}

module.exports = { resolveProviderLogoInfo };
