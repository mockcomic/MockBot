const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, explainError } = require('../lib/musicGuards');

module.exports = {
    name: 'skip',
    aliases: ['next', 's'],
    description: 'Skip the current song',
    usage: 'skip',
    data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);

        try {
            await guard.queue.skip();
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }
        return ctx.reply('⏭️ Skipped.');
    },
};
