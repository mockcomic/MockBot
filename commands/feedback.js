const { SlashCommandBuilder } = require('discord.js');
const { append } = require('../lib/feedbackStore');

module.exports = {
    name: 'feedback',
    description: 'Send feedback to the bot owner',
    usage: 'feedback <your feedback>',
    data: new SlashCommandBuilder()
        .setName('feedback')
        .setDescription('Send feedback to the bot owner')
        .addStringOption(option =>
            option
                .setName('message')
                .setDescription('Your feedback')
                .setRequired(true)
                .setMaxLength(500),
        ),

    async execute(ctx) {
        const content = ctx.args.join(' ').trim();
        if (!content) return ctx.reply(`Usage: \`${ctx.config.prefix}feedback <your feedback>\``);

        // The guild name tells the owner where the note came from; the tag is
        // the author's own text, so it is not a spoofing risk.
        const where = ctx.guild ? ` (${ctx.guild.name})` : '';
        const line = `${new Date().toISOString()} ${ctx.user.tag ?? ctx.user.username}${where}: ${content}`;

        try {
            await append(line);
        } catch (err) {
            console.error('[feedback]', err);
            return ctx.reply(`❌ Could not save your feedback: ${err.message}`);
        }

        // Ephemeral: nobody else needs a congratulations ping.
        return ctx.reply('☑️ Thanks! Your feedback has been saved.', { ephemeral: true });
    },
};
