const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { buildNowPlayingEmbed, controlRow } = require('../lib/musicUi');

/**
 * The embed layout lives in lib/musicUi.js because the ⏸/⏭/🔀 buttons
 * rebuild the very same embed after every click.
 */
module.exports = {
    name: 'nowplaying',
    aliases: ['np', 'playing'],
    description: 'Show the song playing now and its progress (with player controls)',
    usage: 'nowplaying',
    category: 'music',
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the song playing now'),

    async execute(ctx) {
        const guard = await requireQueue(ctx, { sameVoice: false });
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const song = queue.songs[0];
        if (!song) return ctx.reply('Not playing music!');

        return ctx.reply({ embeds: [buildNowPlayingEmbed(queue, song)], components: [controlRow(queue)] });
    },
};
