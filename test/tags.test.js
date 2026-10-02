'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMovieTag, computeSeriesTag, staleSeasonToLookUp, tagLabel, normalizeTag } = require('../src/tags');
const { parseLocal } = require('../src/dates');
const { deepFreeze } = require('../src/util');

const NOW = new Date('2026-09-29T12:00:00');
const day = (offset) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const at = (offset) => parseLocal(day(offset));

test('movie tags', async (t) => {
    const cases = [
        ['on disc within 14 days', { theatrical: at(-90), digital: at(-40), physical: at(-3) }, 'out_on_bluray'],
        ['disc wins over digital', { theatrical: at(-90), digital: at(-2), physical: at(-1) }, 'out_on_bluray'],
        ['digital after a cinema run', { theatrical: at(-60), digital: at(-5), physical: null }, 'just_added'],
        ['digital-first release', { theatrical: null, digital: at(-5), physical: null }, 'now_streaming'],
        ['digital today', { theatrical: at(-30), digital: at(0), physical: null }, 'just_added'],
        ['digital in 3 days', { theatrical: at(-30), digital: at(3), physical: null }, 'coming_date_Oct_2'],
        ['digital in exactly 14 days', { theatrical: at(-30), digital: at(14), physical: null }, 'coming_date_Oct_13'],
        ['digital in 15+ days', { theatrical: at(-30), digital: at(40), physical: null }, 'coming_soon'],
        ['digital long ago', { theatrical: at(-300), digital: at(-200), physical: null }, 'none'],
        ['still in cinemas, no digital date', { theatrical: at(-20), digital: null, physical: null }, 'coming_soon'],
        ['no dates at all', { theatrical: null, digital: null, physical: null }, 'coming_soon'],
        // The two intentional fixes:
        ['already on disc (>14d), no digital date', { theatrical: at(-200), digital: null, physical: at(-100) }, 'none'],
        ['decades-old film with sparse metadata', { theatrical: parseLocal('1994-09-23'), digital: null, physical: null }, 'none'],
        ['cinema run just under the cut-off', { theatrical: at(-364), digital: null, physical: null }, 'coming_soon'],
    ];
    for (const [name, releases, expected] of cases) {
        await t.test(name, () => assert.equal(computeMovieTag(releases, NOW), expected));
    }
    await t.test('missing release info', () => assert.equal(computeMovieTag(null, NOW), 'none'));
});

const tv = (o = {}) => deepFreeze({
    first_air_date: day(-400),
    last_air_date: day(-100),
    status: 'Returning Series',
    number_of_seasons: 2,
    seasons: [{ season_number: 1, air_date: day(-400), episode_count: 8 }, { season_number: 2, air_date: day(-200), episode_count: 8 }],
    last_episode_to_air: { season_number: 2, episode_number: 5, air_date: day(-100), episode_type: 'standard' },
    next_episode_to_air: null,
    ...o,
});

test('series tags', async (t) => {
    const ep = (season, number, offset, type) => ({ season_number: season, episode_number: number, air_date: day(offset), ...(type ? { episode_type: type } : {}) });
    const cases = [
        ['nothing notable', tv(), 'none'],
        ['premiere (first episode this week)', tv({ first_air_date: day(-3), seasons: [{ season_number: 1, air_date: day(-3), episode_count: 8 }], number_of_seasons: 1, last_episode_to_air: ep(1, 1, -3, 'standard') }), 'premiere'],
        ['new series (aired 8 days ago)', tv({ first_air_date: day(-8), seasons: [{ season_number: 1, air_date: day(-8), episode_count: 8 }], number_of_seasons: 1, last_episode_to_air: ep(1, 2, -1, 'standard') }), 'new_series'],
        ['new season', tv({ seasons: [{ season_number: 1, air_date: day(-400), episode_count: 8 }, { season_number: 2, air_date: day(-10), episode_count: 8 }], last_episode_to_air: ep(2, 2, -3, 'standard') }), 'new_season'],
        ['new episode', tv({ last_episode_to_air: ep(2, 4, -2, 'standard') }), 'new_episode'],
        ['season finale', tv({ last_episode_to_air: ep(2, 8, -4, 'finale'), next_episode_to_air: null }), 'season_finale'],
        ['series finale', tv({ status: 'Ended', last_episode_to_air: ep(2, 8, -4, 'finale') }), 'series_finale'],
        ['final season (ended, last episode a while ago)', tv({ status: 'Ended', last_episode_to_air: ep(2, 6, -20, 'standard'), last_air_date: day(-20) }), 'final_season'],
        ['brand-new series far in the future', tv({ first_air_date: day(60), last_episode_to_air: null, last_air_date: null }), 'coming_soon'],
        ['brand-new series next week', tv({ first_air_date: day(6), last_episode_to_air: null, last_air_date: null }), 'coming_date_Oct_5'],
        ['episode 1 of a new season next week', tv({ next_episode_to_air: ep(3, 1, 5, 'standard') }), 'coming_date_Oct_4'],
        ['finale airing in 3 days', tv({ last_episode_to_air: ep(2, 6, -4, 'standard'), next_episode_to_air: ep(2, 8, 3, 'finale') }), 'finale_date_Oct_2'],
        ['finale detected from episode count', tv({ last_episode_to_air: ep(2, 6, -4), next_episode_to_air: ep(2, 8, 3) }), 'finale_date_Oct_2'],
        ['finale too far away to mention', tv({ last_episode_to_air: ep(2, 6, -20), next_episode_to_air: ep(2, 8, 12, 'finale') }), 'none'],
    ];
    for (const [name, data, expected] of cases) {
        await t.test(name, () => assert.equal(computeSeriesTag(data, NOW), expected));
    }

    await t.test('missing details', () => assert.equal(computeSeriesTag(null, NOW), 'none'));

    await t.test('TMDB left an already-aired "next" episode: season list finds the real latest', () => {
        const stale = tv({
            last_episode_to_air: ep(2, 3, -30, 'standard'),
            next_episode_to_air: ep(2, 4, -21, 'standard'), // aired long ago but never rolled forward
        });
        assert.equal(staleSeasonToLookUp(stale, NOW), 2);
        const episodes = [ep(2, 4, -21), ep(2, 5, -14), ep(2, 6, -7), ep(2, 7, -1), ep(2, 8, 6)];
        assert.equal(computeSeriesTag(stale, NOW, episodes), 'new_episode'); // episode 7 aired yesterday
        assert.equal(computeSeriesTag(stale, NOW), 'none'); // without the season list we only know about ep 4
    });

    await t.test('no season lookup needed when next is in the future or is the last episode', () => {
        assert.equal(staleSeasonToLookUp(tv({ next_episode_to_air: ep(2, 6, 3) }), NOW), null);
        assert.equal(staleSeasonToLookUp(tv({ next_episode_to_air: ep(2, 8, -2) }), NOW), null);
        assert.equal(staleSeasonToLookUp(tv(), NOW), null);
    });

    await t.test('does not mutate frozen input', () => {
        const frozen = tv({ next_episode_to_air: ep(2, 4, -21) });
        assert.doesNotThrow(() => computeSeriesTag(frozen, NOW, [ep(2, 7, -1)]));
    });
});

test('tag labels only exist for known tags', async (t) => {
    await t.test('known tags', () => {
        assert.equal(tagLabel('just_added'), 'Just Added');
        assert.equal(tagLabel('out_on_bluray'), 'Now on Blu-ray');
        assert.equal(tagLabel('coming_date_Mar_5'), 'Coming Mar 5');
        assert.equal(tagLabel('finale_date_Dec_31'), 'Finale Dec 31');
    });
    await t.test('none and garbage give no label', () => {
        for (const bad of ['none', '', undefined, null, 42, ['coming_soon'], 'constructor', '__proto__', 'toString',
            'coming_date_Foo_1', 'coming_date_Mar_32', 'coming_date_Mar_0', 'coming_date_Mar_5_extra',
            'coming_date_</text><image>_1', 'coming_date_Mar_5 ', 'Coming Soon']) {
            assert.equal(tagLabel(bad), null, `label for ${JSON.stringify(bad)}`);
            assert.equal(normalizeTag(bad), 'none');
        }
    });
    await t.test('normalizeTag keeps valid tags', () => {
        assert.equal(normalizeTag('coming_soon'), 'coming_soon');
        assert.equal(normalizeTag('coming_date_Oct_2'), 'coming_date_Oct_2');
    });
});
