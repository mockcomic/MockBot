const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

/**
 * Post the reaction-role message for this server. Role names/emoji and the
 * target channel come from config.reactionRoles; the reaction listeners live
 * in Event_listeners/reactionRoles.js (registered once at startup).
 */
module.exports = {
    name: 'rr',
    ownerOnly: true,
    description: 'Post the reaction-role message',
    usage: 'rr',
    data: new SlashCommandBuilder().setName('rr').setDescription('Post the reaction-role message'),

    async execute(ctx) {
        const rr = ctx.config.reactionRoles;
        if (!rr?.enabled || !Array.isArray(rr.roles) || rr.roles.length === 0) {
            return ctx.reply('❌ Reaction roles are not configured in config.json.');
        }

        const lines = rr.roles.map(entry => `${entry.emoji} ${entry.name}`).join('\n');
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Pick your roles')
            .setDescription(`React to this message to get or remove a role.\n\n${lines}`);

        const sent = await ctx.channel.send({ embeds: [embed] });
        for (const entry of rr.roles) {
            await sent.react(entry.emoji).catch(err => console.error('[rr] react failed:', err.message));
        }

        return ctx.reply('☑️ Reaction-role message posted.');
    },
};
