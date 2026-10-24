const { SlashCommandBuilder } = require('discord.js');
const { Song } = require('distube');
const board = require('../lib/soundboard');
const { requireQueue, isBlocked, djReply, playChannelReply } = require('../lib/musicGuards');
const { clip } = require('../lib/respond');

/**
 * Soundboard: play a locally-stored clip (see lib/soundboard.js).
 *
 * A clip becomes a DisTube Song with `stream.playFromSource` and a file path
 * as its url — DisTubeStream feeds it to the same ffmpeg pipeline that streams
 * YouTube, at the queue's volume/filters, so no parallel audio path exists.
 * If nothing is playing the clip starts at once; otherwise it is inserted as
 * the NEXT song so a meme can cut a song but never restarts the queue.
 */

function fakePlugin() {
    // attachStreamInfo skips all plugin work when playFromSource + url are set.
    return { type: 'extractor', validate: async () => true };
}

function clipSong(clipEntry, member) {
    const song = new Song(
        {
            plugin: fakePlugin(),
            source: 'file',
            playFromSource: true,
            id: clipEntry.name,
            name: `🔊 ${clipEntry.name}`,
            url: clipEntry.file,
            duration: 0, // 0 = "live-like": DisTube will not try to seek it
            uploader: { name: 'Soundboard' },
        },
        { member },
    );
    song.stream.url = clipEntry.file;
    return song;
}

module.exports = {
    name: 'sfx',
    aliases: ['sound', 'board'],
    description: 'Play, manage, and list soundboard clips',
    usage: 'sfx <name|list|add|del> [...]',
    data: new SlashCommandBuilder()
        .setName('sfx')
        .setDescription('Play or manage a soundboard clip')
        .addSubcommand(sub => sub
            .setName('play').setDescription('Play a clip (next if a song is playing)')
            .addStringOption(o => o.setName('name').setDescription('Clip name without extension').setRequired(true).setMaxLength(40)))
        .addSubcommand(sub => sub
            .setName('list').setDescription('List every clip on the board'))
        .addSubcommand(sub => sub
            .setName('add').setDescription('Upload a clip (attach the audio file to this message)')
            .addStringOption(o => o.setName('name').setDescription('Name for the clip').setRequired(true).setMaxLength(40)))
        .addSubcommand(sub => sub
            .setName('del').setDescription('Delete a clip')
            .addStringOption(o => o.setName('name').setDescription('Clip name').setRequired(true).setMaxLength(40))),

    async execute(ctx) {
        if (!ctx.guild) return ctx.reply('The soundboard lives in a server.');
        if (ctx.config.music?.soundboardEnabled === false) {
            return ctx.reply('🔇 The soundboard is disabled by the bot owner.');
        }

        let sub = String(ctx.args[0] ?? '').toLowerCase();
        let arg = ctx.args.slice(1).join(' ');
        if (ctx.isSlash) {
            sub = ctx.interaction.options.getSubcommand();
            arg = String(ctx.option('name') ?? '');
        } else if (!sub) {
            return ctx.reply(
                `Usage: \`${ctx.config.prefix}sfx <name|list|add <name>|del <name>>\` — ` +
                'the source of truth for what exists is `sfx list`.',
            );
        }

        if (sub === 'play' || (!['list', 'add', 'del', 'delete', 'remove'].includes(sub) && sub)) {
            const name = sub === 'play' ? arg : sub; // bare `sfx horn` works too
            const entry = board.resolveClip(name);
            if (!entry) return ctx.reply(`❌ No clip \`${clip(name, 40)}\` on the board — \`${ctx.config.prefix}sfx list\` shows what is there.`);

            const voiceChannel = ctx.member?.voice?.channel
                ?? (await ctx.guild.members.fetch(ctx.user.id).catch(() => null))?.voice?.channel;
            if (!voiceChannel) return ctx.reply('Join a voice channel first, then try again.');

            // Same authority rules as starting music.
            const wrongChannel = playChannelReply(ctx.guild, ctx.channel);
            if (wrongChannel) return ctx.reply(wrongChannel);

            const existing = ctx.distube.getQueue(ctx.guild);
            if (existing) {
                const guard = await requireQueue(ctx);
                if (isBlocked(guard)) return ctx.reply(guard.reply);
                guard.queue.addToQueue(clipSong(entry, ctx.member), 1);
                return ctx.reply(`🔊 Queued \`${entry.name}\` as the next song.`);
            }

            await ctx.distube.play(voiceChannel, clipSong(entry, ctx.member), {
                member: ctx.member,
                textChannel: ctx.channel,
                message: ctx.message ?? undefined,
            });
            return ctx.reply(`🔊 Playing \`${entry.name}\` in **${voiceChannel.name}**.`);
        }

        if (sub === 'list') {
            const clips = board.list();
            if (!clips.length) {
                return ctx.reply(`The board is empty — \`${ctx.config.prefix}sfx add <name>\` plus an attached mp3/ogg adds a clip.`);
            }
            const rows = clips.map(c => `• \`${c.name}\` (${(c.sizeBytes / 1024).toFixed(0)} KB)`);
            return ctx.reply(`🔊 Soundboard (${clips.length}):\n${rows.join('\n')}`);
        }

        if (sub === 'add') {
            const blocked = djReply(ctx.guild, ctx.member, null);
            if (blocked) return ctx.reply(blocked);
            if (!arg) return ctx.reply('Name it: `sfx add horn` with the audio file attached.');
            const attachment =
                (ctx.message ?? ctx.interaction?.message)?.attachments?.first?.() ?? null;
            if (!attachment) return ctx.reply('Attach the audio file to the message (mp3, ogg, wav, m4a, aac, opus, flac).');

            let buffer;
            try {
                buffer = Buffer.from(await (await fetch(attachment.url)).arrayBuffer());
            } catch (err) {
                return ctx.reply(`❌ Could not download the attachment: ${err.message}`);
            }
            const ext = `.${String(attachment.name ?? '').split('.').pop() ?? attachment.contentType?.split('/').pop() ?? ''}`.toLowerCase();
            const result = board.save(arg, buffer, { extension: ext });
            if (!result.ok) return ctx.reply(`❌ ${result.error}`);
            return ctx.reply(`🔊 Saved \`${result.name}\` (${(buffer.length / 1024).toFixed(0)} KB) — play it with \`${ctx.config.prefix}sfx ${result.name}\`.`);
        }

        if (sub === 'del' || sub === 'delete' || sub === 'remove') {
            const blocked = djReply(ctx.guild, ctx.member, null);
            if (blocked) return ctx.reply(blocked);
            const result = board.remove(arg);
            return ctx.reply(result.ok ? `🗑️ Deleted \`${result.deleted}\`.` : `❌ ${result.error}`);
        }

        return ctx.reply(`❌ Unknown sfx action \`${clip(sub, 20)}\` — try \`sfx list\`.`);
    },
};
