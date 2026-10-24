/**
 * Human duration parsing for `remind` and `timeout`.
 *
 * Combinations of `<number><unit>` tokens, case-insensitive, longest-first
 * is not required — units are summed, so "2h30m" and "30m2h" both mean
 * 2 hours 30 minutes. Units: w (week), d, h, m, s.
 *
 * A bare number ("10") is deliberately rejected: `seek` already owns the
 * seconds/mm:ss grammar, and silently picking a unit here would make
 * `remind 30 ...` mean "in 30 of something unknown".
 *
 * @param {string} value
 * @returns {number|null} milliseconds, or null when unparseable
 */
const TOKEN = /(\d{1,4})([wdhms])/gi;
const UNIT_MS = {
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
};

function parseHumanDuration(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return null;

    let total = 0;
    let consumed = 0;
    let match;
    TOKEN.lastIndex = 0;
    while ((match = TOKEN.exec(text)) !== null) {
        if (match.index !== consumed) return null; // gap or stray characters
        consumed = match.index + match[0].length;
        total += Number.parseInt(match[1], 10) * UNIT_MS[match[2]];
    }
    if (consumed !== text.length) return null; // trailing junk / unit-less
    return total > 0 ? total : null;
}

/** `90000` -> `1m 30s`, `86400000` -> `1d` — for echoing durations back. */
function formatDurationMs(ms) {
    const parts = [];
    let rest = Math.max(0, Math.floor(ms));
    for (const unit of ['w', 'd', 'h', 'm', 's']) {
        const size = UNIT_MS[unit];
        const n = Math.floor(rest / size);
        if (n) {
            parts.push(`${n}${unit}`);
            rest -= n * size;
        }
    }
    return parts.join(' ') || '0s';
}

module.exports = { parseHumanDuration, formatDurationMs, UNIT_MS };
