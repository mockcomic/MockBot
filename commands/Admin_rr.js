const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const store = require('../lib/reactionRolesStore');
const { COLOR, mdTitle } = require('../lib/musicFormat');

/**
 * Post the reaction-role menu into config.reactionRoles.channelId.
 *
 * This used to post into whatever channel the command was run from, while the
 * listener only accepted reactions in the configured channel — so a menu posted
 * anywhere else looked fine and silently did nothing.
 */
module.exports = {
    name: 'rr',
    adminOnly: PermissionFlagsBits.ManageRoles,
    description: 'Post the reaction-role menu into the configured channel',
    usage: 'rr',
    data: new SlashCommandBuilder()
        .setName('rr')
        .setDescription('Post the reaction-role menu (into reactionRoles.channelId)'),

    async execute(ctx) {
        const rr = ctx.config.reactionRoles;
        if (!rr?.enabled || !Array.isArray(rr.roles) || rr.roles.length === 0) {
            return ctx.reply('❌ Reaction roles are not configured in config.json.');
        }
        if (!rr.channelId) {
            return ctx.reply('❌ Set `reactionRoles.channelId` in config.json first.');
        }

        const target =
            ctx.guild.channels.cache.get(rr.channelId) ??
            (await ctx.guild.channels.fetch(rr.channelId).catch(() => null));

        if (!target) {
            return ctx.reply(
                `❌ Configured channel \`${rr.channelId}\` was not found in **${ctx.guild.name}**. ` +
                'Fix `reactionRoles.channelId` in config.json.',
            );
        }
        if (typeof target.send !== 'function') {
            return ctx.reply(`❌ <#${rr.channelId}> is not a text channel I can post to.`);
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
                `React to this message to get or remove a role.\n\n${lines.join('\n')}\n\n` +
                `Only this message assigns roles; reactions on other posts in ${target} are ignored.`,
            );

        let sent;
        try {
            sent = await target.send({ embeds: [embed] });
        } catch (err) {
            return ctx.reply(`❌ Could not post in ${target}: ${err.message}`);
        }

        store.record(sent.id);

        const failed = [];
        for (const entry of rr.roles) {
            await sent.react(entry.emoji).catch(err => failed.push(`${entry.emoji} (${err.message})`));
        }

        const notes = [
            missing.length ? `⚠️ Unresolved roles: ${missing.join(', ')} — check the names or set \`roleId\`.` : '',
            failed.length ? `⚠️ Could not react with: ${failed.join(', ')}` : '',
            missing.length || failed.length ? '' : '☑️ All reactions applied.',
        ].filter(Boolean).join('\n');

        return ctx.reply(`📌 Menu posted in ${target}: ${sent.url}\n${notes}`, { ephemeral: true });
    },
};
