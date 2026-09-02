#!/usr/bin/env bash
# Tests for restore.sh's REFUSALS — the ones that must fire BEFORE the service
# is stopped and the database dropped. Offline: stub `psql`/`createdb`/`dropdb`/
# `systemctl`/`sudo`/`logger`/`age` on PATH, every one recording its argv, so
# "nothing destructive ran" is an assertion on the record and not an inference.
#
#   ./restore.test.sh          (bash on Linux/WSL; gzip + tar are real)
#
# WHY. The previous restore.sh ran `dropdb` and only then `createdb -O puca`,
# which needs a role neither self-hosting guide created. On a guide-built host
# the live database was dropped and THEN the script aborted — mid-disaster,
# with the service already stopped. Every refusal below has a positive control
# proving the same run proceeds to dropdb + createdb once the precondition
# holds; without those, an unconditional early exit would pass every case.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has() { printf '%s' "$1" | grep -qF -- "$2" && echo 1 || echo 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INSTALL="$TMP/install"; STATE="$TMP/state"; CALLS="$TMP/calls.log"
mkdir -p "$INSTALL/uploads" "$STATE" "$TMP/bin"

# --- stubs ---------------------------------------------------------------------
cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"
STUB
# psql answers from the sandbox state: $STATE/roles (one per line) and
# $STATE/dbowner (the live database's owner, empty = no live database).
# A restore pipe (no -c/-tAc) just drains stdin.
cat > "$TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
echo "psql $*" >> "$CALLS"
q=""
while [ $# -gt 0 ]; do case "$1" in -tAc|-c) q="$2"; shift 2 ;; *) shift ;; esac; done
if [ -z "$q" ]; then cat >/dev/null; exit 0; fi
case "$q" in
	*pg_roles*)
		r="${q#*rolname=\'}"; r="${r%%\'*}"
		grep -qx "$r" "$RS_STATE/roles" 2>/dev/null && echo 1 ;;
	*pg_get_userbyid*) cat "$RS_STATE/dbowner" 2>/dev/null ;;
	*pg_database*)     [ -s "$RS_STATE/dbowner" ] && echo 1 ;;
esac
exit 0
STUB
for tool in createdb dropdb systemctl logger; do
	printf '#!/usr/bin/env bash\necho "%s $*" >> "$CALLS"\nexit 0\n' "$tool" > "$TMP/bin/$tool"
done
# age "decrypts" by copying: the fixture behind a .age name is a real gzip.
cat > "$TMP/bin/age" <<'STUB'
#!/usr/bin/env bash
echo "age $*" >> "$CALLS"
out=""; in=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -d|-i) [ "$1" = -i ] && shift; shift ;; *) in="$1"; shift ;; esac; done
cp "$in" "$out"
STUB
chmod +x "$TMP/bin"/*

# --- fixtures ------------------------------------------------------------------
dump_with_owner() { # <role> -> $TMP/dump.sql.gz
	printf 'CREATE TABLE public.users (id int);\nALTER TABLE public.users OWNER TO %s;\nALTER TABLE public.servers OWNER TO %s;\n' "$1" "$1" | gzip > "$TMP/dump.sql.gz"
}
printf 'blob\n' > "$INSTALL/uploads/f1"
tar -czf "$TMP/uploads.tar.gz" -C "$INSTALL" uploads

reset() {
	rm -rf "$STATE"; mkdir -p "$STATE"; : > "$CALLS"
	: > "$STATE/dbowner"; : > "$STATE/roles"
	rm -f "$INSTALL/.env"
}
run() { # args...  (answers the confirmation prompt with yes)
	( cd "$HERE" && echo yes | CALLS="$CALLS" RS_STATE="$STATE" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" PATH="$TMP/bin:$PATH" bash ./restore.sh "$@" 2>&1 )
}
calls() { cat "$CALLS"; }

echo "--- the owner role must exist BEFORE anything is dropped ---"
reset; dump_with_owner sandbox
out="$(run "$TMP/dump.sql.gz")"; rc=$?
check "refuses when the role is missing"             "$([ $rc -ne 0 ] && echo 1 || echo 0)" "$out"
check "names the role and the fix"                   "$(has "$out" "role 'sandbox' does not exist")" "$out"
check "says nothing was touched"                     "$(has "$out" 'Nothing has been stopped or dropped')"
check "and indeed ran NO dropdb"                     "$([ "$(has "$(calls)" 'dropdb')" = 0 ] && echo 1 || echo 0)" "$(calls)"
check "and did NOT stop the service"                 "$([ "$(has "$(calls)" 'systemctl stop')" = 0 ] && echo 1 || echo 0)" "$(calls)"

# POSITIVE CONTROL: the same run with the role present goes all the way.
reset; dump_with_owner sandbox; echo sandbox > "$STATE/roles"
out="$(run "$TMP/dump.sql.gz" "$TMP/uploads.tar.gz")"; rc=$?
check "proceeds when the role exists"                "$([ $rc -eq 0 ] && echo 1 || echo 0)" "$out"
check "stops the service, drops, recreates as DB_USER" "$([ "$(has "$(calls)" 'systemctl stop sandbox')" = 1 ] && [ "$(has "$(calls)" 'dropdb --if-exists sandbox')" = 1 ] && [ "$(has "$(calls)" 'createdb -O sandbox sandbox')" = 1 ] && echo 1 || echo 0)" "$(calls)"
check "restores the uploads too"                     "$([ -f "$INSTALL/uploads/f1" ] && echo 1 || echo 0)"
check "and reports completion"                       "$(has "$out" 'restore complete')"

echo
echo "--- a superuser-owned live database keeps working (older guides built it that way) ---"
reset; dump_with_owner postgres; echo postgres > "$STATE/roles"; echo postgres > "$STATE/dbowner"
out="$(run "$TMP/dump.sql.gz")"; rc=$?
check "uses the LIVE database's owner, not DB_USER"  "$(has "$(calls)" 'createdb -O postgres sandbox')" "$(calls)"
check "and completes"                                "$([ $rc -eq 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- roles the DUMP names must exist too (ON_ERROR_STOP would abort after the drop) ---"
reset; dump_with_owner someone_else; echo sandbox > "$STATE/roles"
out="$(run "$TMP/dump.sql.gz")"; rc=$?
check "refuses when the dump assigns ownership to a missing role" "$([ $rc -ne 0 ] && [ "$(has "$out" 'someone_else')" = 1 ] && echo 1 || echo 0)" "$out"
check "before dropping anything"                                   "$([ "$(has "$(calls)" 'dropdb')" = 0 ] && echo 1 || echo 0)" "$(calls)"

echo
echo "--- an encrypted offsite artifact needs the identity, checked FIRST ---"
reset; dump_with_owner sandbox; echo sandbox > "$STATE/roles"; cp "$TMP/dump.sql.gz" "$TMP/dump.sql.gz.age"
out="$(run "$TMP/dump.sql.gz.age")"; rc=$?
check "refuses an .age artifact with no identity"    "$([ $rc -ne 0 ] && [ "$(has "$out" 'BACKUP_AGE_IDENTITY')" = 1 ] && echo 1 || echo 0)" "$out"
check "without touching the database"                "$([ "$(has "$(calls)" 'dropdb')" = 0 ] && [ "$(has "$(calls)" 'systemctl stop')" = 0 ] && echo 1 || echo 0)" "$(calls)"

printf 'AGE-SECRET-KEY-1FAKE\n' > "$TMP/identity"
out="$(BACKUP_AGE_IDENTITY="$TMP/identity" run "$TMP/dump.sql.gz.age")"; rc=$?
check "POSITIVE CONTROL: decrypts and restores with the identity" "$([ $rc -eq 0 ] && [ "$(has "$(calls)" 'createdb -O sandbox sandbox')" = 1 ] && echo 1 || echo 0)" "$out"
check "via age -d with that identity"                             "$(has "$(calls)" "age -d -i $TMP/identity")" "$(calls)"

echo
echo "--- the closing hint follows the deployment's listener ---"
reset; dump_with_owner sandbox; echo sandbox > "$STATE/roles"; printf 'PORT=8080\n' > "$INSTALL/.env"
out="$(run "$TMP/dump.sql.gz")"
check "names http://127.0.0.1:8080/ rather than :3000" "$(has "$out" 'http://127.0.0.1:8080/')" "$out"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all restore.sh checks passed"
