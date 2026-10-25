const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { disconnect } = require('../lib/music');

/**
 * Sleep timer: leave the voice channel after N minutes (or when the queue
 * runs dry with `off`… rather `queue`). In-memory on purpose — a restart
 * clearing the timer is acceptable semantics (and rare, thanks to
 * lib/queueResume). Setting it again replaces it; `off` cancels.
 *
 * Anyone who can control the queue (same guard as `volume`) may set it,
 * because it affects what everyone hears.
 */

/** @type {Map<string, {timer: NodeJS.Timeout, until: number}>} guildId -> live timer */
const timers = new Map();

const MINUTES = 480; // 8h sanity cap; this is a sleep timer, not a scheduler

function cancel(guildId) {
    const t = timers.get(String(guildId));
    if (!t) return false;
    if (t.timer) clearTimeout(t.timer);
    if (t.finishOnce && t.distube) t.distube.off('finish', t.finishOnce);
    timers.delete(String(guildId));
    return true;
}

function arm(distube, guildId, minutes) {
    cancel(guildId);
    const timer = setTimeout(() => {
        timers.delete(String(guildId));
        // Disconnect whatever is still running in this guild, queue or not.
        disconnect(distube, distube.getQueue(guildId), guildId).catch(() => {});
    }, minutes * 60_000);
    timer.unref?.();
    timers.set(String(guildId), { timer, until: Date.now() + minutes * 60_000 });
}

function usage(prefix) {
    return `Usage: \`${prefix}sleep <minutes 1-${MINUTES} | queue | off>\``;
}

module.exports = {
    name: 'sleep',
    aliases: ['timer', 'sleeptimer'],
    description: 'Leave the voice channel after N minutes, or when the queue ends',
    usage: 'sleep <minutes | queue | off>',
    category: 'music',
    data: new SlashCommandBuilder()
        .setName('sleep')
        .setDescription('Auto-leave after a while: minutes, queue end, or off')
        .addStringOption(option =>
            option.setName('duration')
                .setDescription(`Minutes (1-${MINUTES}), "queue" (leave when the queue ends), or "off"`)
                .setRequired(true),
        ),

    async execute(ctx) {
        const guildId = ctx.guild.id;
        const raw = String(ctx.option('duration') ?? ctx.args[0] ?? '').trim().toLowerCase();
        if (!raw) return ctx.reply(usage(ctx.config.prefix));

        if (raw === 'off' || raw === 'cancel') {
            return ctx.reply(
                cancel(guildId) ? '😴 Sleep timer cancelled.' : '😴 No sleep timer is running.',
            );
        }

        const queue = ctx.distube.getQueue(guildId);
        if (queue) {
            const guard = await requireQueue(ctx);
            if (isBlocked(guard)) return ctx.reply(guard.reply);
        }

        if (raw === 'queue' || raw === 'end') {
            cancel(guildId);
            if (!queue) return ctx.reply('Nothing is playing — `sleep <minutes>` sets a timer anyway.');
            // A one-shot finish listener (cancellable via cancel()). Kept in
            // the same map so both timer kinds live in one place.
            const finishOnce = q => {
                if (q.id !== guildId) return;
                timers.delete(String(guildId));
                disconnect(ctx.distube, q, guildId).catch(() => {});
            };
            ctx.distube.once('finish', finishOnce);
            timers.set(String(guildId), { timer: null, finishOnce, distube: ctx.distube, until: Infinity });
            return ctx.reply('😴 I will leave when this queue ends.');
        }

        const minutes = Number.parseInt(raw, 10);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MINUTES) {
            return ctx.reply(`❌ ${usage(ctx.config.prefix)}`);
        }
        arm(ctx.distube, guildId, minutes);
        return ctx.reply(`😴 Sleeping in ${minutes} minute${minutes === 1 ? '' : 's'} — I will leave the voice channel then.`);
    },
};

module.exports.timers = timers;
module.exports.cancel = cancel;
module.exports.arm = arm;
