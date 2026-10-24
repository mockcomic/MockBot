const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

/**
 * Manual exit — 24/7 mode otherwise keeps the connection on purpose, so
 * there has to be a way to say "go home". Clears the queue and disconnects,
 * same as `stop` did before 24/7 existed.
 */
module.exports = {
    name: 'leave',
    aliases: ['disconnect', 'dc'],
    description: 'Disconnect from the voice channel (even in 24/7 mode)',
    usage: 'leave',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Disconnect the bot from the voice channel'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);

        await guard.queue.stop().catch(() => {});
        return ctx.reply('👋 Left the voice channel.');
    },
};
