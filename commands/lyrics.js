const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { Client: Genius } = require('genius-lyrics');
const { COLOR, songLink } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

/**
 * Lyrics via Genius (no API key required; GENIUS_TOKEN reduces rate limits).
 * The lyrics text is remote, so it is clipped to the embed limit, and the
 * client's global allowedMentions keeps any @everyone inside it harmless.
 */

const genius = new Genius(process.env.GENIUS_TOKEN || undefined);

module.exports = {
    name: 'lyrics',
    description: 'Show lyrics for the playing song or a search',
    usage: 'lyrics [search terms]',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('lyrics')
        .setDescription('Show lyrics for the playing song or a search')
        .addStringOption(option =>
            option.setName('search').setDescription('Defaults to the playing song'),
        ),

    async execute(ctx) {
        const query = String(ctx.option('search') ?? ctx.args.join(' ')).trim();

        // The Genius request can run past the 3s interaction budget.
        await ctx.defer();

        let search = query;
        if (!search) {
            const queue = ctx.distube.getQueue(ctx.guild?.id);
            const song = queue?.songs?.[0];
            if (!song) return ctx.reply('Nothing is playing — pass a search: `lyrics <artist> <song>`.');
            search = String(song.name);
        }

        let text = null;
        let hit = null;
        try {
            const results = await genius.search(search, { limit: 1 });
            hit = results?.[0] ?? null;
            if (hit) text = await hit.lyrics();
        } catch (err) {
            console.warn('[lyrics]', err.message);
            return ctx.reply(`❌ Could not fetch lyrics: ${clip(err.message ?? String(err), 300)}`);
        }

        if (!hit || !text?.trim()) {
            return ctx.reply(`🔎 No lyrics found for ${query ? `\`${clip(query, 100)}\`` : 'the playing song'}.`);
        }

        const body = clip(text.replace(/\r\n/g, '\n').trim(), 4000);
        const embed = new EmbedBuilder()
            .setColor(COLOR.info)
            .setTitle(`📜 ${clip(hit.title ?? 'Lyrics', 200)}`)
            .setDescription(body || '*(lyrics not available)*')
            .setFooter({
                text: `Artist: ${clip(hit.artist?.name ?? 'Unknown', 100)} · from genius.com`,
            });
        if (hit.thumbnail) embed.setThumbnail(hit.thumbnail);

        return ctx.reply({ embeds: [embed] });
    },
};
