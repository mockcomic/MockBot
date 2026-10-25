const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const settings = require('../lib/guildSettings');

/**
 * Per-guild prefix override. Slash commands are unaffected — this only
 * changes what the prefix dispatcher listens for in this server.
 */
const PREFIX_RE = /^[!#$%&*+.,;:=?^_~0-9A-Za-z-]{1,5}$/;

module.exports = {
    name: 'prefix',
    description: 'Show or change this server’s command prefix (staff)',
    usage: 'prefix [set <new>|reset]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('prefix')
        .setDescription('Show or change the command prefix for this server')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('show, set, or reset')
                .setRequired(true)
                .addChoices(
                    { name: 'show', value: 'show' },
                    { name: 'set', value: 'set' },
                    { name: 'reset', value: 'reset' },
                ),
        )
        .addStringOption(option =>
            option.setName('new').setDescription('New prefix (1-5 characters)').setMaxLength(5),
        ),

    async execute(ctx) {
        const current = settings.get(ctx.guild.id).prefix;
        const effective = current ?? ctx.config.prefix;

        const action = String(ctx.option('action') ?? ctx.args[0] ?? 'show').toLowerCase();

        if (action === 'reset') {
            settings.patch(ctx.guild.id, { prefix: null });
            return ctx.reply(`↩️ Prefix reset to the global \`${ctx.config.prefix}\`.`, { ephemeral: true });
        }

        if (action === 'set') {
            const next = String(ctx.option('new') ?? ctx.args.slice(1).join('') ?? '').trim();
            if (!PREFIX_RE.test(next)) {
                return ctx.reply(
                    '❌ A prefix is 1-5 visible characters without spaces or @ < > (they collide with mentions).',
                    { ephemeral: true },
                );
            }
            settings.patch(ctx.guild.id, { prefix: next });
            return ctx.reply(`✅ Prefix for this server is now \`${next}\` — use it from the next message on.`, { ephemeral: true });
        }

        return ctx.reply(
            `ℹ️ Prefix here: \`${effective}\` (${current ? 'server override — `prefix reset` restores the global one' : 'global default'}).`,
            { ephemeral: true },
        );
    },
};

// Shared with commands/config.js so the prefix grammar lives in exactly one place.
module.exports.PREFIX_RE = PREFIX_RE;
