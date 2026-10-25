const { EmbedBuilder } = require('discord.js');
const { COLOR, songLink, statusLine } = require('../lib/musicFormat');
const { disconnect } = require('../lib/music');
const { clip } = require('../lib/respond');
const { controlRow } = require('../lib/musicUi');
const autoplay = require('../lib/autoplay');
const history = require('../lib/playHistory');
const guildSettings = require('../lib/guildSettings');

function send(queue, payload) {
    queue.textChannel?.send(payload).catch(() => {});
}

/**
 * Register DisTube v5 events. Signatures are queue-based now:
 *   playSong(queue, song), addSong(queue, song), addList(queue, playlist),
 *   finish(queue), error(error, queue, song?)
 *
 * The `finish` branch decides what "the queue ended" actually means for this
 * guild, in order of priority:
 *   1. autoplay on  → queue the next song from the radio mix and stay put
 *   2. 24/7 on      → nothing, just say the queue finished (stay connected)
 *   3. otherwise    → stop(): clear the queue and disconnect (as before v3.2)
 */
module.exports = function setupMusicEvents(distube, deps = {}) {
    const config = deps.config ?? {};

    distube
        .on('playSong', (queue, song) => {
            autoplay.recordPlay(queue.id, song);
            history.recordPlay(queue, song);
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
                components: [controlRow(queue)],
            });
        })
        .on('addSong', (queue, song) => {
            // Same URL already pending? Say so and give its row, so a repeated
            // play does not look like it vanished into the list.
            const dupIndex = queue.songs.findIndex(
                (s, i) => i > 0 && s.url && song.url && s.url === song.url,
            );
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.add)
                        .setDescription(
                            `🎶 Added ${songLink(song)} — \`${song.formattedDuration}\` to the queue by ${song.user ?? 'Unknown'}` +
                            (dupIndex > 0
                                ? `\n⚠️ It was already queued at position ${dupIndex + 1}, so this copy sits at position ${queue.songs.length}.`
                                : ''),
                        ),
                ],
            });
        })
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
        .on('finish', async queue => {
            const guildId = queue.id;

            if (autoplay.enabledFor(guildId, config) && autoplay.canContinue(guildId)) {
                const next = await autoplay.nextSong(distube, guildId, {
                    member: null,
                    textChannel: queue.textChannel,
                });
                if (next) {
                    try {
                        await distube.play(queue.voiceChannel, next, {
                            member: null,
                            textChannel: queue.textChannel,
                        });
                        return; // playSong announces it with the controls
                    } catch (err) {
                        console.error('[autoplay]', err);
                    }
                }
            }

            if (guildSettings.get(guildId).twentyFourSeven) {
                send(queue, {
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLOR.info)
                            .setDescription('⏹️ Queue finished — staying connected (24/7 mode). `leave` disconnects me.'),
                    ],
                });
                return;
            }

            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.info)
                        .setDescription('⏹️ Queue finished — leaving the voice channel.'),
                ],
            });
            // DisTube removes the queue on its own but stays connected; stop()
            // alone only halts the player — voices.leave destroys the connection.
            await disconnect(distube, queue);
        })
        .on('finishSong', (queue, song) => history.recordFinish(queue, song))
        .on('noRelated', (queue, error) =>
            // Signature is (queue, error) — the second argument is a DisTubeError.
            send(queue, `❌ No related song could be found: ${error?.message ?? 'unknown reason'}`),
        )
        // Note: DisTube v5 has no `empty` event and no leaveOnEmpty option, so
        // "the room emptied out" is handled by Event_listeners/voiceIdle.js.
        .on('disconnect', queue => {
            history.recordAbandon(queue); // stop() mid-song = skipped
            send(queue, {
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLOR.info)
                        .setDescription('👋 Disconnected from the voice channel.'),
                ],
            });
        })
        .on('error', (error, queue, song) => {
            console.error('[distube]', error);
            send(
                queue,
                `❌ An error occurred${song ? ` while playing \`${clip(song.name, 120)}\`` : ''}: ` +
                `${clip(error?.message ?? String(error), 800)}`,
            );
        });
};
