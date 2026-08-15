const { SlashCommandBuilder } = require('discord.js');

const MODEL = 'gemini-2.0-flash';

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
    name: 'gemini',
    aliases: ['bard'],
    description: 'Ask Google Gemini a question',
    usage: 'gemini <question>',
    data: new SlashCommandBuilder()
        .setName('gemini')
        .setDescription('Ask Google Gemini a question')
        .addStringOption(option =>
            option.setName('prompt').setDescription('Your question').setRequired(true),
        ),

    async execute(ctx) {
        // BARD kept for backwards compatibility with old .env files.
        const apiKey = process.env.GEMINI_API_KEY ?? process.env.BARD;
        if (!apiKey) return ctx.reply('❌ Gemini API key not set. Add `GEMINI_API_KEY` to .env.');

        const prompt = ctx.args.join(' ').trim();
        if (!prompt) return ctx.reply(`Usage: \`${ctx.config.prefix}gemini <question>\``);

        if (ctx.isSlash) await ctx.defer();

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                    }),
                },
            );
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error?.message ?? `HTTP ${response.status}`);
            }

            const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!answer) throw new Error('Empty response from Gemini');

            for (const chunk of chunkMessage(answer)) {
                await ctx.reply(chunk);
            }
        } catch (err) {
            console.error('[gemini]', err);
            return ctx.reply(`❌ Gemini error: ${err.message}`);
        }
    },
};
