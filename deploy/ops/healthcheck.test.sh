#!/usr/bin/env bash
# Tests for healthcheck.sh, entirely offline: a sandbox install dir and stub
# `systemctl`/`curl`/`ufw`/`sudo`/`pg_isready`/`logger` on PATH, each recording
# its argv so "it did NOT restart" and "it did NOT enable ufw" are checkable
# rather than assumed. Runs under bash on Linux/WSL (it opens a real TCP
# listener for one positive control; python3 is used for that).
#
#   ./healthcheck.test.sh
#
# WHY. Every branch in healthcheck.sh acts on production with root: a wrong
# restart drops every WebSocket and call on the box, and `ufw --force enable`
# on a host with no rules takes it off the network. Each refusal here has a
# matching positive control proving the action DOES happen when it should —
# a check that never fires is indistinguishable from no check.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has() { printf '%s' "$1" | grep -qF -- "$2" && echo 1 || echo 0; }
count() { printf '%s' "$1" | grep -cF -- "$2"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${LISTENER:-}" ] && kill "$LISTENER" 2>/dev/null' EXIT
INSTALL="$TMP/install"; STATE="$TMP/state"; CALLS="$TMP/calls.log"
mkdir -p "$INSTALL" "$STATE" "$TMP/bin"

# --- stubs ---------------------------------------------------------------------
# systemctl: behaviour is driven by marker files under $STATE so each case sets
# up exactly the world it needs.
#   active.<unit>     -> is-active succeeds
#   enabled.<unit>    -> is-enabled succeeds (and `cat` finds the unit)
#   nrestarts.<unit>  -> what `show -p NRestarts --value` prints
cat > "$TMP/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
cmd="$1"; shift
case "$cmd" in
	is-active)  u="${*: -1}"; [ -f "$HC_STATE/active.$u" ] ;;
	is-enabled) u="${*: -1}"; [ -f "$HC_STATE/enabled.$u" ] ;;
	cat)        u="$1"; [ "$u" = sandbox ] || [ -f "$HC_STATE/enabled.$u" ] ;;
	show)       u="$1"; cat "$HC_STATE/nrestarts.$u" 2>/dev/null || echo 0 ;;
	*) exit 0 ;;
esac
STUB
# curl: succeeds for the URL named in $STATE/curl-ok ("any" = every URL,
# empty/missing = none). The URL is curl's last argument in every call the
# script makes.
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$CALLS"
url="${*: -1}"
ok="$(cat "$HC_STATE/curl-ok" 2>/dev/null || true)"
case "$ok" in "") exit 22 ;; any) exit 0 ;; *) [ "$url" = "$ok" ] ;; esac
STUB
cat > "$TMP/bin/ufw" <<'STUB'
#!/usr/bin/env bash
echo "ufw $*" >> "$CALLS"
case "$*" in
	status*)      cat "$HC_STATE/ufw-status" 2>/dev/null || echo "Status: inactive" ;;
	"show added") cat "$HC_STATE/ufw-added" 2>/dev/null ;;
esac
exit 0
STUB
cat > "$TMP/bin/sudo" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/pg_isready"
printf '#!/usr/bin/env bash\necho "logger $*" >> "$CALLS"\n' > "$TMP/bin/logger"
chmod +x "$TMP/bin"/*

LOGF="$INSTALL/health.log"
reset() {   # a healthy, already-monitored host, with ufw active so it stays out of the way
	rm -rf "$STATE"; mkdir -p "$STATE"
	rm -f "$CALLS" "$LOGF" "$INSTALL"/.[a-z]* "$INSTALL/.env" "$TMP/Caddyfile"
	: > "$CALLS"
	touch "$STATE/active.sandbox"
	echo any > "$STATE/curl-ok"
	echo "Status: active" > "$STATE/ufw-status"
	touch "$INSTALL/.health-http-ok"
}
# CADDYFILE is pinned into the sandbox so the real /etc/caddy/Caddyfile on the
# machine running this can never leak into a case (absent = no Caddy here).
run() { ( cd "$HERE" && CALLS="$CALLS" HC_STATE="$STATE" SERVICE_NAME=sandbox INSTALL_DIR="$INSTALL" CADDYFILE="$TMP/Caddyfile" PATH="$TMP/bin:$PATH" "$@" bash ./healthcheck.sh 2>&1 ); }
logtxt() { cat "$LOGF" 2>/dev/null; }
calls() { cat "$CALLS"; }

echo "--- ufw: never enable a firewall nobody configured ---"
reset; echo "Status: inactive" > "$STATE/ufw-status"; : > "$STATE/ufw-added"
run env
check "does NOT run 'ufw --force enable' when there are no rules" "$([ "$(has "$(calls)" '--force enable')" = 0 ] && echo 1 || echo 0)" "$(calls)"
check "and says why in health.log"                                  "$(has "$(logtxt)" 'never configured for this deployment')" "$(logtxt)"

# THE POSITIVE CONTROL: a host provision.sh built has an SSH allow and keeps the re-assert.
reset; echo "Status: inactive" > "$STATE/ufw-status"
printf 'Added user rules (see ufw status for running firewall):\nufw allow 22/tcp\nufw allow 443/tcp\n' > "$STATE/ufw-added"
run env
check "DOES re-enable when an SSH allow rule exists" "$(has "$(calls)" 'ufw --force enable')" "$(calls)"
check "and logs the re-assert"                       "$(has "$(logtxt)" 'ufw INACTIVE -> re-enabling')"

reset; echo "Status: inactive" > "$STATE/ufw-status"; printf 'ufw allow OpenSSH\n' > "$STATE/ufw-added"
run env
check "an 'OpenSSH' app-profile allow counts as evidence" "$(has "$(calls)" 'ufw --force enable')" "$(calls)"

reset; echo "Status: inactive" > "$STATE/ufw-status"; : > "$STATE/ufw-added"
run env OPS_MANAGE_UFW=1
check "OPS_MANAGE_UFW=1 forces the re-assert with no rules" "$(has "$(calls)" 'ufw --force enable')" "$(calls)"

reset; echo "Status: inactive" > "$STATE/ufw-status"; printf 'ufw allow 22/tcp\n' > "$STATE/ufw-added"
run env OPS_MANAGE_UFW=0
check "OPS_MANAGE_UFW=0 leaves ufw alone even with rules" "$([ "$(has "$(calls)" '--force enable')" = 0 ] && echo 1 || echo 0)" "$(calls)"
check "and does not nag about it"                           "$([ "$(has "$(logtxt)" 'ufw')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"

reset
run env
check "an active ufw is not touched" "$([ "$(has "$(calls)" '--force enable')" = 0 ] && echo 1 || echo 0)"

echo
echo "--- the HTTP probe follows PORT/BIND_ADDR instead of assuming :3000 ---"
reset; printf 'JWT_SECRET=hunter2\nPORT=8080\n' > "$INSTALL/.env"; echo "http://127.0.0.1:8080/" > "$STATE/curl-ok"
run env
check "probes the port from .env"                 "$(has "$(calls)" 'http://127.0.0.1:8080/')" "$(calls)"
check "and does NOT restart a healthy service"    "$([ "$(has "$(calls)" 'systemctl restart sandbox')" = 0 ] && echo 1 || echo 0)" "$(calls)"
check "and never wrote the secret anywhere"       "$([ "$(has "$(calls)$(logtxt)" 'hunter2')" = 0 ] && echo 1 || echo 0)"

# POSITIVE CONTROL: the probe really fails -> exactly one restart.
reset; : > "$STATE/curl-ok"
run env
check "a failing probe on a known-good listener restarts exactly once" "$([ "$(count "$(calls)" 'systemctl restart sandbox')" = 1 ] && echo 1 || echo 0)" "$(calls)"
check "and logs it"                                                     "$(has "$(logtxt)" 'HTTP check failed (service up) -> restart')"

reset; : > "$STATE/curl-ok"; rm -f "$INSTALL/.health-http-ok"
run env
check "a probe that has NEVER succeeded is reported as config, not restarted" "$([ "$(has "$(calls)" 'systemctl restart sandbox')" = 0 ] && echo 1 || echo 0)" "$(calls)"
check "and the log names the URL and the knobs"                              "$(has "$(logtxt)" 'has NEVER succeeded')" "$(logtxt)"
check "with no marker left behind"                                           "$([ ! -f "$INSTALL/.health-http-ok" ] && echo 1 || echo 0)"

reset; rm -f "$INSTALL/.health-http-ok"
run env
check "the first success writes the marker" "$([ -f "$INSTALL/.health-http-ok" ] && echo 1 || echo 0)"

reset
run env
check "no .env -> the 3000 default (hosts predating this behave identically)" "$(has "$(calls)" 'http://127.0.0.1:3000/')" "$(calls)"

reset; printf 'BIND_ADDR=10.0.0.5\n' > "$INSTALL/.env"
run env
check "a specific BIND_ADDR is probed there, not on loopback" "$(has "$(calls)" 'http://10.0.0.5:3000/')" "$(calls)"

reset; printf 'BIND_ADDR=0.0.0.0\nPORT=9000\n' > "$INSTALL/.env"
run env
check "0.0.0.0 still probes loopback" "$(has "$(calls)" 'http://127.0.0.1:9000/')" "$(calls)"

reset; printf 'PORT=8080\n' > "$INSTALL/.env"
run env HEALTH_URL=http://127.0.0.1:1234/health
check "HEALTH_URL from the environment/etc-default wins outright" "$(has "$(calls)" 'http://127.0.0.1:1234/health')" "$(calls)"

echo
echo "--- crash-loop detection covers the BACKEND, not only the waker ---"
reset; echo 0 > "$STATE/nrestarts.sandbox"
run env
echo 3 > "$STATE/nrestarts.sandbox"
run env
check "NRestarts climbing on the backend is logged LOUDLY" "$(has "$(logtxt)" 'sandbox RESTARTED BY SYSTEMD (NRestarts 0 -> 3)')" "$(logtxt)"
check "naming the diagnostic"                              "$(has "$(logtxt)" 'journalctl -u sandbox | grep -E')"
# POSITIVE CONTROL: unchanged counter -> silence, or this is a constant alarm.
run env
check "an unchanged counter writes nothing more" "$([ "$(count "$(logtxt)" 'RESTARTED BY SYSTEMD')" = 1 ] && echo 1 || echo 0)" "$(logtxt)"
check "it does not restart over a counter"        "$([ "$(has "$(calls)" 'systemctl restart sandbox')" = 0 ] && echo 1 || echo 0)"

reset; touch "$STATE/enabled.sandbox-waker" "$STATE/active.sandbox-waker"; echo 5 > "$STATE/nrestarts.sandbox-waker"
run env
check "the waker path still fires (the refactor did not regress it)" "$(has "$(logtxt)" 'sandbox-waker RESTARTED BY SYSTEMD (NRestarts 0 -> 5)')" "$(logtxt)"
check "and keeps its historical state file name"                    "$([ "$(cat "$INSTALL/.waker-nrestarts.last" 2>/dev/null)" = 5 ] && echo 1 || echo 0)"

reset; touch "$STATE/enabled.sandbox-waker"
run env
check "an inactive waker is restarted" "$(has "$(calls)" 'systemctl restart sandbox-waker')" "$(calls)"

echo
echo "--- coturn / livekit: gated on is-enabled, restarted when down, probed when up ---"
# THE CONTROL THAT MATTERS MOST: a mesh-only host with no SFU tier stays green.
reset
run env
check "no livekit unit -> no livekit lines, no restart" "$([ "$(has "$(logtxt)$(calls)" 'restart livekit')" = 0 ] && [ "$(has "$(logtxt)" 'livekit')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"
check "no coturn unit -> no coturn lines, no restart"   "$([ "$(has "$(logtxt)$(calls)" 'restart coturn')" = 0 ] && [ "$(has "$(logtxt)" 'coturn')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"

reset; touch "$STATE/enabled.livekit"
run env
check "an enabled but inactive livekit is restarted" "$(has "$(calls)" 'systemctl restart livekit')" "$(calls)"
check "and logged"                                    "$(has "$(logtxt)" 'livekit inactive -> restart')"

reset; touch "$STATE/enabled.livekit" "$STATE/active.livekit"; echo "http://127.0.0.1:3000/" > "$STATE/curl-ok"
run env
check "active livekit whose endpoint does not answer gets a DISTINCT line" "$(has "$(logtxt)" 'livekit unit is active but http://127.0.0.1:7880/ does not answer')" "$(logtxt)"
check "and is not restarted over it"                                      "$([ "$(has "$(calls)" 'systemctl restart livekit')" = 0 ] && echo 1 || echo 0)"

reset; touch "$STATE/enabled.livekit" "$STATE/active.livekit"
run env
check "active livekit that answers is silent" "$([ "$(has "$(logtxt)" 'livekit')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"

reset; touch "$STATE/enabled.coturn" "$STATE/active.coturn"
run env COTURN_PROBE_PORT=34799
check "active coturn with nothing listening gets a DISTINCT line" "$(has "$(logtxt)" 'coturn unit is active but nothing listens on 127.0.0.1:34799')" "$(logtxt)"

if command -v python3 >/dev/null 2>&1; then
	python3 -m http.server 34799 --bind 127.0.0.1 >/dev/null 2>&1 &
	LISTENER=$!
	for _ in 1 2 3 4 5 6 7 8 9 10; do timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/34799' 2>/dev/null && break; sleep 0.3; done
	reset; touch "$STATE/enabled.coturn" "$STATE/active.coturn"
	run env COTURN_PROBE_PORT=34799
	check "POSITIVE CONTROL: a real listener on the port is silent" "$([ "$(has "$(logtxt)" 'coturn')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"
	kill "$LISTENER" 2>/dev/null; LISTENER=""
else
	echo "SKIP  coturn positive control (no python3 to open a listener)"
fi

reset; touch "$STATE/enabled.coturn"
run env
check "an enabled but inactive coturn is restarted" "$(has "$(calls)" 'systemctl restart coturn')" "$(calls)"

reset; touch "$STATE/enabled.coturn" "$STATE/active.coturn"; echo 0 > "$STATE/nrestarts.coturn"
run env COTURN_PROBE_PORT=1 ; : > "$LOGF"
echo 2 > "$STATE/nrestarts.coturn"
run env COTURN_PROBE_PORT=1
check "the crash-loop detector runs for coturn too" "$(has "$(logtxt)" 'coturn RESTARTED BY SYSTEMD (NRestarts 0 -> 2)')" "$(logtxt)"

echo
echo "--- Cloudflare: the global client-IP block is asserted, or every per-IP limit is one bucket ---"
# The fixtures are the SHIPPED files, so the check is pinned to what the docs
# tell an operator to install: deploy/cloudflare/caddy-behind-cloudflare.snippet
# (both blocks) must pass, and deploy/Caddyfile (direct mode) must stay silent
# where nothing says the box is behind Cloudflare.
SNIPPET="$HERE/../cloudflare/caddy-behind-cloudflare.snippet"
DIRECT="$HERE/../Caddyfile"
# Derived fixtures are built from a CR-stripped copy: on a Windows checkout
# (text=auto) these files are CRLF and `^}$` would never match. The raw `cp`
# cases below stay raw on purpose — they prove the checker itself copes.
snippet() { tr -d '\r' < "$SNIPPET"; }
COLLAPSE='one bucket for the whole Cloudflare edge'
cfquiet() { [ "$(has "$1" 'Cloudflare')" = 0 ] && [ "$(has "$1" 'client-IP')" = 0 ] && [ "$(has "$1" 'client_ip')" = 0 ] && echo 1 || echo 0; }

# POSITIVE CONTROL FIRST: the prescribed config passes, so the check CAN pass.
check "fixture sanity: the snippet still carries both directives" "$([ "$(has "$(cat "$SNIPPET")" 'trusted_proxies static')" = 1 ] && [ "$(has "$(cat "$SNIPPET")" 'client_ip_headers CF-Connecting-IP')" = 1 ] && echo 1 || echo 0)"
reset; cp "$SNIPPET" "$TMP/Caddyfile"
run env
check "the shipped snippet (both blocks) is silent" "$(cfquiet "$(logtxt)")" "$(logtxt)"

# THE FAILURE THIS EXISTS FOR: the site block was installed, the global block forgotten.
# (The global options block is the `{` … `}` pair at column 0, first in the file.)
reset; snippet | sed '/^{$/,/^}$/d' > "$TMP/Caddyfile"
check "fixture sanity: the site block survives the strip" "$(has "$(cat "$TMP/Caddyfile")" 'header_up X-Forwarded-For {client_ip}')"
check "fixture sanity: the global block is gone (the word survives only in the header comment)" "$([ "$(grep -Ec '^[[:space:]]*client_ip_headers' "$TMP/Caddyfile")" = 0 ] && echo 1 || echo 0)"
run env
check "site block without the global block is FATAL"      "$(has "$(logtxt)" "FATAL $TMP/Caddyfile has no global")" "$(logtxt)"
check "and says what it costs"                            "$(has "$(logtxt)" "$COLLAPSE")"
check "and names the snippet to install"                  "$(has "$(logtxt)" 'deploy/cloudflare/caddy-behind-cloudflare.snippet')"
check "and reaches syslog"                                "$(has "$(calls)" 'logger -t sandbox-health FATAL')" "$(calls)"
check "detection only: nothing is restarted or reloaded"  "$([ "$(has "$(calls)" 'restart')" = 0 ] && [ "$(has "$(calls)" 'reload')" = 0 ] && echo 1 || echo 0)" "$(calls)"

# The trap the snippet's header names: trusted_proxies INSIDE reverse_proxy does
# not feed {client_ip}. A grep that ignores scope would pass this.
reset; snippet | sed '/^{$/,/^}$/d' | sed 's|^\(\treverse_proxy 127.0.0.1:3000 {\)$|\1\n\t\ttrusted_proxies static 173.245.48.0/20\n\t\tclient_ip_headers CF-Connecting-IP|' > "$TMP/Caddyfile"
check "fixture sanity: both directives present, but inside reverse_proxy" "$([ "$(has "$(cat "$TMP/Caddyfile")" 'trusted_proxies static')" = 1 ] && [ "$(has "$(cat "$TMP/Caddyfile")" 'client_ip_headers CF-Connecting-IP')" = 1 ] && echo 1 || echo 0)" "$(cat "$TMP/Caddyfile")"
run env
check "directives inside reverse_proxy do NOT count" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile has no global")" "$(logtxt)"

# Neither does a comment that mentions them.
reset; { snippet | sed '/^{$/,/^}$/d'; printf '# servers {\n#\ttrusted_proxies static 173.245.48.0/20\n#\tclient_ip_headers CF-Connecting-IP\n# }\n'; } > "$TMP/Caddyfile"
run env
check "directives in a comment do NOT count" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile has no global")" "$(logtxt)"

# A servers block that has only ONE of the two is the "set one without the
# other" failure the snippet warns about.
reset; snippet | sed '/^[[:space:]]*client_ip_headers CF-Connecting-IP$/d' > "$TMP/Caddyfile"
check "fixture sanity: client_ip_headers removed" "$([ "$(has "$(cat "$TMP/Caddyfile")" 'client_ip_headers CF-Connecting-IP')" = 0 ] && echo 1 || echo 0)"
run env
check "trusted_proxies without client_ip_headers is FATAL" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile has no global")" "$(logtxt)"

# The other trap the snippet names: a placeholder that does not exist.
reset; snippet | sed 's/{client_ip}/{http.request.client_ip}/' > "$TMP/Caddyfile"
run env
check "{http.request.client_ip} is FATAL even with the global block" "$(has "$(logtxt)" 'a placeholder that does not exist')" "$(logtxt)"
reset; snippet | sed 's/{client_ip}/{http.vars.client_ip}/' > "$TMP/Caddyfile"
run env
check "the long form {http.vars.client_ip} is accepted" "$(cfquiet "$(logtxt)")" "$(logtxt)"

# THE MERGE FAILURE: the snippet's header says "merge these directives into
# yours if you already have one". An operator who merges the global block into
# an existing Caddyfile and leaves deploy/Caddyfile's direct-mode
# `header_up X-Forwarded-For {remote_host}` has a correct global block whose
# answer the site block throws away. The Caddyfile is no longer evidence of
# Cloudflare (that grep wants {client_ip}), so the origin lock's ufw tag is what
# says the box is behind it — as on a real deployment.
reset; snippet | sed 's/{client_ip}/{remote_host}/' > "$TMP/Caddyfile"
check "fixture sanity: the global block survived the rewrite"       "$(has "$(cat "$TMP/Caddyfile")" 'client_ip_headers CF-Connecting-IP')"
check "fixture sanity: the site block now writes {remote_host}"      "$(has "$(cat "$TMP/Caddyfile")" 'header_up X-Forwarded-For {remote_host}')"
printf 'ufw allow 22/tcp\nufw allow proto tcp from 173.245.48.0/20 to any port 443 comment '"'"'cf-origin'"'"'\n' > "$STATE/ufw-added"
run env
check "global block + site block still writing {remote_host} is FATAL" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile writes X-Forwarded-For from {remote_host}")" "$(logtxt)"
check "and it is NOT blamed on the global block"                       "$([ "$(has "$(logtxt)" 'has no global')" = 0 ] && echo 1 || echo 0)" "$(logtxt)"
check "and says what it costs"                                         "$(has "$(logtxt)" "$COLLAPSE")"
check "and names the line to write"                                    "$(has "$(logtxt)" 'header_up X-Forwarded-For {client_ip}')"
check "and reaches syslog"                                             "$(has "$(calls)" 'logger -t sandbox-health FATAL')" "$(calls)"
check "detection only: nothing is restarted or reloaded"               "$([ "$(has "$(calls)" 'restart')" = 0 ] && [ "$(has "$(calls)" 'reload')" = 0 ] && echo 1 || echo 0)" "$(calls)"

# The same file with NO evidence of Cloudflare is left alone: the global block
# by itself is not evidence, so the FATAL above came from the ufw tag.
reset; snippet | sed 's/{client_ip}/{remote_host}/' > "$TMP/Caddyfile"
run env
check "the same file with no origin lock and no knob is silent" "$(cfquiet "$(logtxt)")" "$(logtxt)"

# The other half-merge: the new line was added and the old one NOT deleted.
# The Caddyfile is its own evidence here; a check that stops at "the right line
# exists" would pass it.
reset; snippet | sed 's|^\(\treverse_proxy 127.0.0.1:3000 {\)$|\1\n\t\theader_up X-Forwarded-For {remote_host}|' > "$TMP/Caddyfile"
check "fixture sanity: both header_up lines present" "$([ "$(has "$(cat "$TMP/Caddyfile")" 'header_up X-Forwarded-For {remote_host}')" = 1 ] && [ "$(has "$(cat "$TMP/Caddyfile")" 'header_up X-Forwarded-For {client_ip}')" = 1 ] && echo 1 || echo 0)" "$(cat "$TMP/Caddyfile")"
run env
check "a stale {remote_host} line beside the correct one is FATAL" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile writes X-Forwarded-For from {remote_host}")" "$(logtxt)"

# The site block missing entirely: the global block resolves the visitor and
# nothing hands it to the backend.
reset; snippet | sed '/^[[:space:]]*header_up X-Forwarded-For {client_ip}$/d' > "$TMP/Caddyfile"
check "fixture sanity: no header_up X-Forwarded-For line remains" "$([ "$(grep -Ec '^[[:space:]]*header_up[[:space:]]+X-Forwarded-For' "$TMP/Caddyfile")" = 0 ] && echo 1 || echo 0)"
run env OPS_BEHIND_CLOUDFLARE=1
check "global block without any header_up X-Forwarded-For is FATAL" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile never writes X-Forwarded-For")" "$(logtxt)"
check "and names the missing line"                                 "$(has "$(logtxt)" 'header_up X-Forwarded-For {client_ip}')"
check "and says what it costs"                                     "$(has "$(logtxt)" "$COLLAPSE")"

# POSITIVE CONTROLS for the site-block check: the old line kept as a COMMENT
# (the tidy way to merge) and a quoted value (Caddyfile syntax allows it) are
# both correct configs and must stay silent.
reset; snippet | sed 's|^\(\treverse_proxy 127.0.0.1:3000 {\)$|\1\n\t\t# header_up X-Forwarded-For {remote_host}|' > "$TMP/Caddyfile"
run env
check "the old {remote_host} line commented out does NOT count" "$(cfquiet "$(logtxt)")" "$(logtxt)"
reset; snippet | sed 's/header_up X-Forwarded-For {client_ip}/header_up X-Forwarded-For "{client_ip}"/' > "$TMP/Caddyfile"
check "fixture sanity: the value is quoted" "$(has "$(cat "$TMP/Caddyfile")" 'header_up X-Forwarded-For "{client_ip}"')"
run env
check "a quoted \"{client_ip}\" is accepted" "$(cfquiet "$(logtxt)")" "$(logtxt)"

# Direct mode: the shipped deploy/Caddyfile on a box nothing says is behind
# Cloudflare. Its comments mention trusted_proxies; that must not trip anything.
reset; cp "$DIRECT" "$TMP/Caddyfile"
run env
check "direct-mode deploy/Caddyfile with no origin lock is silent" "$(cfquiet "$(logtxt)")" "$(logtxt)"

# ...but the SAME file on a box whose ufw carries origin-firewall.sh's tag is a
# Cloudflare deployment that never installed the snippet: the collapse is live.
reset; cp "$DIRECT" "$TMP/Caddyfile"
printf 'ufw allow 22/tcp\nufw allow proto tcp from 173.245.48.0/20 to any port 443 comment '"'"'cf-origin'"'"'\nufw deny proto tcp to any port 443 comment '"'"'cf-origin default-deny'"'"'\n' > "$STATE/ufw-added"
run env
check "origin lock present + direct-mode Caddyfile is FATAL" "$(has "$(logtxt)" "FATAL $TMP/Caddyfile has no global")" "$(logtxt)"

reset; snippet | sed '/^{$/,/^}$/d' > "$TMP/Caddyfile"
run env OPS_BEHIND_CLOUDFLARE=0
check "OPS_BEHIND_CLOUDFLARE=0 silences it (not behind Cloudflare, or not Caddy)" "$(cfquiet "$(logtxt)")" "$(logtxt)"

reset
run env
check "no Caddyfile and no evidence -> silent (nginx box, or no proxy)" "$(cfquiet "$(logtxt)")" "$(logtxt)"

reset
run env OPS_BEHIND_CLOUDFLARE=1
check "OPS_BEHIND_CLOUDFLARE=1 with no Caddyfile is FATAL (cannot verify)" "$(has "$(logtxt)" 'FATAL cannot verify client-IP resolution')" "$(logtxt)"
check "and says how to point it at the real file"                          "$(has "$(logtxt)" 'set CADDYFILE in /etc/default/puca')"

reset; cp "$SNIPPET" "$TMP/Caddyfile"
run env OPS_BEHIND_CLOUDFLARE=1
check "OPS_BEHIND_CLOUDFLARE=1 with the snippet installed is silent" "$(cfquiet "$(logtxt)")" "$(logtxt)"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all healthcheck.sh checks passed"
