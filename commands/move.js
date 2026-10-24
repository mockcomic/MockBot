const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { songLink } = require('../lib/musicFormat');

/**
 * Reorder the queue without removing and re-adding: same splice mechanism as
 * `remove` (DisTube mutates queue.songs directly — see commands/remove.js).
 * Positions follow the `queue` listing: 1 is the playing song and cannot move.
 */
module.exports = {
    name: 'move',
    aliases: ['moveto'],
    description: 'Move a queued song to a different queue position',
    usage: 'move <position> <new position>',
    data: new SlashCommandBuilder()
        .setName('move')
        .setDescription('Move a queued song to another position')
        .addIntegerOption(option =>
            option.setName('position').setDescription('Current queue position (2 or higher)').setRequired(true))
        .addIntegerOption(option =>
            option.setName('to').setDescription('New position (2 or higher, within the queue)').setRequired(true)),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const from = Number(ctx.option('position') ?? ctx.args[0]);
        const to = Number(ctx.option('to') ?? ctx.args[1]);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}move <position> <new position>\` — numbers from \`${ctx.config.prefix}queue\`.`);
        }

        const count = queue.songs.length;
        if (from === 1 || to === 1) return ctx.reply('Position 1 is the playing song — it does not move.');
        if (from < 1 || from > count || to < 1 || to > count) {
            return ctx.reply(`Both positions must be between 2 and ${count} (the queue holds ${count} row(s)).`);
        }
        if (from === to) return ctx.reply(`Song ${from} is already at position ${to}.`);

        const [song] = queue.songs.splice(from - 1, 1);
        queue.songs.splice(to - 1, 0, song);
        return ctx.reply(`↔️ Moved ${songLink(song)} from position ${from} to position ${to}.`);
    },
};
