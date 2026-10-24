const { EmbedBuilder } = require('discord.js');
const settings = require('./guildSettings');
const { clip } = require('./respond');

/**
 * Moderation logging to the channel stored in guildSettings.modlogChannelId.
 *
 * Every entry carries remote/typed text (reasons, targets), so all fields are
 * clipped. A missing, deleted or unsendable channel silently drops the entry —
 * moderation must never fail because the log did.
 */
async function log(guild, { action, moderator, target, detail, color = 0xf1c40f }) {
    try {
        if (!guild) return false;
        const channelId = settings.get(guild.id).modlogChannelId;
        if (!channelId) return false;

        const channel =
            guild.channels.cache.get(channelId) ??
            (await guild.channels.fetch(channelId).catch(() => null));
        if (!channel || typeof channel.send !== 'function') return false;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle('📋 Moderation')
            .setDescription(clip(String(action ?? 'action'), 4096))
            .setTimestamp();
        if (moderator) embed.addFields({ name: 'Moderator', value: clip(moderator, 1024), inline: true });
        if (target) embed.addFields({ name: 'Target', value: clip(target, 1024), inline: true });
        if (detail) embed.addFields({ name: 'Details', value: clip(detail, 1024) });

        await channel.send({ embeds: [embed] });
        return true;
    } catch (err) {
        console.warn(`[modlog] ${err.message}`);
        return false;
    }
}

module.exports = { log };
