const fs = require('node:fs');
const path = require('node:path');

/**
 * Soundboard file management — the disk half behind commands/sfx.js.
 *
 * Clips live in DATA_DIR/sounds/ as flat files. Names are validated to a safe
 * charset on every path (list, play, delete), so a name coming from chat can
 * never escape the folder (`..`, slashes, absolute paths) and a hand-dropped
 * file with a weird name is invisible rather than dangerous.
 *
 * Only playback ordering lives here; playing goes through DisTube by
 * hand-building a Song whose stream is the local path (ffmpeg accepts file
 * inputs exactly like URLs).
 */

const DATA_DIR = process.env.MOCKBOT_DATA_DIR
    ? path.resolve(process.env.MOCKBOT_DATA_DIR)
    : path.join(__dirname, '..', 'data');

const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,38}$/; // no '..' path games possible
const EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.opus', '.flac']);
const MAX_BYTES = 10 * 1024 * 1024;   // a Pi SD card plus a Discord-safe clip
const MAX_CLIPS = 100;

function soundPath(name) {
    const clean = String(name ?? '').toLowerCase().replace(/\.+(mp3|ogg|wav|m4a|aac|opus|flac)$/i, '');
    if (!NAME_RE.test(clean)) return null;
    return path.join(SOUND_DIR, clean);
}

/** Existing clip file for a bare name, or null. */
function resolveClip(name) {
    const base = soundPath(name);
    if (!base) return null;
    for (const ext of EXTS) {
        const file = `${base}${ext}`;
        try {
            if (fs.statSync(file).isFile()) return { name: path.basename(base), file, sizeBytes: fs.statSync(file).size };
        } catch { /* not this extension */ }
    }
    return null;
}

/** Every valid clip, sorted by name. Unreadable or oversized files are skipped. */
function list() {
    let entries;
    try {
        entries = fs.readdirSync(SOUND_DIR);
    } catch {
        return [];
    }
    const clips = [];
    for (const entry of entries) {
        const clip = resolveClip(entry);
        if (clip) clips.push(clip);
    }
    return clips.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_CLIPS);
}

/**
 * Copy a buffer into the board. Validates name, extension, size and count.
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
function save(name, buffer, { extension }) {
    const base = soundPath(name);
    if (!base) return { ok: false, error: 'A clip name is 1-39 characters: letters, numbers, dot, dash, underscore.' };
    const ext = String(extension ?? '').toLowerCase();
    if (!EXTS.has(ext)) return { ok: false, error: `Unsupported audio format ${ext || '(none)'} — allowed: ${[...EXTS].join(', ')}` };
    if (!buffer?.length) return { ok: false, error: 'That file is empty.' };
    if (buffer.length > MAX_BYTES) return { ok: false, error: `That file is ${(buffer.length / 1048576).toFixed(1)} MB — clips are capped at ${MAX_BYTES / 1048576} MB.` };

    const already = resolveClip(name);
    if (already && `${base}${ext}` !== already.file) {
        return { ok: false, error: `\`${already.name}\` already exists as a .${already.file.split('.').pop()} clip — delete it first.` };
    }
    if (!already && list().length >= MAX_CLIPS) {
        return { ok: false, error: `The board holds ${MAX_CLIPS} clips — delete one with \`sfx del <name>\`.` };
    }

    try {
        fs.mkdirSync(SOUND_DIR, { recursive: true });
        if (already) fs.rmSync(already.file, { force: true }); // replaces same-name, possibly other ext
        fs.writeFileSync(`${base}${ext}`, buffer);
    } catch (err) {
        return { ok: false, error: `Could not write the clip: ${err.message}` };
    }
    return { ok: true, name: path.basename(base) };
}

/** @returns {{ok: true, deleted: string} | {ok: false, error: string}} */
function remove(name) {
    const clip = resolveClip(name);
    if (!clip) return { ok: false, error: `No clip named \`${String(name).slice(0, 40)}\` on the board.` };
    try {
        fs.rmSync(clip.file);
    } catch (err) {
        return { ok: false, error: `Could not delete it: ${err.message}` };
    }
    return { ok: true, deleted: clip.name };
}

module.exports = {
    SOUND_DIR,
    NAME_RE,
    EXTS,
    MAX_BYTES,
    MAX_CLIPS,
    soundPath,
    resolveClip,
    list,
    save,
    remove,
};
