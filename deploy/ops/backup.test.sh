#!/usr/bin/env bash
# Tests for backup.sh, offline against a sandbox install dir: stub `pg_dump`
# (prints a dump), `psql`/`systemctl`/`sudo`/`logger`, a stub `df` whose free
# space each case dictates, and a stub `age`. gzip and tar are real.
#
#   ./backup.test.sh    (bash on Linux; the mode assertions SKIP elsewhere)
#
# WHAT IT PINS
#   1. Three artifacts, not two: the config archive carries .env, and it goes
#      through the SAME offsite gate as the dump — withheld without a
#      recipient, shipped encrypted with one. (A plaintext .env offsite hands
#      over JWT_SECRET, i.e. a login for every account.)
#   2. The uploads stage skips itself on low free space instead of filling the
#      disk Postgres shares — with the positive control that ample space
#      produces the archive, or a script that never tars would pass.
#   3. MAX_LOCAL_UPLOAD_ARCHIVES keeps exactly N newest; unset keeps all
#      (today's behaviour, so no host loses depth on the night it updates).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has() { printf '%s' "$1" | grep -qF -- "$2" && echo 1 || echo 0; }
count() { printf '%s' "$1" | grep -cF -- "$2"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INSTALL="$TMP/install"; STATE="$TMP/state"; CALLS="$TMP/calls.log"; OFFSITE="$TMP/offsite"
mkdir -p "$INSTALL/uploads" "$STATE" "$TMP/bin" "$OFFSITE"

# --- stubs ---------------------------------------------------------------------
cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"
STUB
printf '#!/usr/bin/env bash\necho "pg_dump $*" >> "$CALLS"\nprintf "CREATE TABLE users (id int);\\n"\n' > "$TMP/bin/pg_dump"
printf '#!/usr/bin/env bash\necho 1\n' > "$TMP/bin/psql"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/systemctl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/logger"
# df: reports whatever free space $STATE/df-avail says, in the two shapes the
# script asks for.
cat > "$TMP/bin/df" <<'STUB'
#!/usr/bin/env bash
avail="$(cat "$BK_STATE/df-avail" 2>/dev/null || echo 999999999999)"
case "$*" in
	*-B1*) printf 'Avail\n%s\n' "$avail" ;;
	*)     printf 'Avail\n%s\n' "$avail" ;;
esac
STUB
# age "encrypts" by copying, so the offsite dir shows what would have shipped.
cat > "$TMP/bin/age" <<'STUB'
#!/usr/bin/env bash
echo "age $*" >> "$CALLS"
out=""; in=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -r) shift 2 ;; *) in="$1"; shift ;; esac; done
cp "$in" "$out"
STUB
# the offsite command: copies into $OFFSITE (stands in for rclone/rsync)
printf '#!/usr/bin/env bash\ncp "$1" "$BK_OFFSITE/"\n' > "$TMP/bin/ship-stub"
chmod +x "$TMP/bin"/*

printf 'JWT_SECRET=hunter2\nDATABASE_URL=postgres://puca:pw@127.0.0.1/puca\n' > "$INSTALL/.env"
printf 'ciphertext-1\n' > "$INSTALL/uploads/a.enc"
printf 'ciphertext-2\n' > "$INSTALL/uploads/b.enc"

LOGF="$INSTALL/backup.log"
reset() {
	rm -rf "$INSTALL/backups" "$STATE" "$OFFSITE"; mkdir -p "$STATE" "$OFFSITE"
	rm -f "$LOGF"; : > "$CALLS"
}
run() { ( cd "$HERE" && CALLS="$CALLS" BK_STATE="$STATE" BK_OFFSITE="$OFFSITE" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" PATH="$TMP/bin:$PATH" "$@" bash ./backup.sh 2>&1 ); }
logtxt() { cat "$LOGF" 2>/dev/null; }
artifacts() { ls "$INSTALL/backups" 2>/dev/null; }

echo "--- a normal run produces THREE artifacts ---"
reset
out="$(run env)"
check "db dump"          "$([ -n "$(ls "$INSTALL"/backups/sandbox-db-*.sql.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"
check "uploads archive"  "$([ -n "$(ls "$INSTALL"/backups/sandbox-uploads-*.tar.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"
check "config archive"   "$([ -n "$(ls "$INSTALL"/backups/sandbox-config-*.tar.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"
cfg="$(ls "$INSTALL"/backups/sandbox-config-*.tar.gz 2>/dev/null | head -1)"
check "the config archive holds .env"                 "$([ -n "$cfg" ] && tar -tzf "$cfg" | grep -q '/\.env$' && echo 1 || echo 0)" "$(tar -tzf "$cfg" 2>/dev/null)"
check "stored relative to / (restorable with -C /)"   "$([ -n "$cfg" ] && ! tar -tzf "$cfg" | grep -q '^/' && echo 1 || echo 0)"
check "log says config ok"                            "$(has "$(logtxt)" 'config ok ->')" "$(logtxt)"
check "log carries the size/free-space trend line"    "$(has "$(logtxt)" 'backups dir')" "$(logtxt)"
if [ "$(uname -s)" = Linux ]; then
	check "config archive is mode 600 (umask 077, not chmod-ed after)" "$([ "$(stat -c %a "$cfg")" = 600 ] && echo 1 || echo 0)" "got $(stat -c %a "$cfg")"
else
	echo "SKIP  mode assertion (no POSIX modes here)"
fi

echo
echo "--- the config archive rides the same offsite gate as the dump ---"
reset
out="$(run env OFFSITE_CMD="$TMP/bin/ship-stub")"
check "with no recipient, ALL THREE are withheld"  "$([ "$(count "$(logtxt)" 'WITHHELD')" = 3 ] && echo 1 || echo 0)" "$(logtxt)"
check "and the config archive is one of them"       "$(has "$(logtxt)" 'sandbox-config-')"
check "and nothing reached the offsite target"      "$([ -z "$(ls -A "$OFFSITE")" ] && echo 1 || echo 0)" "$(ls "$OFFSITE")"

reset
out="$(run env OFFSITE_CMD="$TMP/bin/ship-stub" BACKUP_AGE_RECIPIENT=age1fake)"
check "with a recipient, three ENCRYPTED artifacts ship"   "$([ "$(ls "$OFFSITE"/*.age 2>/dev/null | wc -l)" = 3 ] && echo 1 || echo 0)" "$(ls "$OFFSITE")"
check "including the config archive"                       "$([ -n "$(ls "$OFFSITE"/sandbox-config-*.tar.gz.age 2>/dev/null)" ] && echo 1 || echo 0)" "$(ls "$OFFSITE")"
check "and no plaintext copy left offsite"                 "$([ -z "$(ls "$OFFSITE" | grep -v '\.age$')" ] && echo 1 || echo 0)" "$(ls "$OFFSITE")"
check "the transient .age copies are removed locally"      "$([ -z "$(ls "$INSTALL"/backups/*.age 2>/dev/null)" ] && echo 1 || echo 0)"

reset
out="$(run env OFFSITE_CMD="$TMP/bin/ship-stub" BACKUP_ALLOW_PLAINTEXT=1)"
check "BACKUP_ALLOW_PLAINTEXT=1 ships plaintext and says so for the config too" "$([ "$(count "$(logtxt)" 'is UNENCRYPTED')" = 3 ] && echo 1 || echo 0)" "$(logtxt)"

echo
echo "--- the uploads stage refuses to fill the disk ---"
reset; echo 100 > "$STATE/df-avail"
out="$(run env)"
check "no uploads archive when free space is short" "$([ -z "$(ls "$INSTALL"/backups/sandbox-uploads-*.tar.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"
check "and the log says why"                        "$(has "$(logtxt)" 'insufficient free space')" "$(logtxt)"
check "the db dump and config still happen"         "$([ -n "$(ls "$INSTALL"/backups/sandbox-db-*.sql.gz 2>/dev/null)" ] && [ -n "$(ls "$INSTALL"/backups/sandbox-config-*.tar.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"

# POSITIVE CONTROL: ample space -> the archive exists and is logged.
reset; echo 999999999999 > "$STATE/df-avail"
out="$(run env)"
check "ample space -> uploads archive written" "$([ -n "$(ls "$INSTALL"/backups/sandbox-uploads-*.tar.gz 2>/dev/null)" ] && echo 1 || echo 0)" "$(artifacts)"
check "and logged as ok"                       "$(has "$(logtxt)" 'uploads ok ->')" "$(logtxt)"

# The threshold is "tree size + reserve" (the tree here is a few dozen bytes):
# a reserve that would not be left over afterwards skips; a smaller one archives.
reset; echo 4000 > "$STATE/df-avail"
out="$(run env BACKUP_MIN_FREE_BYTES=4000)"
check "a tree that would eat into the reserve is skipped" "$(has "$(logtxt)" 'insufficient free space')" "$(logtxt)"
reset; echo 4000 > "$STATE/df-avail"
out="$(run env BACKUP_MIN_FREE_BYTES=100)"
check "and the same tree with a smaller reserve is archived" "$(has "$(logtxt)" 'uploads ok ->')" "$(logtxt)"

echo
echo "--- MAX_LOCAL_UPLOAD_ARCHIVES keeps the newest N ---"
seed_old() { # six fake uploads archives, 1..6 days old, all inside KEEP_DAYS
	mkdir -p "$INSTALL/backups"
	local i; for i in 1 2 3 4 5 6; do
		printf 'old\n' > "$INSTALL/backups/sandbox-uploads-2026010$i-030000.tar.gz"
		touch -d "@$(( $(date +%s) - i * 86400 ))" "$INSTALL/backups/sandbox-uploads-2026010$i-030000.tar.gz"
	done
}
reset; seed_old
out="$(run env KEEP_DAYS=30 MAX_LOCAL_UPLOAD_ARCHIVES=3)"
kept="$(ls "$INSTALL"/backups/sandbox-uploads-*.tar.gz | xargs -n1 basename | sort)"
check "exactly 3 survive"                     "$([ "$(printf '%s\n' "$kept" | wc -l)" = 3 ] && echo 1 || echo 0)" "$kept"
check "the survivors are the newest (tonight's + the two youngest fakes)" \
	"$([ "$(has "$kept" 'sandbox-uploads-20260101-030000')" = 1 ] && [ "$(has "$kept" 'sandbox-uploads-20260102-030000')" = 1 ] && [ "$(has "$kept" 'sandbox-uploads-20260103-030000')" = 0 ] && echo 1 || echo 0)" "$kept"
check "and the rotation is logged"            "$([ "$(count "$(logtxt)" 'rotated (count cap 3)')" = 4 ] && echo 1 || echo 0)" "$(logtxt)"

# CONTROL: unset (the default) keeps all six plus tonight's.
reset; seed_old
out="$(run env KEEP_DAYS=30)"
check "unset -> all 7 survive (today's behaviour is unchanged)" "$([ "$(ls "$INSTALL"/backups/sandbox-uploads-*.tar.gz | wc -l)" = 7 ] && echo 1 || echo 0)" "$(artifacts)"

echo
echo "--- nothing secret leaks into the log ---"
reset
out="$(run env)"
check "JWT_SECRET value never appears in backup.log or stdout" "$([ "$(has "$(logtxt)$out" 'hunter2')" = 0 ] && echo 1 || echo 0)"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all backup.sh checks passed"
