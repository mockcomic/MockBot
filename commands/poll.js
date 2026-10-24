const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { parseHumanDuration, formatDurationMs } = require('../lib/duration');
const { COLOR } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

/**
 * Reaction polls: the bot posts the question, adds letter-keycap reactions,
 * counts votes with a timed collector, and edits the embed with the result.
 *
 * The collector lives in memory — a bot restart while a poll is open leaves
 * the message without its result line; acceptable for a self-hosted toy and
 * documented in the README.
 */

const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮', '🇯'];
const MAX_OPTIONS = LETTERS.length;
const DEFAULT_MS = 60_000;
const MIN_MS = 10_000;
const MAX_MS = 60 * 60_000;

function parseArgs(ctx) {
    // slash: explicit options; prefix: "<duration?> <question> | opt | opt"
    if (ctx.isSlash) {
        const question = String(ctx.option('question') ?? '').trim();
        const opts = String(ctx.option('options') ?? '')
            .split(/[|,]/)
            .map(s => s.trim())
            .filter(Boolean);
        const durationMs = ctx.option('duration') ? parseHumanDuration(String(ctx.option('duration'))) : null;
        return { question, opts, durationMs: durationMs ?? undefined };
    }

    const joined = ctx.args.join(' ').trim();
    const parts = joined.split('|').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return {};

    let [head] = parts;
    const opts = parts.slice(1);
    let durationMs;

    const firstSpace = head.search(/\s/);
    if (firstSpace > 0) {
        const candidate = parseHumanDuration(head.slice(0, firstSpace));
        if (candidate !== null && head.slice(firstSpace).trim()) {
            durationMs = candidate;
            head = head.slice(firstSpace).trim();
        }
    }
    return { question: head, opts, durationMs };
}

module.exports = {
    name: 'poll',
    description: `Create a reaction poll (up to ${MAX_OPTIONS} options; default: Yes/No for 1 minute)`,
    usage: 'poll [duration] <question> [ | option | option …]',
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a reaction poll')
        .addStringOption(option =>
            option.setName('question').setDescription('What to ask').setRequired(true).setMaxLength(300),
        )
        .addStringOption(option =>
            option.setName('options').setDescription('Comma-separated choices (default Yes,No)').setMaxLength(300),
        )
        .addStringOption(option =>
            option.setName('duration').setDescription('e.g. 5m, 30m (default 1m, max 1h)').setMaxLength(16),
        ),

    async execute(ctx) {
        const { question, opts, durationMs } = parseArgs(ctx);
        if (!question) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}poll [duration] <question> [ | option | option ]\``, { ephemeral: true });
        }
        if (opts.length > MAX_OPTIONS) {
            return ctx.reply(`❌ At most ${MAX_OPTIONS} options (you gave ${opts.length}).`, { ephemeral: true });
        }

        let openMs = durationMs ?? DEFAULT_MS;
        if (openMs < MIN_MS) openMs = MIN_MS;
        if (openMs > MAX_MS) openMs = MAX_MS;

        const options = opts.length ? opts : ['Yes', 'No'];
        const optionsShown = options.slice(0, MAX_OPTIONS);

        const lines = optionsShown.map((opt, i) => `${LETTERS[i]} ${clip(opt, 120)}`).join('\n');
        const baseEmbed = new EmbedBuilder()
            .setColor(COLOR.accent)
            .setTitle('📊 Poll')
            .setDescription(`**${clip(question, 300)}**\n\n${lines}`)
            .setFooter({ text: `Vote with the reactions • closes in ${formatDurationMs(openMs)}` });

        let message;
        try {
            message = await ctx.reply({ embeds: [baseEmbed] });
        } catch (err) {
            return ctx.reply(`❌ Could not post the poll: ${err.message}`);
        }

        const reacted = [];
        for (const emoji of LETTERS.slice(0, optionsShown.length)) {
            try {
                await message.react(emoji);
                reacted.push(emoji);
            } catch {
                return ctx.reply(`❌ Could not add the ${emoji} reaction — do I have Add Reactions here?`);
            }
        }
        const allowed = new Set(reacted);
        const labelFor = new Map(optionsShown.map((opt, i) => [reacted[i], opt]));

        // One entry per (user, option) — 'collect' fires once per first add,
        // 'remove' takes it back; this also stops double-counting re-adds.
        const votes = new Map();
        const collector = message.createReactionCollector({
            filter: (reaction, user) => allowed.has(reaction.emoji.name) && !user.bot,
            time: openMs,
            dispose: true,
        });
        collector.on('collect', (reaction, user) => votes.set(`${user.id}:${reaction.emoji.name}`, true));
        collector.on('remove', (reaction, user) => votes.delete(`${user.id}:${reaction.emoji.name}`));

        collector.on('end', () => {
            const counts = new Map([...allowed].map(e => [e, 0]));
            for (const key of votes.keys()) {
                const emoji = key.slice(key.indexOf(':') + 1);
                counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
            }
            const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const total = ranked.reduce((sum, [, n]) => sum + n, 0);

            const body = total
                ? ranked
                    .map(([emoji, n], i) => `${i === 0 && n > 0 ? '**' : ''}${emoji} ${clip(labelFor.get(emoji) ?? '?', 120)} — ${n}${i === 0 && n > 0 ? '**' : ''}`)
                    .join('\n')
                : '*No votes were cast.*';

            const result = EmbedBuilder.from(baseEmbed)
                .setDescription(`**${clip(question, 300)}**\n\n${body}`)
                .setFooter({ text: `Poll closed • ${total} vote${total === 1 ? '' : 's'}` });
            message.edit({ embeds: [result] }).catch(() => {});
        });

        return undefined;
    },
};
