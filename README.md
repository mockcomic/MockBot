# MockBot: Your Interactive Discord Companion
MockBot is a delightful and convenient Discord bot that I've been developing as a personal project. Its purpose is to bring a wide range of enjoyable and practical utilities to your Discord server, enhancing interactivity and user-friendliness — including full music playback via DisTube v5 + yt-dlp.

Currently, MockBot operates efficiently on a Raspberry Pi 4 running Raspbian, showcasing its ability to function seamlessly on minimal hardware.

## Requirements
- **Node.js 20 LTS or newer** (Node 18 minimum)
- A Discord application/bot with the **MESSAGE CONTENT** privileged intent enabled
  (Discord Developer Portal → your application → Bot → Privileged Gateway Intents)
- The bot invited with the `bot` and `applications.commands` scopes and at least:
  Send Messages, Read Message History, Embed Links, Connect, Speak

## Setup and Configuration
1. `npm install` (downloads dependencies, the yt-dlp binary, and a static ffmpeg build)
2. Copy `.env.example` to `.env` in the project root and fill in your keys:

   | Variable | Purpose |
   |---|---|
   | `TOKEN` | Discord bot token (required) |
   | `OWNER` | Your Discord user ID — enables owner-only commands (required for purge/rr/reboot/update) |
   | `GPT` | OpenAI API key for `!gpt` |
   | `GEMINI_API_KEY` | Google Gemini API key for `!gemini` (old `.env` files may call this `BARD`) |
   | `OLLAMAAPI` / `OLLAMAMODEL` | Ollama endpoint/model for `!ollama` (defaults: `http://127.0.0.1:11434/api/generate`, `dolphin-mixtral`) |
   | `TENORKEY` | **Tenor v2** API key (Google Cloud) for `!gif` — old Tenor v1 keys no longer work |

3. `npm start` (or `npm run dev` for auto-restart with nodemon)

Slash commands are registered automatically in every server the bot is in when it starts.

## Commands
Every command works with the `!` prefix **and** as a slash command.

**Music** — `play <url|search>`, `skip` (alias `next`), `stop`, `queue`, `volume <0-150>`, `jump <n>`, `repeat <off|song|queue>`, `filter <name|list|clear>`, `pause`/`resume`

**Utility** — `help`, `ping`, `myID`, `feedback <text>`, `gif <search>`

**AI** — `gpt <question>` (gpt-4o-mini), `gemini <question>` (gemini-2.0-flash), `ollama <question>` (local Ollama)

**Owner only** — `purge <1-100>`, `rr` (post reaction-role message), `feedbacklist`, `reboot`, `update`

Reaction-role roles/emoji are configured in `config.json` under `reactionRoles`.

## Troubleshooting
- **Prefix commands don't respond** — enable the MESSAGE CONTENT intent in the Developer Portal.
- **Music errors mentioning yt-dlp** — yt-dlp auto-updates on startup; if a YouTube change breaks playback, restart the bot or run `npm install @distube/yt-dlp@latest`.
- **`ffmpeg not found`** — `ffmpeg-static` is bundled; otherwise install ffmpeg and put it on PATH.
- **`TOKEN is missing` / `Login failed`** — check your `.env` file.

## Contributions and Feedback
Feel free to fork the repository, make changes, and submit pull requests. Contributions are always welcome! If you prefer to use the bot as-is, simply invite it to your server.

Your feedback is valuable! It helps us improve the bot and address any hidden issues. Therefore, we greatly appreciate your thoughts and suggestions.

Let's enhance our Discord servers with the entertaining and useful MockBot!
