const fs = require('node:fs');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');

const FEEDBACK_FILE = path.join(__dirname, '..', 'feedback.txt');

module.exports = {
    name: 'feedbacklist',
    ownerOnly: true,
    description: 'List all saved feedback',
    usage: 'feedbacklist',
    data: new SlashCommandBuilder().setName('feedbacklist').setDescription('List all saved feedback'),

    async execute(ctx) {
        let content = '';
        try {
            content = (await fs.promises.readFile(FEEDBACK_FILE, 'utf8')).trim();
        } catch {
            return ctx.reply('No feedback has been saved yet.');
        }
        if (!content) return ctx.reply('No feedback has been saved yet.');

        let message = `**Feedback (total ${content.split('\n').length} entries):**\n${content}`;
        while (message.length > 2000) {
            await ctx.reply(message.slice(0, 2000));
            message = message.slice(2000);
        }
        return ctx.reply(message);
    },
};
