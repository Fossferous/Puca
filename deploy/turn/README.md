# Self-hosted TURN (coturn)

Media relay fallback for voice/screen share when direct P2P fails (symmetric
NAT/CGNAT). Self-hosting it means no third-party relay (OpenRelay) ever
carries user media or sees call IP metadata.

## How it works

- coturn runs on the same host as the backend, port **3479**
  (UDP+TCP), relay range **UDP 49180-49220** (3478/5349 belong to another VM
  at this site).
- The backend's `GET /ice-config` mints time-limited TURN credentials
  (TURN REST mechanism: username `<expiry>:<user id>`, credential
  `base64(HMAC-SHA1(TURN_SECRET, username))`) — **only for callers with a
  valid JWT**. Anonymous callers get the legacy public STUN/OpenRelay list.
- Authenticated callers get **self-hosted TURN first** (LAN-local → ICE
  prefers it), then Google STUN, then OpenRelay as a **last-resort fallback**.
  During rollout OpenRelay stays so connectivity never regresses before the
  router forwards are confirmed; media only reaches OpenRelay if BOTH direct
  P2P and self-hosted TURN fail. **Once self-hosted TURN is verified reachable
  end-to-end, drop `open_relay` from the authed branch in
  `get_ice_config` (server_handlers.rs) for fully third-party-free relaying.**

## Install (Ubuntu 24.04)

```bash
apt install -y coturn
SECRET=$(openssl rand -hex 32)
# Substitute the secret AND the deployment-specific IP placeholders. LAN_IP is
# this host's LAN interface; PUBLIC_IP is your WAN/residential IP. The config
# ships with placeholders (never real IPs) so it is safe to commit.
LAN_IP=192.168.x.y
PUBLIC_IP=your.public.ip
sed -e "s/REPLACED_AT_DEPLOY/$SECRET/" \
    -e "s/YOUR_LAN_IP/$LAN_IP/g" \
    -e "s#YOUR_PUBLIC_IP#$PUBLIC_IP#g" \
    turnserver.conf > /etc/turnserver.conf
# Fail loudly if any load-bearing placeholder was left unsubstituted — an
# unresolved listening-ip/external-ip makes coturn refuse to start, and an
# unresolved denied-peer-ip silently drops the hairpin-into-LAN protection.
grep -nE 'YOUR_LAN_IP|YOUR_PUBLIC_IP|REPLACED_AT_DEPLOY' /etc/turnserver.conf \
  && { echo 'ERROR: unsubstituted placeholder in /etc/turnserver.conf'; exit 1; }
# CRITICAL: the systemd service runs as user `turnserver`, NOT root. The config
# holds the secret, so it must be group-readable by that user — mode 600 makes
# coturn silently start with NO config (defaults = OPEN RELAY on 3478). Use 640.
chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf
echo "TURNSERVER_ENABLED=1" > /etc/default/coturn
systemctl enable --now coturn
# backend env (same secret):
echo "TURN_SERVER=turn:chat.example.com:3479?transport=udp,turn:chat.example.com:3479?transport=tcp" >> /opt/puca/.env
echo "TURN_SECRET=$SECRET" >> /opt/puca/.env
systemctl restart puca
```

Verify auth is enforced (not an open relay): a STUN Allocate with **no**
credentials must get `401`, a correct TURN-REST credential must allocate, a
wrong one must be rejected. coturn writes NO per-request lines to journald and
its `/var/tmp/turn_*.log` is hidden by the service's `PrivateTmp` — test with a
real client (`turnutils_uclient`) or a raw Allocate probe instead of trusting
the log. coturn does **not** support inline `# comments` after a directive
value — put comments on their own line.

## Router forwards (site-specific)

- UDP 3479 → <LAN_IP> (TURN control)
- TCP 3479 → <LAN_IP> (TURN over TCP, restrictive-firewall fallback)
- UDP 49180-49220 → <LAN_IP> (relay allocations; chosen to clear the
  existing <OTHER_LAN_HOST> forwards at UDP 49152-49172 and 50000-60000)

## Security notes

- Credentials are auth-gated and expire after 12h; the user id inside the
  username makes abuse attributable. There is no per-credential revocation
  (inherent to the TURN REST/`use-auth-secret` mechanism) — a leaked or
  post-logout credential stays valid until expiry; rotating `TURN_SECRET`
  invalidates all at once. Quotas bound the blast radius.
- `denied-peer-ip` blocks every private/special range so the relay cannot be
  used to reach the LAN. The site's own public IP must remain allowed
  (remote peers target it to reach users behind this NAT).
- Quotas cap concurrent allocations (12/user, 40 total — under the 41-port
  relay range) and bandwidth (`max-bps`/`bps-capacity` are BYTES/sec:
  1,250,000 = 10 Mbps/allocation, 2,500,000 = 20 Mbps aggregate — set
  bps-capacity below your measured UPLOAD speed).
- The site's own public IP is in `denied-peer-ip` so the relay can't be
  hairpinned back into LAN services port-forwarded on that address.
- Media relayed through TURN is DTLS-SRTP **plus** Puca's own frame
  E2EE — the relay sees ciphertext only.
