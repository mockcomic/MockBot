const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { COLOR, queuePage } = require('../lib/musicFormat');

module.exports = {
    name: 'queue',
    aliases: ['q'],
    description: 'Show the current music queue (10 songs per page)',
    usage: 'queue [page]',
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Show the current music queue')
        .addIntegerOption(option =>
            option.setName('page').setDescription('Page number (10 songs per page)').setMinValue(1),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx, { sameVoice: false });
        if (isBlocked(guard)) return ctx.reply(guard.reply);

        const page = Number.parseInt(ctx.args[0], 10);
        const view = queuePage(guard.queue, Number.isNaN(page) ? 1 : page);

        const embed = new EmbedBuilder()
            .setColor(COLOR.accent)
            .setTitle(`📄 Queue for ${ctx.guild.name}`)
            .setDescription(view.description)
            .setFooter({ text: view.footerText });

        return ctx.reply({ embeds: [embed] });
    },
};
