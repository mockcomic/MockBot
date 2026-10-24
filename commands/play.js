const { SlashCommandBuilder } = require('discord.js');
const crypto = require('node:crypto');
const { play, search, isUrl } = require('../lib/music');
const { songLink, mdTitle } = require('../lib/musicFormat');
const { playChannelReply } = require('../lib/musicGuards');
const picker = require('../lib/searchPicker');

/**
 * `play` — URL goes straight in; plain search terms show a top-5 picker
 * (lib/searchPicker) instead of auto-picking the #1 hit and guessing wrong.
 * `--direct` (slash) / `play! <terms>` (prefix) keeps the old auto-pick.
 */
module.exports = {
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or playlist from a URL or search terms',
    usage: 'play <url | search terms>   (play! terms = no picker)',
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or playlist from a URL or search terms')
        .addStringOption(option =>
            option.setName('query').setDescription('Song URL or search terms').setRequired(true),
        )
        .addBooleanOption(option =>
            option.setName('direct')
                .setDescription('Skip the picker and play the top search result'),
        ),

    async execute(ctx) {
        if (!ctx.guild) return ctx.reply('Music commands only work in a server.');

        const wrongChannel = playChannelReply(ctx.guild, ctx.channel);
        if (wrongChannel) return ctx.reply(wrongChannel);

        const voiceChannel = ctx.member?.voice?.channel
            ?? (await ctx.guild.members.fetch(ctx.user.id).catch(() => null))?.voice?.channel;
        if (!voiceChannel) return ctx.reply('Join a voice channel first, then try again.');

        // `!play! data` — the bang is the opt-out from the picker.
        let query = ctx.args.join(' ').trim();
        let direct = Boolean(ctx.option('direct'));
        if (query.startsWith('!')) { direct = true; query = query.slice(1).trim(); }
        if (!query) return ctx.reply(`Usage: \`${ctx.config.prefix}play <url | search terms>\``);

        // Resolving through yt-dlp takes seconds, which is over the 3s interaction
        // budget — defer first, then edit the "thinking" response.
        if (ctx.isSlash) await ctx.defer();

        const alreadyIn = ctx.distube.getQueue(ctx.guild)?.voiceChannel?.id;

        try {
            // URL or an explicit opt-out: one-shot resolve like before v3.4.
            if (isUrl(query) || direct) {
                const resolved = await play(ctx.distube, voiceChannel, query, {
                    member: ctx.member,
                    textChannel: ctx.channel,
                    message: ctx.message ?? undefined,
                });

                const isPlaylist = Array.isArray(resolved?.songs);
                const what = isPlaylist
                    ? `playlist **${mdTitle(resolved.name)}** (${resolved.songs.length} songs)`
                    : songLink(resolved);

                const moved = alreadyIn && alreadyIn !== voiceChannel.id
                    ? ` Moved from <#${alreadyIn}> to follow you.`
                    : '';

                // The playSong/addSong embeds carry the detail; this only confirms
                // the slash command so it does not look like nothing happened.
                return ctx.reply(`✅ Queued ${what} in **${voiceChannel.name}**.${moved}`);
            }

            const results = await search(ctx.distube, query, 5);
            if (!results.length) return ctx.reply(`❌ Nothing found for **${mdTitle(query, 100)}**.`);
            if (results.length === 1) {
                // Nothing to choose between — same behaviour as --direct.
                const resolved = await ctx.distube.play(voiceChannel, results[0], {
                    member: ctx.member,
                    textChannel: ctx.channel,
                    message: ctx.message ?? undefined,
                }).then(() => results[0]);
                return ctx.reply(`✅ Queued ${songLink(resolved)} in **${voiceChannel.name}**.`);
            }

            const token = crypto.randomBytes(8).toString('hex');
            picker.open(token, {
                songs: results,
                voiceChannelId: voiceChannel.id,
                textChannelId: ctx.channel.id,
                guildId: ctx.guild.id,
                userId: ctx.user.id,
            });
            return ctx.reply({ ...picker.pickerPayload(query, results, token), ephemeral: true });
        } catch (err) {
            console.error('[play]', err);
            return ctx.reply(`❌ Could not play that: ${err.message}`);
        }
    },
};
