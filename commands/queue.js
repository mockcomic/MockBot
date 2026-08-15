const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'queue',
    aliases: ['q'],
    description: 'Show the current music queue',
    usage: 'queue',
    data: new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue'),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue || queue.songs.length === 0) return ctx.reply('Not playing music!');

        const listed = queue.songs
            .slice(0, 10)
            .map((song, id) => `**${id + 1}**. ${song.name} — \`${song.formattedDuration}\``)
            .join('\n');
        const remaining = queue.songs.length - 10;

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`📄 Queue for ${ctx.guild.name}`)
            .setDescription(listed + (remaining > 0 ? `\n…and ${remaining} more song(s)` : ''))
            .setFooter({
                text: `Volume: ${queue.volume}% | Loop: ${queue.repeatMode ? (queue.repeatMode === 2 ? 'All Queue' : 'This Song') : 'Off'} | Autoplay: ${queue.autoplay ? 'On' : 'Off'}`,
            });

        return ctx.reply({ embeds: [embed] });
    },
};
