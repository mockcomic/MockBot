const { YtDlpPluginPatched } = require('./YtDlpPluginPatched');

/**
 * Resolve a user query (URL or plain search terms) and start/queue playback.
 *
 * DisTube v5's built-in search flow needs an info-extractor plugin, which the
 * yt-dlp plugin is not. So plain search terms are resolved manually through
 * yt-dlp's own search syntax (`ytsearch1:<query>`) and the resulting
 * Song/Playlist is handed to DisTube.
 *
 * @param {import('distube').DisTube} distube
 * @param {import('discord.js').VoiceBasedChannel} voiceChannel
 * @param {string} query URL or search terms
 * @param {object} opts { member, textChannel, message }
 * @returns {Promise<import('distube').Song|import('distube').Playlist>} what was queued,
 *          so the caller can confirm the real title instead of echoing the query
 */
async function play(distube, voiceChannel, query, opts = {}) {
    const ytdlp = distube.plugins.find(p => p instanceof YtDlpPluginPatched);
    if (!ytdlp) throw new Error('yt-dlp plugin is not loaded');

    const isUrl = /^https?:\/\//i.test(query);
    const input = isUrl ? query : `ytsearch1:${query}`;

    let resolved = await ytdlp.resolve(input, { member: opts.member }, { allowPlaylist: opts.playlist === true });

    // `ytsearch1:` resolves to a 1-song playlist wrapper — unwrap it so a
    // plain search behaves like a single song, not a playlist. An explicit
    // `--playlist` URL keeps its wrapper: the user asked for the list.
    if (resolved?.songs && !isUrl && !(opts.playlist === true) && resolved.songs.length === 1) {
        resolved = resolved.songs[0];
    }

    await distube.play(voiceChannel, resolved, {
        member: opts.member,
        textChannel: opts.textChannel,
        message: opts.message,
    });

    return resolved;
}

/** True when the query looks like a direct URL (play() auto-picks those). */
function isUrl(query) {
    return /^https?:\/\//i.test(String(query ?? ''));
}

/**
 * Top-N candidate Songs for plain search terms — the data behind the `play`
 * result picker. Throws the same errors play() throws (network, cap, timeout).
 */
async function search(distube, query, limit = 5) {
    const ytdlp = distube.plugins.find(p => p instanceof YtDlpPluginPatched);
    if (!ytdlp) throw new Error('yt-dlp plugin is not loaded');
    if (typeof ytdlp.search !== 'function') throw new Error('the yt-dlp plugin cannot search');
    return ytdlp.search(query, limit);
}

/**
 * Playlist candidates (lightweight descriptors, not Songs) for the same
 * search terms — shown alongside the top songs in the `play` picker.
 */
async function searchPlaylists(distube, query, limit = 3) {
    const ytdlp = distube.plugins.find(p => p instanceof YtDlpPluginPatched);
    if (!ytdlp || typeof ytdlp.searchPlaylists !== 'function') return [];
    return ytdlp.searchPlaylists(query, limit);
}

/**
 * Turn a searchPlaylists() descriptor into a real DisTube Playlist (one
 * yt-dlp call) so it can be handed to distube.play().
 */
async function resolvePlaylistDescriptor(distube, descriptor, options = {}) {
    const ytdlp = distube.plugins.find(p => p instanceof YtDlpPluginPatched)
        ?? distube.plugins.find(p => typeof p?.resolve === 'function');
    if (!ytdlp) throw new Error('yt-dlp plugin is not loaded');
    return ytdlp.resolve(descriptor.url, options, { allowPlaylist: true });
}

/**
 * Split prefix/slash arguments into what to play and how.
 * Pure so the flag parsing is unit-testable.
 *
 * `--playlist` (anywhere before the query) = watch?v=…&list=… links queue the
 * whole list instead of just the video. `!` prefix (prefix commands only) and
 * `--direct`/`direct` slash option = skip the picker.
 *
 * @param {{args?: string[], option?: (name: string) => unknown}} source
 */
function parseInvocation({ args = [], option = () => undefined }) {
    const rest = [...args];
    let playlist = false;
    for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '--playlist') {
            rest.splice(i, 1);
            playlist = true;
            i -= 1;
        }
    }
    let query = rest.join(' ').trim();
    let direct = Boolean(option('direct'));
    playlist = playlist || Boolean(option('playlist'));
    if (query.startsWith('!')) { direct = true; query = query.slice(1).trim(); }
    return { query, direct, playlist };
}

module.exports = { play, search, searchPlaylists, resolvePlaylistDescriptor, isUrl, parseInvocation };
