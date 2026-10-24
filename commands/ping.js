const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'ping',
    description: 'Show bot and API latency',
    usage: 'ping',
    data: new SlashCommandBuilder().setName('ping').setDescription('Show bot and API latency'),

    async execute(ctx) {
        const sent = await ctx.reply('🏓 Pinging…');
        const roundtrip = Date.now() - sent.createdTimestamp;
        const ws = Number(ctx.client.ws.ping);
        // ws.ping is -1 until the first heartbeat ACK arrives.
        const wsText = Number.isFinite(ws) && ws >= 0 ? `**${Math.round(ws)}ms**` : 'n/a';
        const text = `🏓 Pong! Roundtrip: **${roundtrip}ms** | WebSocket: ${wsText}`;

        // ctx.editReply handles both styles (message.edit vs interaction.editReply),
        // so commands no longer reach into ctx.interaction.
        return ctx.editReply(text);
    },
};
