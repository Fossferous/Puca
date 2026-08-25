# Tier 2 — Self-hosted E2EE SFU for concurrent multi-streaming

Design doc, 2026-07-24. Goal: let 6+ people watch each other's video/screen-shares
concurrently (parity with mainstream video-chat apps), **without the server ever being able to read the
media** (E2EE preserved), on the existing self-hosted infrastructure.

Grounded in: parallel research on LiveKit vs mediasoup + a read of Púca's
current media crypto (`frontend/src/api/rtc/mediaCrypto.ts` — pairwise-keyed) and
signaling (`src/ws.rs`, `frontend/src/api/rtc/manager.ts` — full mesh).

---

## TL;DR — the two questions you asked

**"How much does it cost on the server?"** — **CPU/RAM are trivial; bandwidth is
the entire problem.** An SFU *forwards* packets, it does not transcode — and with
E2EE it *cannot* transcode (it only ever sees ciphertext). So a single core of the
Beelink handles far more than 6–12 people (mediasoup: ~500 forwarded streams/core;
LiveKit: ~150 video publishers+subscribers/node), and RAM is tens-to-low-hundreds
of MB. **You will run out of home uplink long before CPU.**

**"Would it be reliant solely on my container's broadband?"** — **Yes, and that's
the crux.** Today's mesh *distributes* upload across all 6 homes (each person
uploads their stream 5×). An SFU *concentrates* the entire room's fan-out onto your
one uplink: server egress = `N·(N-1)·bitrate`. The aggregate is identical to the
mesh; the difference is it all funnels through your own upstream instead of six
separate links. **That concentration is the make-or-break constraint** — the whole
design below is about making the server send as little as possible.

**Verdict at your measured 50–100 Mbps upstream:**
- **N=6: yes** — comfortable on 100 Mbps, fine on 50 Mbps *with* the mitigations.
- **N=8: yes with mitigations always** — comfortable on 100, ragged edge on 50.
- **N=10–12 full grid: no** — out of headroom on any single home uplink, regardless
  of SFU choice. Design for 6–8; treat 10+ as out of scope for home-hosting.

**Recommended SFU: LiveKit.** Not because mediasoup can't do it (it can), but
because for a solo, time-constrained, upload-bound deployment LiveKit *buys* the
exact machinery that decides success — dynacast + simulcast + selective subscription
+ an app-owned E2EE key provider — as a single Apache-2.0 Go binary, instead of you
hand-writing the egress-control layer whose correctness is the whole ballgame.

---

## 1. The bandwidth physics (why this is the only number that matters)

Server upload for an all-publish/all-subscribe room:

| N (people) | Forwarded streams `N·(N-1)` | Naive @1 Mbps | Naive @2.5 Mbps | Naive @5 Mbps |
|---|---|---|---|---|
| 4 | 12 | ~14 Mbps | ~35 Mbps | ~69 Mbps |
| 6 | 30 | ~35 Mbps | ~86 Mbps | ~172 Mbps |
| 8 | 56 | ~64 Mbps | ~161 Mbps | ~322 Mbps |
| 12 | 132 | ~152 Mbps | ~380 Mbps | ~760 Mbps |
*(×1.15 for WebRTC/SRTP overhead included.)*

**Usable budget ≠ line speed.** Deduct ~15% protocol overhead, the shared box
(Postgres + Caddy + coturn + app), and — critically — **bufferbloat headroom**:
saturating a residential uplink spikes queueing latency across the *whole* link and
wrecks real-time media (and everything else in the house) *before* you hit 100% of
the pipe. Rule of thumb: usable media egress ≈ **~30–35 Mbps on a 50 Mbps line,
~60–70 Mbps on a 100 Mbps line.**

**The mitigations buy ~4–8×** off the naive worst case by only ever forwarding the
layer each viewer actually needs:
- **Simulcast** — each publisher sends 3 independent layers (e.g. 2.5M / 0.5M /
  0.15M). The SFU forwards the *right* one per subscriber; never transcodes.
- **Selective subscription** — a grid of small tiles pulls the *low* layer; only the
  active speaker / focused tile pulls *high*. Paged/hidden tiles pull nothing.
- **Dynacast** — the SFU auto-pauses any layer nobody is subscribed to (so if
  everyone's looking at one presenter, the other publishers' high layers stop being
  produced at all).

Mitigated N=8 lands around **~52 Mbps** — comfortable on 100, tight on 50. That's
the target envelope.

---

## 2. Why LiveKit over mediasoup

Both clear the two hard gates: **(a)** true zero-knowledge forwarding that preserves
E2EE (client-side encoded-transform / FrameCryptor, AES-GCM — same *class* as
Púca's existing `mediaCrypto.ts` transform), and **(b)** CPU/RAM-trivial for
6–12 forwarding-only participants. So the SFU choice doesn't decide viability —
bandwidth does. Given that, it's a buy-vs-build call on the bandwidth-survival
machinery:

| | **LiveKit** (recommended) | mediasoup |
|---|---|---|
| Model | Turnkey single Go binary + one YAML | Node.js **library** — you build all signaling |
| License | Apache-2.0 | ISC (both fine) |
| Egress control | **Dynacast built-in** (auto-pause unsubscribed layers) | Consumer `setPreferredLayers`/`pause` built-in; **dynacast-equivalent you build yourself** |
| E2EE key mgmt | `ExternalE2EEKeyProvider` — one shared room key + `ratchetKey()` rotation, **app-owned** | You wire the transform (reuse existing byte-format) |
| Signaling | Own WS+protobuf; use `livekit-client` SDK | Reuse Púca's `src/ws.rs` WS channel |
| NAT/ports | `use_external_ip` STUN discovery, single announced UDP port | `announcedAddress` + `WebRtcServer` single port (slightly simpler) |
| Effort | Days (config + client SDK + key glue + admission control) | Weeks (all of the above **plus** signaling + dynacast controller) |

The decisive point: mediasoup's "reuse the existing transform unchanged" advantage
is smaller than it looks, because **the key rework is required either way** (§3), so
it shrinks to just the frame byte-format. Meanwhile mediasoup makes you *build the
dynacast-equivalent viewport→layer controller yourself* — and that hand-written
controller is exactly the code whose correctness determines whether the home uplink
survives. **Buy that machinery. Choose LiveKit.**

(mediasoup stays the right call only if you specifically want a single unified WS
signaling path and are willing to own the egress controller. For this deployment,
no.)

---

## 3. E2EE architecture — the real engineering work

LiveKit is a zero-knowledge forwarder: media is encrypted on the encoded frame
*before* RTP, so the server routes packets it cannot read. The key is **100%
app-provided** — LiveKit "does not (and cannot) store or transport encryption keys";
clients set it via `ExternalE2EEKeyProvider.setKey()`. So the trust property is
preserved and driven from Púca's own crypto. **But there's a required rework:**

**Current media crypto is PAIRWISE** (`mediaCrypto.ts`: `deriveMediaKey` from the
two participants' identity keys, plus a per-session SDP-ephemeral forward-secrecy
handshake). That's correct for a mesh (each link is a distinct pair) but **wrong for
an SFU**: the SFU forwards *one* ciphertext to N receivers, so all participants must
share **one group key**.

The rework (required for *any* SFU):
1. **Derive a per-room media group key** from Púca's existing **channel group-key**
   system (the same infra that already does channel message keys with rotation via
   the migration-015 DB trigger). Feed it to LiveKit's key provider.
2. **Replace the pairwise ephemeral FS handshake with group-key rotation** — map
   Púca's channel key rotation (on member join/leave) onto the key provider's
   `ratchetKey()` / `onKeyRatcheted()`. A member who leaves loses the next epoch,
   exactly like channel messages today.
3. **Keep the frame transform byte-format** (AES-GCM, IV+tag per frame) — this part
   is close to what `mediaCrypto.ts` already emits.

This is the single most subtle part and should be designed carefully (it touches
forward secrecy semantics), but it reuses a proven pattern already in the codebase.

**One thing to verify with a spike before committing** (medium-confidence in
research): confirm LiveKit's opaque `FrameCryptor` path still does **clean simulcast
layer switching with E2EE ON**. The principle is sound — layer selection reads
*unencrypted* RTP metadata (SSRC/RID, payload descriptor, transport-cc), not the
encrypted payload — and it's the whole premise of SFrame SFUs (Google Meet does it).
But LiveKit's docs don't state it unambiguously, so: stand up a 3-layer simulcast +
dynacast room with E2EE on, confirm layers switch cleanly. ~half a day, do it first.

*(What genuinely breaks under E2EE: server-side recording/egress, transcription, and
AI agents — all need plaintext. Púca wants none of these, so the trade is
entirely favorable.)*

---

## 4. Networking & ops (the home-hosting realities)

- **Public UDP port on the home IP is unavoidable.** The SFU terminates
  ICE/DTLS/SRTP, so it must be reachable on a UDP port (LiveKit can use a single
  announced port). Port-forward it on your router to the SFU host, set
  `use_external_ip: true` so LiveKit STUN-discovers and advertises the public IP in
  ICE candidates. **Misconfiguring this is the #1 cause of "works on LAN, fails for
  remote peers."** The `ufw` origin lock that restricts web to Cloudflare ranges must
  *not* block the SFU's UDP port.
- **Cloudflare cannot cloak it.** CF orange-cloud carries HTTP/WS only; it does not
  proxy arbitrary WebRTC/UDP. So the SFU media endpoint is exposed on the home public
  IP — **but this is the SAME exposure class as the existing coturn** (`turn.example.com`
  is already grey-clouded/DNS-only for exactly this reason). It is not a *new* leak
  category. If media-off-home-IP ever becomes a hard requirement, the only escape is a
  public VPS relay (still E2EE, but then it's no longer "home-hosted" and egress moves
  to the VPS uplink — a real option worth noting).
- **coturn stays, as fallback only.** With a public SFU, most clients connect
  directly via server-reflexive candidates; TURN is needed only for restrictive
  NAT/firewalls (and TURN-over-TLS/443 to punch corporate blocks). Note coturn and the
  SFU **share the same uplink** — a relayed participant is charged twice.
- **Router AQM is mandatory, not optional.** Enable **cake or fq_codel** on the
  router/gateway (or an edge box) so that when the uplink does get busy,
  bufferbloat is controlled and latency stays sane. Without this, a full call degrades
  the whole household's internet. This is arguably the highest-leverage single change.

---

## 5. Bandwidth-survival machinery (make-or-break — build this, not just "an SFU")

The SFU is necessary but not sufficient. The project succeeds or fails on this layer:

1. **Simulcast-mandatory publishing** with deliberate layer bitrates, e.g. **150k /
   500k / 2.5M**. Never publish a single fat layer.
2. **Grid defaults to low/mid; promote only the focus/active-speaker to high.**
   Wire the client's tile visibility + size directly into subscription layer hints
   (this is the dynacast/selective-sub signal). A hidden/paged tile subscribes to
   *nothing*.
3. **Per-room egress admission control** (new, server-side): track projected egress;
   as it nears the budget, first **downgrade layers**, then **refuse new publishers**
   ("this call is at capacity"). This is the safety valve that prevents a saturated
   uplink. Design it in from day one — retrofitting is painful.
4. **Screen-share is special**: high-res/high-motion screen share is the most
   expensive stream. Cap concurrent screen-shares (e.g. ≤2), and treat a screen-share
   as consuming a "high-layer slot" in the admission budget.
5. **Audio-first**: audio is ~50 kbps and always fine; never let video pressure
   starve audio. Prioritize audio in the congestion controller.

---

## 6. Integration plan — coexist behind a feature flag

Do **not** rip out the mesh. LiveKit uses its own signaling (WS+protobuf, JWT auth,
up to 2 PeerConnections/client) — you cannot point the hand-rolled mesh at it, you
use the `livekit-client` SDK for the SFU path. So run **both**:

- **Mesh stays the default** for DMs and small calls (≤4). It's lower-latency (direct
  P2P, no server hop) and needs zero server bandwidth — genuinely better for small N.
- **LiveKit engages when a room opts into SFU mode** (or auto-switches when a voice
  channel crosses ~5 participants). Same voice-channel UX; different transport under
  the hood.
- **Kept**: Púca's identity/key system (feeds the E2EE key provider), the voice
  UI (`VoicePanel`/`StreamStage`), presence, `StreamStarted/Stopped` events.
- **Replaced (SFU path only)**: `manager.ts` mesh peer-building, the
  Offer/Answer/ICE relay in `ws.rs` (LiveKit carries its own), `mediaCrypto.ts`
  pairwise keying → group key provider.
- **New**: a LiveKit token endpoint on the backend (mint per-room JWTs from
  Púca auth), the group-key derivation glue, and the admission-control service.

---

## 7. Phased rollout

1. **Spike (½–1 day):** LiveKit single binary on the backend host, one YAML,
   `use_external_ip`, UDP port forwarded. Prove E2EE ON + 3-layer simulcast + dynacast
   switches layers cleanly. Go/no-go gate for the whole plan.
2. **Group-key rework:** derive per-room media key from channel group keys; wire
   `ExternalE2EEKeyProvider` + `ratchetKey()` to channel key rotation. Unit + 2-client
   test that a departed member can't decode the next epoch.
3. **Backend glue:** LiveKit JWT token endpoint from Púca auth; room lifecycle
   tied to voice channels.
4. **Client SFU path:** `livekit-client` behind a feature flag; `VoicePanel` routes to
   SFU when the room is in SFU mode; simulcast layers + subscription hints from tile
   visibility.
5. **Admission control + AQM:** per-room egress budget + layer downgrade + publisher
   cap; enable cake/fq_codel on the router. **Ship this with, not after, the client
   path.**
6. **Load-test on the real uplink** at N=6 and N=8 (mixed camera + 1 screen-share),
   watch effective egress + bufferbloat. Tune layer bitrates and the budget to your
   measured line.

---

## 8. Risks (ranked)

1. **Bandwidth ceiling + no admission control = #1 project-sinker** (vendor-independent).
   Saturating the uplink triggers household-wide bufferbloat before 100% utilization.
   Mitigation: §5 machinery + router AQM, mandatory from day one.
2. **Pairwise→group key rework is the subtle bit** (§3). Under-scoped if treated as
   "reuse the transform." Forward-secrecy semantics change; design deliberately.
3. **Home-IP exposure for media** is unavoidable (§4) — but same class as existing
   coturn, not a new leak. VPS relay is the only full escape.
4. **Two media stacks to maintain** (mesh + LiveKit) for a solo operator. Keep the SFU
   path strictly opt-in/flagged so the mesh remains default and a fallback.
5. **E2EE×simulcast confidence gap** — close with the §7.1 spike before committing.

---

## Bottom line

Technically very doable, CPU/RAM are a non-issue, and **6-way (your original ask) is
comfortably in reach on your 50–100 Mbps upstream** — *if* the egress machinery
(simulcast + selective subscription + dynacast + admission control) and router AQM
are treated as first-class, not afterthoughts. Pick **LiveKit** to buy that
machinery. Design for **6–8**, hard-cap there, and keep the mesh for small calls. The
project's success is 20% "install an SFU" and 80% "make the server send as little as
possible and never saturate the uplink."

---

## Appendix — build corrections & status (2026-07-24)

A 21-agent adversarial verification of this doc, then implementation, produced
the following **corrections to the text above** (the code follows the corrected
versions; details in the repo):

1. **§3.2 is wrong about `ratchetKey()`** — LiveKit ratcheting is a
   deterministic forward derivation (HKDF, fixed salt): a departed member can
   compute every future ratcheted key, so it can NEVER deliver "a member who
   leaves loses the next epoch." Leaver exclusion requires `setKey()` with
   FRESH material at a new key index — which is exactly what channel-key
   rotation mints. Built accordingly (`EpochKeyProvider` in
   `frontend/src/api/rtc/sfuManager.ts`, key = `deriveSfuMediaKey(CK, channel,
   epoch)`, keyIndex = epoch mod 16).
2. **"Rotation via the migration-015 DB trigger" misstates the mechanism** —
   the trigger only bumps `member_generation` and purges the leaver's wrapped
   keys; rotation is client-driven, LAZY (fires on the next text/task send),
   with no push channel. The SFU path polls epoch state every 30 s and on
   participant churn; an event-driven rekey (WS push + in-call minting) and
   rotation-on-permission-revoke (the migration-033 overwrite path never bumps
   the generation) remain open follow-ups.
3. **"One shared group key" is overstated** — per-sender keys (SFrame RFC 9605)
   also traverse an SFU and preserve sender authentication; the shared-key mode
   (built, v1) lets any member forge frames as another member, and a CK-derived
   key is decryptable by every channel VIEWer, not just call participants.
   Accepted for v1 (matches the message-E2EE trust model); revisit if the
   threat model tightens.
4. **§6's keep/replace list had the events wrong** — `StreamStarted` is a
   voice-presence event whose handler *initiates the mesh* (`callUser`); the
   stream UI is driven by `ScreenShareStarted/Stopped` + `CameraStarted/
   Stopped`. The SFU branch guards the three `callUser` sites and keeps
   everything else, including `JoinRoom` on the Púca WS room (presence,
   voice status, and remote-control relays are gated on `users_share_room`).
5. **E2EE ✕ simulcast ✕ dynacast is CONFIRMED, not medium-confidence** — spike
   ran 2026-07-24 on livekit-server v1.13.4 (Windows, single-UDP-port mux,
   3 clients, canvas media): encrypted 3-layer publish, LOW↔HIGH layer
   switching, dynacast pausing unwatched layers to 0 fps and resuming, and
   3× rapid share start/stop churn — zero decryption errors. VP8 only (LiveKit
   disables VP9/AV1 under E2EE). Remaining platform gate: Capacitor iOS
   WKWebView (needs an on-device run; simulcast+E2EE needs iOS ≥ 17.2).
6. **"~150 pubs+subs/node" is a 16-core GCP benchmark**, not a Beelink
   constant; the CPU-is-trivial conclusion still holds at N=6–8. mediasoup is
   also a first-party **Rust** crate (in-process embed was the road not
   taken), and its BWE/priority/observer primitives narrow the effort gap the
   table implies — the LiveKit recommendation survives both corrections.
7. **Deployment realities at THIS site** (all encoded in `deploy/livekit/`):
   LiveKit's default ICE range 50000–60000 is already router-forwarded to the
   Matrix box → single-port mux on UDP 7882 is mandatory; 3478/5349 are taken
   (Matrix) so the embedded TURN stays off; Púca's coturn `denied-peer-ip`
   includes the site's own public IP, so TURN-fallback-into-the-SFU does NOT
   work as deployed (deliberate follow-up, not an accident); the ufw allow must
   be persistent (healthcheck re-asserts ufw every 5 min); some consumer routers have
   no AQM, so the **node-global egress budget** (default 30 Mbps, shares
   charged at 4.5 Mbps, reservations counted) is the bufferbloat defence — no
   new router required at rarely-8 room sizes.

**Built (branch `feature/sfu-tier2`):** migration 035 (`channels.sfu_mode`) +
flag through PATCH/list/UI toggle; `src/sfu.rs` (VIEW-gated token endpoint with
per-connection identities `u<id>#nonce` — LiveKit evicts same-identity joins,
which would have resurrected the v0.5.60 multi-device kick loop; node-global
egress admission; LiveKit webhook usage tracking); `deriveSfuMediaKey` +
`EpochKeyProvider`; `SfuManager` (fail-closed E2EE, VP8 ladder 150k/500k/2.5M,
4.5 Mbps share cap, share-slot refusal, focus→HIGH/grid→LOW layer policy wired
to StreamStage focus); VoicePanel dual-transport branch; 5–8 tile grids;
deploy artifacts (`deploy/livekit/`) and `.env.example`; live acceptance
`tests/sfu-token-live.mjs` (18/18) + egress-model unit tests.

**Outstanding before prod:** operator steps in `deploy/livekit/README.md`
(binary install, Caddy/DNS, ufw, router forward of UDP 7882 + TCP 7881);
end-to-end 2-account test of the real app against a running LiveKit (channel
keys need real logged-in identities); Capacitor iOS/Android on-device E2EE
check; kick→`RemoveParticipant` ejection glue; event-driven live-call rekey.
