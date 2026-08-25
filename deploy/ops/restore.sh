#!/usr/bin/env bash
# Restore Puca from a backup pair produced by backup.sh.
#
#   restore.sh <*-db-YYYYMMDD-HHMMSS.sql.gz> [*-uploads-...tar.gz]
#
# DESTRUCTIVE: drops + recreates the database and (if an uploads archive is
# given) replaces <install dir>/uploads. Stops the service first and restarts it
# after. Run this on the server, as root.
#
# The names are RESOLVED (see names.sh), which matters most here: hardcoding
# them would drop and recreate an empty database under the wrong name, leave the
# real one untouched, and report a successful restore.
#
# To rehearse safely without touching prod, restore the DB into a scratch name:
#   sudo -u postgres psql -c 'CREATE DATABASE restoretest'
#   gunzip -c <db.sql.gz> | sudo -u postgres psql restoretest
# and inspect it, then drop it. (That path skips this script entirely.)
set -euo pipefail

. "$(dirname "$0")/names.sh"
ops_require_install restore

DB_GZ="${1:?usage: restore.sh <db.sql.gz> [uploads.tar.gz]}"
UP_TGZ="${2:-}"
UPLOADS=$INSTALL_DIR/uploads

[ -f "$DB_GZ" ] || { echo "no such db backup: $DB_GZ" >&2; exit 1; }
[ -z "$UP_TGZ" ] || [ -f "$UP_TGZ" ] || { echo "no such uploads backup: $UP_TGZ" >&2; exit 1; }

echo "About to REPLACE the live '$DB_NAME' database on this host"
[ -n "$UP_TGZ" ] && echo "  and overwrite $UPLOADS from $(basename "$UP_TGZ")"
read -r -p "Type 'yes' to continue: " ok
[ "$ok" = "yes" ] || { echo "aborted"; exit 1; }

systemctl stop "$SERVICE_NAME"

sudo -u postgres dropdb --if-exists "$DB_NAME"
sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
gunzip -c "$DB_GZ" | sudo -u postgres psql -q "$DB_NAME"

if [ -n "$UP_TGZ" ]; then
	rm -rf "$UPLOADS"
	tar -xzf "$UP_TGZ" -C "$(dirname "$UPLOADS")"
	chown -R "$SERVICE_USER:$SERVICE_USER" "$UPLOADS" 2>/dev/null || true
fi

systemctl start "$SERVICE_NAME"
echo "restore complete — check: systemctl status $SERVICE_NAME && curl -sf localhost:3000/ >/dev/null && echo up"
