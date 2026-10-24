const fs = require('node:fs');
const path = require('node:path');

/**
 * Which commands exist, per server (and globally).
 *
 * A command is OFF when it is in the global `disabled` list and not in that
 * guild's `enabled` override list, or when it is in the guild's own `disabled`
 * list. Owner-only commands can't be disabled by a guild admin through the
 * portal — only the bot owner's global toggles touch them (see `setGuild`).
 *
 * The bot enforces this in bot.js `runCommand`, help.js hides them, and the
 * web portal flips them. Slash registrations are re-synced after a change so
 * a disabled command disappears from Discord's picker too (best effort — see
 * the resync callback the portal wires up).
 *
 * Shape on disk:
 *   { disabled: [names], guilds: { guildId: { disabled: [], enabled: [] } } }
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'command-toggles.json');

/** @type {{disabled: Set<string>, guilds: Map<string, {disabled: Set<string>, enabled: Set<string>}>}} */
const state = { disabled: new Set(), guilds: new Map() };

function keyList(value) {
    return Array.isArray(value) ? value.map(v => String(v).toLowerCase()).filter(Boolean) : [];
}

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        state.disabled = new Set(keyList(raw?.disabled));
        state.guilds = new Map(
            Object.entries(raw?.guilds ?? {}).map(([gid, g]) => [
                String(gid),
                { disabled: new Set(keyList(g?.disabled)), enabled: new Set(keyList(g?.enabled)) },
            ]),
        );
    } catch {
        state.disabled = new Set();
        state.guilds = new Map();
    }
}

function persist() {
    const obj = {
        disabled: [...state.disabled].sort(),
        guilds: Object.fromEntries([...state.guilds].map(([gid, g]) => [
            gid,
            { disabled: [...g.disabled].sort(), enabled: [...g.enabled].sort() },
        ])),
    };
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[commandToggles] could not save: ${err.message}`);
    }
}

function guildEntry(guildId, create = false) {
    const key = String(guildId);
    let entry = state.guilds.get(key);
    if (!entry && create) state.guilds.set(key, (entry = { disabled: new Set(), enabled: new Set() }));
    return entry;
}

/** False when the command should not run in this guild (null guild = DM/global view). */
function enabled(name, guildId = null) {
    const key = String(name ?? '').toLowerCase();
    if (!key) return false;
    const entry = guildId ? state.guilds.get(String(guildId)) : null;
    if (entry?.enabled.has(key)) return true;
    if (entry?.disabled.has(key)) return false;
    return !state.disabled.has(key);
}

/** Global on/off. `true` = enabled. */
function setGlobal(name, on) {
    const key = String(name ?? '').toLowerCase();
    if (!key) throw new Error('command name required');
    if (on) state.disabled.delete(key);
    else state.disabled.add(key);
    persist();
}

/**
 * Per-guild override. Pass `null` to clear the override so the global toggle
 * applies again. `ownerOnly` commands ignore guild-level overrides entirely.
 */
function setGuild(guildId, name, on, { ownerOnly = false } = {}) {
    if (ownerOnly) return; // guild admins do not get to switch off owner commands
    const key = String(name ?? '').toLowerCase();
    if (!key) throw new Error('command name required');
    const entry = guildEntry(guildId, true);
    entry.disabled.delete(key);
    entry.enabled.delete(key);
    if (on === true) entry.enabled.add(key);
    else if (on === false) entry.disabled.add(key);
    persist();
}

/** Everything the portal needs to render the toggles for one guild. */
function view(names, guildId = null) {
    const entry = guildId ? state.guilds.get(String(guildId)) : null;
    return names.map(name => {
        const key = String(name).toLowerCase();
        return {
            name: key,
            globalOff: state.disabled.has(key),
            guildOverride: entry?.enabled.has(key) ? 'on' : entry?.disabled.has(key) ? 'off' : null,
            enabled: enabled(key, guildId),
        };
    });
}

function clearGuild(guildId) {
    state.guilds.delete(String(guildId));
    persist();
}

load();

module.exports = { FILE, DATA_DIR, load, enabled, setGlobal, setGuild, view, clearGuild };
