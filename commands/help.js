const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');

module.exports = {
    name: 'help',
    aliases: ['h'],
    description: 'Show this help message',
    usage: 'help',
    data: new SlashCommandBuilder().setName('help').setDescription('Show this help message'),

    async execute(ctx) {
        const prefix = ctx.config.prefix;
        const seen = new Set();
        const lines = [];

        for (const cmd of ctx.commands.values()) {
            if (seen.has(cmd.name) || cmd.ownerOnly || cmd.adminOnly) continue;
            seen.add(cmd.name);
            const aliases = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
            const usage = cmd.usage ? `\`${prefix}${cmd.usage}\`` : `\`${prefix}${cmd.name}\``;
            lines.push(`**${usage}**${aliases}\n${cmd.description ?? 'No description.'}`);
        }

        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(`MockBot v${version} — Commands`)
            .setDescription(`Prefix: \`${prefix}\` — every command also works as a slash command.\n\n${lines.join('\n\n')}`)
            .setFooter({ text: 'Admin/owner commands are hidden.' });

        return ctx.reply({ embeds: [embed] });
    },
};
