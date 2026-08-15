const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'stop',
    description: 'Stop the music and clear the queue',
    usage: 'stop',
    data: new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue'),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        await queue.stop();
        return ctx.reply('⏹️ Stopped the music!');
    },
};
