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
- Invited with the `bot` and `applications.commands` scopes and at least:
  Send Messages, Manage Messages, Read Message History, Embed Links, Add Reactions,
  Connect, Speak.
- For reaction roles: the bot's highest role must sit **above** every role it assigns.

## Setup

1. `npm install` — downloads dependencies, the yt-dlp binary and a static ffmpeg build.
2. Copy `.env.example` to `.env` and fill it in:

   | Variable | Purpose |
   |---|---|
   | `TOKEN` | Discord bot token (required) |
   | `OWNER` | Your Discord user ID — unlocks owner-only commands and lets you control playback from anywhere |
   | `MOCKBOT_DATA_DIR` | Optional: where the feedback log and menu ids live (default `./data`) |

3. `npm start` (or `npm run dev` for auto-restart with nodemon).

Slash commands are re-registered in every server the bot is in at startup, so a
new command shows up after a restart — no setup script.

Sanity-check anything without a Discord connection:

```
npm test
```

This loads every module, serializes all slash builders, and exercises the queue
maths, reply-safety helpers, data storage and listeners offline.

## Commands

`🔒` marks commands restricted to server staff or the bot owner; `help` hides them
from people who cannot run them.

**Music** — in control you must be in the bot's voice channel (the owner is exempt).

| Command | Aliases | Notes |
|---|---|---|
| `play <url \| search>` | `p` | Plain text searches YouTube; `watch?v=…&list=…` queues the single video |
| `skip` | `next`, `s` | |
| `previous` | `prev`, `back` | Walks the saved song history |
| `stop` | | Clears the queue and disconnects |
| `pause` | `resume`, `unpause` | One toggle |
| `queue [page]` | `q` | 10 rows per page; row 1 (`▶`) is the playing song |
| `nowplaying` | `np`, `playing` | Progress bar, requester, next song |
| `volume <0-150>` | `vol`, `v` | |
| `jump <position>` | | Positions match `queue`; `2` = next song, `-1` = previous |
| `repeat <off\|song\|queue>` | `loop` | |
| `remove <position\|all>` | `rm` | Row 1 is playing — use `skip` for that |
| `clear` | | Empties the queue but lets the current song finish |
| `seek <seconds\|mm:ss>` | | `seek 90`, `seek 1:30`; refused on live streams |
| `shuffle` | `mix` | Keeps the playing song, shuffles the rest |
| `filter <name\|list\|clear>` | | See `filter list` for the available set |

**Utility** — `help`, `ping`, `myid`, `feedback <text>`

**Staff / owner** — `purge <1-100>` 🔒(Manage Messages), `rr` 🔒(Manage Roles),
`feedbacklist` 🔒(owner), `reboot` 🔒(owner), `update` 🔒(owner)

## Configuration (`config.json`)

```jsonc
{
    "prefix": "!",
    "music": { "leaveOnEmptyAfterSeconds": 90 },
    "reactionRoles": {
        "enabled": true,
        "channelId": "845386774327197726",
        "roles": [{ "name": "HOTS", "emoji": "1️⃣", "roleId": "845386774327197727" }]
    }
}
```

- `music.leaveOnEmptyAfterSeconds` — how long to wait before leaving a voice
  channel that has no human listeners. DisTube v5 dropped its own
  `leaveOnEmpty`, so this is the replacement. Set to `0` to disable.
- `reactionRoles.channelId` — where `rr` posts its menu. Reactions only count on
  messages this bot posted there, so someone else's `1️⃣` poll cannot hand out roles.
- `reactionRoles.roles[].roleId` — optional but recommended: pinning an ID survives a
  role rename. `name` is the fallback, and `rr` prints the resolved IDs so you can paste them in.
- Emojis may be unicode or custom (`name:id`).

## Runtime data

The bot writes to `./data/` (gitignored) rather than the repository root, so a git
operation can never overwrite it:

- `data/feedback.txt` — one timestamped line per `feedback` command
- `data/reaction-roles.json` — ids of the menus the bot has posted

A `feedback.txt` left in the repo root by an older install is moved into `data/`
automatically on the first new feedback entry.

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
- **`ffmpeg not found`** — `ffmpeg-static` is bundled; otherwise put ffmpeg on PATH.
- **`TOKEN is missing` / `Login failed`** — check your `.env` file.
- **`rr` says the channel was not found** — `reactionRoles.channelId` points at a
  channel this guild does not have.
- **Roles are not assigned** — the bot's highest role is below the target role, or
  the configured name no longer matches (switch that entry to `roleId`). The bot
  logs one line per guild the first time it notices.
- **"You must be in … to use this command"** — the music controls require you to be
  in the bot's voice channel; the `OWNER` account is exempt.

## Contributions and Feedback

Fork away and open pull requests — contributions are welcome. If you would rather
just use the bot, the `feedback` command lands in `data/feedback.txt` for the owner
(and `feedbacklist` reads it back).

Let's enhance our Discord servers with the entertaining and useful MockBot!
