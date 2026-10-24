# Runtime state directory.
#
# The bot writes here instead of the repository root so `update` (git pull) can
# never touch it:
#   feedback.txt          — one line per `feedback` command
#   reaction-roles.json   — ids of the menus this bot posted
#
# Everything in this folder is gitignored except this file.
