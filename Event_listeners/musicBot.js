const { EmbedBuilder } = require('discord.js');
const { COLOR, songLink, statusLine } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

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
                            `▶️ Playing ${songLink(song)} — \`${song.formattedDuration}\`\n` +
                            `Requested by: ${song.user ?? 'Unknown'}\n${statusLine(queue)}`,
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
                            `🎶 Added ${songLink(song)} — \`${song.formattedDuration}\` to the queue by ${song.user ?? 'Unknown'}`,
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
                            `📄 Added \`${clip(playlist.name ?? 'playlist', 200)}\` playlist ` +
                            `(${playlist.songs.length} songs) to queue\n${statusLine(queue)}`,
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
            // DisTube removes the queue on its own but stays connected; stop()
            // is what actually disconnects.
            queue.stop().catch(() => {});
        })
        .on('noRelated', (queue, error) =>
            // Signature is (queue, error) — the second argument is a DisTubeError.
            send(queue, `❌ No related song could be found: ${error?.message ?? 'unknown reason'}`),
        )
        // Note: DisTube v5 has no `empty` event and no leaveOnEmpty option, so
        // "the room emptied out" is handled by Event_listeners/voiceIdle.js.
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
                `❌ An error occurred${song ? ` while playing \`${clip(song.name, 120)}\`` : ''}: ` +
                `${clip(error?.message ?? String(error), 800)}`,
            );
        });
};
