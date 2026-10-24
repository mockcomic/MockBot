const fs = require('node:fs');
const path = require('node:path');

/**
 * Per-guild settings, stored under data/guilds.json.
 *
 * Keys per guild (missing means "use the default / global config"):
 *   prefix            - per-guild command prefix (null = config.prefix)
 *   twentyFourSeven   - never auto-leave voice on idle
 *   autoplay          - queue a related song when the queue ends
 *   voteSkip          - null = follow config.music.voteSkipEnabled
 *   modlogChannelId   - channel moderation actions are logged to
 *
 * Same DATA_DIR discipline as feedbackStore; writes are atomic (tmp + rename)
 * so a crash mid-write can never leave a half-written settings file.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'guilds.json');

const DEFAULTS = Object.freeze({
    prefix: null,
    twentyFourSeven: false,
    autoplay: null,
    voteSkip: null,
    modlogChannelId: null,
    // v3.4: welcome + auto-role
    welcomeChannelId: null,
    welcomeMessage: null,   // null = global default; supports {member} {guild} {count}
    autoRoleIds: null,      // array of role ids, or null
    // v3.4: music controls
    djRoleId: null,         // null = no DJ role required (voice-channel rule only)
    musicChannelId: null,   // null = play from any text channel
    sponsorBlock: null,     // null = follow config.music.sponsorBlockByDefault
});

/** @type {Map<string, object>|null} */
let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        cache = new Map(
            Object.entries(raw?.guilds ?? {}).map(([id, s]) => [String(id), { ...DEFAULTS, ...s }]),
        );
    } catch {
        cache = new Map();
    }
    return cache;
}

function persist() {
    const obj = Object.fromEntries([...load()].map(([id, s]) => [id, s]));
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ guilds: obj }, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[guildSettings] could not save: ${err.message}`);
    }
}

/** Merged view for a guild — always a full shape, never undefined fields. */
function get(guildId) {
    return { ...DEFAULTS, ...(load().get(String(guildId)) ?? {}) };
}

/** Shallow-merge a partial into a guild's settings and save. */
function patch(guildId, partial) {
    const map = load();
    const key = String(guildId);
    const next = { ...map.get(key), ...partial };
    map.set(key, next);
    persist();
    return next;
}

/** Drop every override for a guild (back to global defaults). */
function reset(guildId) {
    const map = load();
    map.delete(String(guildId));
    persist();
}

module.exports = { FILE, DATA_DIR, DEFAULTS, get, patch, reset, load, persist };
