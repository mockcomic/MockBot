/**
 * Offline smoke test: loads every module the bot uses and exercises the
 * parts that don't need Discord (registry, slash builders, context logic).
 * Run: node test/smoke.js
 */
const assert = require('node:assert');

process.env.TOKEN = process.env.TOKEN || 'smoke-test-token';

let failures = 0;
const check = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(` FAIL ${name}: ${err.message}`);
    }
};

(async () => {

console.log('Loading modules…');
const { loadCommands } = require('../commands_Handler');
const Context = require('../lib/Context');
const music = require('../lib/music');
const setupMusicEvents = require('../Event_listeners/musicBot');
const setupReactionRoles = require('../Event_listeners/reactionRoles');
const { DisTube } = require('distube');

await check('loadCommands registry', () => {
    const { commands, get } = loadCommands();
    assert.ok(commands.size >= 19, `expected >=19 commands, got ${commands.size}`);
    assert.ok(get('play')?.name === 'play', 'play resolvable');
    assert.ok(get('next')?.name === 'skip', 'alias next -> skip');
    assert.ok(get('loop')?.name === 'repeat', 'alias loop -> repeat');
    assert.ok(get('p')?.name === 'play', 'alias p -> play');
});

await check('slash builders serialize', () => {
    const { commands } = loadCommands();
    const names = new Set();
    for (const cmd of commands.values()) {
        if (!cmd.data) continue;
        const json = cmd.data.toJSON();
        assert.match(json.name, /^[a-z0-9_-]{1,32}$/, `invalid slash name ${json.name}`);
        assert.ok(!names.has(json.name), `duplicate slash name ${json.name}`);
        names.add(json.name);
    }
    assert.ok(names.size >= 19, `expected >=19 slash commands, got ${names.size}`);
    console.log(`        slash commands: ${[...names].join(', ')}`);
});

await check('DisTube v5 instantiates with YtDlpPlugin', () => {
    const { Client, GatewayIntentBits } = require('discord.js');
    const { YtDlpPlugin } = require('@distube/yt-dlp');
    const fakeClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const distube = new DisTube(fakeClient, { plugins: [new YtDlpPlugin()] });
    assert.ok(distube.plugins.length === 1);
    fakeClient.destroy();
});

await check('music events register on a DisTube instance', () => {
    const { Client, GatewayIntentBits } = require('discord.js');
    const { YtDlpPlugin } = require('@distube/yt-dlp');
    const fakeClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const distube = new DisTube(fakeClient, { plugins: [new YtDlpPlugin()] });
    setupMusicEvents(distube);
    assert.ok(distube.listenerCount('playSong') === 1);
    assert.ok(distube.listenerCount('error') === 1);
    fakeClient.destroy();
});

await check('reaction roles setup does not throw', () => {
    const { EventEmitter } = require('node:events');
    const fakeClient = new EventEmitter();
    setupReactionRoles(fakeClient, require('../config.json'));
    assert.ok(fakeClient.listenerCount('messageReactionAdd') === 1);
});

await check('Context prefix vs slash paths', () => {
    const prefixCtx = new Context({
        client: {}, distube: {}, config: { prefix: '!' }, commands: new Map(),
        message: { author: { id: '1' }, guild: { id: 'g' }, channel: {}, member: {}, reply: async c => ({ type: 'msg-reply', c }) },
        args: ['a', 'b'],
    });
    assert.ok(!prefixCtx.isSlash);
    assert.strictEqual(prefixCtx.user.id, '1');

    let replied = 0;
    const interaction = {
        user: { id: '2' }, guild: { id: 'g' }, channel: {}, member: {},
        deferred: false, replied: false,
        reply: async () => ({ createdTimestamp: Date.now() }),
        editReply: async () => ({ createdTimestamp: Date.now() }),
        followUp: async () => ({ createdTimestamp: Date.now() }),
    };
    const slashCtx = new Context({
        client: {}, distube: {}, config: { prefix: '!' }, commands: new Map(),
        interaction, args: ['x'],
    });
    assert.ok(slashCtx.isSlash);
    assert.strictEqual(slashCtx.user.id, '2');
});

await check('Context slash multi-reply uses followUp', async () => {
    const calls = [];
    const interaction = {
        user: { id: '2' }, guild: {}, channel: {}, member: {},
        deferred: true, replied: false,
        reply: async c => calls.push(['reply', c]),
        editReply: async c => calls.push(['editReply', c]),
        followUp: async c => calls.push(['followUp', c]),
    };
    const ctx = new Context({ client: {}, distube: {}, config: {}, commands: new Map(), interaction });
    await ctx.reply('one');
    await ctx.reply('two');
    assert.strictEqual(calls[0][0], 'editReply');
    assert.strictEqual(calls[1][0], 'followUp');
});

await check('music.play helper exported', () => {
    assert.strictEqual(typeof music.play, 'function');
});

    console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
})();
