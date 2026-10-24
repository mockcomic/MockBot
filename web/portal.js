const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Admin web portal, served by the bot process itself.
 *
 * Read: bot status, per-server detail (members, channels, boosts, voice),
 * music state with remote controls, most-used commands, feedback, and the
 * audit trail of everything this page changed.
 *
 * Write: global params (prefix, cooldowns, idle-leave, vote-skip/autoplay
 * defaults, reaction roles), per-guild overrides, and command toggles that
 * switch commands on/off globally or per server. Writes go through
 * lib/runtimeConfig (config.json + DATA_DIR/runtime-config.json, applied in
 * place so the running bot honours them without a restart), lib/guildSettings
 * and lib/commandToggles, and every one is recorded in lib/auditLog.
 *
 * Security model:
 *   - Login is WEB_USER + WEB_PASS (or WEB_PASS_HASH, a hex sha256, so the
 *     .env can hold a digest instead of the password). Constant-time compares
 *     on both. Optional WEB_USERS="alice:hash,bob:hash" for named accounts —
 *     then the audit log names who changed what.
 *   - Sessions are in-memory random 32-byte tokens in an HttpOnly,
 *     SameSite=Strict cookie, sliding 12h expiry, capped count, bound to a
 *     hash of the user agent (a stolen cookie from another browser is dead).
 *   - Every state-changing POST needs the CSRF token issued with the session
 *     in an X-CSRF-Token header — SameSite is the first wall, this is the second.
 *   - Login is throttled per source address and the throttle itself grows;
 *     API mutations are rate-limited too.
 *   - WEB_ALLOWLIST (comma-separated address prefixes, e.g. "127.,192.168.0.")
 *     hard-gates which addresses may reach the portal at all.
 *   - WEB_TLS_CERT/WEB_TLS_KEY serve HTTPS directly and flip the cookie
 *     `Secure` flag (WEB_SECURE=1 forces the flag behind a TLS proxy).
 *   - CSP locks the page down: no external resources, inline styles/scripts
 *     only (the page is one file on purpose — the reference deployment is a
 *     Raspberry Pi and there are no npm dependencies to serve).
 *   - Remote text (song titles, feedback, guild names) reaches the DOM only
 *     via JSON + textContent, so it cannot inject markup.
 *
 * Enabled only when WEB_USER and (WEB_PASS or WEB_PASS_HASH or WEB_USERS) are
 * present. A bind failure costs a log line, never the bot.
 */

const DEFAULT_BIND = '0.0.0.0'; // all interfaces: reachable on the local network
const DEFAULT_PORT = 8787;
const COOKIE_NAME = 'mockbot_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h, refreshed on use
const MAX_SESSIONS = 32;
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_LIMIT = 10; // failed logins per window before a 429
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const API_LIMIT = 240; // requests per window per address (UI polls every 10 s)
const API_WINDOW_MS = 5 * 60 * 1000;
const FEEDBACK_LIMIT = 200; // newest lines the portal will show
const AUDIT_LIMIT = 100;
const STATUS_REFRESH_MS = 10000;

const REPEAT_LABELS = ['off', 'song', 'queue'];

/**
 * Editable global params. `path` is a dot-path into config; the portal can
 * only touch what is listed here, and values are coerced/clamped before they
 * reach lib/runtimeConfig.
 */
const SETTINGS_SCHEMA = [
    {
        path: 'prefix', label: 'Default command prefix', type: 'string',
        maxLen: 5, hint: 'Used unless a server sets its own with the prefix command.',
    },
    {
        path: 'cooldowns.default', label: 'Default cooldown (seconds)', type: 'int',
        min: 0, max: 3600, hint: 'Per user per command. 0 disables. Owner is exempt.',
    },
    {
        path: 'cooldowns.play', label: 'Play cooldown (seconds)', type: 'int',
        min: 0, max: 3600, hint: 'The heavier search+stream command gets its own window.',
    },
    {
        path: 'music.leaveOnEmptyAfterSeconds', label: 'Leave empty voice after (seconds)', type: 'int',
        min: 0, max: 86400, hint: '0 = never auto-leave (server 24/7 overrides still apply).',
    },
    {
        path: 'music.voteSkipEnabled', label: 'Vote skip required by default', type: 'bool',
        hint: 'Servers can opt in/out per guild; requester and owner always skip outright.',
    },
    {
        path: 'music.autoplayByDefault', label: 'Autoplay on by default', type: 'bool',
        hint: 'Queue the YouTube radio mix when a queue runs dry. Per-guild override wins.',
    },
    {
        path: 'reactionRoles.enabled', label: 'Reaction roles system', type: 'bool',
        hint: 'Master switch for the emoji-to-role listener.',
    },
];

const ROLES_PATH = 'reactionRoles.roles';

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

/** Length-independent constant-time compare (both sides are 32-byte digests). */
function matchesSecret(given, expectedHash) {
    return crypto.timingSafeEqual(sha256(given), expectedHash);
}

/** Compare a lowercase hex digest string without leaking its content/length. */
function matchesHexDigest(given, expectedHex) {
    let expected;
    try {
        expected = Buffer.from(String(expectedHex).toLowerCase(), 'hex');
    } catch {
        return false;
    }
    if (expected.length !== 32) return false;
    return crypto.timingSafeEqual(sha256(given), expected);
}

function parseCookies(header) {
    const out = Object.create(null);
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function esc(text) {
    return String(text)
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function loginPage(error, csrfField) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>MockBot admin — sign in</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;background:#111418;color:#e6e8ea;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1b2026;border:1px solid #2c333b;border-radius:10px;padding:28px 32px;width:min(320px,90vw)}
h1{font-size:17px;margin:0 0 18px}
label{display:block;font-size:13px;color:#9aa4ae;margin-bottom:4px}
input{box-sizing:border-box;width:100%;margin-bottom:12px;padding:8px 10px;border-radius:6px;border:1px solid #2c333b;background:#111418;color:#e6e8ea}
button{width:100%;padding:9px;border:0;border-radius:6px;background:#5865f2;color:#fff;font:inherit;cursor:pointer}
.error{color:#f2a3a3;font-size:13px;margin:0 0 12px}
</style>
</head>
<body>
<main>
<h1>MockBot admin</h1>
${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/login">
<input type="hidden" name="csrf" value="${esc(csrfField)}">
<label for="user">Username</label>
<input id="user" name="user" autocomplete="username" required>
<label for="pass">Password</label>
<input id="pass" name="pass" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
</main>
</body>
</html>`;
}

const DASHBOARD_CSS = `
body{font:15px/1.5 system-ui,sans-serif;background:#111418;color:#e6e8ea;margin:0;padding:0 0 40px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:980px;margin:0 auto;padding:18px 24px 0}
h1{font-size:17px;margin:0}
nav{display:flex;gap:6px;max-width:980px;margin:14px auto 18px;padding:0 24px;flex-wrap:wrap}
nav button{padding:7px 14px;border:1px solid #2c333b;border-radius:999px;background:#1b2026;color:#c7ccd1;font:inherit;cursor:pointer}
nav button.on{background:#5865f2;border-color:#5865f2;color:#fff}
main{display:grid;gap:14px;max-width:980px;margin:0 auto;padding:0 24px}
section{background:#1b2026;border:1px solid #2c333b;border-radius:10px;padding:16px 18px}
h2{font-size:14px;margin:0 0 10px;color:#9aa4ae;text-transform:uppercase;letter-spacing:.04em}
h3{font-size:14px;margin:16px 0 6px;color:#9aa4ae}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
dt{color:#9aa4ae}dd{margin:0}
ul,ol{margin:0;padding-left:20px}
li{margin:4px 0;overflow-wrap:anywhere}
.muted{color:#9aa4ae}
a{color:#8ea1ff}
button.act{padding:5px 10px;border:0;border-radius:6px;background:#5865f2;color:#fff;font:inherit;cursor:pointer}
button.act.sec{background:#2c333b;color:#c7ccd1}
input,select,textarea{box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #2c333b;background:#111418;color:#e6e8ea;font:inherit}
textarea{width:100%;min-height:110px;font-family:ui-monospace,monospace;font-size:13px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.row label{color:#9aa4ae;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:#9aa4ae;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:4px 6px;border-bottom:1px solid #2c333b}
td{padding:6px;border-bottom:1px solid #232a31;vertical-align:middle}
td.n{text-align:right;color:#9aa4ae;font-variant-numeric:tabular-nums}
label.sw{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:#2c333b;color:#9aa4ae}
.badge.on{background:#2a4d2e;color:#a6e3a1}
.badge.off{background:#4d2a2a;color:#f2a3a3}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.card{border:1px solid #2c333b;border-radius:8px;padding:10px 12px;background:#171b20;cursor:pointer}
.card.on{border-color:#5865f2}
pre{background:#111418;border:1px solid #2c333b;border-radius:6px;padding:10px;overflow:auto;font-size:12px}
.toast{position:fixed;bottom:18px;right:18px;background:#5865f2;color:#fff;padding:10px 16px;border-radius:8px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
`;

const DASHBOARD_JS = String.raw`
'use strict';
var CSRF = document.body.getAttribute('data-csrf');
var $ = function (id) { return document.getElementById(id); };
function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
}
function clear(n) { n.textContent = ''; return n; }
function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2500);
}
async function get(path) {
    var r = await fetch(path, { cache: 'no-store' });
    if (r.status === 401) { window.location = '/login'; throw new Error('signed out'); }
    if (!r.ok) throw new Error((await r.text().catch(function () { return ''; })) || ('HTTP ' + r.status));
    return r.json();
}
async function post(path, body) {
    var r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
        body: JSON.stringify(body || {}),
    });
    if (r.status === 401) { window.location = '/login'; throw new Error('signed out'); }
    var data = await r.json().catch(function () { return { ok: r.ok }; });
    if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
    toast(data.message || 'saved');
    return data;
}
function fmtUptime(total) {
    var d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm ' + s + 's';
}
function fmtDate(ms) { return new Date(ms).toLocaleString(); }
function dl(node, rows) {
    clear(node);
    rows.forEach(function (row) { node.appendChild(el('dt', row[0])); node.appendChild(el('dd', row[1] === null || row[1] === undefined ? 'n/a' : String(row[1]))); });
}

var current = { tab: 'overview', guildId: null, guilds: null };

var TABS = ['overview', 'servers', 'commands', 'settings', 'feedback', 'audit'];
function showTab(name) {
    current.tab = name;
    TABS.forEach(function (t) {
        var sec = $('tab-' + t); if (sec) sec.style.display = t === name ? '' : 'none';
        var nav = $('nav-' + t); if (nav) nav.className = t === name ? 'on' : '';
    });
    var loaders = { overview: loadOverview, servers: loadServers, commands: loadCommandsTab, settings: loadSettings, feedback: loadFeedback, audit: loadAudit };
    if (loaders[name]) loaders[name]().catch(function (e) { toast('load failed: ' + e.message); });
}
TABS.forEach(function (t) {
    document.addEventListener('DOMContentLoaded', function () {
        var b = $('nav-' + t); if (b) b.addEventListener('click', function () { showTab(t); });
    });
});

// ---- overview ---------------------------------------------------------------
async function loadOverview() {
    var st = await get('/api/status');
    dl($('status'), [
        ['Signed in as', st.user.tag],
        ['Version', st.version + ' · node ' + st.node],
        ['Uptime', fmtUptime(st.user.uptimeSeconds)],
        ['Gateway ping', st.user.wsPing === null ? 'n/a' : st.user.wsPing + ' ms'],
        ['Memory (rss)', st.process.memoryRssMb + ' MB'],
        ['Guilds', String(st.guilds)],
        ['Commands loaded', st.commands.total + ' (' + st.commands.disabled + ' disabled globally)'],
        ['Total executions', String(st.usage.grandTotal)],
        ['Portal user', st.session.actor],
    ]);
    var ul = clear($('music'));
    if (!st.music.length) { ul.appendChild(el('li', 'no active queue', 'muted')); }
    st.music.forEach(function (m) {
        var li = el('li');
        li.appendChild(el('strong', m.guild + ': '));
        if (m.playing) {
            li.appendChild(document.createTextNode(m.playing.name));
            var bits = [];
            if (m.playing.requestedBy) bits.push('requested by ' + m.playing.requestedBy);
            if (m.playing.duration) bits.push(m.playing.duration);
            if (m.playing.live) bits.push('LIVE');
            bits.push('vol ' + m.volume + ', repeat ' + m.repeatMode + ', ' + m.queued + ' queued');
            li.appendChild(el('span', ' — ' + bits.join(', '), 'muted'));
        } else {
            li.appendChild(el('span', 'queue idle', 'muted'));
        }
        ul.appendChild(li);
    });
    var top = clear($('topOverall'));
    if (!st.usage.top.length) { top.appendChild(el('li', 'no commands used yet', 'muted')); }
    st.usage.top.forEach(function (row) { top.appendChild(el('li', row.name + ' — ' + row.count + '×')); });
    $('ownerWarn').style.display = st.owner.set ? 'none' : '';
    $('ownerWarn').textContent = 'OWNER is not set in .env — owner-only commands are unreachable and the portal is the only admin surface.';
}

// ---- servers ----------------------------------------------------------------
async function loadServers() {
    var data = await get('/api/guilds' + (current.guildId ? '?id=' + encodeURIComponent(current.guildId) : ''));
    current.guilds = data.guilds;
    var grid = clear($('guildGrid'));
    data.guilds.forEach(function (g) {
        var card = el('div', null, 'card' + (g.id === current.guildId ? ' on' : ''));
        card.appendChild(el('strong', g.name));
        card.appendChild(el('div', g.memberCount + ' members · ' + g.channelCount + ' channels', 'muted'));
        card.appendChild(el('button', 'Manage', 'act'));
        card.querySelector('button').addEventListener('click', function () {
            current.guildId = g.id; loadServers();
        });
        grid.appendChild(card);
    });
    if (!data.guilds.length) grid.appendChild(el('p', 'the bot is in no servers', 'muted'));

    var detail = clear($('guildDetail'));
    var sel = data.selected;
    if (!sel) { detail.appendChild(el('p', 'pick a server above', 'muted')); return; }
    dl(detail, [
        ['Name', sel.name], ['ID', sel.id],
        ['Owner', sel.ownerTag + ' (' + sel.ownerId + ')'],
        ['Member count', String(sel.memberCount)],
        ['Channels', sel.channelCount + ' (' + sel.voiceChannels + ' voice)'],
        ['Boost tier', sel.premiumTier + ' (' + sel.premiumCount + ' boosts)'],
        ['Joined', fmtDate(sel.joinedAt)], ['Created', fmtDate(sel.createdAt)],
        ['Bot permissions', sel.permissions],
    ]);

    var form = clear($('guildSettingsForm'));
    form.appendChild(el('h3', 'Server settings'));
    function field(labelText, id, value, kind) {
        var row = el('div', null, 'row');
        row.appendChild(el('label', labelText));
        var input = el('input');
        input.id = id;
        if (kind === 'check') { input.type = 'checkbox'; input.checked = Boolean(value); }
        else { input.value = value === null || value === undefined ? '' : String(value); if (kind === 'number') input.type = 'number'; }
        row.appendChild(input);
        form.appendChild(row);
        return input;
    }
    var prefixIn = field('Prefix (blank = global)', 'g-prefix', sel.settings.prefix, 'text');
    var g247 = field('24/7 — never auto-leave', 'g-247', sel.settings.twentyFourSeven, 'check');
    var gAuto = field('Autoplay override', 'g-autoplay', sel.settings.autoplay, 'text');
    var gVote = field('Vote-skip override (true/false)', 'g-voteskip', sel.settings.voteSkip, 'text');
    var gMod = field('Modlog channel ID', 'g-modlog', sel.settings.modlogChannelId, 'text');
    var saveBtn = el('button', 'Save server settings', 'act');
    saveBtn.addEventListener('click', async function () {
        function tri(v) { v = (v || '').trim().toLowerCase(); return v === '' ? null : (v === 'true' || v === 'on' || v === '1' || v === 'yes'); }
        await post('/api/guild/settings', {
            guildId: sel.id,
            patch: {
                prefix: (prefixIn.value || '').trim() ? (prefixIn.value || '').trim() : null,
                twentyFourSeven: g247.checked,
                autoplay: tri(gAuto.value),
                voteSkip: tri(gVote.value),
                modlogChannelId: (gMod.value || '').trim() ? (gMod.value || '').trim() : null,
            },
        });
        loadServers();
    });
    var resetBtn = el('button', 'Reset overrides', 'act sec');
    resetBtn.addEventListener('click', async function () {
        await post('/api/guild/reset', { guildId: sel.id });
        loadServers();
    });
    form.appendChild(saveBtn); form.appendChild(resetBtn);

    var tg = clear($('guildToggles'));
    sel.commands.forEach(function (c) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', c.name));
        tr.appendChild(el('td', c.description, 'muted'));
        var tdUse = el('td', String(c.uses), 'n'); tr.appendChild(tdUse);
        var td = el('td');
        var sel2 = el('select');
        [['', 'inherit global'], ['on', 'force on'], ['off', 'force off']].forEach(function (pair) {
            var o = el('option', pair[1]); o.value = pair[0];
            if (pair[0] === (c.guildOverride || '')) o.selected = true;
            sel2.appendChild(o);
        });
        sel2.disabled = !!c.ownerOnly;
        sel2.addEventListener('change', function () {
            post('/api/commands/toggle', {
                name: c.name, guildId: sel.id,
                on: sel2.value === '' ? null : sel2.value === 'on',
            }).then(loadServers).catch(function (e) { toast(e.message); });
        });
        td.appendChild(sel2);
        td.appendChild(el('span', c.enabled ? '' : '  ', 'muted'));
        if (!c.enabled) td.appendChild(el('span', ' off', 'badge off'));
        tr.appendChild(td);
        tg.appendChild(tr);
    });

    var gu = clear($('guildUsage'));
    if (!sel.topCommands.length) gu.appendChild(el('li', 'no commands used in this server yet', 'muted'));
    sel.topCommands.forEach(function (row) { gu.appendChild(el('li', row.name + ' — ' + row.count + '×')); });

    var mc = clear($('guildMusic'));
    if (!sel.music) { mc.appendChild(el('li', 'no active queue here', 'muted')); }
    else {
        var li = el('li');
        li.appendChild(el('strong', (sel.music.playing ? sel.music.playing.name : 'idle queue') + ' '));
        li.appendChild(el('span', '— ' + sel.music.queued + ' queued, vol ' + sel.music.volume + ', repeat ' + sel.music.repeatMode, 'muted'));
        mc.appendChild(li);
        ['skip', 'pause', 'resume', 'stop'].forEach(function (op) {
            var b = el('button', op, 'act');
            b.style.marginRight = '6px';
            b.addEventListener('click', function () {
                post('/api/music', { guildId: sel.id, op: op }).then(loadServers).catch(function (e) { toast(e.message); });
            });
            mc.appendChild(b);
        });
        var volIn = el('input'); volIn.type = 'number'; volIn.min = '0'; volIn.max = '100'; volIn.value = String(sel.music.volume || 80);
        volIn.style.width = '80px';
        var volBtn = el('button', 'set volume', 'act sec');
        volBtn.addEventListener('click', function () {
            post('/api/music', { guildId: sel.id, op: 'volume', value: Number(volIn.value) })
                .then(loadServers).catch(function (e) { toast(e.message); });
        });
        mc.appendChild(volIn); mc.appendChild(volBtn);
    }
}

// ---- commands (global toggles) ------------------------------------------------
async function loadCommandsTab() {
    var data = await get('/api/commands');
    var tb = clear($('cmdRows'));
    data.commands.forEach(function (c) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td', c.name));
        tr.appendChild(el('td', c.description, 'muted'));
        var tdBadges = el('td');
        if (c.ownerOnly) tdBadges.appendChild(el('span', 'owner', 'badge'));
        if (c.adminOnly) tdBadges.appendChild(el('span', 'admin', 'badge'));
        tr.appendChild(tdBadges);
        tr.appendChild(el('td', String(c.uses), 'n'));
        var td = el('td');
        var lab = el('label', null, 'sw');
        var box = el('input'); box.type = 'checkbox'; box.checked = c.enabled;
        box.addEventListener('change', function () {
            post('/api/commands/toggle', { name: c.name, guildId: null, on: box.checked })
                .then(loadCommandsTab).catch(function (e) { toast(e.message); box.checked = !box.checked; });
        });
        lab.appendChild(box); lab.appendChild(el('span', c.enabled ? 'enabled' : 'disabled'));
        td.appendChild(lab);
        tr.appendChild(td);
        tb.appendChild(tr);
    });
}

// ---- settings ------------------------------------------------------------------
async function loadSettings() {
    var data = await get('/api/settings');
    var form = clear($('settingsForm'));
    data.schema.forEach(function (item) {
        var row = el('div', null, 'row');
        var input;
        if (item.type === 'bool') {
            input = el('input'); input.type = 'checkbox'; input.checked = Boolean(item.value);
            var lab = el('label', null, 'sw');
            lab.appendChild(input); lab.appendChild(el('span', item.label));
            row.appendChild(lab);
        } else {
            row.appendChild(el('label', item.label));
            input = el('input');
            if (item.type === 'int') { input.type = 'number'; input.min = String(item.min); input.max = String(item.max); }
            input.value = item.value === null || item.value === undefined ? '' : String(item.value);
            row.appendChild(input);
        }
        if (item.overridden) row.appendChild(el('span', 'overridden', 'badge on'));
        if (item.hint) row.appendChild(el('span', item.hint, 'muted'));
        input.addEventListener('change', function () {
            var value = item.type === 'bool' ? input.checked : (item.type === 'int' ? Number(input.value) : input.value);
            post('/api/settings', { path: item.path, value: value }).then(loadSettings).catch(function (e) { toast(e.message); });
        });
        form.appendChild(row);
    });

    form.appendChild(el('h3', 'Reaction-role table (JSON)'));
    var ta = el('textarea'); ta.id = 'rolesJson'; ta.value = JSON.stringify(data.roles, null, 2);
    form.appendChild(ta);
    var rolesBtn = el('button', 'Save roles', 'act');
    rolesBtn.addEventListener('click', function () {
        post('/api/settings', { path: 'reactionRoles.roles', value: ta.value }).then(loadSettings).catch(function (e) { toast(e.message); });
    });
    form.appendChild(rolesBtn);

    var ov = clear($('overrides'));
    var keys = Object.keys(data.overrides);
    if (!keys.length) ov.appendChild(el('li', 'no runtime overrides — everything comes from config.json', 'muted'));
    keys.forEach(function (k) {
        var li = el('li', k + ' = ' + JSON.stringify(data.overrides[k]));
        var b = el('button', 'revert', 'act sec');
        b.style.marginLeft = '8px';
        b.addEventListener('click', function () {
            post('/api/settings', { path: k, value: null }).then(loadSettings).catch(function (e) { toast(e.message); });
        });
        li.appendChild(b);
        ov.appendChild(li);
    });

    $('securityNote').textContent = data.securityNotes.join(' · ');
}

// ---- feedback / audit -------------------------------------------------------------
async function loadFeedback() {
    var data = await get('/api/feedback');
    var ol = clear($('feedback'));
    if (!data.lines.length) { ol.appendChild(el('li', 'no feedback recorded yet', 'muted')); return; }
    data.lines.forEach(function (line) { ol.appendChild(el('li', line)); });
}
async function loadAudit() {
    var data = await get('/api/audit');
    var ol = clear($('audit'));
    if (!data.lines.length) { ol.appendChild(el('li', 'nothing has been changed through this portal yet', 'muted')); return; }
    data.lines.forEach(function (line) { ol.appendChild(el('li', line)); });
}

document.addEventListener('DOMContentLoaded', function () {
    $('refreshFb').addEventListener('click', loadFeedback);
    $('refreshAudit').addEventListener('click', loadAudit);
    showTab('overview');
    setInterval(function () {
        if (current.tab === 'overview') loadOverview().catch(function () {});
        if (current.tab === 'servers') loadServers().catch(function () {});
    }, STATUS_REFRESH_MS);
});
`;

function dashboardPage(csrf) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>MockBot admin</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body data-csrf="${esc(csrf)}">
<header>
<h1>MockBot admin</h1>
<form method="post" action="/logout"><button class="act" type="submit">Log out</button></form>
</header>
<nav>
<button id="nav-overview" type="button" class="on">Overview</button>
<button id="nav-servers" type="button">Servers</button>
<button id="nav-commands" type="button">Commands</button>
<button id="nav-settings" type="button">Settings</button>
<button id="nav-feedback" type="button">Feedback</button>
<button id="nav-audit" type="button">Audit</button>
</nav>
<main>
<div id="tab-overview">
<p id="ownerWarn" class="badge off" style="display:none"></p>
<section><h2>Status</h2><dl id="status"><dt>…</dt><dd class="muted">loading</dd></dl></section>
<section><h2>Music</h2><ul id="music"><li class="muted">loading</li></ul></section>
<section><h2>Most used commands (all servers)</h2><ol id="topOverall"><li class="muted">loading</li></ol></section>
</div>
<div id="tab-servers" style="display:none">
<section><h2>Servers</h2><div id="guildGrid" class="grid"><span class="muted">loading</span></div></section>
<section><h2>Server</h2><dl id="guildDetail"><dt>…</dt><dd class="muted">pick a server</dd></dl>
<div id="guildSettingsForm"></div>
<h3>Commands in this server</h3>
<table><thead><tr><th>Command</th><th>Description</th><th>Uses</th><th>Override</th></tr></thead><tbody id="guildToggles"><tr><td colspan="4" class="muted">loading</td></tr></tbody></table>
<h3>Most used here</h3><ol id="guildUsage"><li class="muted">loading</li></ol>
<h3>Playback</h3><ul id="guildMusic"><li class="muted">loading</li></ul></section>
</div>
<div id="tab-commands" style="display:none">
<section><h2>Command toggles (all servers)</h2>
<p class="muted">Unchecking hides the command from the picker, the prefix parser and help everywhere except for the bot owner. Per-server overrides live on the Servers tab.</p>
<table><thead><tr><th>Command</th><th>Description</th><th>Access</th><th>Uses</th><th>Enabled</th></tr></thead><tbody id="cmdRows"><tr><td colspan="5" class="muted">loading</td></tr></tbody></table></section>
</div>
<div id="tab-settings" style="display:none">
<section><h2>Global parameters</h2><p id="securityNote" class="muted"></p><div id="settingsForm"></div></section>
<section><h2>Active overrides (runtime-config.json)</h2><ul id="overrides"><li class="muted">loading</li></ul></section>
</div>
<div id="tab-feedback" style="display:none">
<section>
<h2>Feedback <button id="refreshFb" type="button" class="act sec" style="float:right">refresh</button></h2>
<ol id="feedback" reversed><li class="muted">loading</li></ol>
</section>
</div>
<div id="tab-audit" style="display:none">
<section>
<h2>Audit log <button id="refreshAudit" type="button" class="act sec" style="float:right">refresh</button></h2>
<ol id="audit"><li class="muted">loading</li></ol>
</section>
</div>
</main>
<div id="toast" class="toast"></div>
<script>${DASHBOARD_JS}</script>
</body>
</html>`;
}

/** One snapshot of what the Discord-side bot knows. Never throws. */
function buildStatus({ client, distube, commands, commandToggles, usage, session }) {
    const rawPing = Number(client?.ws?.ping);
    const snapshot = {
        version: (() => {
            try { return String(require('../package.json').version); } catch { return 'unknown'; }
        })(),
        node: process.versions.node,
        process: {
            memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
            pid: process.pid,
        },
        user: {
            tag: String(client?.user?.tag ?? 'unknown'),
            uptimeSeconds: Math.floor((Number(client?.uptime) || 0) / 1000),
            // ws.ping is -1 until the first heartbeat ACK arrives (see commands/ping.js).
            wsPing: Number.isFinite(rawPing) && rawPing >= 0 ? Math.round(rawPing) : null,
        },
        owner: { set: Boolean(String(process.env.OWNER ?? '').trim()) },
        guilds: Number(client?.guilds?.cache?.size) || 0,
        commands: {
            total: Number(commands?.size) || 0,
            disabled: commandToggles ? commandToggles.view([...(commands?.keys?.() ?? [])]).filter(c => !c.enabled).length : 0,
        },
        usage: {
            grandTotal: usage ? usage.grandTotal() : 0,
            top: usage ? usage.top(null, 15) : [],
        },
        session: { actor: String(session?.actor ?? 'admin') },
        music: [],
    };

    let guilds = [];
    try {
        const cache = client?.guilds?.cache;
        guilds = cache && typeof cache.values === 'function' ? [...cache.values()] : [];
    } catch {
        guilds = [];
    }

    for (const guild of guilds) {
        try {
            const queue = distube?.getQueue?.(guild?.id);
            if (!queue) continue;
            const song = queue.songs?.[0];
            snapshot.music.push({
                guild: String(guild?.name ?? guild?.id ?? 'unknown'),
                playing: song ? {
                    name: String(song.name ?? 'unknown'),
                    url: typeof song.url === 'string' ? song.url : null,
                    requestedBy: song.user?.tag ?? song.user?.username ?? song.user?.id ?? null,
                    duration: song.formattedDuration ?? null,
                    live: Boolean(song.live),
                } : null,
                volume: Number.isFinite(queue.volume) ? queue.volume : null,
                repeatMode: REPEAT_LABELS[queue.repeatMode] ?? 'off',
                queued: Math.max(0, (queue.songs?.length ?? 1) - 1),
            });
        } catch {
            // A queue torn down mid-snapshot skips this guild, not the endpoint.
        }
    }
    return snapshot;
}

function guildSummary(guild, { commandToggles, usage, guildSettings, config }) {
    const channels = guild?.channels?.cache ? [...guild.channels.cache.values()] : [];
    return {
        id: String(guild?.id ?? ''),
        name: String(guild?.name ?? guild?.id ?? 'unknown'),
        memberCount: Number(guild?.memberCount) || 0,
        channelCount: channels.length,
    };
}

function guildDetail(guild, { commandToggles, usage, guildSettings, config }) {
    const channels = guild?.channels?.cache ? [...guild.channels.cache.values()] : [];
    const voice = channels.filter(c => c?.type === 2 || c?.type === 'GUILD_VOICE' || c?.type === 'GUILD_STAGE_VOICE');
    const settings = guildSettings ? guildSettings.get(guild.id) : {};
    const owner = guild?.ownerId
        ? guild.client?.users?.cache?.get(guild.ownerId) ?? null
        : null;
    const permissions = guild?.members?.me?.permissions
        ? guild.members.me.permissions.toArray().join(', ')
        : '';
    return {
        id: String(guild?.id ?? ''),
        name: String(guild?.name ?? guild?.id ?? 'unknown'),
        ownerId: String(guild?.ownerId ?? 'unknown'),
        ownerTag: owner?.tag ?? 'unknown',
        memberCount: Number(guild?.memberCount) || 0,
        channelCount: channels.length,
        voiceChannels: voice.length,
        premiumTier: Number(guild?.premiumTier) || 0,
        premiumCount: Number(guild?.premiumSubscriptionCount) || 0,
        createdAt: Number(guild?.createdTimestamp) || null,
        joinedAt: Number(guild?.joinedTimestamp) || null,
        icon: typeof guild?.iconURL === 'function' ? guild.iconURL({ size: 64 }) : null,
        permissions,
        settings,
        effectivePrefix: settings.prefix ?? config?.prefix ?? '!',
        topCommands: usage ? usage.top(guild.id, 15) : [],
        music: null,
    };
}

/**
 * Start the portal. Returns `{ server, port, close }`, or `null` when disabled
 * (missing credentials) or when the port could not be bound — a taken port
 * must not take the bot down, the same rule as the process-wide error traps.
 *
 * @param {object} [options]
 * @param {object} [options.client]   the discord.js Client to report on
 * @param {object} [options.distube]  the DisTube instance for queues/controls
 * @param {Map}    [options.commands] loaded command map
 * @param {Function} [options.resyncSlashCommands] async fn re-registering slash
 *                 commands after a toggle (wired by bot.js)
 * @param {object} [options.env]      credential source (default process.env)
 * @param {number} [options.port]     bind port override (default WEB_PORT or 8787; 0 = ephemeral)
 * @param {string} [options.bind]     bind address override (default WEB_BIND or 0.0.0.0)
 * @param {object} [options.log]      console-shaped logger
 * @param {object} [options.deps]     internal: injected lib modules (tests)
 */
async function startPortal(options = {}) {
    const env = options.env ?? process.env;
    const log = options.log ?? console;
    const deps = options.deps ?? {};
    const guildSettings = deps.guildSettings ?? require('../lib/guildSettings');
    const commandToggles = deps.commandToggles ?? require('../lib/commandToggles');
    const runtimeConfig = deps.runtimeConfig ?? require('../lib/runtimeConfig');
    const usage = deps.usage ?? require('../lib/usage');
    const auditLog = deps.auditLog ?? require('../lib/auditLog');

    const user = env.WEB_USER;
    const pass = env.WEB_PASS;
    const passHash = env.WEB_PASS_HASH;
    const usersSpec = env.WEB_USERS; // "alice:hexsha,bob:hexsha"

    // Accounts: named list wins; otherwise one shared WEB_USER account.
    /** @type {Map<string, {hash: Buffer|null, hex: string|null}>} user -> secret */
    const accounts = new Map();
    if (usersSpec) {
        for (const pair of String(usersSpec).split(',')) {
            const idx = pair.indexOf(':');
            if (idx <= 0) continue;
            const name = pair.slice(0, idx).trim();
            const hex = pair.slice(idx + 1).trim().toLowerCase();
            if (!name || !/^[0-9a-f]{64}$/.test(hex)) {
                log.warn(`[web] WEB_USERS entry for "${name || pair}" is not a 64-char hex sha256; ignored.`);
                continue;
            }
            accounts.set(name, { hash: null, hex });
        }
    }
    if (!accounts.size && user) {
        if (passHash && /^[0-9a-f]{64}$/i.test(String(passHash).trim())) {
            accounts.set(String(user), { hash: null, hex: String(passHash).trim().toLowerCase() });
        } else if (pass) {
            accounts.set(String(user), { hash: sha256(pass), hex: null });
        }
    }
    if (!accounts.size) {
        log.warn('[web] WEB_USER/WEB_PASS (or WEB_PASS_HASH / WEB_USERS) not set — web portal disabled.');
        return null;
    }

    let port = DEFAULT_PORT;
    const rawPort = options.port ?? env.WEB_PORT;
    if (rawPort !== undefined) {
        const parsed = Number.parseInt(String(rawPort), 10);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) port = parsed;
        else log.warn(`[web] WEB_PORT "${rawPort}" is not a port number; using ${DEFAULT_PORT}.`);
    }

    // Default faces the local network; WEB_BIND=127.0.0.1 locks it back to
    // this machine. A bad address fails the listen and costs only a log line.
    const bind = String(options.bind ?? env.WEB_BIND ?? '').trim() || DEFAULT_BIND;

    // Optional hard address gate: comma-separated allowed prefixes.
    const allowlist = String(env.WEB_ALLOWLIST ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    // TLS: serve https when a cert/key pair is given; WEB_SECURE forces the
    // Secure cookie flag behind a TLS-terminating proxy.
    let tls = null;
    if (env.WEB_TLS_CERT && env.WEB_TLS_KEY) {
        try {
            tls = {
                cert: fs.readFileSync(String(env.WEB_TLS_CERT)),
                key: fs.readFileSync(String(env.WEB_TLS_KEY)),
            };
        } catch (err) {
            log.error(`[web] WEB_TLS_CERT/KEY unreadable (${err.message}) — falling back to plain http.`);
        }
    }
    const secureCookie = Boolean(tls) || ['1', 'true', 'yes'].includes(String(env.WEB_SECURE ?? '').toLowerCase());

    const loginLimit = Number.isInteger(options.loginLimit) ? options.loginLimit : LOGIN_LIMIT;
    const loginWindowMs = Number.isFinite(options.loginWindowMs) ? options.loginWindowMs : LOGIN_WINDOW_MS;
    const apiLimit = Number.isInteger(options.apiLimit) ? options.apiLimit : API_LIMIT;
    const readFeedback = typeof options.readFeedback === 'function'
        ? options.readFeedback
        : (deps.feedbackStore ?? require('../lib/feedbackStore')).readAll;

    const sessions = new Map(); // token -> { expiry, csrf, uaHash, actor }
    const loginAttempts = new Map(); // ip -> { count, firstAt }

    function sessionCookie(token, maxAgeSeconds) {
        return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secureCookie ? '; Secure' : ''}`;
    }

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [token, s] of sessions) if (s.expiry <= now) sessions.delete(token);
        for (const [ip, entry] of loginAttempts) if (now - entry.firstAt > loginWindowMs) loginAttempts.delete(ip);
    }, 60_000);
    sweep.unref(); // never keep the process (or a test run) alive

    function uaHash(req) {
        return sha256(String(req.headers['user-agent'] ?? '')).toString('hex').slice(0, 16);
    }

    function touchSession(req, res) {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
        const entry = sessions.get(token);
        if (!entry || entry.expiry <= Date.now()) {
            sessions.delete(token);
            return null;
        }
        // A different browser presenting the same cookie is treated as stolen.
        if (entry.uaHash && entry.uaHash !== uaHash(req)) {
            sessions.delete(token);
            return null;
        }
        entry.expiry = Date.now() + SESSION_TTL_MS; // sliding expiry
        res.setHeader('set-cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
        return entry;
    }

    function throttled(map, key, limit, windowMs) {
        const entry = map.get(key);
        return Boolean(entry && entry.count >= limit && Date.now() - entry.firstAt <= windowMs);
    }

    function bumpFailure(map, key, windowMs) {
        const now = Date.now();
        const entry = map.get(key);
        if (!entry || now - entry.firstAt > windowMs) map.set(key, { count: 1, firstAt: now });
        else entry.count += 1;
    }

    const apiAttempts = new Map();

    function fail(res, code, message) {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(message);
    }

    function json(res, code, payload) {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
    }

    async function audit(session, action, detail) {
        await auditLog.record(session?.actor ?? 'admin', action, detail).catch?.(() => {});
    }

    /** Coerce/validate a settings value against SETTINGS_SCHEMA; throws on bad. */
    function coerceSetting(item, raw) {
        if (raw === null) return null; // revert to config.json
        if (item.type === 'bool') {
            if (typeof raw === 'boolean') return raw;
            const s = String(raw).toLowerCase();
            if (['true', 'on', '1', 'yes'].includes(s)) return true;
            if (['false', 'off', '0', 'no'].includes(s)) return false;
            throw new Error(`${item.path} needs true/false`);
        }
        if (item.type === 'int') {
            const n = Number(raw);
            if (!Number.isInteger(n)) throw new Error(`${item.path} needs a whole number`);
            if (n < item.min || n > item.max) throw new Error(`${item.path} must be ${item.min}-${item.max}`);
            return n;
        }
        const s = String(raw).trim();
        if (!s) throw new Error(`${item.path} cannot be empty`);
        if (s.length > (item.maxLen ?? 32)) throw new Error(`${item.path} too long (max ${item.maxLen ?? 32})`);
        // `<` opens Discord mention syntax, control chars break the log file.
        if (/[\r\n<]/.test(s)) throw new Error(`${item.path} contains forbidden characters`);
        return s;
    }

    function coerceRoles(raw) {
        let value = raw;
        if (typeof raw === 'string') {
            try { value = JSON.parse(raw); } catch (err) { throw new Error(`roles JSON: ${err.message}`); }
        }
        if (!Array.isArray(value)) throw new Error('roles must be a JSON array');
        if (value.length > 25) throw new Error('at most 25 roles (Discord reaction limit)');
        for (const entry of value) {
            if (!entry || typeof entry !== 'object') throw new Error('each role needs {name, emoji}');
            if (!entry.emoji || String(entry.emoji).length > 10) throw new Error('each role needs a short emoji');
            if (!entry.name && !entry.roleId) throw new Error('each role needs a name or roleId');
            if (entry.name && String(entry.name).length > 60) throw new Error('role name too long');
            if (entry.roleId && !/^\d{5,25}$/.test(String(entry.roleId))) throw new Error('roleId must be a snowflake');
            if (entry.channelId && !/^\d{5,25}$/.test(String(entry.channelId))) throw new Error('channelId must be a snowflake');
        }
        return value;
    }

    function commandList(guildId) {
        const names = [...(options.commands?.keys?.() ?? [])];
        return commandToggles.view(names, guildId).map(t => {
            const cmd = options.commands.get(t.name);
            return {
                ...t,
                description: String(cmd?.description ?? ''),
                ownerOnly: Boolean(cmd?.ownerOnly),
                adminOnly: cmd?.adminOnly !== undefined && cmd?.adminOnly !== null && cmd?.adminOnly !== false,
                uses: usage.total(t.name, guildId),
            };
        }).sort((a, b) => a.name.localeCompare(b.name));
    }

    function resync() {
        if (typeof options.resyncSlashCommands !== 'function') return Promise.resolve(null);
        return options.resyncSlashCommands().catch(err => {
            log.warn('[web] slash resync failed:', err?.message ?? err);
            return { error: String(err?.message ?? err) };
        });
    }

    async function handle(req, res) {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'self' data:");
        res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
        if (secureCookie) res.setHeader('strict-transport-security', 'max-age=31536000');
        res.setHeader('x-frame-options', 'DENY');

        let url;
        try {
            url = new URL(req.url, 'http://127.0.0.1');
        } catch {
            return fail(res, 400, 'bad request');
        }
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const ip = String(req.socket.remoteAddress ?? '');

        // Hard address gate (optional).
        if (allowlist.length && !allowlist.some(prefix => ip.startsWith(prefix))) {
            return fail(res, 403, 'address not allowlisted');
        }

        // Global rate limit on everything that is not a static-ish GET page, so
        // a script hammering the JSON APIs cannot DoS the Pi.
        const rateKey = ip;
        if (method !== 'GET' || pathname.startsWith('/api/')) {
            if (throttled(apiAttempts, rateKey, apiLimit, API_WINDOW_MS)) {
                res.setHeader('retry-after', String(Math.ceil(API_WINDOW_MS / 1000)));
                return fail(res, 429, 'too many requests; wait a few minutes.');
            }
            bumpFailure(apiAttempts, rateKey, API_WINDOW_MS);
        }

        if (method === 'GET' && pathname === '/login') {
            if (touchSession(req, res)) {
                res.writeHead(302, { location: '/' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(loginPage('', crypto.randomBytes(16).toString('hex')));
        }

        if (method === 'POST' && pathname === '/login') {
            if (throttled(loginAttempts, ip, loginLimit, loginWindowMs)) {
                res.setHeader('retry-after', String(Math.ceil(loginWindowMs / 1000)));
                return fail(res, 429, 'too many failed logins; wait a few minutes.');
            }
            const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
            if (!contentType.startsWith('application/x-www-form-urlencoded')) {
                return fail(res, 400, 'expected a form post');
            }
            let body;
            try {
                body = await readBody(req, MAX_BODY_BYTES);
            } catch (err) {
                return fail(res, err.statusCode ?? 400, err.statusCode === 413 ? 'request body too large' : 'bad request');
            }
            const form = new URLSearchParams(body);
            const name = String(form.get('user') ?? '');
            const given = String(form.get('pass') ?? '');
            const account = accounts.get(name);
            // Compare against the stored secret even for unknown users so a
            // wrong name costs the same time as a wrong password.
            const probe = account ?? { hash: sha256('\u0000never-matches'), hex: null };
            const ok = account && (probe.hex
                ? matchesHexDigest(given, probe.hex)
                : matchesSecret(given, probe.hash));
            if (ok) {
                loginAttempts.delete(ip);
                let token;
                do token = crypto.randomBytes(32).toString('hex'); while (sessions.has(token));
                if (sessions.size >= MAX_SESSIONS) {
                    // Evict the soonest-to-expire to keep the map bounded.
                    const oldest = [...sessions.entries()].sort((a, b) => a[1].expiry - b[1].expiry)[0];
                    if (oldest) sessions.delete(oldest[0]);
                }
                const csrf = crypto.randomBytes(16).toString('hex');
                sessions.set(token, { expiry: Date.now() + SESSION_TTL_MS, csrf, uaHash: uaHash(req), actor: name });
                res.setHeader('set-cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
                res.writeHead(302, { location: '/' });
                return res.end();
            }
            bumpFailure(loginAttempts, ip, loginWindowMs);
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(loginPage('wrong username or password', crypto.randomBytes(16).toString('hex')));
        }

        if (method === 'POST' && pathname === '/logout') {
            const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
            if (token) sessions.delete(token);
            res.setHeader('set-cookie', sessionCookie('', 0) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
            res.writeHead(302, { location: '/login' });
            return res.end();
        }

        // Everything below needs a live session.
        const session = touchSession(req, res);
        if (!session) {
            if (pathname.startsWith('/api/')) return fail(res, 401, 'unauthorized');
            res.writeHead(302, { location: '/login' });
            return res.end();
        }

        // CSRF: every JSON mutation carries the token issued with the session.
        if (method === 'POST' && pathname.startsWith('/api/')) {
            const given = String(req.headers['x-csrf-token'] ?? '');
            if (!given || !crypto.timingSafeEqual(sha256(given), sha256(session.csrf))) {
                return fail(res, 403, 'missing or wrong CSRF token');
            }
        }

            /** A guild id the bot is actually in (rejects typos and forged ids). */
        function knownGuild(raw) {
        const gid = String(raw ?? '');
        if (!gid || gid.length > 30 || !/^[0-9a-z_-]+$/i.test(gid)) return null;
        const cache = options.client?.guilds?.cache;
        const known = cache?.get ? cache.get(gid) : [...(cache?.values?.() ?? [])].find(g => String(g.id) === gid);
        return known ? gid : null;
    }

    /** Read + JSON-parse a mutation body, 413/400 handled. */
        async function readJson() {
            const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
            if (!contentType.startsWith('application/json')) throw Object.assign(new Error('expected a json post'), { code: 400 });
            const body = await readBody(req, MAX_BODY_BYTES);
            try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('invalid json'), { code: 400 }); }
        }

        try {
            if (method === 'GET' && pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(dashboardPage(session.csrf));
            }

            if (method === 'GET' && pathname === '/api/status') {
                return json(res, 200, buildStatus({ ...options, commandToggles, usage, session }));
            }

            if (method === 'GET' && pathname === '/api/feedback') {
                let lines = [];
                try {
                    const content = await readFeedback();
                    lines = (content ?? '').split('\n').map(line => line.trim()).filter(Boolean)
                        .slice(-FEEDBACK_LIMIT).reverse(); // newest first
                } catch (err) {
                    log.warn('[web] feedback read failed:', err?.message ?? err);
                }
                return json(res, 200, { lines });
            }

            if (method === 'GET' && pathname === '/api/audit') {
                let lines = [];
                try { lines = await auditLog.read(AUDIT_LIMIT); } catch (err) {
                    log.warn('[web] audit read failed:', err?.message ?? err);
                }
                return json(res, 200, { lines });
            }

            if (method === 'GET' && pathname === '/api/commands') {
                return json(res, 200, { commands: commandList(null) });
            }

            if (method === 'GET' && pathname === '/api/settings') {
                const live = runtimeConfig.get?.() ?? {};
                const overrides = runtimeConfig.listOverrides();
                const schema = SETTINGS_SCHEMA.map(item => ({
                    ...item,
                    value: item.path.split('.').reduce((node, part) => (node ?? {})[part], live) ?? null,
                    overridden: overrides[item.path] !== undefined,
                }));
                const securityNotes = [];
                if (!tls && !secureCookie) securityNotes.push('serving plain http — set WEB_TLS_CERT/KEY or a TLS proxy + WEB_SECURE=1 if this leaves the LAN');
                if (!allowlist.length) securityNotes.push('no WEB_ALLOWLIST gate (any address that can route here may try the login)');
                if ([...accounts.values()].some(a => a.hex === null && a.hash)) securityNotes.push('password stored in .env (WEB_PASS_HASH keeps it a digest)');
                if (!process.env.OWNER) securityNotes.push('OWNER unset: owner-only commands are unreachable from Discord');
                return json(res, 200, {
                    schema,
                    roles: Array.isArray(live?.reactionRoles?.roles) ? live.reactionRoles.roles : [],
                    overrides,
                    securityNotes,
                });
            }

            if (method === 'GET' && pathname === '/api/guilds') {
                const wantId = url.searchParams.get('id');
                const guildsIterable = [...(options.client?.guilds?.cache?.values?.() ?? [])];
                const guilds = guildsIterable.map(g => guildSummary(g, { commandToggles, usage, guildSettings, config: runtimeConfig.get?.() }));
                let selected = null;
                const picked = wantId ? guildsIterable.find(g => String(g.id) === String(wantId)) : null;
                if (picked) {
                    selected = guildDetail(picked, { commandToggles, usage, guildSettings, config: runtimeConfig.get?.() });
                    // Commands need the real registry names + per-guild override.
                    selected.commands = commandList(picked.id).map(c => ({ ...c, guildOverride: c.guildOverride }));
                    try {
                        const queue = options.distube?.getQueue?.(picked.id);
                        if (queue) {
                            const song = queue.songs?.[0];
                            selected.music = {
                                playing: song ? { name: String(song.name ?? 'unknown'), duration: song.formattedDuration ?? null, live: Boolean(song.live) } : null,
                                volume: Number.isFinite(queue.volume) ? queue.volume : null,
                                repeatMode: REPEAT_LABELS[queue.repeatMode] ?? 'off',
                                queued: Math.max(0, (queue.songs?.length ?? 1) - 1),
                            };
                        }
                    } catch { /* queue torn down mid-snapshot */ }
                }
                return json(res, 200, { guilds, selected });
            }

            if (method === 'POST' && pathname === '/api/settings') {
                let body;
                try { body = await readJson(); } catch (err) { return fail(res, err.code ?? 400, String(err.message ?? err)); }
                const path = String(body.path ?? '');
                if (path === ROLES_PATH) {
                    let roles;
                    try { roles = coerceRoles(body.value); } catch (err) { return fail(res, 400, err.message); }
                    runtimeConfig.set(ROLES_PATH, roles);
                    await audit(session, 'settings', `${ROLES_PATH} = ${JSON.stringify(roles).slice(0, 200)}`);
                    return json(res, 200, { ok: true, message: 'reaction roles saved' });
                }
                const item = SETTINGS_SCHEMA.find(s => s.path === path);
                if (!item) return fail(res, 400, `unknown or non-editable setting: ${path}`);
                let value;
                try { value = coerceSetting(item, body.value); } catch (err) { return fail(res, 400, err.message); }
                runtimeConfig.set(path, value);
                await audit(session, 'settings', value === null ? `revert ${path}` : `${path} = ${JSON.stringify(value)}`);
                return json(res, 200, { ok: true, message: value === null ? 'reverted to config.json' : 'saved' });
            }

            if (method === 'POST' && pathname === '/api/guild/settings') {
                let body;
                try { body = await readJson(); } catch (err) { return fail(res, err.code ?? 400, String(err.message ?? err)); }
                const gid = knownGuild(body.guildId);
                if (!gid) return fail(res, 400, 'unknown guild id');
                const patchIn = body.patch ?? {};
                const allowed = ['prefix', 'twentyFourSeven', 'autoplay', 'voteSkip', 'modlogChannelId'];
                const patch = {};
                for (const key of allowed) {
                    if (!(key in patchIn)) continue;
                    let v = patchIn[key];
                    if (key === 'prefix') {
                        v = v === null || v === '' ? null : String(v).trim().slice(0, 5);
                        if (v && /[\r\n<]/.test(v)) return fail(res, 400, 'prefix contains forbidden characters');
                    } else if (key === 'modlogChannelId') {
                        v = v === null || v === '' ? null : String(v).trim();
                        if (v && !/^\d{5,25}$/.test(v)) return fail(res, 400, 'modlog channel id must be a snowflake');
                    } else {
                        v = v === null ? null : Boolean(v);
                    }
                    patch[key] = v;
                }
                guildSettings.patch(gid, patch);
                await audit(session, 'guild-settings', `guild ${gid} ${JSON.stringify(patch)}`);
                return json(res, 200, { ok: true, message: 'server settings saved' });
            }

            if (method === 'POST' && pathname === '/api/guild/reset') {
                let body;
                try { body = await readJson(); } catch (err) { return fail(res, err.code ?? 400, String(err.message ?? err)); }
                const gid = knownGuild(body.guildId);
                if (!gid) return fail(res, 400, 'unknown guild id');
                guildSettings.reset(gid);
                commandToggles.clearGuild(gid);
                usage.clearGuild(gid);
                await audit(session, 'guild-reset', `guild ${gid}`);
                return json(res, 200, { ok: true, message: 'server overrides cleared' });
            }

            if (method === 'POST' && pathname === '/api/commands/toggle') {
                let body;
                try { body = await readJson(); } catch (err) { return fail(res, err.code ?? 400, String(err.message ?? err)); }
                const name = String(body.name ?? '').toLowerCase();
                if (!options.commands?.has?.(name)) return fail(res, 400, 'unknown command');
                const cmd = options.commands.get(name);
                let gid = null;
                if (body.guildId !== null && body.guildId !== undefined) {
                    gid = knownGuild(body.guildId);
                    if (!gid) return fail(res, 400, 'unknown guild id');
                }
                const on = body.on === null || body.on === undefined ? null : Boolean(body.on);
                if (gid === null) {
                    commandToggles.setGlobal(name, on !== false);
                } else {
                    commandToggles.setGuild(gid, name, on, { ownerOnly: Boolean(cmd.ownerOnly) });
                }
                const sync = await resync();
                await audit(session, 'toggle', `${name} ${gid ? `guild ${gid}` : 'global'} -> ${on === null ? 'inherit' : on ? 'on' : 'off'}`);
                return json(res, 200, { ok: true, message: sync?.error ? `saved (slash resync failed: ${sync.error})` : 'saved', resync: sync });
            }

            if (method === 'POST' && pathname === '/api/music') {
                let body;
                try { body = await readJson(); } catch (err) { return fail(res, err.code ?? 400, String(err.message ?? err)); }
                const gid = knownGuild(body.guildId);
                if (!gid) return fail(res, 400, 'unknown guild id');
                const op = String(body.op ?? '');
                const distube = options.distube;
                const queue = distube?.getQueue?.(gid);
                if (!queue) return fail(res, 409, 'no active queue in that server');
                const map = {
                    skip: () => distube.skip(queue),
                    pause: () => distube.pause(queue),
                    resume: () => distube.resume(queue),
                    stop: () => distube.stop(queue),
                    volume: () => {
                        const v = Number(body.value);
                        if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error('volume must be 0-100');
                        return distube.setVolume(queue, v);
                    },
                };
                if (!map[op]) return fail(res, 400, 'unknown music op');
                try {
                    await map[op]();
                } catch (err) {
                    return fail(res, 502, `distube refused: ${String(err?.message ?? err).slice(0, 200)}`);
                }
                await audit(session, 'music', `${op} guild ${gid}${op === 'volume' ? ` -> ${body.value}` : ''}`);
                return json(res, 200, { ok: true, message: op });
            }

            return fail(res, 404, 'not found');
        } catch (err) {
            log.error('[web]', err instanceof Error ? err : new Error(String(err)));
            if (!res.headersSent) return json(res, 500, { ok: false, error: 'internal error' });
            return res.end();
        }
    }

    const requestListener = (req, res) => {
        handle(req, res).catch(err => {
            log.error('[web]', err instanceof Error ? err : new Error(String(err)));
            if (!res.headersSent) fail(res, 500, 'internal error');
            else res.end();
        });
    };
    const server = tls ? https.createServer(tls, requestListener) : http.createServer(requestListener);

    const boundPort = await new Promise((resolve, reject) => {
        const onError = err => { server.off('listening', onListening); reject(err); };
        const onListening = () => { server.off('error', onError); resolve(server.address().port); };
        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(port, bind);
    }).catch(err => {
        log.error(`[web] portal could not bind ${bind}:${port} (${err.code ?? err.message}) — the bot keeps running without it.`);
        return null;
    });
    if (boundPort === null) return null;

    // Anything after startup (rare) should also only cost us a log line.
    server.on('error', err => log.error('[web]', err?.message ?? err));
    const scheme = tls ? 'https' : 'http';
    const reach = bind === DEFAULT_BIND || bind === '::'
        ? 'sign in from the local network'
        : `sign in from ${bind}`;
    log.log(`[web] portal on ${scheme}://${bind === DEFAULT_BIND ? '127.0.0.1' : bind}:${boundPort}/ (${reach}${allowlist.length ? `, allowlist: ${allowlist.join(' ')}` : ''})`);

    return {
        server,
        port: boundPort,
        close() {
            clearInterval(sweep);
            sessions.clear();
            loginAttempts.clear();
            apiAttempts.clear();
            server.close();
        },
    };
}

module.exports = { startPortal, DEFAULT_BIND, DEFAULT_PORT, SETTINGS_SCHEMA, buildStatus };
