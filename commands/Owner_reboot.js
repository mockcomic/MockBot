const { exec } = require('node:child_process');
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'reboot',
    ownerOnly: true,
    description: 'Reboot the machine the bot runs on',
    usage: 'reboot',
    data: new SlashCommandBuilder().setName('reboot').setDescription('Reboot the machine the bot runs on'),

    async execute(ctx) {
        await ctx.reply('Goodbye :,(');

        exec('shutdown /r', (error, stdout, stderr) => {
            // Only reached if the shutdown command itself fails.
            if (error) return console.error('[reboot]', error.message);
            if (stderr) return console.error('[reboot]', stderr);
            console.log('[reboot]', stdout);
        });
    },
};
