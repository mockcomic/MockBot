const { SlashCommandBuilder } = require('discord.js');
const settings = require('../lib/guildSettings');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { humanListenerCount } = require('../lib/voteSkip');

/**
 * 24/7 voice mode. While on, the idle watcher never leaves and a finished
 * queue keeps the connection; `leave` is the manual exit.
 */
module.exports = {
    name: '247',
    aliases: ['stay'],
    description: 'Keep the bot in the voice channel when idle (toggle)',
    usage: '247',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('247')
        .setDescription('Keep the bot in voice when idle (toggle 24/7 mode)'),

    async execute(ctx) {
        if (!ctx.guild) return ctx.reply('24/7 mode is a per-server setting.');

        const queue = ctx.distube.getQueue(ctx.guild.id);
        if (queue) {
            const guard = await requireQueue(ctx);
            if (isBlocked(guard)) return ctx.reply(guard.reply);
        }

        const guildId = ctx.guild.id;
        const on = !settings.get(guildId).twentyFourSeven;
        settings.patch(guildId, { twentyFourSeven: on });

        const idle = ctx.voiceIdle;
        if (on) {
            idle?.disarm?.(guildId);
            return ctx.reply('🕐 24/7 mode on — I will stay in the voice channel even when nobody is around. `leave` disconnects me.');
        }
        // Turning off: if the room is already empty, arm the idle timer now
        // instead of waiting for the next voice-state event.
        const channel = queue?.voiceChannel ?? ctx.member?.voice?.channel ?? null;
        if (queue && channel && humanListenerCount(channel) === 0) {
            idle?.arm?.(queue, channel);
        }
        return ctx.reply(
            `🕛 24/7 mode off — I will leave after \`${ctx.config.music?.leaveOnEmptyAfterSeconds ?? 90}s\` alone.`,
        );
    },
};
