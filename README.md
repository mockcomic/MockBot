# MockBot: Your Interactive Discord Companion

MockBot is a Discord bot that brings practical utilities and full music playback
(DisTube v5 + yt-dlp) to your server. Every command works both as `!prefix` text
and as a native slash command, from one shared implementation.

It is built to run unattended on small hardware — the reference deployment is a
Raspberry Pi 4.

## Requirements

- **Node.js 22.12 or newer** — the installed DisTube declares `>=22.12.0`
  (`node -v` to check; the bot warns at startup if you are behind).
- A Discord application/bot with the **MESSAGE CONTENT** privileged intent enabled
  (Developer Portal → your application → Bot → Privileged Gateway Intents).
  **SERVER MEMBERS** powers the join welcome, auto-role and member join/leave
  modlog lines, but Discord withholds it from unverified bots — the bot asks
  the API at boot and simply runs without those features until it is granted.
- Invited with the `bot` and `applications.commands` scopes and at least:
  Send Messages, Manage Messages, Read Message History, Embed Links, Add Reactions,
  Connect, Speak. For `timeout`: Moderate Members; for `modlog`/`prefix`: Manage Server.
- For reaction roles: the bot's highest role must sit **above** every role it assigns.

## Setup

1. `npm install` — downloads dependencies, the yt-dlp binary and a static ffmpeg build.
2. Copy `.env.example` to `.env` and fill it in:

   | Variable | Purpose |
   |---|---|
   | `TOKEN` | Discord bot token (required) |
   | `OWNER` | Your Discord user ID — unlocks owner-only commands and lets you control playback from anywhere |
   | `MOCKBOT_DATA_DIR` | Optional: where the feedback log and menu ids live (default `./data`) |
   | `WEB_USER` + `WEB_PASS` | Optional: enables the web portal (see [Web portal](#web-portal)) |
   | `WEB_PASS_HASH` | Optional instead of `WEB_PASS`: sha256 hex digest, keeps the password out of `.env` |
   | `WEB_USERS` | Optional: named accounts `user:sha256hex,user2:sha256hex` — the audit log records who changed what |
   | `WEB_PORT` | Optional: portal port (default `8787`) |
   | `WEB_BIND` | Optional: bind address (default `0.0.0.0` = local network; `127.0.0.1` = this machine only) |
   | `WEB_ALLOWLIST` | Optional: comma-separated address prefixes allowed to reach the portal (e.g. `127.,192.168.0.`) |
   | `WEB_TLS_CERT` / `WEB_TLS_KEY` | Optional: serve HTTPS directly from the bot |
   | `WEB_SECURE=1` | Optional: mark the session cookie `Secure` behind a TLS-terminating proxy |

3. `npm start` (or `npm run dev` for auto-restart with nodemon).

Slash commands are re-registered in every server the bot is in at startup, so a
new command shows up after a restart — no setup script.

Sanity-check anything without a Discord connection:

```
npm test
```

This loads every module, serializes all slash builders, and exercises the queue
maths, reply-safety helpers, data storage and listeners offline.

## Web portal (optional)

Set `WEB_USER` and `WEB_PASS` in `.env` and the bot also serves an admin
portal on port 8787 (change with `WEB_PORT`) — from the bot's machine at
`http://127.0.0.1:8787/`, from anything else on your network at
`http://<the bot's LAN address>:8787/`. Six tabs:

- **Overview** — tag, version, uptime, gateway ping, memory, guild count,
  loaded/disabled command counts, total command executions, the most-used
  commands across all servers, and live music state everywhere.
- **Servers** — every server the bot is in: member/channel/voice counts,
  boost tier, owner, join date, the permissions it holds, per-server
  settings (prefix, 24/7, autoplay, vote-skip, modlog channel), that
  server's command toggles, its own most-used-commands list, and playback
  controls (skip / pause / resume / stop / volume) that work remotely.
- **Commands** — every command with its description, access level, use
  count, and a toggle. Turning one off removes it from the slash picker,
  the prefix parser and `help` everywhere (re-registered instantly). The
  bot owner can always run and see everything, so a mass-disable can never
  lock you out. Per-server force-on/force-off overrides live on the Servers
  tab; guild staff cannot disable owner-only commands.
- **Settings** — the editable global params: prefix, default and play
  cooldowns, idle-leave seconds, vote-skip and autoplay defaults, reaction
  roles on/off and the emoji-to-role table. Changes take effect **without a
  restart** (stored in `data/runtime-config.json` layered over
  `config.json`; every override shows there with a one-click revert).
- **Feedback** — the user-feedback log, newest first.
- **Audit** — every change made through the portal, timestamped and
  attributed to the signed-in account.

Security notes:

- **Local network by default.** The server binds to `0.0.0.0`, so anyone who
  can route to the machine can open it — the login is the access control, so
  use a real password. Traffic is plain HTTP unless you set
  `WEB_TLS_CERT`/`WEB_TLS_KEY` (or `WEB_SECURE=1` behind a TLS proxy): fine
  on a trusted LAN, do not expose the port to the internet. `WEB_BIND` locks
  it to one address; `WEB_ALLOWLIST` hard-gates which addresses get an
  answer at all. If Windows Firewall asks, allow Node on *private* networks
  for LAN devices to get through.
- **Session and CSRF.** Sessions are random 32-byte tokens in an `HttpOnly,
  SameSite=Strict` cookie with sliding 12-hour expiry, bound to your browser
  fingerprint, capped in count. Every mutation must carry the session's CSRF
  token in a header — a cross-site form post cannot change anything.
- **Passwords without passwords.** `WEB_PASS_HASH` (or `WEB_USERS`) store a
  sha256 digest instead of the plaintext, compared in constant time. Print a
  digest with:
  `node -e "console.log(require('crypto').createHash('sha256').update('your password').digest('hex'))"`.
- **Rate limits.** Failed logins: 10 per 5 minutes per address; API calls are
  rate-limited per address too, and request bodies are capped at 64 KB.
- A login session dies with the bot process; sign in again after a restart.
- Without the credentials the portal is off and boot logs
  `WEB_USER/WEB_PASS ... not set`; if the port is taken, boot logs the bind
  error and the bot keeps running without the page.

## Commands

`🔒` marks commands restricted to server staff or the bot owner; `help` hides them
from people who cannot run them.

**Music** — in control you must be in the bot's voice channel (the owner is exempt).

| Command | Aliases | Notes |
|---|---|---|
| `play <url \| search>` | `p` | Plain text searches YouTube and shows a top-5 picker — choose the song you meant. `play! <terms>` (or the slash `direct` option) auto-picks the top result instead, like old versions. `watch?v=…&list=…` queues the single video |
| `skip` | `next`, `s` | Instant for owner/requester/solo listener; otherwise a listener-majority vote (`voteskip` toggles) |
| `previous` | `prev`, `back` | Walks the saved song history |
| `stop` | | Clears the queue and disconnects |
| `leave` | `disconnect`, `dc` | Disconnect even in 24/7 mode |
| `pause` | `resume`, `unpause` | One toggle |
| `queue [page]` | `q` | 10 rows per page; row 1 (`▶`) is the playing song; ◀ ▶ buttons page |
| `nowplaying` | `np`, `playing` | Progress bar, requester, next song — with ⏸ ⏭ 🔀 buttons |
| `volume <0-150>` | `vol`, `v` | |
| `jump <position>` | | Positions match `queue`; `2` = next song, `-1` = previous |
| `repeat <off\|song\|queue>` | `loop` | |
| `remove <position\|all>` | `rm` | Row 1 is playing — use `skip` for that |
| `move <position> <to>` | `moveto` | Reorder the queue without re-adding |
| `clear` | | Empties the queue but lets the current song finish |
| `seek <seconds\|mm:ss>` | | `seek 90`, `seek 1:30`; refused on live streams |
| `shuffle` | `mix` | Keeps the playing song, shuffles the rest |
| `filter <name\|list\|clear>` | | See `filter list` for the available set |
| `playlist <save\|load\|list\|show\|delete> [name]` | `lists` | Saved queues: 200 songs × 20 lists per server; loads with no yt-dlp lookups (`save <name> replace` overwrites) |
| `lyrics [search]` | | Genius lyrics for the playing song or any search (optional `GENIUS_TOKEN`) |
| `autoplay <on\|off\|status>` | `auto` | When the list ends, queue the first other song of the YouTube radio mix |
| `247` | `stay` | Keep the voice connection when idle; `leave` is the manual exit |
| `voteskip <on\|off\|status>` | | Toggle the listener-majority skip rule for this server |
| `sponsorblock <on\|off\|status>` | `sb` | Skip sponsor/self-promo segments on VODs using the public SponsorBlock API (per-server, opt-in) |
| `sfx <name\|list\|add\|del>` | `sound`, `board` | Soundboard: clips you attach (`sfx add horn` + an mp3/ogg) play through the same voice pipeline — instant when idle, otherwise inserted as the next song |

**Utility** — `help`, `ping`, `myid`, `feedback <text>`, `stats`,
`poll [duration] <question> [ | option | option …]`,
`remind <when> <text>` / `remind list` / `remind cancel <id>` (durations like
`30m`, `2h30m`, `3d`; persisted, and delivered — marked *overdue* — even after
a restart)

**Staff / owner** — `purge <1-100>` 🔒(Manage Messages), `rr [#channel]` 🔒(Manage Roles),
`timeout <@member> <duration|off> [reason]` 🔒(Moderate Members),
`modlog [#channel|off]` 🔒(Manage Server), `prefix [set <new>|reset]` 🔒(Manage Server),
`welcome <show|channel|message|roles>` 🔒(Manage Server),
`dj <show|role|channel>` 🔒(Manage Server),
`watch <list|add <channel>|remove <channel>>` 🔒(Manage Server),
`feedbacklist` 🔒(owner), `reboot` 🔒(owner), `update` 🔒(owner)

**Join handling** — `welcome channel #general` greets new members (template with
`{member} {guild} {count}`), `welcome roles @Member @Verified` auto-assigns
them, and joins/leaves are logged to the `modlog` channel whenever one is set.
Needs the SERVER MEMBERS privileged intent; unverified bots get a boot warning
and the rest of the bot keeps working without it.

**DJ + music channel** — `dj role @DJ` restricts queue control to that role (the
song requester, staff with Manage Server, and the bot owner always pass);
`dj channel #music` makes `play`, `playlist load` and `sfx` work only there.

**Live announcements** — `watch add pokimane`, `watch add channel/UCxxxxxxxxx`
or full URLs. The poller checks every 60 s and posts once per stream go-live.
Twitch needs `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`; YouTube needs a
`GOOGLE_API_KEY` (Data API v3) and a UC… channel id (the channel's About page
shows a "Creator URL" you can paste).

## Configuration (`config.json`)

```jsonc
{
    "prefix": "!",
    "cooldowns": { "default": 3, "play": 5 },
    "music": {
        "leaveOnEmptyAfterSeconds": 90,
        "voteSkipEnabled": true,
        "autoplayByDefault": false
    },
    "reactionRoles": {
        "enabled": true,
        "channelId": "845386774327197726",
        "roles": [{ "name": "HOTS", "emoji": "1️⃣", "roleId": "845386774327197727" }]
    }
}
```

- `cooldowns` — per-user command spam brake, in seconds; `default` applies to
  every command (0 disables) and `play` overrides it because resolution hits
  the network. The bot owner is exempt.
- `music.voteSkipEnabled` / `music.autoplayByDefault` — starting values for
  the per-server `voteskip` / `autoplay` toggles (a server setting, once
  changed, wins over these).
- `music.leaveOnEmptyAfterSeconds` — how long to wait before leaving a voice
  channel that has no human listeners. DisTube v5 dropped its own
  `leaveOnEmpty`, so this is the replacement. Set to `0` to disable, or turn
  the watcher off per server with `247`.
- `reactionRoles.channelId` — default channel for `rr`; the command also
  accepts an explicit channel (`rr #roles`) and works in any guild. Reactions
  only count on menu messages this bot posted, so someone else's `1️⃣` poll
  cannot hand out roles.
- `reactionRoles.roles[].roleId` — optional but recommended: pinning an ID survives a
  role rename. `name` is the fallback, and `rr` prints the resolved IDs so you can paste them in.
- Emojis may be unicode or custom (`name:id`).

Per-server overrides (prefix, 24/7, autoplay, vote skip, modlog channel) live
in `data/guilds.json`; `prefix set`, `247`, `autoplay`, `voteskip` and
`modlog` write them, and slash commands are never affected by the prefix.

## Runtime data

The bot writes to `./data/` (gitignored) rather than the repository root, so a git
operation can never overwrite it:

- `data/feedback.sqlite` — feedback records (falls back to `data/feedback.txt`
  when better-sqlite3 could not be installed; a text log is imported once and
  kept as `feedback.txt.imported`)
- `data/reaction-roles.json` — menus the bot has posted (per message: channel, guild, allowed role ids)
- `data/guilds.json` — per-server overrides (prefix, 24/7, autoplay, vote skip, modlog, welcome, auto-role, dj, music channel, sponsorblock)
- `data/playlists.json` — `playlist save` snapshots
- `data/reminders.json` — pending `remind` entries with absolute timestamps
- `data/watch.json` — live-stream follows and current online flags
- `data/history.json` — play history and per-track play/skip counts
- `data/sounds/` — soundboard clips (add with `sfx add`)

A `feedback.txt` left in the repo root by an older install is moved into `data/`
(and into the database when SQLite is active) automatically.

## Good to know

- **`reboot` restarts the whole machine**, not just the bot — on a Pi that also
  takes anything else hosted there down with it. It uses `shutdown /r` on Windows
  and `systemctl reboot` (falling back to `shutdown -r now`) on Linux, which may
  need root.
- **`update` is non-destructive**: local edits are stashed, the pull is
  `--ff-only`, the stash is popped, and `npm install` runs when the pull touched
  dependency files. Restart afterwards to load new code. If `stash pop` conflicts,
  your copy is reported as still being in the stash rather than dropped.
- Playlist links resolve at most the first **100** entries, and each yt-dlp call is
  bounded (30 s for a stream lookup, 60 s for playlist/search resolution) with an
  8 MB output cap, so a stalled lookup reports an error instead of hanging the queue.
- **Player buttons** (⏸ ⏭ 🔀 and the queue ◀ ▶) obey the same rules as the
  commands: in the bot's voice channel, owner exempt — the page arrows are
  view-only and work for everyone. A ⏭ click routes through the vote logic, so
  the buttons cannot bypass a vote. Stale controls on old messages answer with
  a short ephemeral note and lose their buttons.
- **Vote skip** needs a majority of the *humans* in the voice channel
  (deafened people count; bots don't). The owner and the person who requested
  the song skip without a vote, and so does a solo listener. A running vote
  dies when the song changes.
- **Autoplay** fetches YouTube's radio mix (`RD<videoId>`) for the last song
  and queues the first entry that is *not* that song. Two brakes: 3
  consecutive failures pause autoplay for the session (a flaky network should
  not spam the channel), and it caps at 50 songs in a row without user input.
  Live streams are never used as a seed.
- **Reminders** are persisted with absolute timestamps and re-armed on boot,
  so `update` + `reboot` never loses them; what came due while the bot was
  down is delivered immediately, marked *overdue*. A reminder whose channel
  vanished falls back to a DM.
- **Polls** count votes with an in-memory collector — a restart while a poll
  is open leaves the message without its result line.
- **Cooldowns** are in-memory per user and command (a restart resets them);
  see `config.json` `cooldowns`.
- Replies never ping `@everyone` or roles on the bot's behalf: song titles, yt-dlp
  output and stored feedback are all remote text.
- Replies that can carry remote or command output are truncated at Discord's limits
  and cannot break out of their code fence.

## Troubleshooting

- **Prefix commands do not respond** — enable the MESSAGE CONTENT intent.
- **Music errors mentioning yt-dlp** — yt-dlp auto-updates on startup; if a YouTube
  change breaks playback, restart the bot or `npm install @distube/yt-dlp@latest`.
- **`yt-dlp timed out`** — a slow or blocked network to the video host; retry, and
  check that the Pi has outbound HTTPS.
- **`Cannot connect to the voice channel after 30 seconds`** — run
  `node test/voice-probe.js` on the machine the bot runs on; it prints the
  state trail of a bare voice join and names where the handshake dies. The
  usual causes: outbound UDP to Discord's voice servers blocked and the TCP
  fallback also refused (firewall/ISP), or the bot missing **Connect** on the
  channel. The "30 seconds" wording is DisTube's fixed timeout, so the message
  is identical even when Discord rejects the session outright — the probe is
  what tells these apart.
- **`ffmpeg not found`** — `ffmpeg-static` is bundled; otherwise put ffmpeg on PATH.
- **`TOKEN is missing` / `Login failed`** — check your `.env` file.
- **Web portal did not start** — both `WEB_USER` and `WEB_PASS` must be set, and
  `WEB_PORT` (default 8787) must be free; the boot log says which of the two it
  was. Remember `.env` is only read at boot: restart after editing it.
- **Web portal rejects the right password** — an unquoted `#` in a `.env` value
  starts a comment, so `WEB_PASS=abc#123` arrives as just `abc`. Quote the
  value: `WEB_PASS="abc#123"`.
- **Portal unreachable from another device** — `WEB_BIND` must not be
  `127.0.0.1` (that locks it to the bot's machine), and the OS firewall has to
  allow Node on the private network.
- **`rr` says the channel was not found** — `reactionRoles.channelId` points at a
  channel this guild does not have.
- **Roles are not assigned** — the bot's highest role is below the target role, or
  the configured name no longer matches (switch that entry to `roleId`). The bot
  logs one line per guild the first time it notices.
- **"That control no longer works"** — the buttons live on the old embed; the
  queue moved on. Run `nowplaying` (or `queue`) again.
- **`timeout` refuses a member** — Discord requires your bot's highest role
  above the target's (owners can never be timed out), and 28 days is the max.
- **`lyrics` finds nothing** — Genius search is title-matching; help it with
  `lyrics <artist> <song>`. A `GENIUS_TOKEN` in `.env` reduces rate-limit
  rejections.
- **A `⏳ Please wait` reply appears** — that is the per-user cooldown
  (`config.json` `cooldowns`); it is a spam brake, not an error.
- **"You must be in … to use this command"** — the music controls require you to be
  in the bot's voice channel; the `OWNER` account is exempt.

## Contributions and Feedback

Fork away and open pull requests — contributions are welcome. If you would rather
just use the bot, the `feedback` command lands in the feedback store under
`data/` for the owner (and `feedbacklist` reads it back).

Let's enhance our Discord servers with the entertaining and useful MockBot!
