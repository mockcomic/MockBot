const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { parseHumanDuration, formatDurationMs } = require('../lib/duration');
const modlog = require('../lib/modlog');

/**
 * Native Discord timeouts — no role juggling, expires on Discord's side, and
 * the reason shows up in the member's audit log. `off`/`clear`/`0` lifts it.
 *
 * Both invocation styles land on the same args order: the slash options are
 * declared in (member, duration, reason) order, and the prefix path expects
 * `timeout <@member|id> <duration> [reason]`.
 */
const MAX_MS = 28 * 24 * 60 * 60 * 1000; // Discord's ceiling

module.exports = {
    name: 'timeout',
    aliases: ['mute', 'to'],
    description: 'Timeout or un-timeout a member (native Discord timeout)',
    usage: 'timeout <@member|id> <duration|off> [reason]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ModerateMembers,
    data: new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout a member (Moderate Members)')
        .addUserOption(option =>
            option.setName('member').setDescription('Who to time out').setRequired(true),
        )
        .addStringOption(option =>
            option.setName('duration').setDescription('e.g. 10m, 2h — or off/clear').setRequired(true).setMaxLength(16),
        )
        .addStringOption(option =>
            option.setName('reason').setDescription('Shown in the audit log and modlog').setMaxLength(300),
        ),

    async execute(ctx) {
        const targetId = String(ctx.args[0] ?? '').match(/(\d{17,20})/)?.[1];
        const durationArg = String(ctx.args[1] ?? '').trim().toLowerCase();
        const reason = ctx.args.slice(2).join(' ').trim() || 'no reason given';

        if (!targetId || !durationArg) {
            return ctx.reply(`Usage: \`${ctx.config.prefix}timeout <@member|id> <10m|2h|off> [reason]\``, { ephemeral: true });
        }

        const member = await ctx.guild.members.fetch(targetId).catch(() => null);
        if (!member) return ctx.reply('❌ That member is not in this server (timeouts need a joined member).', { ephemeral: true });
        if (member.id === ctx.guild.members.me?.id) return ctx.reply('🤔 Timeing myself out would silence my own replies.', { ephemeral: true });
        if (!member.moderatable) {
            return ctx.reply('❌ I cannot timeout that member — my highest role must be above theirs (and owners cannot be timed out).', { ephemeral: true });
        }

        let ms;
        if (['off', 'clear', 'stop', '0'].includes(durationArg)) ms = 0;
        else {
            ms = parseHumanDuration(durationArg);
            if (ms === null) return ctx.reply(`❌ \`${durationArg.slice(0, 16)}\` is not a duration — try \`10m\`, \`2h\`, \`off\`.`, { ephemeral: true });
            if (ms > MAX_MS) return ctx.reply(`❌ Discord caps timeouts at 28 days.`, { ephemeral: true });
        }

        try {
            await member.timeout(ms, `MockBot: ${reason.slice(0, 400)}`);
        } catch (err) {
            return ctx.reply(`❌ Timeout failed: ${err.message}`, { ephemeral: true });
        }

        const who = member.toString();
        await modlog.log(ctx.guild, {
            action: ms ? `⏱️ Timeout ${formatDurationMs(ms)}` : '🔓 Timeout removed',
            moderator: ctx.member?.toString() ?? `<@${ctx.user.id}>`,
            target: `${member.user.tag} (${member.id})`,
            detail: reason,
            color: ms ? 0xed4245 : 0x57f287,
        });

        return ctx.reply(
            ms
                ? `⏱️ ${who} timed out for **${formatDurationMs(ms)}** — ${reason}`
                : `🔓 Timeout removed from ${who}.`,
        );
    },
};
