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
        'remind', 'poll', 'stats', 'timeout', 'modlog', 'prefix', 'logs',
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

await check('ytDlpArgs controls --no-playlist and never caps the list', () => {
    const { ytDlpArgs } = require('../lib/YtDlpPluginPatched');
    const watch = 'https://www.youtube.com/watch?v=aaaaaaaa&list=PL123';
    const bare = 'https://www.youtube.com/playlist?list=PL123';

    assert.ok(ytDlpArgs(watch).includes('--no-playlist'), 'watch link defaults to one video');
    assert.ok(!ytDlpArgs(bare).includes('--no-playlist'), 'bare playlist url resolves the list');
    assert.ok(!ytDlpArgs(watch, { allowPlaylist: true }).includes('--no-playlist'), 'allowPlaylist opts in');

    for (const args of [ytDlpArgs(bare), ytDlpArgs(watch, { allowPlaylist: true })]) {
        assert.ok(!args.includes('--playlist-items'), 'no 100-song cap anymore');
    }
    assert.deepEqual(ytDlpArgs(bare, { extraArgs: ['--flat-playlist'] }).slice(-1), ['--flat-playlist']);

    // The autoplay radio-mix path bounds entries explicitly (regression: the
    // removed PLAYLIST_ITEM_CAP used to do this for every resolve call).
    const capped = ytDlpArgs(bare, { playlistItems: 25 });
    assert.ok(capped.includes('--playlist-items') && capped.includes('1-25'), 'playlistItems caps the dump');
    assert.ok(!ytDlpArgs(bare, {}).includes('--playlist-items'), 'no cap unless asked');
});

await check('playlistEntries keeps only playlist rows from a flat search', () => {
    const { playlistEntries } = require('../lib/YtDlpPluginPatched');
    const info = {
        entries: [
            { id: 'PL1', title: 'Best of AC/DC', url: 'https://www.youtube.com/playlist?list=PL1', thumbnail: 'https://i.ytimg.com/vi/x/hq1.jpg' },
            { id: 'aaa', title: 'A video', url: 'https://www.youtube.com/watch?v=aaa' },
            { id: 'PL2', title: 'Hard Rock', url: 'https://www.youtube.com/playlist?list=PL2' },
            null,
        ],
    };
    const out = playlistEntries(info, 3);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
        type: 'playlist',
        name: 'Best of AC/DC',
        url: 'https://www.youtube.com/playlist?list=PL1',
        thumbnail: 'https://i.ytimg.com/vi/x/hq1.jpg',
    });
    assert.equal(out[1].thumbnail, undefined);
    assert.equal(playlistEntries(info, 1).length, 1, 'limit respected');
    assert.deepEqual(playlistEntries({ entries: 'nope' }, 3), []);
    assert.deepEqual(playlistEntries({}, 3), []);
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
        const dash = await r.text();
        assert.match(dash, /MockBot/, 'dashboard renders for a session');
        assert.match(dash, /id="toast"[^>]*role="status"[^>]*aria-live="polite"/, 'errors are announced to screen readers');
        assert.match(dash, /<nav role="tablist">/, 'tabs expose tab semantics');
        assert.match(dash, /:focus-visible/, 'keyboard focus is a designed state');
        assert.match(dash, /aria-selected="true"/, 'the active tab is announced');
        assert.match(dash, /<link rel="icon" href="data:image\/png;base64,/, 'brand favicon survives CSP');
        assert.match(dash, /overflow-wrap:anywhere/, 'narrow screens never scroll sideways');

        r = await fetch(`${base}/api/status`, authed);
        assert.equal(r.status, 200);
        const status = await r.json();
        assert.equal(status.user.tag, 'MockBot#0001');
        assert.equal(status.user.uptimeSeconds, 90);
        assert.equal(status.user.wsPing, 42);
        assert.equal(status.guilds, 2);
        assert.equal(status.commands.total, 2);
        assert.equal(status.commands.disabled, 0);
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

// --- v3.3: portal admin API (settings, toggles, guilds, audit, CSRF) ----------

await check('portal admin API: csrf, settings, toggles, guild detail, audit', async () => {
    const runtimeConfig = require('../lib/runtimeConfig');
    const commandToggles = require('../lib/commandToggles');
    const usage = require('../lib/usage');
    const auditLog = require('../lib/auditLog');
    // Local alias: the file-level `const guildSettings` sits further down and
    // is still in its temporal dead zone while this block runs.
    const guildSettings = require('../lib/guildSettings');

    const fakeGuild = {
        id: 'g-admin',
        name: 'Admin Guild',
        memberCount: 42,
        ownerId: 'owner-id',
        premiumTier: 1,
        premiumSubscriptionCount: 3,
        createdTimestamp: 1_700_000_000_000,
        joinedTimestamp: 1_710_000_000_000,
        channels: { cache: new Map([
            ['c1', { id: 'c1', type: 0 }],
            ['v1', { id: 'v1', type: 2 }],
        ]) },
        members: { me: { permissions: { toArray: () => ['SendMessages', 'Connect'] } } },
    };
    const fakeClient = {
        user: { tag: 'MockBot#0001' },
        uptime: 60_000,
        ws: { ping: 10 },
        guilds: { cache: { size: 1, values: () => [fakeGuild] } },
    };
    let resyncs = 0;
    const portal = await startPortal({
        client: fakeClient,
        distube: { getQueue: () => null },
        commands: new Map([
            ['play', { name: 'play', description: 'Play a song', data: {} }],
            ['poll', { name: 'poll', description: 'Make a poll' }],
            ['reboot', { name: 'reboot', description: 'Restart', ownerOnly: true }],
        ]),
        resyncSlashCommands: async () => { resyncs += 1; return { guilds: 1, failed: 0, commands: 2 }; },
        env: { WEB_USER: 'admin', WEB_PASS: 'correct horse' },
        port: 0,
        log: quiet,
    });
    assert.ok(portal);
    const base = `http://127.0.0.1:${portal.port}`;
    try {
        const r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'correct horse'), redirect: 'manual' });
        const cookie = r.headers.get('set-cookie').split(';')[0];
        // The CSRF token is embedded in the dashboard page's body tag.
        const page = await (await fetch(`${base}/`, { headers: { cookie } })).text();
        const csrf = page.match(/data-csrf="([0-9a-f]{32})"/)[1];
        const api = async (path, body) => {
            const response = await fetch(`${base}${path}`, {
                method: 'POST',
                headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
                body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw Object.assign(new Error(`${path} -> ${response.status}: ${JSON.stringify(payload)}`), { status: response.status });
            return payload;
        };
        const expectFail = async (path, body, code, why) => {
            let err = null;
            try { await api(path, body); } catch (e) { err = e; }
            assert.ok(err, `${why}: the request should have failed`);
            if (err.status === undefined) throw err; // a network error is not the expected 4xx
            assert.equal(err.status, code, why);
        };

        // A mutation without the CSRF header is refused.
        const noCsrf = await fetch(`${base}/api/settings`, {
            method: 'POST', headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ path: 'prefix', value: '?' }),
        });
        assert.equal(noCsrf.status, 403, 'missing CSRF token blocks the mutation');

        // Settings round-trip through runtimeConfig and mutate the live object.
        const live = runtimeConfig.init(require('../config.json'));
        const before = live.prefix;
        let rr = await api('/api/settings', { path: 'prefix', value: '?' });
        assert.ok(rr.ok, 'prefix change accepted');
        assert.equal(live.prefix, '?', 'live config object mutated in place');
        await expectFail('/api/settings', { path: 'cooldowns.default', value: 99999 }, 400, 'out-of-range cooldown rejected');
        rr = await api('/api/settings', { path: 'reactionRoles.enabled', value: false });
        assert.equal(rr.ok, true);
        assert.equal(live.reactionRoles.enabled, false, 'bool coercion works');
        rr = await api('/api/settings', { path: 'reactionRoles.roles', value: '[{"name":"HOTS","emoji":"1️⃣","roleId":"123456789012345678"}]' });
        assert.ok(rr.ok, 'roles JSON accepted');
        await expectFail('/api/settings', { path: 'reactionRoles.roles', value: '[{"emoji":"1️⃣"}]' }, 400, 'roles without name/roleId refused');
        await expectFail('/api/settings', { path: 'not.a.setting', value: 1 }, 400, 'unlisted paths are not editable');

        // Guild settings.
        rr = await api('/api/guild/settings', { guildId: 'g-admin', patch: { prefix: '>', twentyFourSeven: true, bogusKey: 'x' } });
        assert.ok(rr.ok);
        assert.equal(guildSettings.get('g-admin').prefix, '>');
        assert.equal(guildSettings.get('g-admin').twentyFourSeven, true);
        assert.equal(guildSettings.get('g-admin').bogusKey, undefined, 'unknown patch keys never land');

        // Silent truncation is now a loud truncation: sliced input comes back
        // as a note in the response so the UI can tell the operator.
        rr = await api('/api/guild/settings', { guildId: 'g-admin', patch: { prefix: '!play1', autoRoleIds: '111111111111,222222222222,333333333333,444444444444,555555555555,666666666666' } });
        assert.ok(rr.ok);
        assert.equal(guildSettings.get('g-admin').prefix, '!play', 'prefix keeps only 5 chars');
        assert.equal(guildSettings.get('g-admin').autoRoleIds.length, 5, 'only 5 auto-role ids kept');
        assert.ok((rr.notes || []).some(n => /prefix kept first 5/.test(n)), 'the prefix slice is reported');
        assert.ok((rr.notes || []).some(n => /auto-role ids kept first 5/.test(n)), 'the id slice is reported');
        rr = await api('/api/guild/reset', { guildId: 'g-admin' });
        assert.ok(/settings, command overrides and usage stats/.test(rr.message), 'reset names its full blast radius');

        // Guild detail lists toggles, usage and derived info.
        usage.record('g-admin', 'play');
        usage.record('g-admin', 'play');
        const detail = await (await fetch(`${base}/api/guilds?id=g-admin`, { headers: { cookie } })).json();
        assert.equal(detail.selected.memberCount, 42);
        assert.equal(detail.selected.voiceChannels, 1);
        assert.equal(detail.selected.permissions, 'SendMessages, Connect');
        assert.equal(detail.selected.topCommands[0].name, 'play');
        assert.equal(detail.selected.topCommands[0].count, 2);
        assert.ok(detail.selected.commands.length === 3, 'every command listed for the guild');

        // Toggles: global off removes it from the picker and triggers resync.
        rr = await api('/api/commands/toggle', { name: 'poll', guildId: null, on: false });
        assert.ok(rr.ok);
        assert.equal(resyncs, 1, 'slash resync ran after the toggle');
        assert.equal(commandToggles.enabled('poll'), false);
        assert.equal(commandToggles.enabled('poll', 'g-admin'), false);
        // A per-guild "force on" beats the global off.
        rr = await api('/api/commands/toggle', { name: 'poll', guildId: 'g-admin', on: true });
        assert.ok(rr.ok);
        assert.equal(commandToggles.enabled('poll', 'g-admin'), true, 'guild override wins');
        // Owner-only commands ignore guild overrides.
        rr = await api('/api/commands/toggle', { name: 'reboot', guildId: 'g-admin', on: false });
        assert.ok(rr.ok);
        assert.equal(commandToggles.enabled('reboot', 'g-admin'), true, 'guilds cannot disable owner commands');
        await expectFail('/api/commands/toggle', { name: 'nosuch', guildId: null, on: false }, 400, 'unknown command refused');

        // Audit recorded every mutation, newest first.
        const lines = await auditLog.read();
        assert.ok(lines.some(l => /toggle .*poll global -> off/.test(l)), 'the global toggle is in the trail');
        assert.ok(lines.some(l => /settings prefix = "\?"/.test(l)), 'the settings change is in the trail');
        const auditApi = await (await fetch(`${base}/api/audit`, { headers: { cookie } })).json();
        assert.ok(auditApi.lines.length >= 5);

        // Persistent log: /api/logs tails the file the console now tees to.
        const logSink = require('../lib/logSink');
        logSink.start();
        console.log('smoke: line that must land in the file log');
        const logsApi = await (await fetch(`${base}/api/logs?errors=0`, { headers: { cookie } })).json();
        assert.ok(Array.isArray(logsApi.lines) && logsApi.lines.some(l => l.includes('must land in the file log')),
            'the written line shows up through /api/logs');
        console.error('smoke ERROR marker');
        const errApi = await (await fetch(`${base}/api/logs?errors=1`, { headers: { cookie } })).json();
        assert.ok(errApi.lines.some(l => /\sERROR\s/.test(l)), 'errors=1 keeps ERROR lines');
        assert.ok(!errApi.lines.some(l => /must land in the file log/.test(l)), 'errors=1 drops INFO lines');
        const raw = await fetch(`${base}/logs.txt`, { headers: { cookie } });
        assert.equal(raw.status, 200);
        assert.match(raw.headers.get('content-disposition'), /attachment; filename="mockbot\.log"/);
        assert.ok((await raw.text()).includes('must land in the file log'), '/logs.txt carries the log');

        // Status reflects the disabled count and usage totals.
        const status = await (await fetch(`${base}/api/status`, { headers: { cookie } })).json();
        assert.equal(status.commands.disabled, 1, 'poll counts as disabled globally');
        assert.ok(status.usage.top.find(row => row.name === 'play' && row.count === 2));

        // Reverting the prefix restores config.json's value.
        rr = await api('/api/settings', { path: 'prefix', value: null });
        assert.ok(rr.ok);
        assert.equal(live.prefix, before, 'revert drops the override');

        guildSettings.reset('g-admin');
        commandToggles.setGlobal('poll', true);
        usage.clearGuild('g-admin');
    } finally {
        portal.close();
    }
});

await check('portal password can be stored as a hash; allowlist gates addresses', async () => {
    const crypto = require('node:crypto');
    const hex = crypto.createHash('sha256').update('hunter2').digest('hex');
    const portal = await startPortal({
        client: { guilds: { cache: { values: () => [] } } },
        distube: {},
        env: { WEB_USER: 'admin', WEB_PASS_HASH: hex },
        port: 0,
        log: quiet,
    });
    assert.ok(portal, 'WEB_PASS_HASH alone enables the portal');
    const base = `http://127.0.0.1:${portal.port}`;
    try {
        let r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'wrong') });
        assert.equal(r.status, 401);
        r = await fetch(`${base}/login`, { method: 'POST', body: form('admin', 'hunter2'), redirect: 'manual' });
        assert.equal(r.status, 302, 'the pre-image matching the digest signs in');
    } finally {
        portal.close();
    }

    // An allowlist that cannot match ::1 rejects even a correct login attempt.
    const gated = await startPortal({
        client: { guilds: { cache: { values: () => [] } } },
        distube: {},
        env: { WEB_USER: 'admin', WEB_PASS: 'p', WEB_ALLOWLIST: '10.99.' },
        port: 0,
        log: quiet,
    });
    assert.ok(gated);
    try {
        const r = await fetch(`http://127.0.0.1:${gated.port}/login`);
        assert.equal(r.status, 403, 'a non-allowlisted address is refused before the form renders');
    } finally {
        gated.close();
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

// The playSong embed's control row runs through ButtonBuilder, which has no
// .setTitle (that's the Embed API) — a stray setTitle once killed every
// song start with "setTitle is not a function" while no test built a row.
await check('the now-playing control row builds and serializes', () => {
    const { controlRow } = require('../lib/musicUi');
    const row = controlRow(fakeQueue(['a'], { id: 'g-ctl' })).toJSON();
    assert.equal(row.components.length, 3, 'three buttons');
    assert.ok(row.components.every(c => c.label && c.emoji), 'every button has a label and emoji');
});

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

// --- v3.4: welcome renderer -------------------------------------------------------

const lifecycle = require('../Event_listeners/guildLifecycle');

await check('welcome template renders placeholders and survives junk', () => {
    const member = {
        id: '99',
        toString: () => '<@99>',
        guild: { name: 'Test Guild', memberCount: 1234 },
    };
    assert.equal(
        lifecycle.renderWelcome('{member} joined {guild} as #{count}', member),
        '<@99> joined Test Guild as #1234',
    );
    assert.ok(lifecycle.renderWelcome(null, member).includes('<@99>'), 'null template = default text');
    assert.ok(lifecycle.renderWelcome('hi', member) === 'hi', 'no placeholders passes through');
});

await check('welcome auto-roles only return manageable roles', () => {
    const roles = new Map([
        ['r-hi', { id: 'r-hi', name: 'High', position: 50, managed: false }],
        ['r-lo', { id: 'r-lo', name: 'Low', position: 1, managed: false }],
        ['r-mg', { id: 'r-mg', name: 'Bot', position: 1, managed: true }],
    ]);
    const guild = { roles: { cache: { get: id => roles.get(id) ?? null } }, members: { me: { roles: { highest: { position: 10 } } } } };
    const out = lifecycle.resolvableRoles(guild, ['r-hi', 'r-lo', 'r-mg', 'missing', null]);
    assert.deepEqual(out.map(r => r.id), ['r-lo'], 'too-high, managed, and unknown ids drop out');
});

// --- v3.4: dj + music-channel gates -----------------------------------------------

await check('djReply: no role set = open; role set gates by membership, requester, staff', () => {
    const { djReply, playChannelReply } = guards;
    const guildSettings = require('../lib/guildSettings');
    const owner = String(process.env.OWNER);

    guildSettings.patch('g-dj', {});
    assert.equal(djReply({ id: 'g-dj' }, { id: 'u1' }, null), null, 'feature off passes everyone');

    guildSettings.patch('g-dj', { djRoleId: 'r-dj' });
    const guild = { id: 'g-dj', roles: { cache: { get: () => ({ name: 'DJ' }) } } };
    const plain = { id: 'u1', permissions: { has: () => false }, roles: { cache: { has: () => false } } };
    assert.match(djReply(guild, plain, null) ?? '', /DJ/, 'no role = refused with the role name');
    assert.equal(djReply(guild, { ...plain, roles: { cache: { has: id => id === 'r-dj' } } }, null), null, 'role holder passes');
    assert.equal(djReply(guild, plain, { songs: [{ user: { id: 'u1' } }] }), null, 'the song requester passes');
    assert.equal(djReply(guild, { ...plain, permissions: { has: p => p === 'ManageGuild' } }, null), null, 'staff passes');
    assert.equal(djReply(guild, { id: owner, permissions: { has: () => false }, roles: { cache: { has: () => false } } }, null), null, 'bot owner passes');

    guildSettings.patch('g-ch', { musicChannelId: 'ch-music' });
    assert.equal(playChannelReply({ id: 'g-ch' }, { id: 'ch-music' }), null, 'the music channel itself is allowed');
    assert.match(playChannelReply({ id: 'g-ch' }, { id: 'ch-other' }) ?? '', /ch-music/, 'another channel is refused and told where');
    guildSettings.reset('g-dj');
    guildSettings.reset('g-ch');
});

// --- v3.4: search picker store -----------------------------------------------------

const picker = require('../lib/searchPicker');

await check('search picker stores results, expires, and peeks without leaking', async () => {
    picker.open('tok-1', {
        items: [{ name: 'a', url: 'https://example.invalid/a' }],
        voiceChannelId: 'v', textChannelId: 't', guildId: 'g', userId: 'u',
    });
    assert.ok(picker.peek('tok-1'), 'a fresh picker is readable');
    assert.ok(!picker.peek('tok-2'), 'unknown token peeks as null');

    picker.pickers.get('tok-1').expires = Date.now() - 1;
    assert.equal(picker.peek('tok-1'), null, 'an expired picker peeks as null');
    assert.ok(!picker.pickers.has('tok-1'), 'peeking an expired picker deletes it');

    // End-to-end through the handler: a live picker + a fake select interaction
    // must reach distube.play and rewrite the message (a missing import here
    // once produced "that control no longer works" on every pick).
    picker.open('tok-play', {
        items: [{ name: 'b', url: 'https://example.invalid/b', duration: 10 }],
        voiceChannelId: 'vc-1', textChannelId: 'tc-1', guildId: 'g-pick', userId: 'u-picker',
    });
    let played = null;
    let updated = null;
    const distubeStub = {
        getQueue: () => null,
        play: async (channel, song) => { played = { channelId: channel.id, songName: song.name }; },
    };
    const interaction = {
        customId: 'mb:pick:tok-play',
        values: ['1'],
        user: { id: 'u-picker' },
        member: { voice: { channel: { id: 'vc-1' } }, id: 'u-picker' },
        guild: {
            id: 'g-pick',
            channels: { cache: new Map() },
            members: { me: { voice: { channelId: 'vc-1' } }, fetch: async () => ({}) },
            roles: { cache: { get: () => null } },
        },
        reply: async payload => { updated = payload; },
        update: payload => { updated = payload; return Promise.resolve(); },
        // distube.play resolves late, so the handler MUST defer the update
        // first and finish via message.edit — a non-deferring handler once
        // died with "Unknown interaction" against a live Discord.
        deferred: false,
        deferUpdate: async () => { interaction.deferred = true; },
        message: { edit: payload => { updated = payload; return Promise.resolve(payload); } },
    };
    // Go through the dispatcher, not chosen() directly: dispatch calls
    // handlers as (interaction, args, deps), and that shape is exactly the
    // bug this test used to miss (the pick handler bound deps to args).
    const components = require('../lib/components');
    await components.dispatch(interaction, { distube: distubeStub });
    assert.deepEqual(played, { channelId: 'vc-1', songName: 'b' }, 'the chosen song reached distube.play');
    assert.ok(interaction.deferred, 'the update is deferred before the slow distube.play');
    assert.match(String(updated?.content ?? ''), /Queued/, 'the message became a confirmation');
    assert.equal(picker.peek('tok-play'), null, 'a used picker is consumed');

    const payload = picker.pickerPayload('test query', [{ name: 'Song [one]', url: 'https://example.invalid/1', duration: 65 }], 'tok');
    assert.equal(payload.components.length, 1, 'one action row');
    const menu = payload.components[0].toJSON().components[0];
    assert.equal(menu.type, 3, 'a native select menu');
    assert.equal(menu.custom_id, 'mb:pick:tok', 'the token rides in the customId');
    assert.equal(menu.options[0].label, 'Song \\[one\\]', 'titles are markdown-escaped');
});

await check('picker shows playlist items and queues the resolved playlist on pick', async () => {
    const descriptor = { type: 'playlist', name: 'Best of AC/DC', url: 'https://www.youtube.com/playlist?list=PL9' };
    const playlistPayload = picker.pickerPayload('acdc', [descriptor], 'tok-pl');
    const desc = playlistPayload.embeds[0].data.description;
    assert.ok(desc.includes('📄 Best of AC/DC'), 'the embed marks the playlist line');

    picker.open('tok-pl', {
        items: [descriptor],
        voiceChannelId: 'vc-1', textChannelId: 'tc-1', guildId: 'g-pl', userId: 'u-pl-picker',
    });
    let played = null;
    const resolvedPlaylist = { name: 'Best of AC/DC', songs: [{}, {}, {}] };
    const distubeStub = {
        getQueue: () => null,
        plugins: [{ resolve: async url => { played = { resolvedUrl: url }; return resolvedPlaylist; } }],
        play: async (channel, what) => { played.playlist = { name: what.name, songs: what.songs.length }; },
    };
    const interaction = {
        customId: 'mb:pick:tok-pl',
        values: ['1'],
        user: { id: 'u-pl-picker' },
        member: { voice: { channel: { id: 'vc-1' } }, id: 'u-pl-picker' },
        guild: {
            id: 'g-pl',
            channels: { cache: new Map() },
            members: { me: { voice: { channelId: 'vc-1' } }, fetch: async () => ({}) },
            roles: { cache: { get: () => null } },
        },
        reply: async () => {},
        update: () => Promise.resolve(),
        deferred: false,
        deferUpdate: async () => { interaction.deferred = true; },
        message: { edit: payload => { played.content = payload?.content; return Promise.resolve(payload); } },
    };
    const components = require('../lib/components');
    await components.dispatch(interaction, { distube: distubeStub });
    assert.equal(played.resolvedUrl, descriptor.url, 'the descriptor url went through the plugin resolver');
    assert.deepEqual(played.playlist, { name: 'Best of AC/DC', songs: 3 }, 'the resolved Playlist reached distube.play');
    assert.match(String(played.content ?? ''), /Queued playlist \*\*Best of AC\/DC\*\* \(3 songs\)/, 'confirmation names the playlist');
});

await check('parseInvocation extracts --playlist, the bang, and the query', () => {
    const { parseInvocation } = require('../lib/music');
    assert.deepEqual(
        parseInvocation({ args: ['--playlist', 'https://youtu.be/x?list=PL9'] }),
        { query: 'https://youtu.be/x?list=PL9', direct: false, playlist: true },
    );
    assert.deepEqual(
        parseInvocation({ args: ['https://youtu.be/x?list=PL9', '--playlist'] }),
        { query: 'https://youtu.be/x?list=PL9', direct: false, playlist: true },
        'the flag works after the query too',
    );
    assert.deepEqual(
        parseInvocation({ args: ['!acdc', 'best'] }),
        { query: 'acdc best', direct: true, playlist: false },
    );
    assert.deepEqual(
        parseInvocation({ args: ['acdc'], option: name => (name === 'direct' ? true : undefined) }),
        { query: 'acdc', direct: true, playlist: false },
    );
    assert.deepEqual(
        parseInvocation({ args: ['acdc'], option: name => (name === 'playlist' ? true : undefined) }),
        { query: 'acdc', direct: false, playlist: true },
        'the slash playlist option counts as the flag',
    );
});

await check('Staff_prefix exports PREFIX_RE for reuse by !config', () => {
    const mod = require('../commands/Staff_prefix');
    assert.ok(mod.PREFIX_RE instanceof RegExp, 'PREFIX_RE must be exported');
    assert.ok(mod.PREFIX_RE.test('~#'), 'the shared regex still accepts valid prefixes');
    assert.ok(!mod.PREFIX_RE.test('@!'), 'and still rejects mention-colliding ones');
});

await check('leave and disconnect destroy the voice connection, not just the player', async () => {
    const { disconnect } = require('../lib/music');
    const calls = [];
    const distube = { voices: { leave: id => calls.push(['leave', id]) } };
    const queue = { id: 'g-leave', songs: [{}], stop: async () => { calls.push(['stop']); } };

    await disconnect(distube, queue);
    assert.deepEqual(calls, [['stop'], ['leave', 'g-leave']], 'stop then leave, keyed by the queue guild');

    // No queue (24/7 parked): still hang up, keyed by the explicit guild id.
    calls.length = 0;
    await disconnect(distube, null, 'g-leave');
    assert.deepEqual(calls, [['leave', 'g-leave']], 'a bare connection is destroyed by guild id');

    // The command itself: it must reach disconnect through ctx.distube.
    calls.length = 0;
    const leave = require('../commands/leave');
    let replied = null;
    const ctx = {
        guild: { id: 'g-leave' },
        user: { id: 'u' },
        member: { voice: { channelId: 'vc' } },
        distube: {
            getQueue: () => queue,
            voices: { leave: id => calls.push(['leave', id]) },
        },
        reply: async text => { replied = text; },
    };
    await leave.execute(ctx);
    assert.ok(calls.some(c => c[0] === 'leave'), 'leave.execute reached voices.leave');
    assert.match(replied, /Left the voice channel/);
});

await check('config parseValue validates each setting kind', () => {
    const { parseValue } = require('../commands/config');
    const guild = {
        roles: { cache: new Map([['1'.repeat(18), { name: 'DJ' }]]) },
        channels: { cache: new Map([['2'.repeat(18), { name: 'music', send: () => {} }]]) },
    };

    assert.equal(parseValue('autoplay', 'on'), true);
    assert.equal(parseValue('autoplay', 'OFF'), false);
    assert.equal(parseValue('autoplay', 'default'), null);
    assert.throws(() => parseValue('247', 'default'), /takes on, off/, '247 is not nullable');
    assert.throws(() => parseValue('voteskip', 'maybe'), /takes on, off or default/);

    assert.equal(parseValue('djrole', `<@&${'1'.repeat(18)}>`, guild), '1'.repeat(18));
    assert.equal(parseValue('musicchannel', '2'.repeat(18), guild), '2'.repeat(18));
    assert.equal(parseValue('djrole', 'off', guild), null);
    assert.throws(() => parseValue('djrole', '<@&999999999999999999>', guild), /not in this server/);
    assert.throws(() => parseValue('musicchannel', 'nonsense', guild), /mention a real channel/);

    assert.deepEqual(parseValue('autorole', `<@&${'1'.repeat(18)}> @everyone`, guild), ['1'.repeat(18)]);
    assert.equal(parseValue('autorole', 'off', guild), null);
    assert.throws(() => parseValue('autorole', '<@&3'.repeat(1) + '3'.repeat(17) + '>', guild), /unknown role/);

    assert.equal(parseValue('prefix', '~#'), '~#');
    assert.throws(() => parseValue('prefix', '@!'), /1-5 visible chars/);
    assert.throws(() => parseValue('welcomemessage', 'x'.repeat(301)), /300 characters/);
    assert.equal(parseValue('welcomemessage', 'gm {member}'), 'gm {member}');
    assert.throws(() => parseValue('nosuch', 'x'), /unknown setting/);
});

await check('config set/reset/disable drive guildSettings, toggles, and resync', async () => {
    const config = require('../commands/config');
    const settings = require('../lib/guildSettings');
    const commandToggles = require('../lib/commandToggles');
    let resynced = 0;
    let replied = null;
    const fakeGuild = {
        id: 'g-config',
        roles: { cache: new Map([['1'.repeat(18), { name: 'DJ' }]]) },
        channels: { cache: new Map() },
    };
    const ctx = {
        guild: fakeGuild,
        user: { id: 'u' },
        member: { voice: null },
        config: { prefix: '!' },
        commands: new Map([['lyrics', { name: 'lyrics' }], ['reboot', { name: 'reboot', ownerOnly: true }]]),
        resyncSlash: () => { resynced++; },
        isSlash: false,
        option: () => undefined,
        reply: async text => { replied = typeof text === 'string' ? text : JSON.stringify(text); },
    };

    await config.execute(Object.assign(ctx, { args: ['set', '247', 'on'] }));
    assert.equal(settings.get('g-config').twentyFourSeven, true, 'set 247 on wrote the setting');
    assert.match(replied, /`247` = on/);

    await config.execute(Object.assign(ctx, { args: ['set', 'djrole', `<@&${'1'.repeat(18)}>`] }));
    assert.equal(settings.get('g-config').djRoleId, '1'.repeat(18), 'role mention stored by id');

    await config.execute(Object.assign(ctx, { args: ['reset', '247'] }));
    assert.equal(settings.get('g-config').twentyFourSeven, false, 'reset on a non-nullable bool means off');

    await config.execute(Object.assign(ctx, { args: ['set', 'autoplay', 'default'] }));
    assert.equal(settings.get('g-config').autoplay, null, 'default restores follow-global');

    await config.execute(Object.assign(ctx, { args: ['set', 'djrole', 'garbage'] }));
    assert.match(replied, /❌/, 'invalid value replies with the parser message');
    assert.equal(settings.get('g-config').djRoleId, '1'.repeat(18), 'and did not overwrite');

    await config.execute(Object.assign(ctx, { args: ['disable', 'lyrics'] }));
    assert.equal(commandToggles.enabled('lyrics', 'g-config'), false, 'disable wrote a guild override');
    assert.equal(resynced, 1, 'a toggle re-registers the slash command list');

    // Lockout trap: staff disabling `config` hides the only way back.
    ctx.commands.set('config', { name: 'config' });
    await config.execute(Object.assign(ctx, { args: ['disable', 'config'] }));
    assert.match(replied, /cannot disable itself/, 'self-disable is refused for non-owners');
    assert.equal(commandToggles.enabled('config', 'g-config'), true, 'and no override was written');

    await config.execute(Object.assign(ctx, { args: ['disable', 'reboot'] }));
    assert.match(replied, /owner-only/, 'owner commands refuse guild toggles');

    await config.execute(Object.assign(ctx, { args: ['enable', 'lyrics'] }));
    assert.equal(commandToggles.enabled('lyrics', 'g-config'), true, 'enable clears the override');
    assert.equal(resynced, 2);

    await config.execute(Object.assign(ctx, { args: ['show'] }));
    assert.ok(Array.isArray(JSON.parse(replied).embeds), 'show answers with an embed');
});

// --- queue resume across restarts + sleep timer -----------------------------------

await check('queueResume snapshots live queues, respects TTL, and replays them', async () => {
    const qr = require('../lib/queueResume');
    const assert_ = require('node:assert');
    const G = 'g-resume';

    const queue = {
        id: G,
        voiceChannel: { id: 'vc-9', name: 'Music' },
        textChannel: { id: 'tc-9' },
        songs: [
            { url: 'https://www.youtube.com/watch?v=aaaaaaaa', name: 'One', duration: 100, thumbnail: null },
            { url: 'https://www.youtube.com/watch?v=bbbbbbbb', name: 'Two', duration: 200 },
            { url: 'data/sounds/horn', name: 'sfx', source: 'file' }, // no url: dropped
        ],
    };
    assert_.equal(qr.snapshotQueue(queue), true);
    const entry = qr.pending(G);
    assert_.equal(entry.songs.length, 2, 'only url-bearing rows are stored');
    assert_.equal(entry.voiceChannelId, 'vc-9');

    // A manual stop forgets the queue: it must not come back.
    qr.forget(G);
    assert_.equal(qr.pending(G), null, 'forget removes the snapshot');

    // Re-snapshot and expire it: the TTL drops stale queues.
    qr.snapshotQueue(queue);
    qr.load().get(G).savedAt = Date.now() - qr.MAX_AGE_MS - 1000;
    assert_.equal(qr.pending(G), null, 'a stale snapshot is dropped, not replayed');

    // Replay: fresh snapshot against a fake distube/client.
    qr.snapshotQueue(queue);
    const textSends = [];
    const played = [];
    const distubeStub = {
        plugins: [],
        play: async (channel, what) => { played.push({ channelId: channel.id, what }); },
    };
    const clientStub = {
        guilds: { cache: new Map([['g-resume', {
            id: 'g-resume',
            members: { me: {} },
            channels: {
                cache: new Map([
                    ['vc-9', { id: 'vc-9', isJoinable: true, name: 'Music' }],
                    ['tc-9', { id: 'tc-9', send: async t => textSends.push(t) }],
                ]),
                fetch: async () => null,
            },
        }]]) },
    };
    const results = await qr.resumeAll(distubeStub, clientStub);
    assert_.deepEqual(results, [['g-resume', 'resumed', 2]], 'resume reports the guild and song count');
    assert_.equal(played[0].channelId, 'vc-9', 'the bot re-queued into the saved voice channel');
    assert_.equal(played[0].what.songs.length, 2, 'both songs ride in one Playlist');
    assert_.match(textSends[0], /Resumed 2 songs/, 'the text channel is told');
    assert_.equal(qr.pending(G), null, 'a replayed snapshot is consumed');
});

await check('sleep timer arms, replaces, and cancels', () => {
    const sleep = require('../commands/sleep');
    let replied = null;
    let disconnects = 0;
    const distube = {
        getQueue: () => null,
        once: () => {},
        off: () => {},
    };
    const ctx = {
        guild: { id: 'g-sleep' },
        config: { prefix: '!' },
        distube,
        option: () => undefined,
        args: ['15'],
        reply: async t => { replied = t; },
    };
    return (async () => {
        await sleep.execute(ctx);
        assert.ok(sleep.timers.has('g-sleep'), 'sleep 15 armed a timer');
        const first = sleep.timers.get('g-sleep').until;

        await sleep.execute(Object.assign(ctx, { args: ['30'] }));
        assert.ok(sleep.timers.get('g-sleep').until > first, 're-setting replaces the timer');

        await sleep.execute(Object.assign(ctx, { args: ['off'] }));
        assert.equal(sleep.timers.has('g-sleep'), false, 'off cancels');
        assert.match(replied, /cancelled/);

        await sleep.execute(Object.assign(ctx, { args: ['99999'] }));
        assert.match(replied, /❌/, 'out of range is refused');
        assert.equal(sleep.timers.has('g-sleep'), false);

        await sleep.execute(Object.assign(ctx, { args: ['queue'] }));
        assert.match(replied, /Nothing is playing/, 'queue mode with no queue says so');
    })();
});

// --- v3.4: soundboard path safety --------------------------------------------------

const board = require('../lib/soundboard');

await check('soundboard validates names, extensions, and refuses traversal', () => {
    assert.equal(board.soundPath('../../etc/passwd'), null, 'slashes are not name characters');
    assert.equal(board.soundPath('a'.repeat(40)), null, '40 chars is one too many');
    assert.ok(board.soundPath('cool-clip_1.mp3'), 'the extension is trimmed from the base name');

    const bad = board.save('x', Buffer.from('hi'), { extension: '.exe' });
    assert.ok(!bad.ok, 'a non-audio extension is refused');

    const ok = board.save('Horn', Buffer.alloc(2048), { extension: '.mp3' });
    assert.ok(ok.ok && ok.name === 'horn', 'names are lower-cased');
    assert.ok(board.resolveClip('horn'), 'the clip resolves back');
    assert.deepEqual(board.list().map(c => c.name), ['horn'], 'list shows exactly the one clip');

    assert.ok(!board.save('a'.repeat(40), Buffer.alloc(10), { extension: '.mp3' }).ok, 'over-long names cannot be saved');
    assert.ok(board.remove('horn').ok, 'delete works');
    assert.ok(!board.remove('horn').ok, 'deleting twice reports the miss');
});

// --- v3.4: watch input parsing ------------------------------------------------------

await check('watch parses twitch and youtube inputs into the right platform', () => {
    const watchCmd = require('../commands/Staff_watch.js');
    // parseInput is module-private; exercise it through the exported command's
    // behaviour by re-requiring the source text via a fresh module instance.
    const src = require('node:fs').readFileSync(
        require.resolve('../commands/Staff_watch.js'), 'utf8');
    assert.ok(src.includes('function parseInput'), 'the parser exists in the command module');
    const extract = new Function(`${src.match(/function parseInput[\s\S]*?\n}/)[0]}; return parseInput;`);
    const parseInput = extract();

    assert.deepEqual(parseInput('Pokimane'), { platform: 'twitch', channel: 'pokimane' });
    assert.deepEqual(parseInput('https://twitch.tv/shroud'), { platform: 'twitch', channel: 'shroud' });
    assert.deepEqual(parseInput('https://www.youtube.com/channel/UCabc123def456hi'), { platform: 'youtube', channel: 'ucabc123def456hi' });
    assert.deepEqual(parseInput('UCabc123def456hi'), { platform: 'youtube', channel: 'ucabc123def456hi' });
    assert.equal(parseInput('@xqc').platform, 'youtube', 'a bare handle routes to youtube');
    assert.equal(parseInput('@xqc').handle, true, 'handles are flagged for the id-guidance reply');
    assert.equal(parseInput('not a channel!!'), null, 'junk is rejected');
});

// --- v3.4: play history -------------------------------------------------------------

const playHistory = require('../lib/playHistory');

await check('play history counts plays, skips and keeps the recent list capped', () => {
    const song = { name: 'History Song', url: 'https://example.invalid/hist', duration: 100, source: 'youtube-dl' };
    playHistory.recordPlay({ id: 'g-hist' }, song);
    playHistory.recordAbandon({ id: 'g-hist' });    // stop mid-song = skip #1
    playHistory.recordPlay({ id: 'g-hist' }, song);
    playHistory.recordPlay({ id: 'g-hist' }, song); // replaced after ~0s = skip #2

    const top = playHistory.top(5, 'plays');
    const row = top.find(r => r.url === song.url);
    assert.ok(row, 'the track is counted');
    assert.equal(row.plays, 3, 'every play counted');
    assert.equal(row.skips, 2, 'the abandoned and the replaced song both counted as skipped');

    const recent = playHistory.recentPlays(5);
    assert.equal(recent[0].name, 'History Song', 'most recent first');
    assert.equal(recent.length, 3, 'one entry per play');

    playHistory.recordPlay({ id: 'g-hist' }, { name: 'clip', url: 'file', source: 'file' });
    assert.equal(playHistory.recentPlays(5)[0].name, 'History Song', 'soundboard clips are not music history');
});

// --- v3.4: reaction-role store v3 (role allow-list) ----------------------------------

await check('reaction-roles store v3 records and returns the allowed role ids', () => {
    store.record('menu-v3', { channelId: 'c', guildId: 'g', roleIds: ['1', '2'] });
    assert.deepEqual(store.entry('menu-v3').roleIds, ['1', '2'], 'roleIds round-trip');
    assert.equal(store.entry('menu-nope'), null, 'unknown messages have no entry');
    const parsed = store.parse('{"menus":[{"messageId":"m","roleIds":["9"]}]}');
    assert.deepEqual(parsed[0].roleIds, ['9'], 'the file format carries roleIds');
    assert.equal(store.parse('{"menus":[{"messageId":"m"}]}')[0].roleIds, null, 'old entries load as null (fall back to config)');
});

// --- v3.4: guild settings v3 round-trip -----------------------------------------------

await check('the new v3.4 guild settings round-trip through the store', () => {
    const patchIn = {
        welcomeChannelId: '123',
        welcomeMessage: 'hello {member}',
        autoRoleIds: ['1', '2'],
        djRoleId: '9',
        musicChannelId: '456',
        sponsorBlock: true,
    };
    guildSettings.patch('g-v34', patchIn);
    const got = guildSettings.get('g-v34');
    for (const [k, v] of Object.entries(patchIn)) assert.deepEqual(got[k], v, `${k} survives the round trip`);
    guildSettings.reset('g-v34');
    assert.equal(guildSettings.get('g-v34').djRoleId, null, 'reset clears the new keys too');
});

    // Windows refuses to delete a directory containing an open sqlite file.
    feedbackStore.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
})();
