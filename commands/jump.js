const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'jump',
    description: 'Jump to a specific song in the queue',
    usage: 'jump <song number>',
    data: new SlashCommandBuilder()
        .setName('jump')
        .setDescription('Jump to a specific song in the queue')
        .addIntegerOption(option =>
            option.setName('position').setDescription('Song number in the queue').setMinValue(1).setRequired(true),
        ),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        const position = parseInt(ctx.args[0], 10);
        if (Number.isNaN(position) || position < 1 || position >= queue.songs.length) {
            return ctx.reply(`Invalid song number. The queue has ${queue.songs.length} song(s) (position 1 is playing now).`);
        }

        try {
            await queue.jump(position);
        } catch (err) {
            return ctx.reply(`❌ ${err.message}`);
        }
        return ctx.reply(`⏭️ Jumped to song **${position}**.`);
    },
};
