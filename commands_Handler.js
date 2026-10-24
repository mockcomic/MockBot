const fs = require('node:fs');
const path = require('node:path');

/**
 * Load every command module from ./commands into a registry.
 *
 * A command module exports:
 *   name        - canonical (lowercase) command name
 *   aliases     - optional alternative names
 *   description - shown in help / slash registration
 *   usage       - optional prefix usage string
 *   ownerOnly   - true: bot owner only
 *   adminOnly   - true (Administrator) or a specific PermissionFlagsBits value,
 *                 e.g. PermissionFlagsBits.ManageRoles. The bot owner always
 *                 passes. See lib/access.js.
 *   data        - optional SlashCommandBuilder (omit = prefix only)
 *   execute(ctx)- the command body
 *
 * Slash registration and the prefix dispatcher both come from this one map, so
 * a command never needs wiring anywhere else.
 */
function loadCommands() {
    const commands = new Map();
    const aliases = new Map();
    const dir = path.join(__dirname, 'commands');

    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        try {
            const cmd = require(path.join(dir, file));
            if (!cmd || typeof cmd.execute !== 'function' || !cmd.name) {
                console.warn(`[commands] Skipped ${file}: missing name or execute`);
                continue;
            }
            cmd.name = String(cmd.name).toLowerCase();
            if (commands.has(cmd.name)) {
                console.warn(`[commands] ${file}: duplicate name "${cmd.name}" overrides the earlier module`);
            }
            // A real command always wins over someone else's alias for that word.
            if (aliases.has(cmd.name)) {
                console.warn(`[commands] ${file}: "${cmd.name}" was an alias of ${aliases.get(cmd.name)}; the command wins`);
                aliases.delete(cmd.name);
            }
            commands.set(cmd.name, cmd);

            for (const alias of cmd.aliases ?? []) {
                const key = String(alias).toLowerCase();
                if (commands.has(key) || aliases.has(key)) {
                    console.warn(`[commands] ${file}: alias "${key}" collides with an existing command and is ignored`);
                    continue;
                }
                aliases.set(key, cmd.name);
            }
            console.log(`Loaded command: ${cmd.name}`);
        } catch (err) {
            console.error(`[commands] Failed to load ${file}:`, err);
        }
    }

    return {
        commands,
        aliases,
        get(name) {
            const key = String(name ?? '').toLowerCase();
            return commands.get(aliases.get(key) ?? key);
        },
    };
}

module.exports = { loadCommands };
