const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const watch = require('../lib/liveWatch');
const { clip } = require('../lib/respond');

/**
 * Live-stream announcements (lib/liveWatch.js).
 *
 *   watch list                     - what this server follows
 *   watch add <name|handle|chid>   - follow a streamer (announce to this channel
 *                                    or #channel; twitch needs the client env,
 *                                    youtube needs GOOGLE_API_KEY)
 *   watch remove <name>            - stop following
 *
 * Twitch: bare login name (`pokimane`) or `twitch.tv/pokimane`.
 * YouTube: a `channel/UC…` URL or the raw `UC…` id. @handles are refused with
 * instructions to find the UC id (the channel's About page "Creator URL"),
 * which keeps the poller to a single channels.list call per round.
 */

function parseInput(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    if (!text) return null;
    const tw = text.match(/(?:^|\/)twitch\.tv\/([a-z0-9_]{2,25})$/);
    if (tw) return { platform: 'twitch', channel: tw[1] };
    const yt = text.match(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(channel\/UC[a-z0-9_-]{10,}|@[a-z0-9_.-]{1,40})$/i);
    if (yt) {
        const seg = yt[1];
        return seg.startsWith('channel/')
            ? { platform: 'youtube', channel: seg.slice(8) }
            : { platform: 'youtube', channel: seg.slice(1), handle: true };
    }
    if (/^uc[a-z0-9_-]{10,}$/.test(text)) return { platform: 'youtube', channel: text };
    if (/^[a-z0-9_]{2,25}$/.test(text)) return { platform: 'twitch', channel: text };
    if (/^@?[a-z0-9_.-]{1,40}$/.test(text)) return { platform: 'youtube', channel: text.replace(/^@/, ''), handle: true };
    return null;
}

module.exports = {
    name: 'watch',
    aliases: ['follow', 'livenotify'],
    description: 'Get told when a Twitch or YouTube channel goes live',
    usage: 'watch <list|add <channel>|remove <channel>> [#announce-channel]',
    category: 'staff',
    adminOnly: PermissionFlagsBits.ManageGuild,
    data: new SlashCommandBuilder()
        .setName('watch')
        .setDescription('Follow a streamer for live notifications')
        .addSubcommand(sub => sub
            .setName('list').setDescription('Streamers this server follows'))
        .addSubcommand(sub => sub
            .setName('add').setDescription('Follow a channel')
            .addStringOption(o => o
                .setName('channel').setDescription('Twitch login, YouTube @handle, UC… id or URL').setRequired(true).setMaxLength(60))
            .addChannelOption(o => o
                .setName('announce_in').setDescription('Channel to announce in (default: here)')
                .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(sub => sub
            .setName('remove').setDescription('Stop following a channel')
            .addStringOption(o => o.setName('channel').setDescription('What to unfollow').setRequired(true).setMaxLength(60))),

    async execute(ctx) {
        const sub = ctx.isSlash
            ? ctx.interaction.options.getSubcommand()
            : String(ctx.args[0] ?? 'list').toLowerCase();

        if (sub === 'list') {
            const rows = watch.listFor(ctx.guild.id);
            if (!rows.length) return ctx.reply(`No streamers followed here yet — \`${ctx.config.prefix}watch add <channel>\`.`);
            return ctx.reply(
                `🔴 Live notifications:\n` +
                rows.map(w => `• ${w.platform}: \`${w.channel}\` → <#${w.channelId}>`).join('\n'),
            );
        }

        if (sub === 'add') {
            const raw = String(ctx.option('channel') ?? ctx.args[1] ?? '');
            const parsed = parseInput(raw);
            if (!parsed) {
                return ctx.reply('Give me a Twitch login, a YouTube @handle, a UC… channel id, or a full URL.');
            }
            if (parsed.platform === 'twitch' && !(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET)) {
                return ctx.reply('❌ Twitch needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET set on the bot.');
            }
            if (parsed.platform === 'youtube' && !process.env.GOOGLE_API_KEY) {
                return ctx.reply('❌ YouTube notifications need GOOGLE_API_KEY set on the bot (free Data API v3 key).');
            }
            if (parsed.handle) {
                return ctx.reply(
                    'YouTube @handles need a UC… channel id. Open the channel → About → "Creator URL" and paste the `channel/UC…` link here instead.',
                );
            }

            const channel = ctx.option('announce_in') ?? ctx.channel;
            const result = watch.add({
                platform: parsed.platform,
                channel: parsed.channel,
                guildId: ctx.guild.id,
                channelId: channel.id,
                addedBy: ctx.user.id,
            });
            if (!result.ok) return ctx.reply(`❌ ${result.error}`);
            return ctx.reply(
                `🔴 Following ${parsed.platform} \`${clip(parsed.channel, 40)}\` — I will announce in ${channel} within a minute of them going live.` +
                (result.replaced ? ' (updated the existing entry)' : ''),
            );
        }

        if (sub === 'remove' || sub === 'rm') {
            const parsed = parseInput(String(ctx.option('channel') ?? ctx.args[1] ?? ''));
            if (!parsed) return ctx.reply('What should I unfollow? Same formats as `watch add`.');
            const removed = watch.remove({ platform: parsed.platform, channel: parsed.channel, guildId: ctx.guild.id });
            return ctx.reply(removed
                ? `🔕 Unfollowed \`${clip(parsed.channel, 40)}\`.`
                : `You were not following \`${clip(parsed.channel, 40)}\` here.`);
        }

        return ctx.reply('Usage: `watch <list|add <channel>|remove <channel>> [#channel]`');
    },
};
