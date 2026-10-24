const fs = require('node:fs');
const path = require('node:path');

/**
 * Command usage counters, per guild and overall.
 *
 * Kept in memory for O(1) recording on every command, flushed to
 * DATA_DIR/usage.json every 30 s when dirty (atomic tmp+rename like the other
 * stores) so a restart does not lose the picture. Worst case on a crash: the
 * last 30 seconds of activity.
 *
 * Shape on disk: { "all": {name: count}, "guilds": {guildId: {name: count}} }
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'usage.json');
const FLUSH_MS = 30_000;
const MAX_TRACKED = 500; // safety cap on distinct guild keys

/** @type {{all: Map<string, number>, guilds: Map<string, Map<string, number>>}} */
const all = new Map();
const guilds = new Map();
let dirty = false;

function bump(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const [name, n] of Object.entries(raw?.all ?? {})) {
            if (Number.isFinite(n) && n > 0) bump(all, String(name));
        }
        for (const [gid, counts] of Object.entries(raw?.guilds ?? {})) {
            if (guilds.size >= MAX_TRACKED) break;
            const g = new Map();
            for (const [name, n] of Object.entries(counts ?? {})) {
                if (Number.isFinite(n) && n > 0) bump(g, String(name));
            }
            if (g.size) guilds.set(String(gid), g);
        }
    } catch {
        // missing or corrupt file simply starts the counts from zero
    }
}

function persist() {
    if (!dirty) return;
    dirty = false;
    const obj = {
        all: Object.fromEntries(all),
        guilds: Object.fromEntries([...guilds].map(([gid, m]) => [gid, Object.fromEntries(m)])),
    };
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[usage] could not save: ${err.message}`);
    }
}

/** Record one execution of `name` for `guildId`. */
function record(guildId, name) {
    const key = String(name ?? '').toLowerCase();
    if (!key) return;
    bump(all, key);
    if (guildId) {
        const gid = String(guildId);
        let g = guilds.get(gid);
        if (!g) {
            if (guilds.size >= MAX_TRACKED) return;
            guilds.set(gid, (g = new Map()));
        }
        bump(g, key);
    }
    dirty = true;
}

/** Top-n [{name, count}] for a guild, or overall when guildId is null. */
function top(guildId, n = 10) {
    const source = guildId ? guilds.get(String(guildId)) : all;
    return [...(source ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, count]) => ({ name, count }));
}

/** Total executions of one command overall, or in one guild when given. */
function total(name, guildId = null) {
    const key = String(name ?? '').toLowerCase();
    if (!guildId) return all.get(key) ?? 0;
    return guilds.get(String(guildId))?.get(key) ?? 0;
}

/** Total executions of anything, anywhere. */
function grandTotal() {
    let sum = 0;
    for (const n of all.values()) sum += n;
    return sum;
}

/** Forget one guild's counts (e.g. settings reset). */
function clearGuild(guildId) {
    guilds.delete(String(guildId));
    dirty = true;
    persist();
}

load();
const flush = setInterval(persist, FLUSH_MS);
flush.unref(); // never keep the process alive
process.on('exit', persist);

module.exports = { FILE, DATA_DIR, record, top, total, grandTotal, clearGuild, persist };
