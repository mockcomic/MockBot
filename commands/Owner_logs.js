const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');
const logSink = require('../lib/logSink');

/**
 * Owner-only log reader: ships the persistent file log (lib/logSink) as an
 * attachment so errors can be read without shell access.
 *
 * Discord caps an attachment well above what a rotation cycle can hold
 * (cap × (keep+1)), but the command splits anyway: a request for `all` can
 * concatenate archives, and chunked parts keep every file readable in any
 * editor on any phone.
 */

const DEFAULT_LINES = 300;
const MAX_LINES = 5000;
const PART_BYTES = 7 * 1024 * 1024; // stay under Discord's 8 MB floor with headroom
const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, FATAL: 0 };

function parseLines(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_LINES;
    const n = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINES;
    return Math.min(n, MAX_LINES);
}

/** Group a flat tail back into entries: a line starts at a timestamp; indented lines continue it. */
function groupIntoEntries(lines) {
    const entries = [];
    for (const line of lines) {
        if (/^\S+\s(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s/.test(line)) entries.push([line]);
        else if (entries.length) entries[entries.length - 1].push(line);
        else entries.push([line]);
    }
    return entries;
}

function writeParts(text, dir) {
    const buf = Buffer.from(text, 'utf8');
    const parts = [];
    let offset = 0;
    while (offset < buf.length) {
        let end = Math.min(offset + PART_BYTES, buf.length);
        // Never cut mid-line unless a single line exceeds the part size.
        if (end < buf.length) {
            const nl = buf.lastIndexOf(0x0a, end);
            if (nl > offset) end = nl + 1;
        }
        const file = path.join(dir, `mockbot-log-part${parts.length + 1}.txt`);
        fs.writeFileSync(file, buf.subarray(offset, end));
        parts.push(file);
        offset = end;
    }
    return parts.length ? parts : [writeEmpty(dir)];
}

function writeEmpty(dir) {
    const file = path.join(dir, 'mockbot-log-part1.txt');
    fs.writeFileSync(file, 'No log entries matched.\n');
    return file;
}

module.exports = {
    name: 'logs',
    aliases: ['log'],
    ownerOnly: true,
    description: 'Send the bot log file (owner only)',
    usage: 'logs [lines] [--errors]  e.g. "logs 500" or "logs --errors"',
    data: new SlashCommandBuilder()
        .setName('logs')
        .setDescription('Send the bot log file (owner only)')
        .addIntegerOption(o => o.setName('lines').setDescription('How many trailing lines (default 300, max 5000)').setMinValue(1).setMaxValue(MAX_LINES))
        .addBooleanOption(o => o.setName('errors_only').setDescription('Only WARN/ERROR lines')),

    async execute(ctx) {
        if (ctx.isSlash) await ctx.defer();

        const lines = ctx.isSlash
            ? (ctx.option('lines') ?? DEFAULT_LINES)
            : parseLines(ctx.args.find(a => /^[0-9]+$/.test(a)));
        const errorsOnly = ctx.isSlash
            ? Boolean(ctx.option('errors_only'))
            : ctx.args.includes('--errors') || ctx.args.includes('-e');

        const tail = await logSink.tail(MAX_LINES).catch(err => {
            throw new Error(`could not read the log file: ${err.message}`);
        });

        let entries = groupIntoEntries(tail);
        if (errorsOnly) {
            entries = entries.filter(([head]) => {
                const m = head.match(/^\S+\s(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s/);
                return m && (m[1] === 'WARN' || m[1] === 'ERROR' || m[1] === 'FATAL');
            });
        }
        const kept = entries.slice(-Math.min(lines, MAX_LINES));
        const body = kept.map(e => e.join('\n')).join('\n') + (kept.length ? '\n' : '');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockbot-logs-'));
        try {
            const parts = writeParts(body, dir);
            const levelCounts = {};
            for (const [[head]] of kept) {
                const m = head.match(/^\S+\s(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s/);
                if (m) levelCounts[m[1]] = (levelCounts[m[1]] ?? 0) + 1;
            }
            const summary = Object.entries(levelCounts)
                .sort((a, b) => (LEVEL_ORDER[a[0]] ?? 9) - (LEVEL_ORDER[b[0]] ?? 9))
                .map(([lvl, n]) => `${lvl}: ${n}`)
                .join(' · ') || 'no entries';

            const attachments = parts.map(file => ({
                name: path.basename(file),
                description: `MockBot log (${errorsOnly ? 'errors only, ' : ''}newest last)`,
                file,
            }));

            await ctx.reply({
                content: `📜 Last ${kept.length} entr${kept.length === 1 ? 'y' : 'ies'}` +
                    (errorsOnly ? ' (WARN/ERROR only)' : '') +
                    ` — ${summary}. ${parts.length > 1 ? `Split into ${parts.length} parts.` : ''} Newest at the bottom.`,
                files: attachments,
            });
        } finally {
            // Discord reads the buffers during reply(); clean up after.
            setImmediate(() => fs.rmSync(dir, { recursive: true, force: true }));
        }
        return undefined;
    },
};
