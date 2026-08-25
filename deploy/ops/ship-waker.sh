#!/usr/bin/env bash
#
# Build the LAN waker on the build host and install it on the HOME box only.
#
# WHY THIS IS NOT A dual-ship.sh SUBCOMMAND, and must never become one.
# dual-ship.sh loops over every host in hosts.conf, which is exactly right for
# artefacts that must exist everywhere and exactly wrong here. A waker running
# on a datacentre host would be online, verified, and platform=linux — a
# perfectly legitimate candidate for planWake to pick — and it would then
# broadcast a magic packet into that datacentre's LAN and report success. The
# owner would press Wake, see no error, and wait 180 seconds for a machine
# nothing had addressed.
#
# The waker is the one artefact in this repo that is correct on exactly one
# host, so it gets its own single-host script rather than a flag on the
# every-host one.
#
# Usage:
#   deploy/ops/ship-waker.sh              build on the build host, install on home
#   deploy/ops/ship-waker.sh --status     what is running there now
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=hosts.conf
source "$HERE/hosts.conf"

# Derived from hosts.conf (gitignored), never hardcoded here: this file is
# public and server addresses are infrastructure identity. The build host is
# the FIRST entry — the box with the Rust toolchain, same one dual-ship.sh
# builds the backend on. The target is the box on the waker's own LAN.
BUILD_LABEL="${BUILD_LABEL:-${HOSTS[0]%%:*}}"
TARGET_LABEL="${TARGET_LABEL:-home}"

host_for() {
	local want="$1" entry
	for entry in "${HOSTS[@]}"; do
		[ "${entry%%:*}" = "$want" ] && { echo "${entry#*:}"; return 0; }
	done
	echo "ship-waker: no host labelled '$want' in hosts.conf" >&2
	return 1
}
BUILD_HOST="$(host_for "$BUILD_LABEL")"
TARGET_HOST="$(host_for "$TARGET_LABEL")"

# The unit name is DETECTED, not assumed.
#
# A box provisioned before the project was renamed runs `sovereign-waker`, with
# its paired identity in /etc/sovereign-waker/waker.json. Installing a
# differently-named unit beside it does not update anything: it adds a second
# waker with an EMPTY config directory, leaves the original running and paired,
# and the operator is told to `init` and re-pair — at which point the box has two
# wakers and the desktop app is pointed at whichever one answered last.
#
# So: reuse whatever unit is already there, and only fall back to the current
# name on a box that has none.
WAKER_NAME="${WAKER_NAME:-}"
if [ -z "$WAKER_NAME" ]; then
	WAKER_NAME="$(ssh "${SSH_OPTS[@]}" "$TARGET_HOST" '
		for c in puca-waker sovereign-waker; do
			if systemctl cat "$c" >/dev/null 2>&1; then echo "$c"; exit 0; fi
		done
		echo puca-waker' 2>/dev/null | tail -1)"
	WAKER_NAME="${WAKER_NAME:-puca-waker}"
fi
echo "ship-waker: using unit name '$WAKER_NAME' on $TARGET_LABEL"

# Build-once-copy-everywhere is only safe while the build host and the target
# run the same distribution, libc and architecture. This ASSERTS that rather
# than trusting a note somewhere that says it is true.
assert_same_platform() {
	local a b
	a="$(ssh "${SSH_OPTS[@]}" "$BUILD_HOST" 'echo "$(. /etc/os-release; echo $VERSION_ID) $(uname -m) $(ldd --version | head -1 | grep -o "[0-9]\+\.[0-9]\+$")"')"
	b="$(ssh "${SSH_OPTS[@]}" "$TARGET_HOST" 'echo "$(. /etc/os-release; echo $VERSION_ID) $(uname -m) $(ldd --version | head -1 | grep -o "[0-9]\+\.[0-9]\+$")"')"
	if [ "$a" != "$b" ]; then
		echo "REFUSING: build host and target are not the same platform." >&2
		echo "  build : $a" >&2
		echo "  target: $b" >&2
		echo "A binary built on one will not reliably run on the other." >&2
		exit 1
	fi
	echo "PASS  both hosts are $a"
}

status() {
	# WAKER_NAME is exported into the remote shell, not interpolated into a
	# single-quoted string — inside '...' it would reach the far end as the
	# literal text $WAKER_NAME and every command would silently query nothing.
	ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "WAKER_NAME='$WAKER_NAME' bash -s" <<'REMOTE'
	systemctl is-enabled "$WAKER_NAME" 2>/dev/null | sed "s/^/  enabled: /" || true
	systemctl is-active  "$WAKER_NAME" 2>/dev/null | sed "s/^/  active : /" || true
	journalctl -u "$WAKER_NAME" -n 12 --no-pager 2>/dev/null || true
REMOTE
}

if [ "${1:-}" = "--status" ]; then
	status
	exit 0
fi

echo "=== platform check ==="
assert_same_platform

echo "=== building on $BUILD_LABEL ==="
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TAR=$(mktemp -u /tmp/waker-src-XXXX.tar.gz)
tar -czf "$TAR" -C "$REPO_ROOT/crates" puca-waker
scp "${SSH_OPTS[@]}" "$TAR" "$BUILD_HOST:/tmp/waker-src.tar.gz"
rm -f "$TAR"

ssh "${SSH_OPTS[@]}" "$BUILD_HOST" '
	set -e
	export PATH=$PATH:/root/.cargo/bin
	rm -rf /tmp/waker-build && mkdir -p /tmp/waker-build
	# --no-same-owner: the tar was written on Windows and carries a uid that
	# does not exist here. --touch plus the find below: stale mtimes make cargo
	# "finish" in 0.2s and reuse an OLD binary, which is the single most
	# expensive trap in this repo.
	tar -xzf /tmp/waker-src.tar.gz -C /tmp/waker-build --no-same-owner --touch
	find /tmp/waker-build -exec touch {} +
	cd /tmp/waker-build/puca-waker
	cargo build --release 2>&1 | tail -3
	ls -l target/release/puca-waker
'

echo "=== installing on ${TARGET_LABEL} ==="
ssh "${SSH_OPTS[@]}" "$BUILD_HOST" 'cat /tmp/waker-build/puca-waker/target/release/puca-waker' \
	| ssh "${SSH_OPTS[@]}" "$TARGET_HOST" 'cat > /tmp/puca-waker.new'

scp "${SSH_OPTS[@]}" "$REPO_ROOT/deploy/waker/puca-waker.service" "$TARGET_HOST:/tmp/waker.service.in"

# WAKER_NAME is passed in rather than baked in, and the unit file's own paths are
# rewritten to match it. The shipped unit names /opt/puca-waker; on a box whose
# waker is called something else, installing it verbatim would point systemd at a
# directory this script never wrote.
ssh "${SSH_OPTS[@]}" "$TARGET_HOST" "WAKER_NAME='$WAKER_NAME' bash -s" <<'REMOTE'
set -e
: "${WAKER_NAME:?}"
# A dedicated unprivileged account. The waker needs no privilege at all: a
# subnet broadcast is not a raw socket.
id svrn-waker >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin svrn-waker

install -d -m 0755 "/opt/$WAKER_NAME"
install -d -m 0700 -o svrn-waker -g svrn-waker "/etc/$WAKER_NAME"
install -d -m 0700 -o svrn-waker -g svrn-waker "/var/lib/$WAKER_NAME"

# Stop it before replacing the binary it is executing.
systemctl stop "$WAKER_NAME" 2>/dev/null || true

install -m 0755 /tmp/puca-waker.new "/opt/$WAKER_NAME/$WAKER_NAME"
rm -f /tmp/puca-waker.new

sed -e "s#/opt/puca-waker#/opt/$WAKER_NAME#g" \
    -e "s#/etc/puca-waker#/etc/$WAKER_NAME#g" \
    -e "s#/var/lib/puca-waker#/var/lib/$WAKER_NAME#g" \
    -e "s#/puca-waker run#/$WAKER_NAME run#g" \
    /tmp/waker.service.in > "/etc/systemd/system/$WAKER_NAME.service"
chmod 0644 "/etc/systemd/system/$WAKER_NAME.service"
rm -f /tmp/waker.service.in

# The unit must not name a path that does not exist, which sed silently allows
# if a pattern above ever stops matching.
if grep -q "puca-waker" "/etc/systemd/system/$WAKER_NAME.service" && [ "$WAKER_NAME" != "puca-waker" ]; then
	echo "FATAL: unit still references puca-waker paths after rewriting for $WAKER_NAME" >&2
	grep -n "puca-waker" "/etc/systemd/system/$WAKER_NAME.service" >&2
	exit 1
fi

systemctl daemon-reload
# Restart only if it was already enabled — a fresh install has no identity yet.
if systemctl is-enabled --quiet "$WAKER_NAME" 2>/dev/null; then
	systemctl start "$WAKER_NAME"
	echo "restarted $WAKER_NAME (it was already enabled and paired)"
fi
echo "installed: $(/opt/$WAKER_NAME/$WAKER_NAME 2>&1 | head -1 || true)"
sha256sum "/opt/$WAKER_NAME/$WAKER_NAME"
REMOTE

echo
echo "Binary and unit are installed. NOT started — it has no identity yet."
echo "Next, once only:"
echo "  ssh ${TARGET_HOST} /opt/$WAKER_NAME/$WAKER_NAME init <this-box-lan-ip>"
echo "  # pair it from the desktop app, write /etc/$WAKER_NAME/waker.json"
echo "  ssh ${TARGET_HOST} systemctl enable --now $WAKER_NAME"
