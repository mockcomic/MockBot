const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'purge',
    ownerOnly: true,
    description: 'Delete up to 100 recent messages',
    usage: 'purge <1-100>',
    data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Delete up to 100 recent messages')
        .addIntegerOption(option =>
            option.setName('amount').setDescription('Number of messages to delete').setMinValue(1).setMaxValue(100).setRequired(true),
        ),

    async execute(ctx) {
        const amount = parseInt(ctx.args[0], 10);
        if (Number.isNaN(amount) || amount < 1 || amount > 100) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}purge <1-100>\``);
        }

        try {
            // filterOld=true skips messages older than 14 days (Discord API limit).
            const deleted = await ctx.channel.bulkDelete(amount, true);
            return ctx.reply(`🗑️ Deleted ${deleted.size} message(s). Note: Discord cannot bulk-delete messages older than 14 days.`);
        } catch (err) {
            console.error('[purge]', err);
            return ctx.reply(`❌ Purge failed: ${err.message}`);
        }
    },
};
