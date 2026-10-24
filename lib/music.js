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

    let resolved = await ytdlp.resolve(input, { member: opts.member });

    // `ytsearch1:` resolves to a 1-song playlist wrapper — unwrap it so a
    // plain search behaves like a single song, not a playlist.
    if (resolved?.songs && !isUrl && resolved.songs.length === 1) {
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

module.exports = { play, search, isUrl };
