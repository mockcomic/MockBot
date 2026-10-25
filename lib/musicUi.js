const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { register } = require('./components');
const { requireQueue, isBlocked, explainError, isOwner } = require('./musicGuards');
const { COLOR, songLink, progressLine, statusLine, loopLabel, queuePage } = require('./musicFormat');
const voteSkip = require('./voteSkip');
const guildSettings = require('./guildSettings');

/**
 * The interactive music UI: shared embed builders and the button handlers
 * behind every `mb:` control. Requiring this module (bot.js does) registers
 * the handlers with lib/components.js.
 *
 * Controls obey the same rule as the commands: you must sit in the bot's
 * voice channel (owner exempt), except the queue page arrows, which are
 * read-only navigation. `skip` routes through the same vote logic as the
 * command, so the button cannot bypass a vote.
 */

function controlRow(queue) {
    const paused = Boolean(queue?.paused);
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mb:nptoggle')
            .setEmoji(paused ? '▶️' : '⏸️')
            .setStyle(ButtonStyle.Secondary)
            .setLabel(paused ? 'Resume' : 'Pause'),
        new ButtonBuilder()
            .setCustomId('mb:npskip')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Skip'),
        new ButtonBuilder()
            .setCustomId('mb:npshuffle')
            .setEmoji('🔀')
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Shuffle'),
    );
}

function pageRow(page, pages) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mb:qp:${Math.max(1, page - 1)}`)
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1),
        new ButtonBuilder()
            .setCustomId(`mb:qp:${Math.min(pages, page + 1)}`)
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pages),
    );
}

function buildNowPlayingEmbed(queue, song) {
    if (!song) {
        return new EmbedBuilder()
            .setColor(COLOR.info)
            .setTitle('🎶 Now playing')
            .setDescription('⏹️ The queue is empty.');
    }
    const lines = [
        `**${songLink(song)}**`,
        progressLine(queue, song),
        '',
        `Requested by: ${song.user ?? 'Unknown'}`,
        `Channel: ${song.uploader?.name ?? 'Unknown'}`,
        typeof song.views === 'number' ? `Views: ${song.views.toLocaleString('en-US')}` : null,
        queue.songs.length > 1
            ? `Up next: ${songLink(queue.songs[1])}`
            : 'Nothing else in the queue.',
    ].filter(Boolean);

    return new EmbedBuilder()
        .setColor(COLOR.play)
        .setTitle('🎶 Now playing')
        .setDescription(lines.join('\n'))
        .setThumbnail(song.thumbnail ?? null)
        .setFooter({
            text: `Loop: ${loopLabel(queue.repeatMode)} | Autoplay: ${queue.autoplay ? 'On' : 'Off'} | ${statusLine(queue)}`,
        });
}

function nowPlayingPayload(queue) {
    return { embeds: [buildNowPlayingEmbed(queue, queue.songs[0])], components: [controlRow(queue)] };
}

function buildQueueEmbed(queue, guildName, view) {
    return new EmbedBuilder()
        .setColor(COLOR.accent)
        .setTitle(`📄 Queue for ${guildName}`)
        .setDescription(view.description)
        .setFooter({ text: view.footerText });
}

function queuePayload(queue, page, guildName) {
    const view = queuePage(queue, page);
    return { embeds: [buildQueueEmbed(queue, guildName, view)], components: [pageRow(view.page, view.pages)] };
}

/** Buttons arrive without a command Context, so build the shape the guards want. */
function shimFrom(interaction, distube) {
    return { user: interaction.user, member: interaction.member, guild: interaction.guild, distube };
}

async function guard(interaction, deps, options) {
    if (!interaction.guild) return { text: 'Music controls only work in a server.' };
    const queue = deps.distube.getQueue(interaction.guild.id);
    if (!queue || !queue.songs?.length) return { stale: true };
    const checked = await requireQueue(shimFrom(interaction, deps.distube), options);
    if (isBlocked(checked)) return { text: checked.reply };
    return { queue: checked.queue };
}

/** Remove dead controls quietly where possible; otherwise explain once. */
async function dropStale(interaction) {
    try {
        await interaction.update({ components: [] });
    } catch {
        await interaction
            .reply({ content: '⏹️ Nothing is playing anymore.', flags: MessageFlags.Ephemeral })
            .catch(() => {});
    }
}

register('nptoggle', async (interaction, _args, deps) => {
    const r = await guard(interaction, deps);
    if (r.stale) return dropStale(interaction);
    if (r.text) return interaction.reply({ content: r.text, flags: MessageFlags.Ephemeral });

    if (r.queue.paused) await r.queue.resume();
    else await r.queue.pause();
    return interaction.update(nowPlayingPayload(r.queue));
});

register('npskip', async (interaction, _args, deps) => {
    const r = await guard(interaction, deps);
    if (r.stale) return dropStale(interaction);
    if (r.text) return interaction.reply({ content: r.text, flags: MessageFlags.Ephemeral });

    const song = r.queue.songs[0];
    const setting = guildSettings.get(interaction.guild.id).voteSkip;
    const voteEnabled = setting ?? deps.config?.music?.voteSkipEnabled ?? true;
    const decision = voteSkip.attemptSkip({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        isOwner: isOwner(interaction.user.id),
        isRequester: Boolean(song?.user?.id) && song.user.id === interaction.user.id,
        voteEnabled,
        queue: r.queue,
    });

    if (decision.action === 'already') {
        return interaction.reply({ content: `🗳️ You already voted — ${decision.votes}/${decision.needed}.` });
    }
    if (decision.action === 'vote') {
        return interaction.reply({
            content: `🗳️ Vote skip started — ${decision.votes}/${decision.needed} listeners in favour.`,
        });
    }

    try {
        await r.queue.skip();
    } catch (err) {
        return interaction.reply({ content: `❌ ${explainError(err)}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.update(nowPlayingPayload(r.queue));
});

register('npshuffle', async (interaction, _args, deps) => {
    const r = await guard(interaction, deps);
    if (r.stale) return dropStale(interaction);
    if (r.text) return interaction.reply({ content: r.text, flags: MessageFlags.Ephemeral });

    if (r.queue.songs.length < 3) {
        return interaction.reply({
            content: 'Add at least two more songs before shuffling.',
            flags: MessageFlags.Ephemeral,
        });
    }
    try {
        await r.queue.shuffle();
    } catch (err) {
        return interaction.reply({ content: `❌ ${explainError(err)}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.update(nowPlayingPayload(r.queue));
});

register('qp', async (interaction, args, deps) => {
    // Paging the list is read-only: no voice-channel requirement.
    const r = await guard(interaction, deps, { sameVoice: false });
    if (r.stale) return dropStale(interaction);
    if (r.text) return interaction.reply({ content: r.text, flags: MessageFlags.Ephemeral });

    const page = Number.parseInt(args[0], 10) || 1;
    return interaction.update(queuePayload(r.queue, page, interaction.guild.name));
});

module.exports = {
    controlRow,
    pageRow,
    buildNowPlayingEmbed,
    nowPlayingPayload,
    buildQueueEmbed,
    queuePayload,
};
