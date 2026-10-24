const { MessageFlags } = require('discord.js');

/**
 * Unified command context: wraps either a prefix Message or a slash
 * Interaction so every command has one code path for both styles.
 */
class Context {
    /**
     * @param {object} opts
     * @param {import('discord.js').Client} opts.client
     * @param {import('distube').DisTube} opts.distube
     * @param {object} opts.config
     * @param {Map<string, object>} opts.commands
     * @param {import('discord.js').Message|null} [opts.message]
     * @param {import('discord.js').ChatInputCommandInteraction|null} [opts.interaction]
     * @param {string[]} [opts.args]
     */
    constructor({ client, distube, config, commands, message = null, interaction = null, args = [] }) {
        this.client = client;
        this.distube = distube;
        this.config = config;
        this.commands = commands;
        this.message = message;
        this.interaction = interaction;
        this.args = args;
        /** Last message this context produced, so editReply() has a target. */
        this._lastMessage = null;
    }

    get isSlash() {
        return this.interaction !== null;
    }

    get source() {
        return this.interaction ?? this.message;
    }

    get guild() {
        return this.source.guild;
    }

    get channel() {
        return this.source.channel;
    }

    get member() {
        return this.source.member;
    }

    get user() {
        return this.isSlash ? this.interaction.user : this.message.author;
    }

    /**
     * Named slash option, or undefined for a prefix invocation.
     *
     * Prefix commands keep using the flat `args` array; prefer positional
     * `args` unless a command genuinely has several options.
     */
    option(name) {
        if (!this.isSlash) return undefined;
        return this.interaction.options.get(name, false)?.value ?? undefined;
    }

    /** Reply to the invocation (message reply or interaction reply). */
    async reply(content, { ephemeral = false } = {}) {
        const payload = prepare(content, { ephemeral, slash: this.isSlash });

        if (this.isSlash) {
            // First response: reply (or editReply when deferred).
            // Anything after that: followUp so nothing gets overwritten.
            // `ephemeral` only applies to that first response — a followUp is
            // always visible to everyone, as Discord requires.
            if (!this._slashResponded) {
                this._slashResponded = true;
                this._lastMessage = this.interaction.deferred
                    ? await this.interaction.editReply(payload)
                    : await this.interaction.reply(payload);
                return this._lastMessage;
            }
            this._lastMessage = await this.interaction.followUp(payload);
            return this._lastMessage;
        }

        this._lastMessage = await this.message.reply(payload);
        return this._lastMessage;
    }

    /** Replace the reply this context already sent (works for both styles). */
    async editReply(content, { ephemeral = false } = {}) {
        const payload = prepare(content, { ephemeral, slash: this.isSlash });

        if (this.isSlash) {
            if (!this._slashResponded) return this.reply(payload);
            this._lastMessage = await this.interaction.editReply(payload);
            return this._lastMessage;
        }
        if (this._lastMessage) {
            this._lastMessage = await this._lastMessage.edit(payload);
            return this._lastMessage;
        }
        return this.reply(payload);
    }

    /** Send a plain message into the invoking channel. */
    async send(content) {
        return this.channel.send(content);
    }

    /** Defer a slash reply (no-op for prefix). Use for slow commands. */
    async defer() {
        if (this.isSlash && !this.interaction.deferred && !this.interaction.replied) {
            await this.interaction.deferReply();
            this._slashResponded = true;
        }
    }
}

/**
 * Build the payload for one reply.
 *
 * Ephemeral is an interaction-only concept: MessageFlags.Ephemeral (64) on a
 * plain message send is rejected as an invalid form body, so the flag is only
 * attached on the slash path and stripped on the prefix path. Commands can
 * therefore always pass `{ ephemeral: true }` and stay style-agnostic.
 */
function prepare(content, { ephemeral = false, slash = true } = {}) {
    const base = typeof content === 'string' ? { content } : { ...content };

    if (ephemeral && slash) base.flags = MessageFlags.Ephemeral;
    if (!slash && base.flags === MessageFlags.Ephemeral) delete base.flags;

    // A single string is neater than an object with one key.
    return Object.keys(base).length === 1 && typeof base.content === 'string'
        ? base.content
        : base;
}

module.exports = Context;
