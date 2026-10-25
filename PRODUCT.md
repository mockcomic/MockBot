# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the bot's owner (mockcomic) and friends in one personal Discord server — music sessions in voice channels, casual `!play`/`!queue` use from Discord, and hands-on admin through the web portal from the local network. Secondary audience planned: strangers' servers — the bot is personal now but is being kept public-ready, so anything user-facing must degrade gracefully and never assume the owner is present.

## Product Purpose

A self-hosted Discord music + utility bot (45 commands: playback, playlists, saved queues, soundboard, moderation, welcome/auto-role, reminders, stream watch). Success = the owner and friends get reliable, low-fuss music and light moderation in their own server, on the owner's own hardware, without third-party bot services holding their queue or data.

## Positioning

Everything runs locally on the owner's rig and stores as plain files (SQLite/JSON under `data/`): the media pipeline (yt-dlp + system ffmpeg), the settings, the play history, and the admin portal are all owned, inspectable, and portable. Unlike hosted music bots, there is no account, no dashboard vendor, and no rate limit that isn't YouTube's. The admin portal ships inside the bot process — zero npm dependencies, one file, LAN-facing by default.

## Operating Context

- Runs under `systemctl --user mockbot` on a home Linux rig (RTX 3090 host); dev loop is edit → `node test/smoke.js` → restart → live test in the server's voice channel with the owner present.
- All user-facing output is Discord-side: text replies, embeds, select-menu pickers, button rows (play/pause/skip controls), and 👀 ack reactions. The embed copy IS the product voice.
- The admin web portal (`web/portal.js`) is served by the bot itself with its own login/session/CSRF model.
- Git flow: work lands on `dev`; `main` only receives deliberate merges.

## Capabilities and Constraints

- Discord-only interaction model: replies, embeds, components; no custom hosting of pages except the portal.
- The portal is dependency-free by design (single file, no build step, no npm UI deps) and its CSP blocks external resources — fonts/CDNs are not available there.
- Portal may grow into the main admin surface someday: do not design it as throwaway, but it must not require public-internet exposure (LAN-only bind is the current deployment).
- Media playback depends on yt-dlp and system ffmpeg (the bundled static build crashes on this host — prefer system binaries).
- Both Discord and portal surfaces count as MockBot's interface for design work (confirmed).
- Undecided: public listing / verification (bot currently lacks the SERVER MEMBERS privileged intent; features gate on it gracefully).

## Brand Commitments

Name: MockBot (MockBot#3003). Voice: terse, warm, emoji-led status lines (`✅`, `❌`, `👋`, `😴`), usage errors that name the command you should have used instead of stack-trace text. No fabricated testimonials or "trusted by N servers" claims — it's one friend's bot until it isn't.

## Evidence on Hand

- Live command surface: 45 commands with slash + prefix parity (`commands/`).
- Portal code with a documented security model (`web/portal.js` header comment).
- Offline smoke suite (`test/smoke.js`) exercising registry, guards, stores, and music maths.
- Real usage history in `data/` (play counts, usage stats, feedback) — usable as demo content.
- Absence: no marketing copy, no logo beyond `lib/logo.png`, no screenshots/press. Do not invent any.

## Product Principles

1. Local-first ownership: the queue, settings, and history live on the owner's disk in readable formats.
2. Reply-quality is product-quality: every Discord message is a designed surface — informative confirmations, actionable errors.
3. Personal now, public-ready: nothing may hard-assume the owner's presence; permissions and graceful degradation already encode that.
4. Zero-dependency admin: the portal stays one file the bot can always serve.
5. Never break the music: diagnostics and guards exist so a failure says what happened instead of going silent (the no-audio bug and its `[voice.diag]` chase set the standard).

## Accessibility & Inclusion

No formal standard required. Portal must stay keyboard-usable and readable in its dark theme; Discord surfaces inherit Discord's own a11y.
