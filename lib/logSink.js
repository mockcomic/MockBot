const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

/**
 * Persistent file log sink.
 *
 * console.log/warn/error are patched so every line the bot already writes
 * (boot, commands, [client] errors, [unhandledRejection]…) is ALSO appended
 * to a timestamped rolling file. The journal dies with the container; this
 * file survives restarts so errors can be read after the fact — from disk,
 * via the owner-only `logs` command, or in the web portal.
 *
 * Rotation: when the active file passes MAX_BYTES it is renamed
 * `mockbot.log.1` (shifting .1→.2 … up to KEEP archives), so the footprint is
 * bounded to (KEEP+1) × MAX_BYTES ≈ a few MB even on a Pi SD card.
 *
 * Fail-safe by design: any write error disables the sink and restores the
 * original console methods once, so the file log can never take the bot down
 * or start spamming errors itself.
 *
 * Format: `ISO_TIMESTAMP LEVEL message` — stack traces continue on indented
 * lines so a reader (and the `logs` command / portal) can group them.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const DIR = process.env.MOCKBOT_LOG_DIR
    ? path.resolve(process.env.MOCKBOT_LOG_DIR)
    : path.join(DATA_DIR, 'logs');

const FILE = path.join(DIR, 'mockbot.log');
const MAX_BYTES = Number(process.env.MOCKBOT_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
const KEEP = Number(process.env.MOCKBOT_LOG_KEEP ?? 3);
const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

let enabled = false;
let bytesSinceRotate = 0;
const originals = {};

/** Append one formatted entry (message + any Error stacks), never throws. */
function writeLine(level, args) {
    const stamp = new Date().toISOString();
    let text;
    try {
        text = util.format(...args);
    } catch {
        text = String(args);
    }
    const lines = String(text).split('\n');
    const head = `${stamp} ${level} ${lines[0]}\n`;
    const rest = lines.slice(1).map(l => `    ${l}\n`).join('');
    const entry = head + rest;

    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(FILE, entry, 'utf8');
        bytesSinceRotate += Buffer.byteLength(entry);
        if (bytesSinceRotate >= MAX_BYTES) rotate();
    } catch (err) {
        disable();
        originals.error.call(
            console,
            `[logSink] file logging disabled after write failure: ${err.message} (dir: ${DIR})`,
        );
    }
}

/** mockbot.log -> .1, .1 -> .2 … oldest beyond KEEP is dropped. */
function rotate() {
    try {
        fs.rmSync(`${FILE}.${KEEP}`, { force: true });
        for (let i = KEEP - 1; i >= 1; i -= 1) {
            if (fs.existsSync(`${FILE}.${i}`)) fs.renameSync(`${FILE}.${i}`, `${FILE}.${i + 1}`);
        }
        if (fs.existsSync(FILE)) fs.renameSync(FILE, `${FILE}.1`);
        bytesSinceRotate = 0;
    } catch (err) {
        // A failed rotation only risks an oversized file, not a crash.
        originals.warn.call(console, `[logSink] rotation failed: ${err.message}`);
    }
}

/** One-liner variant for the audit-style trail (portal/records). */
function audit(action, detail = '') {
    const safe = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300);
    const args = [`[audit] ${String(action).replace(/\s+/g, '_')} ${safe}`];
    if (enabled) writeLine('INFO', args);
    else originals.log.call(console, ...args);
}

function disable() {
    if (!enabled) return;
    enabled = false;
    for (const key of Object.keys(LEVELS)) {
        if (originals[key]) console[key] = originals[key];
    }
}

/**
 * Start teeing the console to the file. Idempotent; call once at boot, as
 * early as possible so the login attempt itself is captured.
 */
function start() {
    if (enabled) return FILE;
    for (const key of Object.keys(LEVELS)) {
        originals[key] = console[key].bind(console);
        const level = LEVELS[key];
        console[key] = (...args) => {
            originals[key](...args); // keep stdout/journal output unchanged
            writeLine(level, args);
        };
    }
    enabled = true;
    try {
        fs.mkdirSync(DIR, { recursive: true });
    } catch (err) {
        disable();
        originals.error.call(console, `[logSink] could not create ${DIR}: ${err.message}`);
        return FILE;
    }
    writeLine('INFO', [`[logSink] file logging started (${FILE}, cap ${Math.round(MAX_BYTES / 1024)} KB × ${KEEP + 1} files)`]);
    return FILE;
}

/** Raw append for pre-start messages (boot failures that must still persist). */
function emergency(line) {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.appendFileSync(FILE, `${new Date().toISOString()} FATAL ${line}\n`, 'utf8');
    } catch { /* nothing left to do */ }
}

/** Newest `limit` lines across the active file (+ newest archive if needed). */
async function tail(limit = 200) {
    const wanted = Math.max(1, Math.min(limit, 5000));
    const files = [FILE, ...Array.from({ length: KEEP }, (_, i) => `${FILE}.${i + 1}`)];
    const out = [];
    for (const f of files) {
        if (out.length >= wanted) break;
        let content;
        try {
            content = await fs.promises.readFile(f, 'utf8');
        } catch {
            continue; // missing archive is normal
        }
        const lines = content.replace(/\n+$/, '').split('\n');
        out.unshift(...lines.slice(-wanted * 2));
    }
    return out.slice(-wanted);
}

module.exports = { DIR, FILE, start, emergency, tail, audit };
