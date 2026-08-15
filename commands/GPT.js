const { SlashCommandBuilder } = require('discord.js');

const MODEL = 'gpt-4o-mini';

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
    name: 'gpt',
    aliases: ['chatgpt'],
    description: 'Ask ChatGPT a question',
    usage: 'gpt <question>',
    data: new SlashCommandBuilder()
        .setName('gpt')
        .setDescription('Ask ChatGPT a question')
        .addStringOption(option =>
            option.setName('prompt').setDescription('Your question').setRequired(true),
        ),

    async execute(ctx) {
        if (!process.env.GPT) return ctx.reply('❌ OpenAI API key not set. Add `GPT` to .env.');

        const prompt = ctx.args.join(' ').trim();
        if (!prompt) return ctx.reply(`Usage: \`${ctx.config.prefix}gpt <question>\``);

        if (ctx.isSlash) await ctx.defer();

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${process.env.GPT}`,
                },
                body: JSON.stringify({
                    model: MODEL,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error?.message ?? `HTTP ${response.status}`);
            }

            const answer = data.choices?.[0]?.message?.content?.trim();
            if (!answer) throw new Error('Empty response from ChatGPT');

            for (const chunk of chunkMessage(answer)) {
                await ctx.reply(chunk);
            }
        } catch (err) {
            console.error('[gpt]', err);
            return ctx.reply(`❌ ChatGPT error: ${err.message}`);
        }
    },
};
