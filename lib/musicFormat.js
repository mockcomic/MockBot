/**
 * Shared music text/embedding helpers.
 *
 * The status line used to be duplicated between the `finish`/`playSong`
 * embeds and the queue footer and had already drifted apart. Song titles come
 * from a remote source, so they are escaped here once rather than at every
 * call site.
 */

const { formatDuration } = require('distube');

const COLOR = {
    play: 0x57f287,
    add: 0x3498db,
    list: 0x3498db,
    info: 0xf1c40f,
    error: 0xed4245,
    accent: 0x0099ff,
};

const LOOP_LABELS = { 0: 'Off', 1: 'This Song', 2: 'All Queue' };

function loopLabel(mode) {
    return LOOP_LABELS[Number(mode) ?? 0] ?? 'Off';
}

/**
 * Escape a remote title for use as a Discord link label: brackets and a few
 * other control characters would otherwise break the markdown link.
 */
function mdTitle(text, maxLength = 200) {
    return String(text ?? 'Unknown title')
        .slice(0, maxLength)
        .replace(/([[\]()~>|])/g, '\\$1');
}

function songLink(song) {
    const label = mdTitle(song?.name);
    return song?.url ? `[${label}](${song.url})` : label;
}

/** `Volume: \`80%\` | Filter: \`Off\` | Loop: \`Off\` | Autoplay: \`Off\`` */
function statusLine(queue) {
    const filters = queue.filters?.names?.join(', ') || 'Off';
    const autoplay = queue.autoplay ? 'On' : 'Off';
    return `Volume: \`${queue.volume}%\` | Filter: \`${filters}\` | Loop: \`${loopLabel(queue.repeatMode)}\` | Autoplay: \`${autoplay}\``;
}

/** `01:23 / 04:56  [####--------]` for the playing song. */
function progressLine(queue, song, width = 18) {
    const total = Math.max(0, Math.floor(song?.duration ?? 0));
    const elapsed = Math.max(0, Math.floor(queue.currentTime ?? 0));

    if (!total) return `\`${formatDuration(elapsed)}\` (live)`;

    const ratio = Math.min(1, elapsed / total);
    const filled = Math.round(ratio * width);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
    return `\`${formatDuration(elapsed)} / ${formatDuration(total)}\`  ${bar}`;
}

const QUEUE_PAGE_SIZE = 10;

/**
 * Pure pagination over the queue, so the row numbering, the `jump` positions it
 * implies, and the page clamping are testable without Discord.
 *
 * Row 1 is the playing song — the same numbering `jump` accepts.
 *
 * @param {import('distube').Queue} queue
 * @param {number} [requestedPage] 1-based, clamped into range
 */
function queuePage(queue, requestedPage = 1, pageSize = QUEUE_PAGE_SIZE) {
    const songs = Array.isArray(queue?.songs) ? queue.songs : [];
    const total = songs.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number.parseInt(requestedPage, 10) || 1), pages);
    const start = (page - 1) * pageSize;

    const rows = songs.slice(start, start + pageSize).map((song, index) => {
        const position = start + index + 1;
        const marker = position === 1 ? '▶︎' : '·';
        return `\`${position}.\` ${marker} ${songLink(song)} — \`${song.formattedDuration}\``;
    });

    let description = rows.join('\n');
    if (pages > 1) {
        description += `\n\nPage **${page}/${pages}** — pass a page number to see more.`;
    }

    const footerText = [
        `${total} song${total === 1 ? '' : 's'}`,
        `total \`${formatDuration(queue?.duration ?? 0)}\``,
        statusLine(queue),
    ].join(' • ');

    return { page, pages, total, description, footerText };
}

module.exports = {
    COLOR,
    QUEUE_PAGE_SIZE,
    loopLabel,
    mdTitle,
    songLink,
    statusLine,
    progressLine,
    queuePage,
    formatDuration,
};
