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
 *   ownerOnly   - optional, restrict to bot owner
 *   adminOnly   - optional, restrict to bot owner/admins
 *   data        - optional SlashCommandBuilder (omit = prefix only)
 *   execute(ctx)- the command body
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
            cmd.name = cmd.name.toLowerCase();
            commands.set(cmd.name, cmd);
            for (const alias of cmd.aliases ?? []) aliases.set(alias.toLowerCase(), cmd.name);
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
