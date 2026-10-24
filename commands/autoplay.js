const { SlashCommandBuilder } = require('discord.js');
const autoplay = require('../lib/autoplay');
const settings = require('../lib/guildSettings');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

/**
 * Autoplay switch. Affects the shared end-of-queue behaviour, so with a live
 * queue it is gated by the same "sit in the voice channel" rule as the music
 * controls (owner exempt); with no queue anyone may pre-set it.
 */
module.exports = {
    name: 'autoplay',
    aliases: ['auto'],
    description: 'Queue a related song from the YouTube radio mix when the queue ends',
    usage: 'autoplay <on|off|status>',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('autoplay')
        .setDescription('Queue a related song when the queue ends')
        .addStringOption(option =>
            option
                .setName('mode')
                .setDescription('on, off, or status')
                .addChoices(
                    { name: 'on', value: 'on' },
                    { name: 'off', value: 'off' },
                    { name: 'status', value: 'status' },
                ),
        ),

    async execute(ctx) {
        if (!ctx.guild) return ctx.reply('Autoplay is a per-server setting.');

        const sub = String(ctx.option('mode') ?? ctx.args[0] ?? 'status').toLowerCase();
        const queue = ctx.distube.getQueue(ctx.guild.id);

        if (queue && sub !== 'status') {
            const guard = await requireQueue(ctx);
            if (isBlocked(guard)) return ctx.reply(guard.reply);
        }

        if (sub === 'on' || sub === 'off') {
            const value = sub === 'on';
            settings.patch(ctx.guild.id, { autoplay: value });
            return ctx.reply(
                value
                    ? '📻 Autoplay on — when the queue ends, the first *other* song from the radio mix of the last track gets queued.'
                    : '📴 Autoplay off — the queue ends when it ends.',
            );
        }

        const enabled = autoplay.enabledFor(ctx.guild.id, ctx.config);
        const state = autoplay.state.get(String(ctx.guild.id));
        const brakes = state
            ? ` · autoplay songs in a row: ${state.chain}/${autoplay.MAX_CHAIN} · recent failures: ${state.failures}/${autoplay.MAX_FAILURES}`
            : '';
        return ctx.reply(
            `📻 Autoplay is **${enabled ? 'on' : 'off'}** here (change with \`${ctx.config.prefix}autoplay on|off\`)${brakes}.`,
        );
    },
};
