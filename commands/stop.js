const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const queueResume = require('../lib/queueResume');

module.exports = {
    name: 'stop',
    description: 'Stop the music and clear the queue',
    usage: 'stop',
    data: new SlashCommandBuilder().setName('stop').setDescription('Stop the music and clear the queue'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);

        await guard.queue.stop();
        queueResume.forget(ctx.guild.id); // a manual stop must not come back on restart
        return ctx.reply('⏹️ Stopped the music!');
    },
};
