const { SlashCommandBuilder } = require('discord.js');
const reminders = require('../lib/reminders');
const { parseHumanDuration, formatDurationMs } = require('../lib/duration');
const { isOwner } = require('../lib/access');
const { clip } = require('../lib/respond');

/**
 * One-shot reminders persisted to data/reminders.json (lib/reminders.js).
 *
 * `remind <when> <text>` — when is 20m, 2h30m, 3d, … (see lib/duration.js).
 * `remind list` / `remind cancel <id>`. Bare `remind` also lists.
 */
module.exports = {
    name: 'remind',
    aliases: ['reminders'],
    description: `Set a reminder (1 minute to ${reminders.MAX_MS / 86400000} days out)`,
    usage: 'remind <when> <text> | remind list | remind cancel <id>',
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set, list or cancel reminders')
        .addStringOption(option =>
            option.setName('when').setDescription('e.g. 20m, 2h30m, 3d — omit to list').setMaxLength(16),
        )
        .addStringOption(option =>
            option.setName('text').setDescription('What to remind you about').setMaxLength(500),
        )
        .addStringOption(option =>
            option.setName('cancel').setDescription('Reminder id to cancel').setMaxLength(8),
        ),

    async execute(ctx) {
        const userId = ctx.user.id;

        // --- cancel -----------------------------------------------------
        const cancelId = String(ctx.option('cancel') ?? (ctx.args[0] === 'cancel' ? ctx.args[1] : '') ?? '').trim();
        if (cancelId) {
            const existing = reminders.find(cancelId);
            if (!existing || existing.guildId !== String(ctx.guild?.id)) {
                return ctx.reply(`❌ No reminder with id \`${clip(cancelId, 20)}\` here. IDs: \`${ctx.config.prefix}remind list\``, { ephemeral: true });
            }
            if (existing.userId !== String(userId) && !isOwner(userId)) {
                return ctx.reply('❌ That is somebody else’s reminder.', { ephemeral: true });
            }
            reminders.cancel(cancelId);
            return ctx.reply(`🗑️ Reminder \`${cancelId}\` cancelled.`, { ephemeral: true });
        }

        const whenArg = String(ctx.option('when') ?? ctx.args[0] ?? '').trim().toLowerCase();

        // --- list -------------------------------------------------------
        if (!whenArg || whenArg === 'list') {
            const mine = reminders.listFor(ctx.guild.id, userId);
            if (!mine.length) return ctx.reply('You have no reminders here.', { ephemeral: true });
            const rows = mine
                .slice(0, 25)
                .map(r => `• \`${r.id}\` — ${clip(r.text, 120)} (in ${formatDurationMs(Math.max(0, r.at - Date.now()))})`);
            return ctx.reply(clip(`**Your reminders:**\n${rows.join('\n')}`, 1990), { ephemeral: true });
        }

        // --- new --------------------------------------------------------
        const inMs = parseHumanDuration(whenArg);
        if (!inMs) {
            return ctx.reply(
                `❌ \`${clip(whenArg, 30)}\` is not a duration — use units like \`30m\`, \`2h\`, \`3d\` (or \`list\`/\`cancel <id>\`).`,
                { ephemeral: true },
            );
        }
        const text = String(ctx.option('text') ?? ctx.args.slice(1).join(' ')).trim();
        if (!text) return ctx.reply('What should I remind you about? `remind 10m stretch`', { ephemeral: true });

        const result = reminders.add({
            guildId: ctx.guild.id,
            channelId: ctx.channel.id,
            userId,
            text,
            at: Date.now() + inMs,
        });
        if (!result.ok) return ctx.reply(`❌ ${result.error}`, { ephemeral: true });

        return ctx.reply(
            `⏰ Got it — in **${formatDurationMs(inMs)}** I will ping you about \`${clip(text, 120)}\` (id \`${result.reminder.id}\`).`,
            { ephemeral: true },
        );
    },
};
