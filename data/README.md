# Runtime state directory.
#
# The bot writes here instead of the repository root so `update` (git pull) can
# never touch it:
#   feedback.txt / feedback.sqlite — one record per `feedback` command (SQLite
#                                    when better-sqlite3 loaded; feedback.txt
#                                    is imported to feedback.txt.imported once)
#   reaction-roles.json   — menus this bot posted (v2: per-message records)
#   guilds.json           — per-guild settings (prefix, 247, autoplay, voteSkip, modlog)
#   playlists.json        — `playlist save` snapshots, per guild
#   reminders.json        — pending `remind` entries (absolute timestamps)
#
# Everything in this folder is gitignored except this file.
