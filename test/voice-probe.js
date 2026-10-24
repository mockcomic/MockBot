/**
 * Standalone Discord *voice* probe — for the VOICE_CONNECT_FAILED path only.
 *
 *   node test/voice-probe.js [guildId]
 *
 * Joins the first joinable voice channel (optionally of one guild), logs the
 * @discordjs/voice dependency report, every connection state transition with
 * its reason, and the voice endpoint's DNS answer. Prints PASS and exits 0
 * when the connection reaches Ready; otherwise FAIL and exit 1.
 *
 * Why it exists: DisTube's "VOICE_CONNECT_FAILED after 30 seconds" is just
 * "never reached Ready" (node_modules/distube joins entersState on a fixed
 * timeout) — the state trail names the actual boundary:
 *   stuck in `signalling`  → no VOICE_SERVER_UPDATE: the bot lacks Connect on
 *                            that channel, or the voice WebSocket itself fails
 *   `connecting` → `disconnected` (closeCode 4014/4015) → Discord rejected the
 *                            session (permissions/region/server issue)
 *   `connecting` for a long time, then Ready → UDP is blocked and the library
 *                            fell back to TCP: fine, but expect higher latency
 *   never Ready, then Destroyed → UDP *and* TCP fallback both failed: outbound
 *                            UDP/DNS/firewall on this machine is the suspect
 *
 * Runs alone — no DisTube, no audio, no message content intent; the bot leaves
 * the channel as soon as the probe finishes. Uses a second gateway session on
 * the same token, so a running bot may briefly reconnect around it.
 */
require('dotenv').config();

const assert = require('node:assert');
const dns = require('node:dns').promises;
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const voice = require('@discordjs/voice');

const READY_TIMEOUT_MS = 25_000;
const DISCONNECT_REASONS = {
    [voice.VoiceConnectionDisconnectReason.WebSocketClose]: 'WebSocketClose',
    [voice.VoiceConnectionDisconnectReason.AdapterUnavailable]: 'AdapterUnavailable',
    [voice.VoiceConnectionDisconnectReason.EndpointRemoved]: 'EndpointRemoved',
    [voice.VoiceConnectionDisconnectReason.Manual]: 'Manual',
};

function logState(oldState, newState) {
    const parts = [`${oldState.status} -> ${newState.status}`];
    if (newState.reason !== undefined) parts.push(`reason=${DISCONNECT_REASONS[newState.reason] ?? newState.reason}`);
    if (newState.closeCode !== undefined) parts.push(`closeCode=${newState.closeCode}`);
    console.log(`[voice-probe] ${parts.join(' ')}`);
    if (newState.endpoint) {
        dns.lookup(newState.endpoint, { all: true, verbatim: true })
            .then(rows => console.log(`[voice-probe] endpoint ${newState.endpoint} -> ${rows.map(r => `${r.family}:${r.address}`).join(', ') || 'NO ANSWER'}`))
            .catch(err => console.log(`[voice-probe] endpoint ${newState.endpoint} DNS failed: ${err.code ?? err.message}`));
    }
}

(async () => {
    assert.ok(process.env.TOKEN, 'TOKEN missing from .env');
    console.log(`[voice-probe] node ${process.version} on ${process.platform}/${process.arch}`);
    console.log(voice.generateDependencyReport());

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    let result = 'FAIL';
    let connection = null;
    try {
        await client.login(process.env.TOKEN);

        const wanted = process.argv[2];
        // GUILD_CREATE payloads land asynchronously after login(); reading the
        // cache straight away finds no channels and the probe blames itself
        // ("no joinable voice channel") when the bot is fine. Fetch first.
        await new Promise(resolve => setTimeout(resolve, 1500));
        const guilds = [...client.guilds.cache.values()];
        for (const g of guilds) await g.channels.fetch().catch(() => {});
        const guild = wanted ? client.guilds.cache.get(wanted) : guilds.find(g =>
            g.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.joinable),
        );
        assert.ok(guild, `guild ${wanted ?? 'with a joinable voice channel'} not found (is the bot invited?)`);
        const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.joinable);
        assert.ok(channel, 'no joinable voice channel — the bot needs Connect on one');
        console.log(`[voice-probe] probing #${channel.name} in ${guild.name}`);

        connection = voice.joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
        });
        connection.on('stateChange', logState);
        connection.on('error', err => console.log(`[voice-probe] connection error: ${err.stack ?? err}`));

        await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
        // Ping needs at least one keepalive round-trip to be meaningful.
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log(`[voice-probe] Ready after ${connection.ping ? `${Math.round(connection.ping)}ms ping` : 'no ping yet'}`);
        result = 'PASS';
    } catch (err) {
        console.log(`[voice-probe] did not reach Ready: ${err.message}`);
    } finally {
        connection?.destroy();
        await client.destroy();
    }
    console.log(`[voice-probe] ${result}`);
    process.exit(result === 'PASS' ? 0 : 1);
})();
