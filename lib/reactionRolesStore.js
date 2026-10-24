const fs = require('node:fs');
const path = require('node:path');

/**
 * Which messages count as reaction-role menus.
 *
 * Without this, any message in the configured channel carrying a configured
 * emoji would assign roles — a plain "1️⃣" reaction from someone else's poll
 * granted the HOTS role. Only menus this bot posted are honoured.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'reaction-roles.json');
const MAX_IDS = 25;

/** @type {Set<string>|null} */
let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        cache = new Set(Array.isArray(raw?.messageIds) ? raw.messageIds.map(String) : []);
    } catch {
        cache = new Set();
    }
    return cache;
}

/** Best-effort write: losing the file only means menus must be re-posted. */
function persist(ids) {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify({ messageIds: [...ids].slice(-MAX_IDS) }, null, 4), 'utf8');
    } catch (err) {
        console.warn(`[reactionRoles] could not save menu ids: ${err.message}`);
    }
}

function isManaged(messageId) {
    return load().has(String(messageId));
}

/** Remember a message this bot just posted as a reaction-role menu. */
function record(messageId) {
    const ids = load();
    ids.add(String(messageId));
    // Trim to the newest MAX_IDS while preserving order.
    if (ids.size > MAX_IDS) {
        for (const old of [...ids].slice(0, ids.size - MAX_IDS)) ids.delete(old);
    }
    persist(ids);
    return ids.size;
}

module.exports = { FILE, isManaged, record, load };
