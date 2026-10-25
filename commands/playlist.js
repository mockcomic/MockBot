const { SlashCommandBuilder } = require('discord.js');
const { Playlist } = require('distube');
const store = require('../lib/playlistsStore');
const { YtDlpPluginPatched } = require('../lib/YtDlpPluginPatched');
const { rebuildStoredSong } = require('../lib/music');
const { requireQueue, isBlocked, playChannelReply } = require('../lib/musicGuards');
const { mdTitle } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

/**
 * Saved queues. A playlist stores display fields + urls only, so loading it
 * rebuilds Song objects and hands DisTube a Playlist directly — a 200-song
 * list starts without a single yt-dlp call (streams resolve as they play).
 * (rebuildStoredSong lives in lib/music.js, shared with queue resume.)
 */

function usage(ctx) {
    return (
        `Usage: \`${ctx.config.prefix}playlist save <name> [replace]\` · ` +
        `\`load <name>\` · \`list\` · \`show <name>\` · \`delete <name>\``
    );
}

module.exports = {
    name: 'playlist',
    aliases: ['lists'],
    description: `Save and reload the queue as a named playlist (up to ${store.MAX_SONGS} songs, ${store.MAX_PLAYLISTS} lists per server)`,
    usage: 'playlist <save|load|list|show|delete> [name]',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('playlist')
        .setDescription('Save and reload queues as named playlists')
        .addStringOption(option =>
            option
                .setName('action')
                .setDescription('What to do')
                .setRequired(true)
                .addChoices(
                    { name: 'save current queue', value: 'save' },
                    { name: 'load into the queue', value: 'load' },
                    { name: 'list saved playlists', value: 'list' },
                    { name: 'show one playlist', value: 'show' },
                    { name: 'delete a playlist', value: 'delete' },
                ),
        )
        .addStringOption(option =>
            option.setName('name').setDescription('Playlist name').setMaxLength(32),
        )
        .addBooleanOption(option =>
            option.setName('replace').setDescription('Overwrite an existing playlist (save)'),
        ),

    async execute(ctx) {
        // Slash passes ['<action>', '<name>', …] with the action always first
        // (it is a required option); prefix passes ['<action>', ...nameWords,
        // 'replace'?]. Multi-word names rejoin with spaces.
        const action = String(ctx.option('action') ?? ctx.args[0] ?? '').toLowerCase();
        const rest = ctx.args.slice(1);
        const replaceFlag = String(rest.at(-1) ?? '').toLowerCase() === 'replace';
        if (replaceFlag) rest.pop();
        const name = String(ctx.option('name') ?? rest.join(' ')).trim();

        if (!action) return ctx.reply(usage(ctx));

        switch (action) {
            case 'save': {
                if (!name) return ctx.reply(usage(ctx));
                const guard = await requireQueue(ctx, { sameVoice: false });
                if (isBlocked(guard)) return ctx.reply(guard.reply);
                const replace = ctx.option('replace') === true || replaceFlag;
                const result = store.save(ctx.guild.id, name, guard.queue.songs, { replace });
                if (!result.ok) return ctx.reply(`❌ ${result.error}`);
                return ctx.reply(
                    `💾 Saved **${mdTitle(result.playlist.name)}** (${result.playlist.songs.length} songs).`,
                );
            }

            case 'load': {
                if (!name) return ctx.reply(usage(ctx));
                const saved = store.get(ctx.guild.id, name);
                if (!saved) return ctx.reply(`❌ No playlist called \`${name}\` here. Try \`${ctx.config.prefix}playlist list\`.`);

                const voiceChannel = ctx.member?.voice?.channel
                    ?? (await ctx.guild.members.fetch(ctx.user.id).catch(() => null))?.voice?.channel;
                if (!voiceChannel) return ctx.reply('Join a voice channel first, then try again.');

                // Loading a list starts playback, so the music-channel rule applies.
                const wrongChannel = playChannelReply(ctx.guild, ctx.channel);
                if (wrongChannel) return ctx.reply(wrongChannel);

                const plugin = ctx.distube.plugins.find(p => p instanceof YtDlpPluginPatched);
                if (!plugin) return ctx.reply('❌ The yt-dlp plugin is not loaded, so saved playlists cannot play.');

                const options = {
                    member: ctx.member,
                    textChannel: ctx.channel,
                    message: ctx.message ?? undefined,
                };
                const songs = saved.songs.map(entry => rebuildStoredSong(plugin, entry, options));
                const what = songs.length === 1
                    ? songs[0]
                    : new Playlist(
                        {
                            source: 'yt-dlp',
                            songs,
                            id: store.keyOf(saved.name),
                            name: saved.name,
                            url: saved.songs[0]?.url,
                            thumbnail: saved.songs[0]?.thumbnail ?? undefined,
                        },
                        options,
                    );

                await ctx.distube.play(voiceChannel, what, options);
                return ctx.reply(
                    `✅ Loaded **${mdTitle(saved.name)}** (${songs.length} song${songs.length === 1 ? '' : 's'}) in **${voiceChannel.name}**.`,
                );
            }

            case 'show': {
                if (!name) return ctx.reply(usage(ctx));
                const saved = store.get(ctx.guild.id, name);
                if (!saved) return ctx.reply(`❌ No playlist called \`${name}\` here.`);
                const rows = saved.songs
                    .slice(0, 15)
                    .map((s, i) => `\`${i + 1}.\` ${mdTitle(s.name)} — \`${Math.round((s.duration || 0) / 60)}m\``)
                    .join('\n');
                const more = saved.songs.length > 15 ? `\n…and ${saved.songs.length - 15} more.` : '';
                return ctx.reply(
                    `**${mdTitle(saved.name)}** (${saved.songs.length} songs, updated ${saved.updatedAt?.slice(0, 10) ?? '?'}):\n${clip(`${rows}${more}`, 1800)}`,
                );
            }

            case 'delete': {
                if (!name) return ctx.reply(usage(ctx));
                const removed = store.remove(ctx.guild.id, name);
                return ctx.reply(
                    removed ? `🗑️ Deleted \`${name}\`.` : `❌ No playlist called \`${name}\` here.`,
                );
            }

            case 'list':
            default: {
                const entries = store.list(ctx.guild.id);
                if (!entries.length) {
                    return ctx.reply(`No saved playlists yet — \`playlist save <name>\` stores the current queue (${store.MAX_PLAYLISTS} allowed).`);
                }
                const rows = entries
                    .map(e => `• **${mdTitle(e.name)}** — ${e.songs} songs, updated ${e.updatedAt?.slice(0, 10) ?? '?'}`)
                    .join('\n');
                return ctx.reply(clip(`**Saved playlists:**\n${rows}`, 1990));
            }
        }
    },
};
