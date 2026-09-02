#!/usr/bin/env bash
# Tests for restore-drill.sh's OFFSITE path, offline: a stub `rclone` serving a
# fixture "remote", a stub `age` that decrypts by copying, and stub
# `psql`/`createdb`/`dropdb`/`sudo`/`systemctl`/`logger` recording their argv.
#
#   ./restore-drill.test.sh    (bash on Linux/WSL; gzip + tar are real)
#
# WHY. backup.sh ships ONLY encrypted artifacts offsite (`.age`/`.gpg`), and the
# drill's rclone filter never matched that suffix — so the copy that exists
# for a disk loss was the one copy the drill could not find, and every night's
# "no db backup found on offsite remote" read as a missing backup rather than
# a blind drill. The cases below pin: the artifact is located; an encrypted
# artifact with no identity is a loud, specific FAIL; with the identity the
# drill reaches a scratch restore and PASSES (the positive control, without
# which a fix that only changed one error string into another would pass);
# unrelated names still produce "not found"; and the scratch database is
# created with the same `createdb -O` restore.sh uses.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has() { printf '%s' "$1" | grep -qF -- "$2" && echo 1 || echo 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INSTALL="$TMP/install"; REMOTE="$TMP/remote"; CALLS="$TMP/calls.log"
mkdir -p "$INSTALL/backups" "$REMOTE" "$TMP/bin"

# --- stubs ---------------------------------------------------------------------
cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"
STUB
# rclone: `lsf <remote> --include <pattern>` lists the fixture dir through the
# pattern (brace alternation expanded the way rclone does it); `copy` copies.
cat > "$TMP/bin/rclone" <<'STUB'
#!/usr/bin/env bash
echo "rclone $*" >> "$CALLS"
cmd=""; pat=""; args=()
while [ $# -gt 0 ]; do case "$1" in --config) shift 2 ;; --include) pat="$2"; shift 2 ;; lsf|copy) cmd="$1"; shift ;; *) args+=("$1"); shift ;; esac; done
case "$cmd" in
	lsf)
		# expand a single {a,b,c} group, then glob-match each name
		alts="${pat#*\{}"; alts="${alts%%\}*}"; pre="${pat%%\{*}"; post="${pat#*\}}"
		if [ "$alts" = "$pat" ]; then pats=("$pat"); else IFS=',' read -r -a A <<< "$alts"; pats=(); for a in "${A[@]}"; do pats+=("$pre$a$post"); done; fi
		for f in "$RD_REMOTE"/*; do
			n="$(basename "$f")"
			for p in "${pats[@]}"; do
				# shellcheck disable=SC2254
				case "$n" in $p) echo "$n"; break ;; esac
			done
		done ;;
	copy) src="${args[0]}"; cp "$RD_REMOTE/$(basename "$src")" "${args[1]}/" ;;
esac
STUB
cat > "$TMP/bin/age" <<'STUB'
#!/usr/bin/env bash
echo "age $*" >> "$CALLS"
out=""; in=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -d|-i) [ "$1" = -i ] && shift; shift ;; *) in="$1"; shift ;; esac; done
cp "$in" "$out"
STUB
# psql answers the drill's sanity queries with a populated, bootable schema.
cat > "$TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
echo "psql $*" >> "$CALLS"
q=""
while [ $# -gt 0 ]; do case "$1" in -tAc|-c) q="$2"; shift 2 ;; *) shift ;; esac; done
if [ -z "$q" ]; then cat >/dev/null; exit 0; fi
case "$q" in
	*information_schema.tables*) echo 25 ;;
	*_sqlx_migrations*)          echo 58 ;;
	*LOWER\(username\)*)         echo 0 ;;
	*"FROM users"*)              echo 3 ;;
	*"FROM servers"*)            echo 2 ;;
	*"FROM channels"*)           echo 4 ;;
	*"FROM messages"*)           echo 10 ;;
	*pg_database*)               echo 1 ;;
	*) echo 0 ;;
esac
STUB
for tool in createdb dropdb systemctl logger; do
	printf '#!/usr/bin/env bash\necho "%s $*" >> "$CALLS"\nexit 0\n' "$tool" > "$TMP/bin/$tool"
done
chmod +x "$TMP/bin"/*

# --- fixtures ------------------------------------------------------------------
printf 'CREATE TABLE public.users (id int);\n' | gzip > "$TMP/dump.sql.gz"
mkdir -p "$TMP/up/uploads"; printf 'blob\n' > "$TMP/up/uploads/f1"
tar -czf "$TMP/uploads.tar.gz" -C "$TMP/up" uploads
printf 'AGE-SECRET-KEY-1FAKE\n' > "$TMP/identity"

remote_has() { rm -f "$REMOTE"/*; for n in "$@"; do case "$n" in *-db-*) cp "$TMP/dump.sql.gz" "$REMOTE/$n" ;; *) cp "$TMP/uploads.tar.gz" "$REMOTE/$n" ;; esac; done; }
run() { ( cd "$HERE" && CALLS="$CALLS" RD_REMOTE="$REMOTE" RCLONE_REMOTE="fake:puca" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" PATH="$TMP/bin:$PATH" "$@" bash ./restore-drill.sh 2>&1 ); }
calls() { cat "$CALLS"; }

echo "--- an encrypted offsite artifact is LOCATED, and its unreadability is reported as such ---"
: > "$CALLS"; remote_has sandbox-db-20260101-030000.sql.gz.age sandbox-uploads-20260101-030000.tar.gz.age
out="$(run env)"; rc=$?
check "finds the .age artifact"                              "$(has "$out" 'db backup located: sandbox-db-20260101-030000.sql.gz.age')" "$out"
check "FAILS with the explicit 'encrypted but no identity' reason" "$([ $rc -ne 0 ] && [ "$(has "$out" 'encrypted but cannot be opened here')" = 1 ] && [ "$(has "$out" 'BACKUP_AGE_IDENTITY')" = 1 ] && echo 1 || echo 0)" "$out"
check "and does NOT say 'no db backup found'"                "$([ "$(has "$out" 'no db backup found')" = 0 ] && echo 1 || echo 0)"
check "and says where to run the offsite drill instead"      "$(has "$out" 'where the identity lives')"

echo
echo "--- POSITIVE CONTROL: with the identity, the drill restores and PASSES ---"
: > "$CALLS"
out="$(run env BACKUP_AGE_IDENTITY="$TMP/identity")"; rc=$?
check "exit 0"                                       "$([ $rc -eq 0 ] && echo 1 || echo 0)" "$out"
check "decrypted the db artifact"                    "$(has "$out" 'db artifact decrypted')"
check "reached the scratch restore"                  "$(has "$out" 'restored into scratch db sandbox_drill_')" "$out"
check "verified the uploads archive too"             "$(has "$out" 'uploads extracted (1 file(s))')" "$out"
check "printed PASSED"                               "$(has "$out" 'RESTORE DRILL PASSED')"
check "created the scratch db with the SAME -O restore.sh uses" "$(has "$(calls)" 'createdb -O sandbox sandbox_drill_')" "$(calls)"
check "and dropped it afterwards"                    "$(has "$(calls)" 'dropdb --if-exists sandbox_drill_')"

echo
echo "--- the filter is selective: unrelated names are still 'not found' ---"
: > "$CALLS"; remote_has other-db-20260101.sql.gz.age notes.txt
out="$(run env BACKUP_AGE_IDENTITY="$TMP/identity")"; rc=$?
check "reports no db backup on a remote with only unrelated files" "$([ $rc -ne 0 ] && [ "$(has "$out" 'no db backup found on offsite remote')" = 1 ] && echo 1 || echo 0)" "$out"

echo
echo "--- plaintext offsite names still work (a BACKUP_ALLOW_PLAINTEXT=1 deployment) ---"
: > "$CALLS"; remote_has sandbox-db-20260101-030000.sql.gz
out="$(run env)"; rc=$?
check "locates and restores a plain .sql.gz without any identity" "$([ $rc -eq 0 ] && [ "$(has "$out" 'restored into scratch db')" = 1 ] && echo 1 || echo 0)" "$out"

echo
echo "--- --local: the newest local pair, same createdb -O ---"
: > "$CALLS"; cp "$TMP/dump.sql.gz" "$INSTALL/backups/sandbox-db-20260101-030000.sql.gz"; cp "$TMP/uploads.tar.gz" "$INSTALL/backups/sandbox-uploads-20260101-030000.tar.gz"
out="$( cd "$HERE" && CALLS="$CALLS" RD_REMOTE="$REMOTE" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" PATH="$TMP/bin:$PATH" bash ./restore-drill.sh --local 2>&1 )"; rc=$?
check "passes on a local plaintext pair"           "$([ $rc -eq 0 ] && [ "$(has "$out" 'RESTORE DRILL PASSED')" = 1 ] && echo 1 || echo 0)" "$out"
check "with createdb -O DB_USER"                    "$(has "$(calls)" 'createdb -O sandbox sandbox_drill_')" "$(calls)"

# A host where the role is missing: createdb -O fails, and the drill must say
# so in terms of what restore.sh would have done.
: > "$CALLS"; printf '#!/usr/bin/env bash\necho "createdb $*" >> "$CALLS"\necho "createdb: error: role \\"sandbox\\" does not exist" >&2\nexit 1\n' > "$TMP/bin/createdb"
out="$( cd "$HERE" && CALLS="$CALLS" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" PATH="$TMP/bin:$PATH" bash ./restore-drill.sh --local 2>&1 )"; rc=$?
check "a missing owner role FAILS the drill"        "$([ $rc -ne 0 ] && [ "$(has "$out" "could not create scratch db as owner 'sandbox'")" = 1 ] && echo 1 || echo 0)" "$out"
check "and explains restore.sh would fail after the drop" "$(has "$out" 'AFTER dropping the live database')"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all restore-drill.sh checks passed"
