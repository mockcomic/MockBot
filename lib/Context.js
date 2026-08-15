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

    /** Reply to the invocation (message reply or interaction reply). */
    async reply(content) {
        if (this.isSlash) {
            // First response: reply (or editReply when deferred).
            // Anything after that: followUp so nothing gets overwritten.
            if (!this._slashResponded) {
                this._slashResponded = true;
                return this.interaction.deferred
                    ? this.interaction.editReply(content)
                    : this.interaction.reply(content);
            }
            return this.interaction.followUp(content);
        }
        return this.message.reply(content);
    }

    /** Send a plain message into the invoking channel. */
    async send(content) {
        return this.channel.send(content);
    }

    /** Defer a slash reply (no-op for prefix). Use for slow commands. */
    async defer() {
        if (this.isSlash && !this.interaction.deferred && !this.interaction.replied) {
            await this.interaction.deferReply();
        }
    }
}

module.exports = Context;
