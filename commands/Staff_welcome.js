const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const settings = require('../lib/guildSettings');
const lifecycle = require('../Event_listeners/guildLifecycle');

/**
 * Configure the join welcome and auto-role (Event_listeners/guildLifecycle).
 *
 *   welcome show                     - current config
 *   welcome channel [#ch|off]        - where to greet (off = no greeting)
 *   welcome message <template|off>   - {member} {guild} {count} placeholders
 *   welcome roles @r1 @r2 ... | off  - auto-assigned roles (manageable ones)
 */
module.exports = {
    name: 'welcome',
    description: 'Set the join welcome message, channel, and auto-roles',
    usage: 'welcome <show|channel|message|roles> [...]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Configure the join welcome and auto-role')
        .addSubcommand(sub => sub
            .setName('show').setDescription('Show the current welcome config'))
        .addSubcommand(sub => sub
            .setName('channel').setDescription('Set or clear the welcome channel')
            .addChannelOption(o => o
                .setName('channel').setDescription('Text channel to greet in (omit to show)')
                .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub => sub
            .setName('message').setDescription('Set the welcome text ({member} {guild} {count})')
            .addStringOption(o => o.setName('template').setDescription('Leave empty for the default').setMaxLength(400)))
        .addSubcommand(sub => sub
            .setName('roles').setDescription('Auto-assign roles on join')
            .addStringOption(o => o
                .setName('roles').setDescription('Role mentions/ids, space-separated, or "off"')
                .setRequired(true).setMaxLength(600))),

    async execute(ctx) {
        const guildId = ctx.guild.id;
        const current = settings.get(guildId);
        const sub = ctx.isSlash
            ? ctx.interaction.options.getSubcommand()
            : String(ctx.args[0] ?? 'show').toLowerCase();

        const show = () => ctx.reply(
            `👋 Welcome config:\n` +
            `• Channel: ${current.welcomeChannelId ? `<#${current.welcomeChannelId}>` : 'off'}\n` +
            `• Message: ${current.welcomeMessage ? `\`${current.welcomeMessage}\`` : 'default'}\n` +
            `• Auto-roles: ${current.autoRoleIds?.length ? current.autoRoleIds.map(r => `<@&${r}>`).join(' ') : 'none'}\n` +
            `Placeholders: \`{member} {guild} {count}\``,
            { ephemeral: true },
        );

        if (sub === 'show' || !sub) return show();

        if (sub === 'channel') {
            const raw = ctx.option('channel') ?? ctx.args[1] ?? '';
            if (!raw || /^(off|clear)$/i.test(String(raw))) {
                settings.patch(guildId, { welcomeChannelId: null });
                return ctx.reply('👋 Welcome message turned off.', { ephemeral: true });
            }
            const id = String(raw).match(/(\d{17,20})/)?.[1];
            if (!id) return ctx.reply('Mention the channel: `welcome channel #general`.', { ephemeral: true });
            const channel = ctx.guild.channels.cache.get(id)
                ?? (await ctx.guild.channels.fetch(id).catch(() => null));
            if (!channel || typeof channel.send !== 'function') {
                return ctx.reply('❌ That is not a text channel I can post to here.', { ephemeral: true });
            }
            settings.patch(guildId, { welcomeChannelId: id });
            return ctx.reply(`👋 New members will be greeted in ${channel}.`, { ephemeral: true });
        }

        if (sub === 'message') {
            const template = String(ctx.option('template') ?? ctx.args.slice(1).join(' ') ?? '').trim();
            if (!template || /^(off|default|reset)$/i.test(template)) {
                settings.patch(guildId, { welcomeMessage: null });
                return ctx.reply(`👋 Back to the default text:\n\`${lifecycle.DEFAULT_WELCOME}\``, { ephemeral: true });
            }
            settings.patch(guildId, { welcomeMessage: template.slice(0, 400) });
            return ctx.reply(`👋 Welcome text set to:\n\`${template.slice(0, 400)}\``, { ephemeral: true });
        }

        if (sub === 'roles') {
            const raw = String(ctx.option('roles') ?? ctx.args.slice(1).join(' ') ?? '').trim();
            if (!raw || /^(off|none|clear)$/i.test(raw)) {
                settings.patch(guildId, { autoRoleIds: null });
                return ctx.reply('👋 Auto-roles cleared.', { ephemeral: true });
            }
            const ids = [...new Set(raw.match(/\d{17,20}/g) ?? [])];
            if (!ids.length) return ctx.reply('Mention the roles: `welcome roles @Member @Verified` (max 5).', { ephemeral: true });
            if (ids.length > 5) return ctx.reply('❌ At most 5 auto-roles.', { ephemeral: true });

            const bad = ids.filter(id => !ctx.guild.roles.cache.has(id));
            if (bad.length) return ctx.reply(`❌ Unknown role id(s): ${bad.join(', ')}`, { ephemeral: true });

            const unmanaged = lifecycle.resolvableRoles(ctx.guild, ids).length !== ids.length;
            settings.patch(guildId, { autoRoleIds: ids });
            return ctx.reply(
                `👋 Auto-roles set: ${ids.map(r => `<@&${r}>`).join(' ')}` +
                (unmanaged ? '\n⚠️ Some of those sit above my highest role — they will be skipped on join.' : ''),
                { ephemeral: true },
            );
        }

        return ctx.reply('Usage: `welcome <show|channel|message|roles> [...]`', { ephemeral: true });
    },
};
