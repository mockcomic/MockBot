const { SlashCommandBuilder } = require('discord.js');
const settings = require('../lib/guildSettings');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

/**
 * Vote-skip switch. `null` (never set) follows config.json's global default,
 * so a server can opt in/out without the owner changing config.
 */
module.exports = {
    name: 'voteskip',
    description: 'Require a listener majority to skip, unless you requested the song',
    usage: 'voteskip <on|off|status>',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('voteskip')
        .setDescription('Toggle the vote-skip requirement')
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
        if (!ctx.guild) return ctx.reply('Vote skip is a per-server setting.');

        const sub = String(ctx.option('mode') ?? ctx.args[0] ?? 'status').toLowerCase();
        const queue = ctx.distube.getQueue(ctx.guild.id);
        if (queue && sub !== 'status') {
            const guard = await requireQueue(ctx);
            if (isBlocked(guard)) return ctx.reply(guard.reply);
        }

        if (sub === 'on' || sub === 'off') {
            settings.patch(ctx.guild.id, { voteSkip: sub === 'on' });
            return ctx.reply(`🗳️ Vote skip ${sub}.`);
        }

        const stored = settings.get(ctx.guild.id).voteSkip;
        const enabled = stored ?? (ctx.config.music?.voteSkipEnabled ?? true);
        const origin = stored === null ? 'following the global default' : 'set for this server';
        return ctx.reply(
            `🗳️ Vote skip is **${enabled ? 'on' : 'off'}** here (${origin}) — change with \`${ctx.config.prefix}voteskip on|off\`.`,
        );
    },
};
