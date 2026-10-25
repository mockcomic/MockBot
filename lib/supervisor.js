const { spawn } = require('node:child_process');

/**
 * How this process gets restarted, whichever supervisor actually owns it.
 *
 * Deployments differ: some run `systemctl --user` units, some run pm2 (which
 * is how the bot behaves when a host has no lingering systemd user session).
 * Hard-coding one made `!update` restarts fail with exit 1 on the pm2 box,
 * and a host `reboot` needs privileges pm2 children don't have. So ask the
 * process environment instead of guessing:
 *
 *   1. pm2-managed (process.env.pm_id is set by pm2) → `pm2 restart <id>` —
 *      the numeric id always addresses this exact app, even if renamed.
 *   2. systemd user unit (MOCKBOT_UNIT, default `mockbot`) that reports
 *      active → `systemctl --user restart <unit>`.
 *   3. nothing detected → no supervisor to bounce us; the caller must say
 *      "restart manually" instead of killing an unsupervised process.
 *
 * `plan()` is pure (everything probed is injected) so the smoke test can
 * cover all three branches without a pm2 or systemd present.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runProbe(file, args, env = process.env) {
    return new Promise(resolve => {
        let out = '';
        let child;
        try {
            child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], env });
        } catch {
            return resolve(false);
        }
        child.stdout.on('data', d => { out += d; });
        child.on('error', () => resolve(false));
        child.on('close', code => resolve(code === 0 && out.trim() === 'active'));
    });
}

/** Env of a detached restart helper: systemctl --user needs the user bus. */
function systemdEnv(env = process.env) {
    const out = { ...env };
    if (!out.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
        out.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
    }
    if (!out.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === 'function') {
        out.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid()}/bus`;
    }
    return out;
}

/**
 * @param {object} [probe] test seam
 * @param {object} [probe.env] environment to inspect (default process.env)
 * @param {(file:string,args:string[],env:object)=>Promise<boolean>} [probe.systemctlActive]
 */
async function plan(probe = {}) {
    const env = probe.env ?? process.env;
    const unit = String(env.MOCKBOT_UNIT ?? 'mockbot').trim() || 'mockbot';

    if (env.pm_id !== undefined && String(env.pm_id).trim() !== '') {
        return { label: `pm2 (app id ${env.pm_id})`, file: 'pm2', args: ['restart', String(env.pm_id), '--update-env'], env };
    }

    const isActive = probe.systemctlActive
        ?? ((f, a, e) => runProbe(f, a, e));
    if (await isActive('systemctl', ['--user', 'is-active', unit], env)) {
        return { label: `systemd unit ${unit}`, file: 'systemctl', args: ['--user', 'restart', unit], env: systemdEnv(env) };
    }

    return { label: null, file: null, args: null, env: null };
}

/** Spawn a restart helper detached: it must outlive us. */
function spawnDetected(restart) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(restart.file, restart.args, { detached: true, stdio: 'ignore', env: restart.env });
        } catch (err) {
            return resolve({ ok: false, error: err.message });
        }
        child.on('error', err => resolve({ ok: false, error: err.message }));
        child.on('close', code => resolve(code === 0
            ? { ok: true }
            : { ok: false, error: `${restart.file} exited with code ${code}` }));
        child.unref();
    });
}

module.exports = { plan, spawnDetected, systemdEnv, sleep };
