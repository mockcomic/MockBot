const { Events } = require('discord.js');

/**
 * Reaction-role handling, driven by config.reactionRoles.
 * Listeners are registered exactly once at startup (the old version
 * re-registered them every time the admin command ran).
 */
module.exports = function setupReactionRoles(client, config) {
    const rr = config.reactionRoles;
    if (!rr?.enabled || !Array.isArray(rr.roles)) return;

    const roleByEmoji = new Map(rr.roles.map(entry => [entry.emoji, entry.name]));

    const handle = async (reaction, user, add) => {
        try {
            if (user.bot) return;
            if (reaction.partial) reaction = await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const message = reaction.message;
            if (!message.guild || message.channel.id !== rr.channelId) return;

            const roleName = roleByEmoji.get(reaction.emoji.name);
            if (!roleName) return;

            const role = message.guild.roles.cache.find(r => r.name === roleName);
            if (!role) return;

            const member =
                message.guild.members.cache.get(user.id) ??
                (await message.guild.members.fetch(user.id).catch(() => null));
            if (!member) return;

            if (add) await member.roles.add(role);
            else await member.roles.remove(role);
        } catch (err) {
            console.error('[reactionRoles]', err.message);
        }
    };

    client.on(Events.MessageReactionAdd, (reaction, user) => handle(reaction, user, true));
    client.on(Events.MessageReactionRemove, (reaction, user) => handle(reaction, user, false));
};
