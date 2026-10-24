const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, explainError } = require('../lib/musicGuards');

module.exports = {
    name: 'previous',
    aliases: ['prev', 'back'],
    description: 'Play the previously skipped/finished song',
    usage: 'previous',
    data: new SlashCommandBuilder().setName('previous').setDescription('Play the previous song'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        if (!queue.previousSongs?.length) {
            return ctx.reply('Nothing has finished or been skipped yet, so there is no history.');
        }

        try {
            await queue.previous();
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }
        return ctx.reply('⏮️ Playing the previous song.');
    },
};
