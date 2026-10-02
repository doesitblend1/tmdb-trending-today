'use strict';
const { MONTHS, parseLocal, diffDays, dateToken } = require('./dates');

/** Day windows that decide when each badge shows. Tweak them here, not in the logic below. */
const WINDOW = Object.freeze({
    onDisc: 14,
    onDigital: 14,
    comingSoonDate: 14,
    finaleAhead: 5,
    premiere: 6,
    newSeries: 13,
    newSeason: 13,
    finaleAired: 13,
    newEpisode: 6,
    finalSeason: 30,
    /** A film first released in cinemas longer ago than this isn't "coming soon" just because no digital date is on file. */
    staleTheatrical: 365,
});

const TAG_LABELS = Object.freeze({
    just_added: 'Just Added',
    coming_soon: 'Coming Soon',
    now_streaming: 'Now Streaming',
    out_on_bluray: 'Now on Blu-ray',
    premiere: 'Premiere',
    new_series: 'New Series',
    season_finale: 'Season Finale',
    series_finale: 'Series Finale',
    final_season: 'Final Season',
    new_season: 'New Season',
    new_episode: 'New Episode',
});

const DATE_TAG = new RegExp(`^(coming|finale)_date_(${MONTHS.join('|')})_([1-9]|[12]\\d|3[01])$`);

/**
 * Display text for a tag, or null for "none" / anything unrecognised.
 * Only known tags can ever reach the image renderer, so arbitrary query strings can't be drawn onto artwork.
 */
function tagLabel(tag) {
    if (typeof tag !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(TAG_LABELS, tag)) return TAG_LABELS[tag];
    const m = DATE_TAG.exec(tag);
    if (!m) return null;
    return `${m[1] === 'coming' ? 'Coming' : 'Finale'} ${m[2]} ${m[3]}`;
}

const normalizeTag = (tag) => (tagLabel(tag) ? tag : 'none');

// ─── Movies ──────────────────────────────────────────────────────────────────

/**
 * @param {{theatrical: Date|null, digital: Date|null, physical: Date|null}|null} releases earliest dates by kind
 * @param {Date} now
 */
function computeMovieTag(releases, now) {
    if (!releases) return 'none';
    const { theatrical, digital, physical } = releases;
    const since = (d) => (d && d <= now ? diffDays(now, d) : null);
    const sincePhysical = since(physical);
    const sinceDigital = since(digital);

    if (sincePhysical !== null && sincePhysical <= WINDOW.onDisc) return 'out_on_bluray';
    if (sinceDigital !== null && sinceDigital <= WINDOW.onDigital) {
        return theatrical && theatrical < digital ? 'just_added' : 'now_streaming';
    }
    if (digital && digital > now) {
        return diffDays(digital, now) <= WINDOW.comingSoonDate ? `coming_date_${dateToken(digital)}` : 'coming_soon';
    }
    if (digital) return 'none'; // out on digital for a while already

    // No digital date on record. Only call it "coming soon" if that is plausible.
    if (physical && physical <= now) return 'none'; // already on disc
    if (theatrical && theatrical <= now && diffDays(now, theatrical) > WINDOW.staleTheatrical) return 'none'; // old film, sparse metadata
    return 'coming_soon';
}

// ─── Series ──────────────────────────────────────────────────────────────────

const isEnded = (tv) => tv.status === 'Ended' || tv.status === 'Canceled';
const airedBy = (ep, now) => {
    const d = ep?.air_date ? parseLocal(ep.air_date) : null;
    return Boolean(d && d <= now);
};

/**
 * Is `ep` the last episode of its season?
 * Trusts TMDB's episode_type when present, otherwise compares with the season's episode count.
 * `guessWhenUnknown` (used for the episode that just aired, when nothing else is scheduled) treats any
 * later-than-first episode as a finale if the season size is unknown.
 */
function isFinaleEpisode(tv, ep, { guessWhenUnknown = false } = {}) {
    if (!ep) return false;
    if (ep.episode_type) return ep.episode_type === 'finale';
    const expected = tv.seasons?.find((s) => s.season_number === ep.season_number)?.episode_count || 0;
    if (expected > 0) return ep.episode_number >= expected;
    return guessWhenUnknown && ep.episode_number > 1;
}

/**
 * TMDB sometimes leaves an already-aired episode in `next_episode_to_air`. When that happens mid-season, the
 * season's episode list is needed to find what really aired last. Returns the season number to fetch, or null.
 */
function staleSeasonToLookUp(tv, now) {
    const next = tv?.next_episode_to_air;
    if (!airedBy(next, now)) return null;
    const expected = tv.seasons?.find((s) => s.season_number === next.season_number)?.episode_count || 0;
    return expected > 0 && next.episode_number < expected ? next.season_number : null;
}

/**
 * @param {object} tv TMDB /tv/{id} payload
 * @param {Date} now
 * @param {object[]} [seasonEpisodes] episodes of `staleSeasonToLookUp(tv, now)`, if it asked for them
 */
function computeSeriesTag(tv, now, seasonEpisodes) {
    if (!tv) return 'none';
    let lastEp = tv.last_episode_to_air || null;
    let nextEp = tv.next_episode_to_air || null;

    if (airedBy(nextEp, now)) {
        // "Next" has already aired, so it is really (at most) the latest episode.
        if (Array.isArray(seasonEpisodes)) {
            const aired = seasonEpisodes.filter((ep) => airedBy(ep, now));
            const latest = aired[aired.length - 1];
            if (latest && latest.episode_number > nextEp.episode_number) nextEp = latest;
        }
        lastEp = nextEp;
        nextEp = null;
    }

    const firstAir = parseLocal(tv.first_air_date);
    const lastAir = lastEp?.air_date ? parseLocal(lastEp.air_date) : parseLocal(tv.last_air_date);

    // Something premieres soon (new series, or episode 1 of a new season)
    let futureDate = null;
    let brandNew = false;
    if (firstAir && firstAir > now) {
        futureDate = firstAir;
        brandNew = true;
    } else if (nextEp && nextEp.episode_number === 1) {
        futureDate = nextEp.air_date ? parseLocal(nextEp.air_date) : null;
    }
    if (futureDate) {
        if (diffDays(futureDate, now) <= WINDOW.comingSoonDate) return `coming_date_${dateToken(futureDate)}`;
        if (brandNew) return 'coming_soon';
    }

    // A finale is about to air
    const nextAir = nextEp?.air_date ? parseLocal(nextEp.air_date) : null;
    if (nextAir && nextAir > now && diffDays(nextAir, now) <= WINDOW.finaleAhead && isFinaleEpisode(tv, nextEp)) {
        return `finale_date_${dateToken(nextAir)}`;
    }

    const latestSeason = tv.seasons?.slice().reverse().find((s) => s.season_number > 0);
    const seasonAir = latestSeason?.air_date ? parseLocal(latestSeason.air_date) : null;
    const ended = isEnded(tv);
    const within = (d, days) => Boolean(d && d <= now && diffDays(now, d) <= days);

    if (within(firstAir, WINDOW.premiere)) return 'premiere';
    if (within(firstAir, WINDOW.newSeries)) return 'new_series';
    if (within(seasonAir, WINDOW.newSeason)) return 'new_season';
    if (lastEp && isFinaleEpisode(tv, lastEp, { guessWhenUnknown: !nextEp }) && within(lastAir, WINDOW.finaleAired)) {
        return ended ? 'series_finale' : 'season_finale';
    }
    if (within(lastAir, WINDOW.newEpisode)) return 'new_episode';
    if (ended && tv.number_of_seasons > 1 && within(lastAir, WINDOW.finalSeason)) return 'final_season';
    return 'none';
}

module.exports = {
    WINDOW,
    tagLabel,
    normalizeTag,
    computeMovieTag,
    computeSeriesTag,
    staleSeasonToLookUp,
    isFinaleEpisode,
};
