const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'ping',
    description: 'Show bot and API latency',
    usage: 'ping',
    data: new SlashCommandBuilder().setName('ping').setDescription('Show bot and API latency'),

    async execute(ctx) {
        const sent = await ctx.reply('🏓 Pinging…');
        const roundtrip = Date.now() - sent.createdTimestamp;
        const ws = Math.round(ctx.client.ws.ping);
        const text = `🏓 Pong! Roundtrip: **${roundtrip}ms** | WebSocket: **${ws}ms**`;

        if (ctx.isSlash) return ctx.interaction.editReply(text);
        return sent.edit(text);
    },
};
