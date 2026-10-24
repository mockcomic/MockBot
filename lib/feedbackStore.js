const fs = require('node:fs');
const path = require('node:path');

/**
 * Feedback log.
 *
 * Deliberately outside the git working tree: the old version appended to a
 * tracked feedback.txt at the repository root, and the `update` command's
 * `git stash && git stash drop` threw those appends away on every pull.
 * Everything lives under ./data (gitignored) instead.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'feedback.txt');
// v2 kept the log at the repo root; migrate it on first use.
const LEGACY_FILE = path.join(__dirname, '..', 'feedback.txt');

async function ensureDir() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
}

/**
 * Move the legacy root-level log into ./data once, so an upgraded install
 * keeps the feedback it already collected. Best-effort: a failure here must
 * not stop new feedback from being written.
 */
async function migrateLegacy() {
    try {
        await fs.promises.access(FILE);
        return false; // new file already exists
    } catch {
        /* missing — try to migrate */
    }

    try {
        await fs.promises.rename(LEGACY_FILE, FILE);
        console.log('[feedback] Moved feedback.txt into data/');
        return true;
    } catch {
        return false; // nothing to migrate, or not permitted
    }
}

/** Append one feedback record (caller formats the line; we add the newline). */
async function append(line) {
    await ensureDir();
    await migrateLegacy();
    await fs.promises.appendFile(FILE, `${line}\n`, 'utf8');
}

/** @returns {Promise<string|null>} the whole log, or null when there is none */
async function readAll() {
    try {
        const content = (await fs.promises.readFile(FILE, 'utf8')).trim();
        return content || null;
    } catch {
        return null;
    }
}

module.exports = { DATA_DIR, FILE, LEGACY_FILE, append, readAll, ensureDir, migrateLegacy };
