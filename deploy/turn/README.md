# Self-hosted TURN (coturn)

The media relay for voice/screen share when a direct peer-to-peer connection
fails (symmetric NAT, CGNAT, strict corporate firewalls). **It is the only
relay there is**: the backend ships no third-party fallback, so a deployment
without a TURN server is one where two people on different home networks may
simply never connect. Self-hosting it also means no third party ever carries
user media or sees call IP metadata.

## How it works

- coturn runs on the same host as the backend (or its own), listening on
  **3479** UDP+TCP with relay range **UDP 49180-49220**. Those numbers come
  from [`turnserver.conf`](turnserver.conf) — 3479 rather than the standard
  3478 because the site the template was written for had 3478 taken; keep
  whatever you choose in step with your firewall and `TURN_SERVER`.
- The backend's `GET /ice-config` hands every caller STUN for address
  discovery (your relay's own port when `TURN_SERVER` is set, Google's public
  STUN only when it is not — `STUN_SERVERS` in `.env.example` overrides
  either). Callers presenting a valid JWT additionally get time-limited TURN
  credentials (TURN REST mechanism: username `<expiry>:<user id>`, credential
  `base64(HMAC-SHA1(TURN_SECRET, username))`), valid for **4 hours**.
  Anonymous callers get STUN only, so strangers cannot farm the relay.
- Media relayed through TURN is DTLS-SRTP **plus** Puca's own frame E2EE —
  the relay sees ciphertext only.

## Install (Ubuntu 24.04)

`deploy/migrate/provision.sh` does all of this, including the address-model
detection and the `turnadmin` step. By hand:

```bash
apt install -y coturn
SECRET=$(openssl rand -hex 32)
# Substitute the secret AND the deployment-specific IP placeholders. LAN_IP is
# the address on this host's NIC; PUBLIC_IP is the address the internet sees.
# On a VPS that holds its public IP directly, both are the same address and
# the external-ip line must be REMOVED (a stale one advertises a relay
# address that does not exist). render-turn-conf.sh does exactly that:
bash deploy/migrate/render-turn-conf.sh deploy/turn/turnserver.conf "$PUBLIC_IP" "$LAN_IP" "$SECRET" example.com <uplink-mbps> > /etc/turnserver.conf
# ...it exits non-zero if a placeholder survived or a safety directive was lost.
# CRITICAL: the systemd service runs as user `turnserver`, NOT root. The config
# holds the secret, so it must be group-readable by that user — mode 600 makes
# coturn silently start with NO config (defaults = OPEN RELAY on 3478). Use 640.
chown root:turnserver /etc/turnserver.conf && chmod 640 /etc/turnserver.conf
echo "TURNSERVER_ENABLED=1" > /etc/default/coturn
# REST auth needs the secret in coturn's SQLite turn_secret table AS WELL as
# in the config file (coturn 4.6.1 answers every Allocate with 401 otherwise,
# for a correct credential exactly as for a bogus one):
turnadmin -s "$SECRET" -r example.com -b /var/lib/turn/turndb
systemctl enable coturn && systemctl restart coturn     # restart: the package auto-started it on the stock config
ufw allow 3479/tcp && ufw allow 3479/udp && ufw allow 49180:49220/udp
# backend env (same secret), then restart the backend:
echo "TURN_SERVER=turn:turn.example.com:3479?transport=udp,turn:turn.example.com:3479?transport=tcp" >> /opt/puca/.env
echo "TURN_SECRET=$SECRET" >> /opt/puca/.env
systemctl restart puca
```

Use the relay's **own** hostname in `TURN_SERVER` (`turn.example.com`, a
plain A record): if the API hostname is ever proxied through a CDN it resolves
to the CDN, which cannot carry UDP, and TURN silently never connects.

Verify auth is enforced (not an open relay): a STUN Allocate with **no**
credentials must get `401`, a correct TURN-REST credential must allocate, a
wrong one must be rejected — `deploy/migrate/verify.sh` runs both probes with
`turnutils_uclient`, and the positive one matters: a relay that refuses
*everything* passes a bogus-only test while being simply broken. coturn writes
NO per-request lines to journald and its `/var/tmp/turn_*.log` is hidden by
the service's `PrivateTmp`, so test with a real client rather than trusting
the log. coturn does **not** support inline `# comments` after a directive
value — put comments on their own line.

## Behind a home router

Forward to the host's LAN address:

- UDP 3479 (TURN control) and TCP 3479 (TURN over TCP, the fallback for
  UDP-hostile networks)
- UDP 49180-49220 (relay allocations — the range must match `min-port`/
  `max-port` in the config exactly)

If those ranges collide with forwards you already have (the template's
numbers were chosen around another service's 49152-49172 and 50000-60000),
move them in the config and the router together.

## Security notes

- Credentials are auth-gated and expire after **4 hours**; the user id inside
  the username makes abuse attributable. There is no per-credential
  revocation (inherent to the TURN REST/`use-auth-secret` mechanism) — a
  leaked or post-logout credential stays valid until expiry; rotating
  `TURN_SECRET` (config file, `turnadmin` and `.env`, then restart both)
  invalidates all at once. Quotas bound the blast radius.
- `denied-peer-ip` blocks every private/special range so the relay cannot be
  used to reach the LAN. The site's own public IP is denied as a relay target
  too, so the relay can't be hairpinned back into services port-forwarded on
  that address — legitimate peers relay to each *other's* addresses, never to
  the relay's.
- Quotas cap concurrent allocations (12/user, 40 total — under the 41-port
  relay range) and bandwidth (`max-bps`/`bps-capacity` are BYTES/sec:
  1,250,000 = 10 Mbps/allocation; `bps-capacity` is rendered to 60% of the
  `<uplink-mbps>` you pass — a relay both receives and re-sends, so set it
  below your measured **upload** speed).
- `deploy/ops/healthcheck.sh` restarts coturn if its unit is enabled and
  dies, reports a crash loop, and probes the listening port every 5 minutes.
