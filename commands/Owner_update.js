const { execFile } = require('node:child_process');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');
const { fenced } = require('../lib/respond');
const restartWarn = require('../lib/restartWarn');
const queueResume = require('../lib/queueResume');
const supervisor = require('../lib/supervisor');

const REPO_ROOT = path.join(__dirname, '..');

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

        // Ask whatever actually supervises this process (pm2 id > systemd
        // unit) to bounce us; see lib/supervisor.js.
        const restart = await supervisor.plan();
        if (!restart.file) {
            restartWarn.clearPending();
            return ctx.send('✅ Update finished, but I could not find my supervisor (neither pm2 nor a systemd user unit) — restart the bot manually to apply.');
        }
        return new Promise(resolve => {
            supervisor.spawnDetected(restart).then(result => {
                if (!result.ok) {
                    restartWarn.clearPending();
                    resolve(ctx.send(`❌ Could not restart via ${restart.label}: ${result.error}. Apply manually.`));
                    return;
                }
                // The supervisor took it from here: it will SIGTERM us (or we
                // exit now and it starts the replacement). Either way the
                // SIGTERM handler snapshots and exits cleanly.
                resolve(undefined);
                process.kill(process.pid, 'SIGTERM');
            });
        });
    },
};
