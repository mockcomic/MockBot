const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, parseTime, explainError, formatDuration } = require('../lib/musicGuards');

module.exports = {
    name: 'seek',
    description: 'Jump forward or back in the playing song (seconds or mm:ss)',
    usage: 'seek <seconds | mm:ss>',
    data: new SlashCommandBuilder()
        .setName('seek')
        .setDescription('Seek within the playing song')
        .addStringOption(option =>
            option.setName('position').setDescription('Seconds (90) or time (1:30)').setRequired(true),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const song = queue.songs[0];
        if (!song) return ctx.reply('Not playing music!');
        if (song.isLive) return ctx.reply('This is a live stream, so there is nothing to seek.');

        const seconds = parseTime(ctx.args[0]);
        if (seconds === null) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}seek <seconds | mm:ss>\` — for example \`${ctx.config.prefix}seek 90\` or \`${ctx.config.prefix}seek 1:30\`.`);
        }
        if (song.duration && seconds >= song.duration) {
            return ctx.reply(
                `\`${seconds}s\` is past the end of this song (${formatDuration(song.duration)}). ` +
                'Use `skip` instead.',
            );
        }

        try {
            await queue.seek(seconds);
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }
        return ctx.reply(`⏩ Seeked to ${formatDuration(seconds)}.`);
    },
};
