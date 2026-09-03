#!/usr/bin/env bash
# Tests for the parts of provision.sh that can be exercised without a VPS.
#
# provision.sh runs once, as root, on a box that has already been paid for, and
# the two things checked here fail SILENTLY: a config written world-readable for
# a moment is indistinguishable afterwards from one that never was, and a secret
# passed in argv leaves no trace in the script's own output.
#
#   ./provision.test.sh
#
# Companion to render-turn-conf.test.sh, same reasoning and same shape. Needs a
# POSIX filesystem for the mode assertions — under Git Bash on Windows those
# SKIP rather than pass vacuously, so run it on Linux (or WSL) to get them.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/provision.sh"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "--- write_file gives the file its mode BEFORE the bytes land ---"

# Extract write_file from the real file rather than running provision.sh, which
# refuses to run anywhere but a fresh root box (by design). sed on the real
# script, so this cannot pass against a stale copy.
{
	echo 'DRY_RUN=0'
	echo 'STAMP=test'
	sed -n '/^write_file() {/,/^}/p' "$SCRIPT"
} > "$TMP/wf.sh"
check "write_file was extracted from provision.sh" \
	"$(grep -c 'write_file() {' "$TMP/wf.sh" | grep -qx 1 && echo 1 || echo 0)" \
	"the sed extraction no longer matches — this file would be testing nothing"

if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then
	# umask 000 is the adversarial case throughout: if write_file relied on the
	# ambient umask rather than creating the file with an explicit mode, the
	# secret files below would come out 666.
	out="$(cd "$TMP" && umask 000 && . ./wf.sh && printf 'JWT_SECRET=hunter2\n' | write_file "$TMP/dotenv" 600 && stat -c %a "$TMP/dotenv")"
	check "a 600 file really is 600 under umask 000" "$([ "$out" = 600 ] && echo 1 || echo 0)" "got ${out:-<none>}"
	check "and it has the content"                   "$(grep -q 'JWT_SECRET=hunter2' "$TMP/dotenv" && echo 1 || echo 0)"

	# 640 is the coturn case and must still be honoured: a 600 root-owned
	# turnserver.conf is unreadable to coturn's own user, which coturn treats
	# as "no config" — i.e. an OPEN RELAY. This is the assertion a blanket
	# `umask 077` would have broken, which is why provision.sh does not set one.
	out="$(cd "$TMP" && umask 000 && . ./wf.sh && printf 'listening-ip=127.0.0.1\n' | write_file "$TMP/turn.conf" 640 && stat -c %a "$TMP/turn.conf")"
	check "a 640 file really is 640 (coturn must be able to read it)" "$([ "$out" = 640 ] && echo 1 || echo 0)" "got ${out:-<none>}"

	# Re-running provision is supported, and it must still back up first.
	out="$(cd "$TMP" && . ./wf.sh && printf 'second\n' | write_file "$TMP/dotenv" 600 && ls "$TMP" | grep -c 'dotenv.bak-')"
	check "an existing file is backed up before replacement" "$([ "${out:-0}" -ge 1 ] && echo 1 || echo 0)"

	# THE ACTUAL FINDING, and the only assertion here that a write-then-chmod
	# does not also satisfy. Afterwards the two orders are indistinguishable —
	# which is precisely why this went unnoticed — so feed the content slowly
	# and look at the mode WHILE the secret is being written.
	(
		cd "$TMP" && umask 000 && . ./wf.sh
		{ printf 'JWT_SECRET=hunter2\n'; sleep 2; } | write_file "$TMP/slow" 600
	) &
	writer=$!
	sleep 1
	mid="$(stat -c %a "$TMP/slow" 2>/dev/null || echo none)"
	wait "$writer" 2>/dev/null
	check "the file is never world-readable mid-write" "$([ "$mid" = 600 ] && echo 1 || echo 0)" \
		"mode was $mid while the secret was being written — write-then-chmod leaves exactly this window"
else
	echo "SKIP  file-mode assertions (no POSIX modes here: $(uname -s))"
fi

echo
echo "--- no secret is passed on a command line ---"
# /proc/<pid>/cmdline is readable by any local process for the life of the
# command, and execve auditing records it verbatim. The one place this cannot
# be avoided (turnadmin has no stdin interface) must SAY so, so that an
# undocumented one is what fails.
offenders="$(grep -nE '(psql|createuser|createdb)[^|]*-c[^|]*\$\{?DB_PASS' "$SCRIPT" || true)"
check "no psql -c carries an interpolated password" \
	"$([ -z "$offenders" ] && echo 1 || echo 0)" "$offenders"

check "the role is created with the statement on stdin" \
	"$(grep -q 'psql -q -f -' "$SCRIPT" && echo 1 || echo 0)"

# turnadmin -s is unavoidable; what is NOT acceptable is it being silent.
if grep -q 'turnadmin -s' "$SCRIPT"; then
	check "the turnadmin argv exposure is documented where it happens" \
		"$(grep -B14 'turnadmin -s' "$SCRIPT" | grep -qi 'cmdline' && echo 1 || echo 0)" \
		"add a comment above it saying why it cannot be avoided"
else
	echo "SKIP  turnadmin call is gone; nothing to document"
fi

echo
echo "--- the box it builds is one the rest of deploy/ can use ---"
# provision.sh cannot run here (root + a fresh box, by design), so these pin
# the script text for the three gaps that each took a real ship to notice:
# the download/webapp directories Caddy serves and dual-ship.sh writes into,
# LiveKit actually being enabled (and only after daemon-reload knows the
# unit), and the pool size no longer pinned to a third value.
mk="$(grep -E '^run mkdir -p ' "$SCRIPT" | grep -F '/opt/puca/uploads' || true)"
check "creates downloads/mobile beside uploads" "$(printf '%s' "$mk" | grep -qF '/opt/puca/downloads/mobile' && echo 1 || echo 0)" "$mk"
check "creates webapp/ too"                     "$(printf '%s' "$mk" | grep -qF '/opt/puca/webapp' && echo 1 || echo 0)" "$mk"
reload_line="$(grep -n '^run systemctl daemon-reload' "$SCRIPT" | head -1 | cut -d: -f1)"
enable_line="$(grep -n '^run systemctl enable --now livekit' "$SCRIPT" | head -1 | cut -d: -f1)"
check "enables livekit"                          "$([ -n "$enable_line" ] && echo 1 || echo 0)"
check "AFTER daemon-reload (systemd must know the unit first)" "$([ -n "$enable_line" ] && [ -n "$reload_line" ] && [ "$enable_line" -gt "$reload_line" ] && echo 1 || echo 0)" "reload at ${reload_line:-?}, enable at ${enable_line:-?}"
check "and probes 127.0.0.1:7880 before finishing" "$(grep -q 'curl -sf --max-time 2 http://127.0.0.1:7880/' "$SCRIPT" && echo 1 || echo 0)"
check "does not pin DATABASE_MAX_CONNECTIONS (the code default is the one truth)" "$(grep -q 'echo "DATABASE_MAX_CONNECTIONS=' "$SCRIPT" && echo 0 || echo 1)"
check "writes a memory drop-in sized from MemTotal" "$(grep -q 'puca.service.d/limits.conf' "$SCRIPT" && grep -q 'MemTotal' "$SCRIPT" && echo 1 || echo 0)"

echo
echo "--- argument handling ---"
# A real run is impossible off a fresh root box (the guard is deliberate), so
# this proves the refusal, which is what it can honestly prove.
out="$(bash "$SCRIPT" --dry-run 2>&1)"; rc=$?
check "refuses without --public-ip" "$([ $rc -ne 0 ] && echo 1 || echo 0)" "$out"

# --realm becomes the coturn realm, APP_URL, CORS_ORIGINS and the TURN URLs.
# It used to default to example.com, so a host could provision cleanly, boot,
# pass its health check and be unreachable from every client with nothing in
# any log to say why. Both refusals below are that failure, made loud.
out="$(bash "$SCRIPT" --public-ip 203.0.113.10 --dry-run 2>&1)"; rc=$?
check "refuses without --realm"                  "$([ $rc -ne 0 ] && echo 1 || echo 0)" "$out"
check "and says what --realm is for"             "$(printf '%s' "$out" | grep -qF 'it is your domain' && echo 1 || echo 0)" "$out"

for bad in example.com chat.example.com localhost; do
	out="$(bash "$SCRIPT" --public-ip 203.0.113.10 --realm "$bad" --dry-run 2>&1)"; rc=$?
	check "refuses the placeholder realm '$bad'"  "$([ $rc -ne 0 ] && echo 1 || echo 0)" "$out"
done
out="$(bash "$SCRIPT" --public-ip 203.0.113.10 --realm example.com --dry-run 2>&1)"
check "explains what a placeholder realm would break" "$(printf '%s' "$out" | grep -qF 'unreachable from every client' && echo 1 || echo 0)" "$out"

# POSITIVE CONTROL: a real domain gets PAST argument handling. It still stops
# at the fresh-box guard or the first privileged step — this asserts only that
# the refusals above are about the realm, not about everything.
out="$(bash "$SCRIPT" --public-ip 203.0.113.10 --realm chat.somebodys-real-domain.net --dry-run 2>&1)"
check "a real domain is not refused as a placeholder" "$(printf '%s' "$out" | grep -qF 'is a placeholder' && echo 0 || echo 1)" "$out"
check "and it is not refused for a missing realm"     "$(printf '%s' "$out" | grep -qF -- '--realm is required' && echo 0 || echo 1)" "$out"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all provision.sh checks passed"
