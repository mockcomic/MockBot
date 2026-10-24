const { SlashCommandBuilder } = require('discord.js');
const { play } = require('../lib/music');
const { songLink, mdTitle } = require('../lib/musicFormat');

module.exports = {
    name: 'play',
    aliases: ['p'],
    description: 'Play a song or playlist from a URL or search terms',
    usage: 'play <url | search terms>',
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or playlist from a URL or search terms')
        .addStringOption(option =>
            option.setName('query').setDescription('Song URL or search terms').setRequired(true),
        ),

    async execute(ctx) {
        if (!ctx.guild) return ctx.reply('Music commands only work in a server.');

        const voiceChannel = ctx.member?.voice?.channel
            ?? (await ctx.guild.members.fetch(ctx.user.id).catch(() => null))?.voice?.channel;
        if (!voiceChannel) return ctx.reply('Join a voice channel first, then try again.');

        const query = ctx.args.join(' ').trim();
        if (!query) return ctx.reply(`Usage: \`${ctx.config.prefix}play <url | search terms>\``);

        // Resolving through yt-dlp takes seconds, which is over the 3s interaction
        // budget — defer first, then edit the "thinking" response.
        if (ctx.isSlash) await ctx.defer();

        const alreadyIn = ctx.distube.getQueue(ctx.guild)?.voiceChannel?.id;

        try {
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
        } catch (err) {
            console.error('[play]', err);
            return ctx.reply(`❌ Could not play that: ${err.message}`);
        }
    },
};
