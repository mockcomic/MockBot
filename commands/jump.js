const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, resolveJumpTarget, explainError } = require('../lib/musicGuards');

module.exports = {
    name: 'jump',
    description: 'Jump to a queue position (2 = next song, negative numbers go back through history)',
    usage: 'jump <position>',
    data: new SlashCommandBuilder()
        .setName('jump')
        .setDescription('Jump to a queue position (2 = next song, negative = history)')
        .addIntegerOption(option =>
            option
                .setName('position')
                .setDescription('Position from `queue`: 2 = next song, -1 = previous song')
                .setMinValue(-50)
                .setMaxValue(1000)
                .setRequired(true),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const position = Number.parseInt(ctx.args[0], 10);
        if (Number.isNaN(position)) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}jump <position>\` — use \`${ctx.config.prefix}queue\` to see positions.`);
        }

        const target = resolveJumpTarget(position, queue.songs.length, queue.previousSongs.length);
        if (!target.ok) return ctx.reply(`❌ ${target.error}`);

        try {
            await queue.jump(target.apiPosition);
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }

        const where = target.apiPosition > 0 ? `song **${target.position}**` : `song **${target.position}** (history)`;
        return ctx.reply(`⏭️ Jumped to ${where}.`);
    },
};
