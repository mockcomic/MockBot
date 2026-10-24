const { SlashCommandBuilder } = require('discord.js');
const { defaultFilters } = require('distube');
const { requireQueue, isBlocked } = require('../lib/musicGuards');
const { fenced } = require('../lib/respond');

const FILTER_NAMES = Object.keys(defaultFilters);

// Discord allows at most 25 choices per option; two are reserved for clear/list.
const CHOICE_LIMIT = 23;
const CHOICES = [
    { name: 'clear (remove all filters)', value: 'clear' },
    { name: 'list (show filters)', value: 'list' },
    ...FILTER_NAMES.slice(0, CHOICE_LIMIT).map(name => ({ name, value: name })),
];

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
                .addChoices(...CHOICES),
        ),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const name = String(ctx.args[0] ?? 'list').toLowerCase();

        if (name === 'list') {
            const enabled = queue.filters.names.join(', ') || 'Off';
            const shown = FILTER_NAMES.slice(0, CHOICE_LIMIT);
            const hidden = FILTER_NAMES.length - shown.length;
            const note = hidden > 0 ? `\n\n(${hidden} more only reachable as a prefix command)` : '';
            return ctx.reply(`Currently enabled: **${enabled}**\n\n${fenced(shown.join('\n'), { title: 'Filters' })}${note}`);
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
