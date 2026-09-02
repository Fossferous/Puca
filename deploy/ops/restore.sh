#!/usr/bin/env bash
# Restore Puca from a backup set produced by backup.sh.
#
#   restore.sh <*-db-YYYYMMDD-HHMMSS.sql.gz[.age|.gpg]> [*-uploads-...tar.gz[.age|.gpg]]
#
# DESTRUCTIVE: drops + recreates the database and (if an uploads archive is
# given) replaces <install dir>/uploads. Stops the service first and restarts it
# after. Run this on the server, as root.
#
# EVERYTHING THAT CAN REFUSE, REFUSES FIRST — before the service is stopped and
# before anything is dropped. The previous version ran `dropdb` and only then
# discovered that `createdb -O $DB_USER` needed a role that the self-hosting
# guides never created: the live database was already gone, the service was
# already down, and the script aborted in the middle of the one situation it
# exists for. So the owner role, every role the dump itself names, and the
# ability to decrypt an offsite artifact are all checked up front.
#
# The names are RESOLVED (see names.sh), which matters most here: hardcoding
# them would drop and recreate an empty database under the wrong name, leave the
# real one untouched, and report a successful restore.
#
# OFFSITE ARTIFACTS ARE ENCRYPTED (`.age` / `.gpg`, see backup.sh). Hand one in
# and it is decrypted into a private temp dir first — which needs the private
# half, expected to live OFF this box: set BACKUP_AGE_IDENTITY (a path) in
# /etc/default/puca-backup or the environment for the duration of the restore,
# and remove it again afterwards. gpg uses root's keyring.
#
# THE CONFIG ARCHIVE (`<db>-config-*.tar.gz`, also produced by backup.sh) is
# deliberately NOT applied here. It holds the previous .env — JWT_SECRET, the
# database password, TURN/LiveKit secrets — and swapping those under a running
# host logs every user out. On a REBUILT box, restore it by hand BEFORE
# starting the service, and only the parts you mean:
#     tar -tzf <db>-config-<ts>.tar.gz              # see what is in it
#     tar -xzf <db>-config-<ts>.tar.gz -C / opt/puca/.env
#
# To rehearse safely without touching prod, use restore-drill.sh (non-destructive
# by construction), or restore the DB into a scratch name by hand:
#   sudo -u postgres psql -c 'CREATE DATABASE restoretest'
#   gunzip -c <db.sql.gz> | sudo -u postgres psql restoretest
set -euo pipefail

# Optional site config: BACKUP_AGE_IDENTITY for encrypted offsite artifacts.
# shellcheck disable=SC1091
if [ -f /etc/default/puca-backup ]; then set -a; . /etc/default/puca-backup; set +a; fi

. "$(dirname "$0")/names.sh"
ops_require_install restore

DB_GZ_IN="${1:?usage: restore.sh <db.sql.gz[.age|.gpg]> [uploads.tar.gz[.age|.gpg]]}"
UP_TGZ_IN="${2:-}"
UPLOADS=$INSTALL_DIR/uploads

[ -f "$DB_GZ_IN" ] || { echo "no such db backup: $DB_GZ_IN" >&2; exit 1; }
[ -z "$UP_TGZ_IN" ] || [ -f "$UP_TGZ_IN" ] || { echo "no such uploads backup: $UP_TGZ_IN" >&2; exit 1; }

fatal() { echo "FATAL(restore): $*" >&2; echo "  Nothing has been stopped or dropped." >&2; exit 78; }

# --- 0. Decrypt, if these are offsite artifacts ----------------------------------
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DB_GZ="$(ops_decrypt_artifact "$DB_GZ_IN" "$WORK")" \
	|| fatal "cannot open $(basename "$DB_GZ_IN") on this host (see above). Set BACKUP_AGE_IDENTITY to the age identity for this restore, or restore from the local plaintext copy in $INSTALL_DIR/backups."
UP_TGZ=""
if [ -n "$UP_TGZ_IN" ]; then
	UP_TGZ="$(ops_decrypt_artifact "$UP_TGZ_IN" "$WORK")" \
		|| fatal "cannot open $(basename "$UP_TGZ_IN") on this host (see above)."
fi

# --- 1. Pre-flight: the roles this restore needs must already exist -------------
psql_q() { sudo -u postgres psql -tAc "$1" 2>/dev/null; }
role_exists() { psql_q "SELECT 1 FROM pg_roles WHERE rolname='$1'" | grep -q 1; }

# The owner for `createdb -O`: whatever owns the LIVE database when there is
# one (a deployment built as the postgres superuser, per the older guides,
# keeps working unchanged), else DB_USER — the fresh-install role, and the
# only answer on a rebuilt box where no database exists yet.
DB_OWNER="$(psql_q "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='$DB_NAME'" | tr -d '[:space:]')"
DB_OWNER="${DB_OWNER:-$DB_USER}"
if ! role_exists "$DB_OWNER"; then
	fatal "Postgres role '$DB_OWNER' does not exist on this host, and createdb -O needs it.
  Create it to match DATABASE_URL in $INSTALL_DIR/.env:
      sudo -u postgres psql -c \"CREATE ROLE $DB_OWNER LOGIN PASSWORD '<the password in DATABASE_URL>'\"
  or set DB_USER in /etc/default/puca to the role that should own the database."
fi

# The dump names the roles that owned its objects (pg_dump emits
# `ALTER TABLE ... OWNER TO <role>`), and psql runs under ON_ERROR_STOP below —
# so a role missing here would abort the restore on its first mention, AFTER
# the drop. Find them now, while refusing is still free.
missing_roles=""
for r in $(gunzip -c "$DB_GZ" | grep -oE 'OWNER TO "?[A-Za-z0-9_]+"?;' | sed -E 's/OWNER TO "?([A-Za-z0-9_]+)"?;/\1/' | sort -u); do
	role_exists "$r" || missing_roles="$missing_roles $r"
done
if [ -n "$missing_roles" ]; then
	fatal "the dump assigns ownership to role(s) that do not exist on this host:$missing_roles
  Create them (CREATE ROLE <name> LOGIN ...) before restoring, or the restore aborts part-way with the database already dropped."
fi

echo "About to REPLACE the live '$DB_NAME' database on this host (owner: $DB_OWNER)"
[ -n "$UP_TGZ" ] && echo "  and overwrite $UPLOADS from $(basename "$UP_TGZ_IN")"
read -r -p "Type 'yes' to continue: " ok
[ "$ok" = "yes" ] || { echo "aborted"; exit 1; }

# --- 2. The destructive part -------------------------------------------------------
systemctl stop "$SERVICE_NAME"

sudo -u postgres dropdb --if-exists "$DB_NAME"
sudo -u postgres createdb -O "$DB_OWNER" "$DB_NAME"
# ON_ERROR_STOP is what makes `set -euo pipefail` above actually bite. Without
# it psql reports failing statements and then EXITS 0, so a dump that restored
# 60% of its tables and errored on the rest sails through to the "restore
# complete" line below — on the disaster-recovery path, in exactly the scenario
# this script exists for. `-q` compounds it by hiding the notices that would
# otherwise hint something was wrong.
gunzip -c "$DB_GZ" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 "$DB_NAME"

if [ -n "$UP_TGZ" ]; then
	rm -rf "$UPLOADS"
	tar -xzf "$UP_TGZ" -C "$(dirname "$UPLOADS")"
	chown -R "$SERVICE_USER:$SERVICE_USER" "$UPLOADS" 2>/dev/null || true
fi

systemctl start "$SERVICE_NAME"
echo "restore complete — check: systemctl status $SERVICE_NAME && curl -sf $HEALTH_URL >/dev/null && echo up"
echo "(a rebuilt host also needs its previous .env — see the header of this script about the config archive)"
