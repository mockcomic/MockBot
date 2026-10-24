const { MessageFlags } = require('discord.js');
const cooldowns = require('./cooldowns');

/**
 * Button (and select) dispatcher for every interactive component the bot
 * sends. customIds follow `mb:<action>[:args…]`; bot.js routes all button
 * interactions here, so no command needs to keep a collector alive just for
 * static controls. Feature modules register at load time — see lib/musicUi.js.
 *
 * Registration happens once at startup. Handlers receive
 * (interaction, args, deps) where deps is what bot.js passed to dispatch
 * ({ client, distube, config, guildSettings? … }). A handler throwing — the
 * common case being an interaction or queue that has gone stale — never
 * bubbles: the user gets an ephemeral hint and the error is logged.
 */

/** @type {Map<string, Function>} */
const handlers = new Map();

/** Minimum gap between one user's clicks of the same action, seconds. */
const BUTTON_COOLDOWN_SECONDS = 1.5;

function register(action, handler) {
    if (handlers.has(action)) console.warn(`[components] handler "${action}" is being replaced`);
    handlers.set(action, handler);
}

async function dispatch(interaction, deps = {}) {
    const customId = String(interaction.customId ?? '');
    if (!customId.startsWith('mb:')) return;

    const [, action, ...args] = customId.split(':');
    const handler = handlers.get(action);
    if (!handler) {
        // A stale component from a previous version: say nothing loud.
        return interaction.update({ components: [] }).catch(() => {});
    }

    if (!cooldowns.check(interaction.user?.id, `btn:${action}`, BUTTON_COOLDOWN_SECONDS)) {
        return interaction
            .reply({ content: '⏳ Slow down.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
    }

    try {
        await handler(interaction, args, deps);
    } catch (err) {
        console.warn(`[components] ${customId}: ${err?.message ?? err}`);
        await interaction
            .reply({
                content: '⚠️ That control no longer works — run the command again.',
                flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
    }
}

module.exports = { register, dispatch, handlers, BUTTON_COOLDOWN_SECONDS };
