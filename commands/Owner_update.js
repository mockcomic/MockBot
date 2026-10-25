const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');
const { fenced } = require('../lib/respond');
const restartWarn = require('../lib/restartWarn');
const queueResume = require('../lib/queueResume');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * The systemd --user unit this deployment runs under; MOCKBOT_UNIT overrides
 * it for a differently-named install. Restarting the unit (rather than
 * killing ourselves and hoping) is how `update` applies itself.
 */
function restartCommand() {
    const unit = String(process.env.MOCKBOT_UNIT ?? 'mockbot').trim() || 'mockbot';
    const env = {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : undefined),
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS
            ?? (process.getuid ? `unix:path=/run/user/${process.getuid()}/bus` : undefined),
    };
    return { file: 'systemctl', args: ['--user', 'restart', unit], env };
}

/**
 * @returns {Promise<{ command: string, error: Error|null, stdout: string, stderr: string }>}
 */
function run(command, args) {
    return new Promise(resolve => {
        execFile(command, args, { cwd: REPO_ROOT, windowsHide: true }, (error, stdout, stderr) => {
            resolve({
                command: [command, ...args].join(' '),
                error,
                stdout: String(stdout ?? '').trim(),
                stderr: String(stderr ?? '').trim(),
            });
        });
    });
}

/**
 * Non-destructive pull.
 *
 * The old version ran `git stash` then `git stash drop`, which silently threw
 * away any local change on the bot's machine — including appended feedback
 * while it still lived in the working tree. Local edits are now stashed, the
 * pull is fast-forward only (no surprise merges), and the stash is put back.
 */
module.exports = {
    name: 'update',
    ownerOnly: true,
    description: 'Pull the latest bot code from git and restart the bot (local edits are stashed and restored)',
    usage: 'update [--no-restart]',
    data: new SlashCommandBuilder()
        .setName('update')
        .setDescription('Pull the latest bot code from git and restart the bot')
        .addBooleanOption(o => o.setName('no_restart').setDescription('Pull without bouncing the bot (restart manually later)')),

    async execute(ctx) {
        if (ctx.isSlash) await ctx.defer();

        const noRestart = ctx.isSlash
            ? Boolean(ctx.option('no_restart'))
            : ctx.args.includes('--no-restart');

        const report = [];
        let stashed = false;

        const status = await run('git', ['status', '--porcelain']);
        if (status.error) {
            return ctx.reply(`❌ \`git status\` failed: ${status.error.message}\n\n${fenced(status.stderr || status.stdout)}`);
        }
        const dirty = status.stdout.length > 0;

        if (dirty) {
            const stash = await run('git', ['stash', 'push', '-u', '-m', 'mockbot-update']);
            stashed = !stash.error;
            report.push(stash);
        }

        const pull = await run('git', ['pull', '--ff-only']);
        report.push(pull);

        if (stashed) {
            const pop = await run('git', ['stash', 'pop']);
            report.push(pop);
            if (pop.error) {
                report.push(await run('git', ['stash', 'list']));
            }
        }

        // Only reinstall when the pull actually touched dependency files.
        const changed = await run('git', ['diff', '--name-only', 'ORIG_HEAD', 'HEAD']);
        const depsChanged = /\bpackage(-lock)?\.json$/.test(changed.stdout);
        if (!changed.error && depsChanged) {
            report.push(await run('npm', ['install', '--no-audit', '--no-fund']));
        }

        const body = report
            .map(r => `$ ${r.command}\n${r.error ? `error: ${r.error.message}${r.stderr ? `\n${r.stderr}` : ''}` : (r.stderr || r.stdout || '(no output)')}`)
            .join('\n\n');

        const notes = [
            dirty ? 'Local edits were stashed and restored.' : '',
            stashed && report.at(-1)?.error ? 'git stash pop failed — your local copy is still in the stash; resolve before the next update.' : '',
            depsChanged ? 'Dependencies were reinstalled.' : '',
        ].filter(Boolean).join(' ');

        // A clean pull restarts the bot so the new code is live; a failed one
        // leaves the running version untouched. --no-restart stages the pull.
        const restartable = !pull.error && !stashed && !noRestart;
        if (pull.error) notes += ' The pull failed, so nothing changed and the bot was NOT restarted.';
        else if (stashed) notes += ' The stash pop conflicted, so the bot was NOT restarted — resolve it first.';
        else if (noRestart) notes += ' --no-restart: apply the changes with a manual restart.';

        if (!restartable) {
            return ctx.reply(`🔁 Update finished. ${notes}\n\n${fenced(body, { title: 'output' })}`);
        }

        await ctx.reply(`🔁 Update finished. ${notes} ♻️ Restarting MockBot in ${restartWarn.WARN_SECONDS} seconds…\n\n${fenced(body, { title: 'output' })}`);
        await restartWarn.warn(ctx.client, ctx.distube, ctx, 'update');
        await restartWarn.sleep(restartWarn.WARN_SECONDS * 1000);

        // Snapshot before we go, exactly like the SIGTERM handler does
        // (double-snapshot is harmless — persist() rewrites the same file).
        try {
            queueResume.snapshotAll(ctx.distube);
            queueResume.persist();
        } catch { /* a snapshot failure only costs the queues, not the restart */ }

        return new Promise(resolve => {
            const cmd = restartCommand();
            const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', env: cmd.env });
            child.on('error', err => {
                restartWarn.clearPending();
                resolve(ctx.send(`❌ Could not restart the bot: ${err.message}. Apply manually (systemctl --user restart mockbot).`));
            });
            child.on('close', code => {
                if (code !== 0) {
                    restartWarn.clearPending();
                    resolve(ctx.send(`❌ \`systemctl --user restart\` exited ${code}; apply manually.`));
                    return;
                }
                // systemd accepted it; it will SIGTERM us (or we exit now and
                // it restarts us). The SIGTERM handler snapshots + exits.
                resolve(undefined);
                process.kill(process.pid, 'SIGTERM');
            });
            child.unref();
        });
    },
};
