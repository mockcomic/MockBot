const { Events, MessageFlags } = require('discord.js');
const store = require('../lib/reactionRolesStore');
const { register } = require('../lib/components');

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

    /**
     * The native multi-select on the menu (`mb:rr`), via the shared component
     * dispatcher. The submitted selection is the SET of menu roles the user
     * wants: pick a row to take it, unpick to drop it. Values are only
     * honoured when they are in the menu's recorded roleIds (menus posted
     * before v3.4 fall back to the live config table), so a forged payload
     * cannot request a role the menu never offered.
     */
    register('rr', async interaction => {
        const rr = config?.reactionRoles;
        if (!rr?.enabled) return interaction.message.edit({ components: [] }).catch(() => {});

        const menu = store.entry(interaction.message.id);
        if (!menu) {
            return interaction.update({ components: [] }).catch(() => {});
        }

        const allowedIds = menu.roleIds
            ?? rr.roles.map(e => (e.roleId && interaction.guild.roles.cache.get(e.roleId)?.id)
                ?? interaction.guild.roles.cache.find(r => r.name === e.name)?.id)
                .filter(Boolean);
        const allowed = new Set(allowedIds.map(String));

        const chosen = new Set(
            (interaction.values ?? []).filter(v => allowed.has(String(v))).map(String),
        );

        const me = interaction.guild.members.me;
        const member = interaction.member;
        const toAdd = [];
        const toRemove = [];
        for (const id of allowed) {
            const role = interaction.guild.roles.cache.get(id);
            if (!role || role.managed) continue;
            if (me && me.roles.highest.position <= role.position) continue;
            if (chosen.has(id)) toAdd.push(role);
            else toRemove.push(role);
        }

        const reason = 'MockBot role-select menu';
        const owned = new Set(member.roles.cache.keys());
        const add = toAdd.filter(r => !owned.has(r.id));
        const remove = toRemove.filter(r => owned.has(r.id));
        if (add.length) await member.roles.add(add, reason);
        if (remove.length) await member.roles.remove(remove, reason);

        return interaction.reply({ content: '✅ Roles updated.', flags: MessageFlags.Ephemeral });
    });
};

module.exports.emojiKeys = emojiKeys;
