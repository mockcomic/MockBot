const { Events } = require('discord.js');
const guildSettings = require('../lib/guildSettings');

/**
 * Leave a voice channel nobody is listening in.
 *
 * DisTube v5 removed the old `leaveOnEmpty`/`leaveOnEnd` options (verified:
 * those keys are gone from DisTubeOptions and the `empty` event is never
 * emitted), so today a paused or playing queue keeps streaming to an empty
 * room forever — pure CPU on a Raspberry Pi. This restores the behaviour with
 * one timer per guild.
 */
module.exports = function setupVoiceIdle(client, { distube, config } = {}) {
    // Read the live config object at event time, not a snapshot: the web
    // portal can change the timeout (or park it with 0) while the bot runs.
    const currentSeconds = () => {
        const seconds = Number(config?.music?.leaveOnEmptyAfterSeconds ?? 90);
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    };
    if (currentSeconds() <= 0) return { timers: new Map(), disabled: true };

    const seconds = currentSeconds();
    /** @type {Map<string, NodeJS.Timeout>} */
    const timers = new Map();

    const disarm = guildId => {
        const timer = timers.get(guildId);
        if (!timer) return;
        clearTimeout(timer);
        timers.delete(guildId);
    };

    const humanListeners = channel => {
        let count = 0;
        for (const member of channel?.members?.values?.() ?? []) {
            if (!member.user?.bot) count += 1;
        }
        return count;
    };

    const leave = (guildId, queue, channel, secondsNow = seconds) => {
        timers.delete(guildId);
        const name = channel?.name ? `**${channel.name}**` : 'the voice channel';
        queue.textChannel
            ?.send(`👋 Leaving ${name} — nobody was in the channel for ${secondsNow}s.`)
            .catch(() => {});
        queue.stop().catch(() => {});
    };

    const arm = (queue, channel) => {
        if (timers.has(queue.id)) return;
        const secondsNow = currentSeconds();
        if (secondsNow <= 0) return; // switched off at runtime
        const timer = setTimeout(() => leave(queue.id, queue, channel, secondsNow), secondsNow * 1000);
        // Never keep the process alive just for this timer.
        timer.unref?.();
        timers.set(queue.id, timer);
    };

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        try {
            const guildId = (newState?.guild ?? oldState?.guild)?.id;
            if (!guildId) return;

            const queue = distube.getQueue(guildId);
            if (!queue) return void disarm(guildId);

            // 24/7 mode parks the watcher entirely (`247` command).
            if (guildSettings.get(guildId).twentyFourSeven) return void disarm(guildId);

            const channel = queue.voiceChannel;
            if (!channel) return void disarm(guildId);

            const involved = oldState?.channelId === channel.id || newState?.channelId === channel.id;
            if (!involved) return;

            if (humanListeners(channel) === 0) arm(queue, channel);
            else disarm(guildId);
        } catch (err) {
            console.error('[voiceIdle]', err.message);
        }
    });

    // The queue is gone: the timer's target no longer exists. Note DisTube caps
    // each event at one listener, so this module deliberately claims only
    // `deleteQueue` — a disconnect already arrives as a VoiceStateUpdate, where
    // the missing queue makes the branch below disarm the timer.
    distube.on('deleteQueue', queue => disarm(queue.id));

    return { timers, disarm, arm };
};
