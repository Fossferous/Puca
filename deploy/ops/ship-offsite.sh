#!/usr/bin/env bash
# Offsite shipper for backup.sh. Called as: ship-offsite.sh <file>
# Uploads one backup artifact to an rclone remote (Google Drive, R2, B2, etc.).
#
# Wire it in /etc/default/puca-backup:
#   OFFSITE_CMD=/opt/puca/ship-offsite.sh
#   RCLONE_REMOTE=gdrive:puca-backups     # <remote>:<path>
#
# rclone reads /root/.config/rclone/rclone.conf (created once via `rclone config`).
set -euo pipefail

FILE="${1:?usage: ship-offsite.sh <file>}"
REMOTE="${RCLONE_REMOTE:?set RCLONE_REMOTE in /etc/default/puca-backup}"
CONF="${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"

# `copy` uploads the file into the remote path (idempotent; skips if identical).
rclone --config "$CONF" copy "$FILE" "$REMOTE"

# Prune remote copies older than the retention window (matches backup.sh's local
# rotation) so the offsite target doesn't grow unbounded. Best-effort.
rclone --config "$CONF" delete --min-age "${KEEP_DAYS:-14}d" "$REMOTE" 2>/dev/null || true
