/**
 * Offline smoke test: loads every module the bot uses and exercises the parts
 * that don't need Discord (registry, slash builders, context logic, queue
 * maths, the data directory).
 *
 * Run: npm test   (or: node test/smoke.js)
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOKEN = process.env.TOKEN || 'smoke-test-token';
process.env.OWNER = process.env.OWNER || 'owner-id';

// Point the runtime data directory at a scratch folder before lib/ loads, so
// the test never writes into the repository.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mockbot-data-'));
process.env.MOCKBOT_DATA_DIR = DATA_DIR;

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

const flush = async (times = 3) => {
    for (let i = 0; i < times; i += 1) await new Promise(resolve => setImmediate(resolve));
};

const fakeSong = (name, duration = 60) => ({
    name,
    url: `https://example.invalid/${encodeURIComponent(name)}`,
    duration,
    formattedDuration: `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`,
});

/** Minimal shape the queue helpers touch. */
const fakeQueue = (names, overrides = {}) => ({
    songs: names.map(fakeSong),
    previousSongs: [],
    volume: 80,
    repeatMode: 0,
    autoplay: false,
    filters: { names: [] },
    get duration() {
        return this.songs.reduce((sum, s) => sum + s.duration, 0);
    },
    ...overrides,
});

(async () => {

console.log('Loading modules…');
const { loadCommands } = require('../commands_Handler');
const Context = require('../lib/Context');
const music = require('../lib/music');
const setupMusicEvents = require('../Event_listeners/musicBot');
const setupReactionRoles = require('../Event_listeners/reactionRoles');
const setupVoiceIdle = require('../Event_listeners/voiceIdle');
const guards = require('../lib/musicGuards');
const format = require('../lib/musicFormat');
const respond = require('../lib/respond');
const access = require('../lib/access');
const store = require('../lib/reactionRolesStore');
const feedbackStore = require('../lib/feedbackStore');
const { DisTube } = require('distube');
const { PermissionFlagsBits } = require('discord.js');

await check('loadCommands registry', () => {
    const { commands, get } = loadCommands();
    assert.ok(commands.size >= 35, `expected >=35 commands, got ${commands.size}`);
    assert.ok(get('play')?.name === 'play', 'play resolvable');
    assert.ok(get('next')?.name === 'skip', 'alias next -> skip');
    assert.ok(get('loop')?.name === 'repeat', 'alias loop -> repeat');
    assert.ok(get('p')?.name === 'play', 'alias p -> play');
    assert.ok(get('np')?.name === 'nowplaying', 'alias np -> nowplaying');
    assert.ok(get('prev')?.name === 'previous', 'alias prev -> previous');
    assert.ok(get('rm')?.name === 'remove', 'alias rm -> remove');
    // v3.2 aliases
    assert.ok(get('stay')?.name === '247', 'alias stay -> 247');
    assert.ok(get('mute')?.name === 'timeout', 'alias mute -> timeout');
    assert.ok(get('auto')?.name === 'autoplay', 'alias auto -> autoplay');
    assert.ok(get('lists')?.name === 'playlist', 'alias lists -> playlist');
    assert.ok(get('reminders')?.name === 'remind', 'alias reminders -> remind');
    assert.ok(get('dc')?.name === 'leave', 'alias dc -> leave');
    for (const name of [
        'nowplaying', 'shuffle', 'previous', 'remove', 'clear', 'seek',
        'playlist', 'lyrics', 'autoplay', '247', 'leave', 'voteskip',
        'remind', 'poll', 'stats', 'timeout', 'modlog', 'prefix',
    ]) {
        assert.ok(commands.get(name)?.data, `${name} should be registered as a slash command too`);
    }
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
        // Discord rejects anything over 25 choices on one option.
        for (const option of json.options ?? []) {
            if (option.choices) assert.ok(option.choices.length <= 25, `${json.name} has ${option.choices.length} choices`);
        }
    }
    assert.ok(names.size >= 35, `expected >=35 slash commands, got ${names.size}`);
    console.log(`        slash commands: ${[...names].join(', ')}`);
});

// --- P0: jump numbering -----------------------------------------------------

await check('resolveJumpTarget matches the numbering `queue` prints', () => {
    // 5 rows: 1 = playing, 2..5 queued.
    const q = 5;
    assert.deepStrictEqual(guards.resolveJumpTarget(2, q, 2), { ok: true, position: 2, apiPosition: 1 });
    assert.deepStrictEqual(guards.resolveJumpTarget(5, q, 2), { ok: true, position: 5, apiPosition: 4 });
    assert.ok(!guards.resolveJumpTarget(1, q, 2).ok, 'position 1 is already playing');
    assert.ok(!guards.resolveJumpTarget(6, q, 2).ok, 'past the end is refused');
    assert.ok(!guards.resolveJumpTarget(0, q, 2).ok);
    assert.ok(!guards.resolveJumpTarget(-3, q, 2).ok, 'history only goes back 2');
    assert.deepStrictEqual(guards.resolveJumpTarget(-1, q, 2), { ok: true, position: -1, apiPosition: -1 });
});

await check('resolveJumpTarget explains an out-of-range position', () => {
    const bad = guards.resolveJumpTarget(9, 3, 0);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /no song at that position/i);
    const noHistory = guards.resolveJumpTarget(-1, 3, 0);
    assert.equal(noHistory.ok, false);
    assert.match(noHistory.error, /history/i);
});

// --- P1: reply safety -------------------------------------------------------

await check('respond.clip never exceeds the limit and prefers line breaks', () => {
    const text = 'a'.repeat(5000);
    assert.ok(respond.clip(text, 2000).length <= 2000, 'plain clip fits');

    // A newline in the tail of the window is honoured: the long second record
    // is dropped whole rather than cut mid-run.
    const cut = respond.clip(`${'a'.repeat(15)}\n${'b'.repeat(3000)}`, 24);
    assert.equal(cut, `${'a'.repeat(15)}…`);

    // With no nearby newline there is nothing to break on, so it cuts and marks it.
    const rough = respond.clip('z'.repeat(100), 10);
    assert.equal(rough.length, 10);
    assert.ok(rough.endsWith('…'), 'signals the cut');
});

await check('respond.fenced cannot be escaped or overflow', () => {
    const evil = 'output\n```text\n@everyone\n' + '`'.repeat(10);
    const out = respond.fenced(evil, { title: 'log' });
    assert.ok(out.length <= respond.MAX_MESSAGE_LENGTH, `fenced output too long (${out.length})`);
    const fences = out.match(/```/g) ?? [];
    assert.equal(fences.length, 2, `only the wrapper fences should survive, saw ${fences.length}`);
    assert.ok(out.startsWith('```') && out.endsWith('```'));
});

await check('respond.chunkLines splits on newlines, never mid-entry', () => {
    const entries = Array.from({ length: 40 }, (_, i) => `entry ${i} ${'y'.repeat(60)}`);
    const chunks = respond.chunkLines(entries.join('\n'), 200);
    assert.ok(chunks.length > 1, 'expected several chunks');
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 200, `chunk too long (${chunk.length})`);
        for (const line of chunk.split('\n')) assert.match(line, /^entry \d+ /, 'a line was split mid-entry');
    }
    assert.equal(chunks.join('\n'), entries.join('\n'), 'no content lost or reordered');
    assert.ok(respond.chunkLines('').length === 1, 'empty input still yields one chunk');
});

// --- P2: queue pagination ---------------------------------------------------

await check('queuePage numbers rows the way jump reads them', () => {
    const q = fakeQueue(Array.from({ length: 23 }, (_, i) => `song ${i + 1}`));
    const rowsOf = result => result.description.split('\n\n')[0].split('\n');

    const first = format.queuePage(q, 1);
    assert.equal(first.page, 1);
    assert.equal(first.pages, 3);
    const rows = rowsOf(first);
    assert.equal(rows.length, 10, 'a page holds 10 rows');
    assert.ok(rows[0].includes('1.'), 'row numbering starts at 1');
    assert.ok(rows[0].includes('▶'), 'the playing song is marked');
    assert.ok(!rows[1].includes('▶'), 'only row 1 is marked');
    assert.match(first.description, /Page \*\*1\/3\*\*/, 'the page note is separate from the rows');

    // Page clamping, and page 3 holds the 3 leftovers.
    assert.equal(format.queuePage(q, 99).page, 3);
    assert.equal(format.queuePage(q, 0).page, 1);
    assert.equal(format.queuePage(q, NaN).page, 1);
    assert.equal(rowsOf(format.queuePage(q, 3)).length, 3);
    assert.equal(rowsOf(format.queuePage(q, 2))[0].includes('11.'), true, 'page 2 continues the numbering');
    assert.match(format.queuePage(q, 2).footerText, /23 songs/);
});

// --- P0: feedback storage ---------------------------------------------------

await check('feedbackStore writes into data/ and migrates the legacy log', async () => {
    assert.equal(feedbackStore.DATA_DIR, DATA_DIR, 'honours MOCKBOT_DATA_DIR');

    // Simulate an upgraded install: a legacy log at the repo root. Keep whatever
    // was there so running the test never costs anyone data.
    const backup = fs.existsSync(feedbackStore.LEGACY_FILE)
        ? fs.readFileSync(feedbackStore.LEGACY_FILE, 'utf8')
        : null;

    fs.writeFileSync(feedbackStore.LEGACY_FILE, '2020-01-01T00:00:00.000Z old: kept\n', 'utf8');
    await feedbackStore.append('new entry');
    await feedbackStore.append('second entry');

    const content = await feedbackStore.readAll();
    assert.match(content, /old: kept/, 'legacy feedback survived');
    assert.match(content, /new entry/);
    assert.ok(!fs.existsSync(feedbackStore.LEGACY_FILE), 'legacy file moved, not copied');
    // The backend depends on whether better-sqlite3 loaded; either way the log
    // survives and the legacy import happens exactly once.
    if (feedbackStore.BACKEND === 'sqlite') {
        assert.ok(fs.existsSync(path.join(DATA_DIR, 'feedback.sqlite')), 'sqlite database created');
        assert.ok(fs.existsSync(path.join(DATA_DIR, 'feedback.txt.imported')), 'text log imported and retired');
    } else {
        assert.ok(fs.existsSync(path.join(DATA_DIR, 'feedback.txt')));
    }

    // Appending again must not try to migrate a second time.
    await feedbackStore.append('third entry');
    assert.match(await feedbackStore.readAll(), /third entry/);

    if (backup === null) fs.rmSync(feedbackStore.LEGACY_FILE, { force: true });
    else fs.writeFileSync(feedbackStore.LEGACY_FILE, backup, 'utf8');
});

// --- P0: reaction roles only honour our own menus ---------------------------

await check('reaction roles ignore unmanaged messages', async () => {
    const { EventEmitter } = require('node:events');
    const client = new EventEmitter();
    const testConfig = {
        reactionRoles: {
            enabled: true,
            channelId: 'chan-1',
            roles: [{ name: 'Test Role', emoji: '1️⃣', roleId: 'role-1' }],
        },
    };
    setupReactionRoles(client, testConfig);

    const added = [];
    const member = { user: { id: 'u1', bot: false }, roles: { add: async r => added.push(r.id), remove: async () => {} } };
    const guild = {
        id: 'g1',
        name: 'Test Guild',
        roles: { cache: new Map([['role-1', { id: 'role-1', name: 'Test Role', position: 5 }]]) },
        members: { me: { roles: { highest: { position: 99 } } }, cache: new Map([['u1', member]]), fetch: async () => member },
    };
    const reactionFor = messageId => ({
        partial: false,
        emoji: { name: '1️⃣', id: null },
        message: { id: messageId, partial: false, guild, channel: { id: 'chan-1' } },
        fetch: async () => reactionFor(messageId),
    });

    // Same channel, same emoji, but this message was never posted by us.
    client.emit('messageReactionAdd', reactionFor('stranger-message'), { id: 'u1', bot: false });
    await flush();
    assert.deepEqual(added, [], 'a reaction to an unrelated message must not grant a role');

    // Now register the menu and react again.
    store.record('our-menu');
    client.emit('messageReactionAdd', reactionFor('our-menu'), { id: 'u1', bot: false });
    await flush();
    assert.deepEqual(added, ['role-1'], 'a reaction to our menu grants the role');
});

await check('reaction roles refuse roles the bot cannot manage', async () => {
    const { EventEmitter } = require('node:events');
    const client = new EventEmitter();
    setupReactionRoles(client, {
        reactionRoles: { enabled: true, channelId: 'chan-2', roles: [{ name: 'High', emoji: '2️⃣', roleId: 'role-hi' }] },
    });
    store.record('menu-2');

    let touched = false;
    const member = { user: { id: 'u2', bot: false }, roles: { add: async () => { touched = true; }, remove: async () => {} } };
    const guild = {
        id: 'g2',
        name: 'Test Guild',
        roles: { cache: new Map([['role-hi', { id: 'role-hi', name: 'High', position: 50 }]]) },
        // The bot's highest role sits below the managed role.
        members: { me: { roles: { highest: { position: 10 } } }, cache: new Map([['u2', member]]), fetch: async () => member },
    };
    client.emit('messageReactionAdd', {
        partial: false,
        emoji: { name: '2️⃣', id: null },
        message: { id: 'menu-2', partial: false, guild, channel: { id: 'chan-2' } },
    }, { id: 'u2', bot: false });
    await flush();
    assert.equal(touched, false, 'role hierarchy must be respected');
});

// --- P1: queue guards -------------------------------------------------------

await check('requireQueue demands a queue and the same voice channel', async () => {
    const base = user => ({
        user: { id: user },
        member: { voice: { channelId: 'vc-1' } },
        guild: { id: 'g', channels: { cache: new Map([['vc-1', { id: 'vc-1', name: 'Gaming' }]]) } },
        distube: { getQueue: () => fakeQueue(['a', 'b'], { voiceChannel: { id: 'vc-2', name: 'Music' }, }) },
    });

    const none = await guards.requireQueue({
        ...base('owner-id'),
        distube: { getQueue: () => null },
    });
    assert.equal(none.reply, guards.NOT_PLAYING);

    // Owner is exempt from the voice check even from another channel.
    const owner = await guards.requireQueue(base('owner-id'));
    assert.ok(owner.queue, 'owner passes without being in the bot channel');

    // A regular member in a different channel gets a named refusal.
    const outsider = await guards.requireQueue(base('member-id'));
    assert.match(outsider.reply, /Music/, 'the refusal names the channel to join');

    const insider = await guards.requireQueue({
        ...base('member-id'),
        distube: { getQueue: () => fakeQueue(['a', 'b'], { voiceChannel: { id: 'vc-1', name: 'Gaming' } }) },
    });
    assert.ok(insider.queue, 'same channel passes');
});

await check('parseTime accepts seconds and mm:ss', () => {
    assert.equal(guards.parseTime('90'), 90);
    assert.equal(guards.parseTime('1:30'), 90);
    assert.equal(guards.parseTime('01:02:03'), 3723);
    assert.equal(guards.parseTime('70:00'), 4200);
    assert.equal(guards.parseTime('1234'), 1234, 'a bare 4-digit value is seconds');
    assert.equal(guards.parseTime(' 45 '), 45, 'surrounding spaces are fine');
    for (const bad of ['', 'abc', '1:', ':30', '-5', '1:2:3:4', '1:999']) {
        assert.equal(guards.parseTime(bad), null, `${bad} should be rejected`);
    }
});

await check('canRun enforces ownerOnly and adminOnly bits', async () => {
    const ctxFor = (id, permissions) => ({
        user: { id },
        guild: { id: 'g', members: { cache: new Map(), fetch: async () => ({ permissions }) } },
        member: { permissions },
    });
    const allows = bit => ({ has: b => b === bit });

    assert.ok((await access.canRun({ ownerOnly: true }, ctxFor('owner-id', allows(0n)))).ok, 'owner runs owner-only');
    const denied = await access.canRun({ ownerOnly: true }, ctxFor('someone', allows(0n)));
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /owner only/i);

    const admin = { adminOnly: PermissionFlagsBits.ManageRoles };
    assert.ok((await access.canRun(admin, ctxFor('someone', allows(PermissionFlagsBits.ManageRoles)))).ok);
    const notAdmin = await access.canRun(admin, ctxFor('someone', allows(PermissionFlagsBits.SendMessages)));
    assert.equal(notAdmin.ok, false);
    assert.match(notAdmin.reason, /Manage Roles/i, 'the refusal names the permission');
});

// --- P2: idle disconnect ----------------------------------------------------

await check('voiceIdle arms one timer and cancels it when someone returns', () => {
    const { EventEmitter } = require('node:events');
    const client = new EventEmitter();
    const queue = {
        id: 'g-idle',
        textChannel: { send: async () => {} },
        stop: async () => {},
        voiceChannel: { id: 'vc', name: 'Music', members: { values: () => [{ user: { bot: true } }] } },
    };
    const registered = [];
    const distube = { getQueue: () => queue, on: name => registered.push(name) };
    const idle = setupVoiceIdle(client, { distube, config: { music: { leaveOnEmptyAfterSeconds: 5 } } });

    // DisTube caps every event at one listener, and musicBot.js already owns
    // `disconnect`; claiming it here would warn on boot and mask real leaks.
    assert.deepEqual(registered, ['deleteQueue'], 'voiceIdle should only claim deleteQueue');

    const moved = { channelId: 'vc' };
    client.emit('voiceStateUpdate', moved, { guild: { id: 'g-idle' }, channelId: null });
    assert.equal(idle.timers.size, 1, 'empty channel arms one timer');

    client.emit('voiceStateUpdate', moved, { guild: { id: 'g-idle' }, channelId: 'vc' });
    queue.voiceChannel.members = { values: () => [{ user: { bot: true } }, { user: { bot: false } }] };
    client.emit('voiceStateUpdate', { channelId: 'other' }, { guild: { id: 'g-idle' }, channelId: 'vc' });
    assert.equal(idle.timers.size, 0, 'a returning listener cancels the timer');

    // A disabled setting registers nothing to clean up.
    const off = setupVoiceIdle(new EventEmitter(), { distube, config: { music: { leaveOnEmptyAfterSeconds: 0 } } });
    assert.ok(off.disabled, '0 disables the watcher');
    idle.disarm('g-idle');
});

// --- unchanged coverage from the previous suite -----------------------------

await check('DisTube v5 instantiates with YtDlpPlugin', () => {
    const { Client, GatewayIntentBits } = require('discord.js');
    const { YtDlpPlugin } = require('@distube/yt-dlp');
    const fakeClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const distube = new DisTube(fakeClient, { plugins: [new YtDlpPlugin()] });
    assert.ok(distube.plugins.length === 1);
    fakeClient.destroy();
});

await check('the patched yt-dlp plugin still exposes the plugin contract', () => {
    const { YtDlpPluginPatched, isPlaylistUrl } = require('../lib/YtDlpPluginPatched');
    const plugin = new YtDlpPluginPatched();
    assert.equal(typeof plugin.resolve, 'function');
    assert.equal(typeof plugin.getStreamURL, 'function');
    assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
    assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaaaaaaa&list=PL123'), false, 'a watch link is one video');
    assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=aaaaaaaa'), false);
});

await check('music events register on a DisTube instance', () => {
    const { Client, GatewayIntentBits } = require('discord.js');
    const { YtDlpPlugin } = require('@distube/yt-dlp');
    const fakeClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    const distube = new DisTube(fakeClient, { plugins: [new YtDlpPlugin()] });
    setupMusicEvents(distube);
    for (const event of ['playSong', 'addSong', 'addList', 'finish', 'noRelated', 'disconnect', 'error']) {
        assert.equal(distube.listenerCount(event), 1, `${event} should have exactly one listener`);
    }
    fakeClient.destroy();
});

await check('reaction roles setup does not throw', () => {
    const { EventEmitter } = require('node:events');
    const fakeClient = new EventEmitter();
    setupReactionRoles(fakeClient, require('../config.json'));
    assert.ok(fakeClient.listenerCount('messageReactionAdd') === 1);
});

await check('config.json has no dead keys', () => {
    const config = require('../config.json');
    assert.equal(typeof config.prefix, 'string');
    assert.ok(config.music.leaveOnEmptyAfterSeconds > 0);
    assert.equal(typeof config.music.voteSkipEnabled, 'boolean', 'the skip command reads this default');
    assert.equal(typeof config.music.autoplayByDefault, 'boolean', 'the finish handler reads this default');
    assert.ok(Number.isFinite(config.cooldowns.default) && config.cooldowns.default >= 0, 'runCommand reads this');
    assert.ok(Number.isFinite(config.cooldowns.play), 'play gets its own window');
    // The old emoji map was read nowhere.
    assert.equal(config.emoji, undefined, 'unused emoji map should stay deleted');
});

await check('Context prefix vs slash paths', async () => {
    const prefixCtx = new Context({
        client: {}, distube: {}, config: { prefix: '!' }, commands: new Map(),
        message: { author: { id: '1' }, guild: { id: 'g' }, channel: {}, member: {}, reply: async c => ({ type: 'msg-reply', c, createdTimestamp: 5 }) },
        args: ['a', 'b'],
    });
    assert.ok(!prefixCtx.isSlash);
    assert.strictEqual(prefixCtx.user.id, '1');

    // Ephemeral is interaction-only: a prefix reply must not carry the flag.
    const seen = await prefixCtx.reply('hi', { ephemeral: true });
    assert.deepEqual(seen, { type: 'msg-reply', c: 'hi', createdTimestamp: 5 });
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
    // With no flags attached, a plain string is sent as-is.
    assert.strictEqual(calls[0][1], 'one');
    assert.strictEqual(calls[1][1], 'two');
});

await check('Context.editReply reuses the message it sent', async () => {
    const edits = [];
    const ctx = new Context({
        client: {}, distube: {}, config: {}, commands: new Map(),
        message: {
            author: { id: '1' }, guild: {}, channel: {}, member: {},
            reply: async () => ({ createdTimestamp: 1, edit: async c => { edits.push(c); return 'edited'; } }),
        },
    });
    await ctx.reply('first');
    assert.equal(await ctx.editReply('second'), 'edited');
    assert.deepEqual(edits, ['second']);
});

await check('Context.option reads named slash options', () => {
    const ctx = new Context({
        client: {}, distube: {}, config: {}, commands: new Map(),
        interaction: { options: { get: name => (name === 'page' ? { value: 3 } : null) }, user: {}, guild: null },
    });
    assert.equal(ctx.option('page'), 3);
    assert.equal(ctx.option('missing'), undefined);
});

await check('music.play helper exported', () => {
    assert.strictEqual(typeof music.play, 'function');
});

// --- web portal ---------------------------------------------------------------

const { startPortal, DEFAULT_BIND } = require('../web/portal');
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const form = (user, pass) => new URLSearchParams({ user, pass });

/** First real (non-internal) IPv4 of this machine, or null on a bare dev box. */
const lanIp = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address ?? null;

await check('portal stays off without WEB_USER/WEB_PASS', async () => {
    assert.equal(await startPortal({ client: {}, distube: {}, env: {}, port: 0, log: quiet }), null,
        'missing env must not bind a port');
    assert.equal(await startPortal({ client: {}, distube: {}, env: { WEB_USER: 'a' }, port: 0, log: quiet }), null,
        'a user without a password is still disabled');
});

await check('portal faces the local network; WEB_BIND can lock it to localhost', async () => {
    assert.equal(DEFAULT_BIND, '0.0.0.0', 'default bind must expose the portal on the LAN');
    if (!lanIp) return; // nothing to probe without a LAN interface

    const open = await startPortal({
        client: {}, distube: {}, env: { WEB_USER: 'a', WEB_PASS: 'b' }, port: 0, log: quiet,
    });
    assert.ok(open, 'portal starts with credentials set');
    try {
        const r = await fetch(`http://${lanIp}:${open.port}/login`);
        assert.equal(r.status, 200, `reachable over the LAN address ${lanIp}`);
    } finally {
        open.close();
    }

    const locked = await startPortal({
        client: {}, distube: {}, env: { WEB_USER: 'a', WEB_PASS: 'b', WEB_BIND: '127.0.0.1' },
        port: 0, log: quiet,
    });
    assert.ok(locked, 'WEB_BIND=127.0.0.1 starts');
    try {
        assert.equal((await fetch(`http://127.0.0.1:${locked.port}/login`)).status, 200,
            'localhost still answers when locked down');
        let refused = false;
        try {
            await fetch(`http://${lanIp}:${locked.port}/login`, { signal: AbortSignal.timeout(3000) });
        } catch {
            refused = true;
        }
        assert.ok(refused, `WEB_BIND=127.0.0.1 refuses ${lanIp}`);
    } finally {
        locked.close();
    }
});

await check('portal login, dashboard, api, logout, throttling', async () => {
    const fakeClient = {
        user: { tag: 'MockBot#0001' },
        uptime: 90_000,
        ws: { ping: 42 },
        guilds: {
            cache: {
                size: 2,
                values: () => [{ id: 'g1', name: 'Test Guild' }, { id: 'g2', name: 'Quiet Guild' }],
            },
        },
    };
    const fakeDistube = {
        // Only g1 has a queue: 1 playing + 2 queued, volume 80, repeat off.
        getQueue: id => (id === 'g1' ? fakeQueue(['a', 'b', 'c']) : null),
    };
    const portal = await startPortal({
        client: fakeClient,
        distube: fakeDistube,
        commands: new Map([['play'], ['skip']]),
        env: { WEB_USER: 'admin', WEB_PASS: 'correct horse' },
        port: 0, // ephemeral; the test talks to it over 127.0.0.1
        log: quiet,
    });
    assert.ok(portal, 'portal starts when both credentials are set');
    const base = `http://127.0.0.1:${portal.port}`;

    try {
        const home = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(home.status, 302, 'the dashboard demands a login');
        assert.equal(home.headers.get('location'), '/login');

        const anon = await fetch(`${base}/api/status`);
        assert.equal(anon.status, 401);
        assert.ok(!(await anon.text()).includes('MockBot#0001'), 'no bot details leak before login');

        let r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'nope') });
        assert.equal(r.status, 401, 'wrong password is rejected');
        assert.ok(!r.headers.get('set-cookie'), 'a failed login grants no session');

        r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'correct horse'), redirect: 'manual' });
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/');
        const cookie = r.headers.get('set-cookie').split(';')[0];
        assert.match(cookie, /^mockbot_session=[0-9a-f]{64}$/, 'session is an opaque random cookie');
        const authed = { headers: { cookie } };

        r = await fetch(`${base}/`, authed);
        assert.equal(r.status, 200);
        assert.match(await r.text(), /MockBot/, 'dashboard renders for a session');

        r = await fetch(`${base}/api/status`, authed);
        assert.equal(r.status, 200);
        const status = await r.json();
        assert.equal(status.user.tag, 'MockBot#0001');
        assert.equal(status.user.uptimeSeconds, 90);
        assert.equal(status.user.wsPing, 42);
        assert.equal(status.guilds, 2);
        assert.equal(status.commands, 2);
        assert.equal(status.music.length, 1, 'only the guild with a queue appears');
        assert.equal(status.music[0].guild, 'Test Guild');
        assert.equal(status.music[0].playing.name, 'a');
        assert.equal(status.music[0].queued, 2);
        assert.equal(status.music[0].volume, 80);
        assert.equal(status.music[0].repeatMode, 'off');

        await feedbackStore.append('2020-01-01T00:00:00.000Z portal: visible in the log');
        r = await fetch(`${base}/api/feedback`, authed);
        assert.equal(r.status, 200);
        const fb = await r.json();
        assert.ok(fb.lines[0].includes('portal: visible in the log'), 'newest line first');

        r = await fetch(`${base}/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
        assert.equal(r.status, 302);
        assert.equal((await fetch(`${base}/api/status`, authed)).status, 401, 'logout killed the session');

        for (let i = 0; i < 10; i += 1) {
            r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'nope') });
            assert.equal(r.status, 401, `attempt ${i + 1} still answers on its merits`);
        }
        r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'correct horse') });
        assert.equal(r.status, 429, 'after ten misses even the right password waits');
    } finally {
        portal.close();
    }
});

// --- v3.2: duration grammar -----------------------------------------------------

const { parseHumanDuration, formatDurationMs } = require('../lib/duration');

await check('parseHumanDuration accepts unit combinations, nothing else', () => {
    assert.equal(parseHumanDuration('30m'), 30 * 60_000);
    assert.equal(parseHumanDuration('2h30m'), 2 * 3600_000 + 30 * 60_000);
    assert.equal(parseHumanDuration('3d'), 3 * 86400_000);
    assert.equal(parseHumanDuration('1w2d'), 9 * 86400_000);
    assert.equal(parseHumanDuration('45s'), 45_000);
    assert.equal(parseHumanDuration('10M'), 10 * 60_000, 'case-insensitive');
    for (const bad of ['', ' ', '10', 'abc', '1h 2h', '1 x', '0m', '1:30', '-5m', 'm']) {
        assert.equal(parseHumanDuration(bad), null, `"${bad}" must be rejected`);
    }
    assert.equal(formatDurationMs(90_000), '1m 30s');
    assert.equal(formatDurationMs(0), '0s');
});

// --- v3.2: per-guild settings ----------------------------------------------------

const guildSettings = require('../lib/guildSettings');

await check('guildSettings patch/get/reset persist', () => {
    assert.equal(guildSettings.get('g-settings').prefix, null, 'default: no override');
    assert.equal(guildSettings.get('g-settings').twentyFourSeven, false);
    guildSettings.patch('g-settings', { prefix: '?', twentyFourSeven: true });
    assert.equal(guildSettings.get('g-settings').prefix, '?');
    assert.equal(guildSettings.get('g-settings').twentyFourSeven, true);
    assert.ok(fs.existsSync(guildSettings.FILE), 'settings file written');
    guildSettings.patch('g-settings', { prefix: null });
    assert.equal(guildSettings.get('g-settings').prefix, null);
    guildSettings.reset('g-settings');
    assert.equal(guildSettings.get('g-settings').twentyFourSeven, false, 'reset wipes every override');
});

// --- v3.2: playlists -------------------------------------------------------------

const playlists = require('../lib/playlistsStore');

await check('playlistsStore saves, validates, replaces and removes', () => {
    const songs = [
        { url: 'https://youtu.be/aaaaaaaa', name: 'One', duration: 100, thumbnail: 't' },
        'https://youtu.be/bbbbbbbb',
        { name: 'no url', duration: 5 },
    ];
    const saved = playlists.save('g-pl', 'Road Trip', songs);
    assert.ok(saved.ok, 'save accepted');
    assert.equal(saved.playlist.songs.length, 2, 'entries without a url drop out, bare urls normalise');

    assert.ok(!playlists.save('g-pl', 'Road Trip', songs).ok, 'duplicate name refused without replace');
    assert.ok(playlists.save('g-pl', 'Road Trip', songs, { replace: true }).ok, 'replace honoured');
    assert.ok(!playlists.save('g-pl', 'x'.repeat(40), songs).ok, 'name length validated');

    const listed = playlists.list('g-pl');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].songs, 2);

    assert.ok(playlists.get('g-pl', 'road trip'), 'lookup is case-insensitive');
    assert.ok(playlists.remove('g-pl', 'road trip'));
    assert.equal(playlists.get('g-pl', 'road trip'), null);
});

// --- v3.2: reminders --------------------------------------------------------------

const remindersLib = require('../lib/reminders');

await check('reminders validate, persist, fire when due and consume', async () => {
    const sent = [];
    const channel = { send: async p => { sent.push(p); } };
    const fakeClient = {
        guilds: { cache: new Map([['g-rem', { id: 'g-rem', channels: { cache: new Map([['c1', channel]]), fetch: async () => channel } }]]) },
        channels: { cache: new Map([['c1', channel]]) },
        users: { fetch: async () => { throw new Error('no dm'); } },
    };

    assert.ok(!remindersLib.add({ guildId: 'g-rem', channelId: 'c1', userId: 'u1', text: 'x', at: Date.now() + 10_000 }).ok,
        'sub-minute reminders refused');
    assert.ok(!remindersLib.add({ guildId: 'g-rem', channelId: 'c1', userId: 'u1', text: 'x', at: Date.now() + 40 * 86400_000 }).ok,
        'beyond 30 days refused');

    const made = remindersLib.add({ guildId: 'g-rem', channelId: 'c1', userId: 'u1', text: 'stretch', at: Date.now() + 600_000 });
    assert.ok(made.ok, 'a normal reminder is accepted');
    assert.equal(remindersLib.listFor('g-rem', 'u1').length, 1);

    // +660s lands exactly on the 60s overdue boundary when the clock has not
    // ticked between the two Date.now() calls — use +605s so "overdue" is
    // unambiguously past the one-minute mark.
    const fired = await remindersLib.fireDue(fakeClient, Date.now() + 725_000);
    assert.equal(fired, 1, 'the due reminder was delivered');
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /stretch/);
    assert.match(sent[0].content, /overdue/, 'a past-due delivery says so');
    assert.equal(remindersLib.listFor('g-rem', 'u1').length, 0, 'consumed after firing');

    remindersLib.add({ guildId: 'g-rem', channelId: 'c1', userId: 'u1', text: 'second', at: Date.now() + 600_000 });
    const second = remindersLib.listFor('g-rem', 'u1')[0];
    assert.ok(remindersLib.cancel(second.id));
    assert.equal(remindersLib.listFor('g-rem', 'u1').length, 0);
});

// --- v3.2: vote skip --------------------------------------------------------------

const voteSkip = require('../lib/voteSkip');

await check('vote skip: majority needed, exemptions immediate, stale votes die', () => {
    const queueWith = (songId, humans) => ({
        songs: [{ id: songId, user: { id: 'req' } }],
        voiceChannel: {
            id: 'vc',
            members: { values: () => Array.from({ length: humans }, (_, i) => ({ user: { id: `h${i}`, bot: false } })) },
        },
    });
    const base = { voteEnabled: true };

    // A solo listener’s skip is final.
    const solo = voteSkip.attemptSkip({ ...base, guildId: 'g-solo', userId: 'h0', isOwner: false, isRequester: false, queue: queueWith('s1', 1) });
    assert.equal(solo.action, 'skip');
    assert.equal(solo.reason, 'solo');

    // Requester and owner skip outright even with a crowd.
    assert.equal(voteSkip.attemptSkip({ ...base, guildId: 'g-v', userId: 'req', isOwner: false, isRequester: true, queue: queueWith('s1', 3) }).reason, 'requester');
    assert.equal(voteSkip.attemptSkip({ ...base, guildId: 'g-v2', userId: 'x', isOwner: true, isRequester: false, queue: queueWith('s1', 4) }).reason, 'owner');

    // Three listeners: one vote starts the poll, a second passes it.
    const first = voteSkip.attemptSkip({ ...base, guildId: 'g-vote', userId: 'h1', isOwner: false, isRequester: false, queue: queueWith('s1', 3) });
    assert.equal(first.action, 'vote');
    assert.equal(first.votes, 1);
    assert.equal(first.needed, 2, 'ceil(3/2)');

    const dup = voteSkip.attemptSkip({ ...base, guildId: 'g-vote', userId: 'h1', isOwner: false, isRequester: false, queue: queueWith('s1', 3) });
    assert.equal(dup.action, 'already');

    const second = voteSkip.attemptSkip({ ...base, guildId: 'g-vote', userId: 'h2', isOwner: false, isRequester: false, queue: queueWith('s1', 3) });
    assert.equal(second.action, 'skip');
    assert.equal(second.reason, 'passed');

    // A vote does not survive the song changing under it.
    voteSkip.attemptSkip({ ...base, guildId: 'g-stale', userId: 'h1', isOwner: false, isRequester: false, queue: queueWith('sA', 3) });
    const afterSongChange = voteSkip.attemptSkip({ ...base, guildId: 'g-stale', userId: 'h1', isOwner: false, isRequester: false, queue: queueWith('sB', 3) });
    assert.equal(afterSongChange.votes, 1, 'the old song’s vote was discarded');
});

// --- v3.2: cooldowns --------------------------------------------------------------

const cooldowns = require('../lib/cooldowns');

await check('cooldowns let the first call through and block the second', () => {
    cooldowns.__reset();
    assert.equal(cooldowns.check('u1', 'play', 5), true);
    assert.equal(cooldowns.check('u1', 'play', 5), false, 'second call inside the window');
    assert.equal(cooldowns.check('u2', 'play', 5), true, 'another user unaffected');
    assert.equal(cooldowns.check('u1', 'ping', 0), true, '0 disables');
});

// --- v3.2: autoplay ---------------------------------------------------------------

const autoplayLib = require('../lib/autoplay');

await check('autoplay ids, mix url and the chain/failure brakes', () => {
    assert.equal(autoplayLib.videoIdOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1'), 'dQw4w9WgXcQ');
    assert.equal(autoplayLib.videoIdOf('https://example.invalid/x'), null);
    assert.equal(autoplayLib.mixUrl('abc123def'), 'https://www.youtube.com/playlist?list=RDabc123def');

    const st = autoplayLib.ensure('g-auto');
    st.last = { url: 'https://www.youtube.com/watch?v=abc123456' };
    st.failures = autoplayLib.MAX_FAILURES;
    assert.equal(autoplayLib.canContinue('g-auto'), false, 'failures pause autoplay for the session');
    st.failures = 0;
    assert.equal(autoplayLib.canContinue('g-auto'), true);

    autoplayLib.recordPlay('g-auto', { url: 'x', auto: true });
    assert.equal(autoplayLib.ensure('g-auto').chain, 1);
    autoplayLib.recordPlay('g-auto', { url: 'y' });
    assert.equal(autoplayLib.ensure('g-auto').chain, 0, 'a human-picked song resets the chain');
});

// --- v3.2: button dispatch ---------------------------------------------------------

const components = require('../lib/components');

await check('component dispatch pages the queue and strips stale controls', async () => {
    cooldowns.__reset();
    const queue = fakeQueue(Array.from({ length: 16 }, (_, i) => `song ${i}`), { id: 'g-btn' });
    const distube = { getQueue: () => queue };
    const updates = [];
    const interaction = {
        customId: 'mb:qp:2',
        guild: { id: 'g-btn', name: 'G' },
        user: { id: 'u1', bot: false },
        member: { voice: { channelId: 'vc' } },
        update: async payload => { updates.push(payload); return 'updated'; },
        reply: async () => 'replied',
    };
    await components.dispatch(interaction, { distube, config: {} });
    assert.equal(updates.length, 1, 'the queue paging updated the message');
    assert.ok(Array.isArray(updates[0].components), 'new page buttons sent');

    let outcome = null;
    const unknown = {
        customId: 'mb:nosuchthing',
        guild: { id: 'g' }, user: { id: 'u2' }, member: {},
        update: async () => { outcome = 'emptied'; },
        reply: async () => { outcome = 'replied'; },
    };
    await components.dispatch(unknown, { distube, config: {} });
    assert.equal(outcome, 'emptied', 'unknown customIds quietly lose their buttons');
});

// --- v3.2: reaction-roles store v2 ---------------------------------------------------

await check('reaction-roles store v2 records menus with metadata and migrates v1', () => {
    store.record('menu-v2', { channelId: 'chan-v2', guildId: 'guild-v2' });
    assert.ok(store.isManaged('menu-v2'));

    const migrated = store.parse('{"messageIds":["old-a","old-b"]}');
    assert.deepEqual(migrated, [
        { messageId: 'old-a', channelId: null, guildId: null },
        { messageId: 'old-b', channelId: null, guildId: null },
    ], 'v1 ids become per-message records');

    const kept = store.parse('{"menus":[{"messageId":"c","channelId":"d","guildId":"e"}]}');
    assert.equal(kept[0].channelId, 'd');

    assert.deepEqual(store.parse('nonsense'), [], 'a corrupt file degrades to no menus');
});

// --- v3.2: 24/7 parks the idle watcher ----------------------------------------------

await check('voiceIdle disarms when 24/7 mode is on for the guild', () => {
    const { EventEmitter } = require('node:events');
    const client = new EventEmitter();
    const queue = {
        id: 'g-247',
        textChannel: { send: async () => {} },
        stop: async () => {},
        voiceChannel: { id: 'vc', name: 'Music', members: { values: () => [{ user: { bot: true } }] } },
    };
    const distube = { getQueue: () => queue, on: () => {} };
    const idle = setupVoiceIdle(client, { distube, config: { music: { leaveOnEmptyAfterSeconds: 5 } } });

    guildSettings.patch('g-247', { twentyFourSeven: true });
    client.emit('voiceStateUpdate', { channelId: 'vc' }, { guild: { id: 'g-247' }, channelId: null });
    assert.equal(idle.timers.size, 0, '24/7 mode keeps the timer disarmed');

    guildSettings.reset('g-247');
    client.emit('voiceStateUpdate', { channelId: 'vc' }, { guild: { id: 'g-247' }, channelId: null });
    assert.equal(idle.timers.size, 1, 'with 24/7 off the watcher arms again');
    idle.disarm('g-247');
});

    // Windows refuses to delete a directory containing an open sqlite file.
    feedbackStore.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
})();
