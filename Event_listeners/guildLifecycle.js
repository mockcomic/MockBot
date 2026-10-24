const { Events } = require('discord.js');
const settings = require('../lib/guildSettings');
const modlog = require('../lib/modlog');
const { clip } = require('../lib/respond');

/**
 * Member lifecycle: welcome message, auto-role, and join/leave modlog lines.
 *
 * Per-guild settings (lib/guildSettings):
 *   welcomeChannelId  - where the welcome message goes (null = off)
 *   welcomeMessage    - template with {member} {guild} {count}; null = default
 *   autoRoleIds       - roles added on join; each one is skipped (never fatal)
 *                       when the bot cannot manage it
 *
 * Joins and leaves always go to the modlog channel when one is set, even
 * without a welcome config. Everything here is best-effort: a broken channel,
 * a missing permission or a bad template must never break the join itself.
 */

const DEFAULT_WELCOME = '👋 {member} joined **{guild}** — you are member #{count}. `!help` lists commands.';

/** Substitute the welcome template against safe placeholders only. */
function renderWelcome(template, member) {
    const count = member?.guild?.memberCount ?? '?';
    return String(template ?? DEFAULT_WELCOME)
        .replaceAll('{member}', member.toString())   // mention, already capped by Discord
        .replaceAll('{guild}', clip(member?.guild?.name ?? 'the server', 100))
        .replaceAll('{count}', String(count));
}

/** Roles the bot may actually assign right now (manageable + below top). */
function resolvableRoles(guild, ids) {
    const me = guild.members.me;
    const out = [];
    for (const id of ids ?? []) {
        const role = guild.roles.cache.get(String(id));
        if (!role) continue;
        if (role.managed) continue;                      // bot/integration roles
        if (me && me.roles.highest.position <= role.position) continue;
        out.push(role);
    }
    return out;
}

module.exports = function setupGuildLifecycle(client) {
    client.on(Events.GuildMemberAdd, async member => {
        try {
            const guild = member.guild;
            const s = settings.get(guild.id);

            if (Array.isArray(s.autoRoleIds) && s.autoRoleIds.length) {
                const roles = resolvableRoles(guild, s.autoRoleIds);
                if (roles.length) {
                    await member.roles.add(roles, 'MockBot auto-role').catch(err =>
                        console.warn(`[welcome] auto-role failed in ${guild.name}: ${err.message}`));
                }
            }

            if (s.welcomeChannelId) {
                const channel =
                    guild.channels.cache.get(s.welcomeChannelId) ??
                    (await guild.channels.fetch(s.welcomeChannelId).catch(() => null));
                if (channel && typeof channel.send === 'function') {
                    await channel.send({
                        content: renderWelcome(s.welcomeMessage, member),
                        allowedMentions: { parse: ['users'] },
                    }).catch(() => {});
                }
            }
        } catch (err) {
            console.warn(`[welcome] ${err.message}`);
        }

        // The join line only matters where a modlog exists; keep it cheap.
        if (settings.get(member.guild.id).modlogChannelId) {
            await modlog.log(member.guild, {
                action: 'Member joined',
                target: `${member.user.tag} (${member.id})`,
                detail: `Member count: ${member.guild.memberCount}`,
                color: 0x57f287,
            });
        }
    });

    client.on(Events.GuildMemberRemove, async member => {
        try {
            if (!settings.get(member.guild.id).modlogChannelId) return;
            // Roles are already gone from the cache at this point; the tag and
            // account age are what identifies who left.
            const age = member.user?.createdAt
                ? `${Math.max(0, Math.floor((Date.now() - member.user.createdAt.getTime()) / 86_400_000))} days`
                : 'unknown';
            await modlog.log(member.guild, {
                action: 'Member left',
                target: `${member.user?.tag ?? member.id} (${member.id})`,
                detail: `Account age: ${age}. Member count: ${member.guild.memberCount}`,
                color: 0xed4245,
            });
        } catch (err) {
            console.warn(`[welcome] ${err.message}`);
        }
    });
};

module.exports.renderWelcome = renderWelcome;
module.exports.resolvableRoles = resolvableRoles;
module.exports.DEFAULT_WELCOME = DEFAULT_WELCOME;
