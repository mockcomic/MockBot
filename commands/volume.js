const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');

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
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const level = Number.parseInt(ctx.args[0], 10);
        if (Number.isNaN(level) || level < MIN_VOLUME || level > MAX_VOLUME) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}volume <${MIN_VOLUME}-${MAX_VOLUME}>\` (current: ${queue.volume}%)`);
        }

        queue.setVolume(level);
        return ctx.reply(`🔊 Volume set to ${level}%`);
    },
};
