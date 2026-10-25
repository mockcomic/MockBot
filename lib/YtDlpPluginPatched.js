const { spawn } = require('node:child_process');
const path = require('node:path');
const { YtDlpPlugin } = require('@distube/yt-dlp');
const { Song, Playlist, DisTubeError } = require('distube');

/**
 * Patched version of @distube/yt-dlp's plugin.
 *
 * Upstream (v2.0.1) breaks with current yt-dlp releases for two reasons:
 *  1. It passes `--no-call-home`, which yt-dlp now deprecates. yt-dlp prints
 *     a deprecation notice, and since upstream mixes stdout+stderr together
 *     before JSON.parse, the whole request fails.
 *  2. Any stderr output at all corrupts the JSON parse.
 *
 * This subclass keeps stdout (JSON) and stderr (diagnostics) separate and
 * drops the deprecated flag. It also bounds the subprocess: on a Raspberry Pi
 * a stalled network read used to hang the child forever, which left DisTube
 * waiting on a promise that never settled and the queue stuck mid-song.
 */

const YTDLP_BIN = path.join(
    path.dirname(require.resolve('@distube/yt-dlp')),
    '..',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

/** Hard stops for one yt-dlp invocation. Playlists are uncapped, so a
 *  --dump-single-json of a ~700-song list and a long network walk both get
 *  generous budgets. */
const RESOLVE_TIMEOUT_MS = 120_000; // playlists + searches do more network work
const STREAM_TIMEOUT_MS = 30_000; // single format lookup
const MAX_STDOUT_BYTES = 32 * 1024 * 1024; // a --dump-single-json of a big playlist
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * A `watch?v=…&list=…` link is one video that also belongs to a playlist; treat
 * it as the single video unless the URL is a playlist page. Without this, pasting
 * such a link queued the whole playlist, which surprised everyone. Pass
 * `allowPlaylist` (from `play --playlist`) to opt in to the whole list anyway.
 */
function isPlaylistUrl(url) {
    return /[?&]list=[A-Za-z0-9_-]+/.test(String(url)) && !/[?&]v=[A-Za-z0-9_-]{6,}/.test(String(url));
}

/** The full yt-dlp argv for one JSON call — pure, so the flag logic is unit-testable. */
function ytDlpArgs(url, { extraArgs = [], allowPlaylist = false } = {}) {
    return [
        url,
        '--dump-single-json',
        '--no-warnings',
        '--prefer-free-formats',
        '--skip-download',
        '--simulate',
        ...(isPlaylistUrl(url) || allowPlaylist ? [] : ['--no-playlist']),
        ...extraArgs,
    ];
}

function ytDlpJson(url, { extraArgs = [], timeoutMs = STREAM_TIMEOUT_MS, allowPlaylist = false } = {}) {
    const args = ytDlpArgs(url, { extraArgs, allowPlaylist });

    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP_BIN, args);

        // stdout is the JSON; stderr is diagnostics and is only kept for errors.
        const stdoutChunks = [];
        let stdoutBytes = 0;
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new DisTubeError('YTDLP_ERROR', `yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s resolving ${url}`));
        }, timeoutMs);

        child.stdout?.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill('SIGKILL');
                reject(new DisTubeError('YTDLP_ERROR', `yt-dlp output exceeded ${Math.floor(MAX_STDOUT_BYTES / 1024 / 1024)}MB`));
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr?.on('data', chunk => {
            if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
        });

        child.on('error', err => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            reject(new DisTubeError('YTDLP_ERROR', `Cannot run yt-dlp (${YTDLP_BIN}): ${err.message}`));
        });

        child.on('close', code => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;

            if (code !== 0) {
                return reject(new DisTubeError('YTDLP_ERROR', stderr.trim() || `yt-dlp exited with code ${code}`));
            }
            try {
                resolve(JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')));
            } catch (err) {
                reject(new DisTubeError('YTDLP_ERROR', `Cannot parse yt-dlp output: ${err.message}`));
            }
        });
    });
}

/**
 * Playlist descriptors from a flat playlist-search dump. Pure, so the shape
 * logic is unit-testable without spawning yt-dlp.
 */
function playlistEntries(info, limit = 3) {
    const entries = Array.isArray(info?.entries) ? info.entries : [];
    return entries
        .filter(e => e && typeof e.url === 'string' && e.url.includes('/playlist'))
        .slice(0, limit)
        .map(e => ({
            type: 'playlist',
            name: e.title ?? 'Unknown playlist',
            url: e.url,
            ...(e.thumbnail ? { thumbnail: e.thumbnail } : {}),
        }));
}

class YtDlpPluginPatched extends YtDlpPlugin {
    #buildSong(info, options) {
        return new Song(
            {
                plugin: this,
                source: info.extractor ?? 'yt-dlp',
                playFromSource: true,
                id: String(info.id),
                name: info.title || info.fulltitle,
                url: info.webpage_url || info.original_url,
                isLive: info.is_live,
                thumbnail: info.thumbnail ?? info.thumbnails?.[0]?.url,
                duration: info.is_live ? 0 : info.duration,
                uploader: { name: info.uploader, url: info.uploader_url },
                views: info.view_count,
                likes: info.like_count,
                ageRestricted: Boolean(info.age_limit) && info.age_limit >= 18,
            },
            options,
        );
    }

    async resolve(url, options, flags = {}) {
        const info = await ytDlpJson(url, {
            timeoutMs: RESOLVE_TIMEOUT_MS,
            allowPlaylist: Boolean(flags.allowPlaylist),
        });
        if (Array.isArray(info.entries)) {
            if (info.entries.length === 0) {
                throw new DisTubeError('YTDLP_ERROR', 'The playlist is empty');
            }
            const songs = info.entries
                .filter(entry => entry && (entry.webpage_url || entry.url))
                .map(entry => this.#buildSong(entry, options));

            if (songs.length === 0) throw new DisTubeError('YTDLP_ERROR', 'The playlist has no playable entries');

            return new Playlist(
                {
                    source: info.extractor ?? 'yt-dlp',
                    songs,
                    id: String(info.id),
                    name: info.title,
                    url: info.webpage_url || info.original_url,
                    thumbnail: info.thumbnails?.[0]?.url,
                },
                options,
            );
        }
        return this.#buildSong(info, options);
    }

    /**
     * Return up to `limit` candidate Songs for plain search terms, without
     * queueing anything. Uses yt-dlp's own search syntax (`ytsearchN:`), the
     * same path `resolve('ytsearch1:…')` takes for the auto-pick flow — this
     * is how `play` can offer a top-5 picker instead of guessing.
     *
     * @returns {Promise<Song[]>}
     */
    async search(query, limit = 5, options = {}) {
        const n = Math.min(25, Math.max(1, Math.floor(limit)));
        const info = await ytDlpJson(`ytsearch${n}:${query}`, { timeoutMs: RESOLVE_TIMEOUT_MS });
        const entries = Array.isArray(info.entries) ? info.entries : [info];
        return entries
            .filter(entry => entry && (entry.webpage_url || entry.url))
            .slice(0, n)
            .map(entry => this.#buildSong(entry, options));
    }

    /**
     * Top-N playlist *descriptors* for plain search terms (not Songs — the
     * track list is unknown until the pick is resolved). Scrapes YouTube's
     * own results page with the playlists filter (`sp=EgIQAg%253A%253D`)
     * flat, so this is one fast call. Any failure (the opaque filter token
     * may rot) degrades to no playlists rather than breaking the picker.
     *
     * @returns {Promise<Array<{type:'playlist', name, url, thumbnail}>>}
     */
    async searchPlaylists(query, limit = 3) {
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253A%253D`;
        let info;
        try {
            info = await ytDlpJson(url, { extraArgs: ['--flat-playlist'], timeoutMs: RESOLVE_TIMEOUT_MS });
        } catch {
            return [];
        }
        return playlistEntries(info, Math.min(3, Math.max(1, Math.floor(limit))));
    }

    async getStreamURL(song) {
        if (!song.url) {
            throw new DisTubeError('YTDLP_PLUGIN_INVALID_SONG', 'Cannot get stream url from invalid song.');
        }
        const info = await ytDlpJson(song.url, { extraArgs: ['--format', 'ba/ba*'] });
        if (Array.isArray(info.entries)) {
            throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream url of an entire playlist');
        }
        if (!info.url) {
            throw new DisTubeError('YTDLP_ERROR', `yt-dlp returned no playable stream for ${song.url}`);
        }
        return info.url;
    }
}

module.exports = {
    YtDlpPluginPatched,
    YTDLP_BIN,
    isPlaylistUrl,
    ytDlpArgs,
    playlistEntries,
    RESOLVE_TIMEOUT_MS,
    STREAM_TIMEOUT_MS,
    MAX_STDOUT_BYTES,
};
