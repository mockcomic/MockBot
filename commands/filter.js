const { SlashCommandBuilder } = require('discord.js');
const { defaultFilters } = require('distube');

const FILTER_NAMES = Object.keys(defaultFilters);

module.exports = {
    name: 'filter',
    description: 'Toggle an audio filter (e.g. bassboost, nightcore) or clear all',
    usage: 'filter <name | clear | list>',
    data: new SlashCommandBuilder()
        .setName('filter')
        .setDescription('Toggle an audio filter or clear all')
        .addStringOption(option =>
            option
                .setName('name')
                .setDescription('Filter to toggle, or "clear"/"list"')
                .setRequired(false)
                .addChoices(
                    { name: 'clear (remove all filters)', value: 'clear' },
                    { name: 'list (show filters)', value: 'list' },
                    ...FILTER_NAMES.slice(0, 23).map(name => ({ name, value: name })),
                ),
        ),

    async execute(ctx) {
        const queue = ctx.distube.getQueue(ctx.guild);
        if (!queue) return ctx.reply('Not playing music!');

        const name = String(ctx.args[0] ?? 'list').toLowerCase();

        if (name === 'list') {
            const enabled = queue.filters.names.join(', ') || 'Off';
            return ctx.reply(`Available filters: ${FILTER_NAMES.join(', ')}\nCurrently enabled: **${enabled}**`);
        }

        if (name === 'clear') {
            queue.filters.clear();
            return ctx.reply('🧹 All filters cleared.');
        }

        if (!FILTER_NAMES.includes(name)) {
            return ctx.reply(`Unknown filter \`${name}\`. Available: ${FILTER_NAMES.join(', ')}`);
        }

        if (queue.filters.has(name)) {
            queue.filters.remove(name);
        } else {
            queue.filters.add(name);
        }
        const enabled = queue.filters.names.join(', ') || 'Off';
        return ctx.reply(`🎛️ Filters now: **${enabled}** (may take a few seconds to apply)`);
    },
};
