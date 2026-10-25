const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { disconnect } = require('../lib/music');

/**
 * Manual exit — 24/7 mode otherwise keeps the connection on purpose, so
 * there has to be a way to say "go home". Clears the queue and disconnects.
 * Queue#stop() alone never hangs up (it only stops the player), so the
 * disconnect helper has to destroy the voice connection too.
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
        const queue = ctx.distube.getQueue(ctx.guild);
        if (queue) {
            const guard = await requireQueue(ctx, { sameVoice: false });
            if (isBlocked(guard)) return ctx.reply(guard.reply);
        }

        // No queue either (24/7 parked after the last song): still hang up —
        // voices.leave falls back to destroying the bare voice connection.
        await disconnect(ctx.distube, queue, ctx.guild.id);
        return ctx.reply('👋 Left the voice channel.');
    },
};
