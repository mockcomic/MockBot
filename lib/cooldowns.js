/**
 * In-memory per-user-per-command cooldowns.
 *
 * Enforced centrally in bot.js `runCommand` (owner exempt) and by the button
 * dispatcher for control spam. Nothing here needs to survive a restart —
 * the worst a restart can cost is one free extra command.
 */

/** @type {Map<string, number>} key `userId:name` → ms timestamp of last pass */
const last = new Map();

/**
 * Sliding check: pass when `seconds` have elapsed since the user's last pass
 * for this key, and record the pass. seconds <= 0 always passes.
 */
function check(userId, name, seconds) {
    const limit = Number(seconds) || 0;
    if (limit <= 0) return true;
    const key = `${userId}:${name}`;
    const now = Date.now();
    const previous = last.get(key);
    if (previous !== undefined && now - previous < limit * 1000) return false;
    last.set(key, now);
    return true;
}

/** Forget entries older than a minute so the map cannot grow unbounded. */
const sweep = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [key, at] of last) if (at < cutoff) last.delete(key);
}, 30_000);
sweep.unref?.();

module.exports = { check, last, __reset: () => last.clear() };
