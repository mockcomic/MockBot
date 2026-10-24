const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const settings = require('../lib/guildSettings');

/**
 * Music control scopes (staff):
 *
 *   dj show                    - current DJ role + music channel
 *   dj role @role | off        - who may control the queue when not the
 *                                requester (song requesters, ManageGuild
 *                                staff and the bot owner always pass)
 *   dj channel #channel | off  - the only channel where `play`/`playlist
 *                                load` may start playback; control commands
 *                                still work anywhere
 */
module.exports = {
    name: 'dj',
    description: 'Set the DJ role and the music channel for this server',
    usage: 'dj <show|role|channel> [...]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('dj')
        .setDescription('Configure music-control restrictions')
        .addSubcommand(sub => sub
            .setName('show').setDescription('Show the current DJ role and music channel'))
        .addSubcommand(sub => sub
            .setName('role').setDescription('Require this role to control the queue')
            .addStringOption(o => o
                .setName('role').setDescription('Role mention or id, or "off"')
                .setRequired(true).setMaxLength(30)))
        .addSubcommand(sub => sub
            .setName('channel').setDescription('Restrict starting playback to one channel')
            .addChannelOption(o => o
                .setName('channel').setDescription('Text channel, or omit/off to clear')
                .addChannelTypes(ChannelType.GuildText))),

    async execute(ctx) {
        const guildId = ctx.guild.id;
        const current = settings.get(guildId);
        const sub = ctx.isSlash
            ? ctx.interaction.options.getSubcommand()
            : String(ctx.args[0] ?? 'show').toLowerCase();

        const show = () => ctx.reply(
            `🎧 Music controls:\n` +
            `• DJ role: ${current.djRoleId ? `<@&${current.djRoleId}>` : 'none — anyone in the voice channel'}\n` +
            `• Music channel: ${current.musicChannelId ? `<#${current.musicChannelId}>` : 'any channel'}`,
            { ephemeral: true },
        );

        if (sub === 'show' || !sub) return show();

        if (sub === 'role') {
            const raw = String(ctx.option('role') ?? ctx.args.slice(1).join(' ') ?? '').trim();
            if (!raw || /^(off|none|clear)$/i.test(raw)) {
                settings.patch(guildId, { djRoleId: null });
                return ctx.reply('🎧 DJ role cleared — the voice-channel rule applies again.', { ephemeral: true });
            }
            const id = raw.match(/(\d{17,20})/)?.[1];
            if (!id || !ctx.guild.roles.cache.has(id)) {
                return ctx.reply('Mention a real role: `dj role @DJ` (or `dj role off`).', { ephemeral: true });
            }
            settings.patch(guildId, { djRoleId: id });
            return ctx.reply(`🎧 Queue control now needs <@&${id}> (the requester, staff and the bot owner always pass).`, { ephemeral: true });
        }

        if (sub === 'channel') {
            const raw = ctx.option('channel') ?? ctx.args[1] ?? '';
            if (!raw || /^(off|none|clear)$/i.test(String(raw))) {
                settings.patch(guildId, { musicChannelId: null });
                return ctx.reply('🎵 Music can be started from any channel again.', { ephemeral: true });
            }
            const id = String(raw).match(/(\d{17,20})/)?.[1];
            if (!id) return ctx.reply('Mention the channel: `dj channel #music`.', { ephemeral: true });
            const channel = ctx.guild.channels.cache.get(id)
                ?? (await ctx.guild.channels.fetch(id).catch(() => null));
            if (!channel || typeof channel.send !== 'function') {
                return ctx.reply('❌ That is not a text channel I can post to here.', { ephemeral: true });
            }
            settings.patch(guildId, { musicChannelId: id });
            return ctx.reply(`🎵 \`play\` and \`playlist load\` will only work in ${channel}.`, { ephemeral: true });
        }

        return ctx.reply('Usage: `dj <show|role|channel> [...]`', { ephemeral: true });
    },
};
