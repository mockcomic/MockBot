const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');
const { canRun, isOwner } = require('../lib/access');
const { COLOR } = require('../lib/musicFormat');
const { clip } = require('../lib/respond');

module.exports = {
    name: 'help',
    aliases: ['h', 'commands'],
    description: 'Show this help message',
    usage: 'help',
    data: new SlashCommandBuilder().setName('help').setDescription('Show this help message'),

    async execute(ctx) {
        const prefix = ctx.config.prefix;
        const lines = [];
        const hidden = [];

        // ctx.commands is a Map keyed by name, so entries are already unique.
        for (const cmd of ctx.commands.values()) {
            if (!cmd.ownerOnly && !cmd.adminOnly) {
                lines.push(format(cmd, prefix));
                continue;
            }
            // Restricted: show it only to somebody who can actually run it, so
            // the list is a discovery tool rather than a secret.
            const access = await canRun(cmd, ctx);
            if (access.ok) lines.push(`${format(cmd, prefix)} 🔒`);
            else hidden.push(cmd.name);
        }

        const body = lines.sort((a, b) => a.localeCompare(b)).join('\n\n');
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
