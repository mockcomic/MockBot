const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const settings = require('../lib/guildSettings');
const commandToggles = require('../lib/commandToggles');
const { PREFIX_RE } = require('./Staff_prefix');

/**
 * One Discord surface for every per-guild setting the bot stores
 * (data/guilds.json via lib/guildSettings) plus per-server command
 * on/off — so server owners never need the web portal.
 *
 * Deliberately additive: the standalone commands (prefix, dj, 247,
 * sponsorblock, welcome, modlog…) stay exactly as they are; both write
 * the same guildSettings keys, so they cannot drift.
 *
 * The KEYS table below is the single source of truth: every row drives
 * `show`, `set`, `reset`, and the slash key choices. Adding a setting is
 * one row here (plus its DEFAULTS entry in lib/guildSettings.js).
 *
 * Row shape:
 *   gsKey    guildSettings key to write
 *   bool     accepts on|off (plus `default` when nullable = store null)
 *   role|channel  mention or bare snowflake; `off` clears when nullable
 *   roleList comma/space separated role mentions → array
 *   text     plain string, max length
 *   fmt(value, guild)  render for `show` (value = stored value incl. null)
 */

const yn = v => (v === null ? 'follow global' : v ? 'on' : 'off');
const yesNo = v => (v ? 'on' : 'off');
const MENTION_ID = /(\d{17,20})/;

function fmtChannel(value, guild) {
    if (!value) return 'not set';
    const ch = guild?.channels?.cache?.get(value);
    return ch ? `#${ch.name}` : `<#${value}> (not cached)`;
}
function fmtRole(value, guild) {
    if (!value) return 'none';
    const role = guild?.roles?.cache?.get(value);
    return role ? `@${role.name}` : `<@&${value}> (unknown role)`;
}
function fmtRoleList(value) {
    if (!Array.isArray(value) || !value.length) return 'none';
    return value.map(id => `<@&${id}>`).join(' ');
}
function fmtPrefix(value, _guild, config) {
    return value ? `\`${value}\` (override)` : `\`${config?.prefix ?? '!'}\` (global default)`;
}

const KEYS = {
    prefix: { gsKey: 'prefix', text: 5, re: PREFIX_RE, reMsg: 'prefix is 1-5 visible chars without spaces or @ < >', fmt: fmtPrefix },
    '247': { gsKey: 'twentyFourSeven', bool: true, fmt: yesNo },
    autoplay: { gsKey: 'autoplay', bool: true, nullable: true, fmt: yn },
    voteskip: { gsKey: 'voteSkip', bool: true, nullable: true, fmt: yn },
    sponsorblock: { gsKey: 'sponsorBlock', bool: true, nullable: true, fmt: yn },
    djrole: { gsKey: 'djRoleId', role: true, nullable: true, fmt: fmtRole },
    musicchannel: { gsKey: 'musicChannelId', channel: true, nullable: true, fmt: fmtChannel },
    modlogchannel: { gsKey: 'modlogChannelId', channel: true, nullable: true, fmt: fmtChannel },
    welcomechannel: { gsKey: 'welcomeChannelId', channel: true, nullable: true, fmt: fmtChannel },
    welcomemessage: { gsKey: 'welcomeMessage', text: 300, nullable: true, fmt: v => (v ? `\`${v}\`` : 'bot default') },
    autorole: { gsKey: 'autoRoleIds', roleList: true, nullable: true, fmt: fmtRoleList },
};

/**
 * Validate one raw `set` value against its table row.
 * @returns the value to store (or null for a `default`/`off` clear)
 * @throws Error with a user-facing message on anything invalid
 */
function parseValue(key, raw, guild = null) {
    const row = KEYS[key];
    if (!row) throw new Error(`unknown setting \`${key}\` — see \`config show\``);
    const text = String(raw ?? '').trim();

    if (row.bool) {
        const low = text.toLowerCase();
        if (low === 'on' || low === 'true') return true;
        if (low === 'off' || low === 'false') return false;
        if (low === 'default' && row.nullable) return null;
        throw new Error(`\`${key}\` takes on, off${row.nullable ? ' or default' : ''}`);
    }
    if (row.role || row.channel) {
        if (!text) throw new Error(`\`${key}\` needs a ${row.role ? 'role' : 'channel'} mention or id (or \`off\`)`);
        if (/^(off|none|clear|default)$/i.test(text)) {
            if (row.nullable) return null;
            throw new Error(`\`${key}\` cannot be cleared`);
        }
        const id = text.match(MENTION_ID)?.[1];
        if (!id) throw new Error(`mention a real ${row.role ? 'role' : 'channel'}`);
        const collection = row.role ? guild?.roles?.cache : guild?.channels?.cache;
        if (!collection?.has(id)) throw new Error(`that ${row.role ? 'role' : 'channel'} is not in this server`);
        return id;
    }
    if (row.roleList) {
        if (!text || /^(off|none|clear|default)$/i.test(text)) {
            if (row.nullable) return null;
            throw new Error(`\`${key}\` cannot be cleared`);
        }
        const ids = text.split(/[\s,]+/).map(t => t.match(MENTION_ID)?.[1]).filter(Boolean);
        if (!ids.length) throw new Error('mention at least one real role (e.g. @Members @Regular)');
        const unknown = ids.filter(id => !guild?.roles?.cache?.has(id));
        if (unknown.length) throw new Error(`unknown role(s): ${unknown.map(id => `<@&${id}>`).join(' ')}`);
        return ids;
    }
    if (row.text) {
        if (!text) throw new Error(`\`${key}\` needs a value (or \`off\` to clear)`);
        if (/^(off|none|clear|default)$/i.test(text) && row.nullable) return null;
        if (text.length > row.text) throw new Error(`\`${key}\` is limited to ${row.text} characters`);
        if (row.re && !row.re.test(text)) throw new Error(row.reMsg);
        return text;
    }
    throw new Error(`\`${key}\` has no parser`);
}

/** The `show` embed body, given merged settings + this guild's toggle view. */
function renderShow(guild, s, config, disabledCommands) {
    const lines = Object.entries(KEYS).map(([key, row]) => {
        const value = row.fmt(s[row.gsKey], guild, config);
        return `• \`${key}\`: ${value}`;
    });
    const toggles = disabledCommands.length
        ? disabledCommands.map(n => `\`${n}\``).join(' ')
        : 'none';
    return (
        `**Server settings** (change with \`config set <key> <value>\`, revert with \`config reset <key>\`)\n`
        + `${lines.join('\n')}\n\n`
        + `**Disabled in this server:** ${toggles}`
    );
}

module.exports = {
    name: 'config',
    description: 'Show or change this server\'s bot settings (staff)',
    usage: 'config <show|set <key> <value>|reset <key>|disable|enable <command>>',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Show or change this server\'s bot settings')
        .addSubcommand(sub => sub.setName('show').setDescription('List every setting and its current value'))
        .addSubcommand(sub => sub
            .setName('set').setDescription('Change one setting')
            .addStringOption(o => o.setName('key').setDescription('Setting name').setRequired(true).addChoices(...Object.keys(KEYS).map(name => ({ name, value: name }))))
            .addStringOption(o => o.setName('value').setDescription('New value (on/off/mention/text)').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('reset').setDescription('Restore a setting to its default')
            .addStringOption(o => o.setName('key').setDescription('Setting name').setRequired(true).addChoices(...Object.keys(KEYS).map(name => ({ name, value: name })))))
        .addSubcommand(sub => sub
            .setName('disable').setDescription('Turn a command off for this server')
            .addStringOption(o => o.setName('command').setDescription('Command name').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('enable').setDescription('Turn a command back on for this server')
            .addStringOption(o => o.setName('command').setDescription('Command name').setRequired(true))),

    async execute(ctx) {
        const guildId = ctx.guild.id;
        const s = settings.get(guildId);

        const sub = ctx.isSlash
            ? ctx.interaction.options.getSubcommand()
            : String(ctx.args[0] ?? 'show').toLowerCase();
        const E = { ephemeral: true };

        const disabledHere = commandToggles
            .view([...ctx.commands.keys()], guildId)
            .filter(t => !t.enabled)
            .map(t => t.name);

        if (sub === 'show' || !sub) {
            return ctx.reply({
                embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription(renderShow(ctx.guild, s, ctx.config, disabledHere))],
                ...E,
            });
        }

        if (sub === 'set' || sub === 'reset') {
            const key = String(ctx.option('key') ?? ctx.args[1] ?? '').toLowerCase();
            if (!KEYS[key]) return ctx.reply(`❌ Unknown setting \`${key || '(none)'}\`. Keys: ${Object.keys(KEYS).join(', ')}`, E);
            const row = KEYS[key];
            let value;
            if (sub === 'reset') {
                value = null;
            } else {
                const raw = String(ctx.option('value') ?? ctx.args.slice(2).join(' ') ?? '');
                try {
                    value = parseValue(key, raw, ctx.guild);
                } catch (err) {
                    return ctx.reply(`❌ ${err.message}`, E);
                }
            }
            // reset on a non-nullable bool (247) means "off", not "null".
            if (sub === 'reset' && row.bool && !row.nullable) value = false;
            settings.patch(guildId, { [row.gsKey]: value });
            const shown = row.fmt(value, ctx.guild, ctx.config);
            return ctx.reply(`✅ \`${key}\` = ${shown}`, E);
        }

        if (sub === 'disable' || sub === 'enable') {
            const name = String(ctx.option('command') ?? ctx.args[1] ?? '').toLowerCase().replace(/^!/, '');
            const cmd = ctx.commands.get(name);
            if (!cmd) return ctx.reply(`❌ There is no command called \`${name}\`.`, E);
            if (cmd.ownerOnly) return ctx.reply(`⛔ \`${name}\` is owner-only — servers cannot toggle it.`, E);
            commandToggles.setGuild(guildId, name, sub === 'enable', { ownerOnly: Boolean(cmd.ownerOnly) });
            ctx.resyncSlash?.();
            return ctx.reply(`${sub === 'enable' ? '✅' : '🚫'} \`${name}\` is now ${sub === 'enable' ? 'enabled' : 'disabled'} in this server.`, E);
        }

        return ctx.reply('Usage: `config <show|set <key> <value>|reset <key>|disable|enable <command>>`', E);
    },
};

// Exported for the smoke tests — the table and the two pure functions.
module.exports.KEYS = KEYS;
module.exports.parseValue = parseValue;
module.exports.renderShow = renderShow;
