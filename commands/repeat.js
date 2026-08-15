const { SlashCommandBuilder } = require('discord.js');

// DisTube RepeatMode: 0 = disabled, 1 = this song, 2 = all queue
const MODES = {
    off: 0, '0': 0, disable: 0,
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
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        const mode = MODES[String(ctx.args[0] ?? '').toLowerCase()];
        if (mode === undefined) {
            const current = queue.repeatMode ? (queue.repeatMode === 2 ? 'All Queue' : 'This Song') : 'Off';
            return ctx.reply(`Current repeat mode: **${current}**. Usage: \`${ctx.config.prefix}repeat <off | song | queue>\``);
        }

        queue.setRepeatMode(mode);
        const label = mode === 0 ? 'Off' : mode === 1 ? 'This Song' : 'All Queue';
        return ctx.reply(`🔁 Repeat mode set to **${label}**.`);
    },
};
