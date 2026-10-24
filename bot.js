require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, MessageFlags } = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPluginPatched } = require('./lib/YtDlpPluginPatched');
const config = require('./config.json');
const runtimeConfig = require('./lib/runtimeConfig');
const { loadCommands } = require('./commands_Handler');
const Context = require('./lib/Context');
const { canRun, isOwner } = require('./lib/access');
const { clip } = require('./lib/respond');
const guildSettings = require('./lib/guildSettings');
const commandToggles = require('./lib/commandToggles');
const usage = require('./lib/usage');
const cooldowns = require('./lib/cooldowns');
const components = require('./lib/components');
const reminders = require('./lib/reminders');
require('./lib/musicUi'); // registers the mb: control handlers with components.js
require('./lib/searchPicker'); // registers the mb:pick handler (play result picker)
const setupMusicEvents = require('./Event_listeners/musicBot');
const setupReactionRoles = require('./Event_listeners/reactionRoles');
const setupGuildLifecycle = require('./Event_listeners/guildLifecycle');
const setupVoiceIdle = require('./Event_listeners/voiceIdle');
const setupSponsorBlock = require('./lib/sponsorBlock');
const liveWatch = require('./lib/liveWatch');
const { startPortal } = require('./web/portal');

const REQUIRED_NODE = 22;

if (!process.env.TOKEN) {
    console.error('[boot] TOKEN is missing. Create a .env file in the project root (see .env.example).');
    process.exit(1);
}

// DisTube 5 declares engines.node >= 22.12; say so plainly instead of failing
// somewhere inside its module later on.
const nodeMajor = Number.parseInt(process.versions.node, 10);
if (nodeMajor < REQUIRED_NODE) {
    console.warn(
        `[boot] Node ${process.versions.node} is older than the ${REQUIRED_NODE}.12 the installed DisTube requires. ` +
        'Music playback may fail; upgrade Node before reporting music bugs.',
    );
}

// A stray rejection would otherwise take the whole bot down on an unattended machine.
process.on('unhandledRejection', reason => {
    console.error('[unhandledRejection]', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', err => {
    console.error('[uncaughtException]', err);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
        GatewayIntentBits.GuildMembers,   // privileged: welcome/auto-role/modlog joins
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    // Song titles, yt-dlp stderr and stored feedback are all remote text: never
    // let it ping @everyone or a role on our behalf.
    allowedMentions: { parse: ['users'], repliedUser: true },
});

client.on(Events.Error, err => console.error('[client]', err));
client.on(Events.Warn, info => console.warn('[client]', info));

let ffmpegPath;
try {
    ffmpegPath = require('ffmpeg-static');
} catch {
    ffmpegPath = undefined; // fall back to ffmpeg on PATH
}

const distube = new DisTube(client, {
    plugins: [new YtDlpPluginPatched()],
    emitNewSongOnly: true,
    emitAddSongWhenCreatingQueue: false,
    emitAddListWhenCreatingQueue: false,
    // /play from a different voice channel should follow the person who asked.
    joinNewVoiceChannel: true,
    ffmpeg: { path: ffmpegPath },
});

const { commands, get: getCommand } = loadCommands();

// Apply the portal's persisted runtime overrides IN PLACE on the config
// object, so every module that captured `config` at boot sees live values.
runtimeConfig.init(config);

// Slash bodies are rebuilt from the live command map, minus anything switched
// off globally — the portal calls this after a toggle so disabled commands
// vanish from Discord's picker too.
function buildSlashBody() {
    return [...commands.values()]
        .filter(cmd => cmd.data && commandToggles.enabled(cmd.name))
        .map(cmd => cmd.data.toJSON());
}

async function resyncSlashCommands() {
    const body = buildSlashBody();
    const guildsList = [...client.guilds.cache.values()];
    const results = await Promise.allSettled(
        guildsList.map(guild => guild.commands.set(body)),
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    return { guilds: guildsList.length, failed, commands: body.length };
}

setupMusicEvents(distube, { config });
setupReactionRoles(client, config);
setupGuildLifecycle(client);
setupSponsorBlock(distube, { config }).setup();
const idleWatcher = setupVoiceIdle(client, { distube, config });

client.once(Events.ClientReady, async readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    // Register slash commands in every guild the bot is in (instant rollout).
    // Disabled-by-toggle commands are excluded (see buildSlashBody).
    const body = buildSlashBody();

    const results = await Promise.allSettled(
        [...readyClient.guilds.cache.values()].map(guild =>
            guild.commands.set(body).catch(err => {
                console.error(`[slash] Failed to register in ${guild.name}: ${err.message}`);
                throw err;
            }),
        ),
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    const total = results.length;
    console.log(
        `Registered ${body.length} slash commands in ${total - failed}/${total} guild(s)` +
        (failed ? ` — ${failed} failed, see above.` : '.'),
    );

    if (!process.env.OWNER) {
        console.warn('[boot] OWNER is not set, so purge/rr/reboot/update are unreachable.');
    }

    // Deliver reminders that came due while the bot was down and arm the timer.
    reminders.start(readyClient);

    // Live-stream announcements poller (no-op until `watch add` fills the list).
    liveWatch.start({ client: readyClient });

    // Optional admin page (WEB_USER/WEB_PASS). It must never be the
    // reason the bot is dead, so a failed bind only costs a log line.
    try {
        await startPortal({ client, distube, commands, resyncSlashCommands });
    } catch (err) {
        console.error('[web] portal failed to start', err);
    }
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;

    // Per-guild override first (the `prefix` command), global config as fallback.
    const prefix = guildSettings.get(message.guild.id).prefix ?? config.prefix;
    if (!message.content.startsWith(prefix)) return;

    const parts = message.content.slice(prefix.length).trim().split(/\s+/);
    let name = parts.shift()?.toLowerCase();
    if (!name) return;

    // Trailing-bang opt-out: `!play! data` runs play with `!data`, which
    // play() reads as "search and auto-pick, no picker menu".
    if (name.endsWith('!')) {
        name = name.slice(0, -1);
        parts.unshift(`!${parts.join(' ')}`.trimEnd());
    }

    const cmd = getCommand(name);
    if (!cmd) return;

    await runCommand(cmd, new Context({
        client, distube, config, commands,
        voiceIdle: idleWatcher,
        message,
        args: parts,
    }));
});

client.on(Events.InteractionCreate, async interaction => {
    // Buttons (player controls, queue paging) and select menus (the play
    // result picker) go through the shared dispatcher.
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await components.dispatch(interaction, { client, distube, config });
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const cmd = commands.get(interaction.commandName);
    if (!cmd) return;

    if (!interaction.guild) {
        return interaction.reply({
            content: 'MockBot commands only work in a server.',
            flags: MessageFlags.Ephemeral,
        });
    }

    // Map slash options onto the same flat args array prefix commands use.
    // Declaration order is kept, so multi-option commands receive their
    // arguments in the order their SlashCommandBuilder lists them.
    const args = interaction.options.data.map(opt => String(opt.value));

    await runCommand(cmd, new Context({
        client, distube, config, commands,
        voiceIdle: idleWatcher,
        interaction,
        args,
    }));
});

async function runCommand(cmd, ctx) {
    try {
        // Portal/owner command toggles: off globally, or off for this guild
        // (a per-guild "on" override beats a global "off"). The bot owner can
        // always reach everything so a mass-disable never locks them out.
        if (!commandToggles.enabled(cmd.name, ctx.guild?.id) && !isOwner(ctx.user?.id)) {
            return ctx.reply(`🚫 \`${cmd.name}\` is disabled on this server.`, { ephemeral: true });
        }

        // Spam brake before anything else runs (owner exempt). Heavy commands
        // like play override the default in config.cooldowns.
        const seconds = Number(config.cooldowns?.[cmd.name] ?? config.cooldowns?.default ?? 0);
        if (seconds > 0 && !isOwner(ctx.user?.id) && !cooldowns.check(ctx.user?.id, cmd.name, seconds)) {
            return ctx.reply(`⏳ Please wait ${seconds}s before using \`${cmd.name}\` again.`, { ephemeral: true });
        }

        const access = await canRun(cmd, ctx);
        if (!access.ok) {
            return ctx.reply(access.reason, { ephemeral: true });
        }
        usage.record(ctx.guild?.id, cmd.name);
        await cmd.execute(ctx);
    } catch (err) {
        console.error(`[command:${cmd.name}]`, err);
        try {
            // err.message can carry remote text and any length, so cap it.
            await ctx.reply(`❌ Something went wrong: ${clip(err?.message ?? String(err), 800)}`);
        } catch {
            /* interaction may already be gone */
        }
    }
}

client.login(process.env.TOKEN).catch(err => {
    console.error(`[boot] Login failed: ${err.message}`);
    console.error('Check that TOKEN in .env is valid, and that the bot application is still active.');
    process.exit(1);
});

module.exports = { client, distube, config, commands };
