const { SlashCommandBuilder } = require('discord.js');
const { play } = require('../lib/music');

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

        const voiceChannel = ctx.member?.voice?.channel;
        if (!voiceChannel) return ctx.reply('Join a voice channel first, then try again.');

        const query = ctx.args.join(' ').trim();
        if (!query) return ctx.reply(`Usage: \`${ctx.config.prefix}play <url | search terms>\``);

        if (ctx.isSlash) await ctx.defer();

        try {
            await play(ctx.distube, voiceChannel, query, {
                member: ctx.member,
                textChannel: ctx.channel,
                message: ctx.message ?? undefined,
            });
            if (ctx.isSlash) {
                await ctx.reply(`🔎 Resolved \`${query}\` — playing in **${voiceChannel.name}**.`);
            }
        } catch (err) {
            console.error('[play]', err);
            return ctx.reply(`❌ Could not play that: ${err.message}`);
        }
    },
};
