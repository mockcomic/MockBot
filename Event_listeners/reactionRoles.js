const { Events } = require('discord.js');
const store = require('../lib/reactionRolesStore');

/**
 * Reaction-role handling, driven by config.reactionRoles.
 * Listeners are registered exactly once at startup (the old version
 * re-registered them every time the admin command ran).
 *
 * Only menus this bot posted (see lib/reactionRolesStore) are honoured, so a
 * matching emoji on somebody else's message in the same channel can no longer
 * hand out a role.
 */

/** Every string a reaction could be matched by: unicode or custom `name:id`. */
function emojiKeys(emoji) {
    if (!emoji) return [];
    const keys = [];
    if (emoji.name) keys.push(emoji.name);
    if (emoji.id) {
        keys.push(`${emoji.name}:${emoji.id}`);
        keys.push(`a:${emoji.name}:${emoji.id}`);
    }
    if (emoji.identifier) keys.push(emoji.identifier);
    return keys;
}

function resolveRole(guild, entry) {
    if (entry.roleId) {
        const byId = guild.roles.cache.get(entry.roleId);
        if (byId) return byId;
    }
    if (entry.name) return guild.roles.cache.find(r => r.name === entry.name) ?? null;
    return null;
}

module.exports = function setupReactionRoles(client, config) {
    // The emoji→role table and the on/off switch are read per event from the
    // live config object, so the web portal can edit them without a restart
    // (lib/runtimeConfig mutates that object in place).
    const warned = new Set();
    const warnOnce = (key, message) => {
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(`[reactionRoles] ${message}`);
    };

    const handle = async (reaction, user, add) => {
        try {
            const rr = config?.reactionRoles;
            if (!rr?.enabled || !Array.isArray(rr.roles)) return;
            if (user.bot) return;
            if (reaction.partial) reaction = await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const message = reaction.message;
            if (!message.guild) return;
            // Menu trust is per-message (lib/reactionRolesStore), not per
            // configured channel anymore: `rr #channel` may post menus anywhere,
            // in any guild. The emoji→role table stays the shared config.json one.
            if (!store.isManaged(message.id)) return;

            const byEmoji = new Map();
            for (const entry of rr.roles) {
                if (!entry?.emoji) continue;
                byEmoji.set(String(entry.emoji), entry);
            }

            const entry = emojiKeys(reaction.emoji).map(key => byEmoji.get(key)).find(Boolean);
            if (!entry) return;

            const role = resolveRole(message.guild, entry);
            if (!role) {
                warnOnce(
                    `${message.guild.id}:${entry.roleId ?? entry.name}`,
                    `no role matches "${entry.roleId ?? entry.name}" in guild ${message.guild.name} — add a roleId to config.json`,
                );
                return;
            }

            const me = message.guild.members.me;
            if (me && me.roles.highest.position <= role.position) {
                warnOnce(
                    `${message.guild.id}:hierarchy:${role.id}`,
                    `cannot manage @${role.name} in ${message.guild.name}: the bot's highest role is below it`,
                );
                return;
            }

            const member =
                message.guild.members.cache.get(user.id) ??
                (await message.guild.members.fetch(user.id).catch(() => null));
            if (!member) return;

            const reason = 'MockBot reaction-role menu';
            if (add) await member.roles.add(role, reason);
            else await member.roles.remove(role, reason);
        } catch (err) {
            console.error('[reactionRoles]', err.message);
        }
    };

    client.on(Events.MessageReactionAdd, (reaction, user) => handle(reaction, user, true));
    client.on(Events.MessageReactionRemove, (reaction, user) => handle(reaction, user, false));
};

module.exports.emojiKeys = emojiKeys;
