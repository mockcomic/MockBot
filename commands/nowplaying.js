const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { COLOR, songLink, progressLine, statusLine, loopLabel } = require('../lib/musicFormat');

module.exports = {
    name: 'nowplaying',
    aliases: ['np', 'playing'],
    description: 'Show the song playing now and its progress',
    usage: 'nowplaying',
    data: new SlashCommandBuilder().setName('nowplaying').setDescription('Show the song playing now'),

    async execute(ctx) {
        const guard = await requireQueue(ctx, { sameVoice: false });
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const song = queue.songs[0];
        if (!song) return ctx.reply('Not playing music!');

        const lines = [
            `**${songLink(song)}**`,
            progressLine(queue, song),
            '',
            `Requested by: ${song.user ?? 'Unknown'}`,
            `Channel: ${song.uploader?.name ?? 'Unknown'}`,
            typeof song.views === 'number' ? `Views: ${song.views.toLocaleString('en-US')}` : null,
            queue.songs.length > 1
                ? `Up next: ${songLink(queue.songs[1])}`
                : 'Nothing else in the queue.',
        ].filter(Boolean);

        const embed = new EmbedBuilder()
            .setColor(COLOR.play)
            .setTitle('🎶 Now playing')
            .setDescription(lines.join('\n'))
            .setThumbnail(song.thumbnail ?? null)
            .setFooter({
                text: `Loop: ${loopLabel(queue.repeatMode)} | Autoplay: ${queue.autoplay ? 'On' : 'Off'} | ${statusLine(queue)}`,
            });

        return ctx.reply({ embeds: [embed] });
    },
};
