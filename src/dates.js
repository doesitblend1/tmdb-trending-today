'use strict';

const MS_PER_DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "YYYY-MM-DD" -> local midnight (TMDB gives calendar dates, not instants). Returns null when missing or invalid. */
function parseLocal(str) {
    if (!str || typeof str !== 'string') return null;
    const d = new Date(str.length === 10 ? `${str}T00:00:00` : str);
    return Number.isNaN(d.getTime()) ? null : d;
}

const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

/** Whole calendar days between two dates, ignoring time of day. Always >= 0. */
function diffDays(a, b) {
    return Math.round(Math.abs(startOfDay(a) - startOfDay(b)) / MS_PER_DAY);
}

/** "Mar_5": the form embedded in coming_date_* / finale_date_* tags. */
const dateToken = (d) => `${MONTHS[d.getMonth()]}_${d.getDate()}`;

module.exports = { MONTHS, parseLocal, diffDays, dateToken };
