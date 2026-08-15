const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'pause',
    aliases: ['resume'],
    description: 'Pause or resume the current song',
    usage: 'pause',
    data: new SlashCommandBuilder().setName('pause').setDescription('Pause or resume the current song'),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        if (queue.paused) {
            await queue.resume();
            return ctx.reply('▶️ Resumed.');
        }
        await queue.pause();
        return ctx.reply('⏸️ Paused. Use the command again to resume.');
    },
};
