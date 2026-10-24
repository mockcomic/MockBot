const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, explainError } = require('../lib/musicGuards');

module.exports = {
    name: 'shuffle',
    aliases: ['mix'],
    description: 'Shuffle the pending queue (the playing song stays put)',
    usage: 'shuffle',
    data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the pending queue'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        if (queue.songs.length < 3) {
            return ctx.reply('Add at least two more songs before shuffling.');
        }

        try {
            await queue.shuffle();
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }
        return ctx.reply(`🔀 Shuffled the remaining ${queue.songs.length - 1} song(s).`);
    },
};
