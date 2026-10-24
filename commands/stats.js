const { SlashCommandBuilder, EmbedBuilder, version: djsVersion } = require('discord.js');
const { COLOR } = require('../lib/musicFormat');
const { formatDurationMs } = require('../lib/duration');
const settings = require('../lib/guildSettings');

/**
 * A quick look at the machine this bot is running on — uptime, memory,
 * guild/voice counts — the numbers you actually miss on a Raspberry Pi.
 */
module.exports = {
    name: 'stats',
    aliases: ['status', 'info'],
    description: 'Bot uptime, memory and server stats',
    usage: 'stats',
    category: 'utility',
    data: new SlashCommandBuilder().setName('stats').setDescription('Show bot uptime, memory and server stats'),

    async execute(ctx) {
        const { client, distube } = ctx;
        const uptime = client.readyTimestamp ? formatDurationMs(Date.now() - client.readyTimestamp) : 'starting up';
        const mem = process.memoryUsage();
        const mb = n => `${(n / 1048576).toFixed(1)} MB`;

        let guildChannels = 0;
        for (const guild of client.guilds.cache.values()) guildChannels += guild.channels?.cache?.size ?? 0;

        const ping = typeof client.ws?.ping === 'number' && client.ws.ping >= 0 ? `${client.ws.ping} ms` : 'n/a';

        const guildId = ctx.guild?.id;
        const prefix = guildId ? settings.get(guildId).prefix ?? ctx.config.prefix : ctx.config.prefix;

        const embed = new EmbedBuilder()
            .setColor(COLOR.accent)
            .setTitle('🤖 MockBot stats')
            .addFields(
                { name: 'Uptime', value: uptime, inline: true },
                { name: 'Gateway ping', value: ping, inline: true },
                { name: 'Prefix here', value: `\`${prefix}\``, inline: true },
                { name: 'Servers', value: String(client.guilds.cache.size), inline: true },
                { name: 'Channels (cached)', value: String(guildChannels), inline: true },
                { name: 'People (cached)', value: String(client.users.cache.size), inline: true },
                { name: 'Active queues', value: String(distube.queues.size), inline: true },
                { name: 'Memory', value: `RSS ${mb(mem.rss)} · heap ${mb(mem.heapUsed)}`, inline: true },
                { name: 'Runtime', value: `Node ${process.version} · discord.js ${djsVersion}`, inline: true },
            );

        return ctx.reply({ embeds: [embed] });
    },
};
