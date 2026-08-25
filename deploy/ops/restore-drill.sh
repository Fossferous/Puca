#!/usr/bin/env bash
# NON-DESTRUCTIVE restore rehearsal. Proves a backup can actually be restored
# WITHOUT touching the live database or uploads. Run on the server, as root.
#
#   restore-drill.sh                 # pull newest backup from offsite (rclone), verify
#   restore-drill.sh --local         # use the newest LOCAL backup instead of offsite
#   restore-drill.sh <db.sql.gz> [uploads.tar.gz]   # verify specific files
#
# What it does: restores the DB dump into a throwaway database (<db>_drill_<ts>),
# runs sanity queries (table count, row counts for key tables), extracts the
# uploads tar to a temp dir and counts files, then DROPS the scratch DB and
# removes the temp dir. The live DB and uploads are never touched.
set -uo pipefail

# Names are resolved, not hardcoded — a drill that looks for backups under the
# wrong prefix finds none and would otherwise report a clean run. See names.sh.
. "$(dirname "$0")/names.sh"

BACKUP_DIR=$INSTALL_DIR/backups
DRILL_DB="${DB_NAME}_drill_$(date +%s)"
TMP=$(mktemp -d)
CONF=/root/.config/rclone/rclone.conf
[ -f /etc/default/puca-backup ] && . /etc/default/puca-backup
RCLONE_REMOTE="${RCLONE_REMOTE:-}"

fail=0
note(){ echo "  $*"; }
ok(){   echo "PASS  $*"; }
bad(){  echo "FAIL  $*"; fail=$((fail+1)); }

cleanup(){
	sudo -u postgres dropdb --if-exists "$DRILL_DB" 2>/dev/null || true
	rm -rf "$TMP"
}
trap cleanup EXIT

# --- 1. Locate the backup pair ---
DB_GZ=""; UP_TGZ=""
case "${1:-}" in
	--local)
		[ -d "$BACKUP_DIR" ] || { echo "no backup dir '$BACKUP_DIR' — set INSTALL_DIR in /etc/default/puca"; exit 78; }
		DB_GZ=$(ls -t "$BACKUP_DIR"/"$DB_NAME"-db-*.sql.gz 2>/dev/null | head -1)
		UP_TGZ=$(ls -t "$BACKUP_DIR"/"$DB_NAME"-uploads-*.tar.gz 2>/dev/null | head -1)
		note "using newest LOCAL backup from $BACKUP_DIR"
		;;
	"" )
		# Offsite: fetch the newest db + uploads from the remote.
		[ -n "$RCLONE_REMOTE" ] || { echo "OFFSITE not configured (RCLONE_REMOTE unset); try --local"; exit 1; }
		note "fetching newest backup from offsite: $RCLONE_REMOTE"
		DBN=$(rclone --config "$CONF" lsf "$RCLONE_REMOTE" --include "$DB_NAME-db-*.sql.gz" | sort | tail -1)
		UPN=$(rclone --config "$CONF" lsf "$RCLONE_REMOTE" --include "$DB_NAME-uploads-*.tar.gz" | sort | tail -1)
		[ -n "$DBN" ] || { echo "no db backup found on offsite remote"; exit 1; }
		rclone --config "$CONF" copy "$RCLONE_REMOTE/$DBN" "$TMP/"
		[ -n "$UPN" ] && rclone --config "$CONF" copy "$RCLONE_REMOTE/$UPN" "$TMP/"
		DB_GZ="$TMP/$DBN"; UP_TGZ="$TMP/$UPN"
		;;
	* )
		DB_GZ="$1"; UP_TGZ="${2:-}"
		note "using explicit files"
		;;
esac
[ -n "$DB_GZ" ] && [ -f "$DB_GZ" ] && ok "db backup located: $(basename "$DB_GZ") ($(du -h "$DB_GZ" | cut -f1))" || bad "db backup not found"

# --- 2. Integrity of the archives ---
gzip -t "$DB_GZ" 2>/dev/null && ok "db gzip integrity" || bad "db gzip corrupt"
if [ -n "$UP_TGZ" ] && [ -f "$UP_TGZ" ]; then
	tar -tzf "$UP_TGZ" >/dev/null 2>&1 && ok "uploads tar integrity" || bad "uploads tar corrupt"
fi

# --- 3. Restore into a THROWAWAY database ---
if sudo -u postgres createdb "$DRILL_DB" 2>/dev/null; then
	if gunzip -c "$DB_GZ" | sudo -u postgres psql -q "$DRILL_DB" >/dev/null 2>&1; then
		ok "restored into scratch db $DRILL_DB"
		TC=$(sudo -u postgres psql -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" "$DRILL_DB")
		[ "${TC:-0}" -ge 20 ] && ok "schema present ($TC tables)" || bad "too few tables ($TC)"
		for t in users servers channels messages; do
			c=$(sudo -u postgres psql -tAc "SELECT count(*) FROM $t" "$DRILL_DB" 2>/dev/null || echo "ERR")
			note "rows in $t: $c"
		done
	else
		bad "restore into scratch db failed"
	fi
else
	bad "could not create scratch db"
fi

# --- 4. Uploads restore sanity ---
if [ -n "$UP_TGZ" ] && [ -f "$UP_TGZ" ]; then
	# Assert on the OUTCOME, not on having run the command. This previously
	# printed PASS when tar failed outright and when the archive held zero
	# files — an assertion that cannot fail is not a check.
	if ! tar -xzf "$UP_TGZ" -C "$TMP" 2>/dev/null; then
		bad "uploads extract failed"
	else
		N=$(find "$TMP/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')
		if [ "${N:-0}" -gt 0 ]; then
			ok "uploads extracted ($N file(s))"
		else
			bad "uploads archive extracted to 0 files"
		fi
	fi
fi

echo
if [ "$fail" -eq 0 ]; then
	echo "RESTORE DRILL PASSED — this backup is restorable. (scratch db + temp files cleaned up)"
else
	echo "RESTORE DRILL FAILED ($fail issue(s)) — investigate before trusting the backups."
fi
exit "$fail"
