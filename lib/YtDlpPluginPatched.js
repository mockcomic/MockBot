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

/** Hard stops for one yt-dlp invocation. */
const RESOLVE_TIMEOUT_MS = 60_000; // playlists + searches do more network work
const STREAM_TIMEOUT_MS = 30_000; // single format lookup
const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // a --dump-single-json of a big playlist
const MAX_STDERR_BYTES = 64 * 1024;

/** Cap playlist resolution so a 5000-song playlist can't hang the bot. */
const PLAYLIST_ITEM_LIMIT = 100;
const PLAYLIST_ITEM_CAP = ['--playlist-items', `1-${PLAYLIST_ITEM_LIMIT}`];

/**
 * A `watch?v=…&list=…` link is one video that also belongs to a playlist; treat
 * it as the single video unless the URL is a playlist page. Without this, pasting
 * such a link queued up to PLAYLIST_ITEM_LIMIT songs, which surprised everyone.
 */
function isPlaylistUrl(url) {
    return /[?&]list=[A-Za-z0-9_-]+/.test(String(url)) && !/[?&]v=[A-Za-z0-9_-]{6,}/.test(String(url));
}

function ytDlpJson(url, { extraArgs = [], timeoutMs = STREAM_TIMEOUT_MS } = {}) {
    const args = [
        url,
        '--dump-single-json',
        '--no-warnings',
        '--prefer-free-formats',
        '--skip-download',
        '--simulate',
        ...(isPlaylistUrl(url) ? [] : ['--no-playlist']),
        ...extraArgs,
    ];

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

    async resolve(url, options) {
        const info = await ytDlpJson(url, { extraArgs: PLAYLIST_ITEM_CAP, timeoutMs: RESOLVE_TIMEOUT_MS });

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
    PLAYLIST_ITEM_LIMIT,
    RESOLVE_TIMEOUT_MS,
    STREAM_TIMEOUT_MS,
    MAX_STDOUT_BYTES,
};
