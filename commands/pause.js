const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

module.exports = {
    name: 'pause',
    // Also the resume command: it toggles, so both names are useful as prefixes.
    aliases: ['resume', 'unpause'],
    description: 'Pause or resume the current song',
    usage: 'pause',
    data: new SlashCommandBuilder().setName('pause').setDescription('Pause or resume the current song'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        if (queue.paused) {
            await queue.resume();
            return ctx.reply('▶️ Resumed.');
        }
        await queue.pause();
        return ctx.reply('⏸️ Paused. Run the command again to resume.');
    },
};
