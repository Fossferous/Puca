#!/usr/bin/env bash
# Lock the origin so ONLY Cloudflare can reach HTTP/HTTPS. Run on the host that
# terminates TLS (the box that terminates TLS). Requires ufw and curl.
#
# This is REQUIRED when chat.example.com is proxied through Cloudflare: without it,
# an attacker can bypass Cloudflare by hitting the origin IP directly AND forge
# the CF-Connecting-IP header the reverse proxy trusts.
#
# Only ports 80/443 are touched — SSH (22) and the TURN ports are left alone, so
# this cannot lock you out of SSH or break coturn. ufw is FIRST-MATCH: the
# Cloudflare `allow` rules are inserted BEFORE the catch-all `deny` so CF traffic
# is accepted and everything else on 80/443 is dropped. (Getting this order wrong
# — deny before allow — would drop Cloudflare too and take the site offline.)
#
# Re-run whenever Cloudflare updates its ranges. Safe to re-run: it removes its
# own previously-added rules (tagged in the comment) first. Does a dry-run print
# for review; pass --apply to actually change rules.
#
# NOTE: no `set -e` — a single failing IPv6 rule (e.g. ufw IPv6 disabled) must
# not abort the run and leave a half-applied ruleset.
set -uo pipefail

TAG="cf-origin"
APPLY="${1:-}"

command -v ufw  >/dev/null || { echo "ufw not found"; exit 1; }
command -v curl >/dev/null || { echo "curl not found"; exit 1; }

echo "Fetching Cloudflare IP ranges..."
mapfile -t CF_V4 < <(curl -fsS https://www.cloudflare.com/ips-v4)
mapfile -t CF_V6 < <(curl -fsS https://www.cloudflare.com/ips-v6)
[ "${#CF_V4[@]}" -gt 0 ] || { echo "empty IPv4 list — aborting"; exit 1; }
CF_ALL=("${CF_V4[@]}" "${CF_V6[@]}")

if [ "${APPLY}" != "--apply" ]; then
	echo "DRY RUN. Would allow 80/443 from ${#CF_ALL[@]} Cloudflare ranges, then deny all other 80/443."
	printf '  allow %s\n' "${CF_ALL[@]}"
	echo "Re-run with --apply to change the firewall."
	exit 0
fi

# Remove any rules we added on a previous run (matched by the comment tag).
while ufw status numbered | grep -q "# ${TAG}"; do
	num=$(ufw status numbered | grep "# ${TAG}" | head -1 | sed -E 's/^\[ *([0-9]+)\].*/\1/')
	yes | ufw delete "${num}" >/dev/null
done

# 0) Delete EVERY existing 80/443 rule, not just our own tagged ones.
#
# Without this the ordering silently inverts. A pre-existing blanket
# `ufw allow 80/tcp` (deploy/migrate/provision.sh adds exactly that) occupies an
# early position, and ufw treats our `deny proto tcp to any port 80` as the SAME
# rule identity — so it UPDATES that rule in place and inherits its early
# position, landing the catch-all deny ABOVE the Cloudflare allows. ufw is
# first-match, so Cloudflare gets dropped with everyone else and the site is
# offline behind the CDN. Verified on a real box: DROP at positions 2-3 with the
# CF allows stranded at 9+.
#
# Deleting highest-numbered first: each delete renumbers the rest, so ascending
# order skips rules.
while true; do
	num=$(ufw status numbered | grep -E '(80|443)/tcp' | tail -1 | sed -E 's/^\[ *([0-9]+)\].*/\1/')
	[ -n "${num}" ] || break
	yes | ufw delete "${num}" >/dev/null 2>&1
done

# 1) ALLOW Cloudflare first (these land ABOVE the deny in ufw's ordered list).
for cidr in "${CF_ALL[@]}"; do
	[ -n "${cidr}" ] || continue
	for p in 80 443; do
		ufw allow proto tcp from "${cidr}" to any port "${p}" comment "${TAG}" \
			|| echo "skip (allow failed, maybe IPv6 disabled): ${cidr}:${p}"
	done
done

# 2) DENY everything else on 80/443 (appended AFTER the allows -> lower priority).
for p in 80 443; do
	ufw deny proto tcp to any port "${p}" comment "${TAG} default-deny"
done

echo "Applied. Review order (allows MUST be above the deny):"
ufw status numbered | grep -E "# ${TAG}|443|80 "
