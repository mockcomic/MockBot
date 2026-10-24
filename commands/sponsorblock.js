const { SlashCommandBuilder } = require('discord.js');
const settings = require('../lib/guildSettings');

/**
 * Per-server SponsorBlock toggle (skips sponsor/self-promo segments on VODs).
 * The watcher itself is lib/sponsorBlock.js; this only flips the setting.
 */
module.exports = {
    name: 'sponsorblock',
    aliases: ['sb'],
    description: 'Turn sponsor-segment skipping on or off for this server',
    usage: 'sponsorblock <on|off|status>',
    data: new SlashCommandBuilder()
        .setName('sponsorblock')
        .setDescription('Toggle SponsorBlock segment skipping')
        .addStringOption(option =>
            option.setName('state').setDescription('on, off, or status')
                .addChoices(
                    { name: 'on', value: 'on' },
                    { name: 'off', value: 'off' },
                    { name: 'status', value: 'status' },
                )),

    async execute(ctx) {
        const raw = String(ctx.option('state') ?? ctx.args[0] ?? 'status').toLowerCase();
        const current = settings.get(ctx.guild.id).sponsorBlock;
        const effective = current ?? Boolean(ctx.config.music?.sponsorBlockByDefault);

        if (raw === 'on' || raw === 'off') {
            settings.patch(ctx.guild.id, { sponsorBlock: raw === 'on' });
            return ctx.reply(`${raw === 'on' ? '⏭️ SponsorBlock on' : '▶️ SponsorBlock off'} for this server.`, { ephemeral: true });
        }

        const globalDefault = Boolean(ctx.config.music?.sponsorBlockByDefault);
        return ctx.reply(
            `ℹ️ SponsorBlock here: **${effective ? 'on' : 'off'}**` +
            (current === null
                ? ` (following the global default — \`${ctx.config.prefix}sponsorblock ${globalDefault ? 'off' : 'on'}\` overrides it).`
                : ' (server override — `sponsorblock status` shows this line, the global default is ' +
                  `${globalDefault ? 'on' : 'off'}).`),
            { ephemeral: true },
        );
    },
};
