const { SlashCommandBuilder } = require('discord.js');

const MIN_VOLUME = 0;
const MAX_VOLUME = 150;

module.exports = {
    name: 'volume',
    aliases: ['vol', 'v'],
    description: `Set the playback volume (${MIN_VOLUME}-${MAX_VOLUME})`,
    usage: 'volume <0-150>',
    data: new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set the playback volume')
        .addIntegerOption(option =>
            option
                .setName('level')
                .setDescription(`Volume between ${MIN_VOLUME} and ${MAX_VOLUME}`)
                .setMinValue(MIN_VOLUME)
                .setMaxValue(MAX_VOLUME)
                .setRequired(true),
        ),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        const level = parseInt(ctx.args[0], 10);
        if (Number.isNaN(level) || level < MIN_VOLUME || level > MAX_VOLUME) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}volume <${MIN_VOLUME}-${MAX_VOLUME}>\` (current: ${queue.volume}%)`);
        }

        queue.setVolume(level);
        return ctx.reply(`🔊 Volume set to ${level}%`);
    },
};
