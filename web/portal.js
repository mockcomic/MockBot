const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Optional local-network web portal.
 *
 * A tiny read-only admin page served by the bot process itself: status,
 * per-guild music state and the feedback log. Bound to every interface by
 * default, so anyone on the local network can open it; the login (WEB_USER /
 * WEB_PASS) is the access control. Set WEB_BIND=127.0.0.1 to lock it back to
 * the machine the bot runs on.
 *
 * Enabled only when both WEB_USER and WEB_PASS are present in the environment
 * (see .env.example). One shared login; a session is an in-memory random token
 * in an HttpOnly/SameSite=Strict cookie, so a bot restart just means signing
 * in again. No new npm dependencies on purpose — the reference deployment is a
 * Raspberry Pi and the rest of the bot already runs on plain node built-ins.
 *
 * Remote text (song titles, feedback lines) reaches the browser only through
 * JSON endpoints rendered with textContent, so it cannot inject HTML or
 * break out of the page the way a Discord mention cannot break out of a reply.
 */

const DEFAULT_BIND = '0.0.0.0'; // all interfaces: reachable on the local network
const DEFAULT_PORT = 8787;
const COOKIE_NAME = 'mockbot_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h, refreshed on use
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_LIMIT = 10; // failed logins per window before a 429
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const FEEDBACK_LIMIT = 200; // newest lines the portal will show
const STATUS_REFRESH_MS = 5000;

const REPEAT_LABELS = ['off', 'song', 'queue'];

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest();
}

/** Length-independent constant-time compare (both sides are 32-byte digests). */
function matchesSecret(given, expectedHash) {
    return crypto.timingSafeEqual(sha256(given), expectedHash);
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

function sessionCookie(token, maxAgeSeconds) {
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
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

function loginPage(error) {
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

function dashboardPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>MockBot admin</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;background:#111418;color:#e6e8ea;margin:0;padding:24px}
header{display:flex;justify-content:space-between;align-items:center;max-width:760px;margin:0 auto 18px}
h1{font-size:17px;margin:0}
button{padding:7px 12px;border:0;border-radius:6px;background:#5865f2;color:#fff;font:inherit;cursor:pointer}
main{display:grid;gap:14px;max-width:760px;margin:0 auto}
section{background:#1b2026;border:1px solid #2c333b;border-radius:10px;padding:16px 18px}
h2{font-size:14px;margin:0 0 10px;color:#9aa4ae;text-transform:uppercase;letter-spacing:.04em}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
dt{color:#9aa4ae}dd{margin:0}
ul,ol{margin:0;padding-left:20px}
li{margin:4px 0;overflow-wrap:anywhere}
.muted{color:#9aa4ae}
a{color:#8ea1ff}
</style>
</head>
<body>
<header>
<h1>MockBot admin</h1>
<form method="post" action="/logout"><button type="submit">Log out</button></form>
</header>
<main>
<section><h2>Status</h2><dl id="status"><dt>…</dt><dd class="muted">loading</dd></dl></section>
<section><h2>Music</h2><ul id="music"><li class="muted">loading</li></ul></section>
<section>
<h2>Feedback <button id="refreshFb" type="button" style="float:right">refresh</button></h2>
<ol id="feedback" reversed><li class="muted">loading</li></ol>
</section>
</main>
<script>
'use strict';
var $ = function (id) { return document.getElementById(id); };
function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
}
function fmtUptime(total) {
    var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (h ? h + 'h ' : '') + m + 'm ' + s + 's';
}
function renderStatus(st) {
    var dl = $('status');
    dl.textContent = '';
    var rows = [
        ['Signed in as', st.user.tag],
        ['Uptime', fmtUptime(st.user.uptimeSeconds)],
        ['Gateway ping', st.user.wsPing === null ? 'n/a' : st.user.wsPing + ' ms'],
        ['Guilds', String(st.guilds)],
        ['Commands', String(st.commands)]
    ];
    rows.forEach(function (row) { dl.appendChild(el('dt', row[0])); dl.appendChild(el('dd', row[1])); });

    var ul = $('music');
    ul.textContent = '';
    if (!st.music.length) { ul.appendChild(el('li', 'no active queue', 'muted')); return; }
    st.music.forEach(function (m) {
        var li = el('li');
        li.appendChild(el('strong', m.guild + ': '));
        if (m.playing) {
            li.appendChild(document.createTextNode(m.playing.name));
            var bits = [];
            if (m.playing.requestedBy) bits.push('requested by ' + m.playing.requestedBy);
            if (m.playing.duration) bits.push(m.playing.duration);
            bits.push('vol ' + m.volume + ', repeat ' + m.repeatMode + ', ' + m.queued + ' queued');
            li.appendChild(el('span', ' — ' + bits.join(', '), 'muted'));
        } else {
            li.appendChild(el('span', 'queue idle', 'muted'));
        }
        ul.appendChild(li);
    });
}
async function loadStatus() {
    var r = await fetch('/api/status', { cache: 'no-store' });
    if (r.status === 401) { window.location = '/login'; return; }
    renderStatus(await r.json());
}
async function loadFeedback() {
    var r = await fetch('/api/feedback', { cache: 'no-store' });
    if (!r.ok) return;
    var data = await r.json();
    var ol = $('feedback');
    ol.textContent = '';
    if (!data.lines.length) { ol.appendChild(el('li', 'no feedback recorded yet', 'muted')); return; }
    data.lines.forEach(function (line) { ol.appendChild(el('li', line)); });
}
$('refreshFb').addEventListener('click', loadFeedback);
loadStatus();
loadFeedback();
setInterval(loadStatus, ${STATUS_REFRESH_MS});
</script>
</body>
</html>`;
}

/** One snapshot of what the Discord-side bot knows. Never throws. */
function buildStatus({ client, distube, commands }) {
    const rawPing = Number(client?.ws?.ping);
    const snapshot = {
        user: {
            tag: String(client?.user?.tag ?? 'unknown'),
            uptimeSeconds: Math.floor((Number(client?.uptime) || 0) / 1000),
            // ws.ping is -1 until the first heartbeat ACK arrives (see commands/ping.js).
            wsPing: Number.isFinite(rawPing) && rawPing >= 0 ? Math.round(rawPing) : null,
        },
        guilds: Number(client?.guilds?.cache?.size) || 0,
        commands: Number(commands?.size) || 0,
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

/**
 * Start the portal. Returns `{ server, port, close }`, or `null` when disabled
 * (missing credentials) or when the port could not be bound — a taken port
 * must not take the bot down, the same rule as the process-wide error traps.
 *
 * @param {object} [options]
 * @param {object} [options.client]  the discord.js Client to report on
 * @param {object} [options.distube] the DisTube instance to read queues from
 * @param {Map}    [options.commands] loaded command map, for the count
 * @param {object} [options.env]     credential source (default process.env)
 * @param {number} [options.port]    bind port override (default WEB_PORT or 8787; 0 = ephemeral, for tests)
 * @param {string} [options.bind]    bind address override (default WEB_BIND or 0.0.0.0)
 * @param {object} [options.log]     console-shaped logger
 */
async function startPortal(options = {}) {
    const env = options.env ?? process.env;
    const log = options.log ?? console;
    const user = env.WEB_USER;
    const pass = env.WEB_PASS;
    if (!user || !pass) {
        log.warn('[web] WEB_USER/WEB_PASS not set — web portal disabled.');
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

    const loginLimit = Number.isInteger(options.loginLimit) ? options.loginLimit : LOGIN_LIMIT;
    const loginWindowMs = Number.isFinite(options.loginWindowMs) ? options.loginWindowMs : LOGIN_WINDOW_MS;
    // Injectable so tests can point it anywhere; the bot uses the real store.
    const readFeedback = typeof options.readFeedback === 'function'
        ? options.readFeedback
        : require('../lib/feedbackStore').readAll;

    const expectedUserHash = sha256(user);
    const expectedPassHash = sha256(pass);
    const sessions = new Map(); // token -> expiry timestamp
    const loginAttempts = new Map(); // ip -> { count, firstAt }

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
        for (const [ip, entry] of loginAttempts) if (now - entry.firstAt > loginWindowMs) loginAttempts.delete(ip);
    }, 60_000);
    sweep.unref(); // never keep the process (or a test run) alive

    function touchSession(req, res) {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
        const expiry = sessions.get(token);
        if (!expiry || expiry <= Date.now()) {
            sessions.delete(token);
            return false;
        }
        sessions.set(token, Date.now() + SESSION_TTL_MS); // sliding expiry
        res.setHeader('set-cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
        return true;
    }

    function throttled(ip) {
        const entry = loginAttempts.get(ip);
        return Boolean(entry && entry.count >= loginLimit && Date.now() - entry.firstAt <= loginWindowMs);
    }

    function bumpFailure(ip) {
        const now = Date.now();
        const entry = loginAttempts.get(ip);
        if (!entry || now - entry.firstAt > loginWindowMs) loginAttempts.set(ip, { count: 1, firstAt: now });
        else entry.count += 1;
    }

    function fail(res, code, message) {
        res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(message);
    }

    async function handle(req, res) {
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

        // No IP gate: the portal faces the local network on purpose, and the
        // session cookie (issued only after a correct login) is the access
        // control. The login itself is throttled per source address.
        let pathname;
        try {
            pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        } catch {
            return fail(res, 400, 'bad request');
        }
        const method = req.method ?? 'GET';

        if (method === 'GET' && pathname === '/login') {
            if (touchSession(req, res)) {
                res.writeHead(302, { location: '/' });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(loginPage());
        }

        if (method === 'POST' && pathname === '/login') {
            if (throttled(req.socket.remoteAddress ?? '')) {
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
            const ok = matchesSecret(form.get('user') ?? '', expectedUserHash)
                && matchesSecret(form.get('pass') ?? '', expectedPassHash);
            if (ok) {
                loginAttempts.delete(req.socket.remoteAddress ?? '');
                const token = crypto.randomBytes(32).toString('hex');
                sessions.set(token, Date.now() + SESSION_TTL_MS);
                res.setHeader('set-cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
                res.writeHead(302, { location: '/' });
                return res.end();
            }
            bumpFailure(req.socket.remoteAddress ?? '');
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(loginPage('wrong username or password'));
        }

        if (method === 'POST' && pathname === '/logout') {
            const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
            if (token) sessions.delete(token);
            res.setHeader('set-cookie', sessionCookie('', 0) + '; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
            res.writeHead(302, { location: '/login' });
            return res.end();
        }

        // Everything below needs a live session.
        if (!touchSession(req, res)) {
            if (pathname === '/api/status' || pathname === '/api/feedback') {
                return fail(res, 401, 'unauthorized');
            }
            res.writeHead(302, { location: '/login' });
            return res.end();
        }

        if (method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(dashboardPage());
        }

        if (method === 'GET' && pathname === '/api/status') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify(buildStatus(options)));
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
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify({ lines }));
        }

        return fail(res, 404, 'not found');
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch(err => {
            log.error('[web]', err instanceof Error ? err : new Error(String(err)));
            if (!res.headersSent) fail(res, 500, 'internal error');
            else res.end();
        });
    });

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
    const reach = bind === DEFAULT_BIND || bind === '::'
        ? 'sign in from the local network'
        : `sign in from ${bind}`;
    log.log(`[web] portal on http://${bind === DEFAULT_BIND ? '127.0.0.1' : bind}:${boundPort}/ (${reach})`);

    return {
        server,
        port: boundPort,
        close() {
            clearInterval(sweep);
            sessions.clear();
            loginAttempts.clear();
            server.close();
        },
    };
}

module.exports = { startPortal, DEFAULT_BIND, DEFAULT_PORT };
