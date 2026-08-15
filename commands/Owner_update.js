const { exec } = require('node:child_process');
const { SlashCommandBuilder } = require('discord.js');

const run = command =>
    new Promise(resolve => {
        exec(command, (error, stdout, stderr) => {
            resolve({ command, error, stdout: stdout?.trim(), stderr: stderr?.trim() });
        });
    });

module.exports = {
    name: 'update',
    ownerOnly: true,
    description: 'Pull the latest bot code from git',
    usage: 'update',
    data: new SlashCommandBuilder().setName('update').setDescription('Pull the latest bot code from git'),

    async execute(ctx) {
        if (ctx.isSlash) await ctx.defer();

        const results = [];
        for (const command of ['git stash', 'git stash drop', 'git pull']) {
            const result = await run(command);
            results.push(
                `$ ${result.command}\n` +
                `${result.error ? `error: ${result.error.message}` : result.stderr || result.stdout || '(no output)'}`,
            );
        }

        return ctx.reply(`🔁 Update finished. Restart the bot to apply changes.\n\`\`\`\n${results.join('\n\n')}\n\`\`\``);
    },
};
