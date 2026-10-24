const fs = require('node:fs');
const path = require('node:path');

/**
 * Which messages count as reaction-role menus.
 *
 * Without this, any message carrying a configured emoji would assign roles —
 * a plain "1️⃣" reaction from someone else's poll granted the HOTS role. Only
 * menus this bot posted are honoured.
 *
 * Schema v2 is per-guild aware (`{ menus: [{messageId, channelId, guildId}] }`)
 * so the listener can trust a menu without a single globally-configured
 * channel. The v1 shape (`{ messageIds: [...] }`) is migrated on load — the
 * channel/guild of old menus is not remembered, and messageId is the security
 * property, so a migrated entry is treated as valid wherever it is found.
 *
 * v3 adds `roleIds` per menu: the exact roles the select menu may toggle.
 * Select values come from the client, so they are validated against this list
 * — without it, a forged value could ask for any role in the guild.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'reaction-roles.json');
const MAX_MENUS = 200;

/** @type {Array<{messageId: string, channelId: string|null, guildId: string|null}>|null} */
let entries = null;
/** @type {Set<string>|null} */
let ids = null;

function parse(rawText) {
    let raw;
    try {
        raw = JSON.parse(rawText);
    } catch {
        return [];
    }
    if (Array.isArray(raw?.menus)) {
        return raw.menus
            .filter(m => m && m.messageId)
            .map(m => ({
                messageId: String(m.messageId),
                channelId: m.channelId ? String(m.channelId) : null,
                guildId: m.guildId ? String(m.guildId) : null,
                roleIds: Array.isArray(m.roleIds) ? m.roleIds.map(String) : null,
            }));
    }
    if (Array.isArray(raw?.messageIds)) {
        // v1 → v2 migration; persisted on the next record().
        return raw.messageIds.map(id => ({ messageId: String(id), channelId: null, guildId: null }));
    }
    return [];
}

function load() {
    if (entries) return entries;
    try {
        entries = parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        entries = [];
    }
    ids = new Set(entries.map(e => e.messageId));
    return entries;
}

/** Best-effort write: losing the file only means menus must be re-posted. */
function persist() {
    const list = load().slice(-MAX_MENUS);
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ menus: list }, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[reactionRoles] could not save menu ids: ${err.message}`);
    }
}

function isManaged(messageId) {
    return load() && ids.has(String(messageId));
}

/** Remember a message this bot just posted as a reaction-role menu. */
function record(messageId, { channelId = null, guildId = null, roleIds = null } = {}) {
    const list = load();
    const key = String(messageId);
    if (!ids.has(key)) {
        list.push({
            messageId: key,
            channelId: channelId ? String(channelId) : null,
            guildId: guildId ? String(guildId) : null,
            roleIds: Array.isArray(roleIds) && roleIds.length ? roleIds.map(String) : null,
        });
        ids.add(key);
        if (list.length > MAX_MENUS) {
            const trimmed = list.splice(0, list.length - MAX_MENUS);
            for (const old of trimmed) ids.delete(old.messageId);
        }
    }
    persist();
    return ids.size;
}

/** The stored entry for a menu message (null when this bot never posted it). */
function entry(messageId) {
    return load().find(e => e.messageId === String(messageId)) ?? null;
}

module.exports = { FILE, isManaged, entry, record, load, persist, parse };
