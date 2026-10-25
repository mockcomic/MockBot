const { YtDlpPluginPatched } = require('./YtDlpPluginPatched');
const settings = require('./guildSettings');

/**
 * Autoplay / radio mode.
 *
 * DisTube's built-in autoplay needs an info-extractor plugin; ours is the
 * yt-dlp plugin (it is not one), so autoplay is implemented here instead:
 * when the queue finishes, resolve YouTube's radio mix for the last song
 * (`RD<videoId>` playlist) and queue the first entry that is not the song
 * that just ended.
 *
 * Two brakes keep an unattended Pi out of loops:
 *   - MAX_FAILURES consecutive resolve failures pause autoplay for the
 *     session (a flaky network should not spam the text channel), and
 *   - MAX_CHAIN caps how many songs in a row autoplay may pick without a
 *     user pressing play again.
 */

const MAX_FAILURES = 3;
const MAX_CHAIN = 50;

/** @type {Map<string, { last: object|null, failures: number, chain: number }>} */
const state = new Map();

function ensure(guildId) {
    const key = String(guildId);
    let entry = state.get(key);
    if (!entry) state.set(key, (entry = { last: null, failures: 0, chain: 0 }));
    return entry;
}

/**
 * Call from the playSong event for every song. Autoplay-picked songs carry
 * `auto: true` (set by nextSong); a human-picked song resets both counters.
 */
function recordPlay(guildId, song) {
    const entry = ensure(guildId);
    if (song?.auto) entry.chain += 1;
    else {
        entry.chain = 0;
        entry.failures = 0;
    }
    entry.last = song ?? entry.last;
}

/** Guild override wins; otherwise the global default from config.json. */
function enabledFor(guildId, config) {
    const value = settings.get(guildId).autoplay;
    if (value === true || value === false) return value;
    return Boolean(config?.music?.autoplayByDefault);
}

function videoIdOf(url) {
    return String(url ?? '').match(/[?&]v=([\w-]{6,})/)?.[1] ?? null;
}

function mixUrl(videoId) {
    return `https://www.youtube.com/playlist?list=RD${videoId}`;
}

/**
 * Resolve the next autoplay candidate for a guild.
 *
 * @param {import('distube').DisTube} distube
 * @param {string} guildId
 * @param {{ member: import('discord.js').GuildMember|null, textChannel: import('discord.js').TextBasedChannel }} opts
 * @returns {Promise<object|null>} a Song ready for distube.play, or null when
 *          autoplay should not continue (capped, failed, no seed, live source)
 */
async function nextSong(distube, guildId, { member = null, textChannel } = {}) {
    const entry = ensure(guildId);
    if (entry.failures >= MAX_FAILURES || entry.chain >= MAX_CHAIN) return null;

    const seed = entry.last;
    const videoId = videoIdOf(seed?.url);
    // Live streams have no "related" semantics and 0-duration breaks progress UI.
    if (!videoId || seed?.isLive) return null;

    const ytdlp = distube.plugins.find(p => p instanceof YtDlpPluginPatched);
    if (!ytdlp) return null;

    try {
        // The radio mix only needs a handful of entries — without a cap this
        // dumps the full (100+) mix JSON on every auto-queued song, which the
        // old PLAYLIST_ITEM_CAP used to bound implicitly.
        const resolved = await ytdlp.resolve(mixUrl(videoId), { member, textChannel }, { playlistItems: 25 });
        const songs = Array.isArray(resolved?.songs) ? resolved.songs : [resolved];
        const next = songs.find(song => song && videoIdOf(song.url) && videoIdOf(song.url) !== videoId);
        if (!next) throw new Error('the radio mix offered nothing new');
        next.auto = true;
        entry.failures = 0;
        return next;
    } catch (err) {
        entry.failures += 1;
        console.warn(`[autoplay] guild ${guildId}: ${err.message}`);
        return null;
    }
}

/** Whether autoplay may keep the queue going right now (brakes aside). */
function canContinue(guildId) {
    const entry = ensure(guildId);
    return entry.failures < MAX_FAILURES && entry.chain < MAX_CHAIN && Boolean(entry.last);
}

module.exports = {
    state,
    MAX_FAILURES,
    MAX_CHAIN,
    ensure,
    recordPlay,
    enabledFor,
    nextSong,
    canContinue,
    videoIdOf,
    mixUrl,
};
