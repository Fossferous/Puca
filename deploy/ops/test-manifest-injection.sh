#!/usr/bin/env bash
# Proves the dual-ship updater-manifest fix on two axes:
#
#   1. INJECTION: release notes carrying a backtick or $( ) must NOT execute.
#      The old form re-parsed the heredoc body on the REMOTE shell as root.
#   2. PATH AGREEMENT: the file the interpreter writes must be the same file
#      the MSYS tools see. Production hands the path to `scp`, an MSYS binary,
#      while a native Windows python resolves "/tmp/x" to C:\tmp\x — a
#      different directory. So every assertion below reads the manifest by
#      piping it through `cat` (MSYS), never by handing python the path again:
#      that is precisely the contract scp depends on, and reading it any other
#      way would hide the divergence instead of catching it.
#
# A positive control runs the OLD form on the same input; if it does not
# execute the command, this harness proves nothing and says so.
set -u

SCRIPT="/c/Users/USER/Testing/puca-release/deploy/ops/dual-ship.sh"

# Extract the interpreter picker, the path translator and both builders from
# the REAL script (it exits early without hosts.conf, so it cannot be sourced
# wholesale). Do NOT end the range on /^}$/ — the embedded python's dict
# literal also closes with a brace at column 0, so a naive match stops
# mid-function and defines nothing, making every assertion pass vacuously.
A=$(grep -n '^PY=""' "$SCRIPT" | cut -d: -f1)
E=$(grep -n '^build_app_version_json()' "$SCRIPT" | cut -d: -f1)
E=$(awk -v s="$E" 'NR>s && $0=="}" && prev=="\x27" {print NR; exit} {prev=$0}' "$SCRIPT")
sed -n "${A},${E}p" "$SCRIPT" > /tmp/_fns.sh
# shellcheck disable=SC1091
. /tmp/_fns.sh
for fn in build_installer_manifest build_app_version_json to_native_path; do
    if ! declare -F "$fn" >/dev/null; then
        echo "HARNESS BROKEN: $fn undefined after extraction; refusing to report a vacuous pass" >&2
        exit 2
    fi
done

echo "interpreter: $PY ($("$PY" -c 'import sys;print(sys.version.split()[0])'))"
echo

rm -f /tmp/PWNED /tmp/PWNED2 /tmp/m1.json /tmp/m2.json /tmp/m4.json
fails=0
ATTACK='fixed `touch /tmp/PWNED` and $(touch /tmp/PWNED2) ordering'

# Read a manifest the way scp sees it: through an MSYS tool, by stdin.
# Compare inside python, not in the shell: $( ) eats trailing newlines and
# Windows text-mode adds \r, so a shell string-compare fails on a manifest
# that is perfectly correct. Expected value travels by environment.
read_notes() { cat "$1" | "$PY" -c 'import json,sys;print(json.load(sys.stdin)["notes"])'; }
notes_equal() {
    PUCA_EXPECT="$2" "$PY" -c '
import json, os, sys
got = json.load(sys.stdin)["notes"]
sys.exit(0 if got == os.environ["PUCA_EXPECT"] else 1)
' < "$1"
}

echo "### 1. INJECTION - notes carrying a backtick and \$( )"
build_installer_manifest /tmp/m1.json 0.9.9 "$ATTACK" 2026-01-01T00:00:00Z sig https://h/x.exe
if read_notes /tmp/m1.json >/dev/null 2>&1; then
    echo "  manifest readable by MSYS tools (so scp would ship it)"
    if notes_equal /tmp/m1.json "$ATTACK"; then
        echo "  notes round-tripped verbatim: $(read_notes /tmp/m1.json)"
    else
        echo "  FAIL: notes altered"; fails=$((fails+1))
    fi
else
    echo "  FAIL: manifest missing or unreadable where scp would look"; fails=$((fails+1))
fi
if [ -e /tmp/PWNED ] || [ -e /tmp/PWNED2 ]; then
    echo "  FAIL: THE COMMAND EXECUTED"; fails=$((fails+1))
else
    echo "  PASS: nothing executed"
fi
echo

echo "### 2. ESCAPING - quote, backslash and newline in notes"
printf -v MESSY 'he said "hi" \\ then\na newline'
build_installer_manifest /tmp/m2.json 0.9.9 "$MESSY" 2026-01-01T00:00:00Z sig https://h/x.exe
if notes_equal /tmp/m2.json "$MESSY"; then
    echo "  PASS: still valid JSON and round-trips exactly"
else
    echo "  FAIL: unparseable or altered (old form emitted invalid JSON here)"; fails=$((fails+1))
fi
echo

echo "### 3. app-version.json builder, same hostile input"
build_app_version_json /tmp/m4.json 0.9.9 "$ATTACK" https://example.invalid
if notes_equal /tmp/m4.json "$ATTACK"; then
    echo "  PASS: valid JSON, verbatim notes"
else
    echo "  FAIL: bad manifest"; fails=$((fails+1))
fi
if [ -e /tmp/PWNED ] || [ -e /tmp/PWNED2 ]; then
    echo "  FAIL: THE COMMAND EXECUTED"; fails=$((fails+1))
fi
echo

echo "### 4. POSITIVE CONTROL - the OLD heredoc form, identical input"
echo "     (if this stays silent, tests 1 and 3 prove nothing)"
notes="$ATTACK"
eval "cat > /tmp/m3.json <<JEOF
{ \"notes\": \"$notes\" }
JEOF" 2>/dev/null || true
if [ -e /tmp/PWNED ] || [ -e /tmp/PWNED2 ]; then
    echo "  CONTROL FIRES: the old form executed it -> the passes above are real"
else
    echo "  CONTROL SILENT: harness does not reproduce the old behaviour"; fails=$((fails+1))
fi

rm -f /tmp/PWNED /tmp/PWNED2 /tmp/m1.json /tmp/m2.json /tmp/m3.json /tmp/m4.json /tmp/_fns.sh
echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
exit "$fails"
