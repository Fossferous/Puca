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
   # This host's own node, for the server API: removals and the room resync
   # (see "Kick/ban mid-call" below). Without it there is no resync.
   LIVEKIT_API_URL=http://127.0.0.1:7880
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
- **Kick/ban mid-call:** LiveKit authorizes only at token mint (20-min TTL),
  so the backend ejects server-side with `RoomService.RemoveParticipant`
  (`evict_user_from_channel` in `src/sfu.rs`, a 5 s timeout per call):
  - a kick, ban, leave, role or permission-overwrite change runs the perms
    sweep (`evict_sweep` in `src/ws.rs`), which removes every member who no
    longer has VIEW and CONNECT on an SFU channel. The remaining clients see
    the participant leave and re-key the call epoch at once;
  - a voice move cuts that user's SFU session, and changing a channel's
    transport (`sfu_mode`, either way) puts everyone in its room out to
    rejoin on the new one;
  - a REJOIN with a token minted earlier is caught by the `participant_joined`
    webhook, which re-runs the mint-time permission check and evicts again.

  What it can eject is what it knows: token mints, webhooks, and a resync
  from LiveKit's RoomService (`ListRooms` + `ListParticipants`) at startup and
  every `SFU_RESYNC_SECS` (180 s) - so a participant already in a call when
  the backend restarts is known, and ejectable, as soon as LiveKit answers.
  What it adds goes through the same join check the `participant_joined`
  webhook runs - acting only on what the database answers (not a member, no
  VIEW_CHANNEL/CONNECT, not an SFU channel), never on a failed lookup - so a
  kick, ban or permission change that happened while a session was unknown
  (during the read, or while the backend was down) still removes it, with one
  `SFU resync: removing user N from sfu channel C (<reason>)` line each. A
  removal LiveKit does not confirm, or a check the database cannot answer,
  stays known (counted, and reachable by any kick) and is marked for the next
  pass, which cuts or checks it again; with `SFU_RESYNC_SECS=0` the resync
  keeps going at the 30 s retry pace until nothing is owed. A voice
  move or transport change requested during the read is applied to the
  sessions the read added. It also clears a session whose `participant_left`
  webhook was lost.
  The sweep, and a switch OUT of `sfu_mode`, also reach sessions whose Púca
  socket never rejoined.

  **The resync runs only with `LIVEKIT_API_URL` set** - to this host's node,
  `http://127.0.0.1:7880`. Without it, removals use the public `LIVEKIT_URL`,
  which on a standby host reaches the live node rather than its own, and
  mirroring that node's rooms would be wrong; the server says so once at
  startup (`SFU resync is off: ...`). With it: one
  `SFU resync: LiveKit has N room(s) ...` line at startup, and
  `SFU resync: cannot read LiveKit's rooms (...)` once per outage. LiveKit
  itself logs each server-API call at INFO (`API RoomService.ListRooms`, and
  one `ListParticipants` per `sfu_<channel>` room), so every resync adds
  1 + (sfu rooms) lines to `journalctl -u livekit`, plus one per removal.

  In the log: a sweep writes `SFU perms eviction: user N removed ...` only
  when LiveKit confirmed every session, and `... NOT removed ... LiveKit
  confirmed X of Y sessions` otherwise. The webhook path writes `SFU join re-auth: evicting user N ...`
  before it tries. Each failed call writes `SFU evict <identity>:` with
  LiveKit's status or the transport error and its cause.
- **Remote control / voice status rely on the Puca WS room** — SFU
  clients still JoinRoom `voice_<id>`; only Offer/Answer/ICE stopped being
  used on the SFU path.
