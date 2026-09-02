#!/usr/bin/env bash
# Every-5-min health check: restarts the service if down or HTTP-hung; detects a
# crash-looping unit; supervises coturn/livekit where they are installed; keeps
# the origin firewall up where one was configured. Logs to <install dir>/health.log.
#
# Names are resolved, not hardcoded — monitoring the wrong service name is worse
# than no monitoring, because it reports nothing while the real service is down.
# See names.sh, which also resolves HEALTH_URL from the deployment's PORT and
# BIND_ADDR for the same reason.
. "$(dirname "$0")/names.sh"
ops_require_install healthcheck

LOG=$INSTALL_DIR/health.log
ts(){ date '+%F %T'; }
note(){ echo "$(ts) $*" >> "$LOG"; }

# --- Crash-loop detector, shared by every unit below ---------------------------
#
# Two failure shapes, learned 2026-08-17 the expensive way on the LAN waker:
#
#  - INACTIVE/FAILED: restart it.
#  - ACTIVE BUT CRASH-LOOPING: `is-active` reads "activating"/"active" between
#    5s deaths, so activity alone said nothing while seccomp (SIGSYS) killed
#    506 processes in 44 minutes and Wake was silently down the whole time.
#    NRestarts climbing is the loop's fingerprint; log it LOUDLY. Do not
#    reset-failed — the counter is the evidence.
#
# The backend has the same mode and it has happened twice: a migration
# checksum mismatch panics at boot (VersionMismatch), and with Restart=on-failure
# / RestartSec=5 systemd never reaches its start-limit, so the unit loops
# forever — "activating" every time this script looks, or "inactive" and
# restarted every 5 minutes with no counter and no escalation. One function,
# called for every unit, so the two cannot drift again.
#
# Alarm on the counter INCREASING since the last check — a live loop raises it
# every 5s, so every 5-min check fires; a historical, already-recovered restart
# logs exactly once and then stays quiet. (`systemctl restart` by a human
# resets the counter, which also resets this — the first run after a manual
# restart sees 0 and stays silent; that is expected, not a fixed loop.)
#
# Detection only writes health.log + syslog; the fix is never automated,
# because a crash loop, by definition, survives restarting.
#
#   check_restart_loop <unit> <state-file> <what is down while it loops>
check_restart_loop() {
	local unit="$1" state="$2" consequence="$3" now prev
	now=$(systemctl show "$unit" -p NRestarts --value 2>/dev/null)
	prev=$(cat "$state" 2>/dev/null || echo 0)
	if [ "${now:-0}" -gt "${prev:-0}" ] 2>/dev/null; then
		note "$unit RESTARTED BY SYSTEMD (NRestarts $prev -> $now) — if this line repeats, it is crash-looping and $consequence; check: journalctl -u $unit | grep -E 'VersionMismatch|panic|SIGSYS'"
		logger -t "$SERVICE_NAME-health" "$unit restarted by systemd (NRestarts=$now); repeated lines = crash loop, $consequence"
	fi
	echo "${now:-0}" > "$state" 2>/dev/null || true
}

# --- The backend ----------------------------------------------------------------
#
# A probe that has NEVER succeeded on this host is a configuration error, not
# an outage: the port or bind address in .env does not match what is probed.
# Restarting on it would drop every WebSocket, voice session and upload every
# five minutes, forever, on a service that is perfectly healthy. So the first
# success is remembered, and until it has happened once a failure is reported
# as FATAL config rather than acted on.
HEALTH_OK_MARK=$INSTALL_DIR/.health-http-ok
restart=0
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
	note "service inactive -> restart"; restart=1
elif ! curl -sf -o /dev/null --max-time 5 "$HEALTH_URL"; then
	if [ -f "$HEALTH_OK_MARK" ]; then
		note "HTTP check failed (service up) -> restart"; restart=1
	else
		note "FATAL HTTP probe at $HEALTH_URL has NEVER succeeded on this host — check PORT/BIND_ADDR in $INSTALL_DIR/.env, or set HEALTH_URL in /etc/default/puca to the listener; NOT restarting a service over a probe that may be misconfigured"
		logger -t "$SERVICE_NAME-health" "FATAL: HTTP probe $HEALTH_URL has never succeeded; check PORT/BIND_ADDR or HEALTH_URL; not restarting"
	fi
else
	[ -f "$HEALTH_OK_MARK" ] || : > "$HEALTH_OK_MARK" 2>/dev/null || true
fi
if [ "$restart" = "1" ]; then
	systemctl restart "$SERVICE_NAME"
	logger -t "$SERVICE_NAME-health" "$SERVICE_NAME unhealthy; restarted"
fi
check_restart_loop "$SERVICE_NAME" "$INSTALL_DIR/.$SERVICE_NAME-nrestarts.last" "the API is down"

sudo -u postgres pg_isready -q || note "postgres not ready"

# --- Optional units: present-or-absent is decided by `is-enabled` ----------------
#
# `is-enabled` is the discriminator, NOT the binary existing: a mesh-only host
# with coturn installed but never enabled must stay green, and a deployment
# without the SFU tier has no livekit unit at all. Gating on the binary is the
# mistake the ufw block below used to make.
#
#   supervise_optional_unit <unit> <what is down while it is>
supervise_optional_unit() {
	local unit="$1" consequence="$2"
	systemctl is-enabled --quiet "$unit" 2>/dev/null || return 0
	if ! systemctl is-active --quiet "$unit"; then
		note "$unit inactive -> restart"
		systemctl restart "$unit"
		logger -t "$SERVICE_NAME-health" "$unit unhealthy; restarted"
	fi
	check_restart_loop "$unit" "$INSTALL_DIR/.$unit-nrestarts.last" "$consequence"
}

# The LAN waker (home box only; the unit simply doesn't exist elsewhere).
# Its state file keeps the name it has always had, so the counter survives
# this refactor without a spurious first-run alarm.
if systemctl is-enabled --quiet "$SERVICE_NAME-waker" 2>/dev/null; then
	if ! systemctl is-active --quiet "$SERVICE_NAME-waker"; then
		note "$SERVICE_NAME-waker inactive -> restart"
		systemctl restart "$SERVICE_NAME-waker"
		logger -t "$SERVICE_NAME-health" "$SERVICE_NAME-waker unhealthy; restarted"
	fi
	check_restart_loop "$SERVICE_NAME-waker" "$INSTALL_DIR/.waker-nrestarts.last" "Wake is down"
fi

# coturn and LiveKit. The backend hands out relay credentials and SFU join
# tokens purely from .env — it never checks either is alive — so "voice
# stopped working" had no server-side signal at all: the box reported healthy,
# the API reported healthy, and there was nothing to look at.
supervise_optional_unit coturn  "relayed calls (peers behind symmetric NAT/CGNAT) cannot connect"
supervise_optional_unit livekit "SFU voice channels cannot be joined"

# One cheap liveness probe each, only when the unit is enabled AND active, so
# "active but not answering" gets its own distinct line: that is a config
# problem (wrong port, unreadable config file), not something a restart fixes.
# Ports come from the units' own config files, not this script.
if systemctl is-enabled --quiet livekit 2>/dev/null && systemctl is-active --quiet livekit; then
	lk_port="$(sed -n 's/^port:[[:space:]]*\([0-9]*\).*/\1/p' /opt/livekit/livekit.yaml 2>/dev/null | head -1)"
	LIVEKIT_PROBE_URL="${LIVEKIT_PROBE_URL:-http://127.0.0.1:${lk_port:-7880}/}"
	if ! curl -sf -o /dev/null --max-time 3 "$LIVEKIT_PROBE_URL"; then
		note "livekit unit is active but $LIVEKIT_PROBE_URL does not answer — reachable unit, unreachable endpoint; check port: in /opt/livekit/livekit.yaml (or set LIVEKIT_PROBE_URL in /etc/default/puca)"
		logger -t "$SERVICE_NAME-health" "livekit active but $LIVEKIT_PROBE_URL unreachable"
	fi
fi
if systemctl is-enabled --quiet coturn 2>/dev/null && systemctl is-active --quiet coturn; then
	turn_port="$(sed -n 's/^listening-port=\([0-9]*\).*/\1/p' /etc/turnserver.conf 2>/dev/null | head -1)"
	COTURN_PROBE_PORT="${COTURN_PROBE_PORT:-${turn_port:-3478}}"
	# coturn answers TCP on listening-port as well as UDP (unless no-tcp), so a
	# plain connect is a real "is anything listening" test with no dependency.
	if ! timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$COTURN_PROBE_PORT" 2>/dev/null; then
		note "coturn unit is active but nothing listens on 127.0.0.1:$COTURN_PROBE_PORT — reachable unit, unreachable endpoint; check listening-port in /etc/turnserver.conf and that coturn can READ it (a 600 root-owned file starts coturn with defaults, on 3478, as an open relay)"
		logger -t "$SERVICE_NAME-health" "coturn active but port $COTURN_PROBE_PORT not listening"
	fi
fi

# --- Origin firewall --------------------------------------------------------------
#
# Where the origin is locked to a CDN (Cloudflare), the ufw default-deny is what
# stops the origin IP being hit directly (bypassing the CDN + forging
# CF-Connecting-IP). ufw once read back inactive after a first `--force enable`,
# and a reboot could leave it down — so it is re-asserted here.
#
# ONLY where it was configured for THIS deployment. ufw ships installed-and-
# inactive on stock Ubuntu Server, so "the binary exists" is true on every box
# — and `ufw --force enable` on a host with NO allow rules applies deny(incoming)
# to everything: the operator's current SSH session survives (ESTABLISHED is
# accepted), this script's own loopback probes keep passing, and every new SSH
# connection and all inbound 443 are dropped. The service goes dark with one
# line in a log file on a box that can no longer be reached. That was the
# behaviour for any host built from the guides rather than provision.sh.
#
# Evidence of a rule set is an allow for SSH in `ufw show added` (which reads
# the persisted rules whether or not ufw is active). Hosts provision.sh built
# have `ufw allow 22/tcp` and keep the re-assert; a host that never had rules
# gets a WARN and is left alone. OPS_MANAGE_UFW in /etc/default/puca overrides:
# 1 forces the re-assert, 0 disables it.
if command -v ufw >/dev/null 2>&1 && [ "${OPS_MANAGE_UFW:-}" != "0" ]; then
	if ! ufw status 2>/dev/null | grep -q "Status: active"; then
		if [ "${OPS_MANAGE_UFW:-}" = "1" ] \
			|| ufw show added 2>/dev/null | grep -E '^ufw (allow|limit) ' | grep -qiE '(^|[[:space:]])(22(/tcp)?|ssh|openssh)([[:space:]]|$)'; then
			note "ufw INACTIVE -> re-enabling (origin was directly reachable)"
			ufw --force enable >/dev/null 2>&1
			logger -t "$SERVICE_NAME-health" "ufw was inactive; re-enabled origin firewall"
		else
			note "WARN ufw is installed but inactive and has no allow rule for SSH — it was never configured for this deployment; NOT enabling (that would deny 22 and 443). Add rules first (deploy/migrate/provision.sh step [6/7] lists them) or set OPS_MANAGE_UFW=1 in /etc/default/puca to force it"
		fi
	fi
fi
