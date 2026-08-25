#!/usr/bin/env bash
# Tests for render-turn-conf.sh. Runs anywhere bash + sed exist, including Git
# Bash on Windows — the point is that the config generation is exercised BEFORE
# it runs once, as root, on a VPS that has already been paid for.
#
#   ./render-turn-conf.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RENDER="$HERE/render-turn-conf.sh"
TEMPLATE="$HERE/../turn/turnserver.conf"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has()  { printf '%s' "$1" | grep -q "$2" && echo 1 || echo 0; }

PUB=203.0.113.10

echo "--- no NAT (public IP on the NIC) ---"
NONAT="$(bash "$RENDER" "$TEMPLATE" "$PUB" "$PUB" deadbeef example.com 1000)"
rc=$?
check "renders successfully" "$([ $rc = 0 ] && echo 1 || echo 0)"
check "listening-ip is the public IP"  "$(has "$NONAT" "^listening-ip=$PUB$")"
check "relay-ip is the public IP"      "$(has "$NONAT" "^relay-ip=$PUB$")"
# The one that matters: a stale external-ip breaks every relayed call.
check "external-ip is absent entirely" "$([ "$(has "$NONAT" '^external-ip=')" = 0 ] && echo 1 || echo 0)" \
	"$(printf '%s' "$NONAT" | grep '^external-ip=' || true)"
check "own public IP is denied as a peer" "$(has "$NONAT" "^denied-peer-ip=$PUB$")"
check "secret substituted"             "$(has "$NONAT" '^static-auth-secret=deadbeef$')"

# 1000 Mbps * 60% = 600 Mbps = 75,000,000 bytes/sec.
check "bps-capacity scales to the uplink" "$(has "$NONAT" '^bps-capacity=75000000$')" \
	"$(printf '%s' "$NONAT" | grep '^bps-capacity=' || true)"
check "per-allocation cap is 10 Mbps"     "$(has "$NONAT" '^max-bps=1250000$')"

echo
echo "--- 1:1 NAT (NIC holds a private address) ---"
NAT="$(bash "$RENDER" "$TEMPLATE" "$PUB" 10.0.0.5 deadbeef example.com 1000)"
check "listening-ip is the NIC address"   "$(has "$NAT" '^listening-ip=10\.0\.0\.5$')"
check "external-ip maps public to private" "$(has "$NAT" "^external-ip=$PUB/10\.0\.0\.5$")"

echo
echo "--- safety directives survive in both modes ---"
for name in 'use-auth-secret' 'no-multicast-peers' 'denied-peer-ip=192\.168\.0\.0' 'denied-peer-ip=169\.254\.0\.0'; do
	check "no-NAT keeps $name" "$(has "$NONAT" "^$name")"
	check "NAT keeps $name"    "$(has "$NAT" "^$name")"
done

echo
echo "--- the render must FAIL rather than emit a broken config ---"
# Anti-vacuity: these are the cases the guards exist for. If a mangled template
# still renders "successfully", every PASS above is worthless, because the
# guards would not have caught a real regression either.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A template that gained a NEW placeholder line the substitution does not know
# about — the realistic regression, since every line render-turn-conf.sh already
# rewrites is by definition covered.
cp "$TEMPLATE" "$TMP/placeholder.conf"
echo 'alt-listening-ip=YOUR_LAN_IP' >> "$TMP/placeholder.conf"
bash "$RENDER" "$TMP/placeholder.conf" "$PUB" "$PUB" s r 1000 >/dev/null 2>&1
check "rejects a surviving placeholder" "$([ $? -ne 0 ] && echo 1 || echo 0)"

# A template someone stripped the authentication directive out of.
grep -v '^use-auth-secret' "$TEMPLATE" > "$TMP/noauth.conf"
bash "$RENDER" "$TMP/noauth.conf" "$PUB" "$PUB" s r 1000 >/dev/null 2>&1
check "rejects a template with no use-auth-secret" "$([ $? -ne 0 ] && echo 1 || echo 0)"

# A template someone stripped the private-network denylist out of.
grep -v '^denied-peer-ip=192\.168\.0\.0' "$TEMPLATE" > "$TMP/nodeny.conf"
bash "$RENDER" "$TMP/nodeny.conf" "$PUB" "$PUB" s r 1000 >/dev/null 2>&1
check "rejects a template missing the RFC1918 denylist" "$([ $? -ne 0 ] && echo 1 || echo 0)"

echo
[ "$fails" -eq 0 ] && echo "ALL PASS" || echo "$fails FAILURE(S)"
exit $(( fails > 0 ? 1 : 0 ))
