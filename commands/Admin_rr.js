const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const store = require('../lib/reactionRolesStore');
const { COLOR, mdTitle } = require('../lib/musicFormat');

/**
 * Post the reaction-role menu.
 *
 * Target channel, in order of precedence: an explicit channel argument
 * (`rr #reviews`), config.reactionRoles.channelId, or the channel the command
 * ran in. Menus are remembered per message (lib/reactionRolesStore), so
 * reactions only assign roles on menus this bot posted — in any channel, in
 * any guild.
 */
module.exports = {
    name: 'rr',
    adminOnly: PermissionFlagsBits.ManageRoles,
    description: 'Post the reaction-role menu (optionally into a given channel)',
    usage: 'rr [#channel]',
    category: 'staff',
    data: new SlashCommandBuilder()
        .setName('rr')
        .setDescription('Post the reaction-role menu')
        .addChannelOption(option =>
            option
                .setName('channel')
                .setDescription('Where to post (default: reactionRoles.channelId, else this channel)')
                .addChannelTypes(ChannelType.GuildText),
        ),

    async execute(ctx) {
        const rr = ctx.config.reactionRoles;
        if (!rr?.enabled || !Array.isArray(rr.roles) || rr.roles.length === 0) {
            return ctx.reply('❌ Reaction roles are not configured in config.json.');
        }

        const requested = String(ctx.option('channel') ?? ctx.args[0] ?? '').trim();
        let target = null;
        let source = 'this channel';

        if (requested) {
            const channelId = requested.match(/(\d{17,20})/)?.[1];
            if (!channelId) return ctx.reply('❌ Mention the channel: `rr #roles`.');
            target =
                ctx.guild.channels.cache.get(channelId) ??
                (await ctx.guild.channels.fetch(channelId).catch(() => null));
            if (!target) return ctx.reply('❌ That channel was not found in this server.');
            source = 'the channel you named';
        } else if (rr.channelId) {
            target =
                ctx.guild.channels.cache.get(rr.channelId) ??
                (await ctx.guild.channels.fetch(rr.channelId).catch(() => null));
            if (!target) {
                return ctx.reply(
                    `❌ Configured channel \`${rr.channelId}\` was not found in **${ctx.guild.name}**. ` +
                    'Fix `reactionRoles.channelId` in config.json, or pass a channel: `rr #roles`.',
                );
            }
            source = 'reactionRoles.channelId';
        } else {
            target = ctx.channel;
        }

        if (typeof target.send !== 'function') {
            return ctx.reply(`❌ ${target} is not a text channel I can post to.`);
        }

        const missing = [];
        const lines = rr.roles.map(entry => {
            const role = (entry.roleId && ctx.guild.roles.cache.get(entry.roleId))
                ?? ctx.guild.roles.cache.find(r => r.name === entry.name);
            if (!role) {
                missing.push(entry.name ?? entry.roleId);
                return `${entry.emoji} ${mdTitle(entry.name ?? 'unknown role')} *(role not found)*`;
            }
            // Show the id so the config can be pinned to it instead of a name.
            return `${entry.emoji} <@&${role.id}> — \`roleId: ${role.id}\``;
        });

        const embed = new EmbedBuilder()
            .setColor(COLOR.accent)
            .setTitle('Pick your roles')
            .setDescription(
                `Pick below — or react — to get or remove a role.\n\n${lines.join('\n')}\n\n` +
                'Only this message assigns roles; reactions and picks on other posts are ignored.',
            );

        // Native multi-select alongside the reactions: same roles, same rules,
        // but no custom-emoji fragility and it works on mobile keyboards.
        // The menu's own row is kept separately so a missing emoji still
        // leaves a usable select (max 25 rows).
        const chosen = rr.roles
            .map(entry => (entry.roleId && ctx.guild.roles.cache.get(entry.roleId))
                ?? ctx.guild.roles.cache.find(r => r.name === entry.name))
            .filter(Boolean)
            .slice(0, 25);

        let sent;
        try {
            sent = await target.send({
                embeds: [embed],
                components: chosen.length ? [{
                    type: 3,
                    customId: 'mb:rr',
                    placeholder: 'Choose your roles',
                    min_values: 0,
                    max_values: chosen.length,
                    options: chosen.map(role => ({
                        label: role.name.slice(0, 100),
                        value: role.id,
                        description: `roleId ${role.id}`.slice(0, 100),
                    })),
                }] : [],
            });
        } catch (err) {
            return ctx.reply(`❌ Could not post in ${target}: ${err.message}`);
        }

        store.record(sent.id, {
            channelId: target.id,
            guildId: ctx.guild.id,
            roleIds: chosen.map(r => r.id),
        });

        const failed = [];
        for (const entry of rr.roles) {
            await sent.react(entry.emoji).catch(err => failed.push(`${entry.emoji} (${err.message})`));
        }

        const notes = [
            missing.length ? `⚠️ Unresolved roles: ${missing.join(', ')} — check the names or set \`roleId\`.` : '',
            failed.length ? `⚠️ Could not react with: ${failed.join(', ')}` : '',
            missing.length || failed.length ? '' : '☑️ All reactions applied.',
        ].filter(Boolean).join('\n');

        return ctx.reply(`📌 Menu posted in ${target} (from ${source}): ${sent.url}\n${notes}`, { ephemeral: true });
    },
};
