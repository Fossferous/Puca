#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 VPS to run Sovereign. Run as root ON THE NEW
# BOX. Installs packages, writes coturn/LiveKit/firewall config with this
# host's addresses substituted in, and creates an empty database.
#
# It does NOT migrate anything: no data is copied, no DNS is changed, no
# backend is started. Restoring data is deploy/ops/restore.sh, and only after
# the soak in deploy/migrate/README.md says this host can carry media at all.
#
#   ./provision.sh --public-ip 203.0.113.10 --uplink-mbps 1000
#   ./provision.sh --public-ip 203.0.113.10 --uplink-mbps 1000 --dry-run
#
# Safe to re-run: every generated file is backed up to <file>.bak-<timestamp>
# before it is replaced.
set -euo pipefail

# NO GLOBAL `umask 077` HERE, DELIBERATELY — write_file below gives every
# generated file its exact mode BEFORE any byte lands, which is the whole of
# the problem a restrictive umask was meant to cover. A blanket umask would
# also apply to `mkdir -p /opt/puca/...` a few steps down, making /opt/puca
# 0700; Caddy runs as its own user and serves /opt/puca/webapp and
# /opt/puca/downloads out of it, so a freshly provisioned box would answer 403
# on the web app and the download site with nothing in any log to explain it.

PUBLIC_IP=""
UPLINK_MBPS=1000
REALM="example.com"
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		--public-ip)   PUBLIC_IP="$2"; shift 2 ;;
		--uplink-mbps) UPLINK_MBPS="$2"; shift 2 ;;
		--realm)       REALM="$2"; shift 2 ;;
		--dry-run)     DRY_RUN=1; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

[ -n "$PUBLIC_IP" ] || { echo "usage: provision.sh --public-ip <ip> [--uplink-mbps N] [--dry-run]" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# --- Guard: never run this against the existing production box. -------------
# Provisioning rewrites /etc/turnserver.conf and the LiveKit config. On the
# live host that is an outage, and the whole point of this script is that it
# runs somewhere new.
if [ -x /opt/puca/puca ] || systemctl is-active --quiet puca 2>/dev/null; then
	echo "REFUSING: /opt/puca/puca exists or the service is running." >&2
	echo "This looks like an already-deployed host. Provision only runs on a fresh box." >&2
	exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TURN_TEMPLATE="$REPO/deploy/turn/turnserver.conf"
LK_TEMPLATE="$REPO/deploy/livekit/livekit.yaml"
[ -f "$TURN_TEMPLATE" ] || { echo "missing $TURN_TEMPLATE — run this from a repo checkout" >&2; exit 1; }
[ -f "$LK_TEMPLATE" ]   || { echo "missing $LK_TEMPLATE — run this from a repo checkout" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }
write_file() {
	# write_file <path> <mode>  — content on stdin, backing up any existing file.
	local path="$1" mode="$2"
	if [ "$DRY_RUN" = 1 ]; then
		echo "  [dry-run] would write $path (mode $mode):"
		sed 's/^/      | /' | head -40
		return
	fi
	[ -f "$path" ] && cp -a "$path" "$path.bak-$STAMP"
	# install-then-fill, NOT write-then-chmod. `cat > "$path"` followed by
	# `chmod` leaves a window — however short — in which a file containing
	# JWT_SECRET and the database password exists at whatever the ambient umask
	# allows. `install -m` creates it with the final mode before a single byte
	# is written, so there is no such window at all. (The umask at the top of
	# this script covers the same hazard for everything else; this covers the
	# case where the caller wants a WIDER mode than the umask, which is exactly
	# what /etc/turnserver.conf at 640 is.)
	install -m "$mode" /dev/null "$path"
	cat > "$path"
}

# --- Does this host hold the public IP directly, or is it 1:1 NAT? ----------
# This single fact decides two settings, and getting it wrong breaks media in a
# way that looks like a firewall problem: coturn would advertise a relay
# address nobody can reach, and LiveKit would either advertise a private
# candidate (no NAT assumed but there is one) or waste a STUN round trip and
# advertise the wrong address (NAT assumed but there is none).
#
# Most bare VPS products (OVH, Netcup, Contabo, Hetzner Cloud) put the public
# IP straight on the NIC. Cloud providers with floating/elastic IPs (AWS, GCP,
# some Hetzner setups) do 1:1 NAT. Detect rather than assume.
NIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
[ -n "$NIC_IP" ] || { echo "could not determine this host's outbound IP" >&2; exit 1; }

if [ "$NIC_IP" = "$PUBLIC_IP" ]; then
	BEHIND_NAT=0
	echo "Address model: public IP is on the NIC directly (no NAT)."
else
	BEHIND_NAT=1
	echo "Address model: NIC holds $NIC_IP but public is $PUBLIC_IP — 1:1 NAT."
	echo "  If that is wrong, --public-ip was wrong; stop now."
fi

# Sanity: the address the internet sees should match what was passed in. A
# mismatch means either the wrong --public-ip or an egress proxy, and both
# produce a server that answers signalling but drops every call.
SEEN="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
if [ -n "$SEEN" ] && [ "$SEEN" != "$PUBLIC_IP" ]; then
	echo "WARNING: the internet sees this host as $SEEN, not $PUBLIC_IP." >&2
	echo "         Continuing, but verify before trusting any media test." >&2
fi

echo
echo "Provisioning for $PUBLIC_IP (uplink ${UPLINK_MBPS} Mbps, realm $REALM)"
[ "$DRY_RUN" = 1 ] && echo "DRY RUN — nothing will be changed."
echo

# --- Packages ---------------------------------------------------------------
echo "[1/7] packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq \
	postgresql postgresql-contrib \
	coturn \
	ufw curl openssl ca-certificates gnupg jq apt-transport-https \
	build-essential pkg-config libssl-dev \
	nodejs

# Caddy is NOT in the Ubuntu archive — `apt install caddy` fails outright and,
# under set -e, aborts the provision half-done. Its own repository has to be
# added first.
if ! command -v caddy >/dev/null 2>&1; then
	run bash -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
	run bash -c 'echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] \
https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
		> /etc/apt/sources.list.d/caddy-stable.list'
	run apt-get update -qq
	run apt-get install -y -qq caddy
fi

# Rust toolchain: the backend is built ON the box (see CLAUDE.md), so the
# target box needs cargo, not just a binary drop.
if [ ! -x /root/.cargo/bin/cargo ]; then
	run bash -c 'curl -fsS --proto "=https" --tlsv1.2 https://sh.rustup.rs | sh -s -- -y --profile minimal'
fi

# --- Users and directories --------------------------------------------------
echo "[2/7] service account and directories"
id puca >/dev/null 2>&1 || run useradd --system --home /opt/puca --shell /usr/sbin/nologin puca
run mkdir -p /opt/puca/uploads /opt/puca/releases /opt/livekit
run chown -R puca:puca /opt/puca

# --- Database ---------------------------------------------------------------
# Empty database only. Data arrives via deploy/ops/restore.sh at cutover, not
# now — migrating early means running two live servers with diverging state.
echo "[3/7] postgres role and empty database"
DB_PASS="$(openssl rand -hex 24)"
if [ "$DRY_RUN" = 1 ]; then
	echo "  [dry-run] would create role 'puca' + database 'puca'"
else
	if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='puca'" | grep -q 1; then
		echo "  role exists — leaving its password alone (re-run safe)"
		DB_PASS=""
	else
		# The password goes in on STDIN, never in argv: an argument is visible
		# in /proc/<pid>/cmdline to any local process for the life of the
		# command, and is captured verbatim by execve auditing (auditd, any
		# EDR). DB_PASS comes from `openssl rand -hex 24` above, so it is
		# hex-only and cannot contain the quote that would break out of the
		# literal — worth stating, because that is the property being relied on.
		printf "CREATE ROLE puca LOGIN PASSWORD '%s'\n" "$DB_PASS" \
			| sudo -u postgres psql -q -f -
	fi
	sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='puca'" | grep -q 1 \
		|| sudo -u postgres createdb -O puca puca
fi

# --- coturn -----------------------------------------------------------------
# Generated from deploy/turn/turnserver.conf so the peer denylist (the part
# that stops the relay being used to reach private networks and the host's own
# services) stays single-sourced. Only the address and quota lines change here.
echo "[4/7] coturn"
TURN_SECRET="$(openssl rand -hex 32)"

# bps-capacity is the aggregate ceiling in BYTES/sec and it is the whole reason
# for moving hosts: the home value was 20 Mbps because a residential uplink
# could not carry more. Size it to 60% of the real uplink — a relay both
# receives and re-sends, and the box still has to serve HTTP, WS and the SFU.
CAP_BYTES=$(( UPLINK_MBPS * 1000000 / 8 * 60 / 100 ))

LISTEN_IP=$([ "$BEHIND_NAT" = 1 ] && echo "$NIC_IP" || echo "$PUBLIC_IP")

# Rendering lives in render-turn-conf.sh, which has its own tests
# (render-turn-conf.test.sh) — this substitution runs exactly once, as root, on
# a box that has already been paid for, so it is exercised beforehand instead.
# It exits non-zero if a placeholder survived or the template lost a safety
# directive, and `set -e` turns that into an aborted provision.
TURN_CONF="$(bash "$HERE/render-turn-conf.sh" \
	"$TURN_TEMPLATE" "$PUBLIC_IP" "$NIC_IP" "$TURN_SECRET" "$REALM" "$UPLINK_MBPS")"

# 640 not 600: coturn drops to its own user and a 600 root-owned file is
# unreadable, which coturn treats as "no config" — i.e. an OPEN RELAY.
printf '%s\n' "$TURN_CONF" | write_file /etc/turnserver.conf 640
[ "$DRY_RUN" = 1 ] || chown root:turnserver /etc/turnserver.conf 2>/dev/null || true
[ "$DRY_RUN" = 1 ] || sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

# REST auth needs the secret in the SQLite turn_secret table as WELL as in the
# config file. `static-auth-secret` alone is documented as sufficient and is
# NOT: this coturn (4.6.1, Ubuntu 24.04) answers every single Allocate with
#   ERROR: check_stun_auth: Cannot find credentials of user <...>
# and 401 Unauthorized, for a correctly HMAC-signed credential exactly as for a
# bogus one. Diagnosed live with `turnserver -V`; registering the same secret
# via turnadmin fixed it immediately and a wrong secret is still refused.
#
# This one is nastier than it looks: nothing about it is visible until a real
# user behind strict NAT actually needs the relay, because everyone whose
# connection succeeds peer-to-peer never touches TURN at all.
# ARGV EXPOSURE, ACCEPTED AND STATED. turnadmin has no way to take the secret
# on stdin or from a file — `-s` is the only interface — so for the life of this
# one command the TURN secret is readable in /proc/<pid>/cmdline by any local
# process and is captured by execve auditing. It is not removable without
# writing coturn's SQLite turn_secret table directly, which would mean
# reimplementing an internal schema this script would then silently depend on.
# Bounded by: the command runs once, on a FRESH box (the guard at the top
# refuses a deployed one), before any untrusted process exists on it; and the
# same secret is in /etc/turnserver.conf mode 640 anyway. Rotating it means
# rewriting both, so a leak here is recoverable rather than permanent.
run turnadmin -s "$TURN_SECRET" -r "$REALM" -b /var/lib/turn/turndb

# The coturn PACKAGE auto-starts the service during `apt-get install` above,
# using its own stock /etc/turnserver.conf — the file we just overwrote is on
# disk, but the already-running process never re-reads it. Confirmed live: it
# kept serving on the DEFAULT port (3478, auto-discovered addresses) with our
# rendered config sitting unread right next to it, "NO EXPLICIT LISTENER
# ADDRESS(ES) ARE CONFIGURED" in its own log — verify.sh's open-relay probe
# then gets a bare connection refused on 3479 because nothing is listening
# there at all. A config write with no restart is a no-op in every way that
# matters. Must come AFTER turnadmin so the secret is in place on startup.
run systemctl restart coturn

# --- LiveKit ----------------------------------------------------------------
echo "[5/7] livekit"
LK_KEY="SV$(openssl rand -hex 6)"
LK_SECRET="$(openssl rand -hex 32)"

# Pinned to the version production already runs. The upstream one-liner
# installer (`curl https://get.livekit.io | bash`) tracks latest, which would
# quietly make the new box a different SFU version from the one the egress
# sampler and admission model were validated against — and a metric name change
# is exactly how the measured branch went inert once before.
LIVEKIT_VERSION=1.13.4

# The unit file runs as User=livekit with ExecStart=/opt/livekit/livekit-server.
# Neither the account nor that path existed: the service crash-looped on
# `status=217/USER` ("Failed to determine user credentials") ~25 times, and the
# binary had been extracted to /usr/local/bin owned by a stray uid 1001 from
# inside the tarball. Create the account and install where the unit looks.
id livekit >/dev/null 2>&1 || run useradd --system --home /opt/livekit --shell /usr/sbin/nologin livekit

if [ ! -x /opt/livekit/livekit-server ] \
	|| ! /opt/livekit/livekit-server --version 2>/dev/null | grep -q "$LIVEKIT_VERSION"; then
	run bash -c "curl -fsSL -o /tmp/livekit.tgz \
		https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz \
		&& tar -xzf /tmp/livekit.tgz -C /tmp livekit-server \
		&& install -o livekit -g livekit -m 755 /tmp/livekit-server /opt/livekit/livekit-server \
		&& rm -f /tmp/livekit.tgz /tmp/livekit-server"
fi

# use_external_ip triggers a STUN lookup to discover the public address. With
# the public IP on the NIC there is nothing to discover, and leaving it on adds
# a startup dependency on a third-party STUN server for no benefit.
LK_EXTERNAL=$([ "$BEHIND_NAT" = 1 ] && echo true || echo false)
sed \
	-e "s|__LIVEKIT_API_KEY__|$LK_KEY|g" \
	-e "s|__LIVEKIT_API_SECRET__|$LK_SECRET|g" \
	-e "s|^  use_external_ip: .*|  use_external_ip: $LK_EXTERNAL|" \
	"$LK_TEMPLATE" | write_file /opt/livekit/livekit.yaml 640

# 640 root:root leaves the config unreadable by the livekit user the service
# runs as — the same class of trap as coturn's config permissions. Must be owned
# by livekit, not merely mode-640.
[ "$DRY_RUN" = 1 ] || chown livekit:livekit /opt/livekit /opt/livekit/livekit.yaml

[ "$DRY_RUN" = 1 ] || cp "$REPO/deploy/livekit/livekit.service" /etc/systemd/system/livekit.service

# --- Firewall ---------------------------------------------------------------
# SSH first and explicitly. `ufw --force enable` with no allow rule for 22 ends
# the session and the box has to be rebuilt from the provider's console.
echo "[6/7] firewall"
run ufw allow 22/tcp
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw allow 3479/tcp comment 'coturn'
run ufw allow 3479/udp comment 'coturn'
run ufw allow 49180:49220/udp comment 'coturn relay range'
run ufw allow 7881/tcp comment 'livekit ice-tcp'
run ufw allow 7882/udp comment 'livekit media mux'
# Deliberately NOT opened: 5432 (postgres), 7880 (livekit signalling — Caddy
# proxies it), 6789 (livekit metrics — scraped over loopback). Each is a
# straight path to data or to the admission controller if exposed.
run ufw --force enable

# --- Backend env skeleton ---------------------------------------------------
echo "[7/7] /opt/puca/.env skeleton"
if [ -f /opt/puca/.env ] && [ "$DRY_RUN" != 1 ]; then
	echo "  .env already exists — left untouched"
else
	SFU_BUDGET=$(( UPLINK_MBPS * 60 / 100 ))
	{
		echo "# Generated by deploy/migrate/provision.sh on $STAMP."
		echo "# JWT_SECRET and DATABASE_URL below are NEW. At cutover, copy the"
		echo "# JWT_SECRET from the OLD box instead — changing it logs every user"
		echo "# out and invalidates every session token in flight."
		echo "APP_ENV=production"
		echo "BIND_ADDR=127.0.0.1"
		echo "PORT=3000"
		echo "DATABASE_URL=postgres://puca:${DB_PASS:-SET_ME}@127.0.0.1/puca"
		echo "JWT_SECRET=$(openssl rand -hex 32)"
		echo "RUST_LOG=puca=info,tower_http=warn"
		echo "DATABASE_MAX_CONNECTIONS=10"
		echo "APP_URL=https://app.${REALM}"
		# The desktop (Tauri) and mobile (Capacitor) clients send their own
		# origins, NOT the web one. Listing only app.<realm> CORS-blocks every
		# non-browser client while the webapp keeps working — a migration that
		# looks completely successful and has locked out every installed app.
		echo "CORS_ORIGINS=https://chat.${REALM},tauri://localhost,http://tauri.localhost,https://localhost,capacitor://localhost,https://app.${REALM}"
		# turn.<realm>, not <realm>: the relay has its own hostname (grey-clouded
		# in DNS, since Cloudflare cannot proxy UDP). Pointing at the bare realm
		# resolves to the proxied web host and TURN never connects.
		echo "TURN_SERVER=turn:turn.${REALM}:3479?transport=udp,turn:turn.${REALM}:3479?transport=tcp"
		echo "TURN_SECRET=$TURN_SECRET"
		echo "LIVEKIT_URL=wss://sfu.${REALM}"
		echo "LIVEKIT_API_KEY=$LK_KEY"
		echo "LIVEKIT_API_SECRET=$LK_SECRET"
		echo "SFU_METRICS_URL=http://127.0.0.1:6789/metrics"
		echo "SFU_ROOM_MAX_PARTICIPANTS=8"
		echo "SFU_MAX_SCREEN_SHARES=0" # 0 = unlimited; egress budget governs shares
		# NOT generated: REGISTRATION_INVITE_CODE. It must be carried over from
		# the existing deployment — a fresh value silently invalidates every
		# invite link already handed out.
		echo "# REGISTRATION_INVITE_CODE=<carry over from the old box>"
		echo "# Node-global SFU egress ceiling. This is the number the migration"
		echo "# exists to raise; it was sized to a home uplink before."
		echo "SFU_EGRESS_BUDGET_MBPS=$SFU_BUDGET"
		echo "MOBILE_UPDATE_FILE=/opt/puca/mobile-update.json"
	} | write_file /opt/puca/.env 600
	[ "$DRY_RUN" = 1 ] || chown puca:puca /opt/puca/.env
fi

[ "$DRY_RUN" = 1 ] || cp "$REPO/deploy/puca.service" /etc/systemd/system/puca.service
run systemctl daemon-reload

cat <<EOF

Provisioned. Nothing is serving yet, and no data has moved.

Written:
  /etc/turnserver.conf        listen $LISTEN_IP, $( [ "$BEHIND_NAT" = 1 ] && echo "external-ip set for NAT" || echo "no external-ip (public IP on NIC)" )
  /opt/livekit/livekit.yaml   use_external_ip: $LK_EXTERNAL
  /opt/puca/.env         SFU budget $(( UPLINK_MBPS * 60 / 100 )) Mbps, coturn cap $(( CAP_BYTES * 8 / 1000000 )) Mbps
  ufw                         22/80/443 + media ports; postgres/metrics/signalling closed

Next, in order:
  1. node deploy/migrate/udp-sink.mjs        (here, and soak from your machine)
     Do not go further until the soak passes. If this host's DDoS mitigation
     eats sustained UDP, everything after this is wasted work.
  2. deploy/migrate/verify.sh                (here, checks what was configured)
  3. Only then: DNS, certificates, restore.sh, cutover.
EOF
