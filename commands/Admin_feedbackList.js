const { SlashCommandBuilder } = require('discord.js');
const { readAll } = require('../lib/feedbackStore');
const { chunkLines, clip } = require('../lib/respond');

const MAX_PAGES = 5;

module.exports = {
    name: 'feedbacklist',
    ownerOnly: true,
    description: 'List all saved feedback',
    usage: 'feedbacklist',
    data: new SlashCommandBuilder().setName('feedbacklist').setDescription('List all saved feedback'),

    async execute(ctx) {
        const content = await readAll();
        if (!content) return ctx.reply('No feedback has been saved yet.');

        const entries = content.split('\n');
        // Newline-aligned chunks, so an entry is never cut in half the way a
        // raw 2000-character slice could.
        const chunks = chunkLines(content);
        const shown = chunks.slice(0, MAX_PAGES);

        await ctx.reply(`**Feedback — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:**`);
        for (const chunk of shown) {
            await ctx.reply(chunk);
        }

        if (chunks.length > shown.length) {
            const rest = chunks.length - shown.length;
            return ctx.reply(clip(`…and ${rest} more message(s) of feedback (newest entries are last in data/feedback.txt).`));
        }
        return undefined;
    },
};
