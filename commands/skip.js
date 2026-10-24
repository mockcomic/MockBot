const { SlashCommandBuilder } = require('discord.js');
const { requireQueue, isBlocked, explainError, isOwner } = require('../lib/musicGuards');
const { humanListenerCount, attemptSkip } = require('../lib/voteSkip');
const guildSettings = require('../lib/guildSettings');

/**
 * Skip — instant for the owner, the requester, or the sole listener; a vote
 * of the humans in the voice channel otherwise (see lib/voteSkip.js).
 */
module.exports = {
    name: 'skip',
    aliases: ['next', 's'],
    description: 'Skip the current song (votes needed when several people are listening)',
    usage: 'skip',
    category: 'music',
    data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),

    async execute(ctx) {
        const guard = await requireQueue(ctx);
        if (isBlocked(guard)) return ctx.reply(guard.reply);
        const { queue } = guard;

        const setting = guildSettings.get(ctx.guild.id).voteSkip;
        const voteEnabled = setting ?? (ctx.config.music?.voteSkipEnabled ?? true);
        const song = queue.songs[0];
        const decision = attemptSkip({
            guildId: ctx.guild.id,
            userId: ctx.user.id,
            isOwner: isOwner(ctx.user.id),
            isRequester: Boolean(song?.user?.id) && String(song.user.id) === String(ctx.user.id),
            voteEnabled,
            queue,
        });

        if (decision.action === 'already') {
            return ctx.reply(`🗳️ You already voted — ${decision.votes}/${decision.needed} in favour.`, { ephemeral: true });
        }
        if (decision.action === 'vote') {
            const others = Math.max(0, humanListenerCount(queue.voiceChannel) - decision.votes);
            return ctx.reply(
                `🗳️ Vote skip started — ${decision.votes}/${decision.needed} in favour. ` +
                `Others in ${queue.voiceChannel?.name ?? 'the channel'}: \`skip\` to join${others ? ` (${others} listener(s) have not voted yet)` : ''}.`,
            );
        }

        try {
            await queue.skip();
        } catch (err) {
            return ctx.reply(`❌ ${explainError(err)}`);
        }
        return ctx.reply(
            decision.reason === 'passed'
                ? `⏭️ Vote passed (${decision.votes}/${decision.needed}) — skipped.`
                : '⏭️ Skipped.',
        );
    },
};
