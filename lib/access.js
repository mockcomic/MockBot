const { PermissionFlagsBits } = require('discord.js');

/**
 * Who may run a command.
 *
 * `commands_Handler.js` documents `ownerOnly` and `adminOnly`; the old runner
 * only ever checked `ownerOnly`, so `adminOnly` was a documented-but-dead flag
 * while the files were already named `Admin_*`.
 *
 *   ownerOnly: true            → bot owner only
 *   adminOnly: true            → owner, or a member with ADMINISTRATOR
 *   adminOnly: <permissionBit> → owner, or a member with that permission
 *                                (e.g. PermissionFlagsBits.ManageRoles)
 */

function isOwner(userId) {
    const owner = String(process.env.OWNER ?? '').trim();
    return Boolean(owner) && String(userId) === owner;
}

/** The permission an `adminOnly` command requires, or null when it asks for none. */
function requiredPermission(cmd) {
    const flag = cmd?.adminOnly;
    if (flag === true) return PermissionFlagsBits.Administrator;
    if (typeof flag === 'bigint' || typeof flag === 'number') return BigInt(flag);
    return null;
}

/**
 * Guild-level permission check. The interaction payload's `member.permissions`
 * describes the *application's* permissions, so the member is resolved through
 * the guild to ask about the person.
 */
async function hasPermission(ctx, bit) {
    if (!bit) return true;
    const guild = ctx.guild;
    if (!guild) return false;

    const member =
        (ctx.member?.permissions ? ctx.member : null) ??
        guild.members.cache.get(ctx.user.id) ??
        (await guild.members.fetch(ctx.user.id).catch(() => null));

    if (!member?.permissions) return false;
    try {
        return member.permissions.has(bit);
    } catch {
        return false;
    }
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function canRun(cmd, ctx) {
    if (isOwner(ctx.user?.id)) return { ok: true };

    if (cmd.ownerOnly) {
        return { ok: false, reason: '⛔ Access denied — owner only.' };
    }

    const needed = requiredPermission(cmd);
    if (needed !== null && !(await hasPermission(ctx, needed))) {
        return { ok: false, reason: `⛔ This command needs ${describe(needed)} permission.` };
    }

    return { ok: true };
}

function describe(bit) {
    const named = Object.entries(PermissionFlagsBits).find(([, value]) => value === bit)?.[0];
    return named
        ? named.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())
        : 'administrator';
}

module.exports = { isOwner, requiredPermission, hasPermission, canRun, describe };
