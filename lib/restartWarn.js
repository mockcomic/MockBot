const fs = require('node:fs');
const path = require('node:path');

/**
 * Pre-restart warning + recovery announcement.
 *
 * `update` (which restarts the bot) and `reboot` (which restarts the host)
 * announce a 10-second heads-up to everyone actually using the bot: the
 * command channel plus the text channel of every live music queue. The list
 * of warned channels is written to a small pending file; on the next boot
 * bot.js consumes it (takePending) and posts "✅ back up" where a queue
 * resume message didn't already cover it.
 *
 * Deliberately forgiving: a channel that was deleted or denies us SEND
 * between snapshot and send costs one swallowed error, never the restart.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const PENDING_FILE = path.join(DATA_DIR, 'pending-restart.json');
const PENDING_MAX_AGE_MS = 10 * 60_000; // a stale record never announces recovery
const WARN_SECONDS = 10;

const MESSAGES = {
    update: '⚠️ MockBot is restarting to apply an update in **10 seconds** — music will pause and resume automatically.',
    reboot: '⚠️ The host is rebooting in **10 seconds** — music will stop and resume when MockBot is back.',
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Channels that must hear the warning, command channel first, deduped by id.
 * Queue channels come from DisTube's live queues (not the resume snapshots —
 * warn the people listening NOW).
 */
async function targetChannels(client, distube, ctx) {
    const seen = new Set();
    const out = [];
    const add = ch => {
        if (!ch?.id || seen.has(ch.id)) return;
        seen.add(ch.id);
        out.push(ch);
    };
    add(ctx.channel);
    for (const guild of client.guilds.cache.values()) {
        let queue = null;
        try {
            queue = distube.getQueue(guild.id) ?? null;
        } catch { /* a dead guild costs nothing */ }
        add(queue?.textChannel);
    }
    return out;
}

/** Post the warning everywhere and record who heard it. Never throws. */
async function warn(client, distube, ctx, kind) {
    const channels = await targetChannels(client, distube, ctx);
    const text = MESSAGES[kind] ?? MESSAGES.update;
    for (const ch of channels) {
        await ch.send?.(text).catch?.(() => {});
    }
    const record = { savedAt: Date.now(), kind, channelIds: channels.map(c => c.id) };
    try {
        fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
        fs.writeFileSync(PENDING_FILE, JSON.stringify(record), 'utf8');
    } catch (err) {
        console.warn(`[restartWarn] could not save the pending record: ${err.message}`);
    }
    return channels;
}

/** Remove the pending record (used when the restart turns out to be impossible). */
function clearPending() {
    try {
        fs.rmSync(PENDING_FILE, { force: true });
    } catch { /* nothing to clean */ }
}

/** Read + delete the pending record once, or null when absent/stale/corrupt. */
async function takePending() {
    let record;
    try {
        record = JSON.parse(await fs.promises.readFile(PENDING_FILE, 'utf8'));
    } catch {
        return null;
    } finally {
        clearPending();
    }
    if (!record || !Array.isArray(record.channelIds)
        || !Number.isFinite(record.savedAt)
        || Date.now() - record.savedAt > PENDING_MAX_AGE_MS) {
        return null;
    }
    return record;
}

module.exports = { PENDING_FILE, PENDING_MAX_AGE_MS, WARN_SECONDS, sleep, targetChannels, warn, takePending, clearPending };
