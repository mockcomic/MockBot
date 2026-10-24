const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

module.exports = {
    name: 'clear',
    description: 'Remove every queued song but let the current one finish',
    usage: 'clear',
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Clear the queue after the song playing now'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);

        const removed = guard.queue.songs.splice(1);
        return ctx.reply(removed.length
            ? `🧹 Cleared ${removed.length} queued song(s); the playing song will finish normally. Use \`stop\` to end it now.`
            : 'The queue after the playing song was already empty.');
    },
};
