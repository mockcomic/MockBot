const fs = require('node:fs');
const path = require('node:path');

/**
 * Play history for the portal's Overview tab.
 *
 * Two views from one compact record set:
 *   - "recently played": last RECENT entries, newest first
 *   - "most played":     per-track play counts
 *   - "most skipped":    tracks whose playback ended before SKIP_RATIO of the
 *                        song was heard (a natural skip at the end never
 *                        counts; live streams are ignored entirely)
 *
 * Like lib/usage.js: counters in memory, flushed to DATA_DIR/history.json
 * every FLUSH_MS when dirty, so the hot path (every song!) never touches
 * disk. The recent list is a capped ring; counts are capped at MAX_TRACKED
 * distinct tracks. Worst case on a crash: the last flush window of plays.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'history.json');
const FLUSH_MS = 30_000;
const RECENT = 100;
const MAX_TRACKED = 2000;
const SKIP_RATIO = 0.5;

/** @type {Array<{url: string, name: string, guild: string, by: string|null, ts: number}>} */
let recent = [];
/** @type {Map<string, {name: string, plays: number, skips: number}>} */
const tracks = new Map();
let dirty = false;

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (Array.isArray(raw?.recent)) {
            recent = raw.recent
                .filter(r => r && r.url && r.ts)
                .slice(0, RECENT);
        }
        for (const [url, t] of Object.entries(raw?.tracks ?? {})) {
            if (tracks.size >= MAX_TRACKED) break;
            if (t && Number.isFinite(t.plays)) tracks.set(url, { name: String(t.name ?? 'Unknown'), plays: t.plays, skips: Number(t.skips) || 0 });
        }
    } catch {
        /* fresh counters */
    }
}

function persist() {
    if (!dirty) return;
    dirty = false;
    const obj = { recent, tracks: Object.fromEntries(tracks) };
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[history] could not save: ${err.message}`);
    }
}

function keyOf(song) {
    const url = String(song?.url ?? '');
    return url || `name:${String(song?.name ?? 'unknown').toLowerCase()}`;
}

/** @type {Map<string, {url: string, startedAt: number, duration: number, isLive: boolean}>} guildId -> the song playing right now */
const active = new Map();

/**
 * Close out the song that was playing in one guild using wall-clock play
 * time: under SKIP_RATIO of the track means it was skipped — by vote, button,
 * jump or moving on, by any name. A long pause counts as listened-to; the
 * ratio is coarse on purpose.
 */
function closeActive(guildId, forceSkip = false) {
    const entry = active.get(String(guildId));
    if (!entry) return;
    active.delete(String(guildId));
    const t = tracks.get(entry.url);
    if (!t) return;
    const total = Math.floor(entry.duration);
    const heard = (Date.now() - entry.startedAt) / 1000;
    if (!entry.isLive && (forceSkip || (total > 10 && heard < total * SKIP_RATIO))) {
        t.skips += 1;
        dirty = true;
    }
}

/** Called from the playSong event — every song that starts, wherever it came from. */
function recordPlay(queue, song) {
    closeActive(queue?.id); // the previous song in this guild just gave way
    if (!song || String(song.source ?? '').toLowerCase() === 'file') return; // sfx clips are noise
    active.set(String(queue?.id ?? 'unknown'), {
        url: keyOf(song),
        startedAt: Date.now(),
        duration: song.duration ?? 0,
        isLive: Boolean(song.isLive),
    });
    const url = keyOf(song);
    recent.unshift({
        url: typeof song.url === 'string' ? song.url : null,
        name: String(song.name ?? 'Unknown').slice(0, 120),
        guild: String(queue?.textChannel?.guild?.name ?? queue?.id ?? 'unknown'),
        by: song.user?.tag ?? song.user?.id ?? null,
        ts: Date.now(),
    });
    if (recent.length > RECENT) recent.length = RECENT;

    const t = tracks.get(url) ?? { name: String(song.name ?? 'Unknown').slice(0, 120), plays: 0, skips: 0 };
    if (!tracks.has(url) && tracks.size >= MAX_TRACKED) return; // cap reached: still keep `recent`
    t.plays += 1;
    tracks.set(url, t);
    dirty = true;
}

/**
 * Called from finishSong: the queue moved on by itself — normal ending or
 * early death, closeActive decides by ratio.
 */
function recordFinish(queue, song) {
    closeActive(queue?.id);
}

/** Called from stop/disconnect: a song cut off mid-play counts as skipped. */
function recordAbandon(queue) {
    closeActive(queue?.id, true);
}

function recentPlays(n = 15) {
    return recent.slice(0, n);
}

function top(n = 10, field = 'plays') {
    return [...tracks.entries()]
        .map(([url, t]) => ({ url, name: t.name, plays: t.plays, skips: t.skips }))
        .filter(r => (field === 'skips' ? r.skips : r.plays) > 0)
        .sort((a, b) => b[field] - a[field])
        .slice(0, n);
}

load();
const flush = setInterval(persist, FLUSH_MS);
flush.unref();
process.on('exit', persist);

module.exports = { FILE, DATA_DIR, recordPlay, recordFinish, recordAbandon, recentPlays, top, persist, load };
