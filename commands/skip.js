const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'skip',
    aliases: ['next', 's'],
    description: 'Skip the current song',
    usage: 'skip',
    data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        try {
            await queue.skip();
        } catch (err) {
            return ctx.reply(`❌ ${err.message}`);
        }
        return ctx.reply('⏭️ Skipped.');
    },
};
