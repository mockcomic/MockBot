const { videoIdOf } = require('./autoplay');
const guildSettings = require('./guildSettings');

/**
 * SponsorBlock segment skipping for streamed songs.
 *
 * yt-dlp's `--sponsorblock-remove` rewrites a downloaded file, which a
 * streaming bot does not have. Instead we ask the public SponsorBlock API
 * (sponsor.ajhen.press) for the segment list when a song starts and poll once
 * a second: when playback enters a segment, `queue.seek()` jumps past it —
 * the same mechanism `seek` uses, so the stream restarts at the skip point.
 *
 * Opt-in per server (guildSettings.sponsorBlock, default from
 * config.music.sponsorBlockByDefault). Guards: no live streams, only videos
 * over MIN_DURATION seconds, at most MAX_SEGMENTS skips (an auto-flagged
 * mess should not become a strobe), and any failure — network, schema, a
 * denied seek — silently leaves normal playback alone.
 */

const API = 'https://sponsor.ajhen.press/api/skipSegments';
const CATEGORIES = ['sponsor', 'selfpromo'];   // intro/outro left alone on purpose
const MIN_DURATION = 30;
const MAX_SEGMENTS = 10;
const POLL_MS = 1000;
const HIT_BEFORE = 0.5;   // treat "0.5s before the segment" as inside it
const PAD_AFTER = 0.5;    // land this far past the segment end

/**
 * @param {object} config live config object (runtimeConfig-mutated)
 * @returns {{ setup: Function, fetchSegments: Function, enabledFor: Function }}
 */
module.exports = function setupSponsorBlock(distube, { config } = {}) {
    /** @type {Map<string, {timer: NodeJS.Timeout, song: object, segments: number[][]}>} */
    const watchers = new Map();

    function enabledFor(guildId) {
        const value = guildSettings.get(guildId).sponsorBlock;
        if (value === true || value === false) return value;
        return Boolean(config?.music?.sponsorBlockByDefault);
    }

    async function fetchSegments(videoId) {
        const url = `${API}?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` +
            `&categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return [];
        const data = await res.json().catch(() => null);
        if (!Array.isArray(data)) return [];
        const segments = data[0]?.segments;
        if (!Array.isArray(segments)) return [];
        return segments
            .filter(s => Array.isArray(s) && s.length === 2 && s.every(n => Number.isFinite(n)))
            .map(([start, end]) => [Math.max(0, start), Math.max(0, end)])
            .filter(([start, end]) => end > start)
            .sort((a, b) => a[0] - b[0]);
    }

    function stop(guildId) {
        const w = watchers.get(String(guildId));
        if (w) {
            clearInterval(w.timer);
            watchers.delete(String(guildId));
        }
    }

    function start(queue, song) {
        const guildId = String(queue.id);
        stop(guildId);
        if (!enabledFor(guildId) || song?.isLive || (song?.duration ?? 0) < MIN_DURATION) return;

        const videoId = videoIdOf(song.url);
        if (!videoId) return;

        fetchSegments(videoId).then(segments => {
            if (!segments.length || segments.length > MAX_SEGMENTS) return;
            // The song may have changed while the API call was in flight.
            if (queue.songs[0] !== song) return;

            const timer = setInterval(() => {
                try {
                    // Stop when this song is gone (skipped, finished, queue dead).
                    if (queue.songs[0] !== song || queue.paused || queue.stopped) {
                        if (queue.songs[0] !== song || queue.stopped) return stop(guildId);
                        return; // paused: hold position, resume checking later
                    }
                    const at = queue.currentTime;
                    const hit = segments.find(
                        ([start, end]) => at >= start - HIT_BEFORE && at < end && end < queue.songs[0].duration,
                    );
                    if (!hit) return;
                    void queue.seek(Math.min(hit[1] + PAD_AFTER, queue.songs[0].duration - 1));
                } catch {
                    stop(guildId);
                }
            }, POLL_MS);
            timer.unref();
            watchers.set(guildId, { timer, song, segments });
        }).catch(() => {});
    }

    function setup() {
        distube
            .on('playSong', (queue, song) => start(queue, song))
            .on('finish', queue => stop(String(queue.id)))
            .on('disconnect', queue => stop(String(queue.id)));
    }

    return { setup, fetchSegments, enabledFor, stop, watchers };
};

module.exports.CATEGORIES = CATEGORIES;
