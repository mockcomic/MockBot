const { SlashCommandBuilder } = require('discord.js');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    createAudioResource,
    joinVoiceChannel,
    entersState,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
} = require('@discordjs/voice');

/**
 * TEMP voice diagnostics (added while chasing "joins VC but no audio").
 *
 *   !diag          snapshot of DisTube queue, VoiceConnection, AudioPlayer,
 *                  and the audio resource byte counters
 *   !diag watch    stream AudioPlayer/VoiceConnection state changes + counters
 *                  for 10s (proves whether packets are actually produced/sent)
 *   !diag test     bypass yt-dlp/ffmpeg entirely: play a locally generated
 *                  6s 440Hz ogg/opus tone through the same voice pipeline
 *
 * Remove this command once the no-audio bug is fixed.
 */

const TONE_FILE = path.join(__dirname, '..', 'data', 'diag-tone.ogg');

function fmt(obj) {
    return Object.entries(obj)
        .map(([k, v]) => `\`${k}\`: ${v}`)
        .join('\n');
}

/** Counters that only move if audio is actually flowing. */
function counters(queue) {
    const resource = queue?.voice?.stream?.audioResource;
    if (!resource) return { resource: 'none' };
    return {
        resource: 'present',
        bytesRead: resource.playbackStream?.bytesRead ?? 'n/a',
        transformedFrames: resource.volume?.transformedFrames ?? 'n/a',
        volume: resource.volume?.volume ?? 'n/a',
        streamEnded: Boolean(resource.playbackStream?.ended),
        streamDestroyed: Boolean(resource.playbackStream?.destroyed),
    };
}

function snapshot(ctx) {
    const queue = ctx.distube.getQueue(ctx.guild);
    const lines = [];
    if (!queue) {
        lines.push('distube queue: NONE (not playing through DisTube)');
        return lines.join('\n');
    }
    const conn = queue.voice?.connection;
    const player = queue.voice?.audioPlayer;
    const vc = ctx.guild.channels.cache.get(queue.voiceChannel?.id);
    lines.push(fmt({
        song: queue.songs[0]?.name ?? '?',
        playing: queue.playing,
        paused: queue.paused,
        volume: queue.volume,
        streamType: queue.songs[0]?.stream?.type ?? '?',
        connection: conn?.state?.status ?? 'none',
        player: player?.state?.status ?? 'none',
        vc: vc ? `#${vc.name} users=${(vc.members ?? new Map()).size}` : '?',
        ...counters(queue),
    }));
    return lines.join('\n');
}

module.exports = {
    name: 'diag',
    description: 'Voice diagnostics (temporary)',
    usage: 'diag [watch|test]',
    data: new SlashCommandBuilder()
        .setName('diag')
        .setDescription('Voice diagnostics (temporary)')
        .addStringOption(o => o.setName('mode').setDescription('deps | watch | test').setRequired(false)),

    async execute(ctx) {
        const mode = (ctx.option('mode') ?? ctx.args[0] ?? '').toLowerCase();
        console.log(`[diag] mode='${mode}'\n${snapshot(ctx)}`);

        if (mode === 'watch') {
            const queue = ctx.distube.getQueue(ctx.guild);
            if (!queue) return ctx.reply('❌ No active queue to watch.');
            const player = queue.voice.audioPlayer;
            const conn = queue.voice.connection;
            const events = [];
            const stamp = () => new Date().toISOString().slice(11, 23);
            const onPlayer = (oldS, newS) => {
                events.push(`${stamp()} player ${oldS.status} → ${newS.status} ${JSON.stringify(counters(queue))}`);
                console.log(`[diag.watch] ${events.at(-1)}`);
            };
            const onConn = (oldS, newS) => {
                events.push(`${stamp()} connection ${oldS.status} → ${newS.status} reason=${JSON.stringify(newS.reason ?? null)} closeCode=${newS.closeCode ?? '-'}`);
                console.log(`[diag.watch] ${events.at(-1)}`);
            };
            player.on('stateChange', onPlayer);
            conn.on('stateChange', onConn);
            await new Promise(r => setTimeout(r, 10_000));
            player.off('stateChange', onPlayer);
            conn.off('stateChange', onConn);
            const body = [
                `After 10s watch:\n${fmt(counters(queue))}`,
                events.length ? `Events:\n${events.slice(-20).join('\n')}` : 'No state changes in 10s.',
            ].join('\n\n');
            console.log(`[diag.watch] done ${JSON.stringify(counters(queue))}`);
            return ctx.reply(`\`\`\`${body.slice(0, 1800)}\`\`\``);
        }

        if (mode === 'deps') {
            // Remote version of `node test/voice-probe.js`'s static half: the
            // library table voice actually chose (DAVE, opus, encryption) plus
            // whether the DAVE native addon itself loads. A missing/broken
            // davey binary = ws close 4017 = "cannot connect after 30 seconds".
            const lines = [];
            try {
                lines.push(require('@discordjs/voice').generateDependencyReport());
            } catch (err) {
                lines.push(`dependency report failed: ${err.message}`);
            }
            try {
                require('@snazzah/davey');
                lines.push('davey require(): OK');
            } catch (err) {
                lines.push(`davey require() FAILED: ${err.message.split('\n')[0]}`);
            }
            try {
                lines.push(`node ${process.version} on ${process.platform}/${process.arch}`);
            } catch { /* cosmetic */ }
            const body = lines.join('\n');
            return ctx.reply(`\`\`\`${body.slice(0, 1800)}${body.length > 1800 ? '\n…' : ''}\`\`\``);
        }

        if (mode === 'test') {
            // Generate a plain 440Hz tone (nothing yt-dlp-related). Prefer the
            // system ffmpeg — the bundled static build SIGSEGVs on network input.
            const ffmpeg = (() => { try { require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { try { return require('ffmpeg-static'); } catch { return null; } } })();
            if (!ffmpeg) return ctx.reply('❌ No usable ffmpeg found.');
            const ok = await new Promise(resolve => {
                const child = spawn(ffmpeg, [
                    '-y', '-hide_banner', '-loglevel', 'error',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
                    '-c:a', 'libopus', '-f', 'ogg', TONE_FILE,
                ]);
                child.on('error', () => resolve(false));
                child.on('close', code => resolve(code === 0));
            });
            if (!ok) return ctx.reply('❌ Could not generate test tone (ffmpeg failed).');

            const vch = ctx.member?.voice?.channel;
            if (!vch) return ctx.reply('Join a voice channel first.');
            const conn = joinVoiceChannel({
                channelId: vch.id,
                guildId: ctx.guild.id,
                adapterCreator: ctx.guild.voiceAdapterCreator,
                selfDeaf: false,
            });
            await entersState(conn, VoiceConnectionStatus.Ready, 20_000);

            const { createAudioPlayer } = require('@discordjs/voice');
            const player = createAudioPlayer();
            conn.subscribe(player);
            const resource = createAudioResource(fs.createReadStream(TONE_FILE), {
                inputType: StreamType.OggOpus,
                inlineVolume: true,
            });
            player.play(resource);
            await entersState(player, AudioPlayerStatus.Playing, 10_000);
            await entersState(player, AudioPlayerStatus.Idle, 20_000).catch(() => {});
            conn.destroy();
            return ctx.reply(`✅ Test tone finished (bytesRead=${resource.playbackStream?.bytesRead ?? '?'}). Did you hear a 6s beep?`);
        }

        return ctx.reply(`\`\`\`${snapshot(ctx)}\`\`\``);
    },
};
