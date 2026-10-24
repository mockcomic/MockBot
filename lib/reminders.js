const fs = require('node:fs');
const path = require('node:path');
const { clip } = require('./respond');
const { formatDurationMs } = require('./duration');

/**
 * Persistent reminders → data/reminders.json.
 *
 * The bot already lives on an always-on machine and owns its restart flow
 * (`update` + `reboot`), so reminders must survive both: everything is stored
 * with absolute timestamps and re-armed at startup — anything whose moment
 * passed while the bot was down is delivered immediately, marked overdue.
 *
 * One unref'd timer points at the soonest reminder; after each batch the next
 * one is scheduled. A reminder whose channel vanished falls back to a DM; if
 * that fails too it is dropped (with a console note) rather than retried
 * forever.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'reminders.json');

const MIN_MS = 60 * 1000; // one minute ahead of now
const MAX_MS = 30 * 24 * 60 * 60 * 1000; // Discord-message horizon: a month
const MAX_PER_USER = 25;

/** @type {Array<object>|null} */
let items = null;
let timer = null;

function load() {
    if (items) return items;
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        items = (Array.isArray(raw?.reminders) ? raw.reminders : [])
            .filter(r => r && r.id && r.userId && Number.isFinite(r.at) && Number.isFinite(r.createdAt));
    } catch {
        items = [];
    }
    return items;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ reminders: load() }, null, 4), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[reminders] could not save: ${err.message}`);
    }
}

function nextId() {
    const ids = new Set(load().map(r => r.id));
    let id;
    do {
        id = Math.random().toString(36).slice(2, 8);
    } while (ids.has(id));
    return id;
}

/**
 * @returns {{ok: true, reminder} | {ok: false, error: string}}
 */
function add({ guildId, channelId, userId, text, at }) {
    const now = Date.now();
    const inMs = at - now;
    if (!Number.isFinite(at)) return { ok: false, error: 'That target time is not valid.' };
    if (inMs < MIN_MS / 2) return { ok: false, error: 'Reminders must be at least a minute out.' };
    if (inMs > MAX_MS) return { ok: false, error: 'Reminders can be set at most 30 days ahead.' };

    const list = load();
    const mine = list.filter(r => r.userId === String(userId) && r.guildId === String(guildId)).length;
    if (mine >= MAX_PER_USER) {
        return { ok: false, error: `You already have ${MAX_PER_USER} reminders in this server — cancel one first.` };
    }

    const reminder = {
        id: nextId(),
        guildId: String(guildId),
        channelId: String(channelId),
        userId: String(userId),
        text: clip(String(text ?? '').trim(), 500),
        at,
        createdAt: now,
    };
    list.push(reminder);
    persist();
    return { ok: true, reminder };
}

function listFor(guildId, userId) {
    return load()
        .filter(r => r.guildId === String(guildId) && r.userId === String(userId))
        .sort((a, b) => a.at - b.at);
}

/** @returns {boolean} whether an id existed and was removed (ownership checked by the caller). */
function cancel(id) {
    const list = load();
    const index = list.findIndex(r => r.id === String(id));
    if (index === -1) return false;
    list.splice(index, 1);
    persist();
    return true;
}

function find(id) {
    return load().find(r => r.id === String(id)) ?? null;
}

async function deliver(client, r, overdue) {
    const age = ` — set ${formatDurationMs(Date.now() - r.createdAt)} ago`;
    const body = `⏰${overdue ? ' (overdue)' : ''} Reminder for <@${r.userId}>: ${clip(r.text, 500)}${age}`;

    const guild = client.guilds.cache.get(r.guildId);
    const channel =
        (guild ? client.channels.cache.get(r.channelId) : null) ??
        (guild ? await guild.channels.fetch(r.channelId).catch(() => null) : null);
    if (channel && typeof channel.send === 'function') {
        await channel.send({ content: body }).catch(() => null);
        return true;
    }

    const user = await client.users.fetch(r.userId).catch(() => null);
    if (user) {
        await user.send({ content: body }).catch(() => null);
        return true;
    }
    return false;
}

/** Send everything due (also used directly by the smoke test). Returns the count. */
async function fireDue(client, now = Date.now()) {
    const due = load().filter(r => r.at <= now).sort((a, b) => a.at - b.at);
    if (!due.length) return 0;

    const list = load();
    let delivered = 0;
    for (const r of due) {
        const index = list.indexOf(r);
        if (index === -1) continue; // cancelled while awaiting the API
        list.splice(index, 1); // consumed either way — never re-fire a loop
        const ok = await deliver(client, r, r.at < now - 60_000).catch(() => false);
        if (ok) delivered += 1;
        else console.warn(`[reminders] could not deliver ${r.id} to ${r.userId}`);
    }
    persist();
    return delivered;
}

function scheduleNext(client) {
    if (timer) clearTimeout(timer);
    timer = null;
    const list = load();
    if (!list.length) return;
    const soonest = Math.min(...list.map(r => r.at));
    const delay = Math.min(Math.max(soonest - Date.now(), 1000), 2 ** 31 - 2);
    timer = setTimeout(() => {
        fireDue(client)
            .catch(err => console.error('[reminders]', err))
            .finally(() => scheduleNext(client));
    }, delay);
    timer.unref?.();
}

/** Deliver anything that came due while the bot was down, then arm. */
function start(client) {
    fireDue(client)
        .catch(err => console.error('[reminders]', err))
        .finally(() => scheduleNext(client));
}

function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
}

module.exports = {
    FILE,
    DATA_DIR,
    MIN_MS,
    MAX_MS,
    MAX_PER_USER,
    load,
    add,
    listFor,
    cancel,
    find,
    fireDue,
    start,
    stop,
    scheduleNext,
};
