# Large file transfer — hybrid server + peer-to-peer

**Status:** implemented and unit-tested. §10 lists what is still unverified.

**Why it exists:** the server-mediated path caps attachment size, and raising the
cap only moves the wall. Sending large files directly between two clients removes
it, and keeps the bytes off the server entirely — which matters more here than the
size limit does, because the server never becomes a copy of everything anyone
sent.

This document is the design reference for that subsystem; the source cites it by
section (`frontend/src/api/fileTransfer.ts`, `transferSinks.ts`,
`frontend/src-tauri/src/file_transfer.rs`, `src/protocol.rs`).

---

## 1. The decision this document exists to make

"No cap" and "entirely P2P" are each achievable, but they are not free, and the
costs land on the *user experience* rather than on the code. Everything below
follows from four facts:

1. **A peer transfer needs both people online at the same time.** Server-stored
   files are send-and-forget; you upload once, the recipient collects whenever.
   A peer transfer is a live handshake between two running apps. Send a 4 GB
   file to someone whose laptop is shut and *nothing happens* — there is no
   "sent" state to show, only "waiting".
2. **The sender must stay open for the whole transfer.** 4 GB over a domestic
   uplink is 10–25 minutes of the app staying awake. This makes resumability a
   requirement, not a polish item.
3. **"Entirely P2P" cannot be guaranteed.** When both ends sit behind symmetric
   NAT, ICE has no direct path and falls back to TURN — which is coturn on LXC
   109, i.e. the user's own home connection, carrying every byte *in and back
   out*. Silently relaying a 4 GB transfer through the house is the worst
   possible outcome of a feature sold as peer-to-peer.
   Note the flip side: a TURN relay only ever sees DTLS-encrypted packets, so
   relaying costs bandwidth but never confidentiality.
4. **The receiving end differs enormously by platform.** Streaming 4 GB to disk
   is routine in the Tauri desktop app, awkward in a browser, and unreliable on
   a phone whose webview gets suspended when the screen locks.

**Therefore: hybrid.** Keep the server path for everyday files, add a peer path
for large ones, and be honest in the UI about which one is in play.

| | Server path (exists) | Peer path (this plan) |
|---|---|---|
| Size | ≤ 25 MB | effectively uncapped (desktop) |
| Recipient offline | fine | impossible — must be online |
| Sender closes app | fine | transfer dies (resumable) |
| Costs the host | disk + egress | nothing, unless relayed |
| Works on | everything | desktop first; browser limited; mobile poor |
| Chat history | permanent link | expires when both leave |

---

## 2. Transport

`RTCDataChannel` over the existing peer connection machinery. Nothing about the
signalling needs inventing — the WS signalling, perfect negotiation, the connId
rebuild protocol and the ICE/TURN config are all live and battle-tested for
media. There is currently **no** `RTCDataChannel` anywhere in the codebase, so
this is new surface built on proven foundations.

Channel config:

```ts
pc.createDataChannel('file', { ordered: true, maxRetransmits: undefined })
```

Reliable + ordered. Do not be tempted by unordered mode: chunk reassembly then
becomes our problem for no gain, since SCTP already does it well.

**Flow control is the part that goes wrong.** Writing chunks in a loop without
watching `bufferedAmount` will balloon memory and stall the connection. The
correct shape:

```ts
const CHUNK = 16 * 1024;                 // safe across implementations
dc.bufferedAmountLowThreshold = 512 * 1024;
// write until bufferedAmount > 1 MB, then await the 'bufferedamountlow' event
```

Throughput is then bounded by the uplink, which is the honest limit.

---

## 3. Protocol sketch

Control messages ride the existing WS (small, needs to work before any peer
connection exists); bulk bytes ride the data channel.

```
offer    →  {transferId, name, size, mime, sha256, chunkSize}
accept   ←  {transferId, resumeFromByte}      // 0 for a fresh transfer
reject   ←  {transferId, reason}
data     →  [4-byte chunk index][payload]     // on the data channel
progress ←  {transferId, receivedBytes}       // throttled, ~1/s
complete ←  {transferId, sha256}              // receiver's computed digest
cancel   ↔  {transferId}
```

- **Integrity is not optional.** The receiver hashes as it writes and compares
  to the offer's digest. A transfer that survives 20 minutes and lands corrupt
  with no way to tell is worse than one that fails loudly.
- **Resume is by byte offset.** The receiver keeps its partial file and the
  offset; a re-offer with the same `transferId` and `sha256` resumes rather than
  restarts. This is what makes a 4 GB transfer over a domestic link realistic.
- **`transferId` is random per transfer**, not derived from the file, so two
  people sending the same file do not collide.

---

## 4. The relay policy — the one design decision that must not be fudged

Before sending, inspect the selected candidate pair:

```ts
const stats = await pc.getStats();
// look for the succeeded candidate-pair and its local/remote candidateType
```

- **Direct pair (`host` / `srflx` / `prflx`)** → proceed, no cap.
- **Relayed pair (`relay`)** → the bytes would cross the host's home connection
  twice. Do **not** silently proceed with a multi-gigabyte transfer.

Recommended: allow relayed transfers only up to a configurable ceiling
(`P2P_RELAY_MAX_BYTES`, default ~100 MB) and otherwise tell the truth: *"No
direct connection to <user> — a transfer this large would run through the
server. Try again when you're both on better networks, or send a smaller file."*

This is the difference between a feature that quietly costs the host money and
one that behaves as advertised.

---

## 5. Platform matrix — where "no cap" is real

| Target | Receive strategy | Practical ceiling |
|---|---|---|
| **Tauri desktop** | stream chunks straight to a file via the Rust side | genuinely uncapped |
| **Browser (app.example.com)** | File System Access API (`showSaveFilePicker`) + `WritableStream`; needs a user gesture, Chromium-only | uncapped where available, else a few hundred MB in memory |
| **Capacitor mobile** | Filesystem plugin, chunked appends | small only — the webview is suspended in the background, so a long transfer stalls when the screen locks |

**Never buffer a whole file in memory to hand to a Blob.** That is the failure
mode that turns "no cap" into a browser tab crash. Desktop-first is not a
limitation to apologise for; it is where the feature actually works.

---

## 6. Scope: DMs first

A file sent to a channel of eight people is eight concurrent uploads from one
domestic uplink, unless recipients re-seed to each other — which is a torrent,
and a much larger project.

**Ship DM-to-DM first.** Group sending can come later as sequential fan-out with
honest progress ("2 of 8 delivered"), or not at all.

---

## 7. UI

The mental model must be visibly different from an attachment, or people will
expect chat-history semantics and be disappointed:

- An offer appears as a card in the conversation: name, size, **Accept** /
  **Decline**.
- While transferring: progress, rate, time remaining, **Cancel** on both sides.
- On completion: "Saved to …" with a reveal-in-folder action on desktop.
- If the recipient is offline: the composer says so before sending, rather than
  queueing something that will never happen.
- If the transfer would be relayed: say so before starting (see §4).

---

## 8. Staging

1. **Data channel + offer/accept, DM-only, desktop-only, no resume.** Proves the
   plumbing end to end. Cap at something modest while shaking out flow control.
2. **Streaming to disk + integrity + progress/cancel.** This is the first
   genuinely useful version.
3. **Resume by offset**, which makes large transfers survive reality.
4. **Relay policy + the honest refusal path** (§4).
5. **Browser receive** via File System Access, with graceful degradation.
6. *(Optional)* group fan-out.

Steps 1–4 are the feature. 5 is a nice-to-have. 6 may never be worth it.

---

## 9. Risks worth naming up front

- **Flow control** is where data-channel implementations usually go wrong;
  budget real time for `bufferedAmount` backpressure and test on a slow link,
  not on localhost. A localhost test proves almost nothing here.
- **Resume correctness**: appending to the wrong offset silently corrupts a file
  that then passes every UI check and fails only the hash. Test the hash
  mismatch path deliberately.
- **Sender-side teardown**: closing the app, losing the socket, or the recipient
  vanishing mid-transfer must leave no half-written file presented as complete.
- **Mobile suspension** will produce stalled transfers that look like bugs.
  Better to refuse large transfers on mobile than to offer a coin flip.
- **This bypasses the E2EE story deliberately**: DTLS protects the bytes in
  flight, and no server copy exists at all. That is a *stronger* position than
  the attachment path, but it should be stated in the UI rather than assumed.

---

## 10. Implementation status (2026-07-26) — built, NOT deployed

Stages 1–4 are implemented. Stage 5 (browser File System Access) is in as a
fallback; stage 6 (group fan-out) is not attempted and may never be worth it.

| Piece | Where |
|---|---|
| Control plane | `src/protocol.rs`, `src/ws.rs` (`FileOffer`/`Accept`/`Reject`/`Cancel`/`Signal`) |
| Transfer registry + reaper | `src/state.rs`, swept from `main.rs` |
| Byte engine | `frontend/src/api/fileTransfer.ts` |
| Negotiation + relay policy | `frontend/src/api/fileTransferManager.ts` |
| Platform sinks | `frontend/src/api/transferSinks.ts` |
| Desktop disk sink | `frontend/src-tauri/src/file_transfer.rs` |
| UI | `frontend/src/components/FileTransfers.tsx` |

**Authorization** turned out to be the design's real constraint, and the plan
missed it: all existing peer signalling is gated on `users_share_room`, and two
people in a DM share no room. Transfers therefore have their own messages,
authorized once by DM eligibility (a conversation exists, neither has blocked
the other) and thereafter against the registered transfer pair — narrower, and
free on the ICE hot path.

### Defects the audit found, all in freshly written code

1. **Unbounded write.** The receiver wrote each chunk before checking the
   declared size, so a peer could send past the end and fill the disk. `total`
   comes from the sender: a claim, not a fact.
2. **Resume with no integrity check.** A resumed transfer's running hash cannot
   cover bytes an earlier attempt wrote, and nothing re-hashed from disk. The
   desktop sink now hashes at rest and the manager compares; a sink that cannot
   verify refuses to resume at all.
3. **Failure promoted a partial file.** Teardown called `sink.close()`, which on
   desktop renames `.part` to the real name — presenting a truncated file as
   complete. Failure now takes an explicit `abort(keep)` path.
4. **Offers dropped when no DM was open.** The manager was wired inside the
   card component, which only mounts in a DM view.
5. **Chunks processed concurrently.** `onmessage` fires far faster than a disk
   write completes, so a second chunk began while the first was still being
   written, read a stale `expectedIndex`, and failed a good transfer as
   `bad-chunk`. Handling is now serialized on a promise chain.

### What is NOT proven

**No file has moved between two machines.** Everything above is unit-verified —
including backpressure against a rate-limited fake channel, and the filename
sanitizer against real traversal strings — but the live path (two apps, real
ICE, a real relay decision, a real multi-gigabyte file) has never run. That is
the next step and it needs a second person.

Known gaps, deliberately left:

- Completed and cancelled cards are never pruned from the list; they accumulate
  for the session.
- The relay check runs once when sending starts. ICE can re-route to a relay
  mid-transfer and that is not re-checked.
- The browser File System Access sink cannot resume (we cannot know what a
  freshly picked file already contains), so it always starts from zero.
- Mobile receives via the capped in-memory sink (100 MB) — the old "refuses
  to receive at all, by design" is long stale; see transferSinks.ts.
