const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'myid',
    description: 'Show your Discord user ID',
    usage: 'myID',
    data: new SlashCommandBuilder().setName('myid').setDescription('Show your Discord user ID'),

    async execute(ctx) {
        return ctx.reply(`Your ID is: **${ctx.user.id}**`);
    },
};
