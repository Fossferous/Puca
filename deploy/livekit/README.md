# LiveKit SFU — Tier-2 concurrent multi-streaming

Self-hosted E2EE SFU for voice channels with `sfu_mode` on: 5–8 people
watching each other's cameras/screens concurrently, media routed through the
server **as ciphertext only** (group key derived client-side from the channel
key system — the SFU can never read frames). Design + verified corrections:
`docs/SFU_TIER2_DESIGN.md`.

Spike-verified on livekit-server **v1.13.4**: E2EE ✕ 3-layer simulcast ✕
dynacast layer pause/switch all work together on the single-UDP-port mux.

## Ports

| Port | Proto | What | Exposure |
|---|---|---|---|
| 7880 | TCP | signaling WS | localhost only, behind Caddy → `sfu.<domain>` (Cloudflare orange) |
| 7881 | TCP | ICE/TCP fallback | router-forward → the SFU host + ufw allow |
| 7882 | UDP | ALL media (single-port mux) | router-forward → the SFU host + ufw allow |

The yaml's single-port mux (`udp_port: 7882`) is mandatory: LiveKit's default
is a 50000–60000 range, which is both hard to forward on a home router and
likely to collide with something you already run. Keep 7881/7882 clear of
your coturn ports (3479 + 49180–49220 as shipped) and of any other forward.

## Install

`deploy/migrate/provision.sh` does steps 1–4 (pinned version, account, config
rendered for the host's address model, unit enabled and probed on :7880). By
hand:

```bash
# 1. Binary (pin the spike-verified version; verify the checksum)
mkdir -p /opt/livekit && cd /opt/livekit
curl -LO https://github.com/livekit/livekit/releases/download/v1.13.4/livekit_1.13.4_linux_amd64.tar.gz
curl -LO https://github.com/livekit/livekit/releases/download/v1.13.4/checksums.txt
sha256sum -c --ignore-missing checksums.txt
tar xzf livekit_1.13.4_linux_amd64.tar.gz livekit-server

# 2. Keys + config (template in this directory)
API_KEY="puca-sfu"
API_SECRET="$(openssl rand -hex 32)"
sed -e "s/__LIVEKIT_API_KEY__/$API_KEY/g" -e "s/__LIVEKIT_API_SECRET__/$API_SECRET/g" \
    deploy/livekit/livekit.yaml > /opt/livekit/livekit.yaml
chmod 640 /opt/livekit/livekit.yaml
useradd -r -s /usr/sbin/nologin livekit || true
chown -R livekit:livekit /opt/livekit

# 3. Service
cp deploy/livekit/livekit.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now livekit

# 4. Firewall — PERSISTENT rules (deploy/ops/healthcheck.sh re-asserts
#    "ufw --force enable" every 5 minutes; a temporary allow will be re-locked)
ufw allow 7882/udp comment 'LiveKit SFU media (single-port mux)'
ufw allow 7881/tcp comment 'LiveKit SFU ICE/TCP fallback'
```

Then:

5. **Router:** forward **UDP 7882** and **TCP 7881** to the SFU host's LAN
   address (e.g. `192.168.1.10`) — same procedure as the TURN forwards in
   `deploy/turn/README.md`. Signaling needs no forward (it rides Caddy/443).
6. **Cloudflare DNS:** add `sfu` as a **Proxied (orange)** record to the origin
   (WS is proxyable; this record leaks no IP). Media never uses this hostname —
   ICE candidates carry the raw public IP via `use_external_ip`, which is the
   same exposure class as the existing grey-cloud coturn.
7. **Caddy:** add the site block:

   ```caddy
   sfu.example.com {
       import cloudflare_only   # same origin-lock snippet as chat/app
       reverse_proxy 127.0.0.1:7880
   }
   ```

8. **Backend env** (`/opt/puca/.env`, then `systemctl restart puca`):

   ```bash
   LIVEKIT_URL=wss://sfu.example.com
   LIVEKIT_API_KEY=puca-sfu
   LIVEKIT_API_SECRET=<the same secret as livekit.yaml>
   # Node-global projected-egress ceiling for ALL SFU rooms combined.
   # ~30 on the 50 Mbps uplink profile, ~60 on the 100 Mbps one — leaves
   # bufferbloat headroom (no router AQM at this site) plus room for coturn,
   # Matrix, other remote-access tools and the nightly rclone backups on the same line.
   SFU_EGRESS_BUDGET_MBPS=30
   SFU_ROOM_MAX_PARTICIPANTS=8
   SFU_MAX_SCREEN_SHARES=0   # unset or 0 = unlimited; egress budget governs
   ```

   Unset LIVEKIT_* = SFU tier off; the token endpoint answers 503 and mesh
   channels are unaffected.

## Verify

```bash
systemctl status livekit
curl -s http://127.0.0.1:7880/  # "OK" from livekit-server
# Join token flow (from anywhere with a Puca JWT):
curl -s -H "Authorization: Bearer $JWT" https://chat.example.com/channels/<id>/sfu-token
# Live media check: two browsers, one INSIDE the LAN and one OUTSIDE —
# the outside one proves the router forward, the inside one proves NAT
# hairpinning (consumer routers are frequently flaky at loopback; if the
# in-house client fails, that's the hairpin, not the deploy).
```

## Operational notes

- **Egress budget is the whole ballgame.** The backend refuses joins once
  projected node egress (all rooms, reservations included, shares charged at
  4.5 Mbps) exceeds `SFU_EGRESS_BUDGET_MBPS`. Raise it only after measuring
  the real uplink under load — saturating a residential line bufferbloats the
  entire household (there is no router AQM here by design decision).
- **Measured admission (2026-07):** since stream-watching went opt-in
  (v0.7.3), the worst case over-counts, so admission is hybrid: when the
  projection would refuse, the backend consults REAL egress sampled from
  LiveKit's Prometheus endpoint (`prometheus_port: 6789` in livekit.yaml,
  `SFU_METRICS_URL` env, sampled every 10s) and admits if measured egress plus
  the worst-case cost of not-yet-measured seats fits the budget. Sampler down
  or stale ⇒ worst-case-only, i.e. the pre-2026-07 behaviour. Verify with
  `curl -s http://127.0.0.1:6789/metrics | grep packet_bytes | head`.
- **Version pinning:** E2EE/FrameCryptor behavior moves between LiveKit minor
  versions. v1.13.4 is spike-verified; retest E2EE+simulcast+dynacast (and the
  rapid share-churn case, client-sdk-js issue #973) before bumping.
- **Healthcheck cron:** deploy/ops/healthcheck.sh supervises the livekit
  unit once it is enabled — restarts it when inactive, reports a crash loop,
  and probes `http://127.0.0.1:7880/` every 5 minutes with a distinct
  "active but not answering" line. It does NOT check that the backend's
  `LIVEKIT_URL` matches a Caddy vhost; `deploy/migrate/verify.sh` does.
- **Kick/ban mid-call (known gap, v1):** LiveKit authorizes at token mint
  (20-min TTL). A user kicked from the server keeps receiving the CURRENT call
  epoch until they disconnect or the key rotates; they cannot rejoin (token
  refetch fails) and cannot read the next epoch. Server-side ejection
  (RoomService.RemoveParticipant on kick events) is a scoped follow-up.
- **Remote control / voice status rely on the Puca WS room** — SFU
  clients still JoinRoom `voice_<id>`; only Offer/Answer/ICE stopped being
  used on the SFU path.
