const fs = require('node:fs');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');

const FEEDBACK_FILE = path.join(__dirname, '..', 'feedback.txt');

module.exports = {
    name: 'feedback',
    description: 'Send feedback to the bot owner',
    usage: 'feedback <your feedback>',
    data: new SlashCommandBuilder()
        .setName('feedback')
        .setDescription('Send feedback to the bot owner')
        .addStringOption(option =>
            option.setName('message').setDescription('Your feedback').setRequired(true),
        ),

    async execute(ctx) {
        const content = ctx.args.join(' ').trim();
        if (!content) return ctx.reply(`Usage: \`${ctx.config.prefix}feedback <your feedback>\``);

        const line = `${new Date().toISOString()} ${ctx.user.tag ?? ctx.user.username}: ${content}\n`;

        await fs.promises.appendFile(FEEDBACK_FILE, line, 'utf8');
        return ctx.reply('☑️ Thanks! Your feedback has been saved.');
    },
};
