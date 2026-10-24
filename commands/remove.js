const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { songLink } = require('../lib/musicFormat');

/**
 * DisTube v5 has no Queue#remove(position), and its own jump() mutates
 * queue.songs directly (verified: Queue#jump does songs.splice(0, position)),
 * so splicing the pending rows is the same mechanism the library uses.
 */
module.exports = {
    name: 'remove',
    aliases: ['rm'],
    description: 'Remove a song from the queue by its `queue` position, or "all" to clear the pending list',
    usage: 'remove <position | all>',
    data: new SlashCommandBuilder()
        .setName('remove')
        .setDescription('Remove a queued song by position, or all pending songs')
        .addStringOption(option =>
            option.setName('position').setDescription('Queue position (2 or higher), or "all"').setRequired(true),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const raw = String(ctx.args[0] ?? '').trim().toLowerCase();
        if (!raw) return ctx.reply(`Usage: \`${ctx.config.prefix}remove <position | all>\``);

        if (raw === 'all') {
            const removed = queue.songs.splice(1);
            return ctx.reply(removed.length
                ? `🗑️ Removed ${removed.length} queued song(s). The playing song continues.`
                : 'There was nothing queued after the playing song.');
        }

        const position = Number.parseInt(raw, 10);
        if (Number.isNaN(position) || position < 1) {
            return ctx.reply(`Position must be a whole number from the \`${ctx.config.prefix}queue\` list (or "all").`);
        }
        if (position === 1) {
            return ctx.reply('Song 1 is playing now — use `skip` to move past it or `stop` to end playback.');
        }
        if (position > queue.songs.length) {
            return ctx.reply(`There is no song ${position}; the queue holds ${queue.songs.length} row(s).`);
        }

        const [removed] = queue.songs.splice(position - 1, 1);
        return ctx.reply(`🗑️ Removed ${songLink(removed)} (was position ${position}).`);
    },
};
