/**
 * Shared guards and position maths for the music commands.
 *
 * Two problems this solves:
 *  1. DisTube's Queue#jump() counts *songs to skip* (jump(1) = next song) while
 *     the queue listing numbers the playing song 1, so passing the user's
 *     number straight through was off by one. resolveJumpTarget() is the single
 *     place that mapping happens, and it is unit-tested.
 *  2. Anyone in a guild could skip/stop/volume a queue they were not even in
 *     voice for. requireQueue() now checks membership in the bot's channel.
 */

const { formatDuration } = require('distube');
const { isOwner } = require('./access');

const NOT_PLAYING = 'Not playing music!';

/**
 * DisTube's own messages are mostly readable; these few are terse enough to
 * deserve a sentence that names the command the user should have used.
 */
const FRIENDLY_ERRORS = {
    NO_SONG_POSITION: 'There is no song at that position.',
    NO_UP_NEXT: 'There is no next song in the queue.',
    NO_PREVIOUS: 'There is no previous song to play.',
    DISABLED_OPTION: 'That feature is disabled for this bot (song history is not kept).',
    NO_PLAYING_SONG: 'Nothing is playing right now.',
    NOT_PLAYING: 'Nothing is playing right now.',
    INVALID_TYPE: 'That value is not valid here.',
};

/** Human-readable text for an error thrown by DisTube or the plugin. */
function explainError(err) {
    const code = typeof err?.errorCode === 'string' ? err.errorCode : null;
    if (code && FRIENDLY_ERRORS[code]) return FRIENDLY_ERRORS[code];
    const message = typeof err?.message === 'string' ? err.message.trim() : '';
    return message || String(err);
}

/**
 * Translate a queue-list position into a DisTube Queue#jump() argument.
 *
 * Positions follow the `queue` listing: 1 is the song playing now, 2 the next
 * one, ... Negative positions walk back through the history (`-1` = previous).
 *
 * @param {number} position       user-facing position
 * @param {number} songCount      queue.songs.length
 * @param {number} previousCount  queue.previousSongs.length
 * @returns {{ ok: boolean, apiPosition?: number, position?: number, error?: string }}
 */
function resolveJumpTarget(position, songCount, previousCount) {
    if (!Number.isInteger(position) || position === 0) {
        return { ok: false, error: 'The song number must be a whole number other than 0.' };
    }

    if (position === 1) {
        return {
            ok: false,
            error: 'Song 1 is the one playing now. Use `skip` to move on or `repeat song` to loop it.',
        };
    }

    if (position > 1) {
        // jump() skips `apiPosition` songs from the current one, and DisTube
        // rejects anything >= songCount (there is nothing to land on).
        if (position > songCount) {
            return { ok: false, error: outOfRange(songCount, previousCount) };
        }
        return { ok: true, position, apiPosition: position - 1 };
    }

    // Negative: -1 must stay within the saved history.
    if (-position > previousCount) {
        return {
            ok: false,
            error: previousCount
                ? `History goes back ${previousCount} song(s), so the smallest number is -${previousCount}.`
                : 'No song history to jump back to.',
        };
    }
    return { ok: true, position, apiPosition: position };
}

function outOfRange(songCount, previousCount) {
    const forward = songCount > 1 ? `2-${songCount}` : 'none (only the playing song)';
    const back = previousCount ? `, or -1 to -${previousCount} for history` : '';
    return `There is no song at that position. Playable positions: ${forward}${back}.`;
}

/**
 * Common precondition for every queue command.
 *
 * Async because an interaction's `member` payload does not always carry a voice
 * state, so the invoker is resolved through the guild member cache/fetch.
 *
 * @param {import('./Context')} ctx
 * @param {{ sameVoice?: boolean }} [options]
 * @returns {Promise<{ queue: import('distube').Queue } | { reply: string }>}
 */
async function requireQueue(ctx, { sameVoice = true } = {}) {
    const queue = ctx.distube.getQueue(ctx.guild);
    if (!queue || queue.songs.length === 0) return { reply: NOT_PLAYING };
    if (!sameVoice || isOwner(ctx.user?.id)) return { queue };

    const botChannel = queue.voiceChannel ?? ctx.guild.channels.cache.get(queue.voice?.channelId ?? '');
    const member =
        (ctx.member?.voice ? ctx.member : null) ??
        (await ctx.guild.members.fetch(ctx.user.id).catch(() => null));
    const memberChannelId = member?.voice?.channelId;

    if (!memberChannelId) {
        return { reply: `Join ${channelMention(botChannel)} to control this queue.` };
    }
    if (botChannel && memberChannelId !== botChannel.id) {
        return { reply: `You must be in ${channelMention(botChannel)} to use this command.` };
    }
    return { queue };
}

function channelMention(channel) {
    return channel?.name ? `**${channel.name}**` : "the bot's voice channel";
}

/** Unresolved when the guard produced a reply instead of a queue. */
function isBlocked(result) {
    return typeof result.reply === 'string';
}

/**
 * "90" -> "01:30", "1:05" -> "01:05", "70:00" -> "01:10:00".
 * Used by `seek`, which accepts both plain seconds and mm:ss.
 *
 * Minutes may exceed 59 (a long video), seconds may not.
 *
 * @returns {number|null} seconds, or null when unparseable
 */
function parseTime(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;

    if (/^\d+$/.test(text)) return Number.parseInt(text, 10);

    const parts = text.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every(p => /^\d{1,3}$/.test(p))) return null;

    const nums = parts.map(p => Number.parseInt(p, 10));
    const seconds = nums.at(-1);
    if (seconds > 59) return null;

    return nums.length === 2 ? nums[0] * 60 + seconds : nums[0] * 3600 + nums[1] * 60 + seconds;
}

module.exports = {
    NOT_PLAYING,
    explainError,
    isOwner,
    resolveJumpTarget,
    requireQueue,
    isBlocked,
    channelMention,
    parseTime,
    formatDuration,
};
