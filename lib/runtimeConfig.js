const fs = require('node:fs');
const path = require('node:path');

/**
 * Runtime-editable view of config.json.
 *
 * Overrides live in DATA_DIR/runtime-config.json and are applied ON TOP of the
 * shipped config.json. The merged values are written back INTO the original
 * config object (in place), so every module that captured `config` at boot —
 * bot.js, voiceIdle, reactionRoles, the command runner — sees edits from the
 * web portal without a restart, as long as they read the field at use time
 * rather than copying it into a constant.
 *
 * Anything not present in the override file keeps its config.json value.
 * Setting an override to `null` removes it (the shipped default returns).
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'runtime-config.json');

/** @type {object} the config.json object we mutate */
let base = null;
/** @type {object} dot-path -> value */
let overrides = {};

function loadOverrides() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        overrides = {};
    }
    return overrides;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(overrides, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[runtimeConfig] could not save: ${err.message}`);
    }
}

/** Write one dot-path of `obj` with plain nested objects, deleting on undefined. */
function deepSet(obj, dotted, value) {
    const parts = dotted.split('.');
    let node = obj;
    for (const part of parts.slice(0, -1)) {
        if (typeof node[part] !== 'object' || node[part] === null || Array.isArray(node[part])) node[part] = {};
        node = node[part];
    }
    const last = parts.at(-1);
    if (value === null || value === undefined) delete node[last];
    else node[last] = value;
    return obj;
}

/** Rebuild the live config object from config.json + overrides. */
function apply() {
    if (!base) return null; // init() has not run yet: overrides are persisted, applied at boot
    for (const key of Object.keys(base)) delete base[key];
    // A copy of the shipped file first...
    let merged;
    try {
        merged = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    } catch {
        merged = {};
    }
    // ...then every override path on top.
    for (const [dotted, value] of Object.entries(overrides)) {
        if (value === null || value === undefined) continue;
        deepSet(merged, dotted, value);
    }
    Object.assign(base, merged);
    return base;
}

/**
 * Install the runtime layer over the required config.json object. Call once
 * at boot with the object every module already holds.
 */
function init(configObject) {
    base = configObject;
    loadOverrides();
    return apply();
}

/**
 * Set or clear (value === null) one dot-path, e.g. 'music.leaveOnEmptyAfterSeconds'
 * or 'cooldowns.play' or 'prefix'. Returns the live config object.
 */
function set(dotted, value) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/i.test(String(dotted))) {
        throw new Error(`bad config path: ${dotted}`);
    }
    if (value === null || value === undefined) delete overrides[dotted];
    else overrides[dotted] = value;
    persist();
    return apply();
}

/** A plain copy of the active overrides (for the portal). */
function listOverrides() {
    return { ...overrides };
}

function get() {
    return base ?? {};
}

module.exports = { FILE, DATA_DIR, init, set, get, listOverrides, loadOverrides, apply };
