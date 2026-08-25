#!/usr/bin/env bash
# Check a provisioned box before trusting it with production. Run as root ON
# THE NEW BOX, after provision.sh.
#
# These are the checks whose failures are SILENT — a box that fails any of them
# still starts, still answers HTTP, and still looks provisioned. Config that is
# merely read back to you proves nothing, so where a live probe is possible
# this does the probe instead.
#
#   ./verify.sh
set -uo pipefail   # no -e: every check must run, so one failure cannot mask the rest

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+  — $2}"; fails=$((fails + 1)); }
warn() { echo "WARN  $1${2:+  — $2}"; }

echo "=== coturn ==="

if [ -f /etc/turnserver.conf ]; then
	pass "config present"

	if grep -q 'YOUR_LAN_IP\|YOUR_PUBLIC_IP\|REPLACED_AT_DEPLOY' /etc/turnserver.conf; then
		fail "placeholders left in config" "coturn starts, then fails every allocation"
	else
		pass "no placeholders survived"
	fi

	# The permissions trap. coturn drops privileges; if it cannot READ its own
	# config it does not refuse to start, it starts with defaults — and the
	# default is an open relay with no authentication. 600 root-only is the
	# mistake that causes this, which is why 640 root:turnserver is required.
	perms="$(stat -c '%a %U:%G' /etc/turnserver.conf)"
	if sudo -u turnserver test -r /etc/turnserver.conf 2>/dev/null; then
		pass "config readable by the turnserver user ($perms)"
	else
		fail "turnserver user CANNOT read /etc/turnserver.conf ($perms)" \
			"coturn falls back to defaults = OPEN RELAY"
	fi

	grep -q '^use-auth-secret' /etc/turnserver.conf \
		&& pass "authentication is enabled" \
		|| fail "use-auth-secret missing" "unauthenticated relay"

	# external-ip must match the address model. Carried over from a NAT'd host
	# it points relays at an address that does not exist here.
	nic="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
	listen="$(sed -n 's/^listening-ip=\(.*\)/\1/p' /etc/turnserver.conf | head -1)"
	ext="$(sed -n 's/^external-ip=\(.*\)/\1/p' /etc/turnserver.conf | head -1)"
	if [ "$listen" = "$nic" ] && [ -z "$ext" ]; then
		pass "no NAT: listening on the NIC address $nic, no external-ip"
	elif [ -n "$ext" ] && [ "$listen" = "$nic" ]; then
		pass "NAT: listening $listen, advertising $ext"
	else
		fail "address model inconsistent" "listening-ip=$listen nic=$nic external-ip=${ext:-<none>}"
	fi

	# Aggregate bandwidth ceiling — the number the whole migration is about.
	cap="$(sed -n 's/^bps-capacity=\([0-9]*\)/\1/p' /etc/turnserver.conf | head -1)"
	if [ -n "$cap" ]; then
		mbps=$(( cap * 8 / 1000000 ))
		[ "$mbps" -gt 50 ] \
			&& pass "relay ceiling ${mbps} Mbps" \
			|| warn "relay ceiling only ${mbps} Mbps" "still sized for a home uplink?"
	fi
else
	fail "/etc/turnserver.conf missing"
fi

# Live probe: a BOGUS credential must be refused. This is the check that
# actually distinguishes a locked relay from an open one; the logs will not
# tell you, because an open relay logs a successful allocation as normal.
#
# TWO probes, not one. A bogus credential failing proves nothing on its own —
# it is equally consistent with "auth works" and "this relay refuses
# EVERYTHING", which is exactly the state this box was in: coturn 4.6.1 ignores
# `static-auth-secret` unless the same secret is also registered in the SQLite
# turn_secret table, so every Allocate got 401 regardless of credential. The
# old single-sided probe reported that as a clean pass. A negative test with no
# positive control cannot distinguish secure from broken.
#
# `-y` is client-to-client mode and needs a second uclient as the peer; with a
# lone client it can never complete, so use an explicit dummy peer via -e/-r.
# `-W` is the REST-API shared-secret mode, which is what `use-auth-secret`
# expects — `-u/-w` with a hand-rolled HMAC does not exercise the same path.
if command -v turnutils_uclient >/dev/null 2>&1 && [ -n "${listen:-}" ]; then
	turn_secret="$(sed -n 's/^static-auth-secret=\(.*\)/\1/p' /etc/turnserver.conf | head -1)"
	turn_port="$(sed -n 's/^listening-port=\([0-9]*\)/\1/p' /etc/turnserver.conf | head -1)"
	turn_port="${turn_port:-3478}"
	probe() { timeout 20 turnutils_uclient -e 8.8.8.8 -r 12345 -u probe -W "$1" -p "$turn_port" "$listen" 2>&1 || true; }
	granted() { printf '%s' "$1" | grep -qi 'start_mclient\|Total connect time'; }

	bogus_out="$(probe 'definitely_the_wrong_secret')"
	if granted "$bogus_out"; then
		fail "OPEN RELAY: a bogus secret was granted an allocation" \
			"anyone on the internet can relay traffic through this host"
	else
		pass "bogus secret refused"
	fi

	if [ -z "$turn_secret" ]; then
		warn "no static-auth-secret found — cannot run the positive control"
	else
		real_out="$(probe "$turn_secret")"
		if granted "$real_out"; then
			pass "a VALID credential is granted an allocation (relay actually works)"
		else
			fail "the relay refuses even a VALID credential — TURN is broken, not secure" \
				"register the secret: turnadmin -s <secret> -r <realm> -b /var/lib/turn/turndb"
		fi
	fi
else
	warn "skipped the relay probes" "turnutils_uclient not installed"
fi

echo
echo "=== livekit ==="
LK=/opt/livekit/livekit.yaml
if [ -f "$LK" ]; then
	pass "config present"
	grep -q '__LIVEKIT_API' "$LK" \
		&& fail "placeholder key/secret left in config" \
		|| pass "keys substituted"

	# Without prometheus_port the backend's egress sampler has nothing to
	# scrape, and SFU admission degrades to the worst-case projection alone —
	# silently, and only visible as calls being refused under load.
	grep -q '^prometheus_port:' "$LK" \
		&& pass "prometheus_port set (measured-egress branch will work)" \
		|| fail "prometheus_port missing" "SFU admission silently loses its measured branch"

	nic="${nic:-$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)}"
	lkext="$(sed -n 's/^ *use_external_ip: *\(.*\)/\1/p' "$LK" | head -1)"
	if [ -n "${ext:-}" ] && [ "$lkext" != "true" ]; then
		fail "coturn says this host is NAT'd but livekit use_external_ip is $lkext" \
			"LiveKit will advertise an unreachable candidate"
	elif [ -z "${ext:-}" ] && [ "$lkext" = "true" ]; then
		warn "use_external_ip: true with no NAT" "adds a STUN dependency for nothing"
	else
		pass "use_external_ip: $lkext matches the address model"
	fi
else
	fail "$LK missing"
fi

echo
echo "=== firewall ==="
if ufw status | grep -q '^Status: active'; then
	pass "ufw active"
else
	fail "ufw inactive" "every port below is exposed"
fi

ufw status | grep -qE '(^|[^0-9])22/tcp .*ALLOW' \
	&& pass "22/tcp allowed" \
	|| fail "SSH not allowed" "you may be locked out on next boot"

# If the origin lock is applied, the Cloudflare ALLOWs must be evaluated BEFORE
# the catch-all DENY. ufw is first-match, and the ordering silently inverts when
# a blanket `allow 80/tcp` already exists (ufw updates that rule in place, so the
# deny inherits its early position). Every config check still passes while
# Cloudflare itself is dropped and the site is offline behind the CDN — read the
# COMPILED chain, not `ufw status`, because that is what actually runs.
if iptables -L ufw-user-input -n 2>/dev/null | grep -qE 'DROP.*dpt:443'; then
	first_allow=$(iptables -L ufw-user-input -n --line-numbers 2>/dev/null \
		| grep -E 'ACCEPT.*dpt:443' | head -1 | awk '{print $1}')
	first_deny=$(iptables -L ufw-user-input -n --line-numbers 2>/dev/null \
		| grep -E 'DROP.*dpt:443' | head -1 | awk '{print $1}')
	if [ -n "$first_allow" ] && [ -n "$first_deny" ] && [ "$first_allow" -lt "$first_deny" ]; then
		pass "origin lock ordering: CF allows ($first_allow) precede the deny ($first_deny)"
	else
		fail "origin lock is INVERTED — the deny ($first_deny) precedes the CF allows ($first_allow)" \
			"Cloudflare is dropped too; the site will be offline once DNS points here"
	fi
else
	warn "Cloudflare origin lock not applied" "80/443 are reachable directly, bypassing the CDN"
fi

# Ports that must NOT be reachable from outside. Each is a direct path to data
# or to the admission controller.
for spec in "5432:postgres" "7880:livekit signalling" "6789:livekit metrics"; do
	port="${spec%%:*}"; what="${spec##*:}"
	if ufw status | grep -qE "(^|[^0-9])${port}(/| ).*ALLOW"; then
		fail "$what ($port) is open to the internet"
	else
		pass "$what ($port) not exposed"
	fi
done

echo
echo "=== host identity ==="
# Reading over loopback, so this is unaffected by the Cloudflare origin lock —
# an external check would depend on the caller's source IP being exempt, which
# it is not.
#
# The hostname and the self-identifying header are site-specific, so they are
# PASSED IN. They used to be hardcoded to chat.example.com, which meant this
# probe warned on every real box and proved nothing. An explicit skip is more
# honest than a check that cannot pass:
#   API_HOST=chat.your-domain HOST_HEADER=x-puca-host ./verify.sh
API_HOST="${API_HOST:-}"
HOST_HEADER="${HOST_HEADER:-x-puca-host}"
if [ -z "$API_HOST" ]; then
	warn "API_HOST not set" "host-identity probe skipped; re-run as API_HOST=<your api hostname> ./verify.sh"
else
	selfid="$(curl -sk -I --resolve "$API_HOST:443:127.0.0.1" "https://$API_HOST/" --max-time 15 2>/dev/null \
		| grep -i "^$HOST_HEADER:" | cut -d' ' -f2- | tr -d '\r\n')"
	if [ -n "$selfid" ]; then
		pass "serves $HOST_HEADER: $selfid"
		echo "      confirm which box a client reaches with:"
		echo "      curl -sI https://$API_HOST/ | grep -i $HOST_HEADER"
	else
		warn "no $HOST_HEADER header" "you cannot tell which box answered a given request"
	fi
fi

echo
echo "=== postgres ==="
listen_addr="$(sudo -u postgres psql -tAc 'SHOW listen_addresses' 2>/dev/null | tr -d ' ')"
case "$listen_addr" in
	localhost|127.0.0.1|"") pass "listening on loopback only (${listen_addr:-default})" ;;
	*) warn "listen_addresses = $listen_addr" "ufw blocks 5432, but do not rely on one layer" ;;
esac

echo
echo "=== backend env ==="
ENVF=/opt/puca/.env
if [ -f "$ENVF" ]; then
	perms="$(stat -c '%a' "$ENVF")"
	[ "$perms" = "600" ] && pass ".env mode 600" || fail ".env mode $perms" "secrets world-readable"
	grep -q 'SET_ME' "$ENVF" && fail "unfilled value in .env" || pass "no unfilled values"
	budget="$(sed -n 's/^SFU_EGRESS_BUDGET_MBPS=\([0-9]*\)/\1/p' "$ENVF")"
	[ -n "$budget" ] && pass "SFU egress budget ${budget} Mbps" || warn "SFU_EGRESS_BUDGET_MBPS unset" "falls back to the built-in default"
else
	fail "$ENVF missing"
fi

echo
if [ "$fails" -eq 0 ]; then
	echo "ALL CHECKS PASSED."
	echo "This says the box is CONFIGURED correctly. It does not say the host can"
	echo "carry sustained UDP — only the soak answers that. Run it before cutover."
else
	echo "$fails CHECK(S) FAILED — do not cut over."
fi
exit $(( fails > 0 ? 1 : 0 ))
