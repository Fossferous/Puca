#!/usr/bin/env bash
# Render a deployable /etc/turnserver.conf from the repo template.
#
#   render-turn-conf.sh <template> <public-ip> <nic-ip> <secret> <realm> <uplink-mbps>
#
# Writes to stdout. Exits non-zero if any placeholder survived — a config with
# YOUR_LAN_IP still in it starts coturn happily and then fails every single
# allocation, which presents as "voice is broken" rather than as a config error.
#
# This lives in its own file so it can be tested on any machine (see
# render-turn-conf.test.sh) instead of only being exercised once, as root, on a
# freshly bought VPS.
set -euo pipefail

TEMPLATE="${1:?template path}"
PUBLIC_IP="${2:?public ip}"
NIC_IP="${3:?nic ip}"
SECRET="${4:?turn secret}"
REALM="${5:?realm}"
UPLINK_MBPS="${6:?uplink mbps}"

# A relay both receives and re-sends, and the box still serves HTTP, WS and the
# SFU from the same uplink — so the relay gets 60% of the line, not all of it.
CAP_BYTES=$(( UPLINK_MBPS * 1000000 / 8 * 60 / 100 ))
MAX_BYTES=$(( 10 * 1000000 / 8 ))   # 10 Mbps per allocation; a share is ~4.5

if [ "$PUBLIC_IP" = "$NIC_IP" ]; then
	# No NAT. external-ip must be ABSENT, not set to public/public: carried
	# over from a NAT'd host it advertises a LAN address that does not exist
	# here and every relayed call fails.
	LISTEN_IP="$PUBLIC_IP"
	EXTERNAL_LINE=""
else
	LISTEN_IP="$NIC_IP"
	EXTERNAL_LINE="external-ip=$PUBLIC_IP/$NIC_IP"
fi

OUT="$(
	sed \
		-e "s|^listening-ip=.*|listening-ip=$LISTEN_IP|" \
		-e "s|^relay-ip=.*|relay-ip=$LISTEN_IP|" \
		-e "s|^external-ip=.*|__EXTERNAL__|" \
		-e "s|^static-auth-secret=.*|static-auth-secret=$SECRET|" \
		-e "s|^realm=.*|realm=$REALM|" \
		-e "s|^denied-peer-ip=YOUR_PUBLIC_IP|denied-peer-ip=$PUBLIC_IP|" \
		-e "s|^max-bps=.*|max-bps=$MAX_BYTES|" \
		-e "s|^bps-capacity=.*|bps-capacity=$CAP_BYTES|" \
		"$TEMPLATE" \
	| { if [ -n "$EXTERNAL_LINE" ]; then sed "s|^__EXTERNAL__|$EXTERNAL_LINE|"; else grep -v '^__EXTERNAL__'; fi; }
)"

if printf '%s' "$OUT" | grep -q 'YOUR_LAN_IP\|YOUR_PUBLIC_IP\|REPLACED_AT_DEPLOY\|__EXTERNAL__'; then
	echo "render-turn-conf: placeholder survived substitution:" >&2
	printf '%s\n' "$OUT" | grep -n 'YOUR_LAN_IP\|YOUR_PUBLIC_IP\|REPLACED_AT_DEPLOY\|__EXTERNAL__' >&2
	exit 1
fi

# The relay denylist is what stops this host being used to reach private
# networks and its own services. If a template edit ever drops it, the render
# must fail rather than quietly produce a usable-looking config.
for required in '^use-auth-secret' '^denied-peer-ip=10\.0\.0\.0' '^denied-peer-ip=192\.168\.0\.0' '^denied-peer-ip=169\.254\.0\.0' '^no-multicast-peers'; do
	printf '%s\n' "$OUT" | grep -q "$required" || {
		echo "render-turn-conf: template lost a required safety directive: $required" >&2
		exit 1
	}
done

printf '%s\n' "$OUT"
