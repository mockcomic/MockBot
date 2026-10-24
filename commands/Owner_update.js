const { execFile } = require('node:child_process');
const path = require('node:path');
const { SlashCommandBuilder } = require('discord.js');
const { fenced } = require('../lib/respond');

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
    description: 'Pull the latest bot code from git (local edits are stashed and restored)',
    usage: 'update',
    data: new SlashCommandBuilder().setName('update').setDescription('Pull the latest bot code from git'),

    async execute(ctx) {
        if (ctx.isSlash) await ctx.defer();

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

        report.push(await run('git', ['pull', '--ff-only']));

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
            'Restart the bot to apply changes.',
            dirty ? 'Local edits were stashed and restored.' : '',
            stashed && report.at(-1)?.error ? 'git stash pop failed — your local copy is still in the stash; resolve before the next update.' : '',
            depsChanged ? 'Dependencies were reinstalled.' : '',
        ].filter(Boolean).join(' ');

        return ctx.reply(`🔁 Update finished. ${notes}\n\n${fenced(body, { title: 'output' })}`);
    },
};
