const {
    ActionRowBuilder,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
} = require('discord.js');
const { register } = require('./components');
const { COLOR, songLink, mdTitle } = require('./musicFormat');
const { explainError } = require('./musicGuards');

/**
 * The `play` search-result picker.
 *
 * Plain-text search used to auto-pick YouTube's #1 hit through
 * `ytsearch1:` — which silently queued whatever yt-dlp thought you meant.
 * Instead, resolve the top 5 (`ytsearch5:`), show them in a select menu, and
 * queue the one the requester picks. URLs skip the picker entirely.
 *
 * Results are held in memory only, keyed by a random token embedded in the
 * select's customId (`mb:pick:<token>`). Nothing is persisted: an expired or
 * stale picker just needs a fresh `play`. The picker belongs to whoever ran
 * the command (the owner may use anyone's), and expires after PICKER_TTL_MS.
 */

const PICKER_TTL_MS = 3 * 60_000;
const MAX_PICKERS = 200;

/** @type {Map<string, {songs: object[], voiceChannelId: string, textChannelId: string, guildId: string, userId: string, expires: number}>} */
const pickers = new Map();

function prune() {
    const now = Date.now();
    for (const [token, p] of pickers) if (p.expires <= now) pickers.delete(token);
    while (pickers.size > MAX_PICKERS) pickers.delete(pickers.keys().next().value);
}

/**
 * Remember a pending search and return its interaction token.
 * @param {object} entry { songs, voiceChannelId, textChannelId, guildId, userId }
 */
function open(token, entry) {
    prune();
    pickers.set(token, { ...entry, expires: Date.now() + PICKER_TTL_MS });
    return token;
}

/** The song list behind a picker, or null when expired/unknown. */
function peek(token) {
    const entry = pickers.get(String(token));
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        pickers.delete(String(token));
        return null;
    }
    return entry;
}

function fmtDuration(song) {
    if (!song) return '';
    if (song.isLive) return 'LIVE';
    const d = Math.max(0, Math.floor(song.duration ?? 0));
    const h = Math.floor(d / 3600);
    const m = Math.floor((d % 3600) / 60);
    const s = d % 60;
    return h
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The picker message: numbered results embed + one select menu.
 *
 * @param {string} query      what was searched (for the header)
 * @param {object[]} songs    candidate Songs from plugin.search()
 * @param {string} token      the picker token from open()
 */
function pickerPayload(query, songs, token) {
    const lines = songs.map((s, i) =>
        `**${i + 1}.** ${songLink(s)} — \`${fmtDuration(s)}\`\n      ${mdTitle(s.uploader?.name ?? 'Unknown channel', 80)}`);

    const embed = new EmbedBuilder()
        .setColor(COLOR.info)
        .setTitle('🔎 Which one did you mean?')
        .setDescription(
            `Search: **${mdTitle(query, 100)}**\n\n${lines.join('\n')}\n\n` +
            'Pick below — the choice expires in 3 minutes.',
        );

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`mb:pick:${token}`)
        .setPlaceholder('Choose a song to play')
        .addOptions(
            songs.map((s, i) => new StringSelectMenuOptionBuilder()
                .setValue(String(i + 1))
                .setLabel(mdTitle(s.name, 90))
                .setDescription(`${fmtDuration(s)} • ${mdTitle(s.uploader?.name ?? 'Unknown', 60)}`.slice(0, 95))),
        );

    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

/** Queue the chosen song and rewrite the message into a plain confirmation. */
async function chosen(interaction, deps) {
    const [, , token] = String(interaction.customId).split(':');
    const entry = peek(token);

    if (!entry) {
        return interaction.update({ embeds: [], components: [], content: '⌛ That search expired — run `play` again.' });
    }
    if (interaction.user.id !== entry.userId && interaction.user.id !== String(process.env.OWNER ?? '')) {
        return interaction.reply({ content: 'Only the person who searched can pick the song.', flags: MessageFlags.Ephemeral });
    }

    const index = Number.parseInt(interaction.values?.[0] ?? '', 10) - 1;
    const song = entry.songs[index];
    if (!song) return interaction.reply({ content: '❌ That choice is not one of the options.', flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;

    // Picking a song can start or extend a queue — the DJ gate applies here
    // too, checked against whatever queue exists right now.
    const current = deps.distube?.getQueue?.(guild.id);
    const blocked = djReply(guild, interaction.member, current);
    if (blocked) return interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral });
    const voiceChannel =
        interaction.member?.voice?.channel
        ?? guild.members.me?.voice?.channel
        ?? (guild.channels.cache.get(entry.voiceChannelId) ?? null);
    if (!voiceChannel) {
        return interaction.update({ embeds: [], components: [], content: '❌ Nobody was in a voice channel any more — `play` again.' });
    }

    pickers.delete(String(token));
    const textChannel = guild.channels.cache.get(entry.textChannelId) ?? interaction.channel;

    try {
        await deps.distube.play(voiceChannel, song, {
            member: interaction.member ?? await guild.members.fetch(interaction.user.id),
            textChannel,
            message: interaction.message,
        });
    } catch (err) {
        return interaction.reply({ content: `❌ Could not play that: ${explainError(err)}`, flags: MessageFlags.Ephemeral });
    }

    const alreadyIn = guild.members.me?.voice?.channelId && guild.members.me.voice.channelId !== voiceChannel.id
        ? ` Moved to **${voiceChannel.name}** to follow you.`
        : '';
    return interaction.update({
        embeds: [],
        components: [],
        content: `✅ Queued ${songLink(song)} in **${voiceChannel.name}**.${alreadyIn}`,
    });
}

register('pick', chosen);

module.exports = {
    open,
    peek,
    pickers,
    pickerPayload,
    fmtDuration,
    chosen,
    PICKER_TTL_MS,
};
