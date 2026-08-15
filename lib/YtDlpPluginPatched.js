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
 * drops the deprecated flag.
 */

const YTDLP_BIN = path.join(
    path.dirname(require.resolve('@distube/yt-dlp')),
    '..',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
);

function ytDlpJson(url, extraArgs = []) {
    const args = [
        url,
        '--dump-single-json',
        '--no-warnings',
        '--prefer-free-formats',
        '--skip-download',
        '--simulate',
        ...extraArgs,
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP_BIN, args);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) {
                return reject(new DisTubeError('YTDLP_ERROR', stderr || `yt-dlp exited with code ${code}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                reject(new DisTubeError('YTDLP_ERROR', `Cannot parse yt-dlp output: ${err.message}`));
            }
        });
    });
}

/** Cap playlist resolution so a 5000-song playlist can't hang the bot. */
const PLAYLIST_ITEM_CAP = ['--playlist-items', '1-100'];

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
        const info = await ytDlpJson(url, PLAYLIST_ITEM_CAP);

        if (Array.isArray(info.entries)) {
            if (info.entries.length === 0) {
                throw new DisTubeError('YTDLP_ERROR', 'The playlist is empty');
            }
            return new Playlist(
                {
                    source: info.extractor ?? 'yt-dlp',
                    songs: info.entries.map(entry => this.#buildSong(entry, options)),
                    id: String(info.id),
                    name: info.title,
                    url: info.webpage_url,
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
        const info = await ytDlpJson(song.url, ['--format', 'ba/ba*']);
        if (Array.isArray(info.entries)) {
            throw new DisTubeError('YTDLP_ERROR', 'Cannot get stream url of an entire playlist');
        }
        return info.url;
    }
}

module.exports = { YtDlpPluginPatched, YTDLP_BIN };
