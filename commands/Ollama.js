const { SlashCommandBuilder } = require('discord.js');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
const DEFAULT_MODEL = 'dolphin-mixtral';

/** Split a long reply into Discord-safe chunks. */
const chunkMessage = (message, size = 2000) => {
    const chunks = [];
    while (message.length > size) {
        chunks.push(message.slice(0, size));
        message = message.slice(size);
    }
    chunks.push(message);
    return chunks;
};

module.exports = {
    name: 'ollama',
    description: 'Ask a local Ollama model a question',
    usage: 'ollama <question>',
    data: new SlashCommandBuilder()
        .setName('ollama')
        .setDescription('Ask a local Ollama model a question')
        .addStringOption(option =>
            option.setName('prompt').setDescription('Your question').setRequired(true),
        ),

    async execute(ctx) {
        const prompt = ctx.args.join(' ').trim();
        if (!prompt) return ctx.reply(`Usage: \`${ctx.config.prefix}ollama <question>\``);

        if (ctx.isSlash) await ctx.defer();
        else await ctx.send('Fetching Data…').catch(() => {});

        const endpoint = process.env.OLLAMAAPI ?? DEFAULT_ENDPOINT;
        const model = process.env.OLLAMAMODEL ?? DEFAULT_MODEL;

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt, stream: false }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            const answer = data.response?.trim();
            if (!answer) throw new Error('Empty response from Ollama');

            for (const chunk of chunkMessage(answer)) {
                await ctx.reply(chunk);
            }
        } catch (err) {
            console.error('[ollama]', err);
            return ctx.reply(`❌ Ollama error: ${err.message} (is Ollama running at ${endpoint}?)`);
        }
    },
};
