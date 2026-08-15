require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const { DisTube } = require('distube');
const { YtDlpPluginPatched } = require('./lib/YtDlpPluginPatched');
const config = require('./config.json');
const { loadCommands } = require('./commands_Handler');
const Context = require('./lib/Context');
const setupMusicEvents = require('./Event_listeners/musicBot');
const setupReactionRoles = require('./Event_listeners/reactionRoles');

if (!process.env.TOKEN) {
    console.error('[boot] TOKEN is missing. Create a .env file in the project root (see .env.example).');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: enable it in the Developer Portal
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

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
    ffmpeg: { path: ffmpegPath },
});

const { commands, get: getCommand } = loadCommands();

setupMusicEvents(distube);
setupReactionRoles(client, config);

client.once(Events.ClientReady, async readyClient => {
    console.log(`Logged in as ${readyClient.user.tag}`);

    // Register slash commands in every guild the bot is in (instant rollout).
    const body = [...commands.values()]
        .filter(cmd => cmd.data)
        .map(cmd => cmd.data.toJSON());
    for (const guild of readyClient.guilds.cache.values()) {
        guild.commands.set(body).catch(err =>
            console.error(`[slash] Failed to register in ${guild.name}: ${err.message}`),
        );
    }
    console.log(`Registered ${body.length} slash commands.`);
});

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;

    const prefix = config.prefix;
    if (!message.content.startsWith(prefix)) return;

    const parts = message.content.slice(prefix.length).trim().split(/\s+/);
    const name = parts.shift()?.toLowerCase();
    if (!name) return;

    const cmd = getCommand(name);
    if (!cmd) return;

    await runCommand(cmd, new Context({
        client, distube, config, commands,
        message,
        args: parts,
    }));
});

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const cmd = commands.get(interaction.commandName);
    if (!cmd) return;

    if (!interaction.guild) {
        return interaction.reply('MockBot commands only work in a server.');
    }

    // Map slash options onto the same flat args array prefix commands use.
    const args = interaction.options.data.map(opt => String(opt.value));

    await runCommand(cmd, new Context({
        client, distube, config, commands,
        interaction,
        args,
    }));
});

async function runCommand(cmd, ctx) {
    try {
        if (cmd.ownerOnly && ctx.user.id !== process.env.OWNER) {
            return ctx.reply('⛔ Access denied — owner only.');
        }
        await cmd.execute(ctx);
    } catch (err) {
        console.error(`[command:${cmd.name}]`, err);
        try {
            await ctx.reply(`❌ Something went wrong: ${err.message}`);
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
