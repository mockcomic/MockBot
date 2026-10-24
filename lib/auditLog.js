const fs = require('node:fs');
const path = require('node:path');

/**
 * Append-only audit trail of everything the web portal changed, so a config
 * edit that surprised somebody can be traced to a time. Newest entries first
 * when read; capped so the file cannot grow without bound on a Pi's SD card.
 *
 * Lines: `ISO_TIMESTAMP <actor> <action> <detail>`
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'audit.log');
const MAX_LINES = 500;
const MAX_DETAIL = 300;

/** One line of the trail. Never throws — an audit failure must not fail the change. */
async function record(actor, action, detail = '') {
    const stamp = new Date().toISOString();
    const safeDetail = String(detail)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, MAX_DETAIL);
    const line = `${stamp} ${String(actor).replace(/\s+/g, '_')} ${String(action).replace(/\s+/g, '_')} ${safeDetail}`.trimEnd();
    try {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        await fs.promises.appendFile(FILE, `${line}\n`, 'utf8');
    } catch (err) {
        console.warn(`[audit] could not append: ${err.message}`);
    }
}

/** Newest first, at most `limit` lines. */
async function read(limit = 100) {
    let content;
    try {
        content = await fs.promises.readFile(FILE, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(-Math.max(1, limit))
        .reverse();
}

module.exports = { FILE, DATA_DIR, record, read };
