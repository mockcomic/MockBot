const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');
const { canRun, isOwner } = require('../lib/access');
const guildSettings = require('../lib/guildSettings');
const { COLOR } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

/**
 * Commands that belong to the Music section. Explicit `category` fields win;
 * this map keeps the pre-v3.2 music commands from all needing an edit.
 */
const MUSIC = new Set([
    'play', 'skip', 'previous', 'stop', 'pause', 'queue', 'nowplaying', 'volume',
    'jump', 'repeat', 'remove', 'clear', 'seek', 'shuffle', 'filter',
    'playlist', 'lyrics', 'autoplay', '247', 'leave', 'voteskip',
]);

function bucketOf(cmd) {
    if (cmd.category === 'music' || cmd.category === 'utility' || cmd.category === 'staff') return cmd.category;
    if (cmd.ownerOnly || cmd.adminOnly) return 'staff';
    return MUSIC.has(cmd.name) ? 'music' : 'utility';
}

const SECTIONS = [
    ['music', '🎵 Music'],
    ['utility', '🛠️ Utility'],
    ['staff', '🔒 Staff / owner'],
];

module.exports = {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show this help message',
    usage: 'help',
    category: 'utility',
    data: new SlashCommandBuilder().setName('help').setDescription('Show this help message'),

    async execute(ctx) {
        // Show the prefix this server actually listens to, not just the global one.
        const prefix = guildSettings.get(ctx.guild?.id).prefix ?? ctx.config.prefix;
        const buckets = { music: [], utility: [], staff: [] };
        const hidden = [];

        // ctx.commands is a Map keyed by name, so entries are already unique.
        for (const cmd of ctx.commands.values()) {
            let restrictedLine = null;
            if (cmd.ownerOnly || cmd.adminOnly) {
                // Restricted: show it only to somebody who can actually run it,
                // so the list is a discovery tool rather than a secret.
                const access = await canRun(cmd, ctx);
                if (!access.ok) {
                    hidden.push(cmd.name);
                    continue;
                }
                restrictedLine = `${format(cmd, prefix)} 🔒`;
            }
            buckets[bucketOf(cmd)].push(restrictedLine ?? format(cmd, prefix));
        }

        const body = SECTIONS
            .map(([key, title]) => {
                const lines = buckets[key];
                if (!lines.length) return null;
                return `**${title}**\n${lines.sort((a, b) => a.localeCompare(b)).join('\n\n')}`;
            })
            .filter(Boolean)
            .join('\n\n');

        const footer = hidden.length
            ? `${hidden.length} restricted command(s) hidden from you`
            : isOwner(ctx.user.id)
                ? 'You can see every command'
                : 'Ask a server admin for the restricted commands';

        const embed = new EmbedBuilder()
            .setColor(COLOR.accent)
            .setTitle(`MockBot v${version} — Commands`)
            .setDescription(
                clip(
                    `Prefix: \`${prefix}\` — every command also works as a slash command.\n\n` +
                    `${body || 'No commands available to you.'}\n\n🔒 = restricted to admins or the bot owner.`,
                ),
            )
            .setFooter({ text: clip(footer, 2048) });

        return ctx.reply({ embeds: [embed] });
    },
};

function format(cmd, prefix) {
    const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
    const usage = cmd.usage ? `\`${prefix}${cmd.usage}\`` : `\`${prefix}${cmd.name}\``;
    return `**${usage}**${aliases}\n${cmd.description ?? 'No description.'}`;
}
