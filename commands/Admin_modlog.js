const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const settings = require('../lib/guildSettings');

/**
 * Point moderation logging (timeouts, purges) at a channel. Stored in
 * guildSettings; `off` or `clear` unsets it. An unset or broken channel just
 * means moderation is not logged — actions never fail because of it.
 */
module.exports = {
    name: 'modlog',
    description: 'Set or show the channel moderation actions are logged to',
    usage: 'modlog [#channel|off]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('modlog')
        .setDescription('Set or show the modlog channel')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Text channel to log moderation to (omit to show current)')
                .addChannelTypes(ChannelType.GuildText),
        ),

    async execute(ctx) {
        const arg = String(ctx.option('channel') ?? ctx.args[0] ?? '').trim();

        if (!arg || arg === 'off' || arg === 'clear') {
            const current = settings.get(ctx.guild.id).modlogChannelId;
            if (arg && !current) return ctx.reply('Modlog is already off here.', { ephemeral: true });
            settings.patch(ctx.guild.id, { modlogChannelId: arg ? null : current });
            if (arg) return ctx.reply('📋 Modlog turned off.', { ephemeral: true });
            return ctx.reply(
                current
                    ? `📋 Modlog posts to <#${current}>. Set another with \`${ctx.config.prefix}modlog #channel\`, or \`off\`.`
                    : '📋 No modlog channel set — `modlog #channel` starts one.',
                { ephemeral: true },
            );
        }

        const channelId = arg.match(/(\d{17,20})/)?.[1];
        if (!channelId) return ctx.reply('Mention the channel: `modlog #mod-log`.', { ephemeral: true });

        const channel =
            ctx.guild.channels.cache.get(channelId) ??
            (await ctx.guild.channels.fetch(channelId).catch(() => null));
        if (!channel || channel.type !== ChannelType.GuildText || typeof channel.send !== 'function') {
            return ctx.reply('❌ That is not a text channel I can post to here.', { ephemeral: true });
        }

        settings.patch(ctx.guild.id, { modlogChannelId: channelId });
        try {
            await channel.send('📋 Modlog enabled — moderation actions (timeouts, purges) will be logged here.');
        } catch {
            return ctx.reply('❌ I cannot send messages in that channel — check my permissions.', { ephemeral: true });
        }
        return ctx.reply(`📋 Modlog set to ${channel}.`, { ephemeral: true });
    },
};
