#!/usr/bin/env bash
# Every-5-min health check: restarts the service if down or HTTP-hung; logs issues.
#
# Names are resolved, not hardcoded — monitoring the wrong service name is worse
# than no monitoring, because it reports nothing while the real service is down.
# See names.sh.
. "$(dirname "$0")/names.sh"
ops_require_install healthcheck

LOG=$INSTALL_DIR/health.log
ts(){ date '+%F %T'; }
restart=0
if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "$(ts) service inactive -> restart" >> "$LOG"; restart=1
elif ! curl -sf -o /dev/null --max-time 5 http://127.0.0.1:3000/; then
  echo "$(ts) HTTP check failed (service up) -> restart" >> "$LOG"; restart=1
fi
if [ "$restart" = "1" ]; then
  systemctl restart "$SERVICE_NAME"
  logger -t "$SERVICE_NAME-health" "$SERVICE_NAME unhealthy; restarted"
fi
sudo -u postgres pg_isready -q || echo "$(ts) postgres not ready" >> "$LOG"

# The LAN waker (home box only; the unit simply doesn't exist elsewhere, and
# `systemctl is-enabled` distinguishes that from a broken one). Two failure
# shapes, learned 2026-08-17 the expensive way:
#
#  - INACTIVE/FAILED: restart it, same policy as the backend.
#  - ACTIVE BUT CRASH-LOOPING: `is-active` reads "activating"/"active" between
#    5s deaths, so activity alone said nothing while seccomp (SIGSYS) killed
#    506 processes in 44 minutes and Wake was silently down the whole time.
#    NRestarts climbing is the loop's fingerprint; log it LOUDLY. Do not
#    reset-failed — the counter is the evidence.
#
# Detection only writes health.log + syslog, matching this file's style; the
# fix is never automated because a crash-loop, by definition, survives
# restarting.
if systemctl is-enabled --quiet "$SERVICE_NAME-waker" 2>/dev/null; then
  if ! systemctl is-active --quiet "$SERVICE_NAME-waker"; then
    echo "$(ts) $SERVICE_NAME-waker inactive -> restart" >> "$LOG"
    systemctl restart "$SERVICE_NAME-waker"
    logger -t "$SERVICE_NAME-health" "$SERVICE_NAME-waker unhealthy; restarted"
  fi
  # Alarm on the counter INCREASING since the last check — a live loop raises
  # it every 5s, so every 5-min check fires; a historical, already-recovered
  # restart logs exactly once and then stays quiet. (`systemctl restart` by a
  # human resets the counter, which also resets this.)
  WAKER_RESTARTS=$(systemctl show "$SERVICE_NAME-waker" -p NRestarts --value 2>/dev/null)
  WAKER_STATE=$INSTALL_DIR/.waker-nrestarts.last
  WAKER_PREV=$(cat "$WAKER_STATE" 2>/dev/null || echo 0)
  if [ "${WAKER_RESTARTS:-0}" -gt "${WAKER_PREV:-0}" ] 2>/dev/null; then
    echo "$(ts) $SERVICE_NAME-waker RESTARTED BY SYSTEMD (NRestarts $WAKER_PREV -> $WAKER_RESTARTS) — if this line repeats, it is crash-looping and Wake is down; check: journalctl -u $SERVICE_NAME-waker | grep -E 'SYS|panic'" >> "$LOG"
    logger -t "$SERVICE_NAME-health" "$SERVICE_NAME-waker restarted by systemd (NRestarts=$WAKER_RESTARTS); repeated lines = crash loop, Wake down"
  fi
  echo "${WAKER_RESTARTS:-0}" > "$WAKER_STATE"
fi

# Origin firewall MUST stay active: while Cloudflare is the only public ingress,
# the ufw default-deny is what stops the origin IP being hit directly (bypassing
# CF + forging CF-Connecting-IP). ufw in this LXC once read back inactive after a
# first `--force enable`, and a reboot could leave it down — so re-assert it.
# `ufw --force enable` is idempotent; rules persist, so this only flips it back on.
if command -v ufw >/dev/null 2>&1; then
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "$(ts) ufw INACTIVE -> re-enabling (origin was directly reachable)" >> "$LOG"
    ufw --force enable >/dev/null 2>&1
    logger -t "$SERVICE_NAME-health" "ufw was inactive; re-enabled origin firewall"
  fi
fi
