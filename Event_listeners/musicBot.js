const { EmbedBuilder } = require('discord.js');

const COLOR = {
    play: 0x57f287,
    add: 0x3498db,
    list: 0x3498db,
    info: 0xf1c40f,
    error: 0xed4245,
};

function status(queue) {
    const loop = queue.repeatMode ? (queue.repeatMode === 2 ? 'All Queue' : 'This Song') : 'Off';
    const filters = queue.filters?.names?.join(', ') || 'Off';
    return `Volume: \`${queue.volume}%\` | Filter: \`${filters}\` | Loop: \`${loop}\` | Autoplay: \`${queue.autoplay ? 'On' : 'Off'}\``;
}

function send(queue, payload) {
    queue.textChannel?.send(payload).catch(() => {});
}

/**
 * Register DisTube v5 events. Signatures are queue-based now:
 *   playSong(queue, song), addSong(queue, song), addList(queue, playlist),
 *   finish(queue), error(error, queue, song?)
 */
module.exports = function setupMusicEvents(distube) {
    distube
        .on('playSong', (queue, song) =>
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.play)
                        .setDescription(
                            `▶️ Playing [${song.name}](${song.url}) — \`${song.formattedDuration}\`\n` +
                            `Requested by: ${song.user ?? 'Unknown'}\n${status(queue)}`,
                        )
                        .setThumbnail(song.thumbnail ?? null),
                ],
            }),
        )
        .on('addSong', (queue, song) =>
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.add)
                        .setDescription(
                            `🎶 Added [${song.name}](${song.url}) — \`${song.formattedDuration}\` to the queue by ${song.user ?? 'Unknown'}`,
                        ),
                ],
            }),
        )
        .on('addList', (queue, playlist) =>
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.list)
                        .setDescription(
                            `📄 Added \`${playlist.name}\` playlist (${playlist.songs.length} songs) to queue\n${status(queue)}`,
                        ),
                ],
            }),
        )
        .on('finish', queue => {
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.info)
                        .setDescription('⏹️ Queue finished — leaving the voice channel.'),
                ],
            });
            queue.stop().catch(() => {});
        })
        .on('noRelated', (queue, error) =>
            send(queue, `❌ No related song could be found: ${error.message}`),
        )
        .on('disconnect', queue =>
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.info)
                        .setDescription('👋 Disconnected from the voice channel.'),
                ],
            }),
        )
        .on('error', (error, queue, song) => {
            console.error('[distube]', error);
            send(
                queue,
                `❌ An error occurred${song ? ` while playing \`${song.name}\`` : ''}: ${error.message}`,
            );
        });
};
