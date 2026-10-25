const fs = require('node:fs');
const path = require('node:path');
const { videoIdOf } = require('./autoplay');

/**
 * Queue snapshot across restarts.
 *
 * DisTube has no resume: `reboot`, `update` or a crash drops every queue
 * while the music is the whole point. This stores a snapshot per guild —
 * {voiceChannelId, textChannelId, songs:[{url,name,duration,thumbnail}],
 * text} — whenever the queue changes meaningfully and whenever the process
 * is going away, then replays it on the next boot: the bot rejoins the voice
 * channel, queues the songs (streams re-resolve through yt-dlp, so the same
 * urls work again) and starts playing.
 *
 * Deliberately conservative:
 *   - A snapshot is only kept for a live queue (>=1 song) in a guild; sfx
 *     file songs cannot be re-resolved and skip the whole snapshot.
 *   - TTL: a stale snapshot (>MAX_AGE_MS) is dropped, not replayed — nobody
 *     wants yesterday's queue at a random minute today.
 *   - The current song resumes from the START (no timestamp seek): simpler,
 *     and a song someone just heard 60% of replaying fully beats guessing.
 *   - Any replay failure is per-guild: one dead video or a deleted channel
 *     must not stop the other servers resuming.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'queue-resume.json');
const MAX_GUILDS = 50;
const MAX_SONGS = 200;        // per snapshot; the queue itself is uncapped
const MAX_AGE_MS = 6 * 60 * 60_000;

/** @type {Map<string, {voiceChannelId: string, textChannelId: string, savedAt: number, songs: object[]}>|null} */
let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        cache = new Map(
            Object.entries(raw?.guilds ?? {})
                .filter(([, s]) => s && Array.isArray(s.songs) && s.songs.length && s.voiceChannelId && s.savedAt)
                .slice(0, MAX_GUILDS),
        );
    } catch {
        cache = new Map();
    }
    return cache;
}

function persist() {
    const obj = { guilds: Object.fromEntries([...load()]) };
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = `${FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (err) {
        console.warn(`[queueResume] could not save: ${err.message}`);
    }
}

/** Minimal replayable rows; anything without a url cannot be re-resolved. */
function songRows(queue) {
    return (queue?.songs ?? [])
        .filter(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url))
        .slice(0, MAX_SONGS)
        .map(s => ({
            url: s.url,
            name: String(s.name ?? 'Unknown').slice(0, 120),
            duration: Number.isFinite(s.duration) ? s.duration : 0,
            thumbnail: typeof s.thumbnail === 'string' ? s.thumbnail : null,
        }));
}

/** True when this queue is worth taking across a restart. */
function snapshotable(queue) {
    if (!queue || queue.songs?.length < 1) return false;
    if (!queue.voiceChannel?.id || !queue.textChannel?.id) return false;
    // A queue seeded from local sfx files is not a music session to restore.
    return String(queue.songs[0]?.source ?? '').toLowerCase() !== 'file';
}

/** Remember the whole live queue of one guild (called on stop/finish/shutdown). */
function snapshotQueue(queue) {
    if (!snapshotable(queue)) return false;
    const rows = songRows(queue);
    if (!rows.length) return false;
    load().set(String(queue.id), {
        voiceChannelId: String(queue.voiceChannel.id),
        textChannelId: String(queue.textChannel.id),
        savedAt: Date.now(),
        songs: rows,
    });
    persist();
    return true;
}

/** Forget a guild's pending resume (manual stop/leave, or after a replay). */
function forget(guildId) {
    if (!load().delete(String(guildId))) return false;
    persist();
    return true;
}

/**
 * Set while the process is going down: the SIGTERM handler snapshots every
 * live queue first, and the disconnect events that follow client.destroy()
 * must not forget those fresh snapshots.
 */
let shuttingDown = false;
function markShutdown() { shuttingDown = true; }
function isShuttingDown() { return shuttingDown; }

/** Forget every guild (a planned `reboot`/`update` keeps queues on purpose). */
function forgetAll() {
    if (!load().size) return;
    cache.clear();
    persist();
}

function pending(guildId) {
    const entry = load().get(String(guildId));
    if (!entry) return null;
    if (Date.now() - entry.savedAt > MAX_AGE_MS) {
        forget(guildId);
        return null;
    }
    return entry;
}

/** Every unexpired pending snapshot (the boot-time replay list). */
function pendingAll() {
    const out = [];
    for (const [guildId] of [...load()]) {
        const entry = pending(guildId);
        if (entry) out.push([guildId, entry]);
    }
    return out;
}

function entryRows(entry) {
    return entry.songs
        .filter(r => videoIdOf(r.url) || /^https?:\/\//i.test(r.url))
        .map(r => ({ ...r }));
}

/**
 * Take a snapshot of every live queue. Wired to SIGTERM (systemd restart,
 * `!reboot`) and the periodic saver, so a queue that never "finished" still
 * survives as long as it was live at some point in the save window.
 */
function snapshotAll(distube) {
    let n = 0;
    for (const queue of distube.queues.collection?.values?.() ?? []) {
        if (snapshotQueue(queue)) n += 1;
    }
    return n;
}

/**
 * Rejoin + requeue every pending snapshot. Called once at ClientReady.
 * Streams re-resolve at play time (rebuildStoredSong), so no yt-dlp calls
 * happen here beyond what playback needs. Replies go to the saved text
 * channel; one failing guild never stops the rest.
 *
 * @returns {Promise<Array<[guildId, 'resumed'|'no-channel'|'failed', detail?]>>}
 */
async function resumeAll(distube, client) {
    const { Playlist } = require('distube');
    const { YtDlpPluginPatched } = require('./YtDlpPluginPatched');
    const { rebuildStoredSong } = require('./music');
    const results = [];
    for (const [guildId, entry] of pendingAll()) {
        try {
    const guild = client.guilds.cache.get(guildId);
    const voiceChannel = guild?.channels?.cache?.get(entry.voiceChannelId)
        ?? (guild ? await guild.channels.fetch(entry.voiceChannelId).catch(() => null) : null);
    if (!voiceChannel?.isJoinable) {
        forget(guildId);
        results.push([guildId, 'no-channel']);
        continue;
    }
    const textChannel = guild.channels.cache.get(entry.textChannelId)
        ?? (await guild.channels.fetch(entry.textChannelId).catch(() => null));
    const plugin = distube.plugins.find(p => p instanceof YtDlpPluginPatched);
    const options = { member: guild.members.me ?? null, textChannel: textChannel ?? undefined };
    const rows = entryRows(entry);
    const songs = rows.map(r => rebuildStoredSong(plugin, r, options));
    if (!songs.length) {
        forget(guildId);
        results.push([guildId, 'failed', 'no replayable rows']);
        continue;
    }
    // One Playlist (same shape `playlist load` uses) so the
    // whole list lands in one play() call.
    const what = songs.length === 1
        ? songs[0]
        : new Playlist(
    {
        source: 'yt-dlp',
        songs,
        id: `resume-${guildId}`,
        name: `Resumed queue (${songs.length} songs)`,
        url: rows[0].url,
        thumbnail: rows[0].thumbnail ?? undefined,
    },
    options,
        );
    await distube.play(voiceChannel, what, options);
    forget(guildId);
    // The row carries the text channel so the restart-recovery pass can avoid
    // posting a second "back up" message where this "Resumed" one already went.
    results.push([guildId, 'resumed', { songs: songs.length, textChannelId: entry.textChannelId }]);
    await textChannel?.send?.(`🔁 Resumed ${songs.length} song${songs.length === 1 ? '' : 's'} in **${voiceChannel.name}** after restart.`).catch(() => {});
        } catch (err) {
    results.push([guildId, 'failed', err.message]);
        }
    }
    return results;
}

module.exports = {
    FILE,
    DATA_DIR,
    MAX_AGE_MS,
    load,
    persist,
    snapshotQueue,
    snapshotAll,
    forget,
    forgetAll,
    markShutdown,
    isShuttingDown,
    pending,
    pendingAll,
    songRows,
    snapshotable,
    resumeAll,
};
