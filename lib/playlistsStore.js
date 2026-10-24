const fs = require('node:fs');
const path = require('node:path');
const { clip } = require('./respond');

/**
 * Saved queues → data/playlists.json.
 *
 * A playlist stores the minimum needed to rebuild DisTube Song objects
 * without any yt-dlp round-trips: the url (streams resolve at play time),
 * the display name, duration and thumbnail. Songs are trimmed to
 * MAX_SONGS and each guild may keep MAX_PLAYLISTS lists.
 *
 * Names are matched case-insensitively; the display name keeps its case.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'playlists.json');

const MAX_SONGS = 200;
const MAX_PLAYLISTS = 20;
const NAME_RE = /^[\w -]{1,32}$/;

/** @type {Map<string, Map<string, object>>|null} guildId → (key → playlist) */
let cache = null;

function load() {
    if (cache) return cache;
    cache = new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const [guildId, lists] of Object.entries(raw?.playlists ?? {})) {
            const map = new Map();
            for (const [key, list] of Object.entries(lists ?? {})) {
                if (Array.isArray(list?.songs) && list.songs.length) map.set(key, list);
            }
            if (map.size) cache.set(String(guildId), map);
        }
    } catch {
        /* no file yet */
    }
    return cache;
}

function persist() {
    const obj = {};
    for (const [guildId, map] of load()) {
        obj[guildId] = Object.fromEntries(map);
    }
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ playlists: obj }, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[playlists] could not save: ${err.message}`);
    }
}

function keyOf(name) {
    return String(name ?? '').trim().toLowerCase();
}

/** Accepts DisTube Songs or bare url strings; keeps the record small. */
function normalizeSong(song) {
    if (typeof song === 'string') {
        return { url: song, name: clip(song, 120), duration: 0, thumbnail: null };
    }
    if (!song?.url) return null;
    return {
        url: String(song.url),
        name: clip(song.name ?? song.url, 200),
        duration: Number.isFinite(song.duration) ? song.duration : 0,
        thumbnail: song.thumbnail ?? null,
    };
}

/** @returns {{ok: true, playlist} | {ok: false, error: string}} */
function save(guildId, name, songs, { replace = false } = {}) {
    const key = keyOf(name);
    if (!NAME_RE.test(key)) {
        return { ok: false, error: 'Playlist names are up to 32 characters: letters, numbers, spaces, `-` and `_`.' };
    }
    const normalized = songs.map(normalizeSong).filter(Boolean).slice(0, MAX_SONGS);
    if (!normalized.length) return { ok: false, error: 'Nothing to save — no playable urls in that queue.' };

    const byGuild = load();
    const guildKey = String(guildId);
    const map = byGuild.get(guildKey) ?? new Map();
    if (map.has(key) && !replace) {
        return { ok: false, error: `\`${name}\` already exists — save again with \`replace\` to overwrite it.` };
    }
    if (!map.has(key) && map.size >= MAX_PLAYLISTS) {
        return { ok: false, error: `This server already stores ${MAX_PLAYLISTS} playlists — delete one first.` };
    }

    const existing = map.get(key);
    const now = new Date().toISOString();
    const playlist = {
        name: String(name).trim(),
        songs: normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    map.set(key, playlist);
    byGuild.set(guildKey, map);
    persist();
    return { ok: true, playlist };
}

function get(guildId, name) {
    return load().get(String(guildId))?.get(keyOf(name)) ?? null;
}

/** @returns {Array<{name, songs: number, updatedAt}>} */
function list(guildId) {
    const map = load().get(String(guildId));
    if (!map) return [];
    return [...map.values()]
        .map(p => ({ name: p.name, songs: p.songs.length, updatedAt: p.updatedAt }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function remove(guildId, name) {
    const map = load().get(String(guildId));
    if (!map?.delete(keyOf(name))) return false;
    if (!map.size) load().delete(String(guildId));
    persist();
    return true;
}

module.exports = {
    FILE,
    DATA_DIR,
    MAX_SONGS,
    MAX_PLAYLISTS,
    NAME_RE,
    load,
    persist,
    save,
    get,
    list,
    remove,
    normalizeSong,
    keyOf,
};
