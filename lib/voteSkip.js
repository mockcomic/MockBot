/**
 * Vote skip.
 *
 * A queue anyone in voice could steer with `skip` let one determined listener
 * burn through a playlist. When two or more humans are listening, skipping now
 * needs a majority of them — unless you are the owner or the person who
 * requested the song, whose word is final.
 *
 * State is in-memory and keyed by the playing song's id: when the song changes
 * (naturally, by skip, or by jump) a running vote is stale by definition, and
 * attemptSkip() notices that on the next press, so no event wiring is needed.
 */

/** @type {Map<string, { songId: string|null, voters: Set<string>, needed: number }>} */
const state = new Map();

function requiredVotes(listenerCount) {
    return Math.max(1, Math.ceil(listenerCount / 2));
}

/** Humans connected to a voice channel (bots excluded; deafened people count). */
function humanListenerCount(channel) {
    let count = 0;
    for (const member of channel?.members?.values?.() ?? []) {
        if (!member.user?.bot) count += 1;
    }
    return count;
}

/**
 * The single decision point shared by the `skip` command and the ⏭ button.
 *
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.userId          the person pressing skip
 * @param {boolean} opts.isOwner        bot owner (skips the vote entirely)
 * @param {boolean} opts.isRequester    requested the current song
 * @param {boolean} opts.voteEnabled    guild/config toggle
 * @param {import('distube').Queue} opts.queue
 * @returns {{ action: 'skip', reason: string, votes: number, needed: number }
 *          | { action: 'vote', votes: number, needed: number, started: boolean }
 *          | { action: 'already', votes: number, needed: number }}
 */
function attemptSkip({ guildId, userId, isOwner, isRequester, voteEnabled, queue }) {
    const song = queue?.songs?.[0];
    const listeners = humanListenerCount(queue?.voiceChannel);

    // Drop a vote left over from the previous song before deciding.
    const current = state.get(String(guildId));
    if (current && current.songId !== (song?.id ?? null)) state.delete(String(guildId));

    if (!voteEnabled || isOwner || isRequester || listeners <= 1) {
        state.delete(String(guildId));
        return {
            action: 'skip',
            reason: !voteEnabled ? 'off' : isOwner ? 'owner' : isRequester ? 'requester' : 'solo',
            votes: 1,
            needed: 1,
        };
    }

    const needed = requiredVotes(listeners);
    const vote = state.get(String(guildId)) ?? { songId: song?.id ?? null, voters: new Set(), needed };
    vote.needed = needed;

    if (vote.voters.has(String(userId))) {
        return { action: 'already', votes: vote.voters.size, needed };
    }
    vote.voters.add(String(userId));

    if (vote.voters.size >= needed) {
        state.delete(String(guildId));
        return { action: 'skip', reason: 'passed', votes: vote.voters.size, needed };
    }

    state.set(String(guildId), vote);
    return { action: 'vote', votes: vote.voters.size, needed, started: vote.voters.size === 1 };
}

module.exports = { state, attemptSkip, requiredVotes, humanListenerCount };
