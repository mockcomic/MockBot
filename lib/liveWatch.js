const fs = require('node:fs');
const path = require('node:path');

/**
 * Live-stream announcements (Twitch + YouTube channels).
 *
 * `!watch add <channel>` stores a streamer; every POLL_MS the poller checks
 * each one and posts "LIVE" to the guild's announce channel the moment a
 * stream goes online (once per stream — the online flag is tracked, so a
 * brief API hiccup cannot double-post).
 *
 * APIs, all optional — the feature simply stays off without credentials:
 *   TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET  → app-token flow (client_credentials)
 *   GOOGLE_API_KEY                           → YouTube Data API v3 (free tier)
 * A GOOGLE_API_KEY + a channel HANDLER resolves via `forHandle`; a raw
 * UC… id works without any lookup.
 *
 * Data: DATA_DIR/watch.json  { watchers: [{platform, channel, guildId,
 * channelId, addedBy}], online: {"twitch:name": true} }
 * Writes are atomic like the other stores.
 */

const POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_WATCHERS = 200;

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'watch.json');

/** @type {{watchers: object[], online: Record<string, boolean>}|null} */
let state = null;
let timer = null;
let tickRunning = false;

function load() {
    if (state) return state;
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        state = {
            watchers: Array.isArray(raw?.watchers)
                ? raw.watchers.filter(w => w && w.platform && w.channel && w.guildId && w.channelId)
                : [],
            online: raw?.online && typeof raw.online === 'object' ? raw.online : {},
        };
    } catch {
        state = { watchers: [], online: {} };
    }
    return state;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[watch] could not save: ${err.message}`);
    }
}

function add(entry) {
    const s = load();
    const key = w => `${w.platform}|${String(w.channel).toLowerCase()}|${w.guildId}`;
    const shaped = { ...entry, channel: String(entry.channel).toLowerCase().replace(/^@/, '') };
    const existing = s.watchers.find(w => key(w) === key(shaped));
    if (existing) {
        Object.assign(existing, shaped, { addedBy: entry.addedBy ?? existing.addedBy });
        persist();
        return { ok: true, replaced: true, watcher: shaped };
    }
    if (s.watchers.length >= MAX_WATCHERS) return { ok: false, error: `The watch list is full (${MAX_WATCHERS}).` };
    s.watchers.push(shaped);
    persist();
    return { ok: true, watcher: shaped };
}

function remove({ platform, channel, guildId }) {
    const s = load();
    const before = s.watchers.length;
    const ch = String(channel).toLowerCase().replace(/^@/, '');
    s.watchers = s.watchers.filter(w =>
        !(w.platform === platform && String(w.channel).toLowerCase() === ch && (!guildId || w.guildId === guildId)));
    persist();
    return before - s.watchers.length;
}

function listFor(guildId) {
    return load().watchers.filter(w => w.guildId === String(guildId));
}

// --- Twitch -------------------------------------------------------------------

let twitchToken = null;   // { token, expiresAt }

async function twitchAccessToken() {
    const id = process.env.TWITCH_CLIENT_ID;
    const secret = process.env.TWITCH_CLIENT_SECRET;
    if (!id || !secret) return null;
    if (twitchToken && twitchToken.expiresAt - Date.now() > 60_000) return twitchToken.token;

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twitch OAuth ${res.status}`);
    const data = await res.json();
    twitchToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return twitchToken.token;
}

/** @returns {Promise<Map<string, boolean>>} channel -> live */
async function twitchLive(names) {
    const out = new Map();
    if (!names.length) return out;
    const token = await twitchAccessToken();
    if (!token) throw new Error('missing TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET');

    for (let i = 0; i < names.length; i += 100) {
        const chunk = names.slice(i, i + 100);
        const url = new URL('https://api.twitch.tv/helix/streams');
        for (const n of chunk) url.searchParams.append('user_login', n);
        const res = await fetch(url, {
            headers: { 'client-id': process.env.TWITCH_CLIENT_ID, authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Twitch API ${res.status}`);
        const data = await res.json();
        for (const n of chunk) out.set(n, false);
        for (const s of data.data ?? []) {
            out.set(String(s.user_login ?? '').toLowerCase(), true);
            out.liveTitle = out.liveTitle ?? {};
            out.liveTitle[String(s.user_login).toLowerCase()] = { title: s.title, game: s.game_name };
        }
    }
    return out;
}

// --- YouTube ------------------------------------------------------------------

/** @returns {Promise<Map<string, boolean>>} channelId -> live */
async function youtubeLive(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('missing GOOGLE_API_KEY');

    for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const url = new URL('https://www.googleapis.com/youtube/v3/channels');
        url.searchParams.set('part', 'snippet,liveDetails');
        url.searchParams.set('id', chunk.join(','));
        url.searchParams.set('key', key);
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`YouTube API ${res.status}`);
        const data = await res.json();
        for (const item of data.items ?? []) {
            const live = item.snippet?.liveBroadcastContent === 'live';
            out.set(item.id, live);
            if (live) {
                out.liveTitle = out.liveTitle ?? {};
                out.liveTitle[item.id] = {
                    title: item.liveDetails?.liveBroadcastTitle ?? item.snippet.title,
                    channel: item.snippet.title,
                };
            }
        }
    }
    return out;
}

// --- the loop -----------------------------------------------------------------

/** One pass over every watcher; isolated from the timer so tests can drive it.
 *  `markOnly` records current live streams as already-seen without posting —
 *  used on boot so restarting the bot does not announce hours-old streams. */
async function tick({ client, markOnly = false }) {
    const s = load();
    if (!s.watchers.length) return;

    const twitch = [...new Set(s.watchers.filter(w => w.platform === 'twitch').map(w => w.channel))];
    const youtube = [...new Set(s.watchers.filter(w => w.platform === 'youtube').map(w => w.channel))];

    const results = {};
    if (twitch.length) {
        try { results.twitch = await twitchLive(twitch); }
        catch (err) { console.warn(`[watch] twitch check failed: ${err.message}`); }
    }
    if (youtube.length) {
        try { results.youtube = await youtubeLive(youtube); }
        catch (err) { console.warn(`[watch] youtube check failed: ${err.message}`); }
    }

    let changed = false;
    for (const w of s.watchers) {
        const map = results[w.platform];
        if (!map) continue; // that platform errored this round — leave its state alone
        const live = Boolean(map.get(w.channel));
        const key = `${w.platform}:${w.channel}`;
        const was = Boolean(s.online[key]);

        if (live && !was) {
            s.online[key] = true;
            changed = true;
            if (markOnly) continue; // boot pass: remember, do not announce
            const extra = map.liveTitle?.[w.channel];
            const guild = client.guilds.cache.get(w.guildId);
            const channel = guild?.channels.cache.get(w.channelId) ?? null;
            if (channel && typeof channel.send === 'function') {
                const title = extra?.title ? ` — ${String(extra.title).slice(0, 120)}` : '';
                const link = w.platform === 'twitch'
                    ? `https://twitch.tv/${w.channel}`
                    : `https://www.youtube.com/channel/${w.channel}/live`;
                await channel.send({
                    content: `🔴 **${w.channel}** is live on ${w.platform === 'twitch' ? 'Twitch' : 'YouTube'}!${title}\n${link}`,
                    allowedMentions: { parse: [] },
                }).catch(() => {});
            }
        } else if (!live && was) {
            s.online[key] = false;
            changed = true;
        }
    }
    if (changed) persist();
}

function start({ client }) {
    if (timer) return;
    const loop = () => tick({ client }).catch(err => console.warn('[watch]', err.message));
    timer = setInterval(loop, POLL_MS);
    timer.unref();
    // Quiet first pass shortly after boot: streams already live are marked
    // seen without an announcement, so a restart never spams old go-lives.
    setTimeout(() => {
        tick({ client, markOnly: true }).catch(() => {});
    }, 10_000).unref();
}

module.exports = {
    FILE, DATA_DIR, POLL_MS, MAX_WATCHERS,
    add, remove, listFor, load, persist, tick, start,
    twitchLive, youtubeLive,
    get _timer() { return timer; },
};
