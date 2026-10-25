const { spawn } = require('node:child_process');
const { SlashCommandBuilder } = require('discord.js');

/**
 * Platform-aware host reboot.
 *
 * This command reboots the whole machine, not just the bot — worth being loud
 * about, because the documented deployment is a headless Raspberry Pi. The old
 * `shutdown /r` was Windows-only and did nothing useful on Linux.
 */
function plan() {
    if (process.platform === 'win32') {
        return { label: 'Windows', primary: ['shutdown', ['/r', '/t', '5']], fallback: null };
    }
    if (process.platform === 'darwin') {
        return { label: 'macOS', primary: ['/sbin/shutdown', ['-r', '+1']], fallback: null };
    }
    // Linux (the Raspberry Pi target): logind first, sysv shutdown as backup.
    return { label: 'Linux', primary: ['systemctl', ['reboot']], fallback: ['shutdown', ['-r', 'now']] };
}

function attempt([file, args]) {
    return new Promise(resolve => {
        const child = spawn(file, args, { stdio: 'ignore' });
        child.on('error', err => resolve({ ok: false, error: err.message }));
        child.on('close', code => {
            resolve(code === 0
                ? { ok: true }
                : { ok: false, error: `${file} exited with code ${code}${process.getuid?.() === 0 ? '' : ' (may need root: try sudo)'}` },
            );
        });
    });
}

module.exports = {
    name: 'reboot',
    ownerOnly: true,
    description: 'Reboot the machine the bot runs on',
    usage: 'reboot',
    data: new SlashCommandBuilder().setName('reboot').setDescription('Reboot the machine the bot runs on'),

    async execute(ctx) {
        const os = plan();
        const restartWarn = require('../lib/restartWarn');
        await restartWarn.warn(ctx.client, ctx.distube, ctx, 'reboot');
        await ctx.reply(
            `⚠️ Rebooting the **host machine** (${os.label}) in ${restartWarn.WARN_SECONDS} seconds — this stops everything else running on it, ` +
            'not just the bot. Back in a moment :(',
        );
        await restartWarn.sleep(restartWarn.WARN_SECONDS * 1000);

        const first = await attempt(os.primary);
        if (first.ok) return undefined;

        // The host is not going down after all: the next boot must not post a
        // bogus "back up" for a restart that never happened.
        restartWarn.clearPending();
        if (os.fallback) {
            const second = await attempt(os.fallback);
            if (second.ok) return undefined;
            return ctx.send(`❌ Reboot failed: ${first.error} / fallback: ${second.error}`);
        }

        return ctx.send(`❌ Reboot failed: ${first.error}`);
    },
};
