const fs = require('node:fs');
const path = require('node:path');

/**
 * Feedback log.
 *
 * Deliberately outside the git working tree: the old version appended to a
 * tracked feedback.txt at the repository root, and the `update` command's
 * `git stash && git stash drop` threw those appends away on every pull.
 * Everything lives under ./data (gitignored) instead.
 *
 * Storage backend: better-sqlite3 when it loaded (it is an optional
 * dependency — a Pi whose npm could not build it must still boot), the plain
 * text log otherwise. Both backends expose the same two operations the
 * commands use: append(line) and readAll(). When SQLite takes over, any text
 * log is imported once and left behind as feedback.txt.imported.
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const FILE = path.join(DATA_DIR, 'feedback.txt');
// v2 kept the log at the repo root; migrate it on first use.
const LEGACY_FILE = path.join(__dirname, '..', 'feedback.txt');
const DB_FILE = path.join(DATA_DIR, 'feedback.sqlite');
const IMPORTED_FILE = `${FILE}.imported`;

let Database = null;
try {
    // eslint-disable-next-line global-require
    Database = require('better-sqlite3');
} catch {
    Database = null;
}

const BACKEND = Database ? 'sqlite' : 'text';

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

/** @type {{stmts: {insert: import('better-sqlite3').Statement, count: import('better-sqlite3').Statement, lines: import('better-sqlite3').Statement}, handle: import('better-sqlite3').Database}|null} */
let db = null;

function openDb() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const handle = new Database(DB_FILE);
    handle.exec('CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL)');
    db = {
        handle,
        stmts: {
            insert: handle.prepare('INSERT INTO feedback (line) VALUES (?)'),
            count: handle.prepare('SELECT COUNT(*) AS n FROM feedback'),
            lines: handle.prepare('SELECT line FROM feedback ORDER BY id'),
        },
    };
    return db;
}

/** Pull whatever text logs exist into an empty database, then retire them. */
async function importTextLogs(bundle) {
    try {
        const rows = bundle.stmts.count.get().n;
        if (rows > 0) return;
    } catch {
        return;
    }

    await migrateLegacy();
    let content = null;
    try {
        content = (await fs.promises.readFile(FILE, 'utf8')).trim();
    } catch {
        return; // no log to import
    }
    if (!content) return;

    for (const line of content.split('\n')) {
        if (line.trim()) bundle.stmts.insert.run(line);
    }
    await fs.promises.rename(FILE, IMPORTED_FILE);
    console.log('[feedback] Imported data/feedback.txt into feedback.sqlite (kept as feedback.txt.imported)');
}

async function sqlite() {
    if (!db) {
        const bundle = openDb();
        await importTextLogs(bundle);
    }
    return db;
}

/** Append one feedback record (caller formats the line). */
async function append(line) {
    if (BACKEND === 'text') {
        await ensureDir();
        await migrateLegacy();
        await fs.promises.appendFile(FILE, `${line}\n`, 'utf8');
        return;
    }
    const bundle = await sqlite();
    bundle.stmts.insert.run(String(line ?? ''));
}

/** @returns {Promise<string|null>} the whole log, or null when there is none */
async function readAll() {
    if (BACKEND === 'text') {
        try {
            const content = (await fs.promises.readFile(FILE, 'utf8')).trim();
            return content || null;
        } catch {
            return null;
        }
    }
    const bundle = await sqlite();
    const lines = bundle.stmts.lines.all().map(r => r.line);
    return lines.length ? lines.join('\n') : null;
}

/** Close the database handle (Windows keeps open files from being deleted). */
function close() {
    try {
        db?.handle?.close();
    } catch {
        /* already closed */
    }
    db = null;
}
process.on?.('exit', close);

console.log(`[feedback] storage: ${BACKEND}${BACKEND === 'sqlite' ? '' : ' (better-sqlite3 unavailable — using the text log)'}`);

module.exports = {
    DATA_DIR,
    FILE,
    LEGACY_FILE,
    DB_FILE,
    IMPORTED_FILE,
    BACKEND,
    append,
    readAll,
    ensureDir,
    migrateLegacy,
    close,
};
