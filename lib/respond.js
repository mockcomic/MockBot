/**
 * Reply-safety helpers.
 *
 * Anything we echo back from an untrusted source (yt-dlp stderr, song titles,
 * stored feedback, git output) can break Discord's 2000-character message cap
 * or escape a code fence. Everything user-controlled that we put in a text
 * reply goes through one of these first.
 */

const MAX_MESSAGE_LENGTH = 2000;
const FENCE = '```';
const ELLIPSIS = '…';

/**
 * Shorten text to `limit` characters, preferring a line boundary so an entry
 * is not cut mid-word. The result is always <= limit characters.
 */
function clip(text, limit = MAX_MESSAGE_LENGTH) {
    const value = String(text ?? '');
    if (value.length <= limit) return value;
    // -1 keeps room for the ellipsis.
    const cut = value.slice(0, Math.max(0, limit - ELLIPSIS.length));
    const newline = cut.lastIndexOf('\n');
    // Only honour the newline when it saves most of the content.
    const head = newline > cut.length * 0.6 ? cut.slice(0, newline) : cut;
    return head.trimEnd() + ELLIPSIS;
}

/**
 * Same as clip but for a single line that has no newline to break on: plain
 * slices, so a long line becomes several chunks instead of one clipped one.
 */
function hardChunks(text, size = MAX_MESSAGE_LENGTH) {
    const value = String(text ?? '');
    const parts = [];
    for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
    return parts.length ? parts : [''];
}

/**
 * Wrap untrusted output in a code block that cannot be broken out of and never
 * exceeds the message limit.
 *
 * A run of three or more backticks in the body would close the fence early, so
 * every backtick in such a run is separated by a zero-width space: invisible in
 * the client, harmless inside a code block, and it makes a run of any length
 * impossible to mistake for a fence.
 *
 * @param {string} body        text to show verbatim
 * @param {object} [options]   { title, limit }
 */
function fenced(body, { title = '', limit = MAX_MESSAGE_LENGTH } = {}) {
    const safe = String(body ?? '').replace(/`{3,}/g, run => run.split('').join('\u200b'));
    const head = title ? `${title}\n` : '';
    // ```\n + head + body + \n```
    const overhead = FENCE.length + 1 + head.length + 1 + FENCE.length;
    const budget = limit - overhead;
    if (budget <= 0) return clip(`${head}${safe}`, limit);
    return `${FENCE}\n${head}${clip(safe, budget)}\n${FENCE}`;
}

/**
 * Split text into message-sized chunks on newline boundaries, so a chunk never
 * splits a record in half. Oversized single lines fall back to hard slices.
 *
 * @returns {string[]} always at least one chunk
 */
function chunkLines(text, limit = MAX_MESSAGE_LENGTH) {
    const chunks = [];
    let current = '';

    for (const line of String(text ?? '').split('\n')) {
        if (line.length > limit) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            chunks.push(...hardChunks(line, limit));
            continue;
        }
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length <= limit) {
            current = candidate;
        } else {
            chunks.push(current);
            current = line;
        }
    }

    if (current) chunks.push(current);
    return chunks.length ? chunks : [''];
}

module.exports = { MAX_MESSAGE_LENGTH, clip, hardChunks, fenced, chunkLines };
