const { SlashCommandBuilder } = require('discord.js');

/**
 * Tenor GIF search (Tenor API v2 — the v1 API was shut down in 2024).
 * Requires a Tenor v2 key (Google Cloud) in .env as TENORKEY.
 */
module.exports = {
    name: 'gif',
    description: 'Search for a GIF on Tenor',
    usage: 'gif <search terms>',
    data: new SlashCommandBuilder()
        .setName('gif')
        .setDescription('Search for a GIF on Tenor')
        .addStringOption(option =>
            option.setName('query').setDescription('What to search for').setRequired(true),
        ),

    async execute(ctx) {
        if (!process.env.TENORKEY) {
            return ctx.reply('❌ Tenor API key not set. Add `TENORKEY` to .env (Tenor v2 key from Google Cloud).');
        }

        const query = ctx.args.join(' ').trim();
        if (!query) return ctx.reply(`Usage: \`${ctx.config.prefix}gif <search terms>\``);

        const url =
            `https://tenor.googleapis.com/v2/search` +
            `?q=${encodeURIComponent(query)}` +
            `&key=${encodeURIComponent(process.env.TENORKEY)}` +
            `&client_key=mockbot&contentfilter=off&media_filter=tinygif,gif&limit=10`;

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Tenor API error ${response.status}`);
            const json = await response.json();

            const results = json.results ?? [];
            if (results.length === 0) return ctx.reply('No gif was found with your search parameters.');

            const pick = results[Math.floor(Math.random() * results.length)];
            const gifUrl = pick.media_formats?.tinygif?.url ?? pick.media_formats?.gif?.url;
            if (!gifUrl) return ctx.reply('No gif was found with your search parameters.');

            return ctx.reply(gifUrl);
        } catch (err) {
            console.error('[gif]', err);
            return ctx.reply('❌ GIF search failed. Check that TENORKEY is a valid Tenor v2 key.');
        }
    },
};
