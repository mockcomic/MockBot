const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { loopLabel } = require('../lib/musicFormat');

// DisTube RepeatMode: 0 = disabled, 1 = this song, 2 = all queue
const MODES = {
    off: 0, '0': 0, disable: 0, none: 0,
    song: 1, one: 1, '1': 1,
    queue: 2, all: 2, '2': 2,
};

module.exports = {
    name: 'repeat',
    aliases: ['loop'],
    description: 'Set repeat mode: off, song, or queue',
    usage: 'repeat <off | song | queue>',
    data: new SlashCommandBuilder()
        .setName('repeat')
        .setDescription('Set repeat mode')
        .addStringOption(option =>
            option
                .setName('mode')
                .setDescription('Repeat mode')
                .setRequired(true)
                .addChoices(
                    { name: 'Off', value: 'off' },
                    { name: 'This Song', value: 'song' },
                    { name: 'All Queue', value: 'queue' },
                ),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const mode = MODES[String(ctx.args[0] ?? '').toLowerCase()];
        if (mode === undefined) {
            return ctx.reply(
                `Current repeat mode: **${loopLabel(queue.repeatMode)}**. ` +
                `Usage: \`${ctx.config.prefix}repeat <off | song | queue>\``,
            );
        }

        queue.setRepeatMode(mode);
        return ctx.reply(`🔁 Repeat mode set to **${loopLabel(mode)}**.`);
    },
};
