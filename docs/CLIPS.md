# Clips — the replay buffer, and the consent gate in front of it

Clips are a desktop replay buffer: the app keeps the last few minutes of a
voice call in memory, sealed, and a clip is posted to the channel only after
**every participant** has approved it. The owner's per-server switch is the
only gate (off until the owner turns it on; members of a server with clips
off see nothing), and `GET /clips/usage` reports the retention the operator
configured (`CLIP_RETENTION_DAYS`) so Settings › Clips can say how long a
posted clip lives. Spike measurements:
`frontend/e2e/spike-clips/README.md`; the build history is at the end of
this page.

**When the clipper may see the footage (2026-08-19, twice revised — read
this, not your memory of the previous rule).** Nobody — not the clipper, not
an approver — decodes a single frame before every call participant has
approved. Between sealing and approval the composer shows metadata only
(duration, resolution, size). An earlier build (≤0.8.99) let the clipper
preview before requesting approval; 0.8.100 removed all preview; the current
build restores it STRICTLY after approval: once the server says approved, the
composer plays a preview (worker-side MSE `MediaSourceHandle`, never a Blob)
and offers a **trim**, then the clipper posts. Trim can only narrow the
window that was already approved — it removes footage, never adds any
outside what approvers were told — so it needs no new consent.
`frontend/src/tests/clipNoPreview.test.ts` pins that the composer's `<video>`
and `attachPreview()` live only inside the `approved` render branch, and that
the only transitions into `approved` are the server's word.

## The one-sentence promise

While you are in a voice channel on desktop, Púca can keep the last few
minutes of your screen + system audio + your mic in an **encrypted, in-memory**
ring; you can save a clip of it; and it will only ever be posted after
**everyone who was in the call during that window** approves. Nothing is
uploaded before that, and nothing is written to disk at any point.

## Where it runs

| surface | can record | can approve | can watch |
|---|---|---|---|
| Windows desktop (Tauri / WebView2) | yes | yes | yes |
| Android (Capacitor) | no — no `MediaProjection` plumbing, by design | yes (Phase 2) | yes (Phase 2) |
| browser (app.example.com) | no | yes (Phase 2) | yes (Phase 2) |

Capture is one of TWO pipelines feeding the same worker/ring: a manual or
prompted arm uses WebView/WebCodecs (`frontend/src/api/clips/`, getDisplayMedia
picker); the **auto** arm uses the native crates `puca-capture`/`-encode`
— now linked into the app itself (`src-tauri/src/clip_capture.rs`), not just
the agent sidecar — with WASAPI loopback for audio (`clip_desktop_audio.rs`)
and a keyframe forced every 2 s (the agent's own use of those crates keeps
its infinite GOP; the clip path does not). See "Arm automatically" below.

## How the buffer works (`frontend/src/api/clips/`)

- **Arm** — manually: a click (`getDisplayMedia` needs the gesture; the
  picker's "Also share system audio" toggle is OFF by default in WebView2, on
  the "Entire Screen" tab; if you forget it, the pill says so and offers
  *Pick again*). Or automatically on joining a call, with NO click and NO
  picker — the native path under "Arm automatically" below.
- The video track and a mixed audio track (system audio → gain, plus a
  `MediaStreamAudioSourceNode` over the **current processed mic track** — so
  your mute is respected and a noise-mode swap re-taps via
  `onMicTrackSwapped`) feed `MediaStreamTrackProcessor`s whose readables are
  transferred to a Worker.
- The Worker encodes with WebCodecs (H.264 hardware, forced keyframe every
  2 s; AAC or Opus) and keeps **GOP units**. Every closed unit is AES-256-GCM
  ciphertext under a key created `extractable: false` — its material never
  exists in the JS heap. Eviction is by seconds AND bytes (Settings › Clips).
- **Clip** seals the last D seconds: units are decrypted, muxed by mediabunny
  into fragmented MP4, split into an **init part + moof-aligned ≤24 MiB
  parts**, each sealed under a fresh clip key bound to the clip id and part
  index (`clipCrypto.ts`). The sealed bytes never leave the Worker before
  approval — the composer shows only metadata (duration, resolution, size)
  until the server says everyone approved; then a worker-side MSE preview and
  a trim (a RE-MUX of the kept range into a fresh fMP4 whose timeline starts
  at 0, re-sealed under fresh indices — `clipTrim.ts`) precede the upload.
  The press does NOT close the open unit (2026-09-21): the seal muxes a
  zero-filled-after-use COPY of it, and the unit keeps growing until its
  own next keyframe. Closing it cost the native path everything up to the
  agent's next timed keyframe (up to 2 s, video and audio) in every later
  clip spanning the press, because only the picker path can force one.
  The seal reads a list of units snapshotted at the press, and eviction
  waits while any seal runs, so GOPs closing mid-mux can neither enter
  the clip nor pull (and zero-fill) a unit out from under it.
- **Discard / disarm / leave / channel switch / suspend / lock / quit** zero
  the buffers and drop the key (table below).

## What is guaranteed (mechanically checked)

- No file-writing or persistent-storage API is reachable from `api/clips/**`
  (`src/tests/clipNoDiskWrite.test.ts` greps for it; the spike scanned the
  WebView2 profile for clip-sized files and found only Chromium caches).
- The ring is ciphertext under a non-extractable key; plaintext exists only in
  flight (the open GOP, a seal's copy of it, the seal's transient mux
  buffers) and is zero-filled.
- Nothing is uploaded until every required approver has said yes (Phase 2:
  the server refuses `kind=clip` bytes for an unapproved proposal BEFORE it
  reads the body). The server never sees a frame; the clip key rides in the
  E2EE message body — the same trust model as `sovereign-enc:` attachments.
- **Nobody watches the footage before every participant has approved — not
  even the clipper.** The worker's `preview`/`trim` messages exist, but the
  composer only sends them from its `approved` phase, and the only transitions
  into that phase are the server's word (a solo proposal returned already
  approved, or the bus reporting `approved`). `clipNoPreview.test.ts` pins
  both facts and is positive-controlled: a `<video>` in any pre-approval
  branch, or a pending→upload shortcut that skips `approved`, goes red.
  Between seal and approval the composer is metadata only.
- **Trim can only shrink an approved clip.** The worker decrypts the sealed
  clip, RE-MUXES the kept range from its packets (no re-encode — the same
  AVC/AAC access units) into a fresh fragmented MP4 whose timeline starts at
  0, and seals the new parts under **fresh clip secrets** (new key + nonce
  prefix — clipCrypto derives a part's nonce from (prefix, index) and the
  re-mux re-uses indices 0..m, so re-sealing under the old key would repeat
  AES-GCM nonces; the manifest carries whichever key the posted parts were
  sealed with). The cut points snap OUTWARD to the nearest keyframes (one
  GOP ≈ 2 s), so the user never loses footage they asked to keep and the
  result is never wider than the approved clip (its only input); audio starts
  at the first whole AAC frame inside the cut (≤ 21 ms late — a straddling
  frame is dropped, not clamped, which would have written it ~1 ms long).
  `clipTrim.ts trimSealedParts` is the whole algorithm outside the worker;
  `clipTrimRemux.test.ts` runs it against the real mediabunny muxer and real
  WebCrypto on a multi-GOP file and proves: a FRONT trim's output starts at
  t=0 (fragments carry absolute `tfdt` — a positive control shows the
  demuxer reports them — so merely relisting the later parts of the original
  would have stalled every player at 0 s); every new nonce differs from
  every old one and the new parts reject under the old key; a failure
  mid-way leaves every old wire byte-identical AND (positive control) leaves
  the ORIGINAL untouched under `retireOriginal: false` too, still openable
  at its original indices under its original secrets.
  `e2e/clip-worker-headless.mjs` plays a front-trimmed clip from the real
  worker bundle, undoes it, and asserts the restored clip plays too — the
  worker-protocol proof `clipTrimRemux.test.ts` alone cannot give, since the
  undo bookkeeping (`undoPoint`) lives in replayWorker.ts, not clipTrim.ts.

- **Undo restores exactly one trim — cutting too much used to be
  unrecoverable, now it is not.** Applying a trim used to zero-fill the
  pre-trim ciphertext and key the moment the new parts were sealed
  (`trimSealedParts`'s `retireOriginal` argument, always `true` before this),
  so a cut deeper than intended had no way back short of a fresh approval
  round — and if the call had ended, not even that. The worker now decides
  whether to retire: `retireOriginal: false` leaves the pre-trim `parts` and
  `secrets` completely untouched (decrypting never mutates them — WebCrypto's
  `decrypt` always returns a fresh buffer — so "don't zero it" is the whole
  mechanism, no copy needed) and keeps them as `undoPoint`, a single extra
  `SealedClip` the worker holds alongside the current one. `t:'undoTrim'`
  swaps `sealed` back to it — O(1), a pointer swap, not a re-mux — and
  retires whatever was current (it was never uploaded: undo is only reachable
  from the composer's pre-Post `approved`-phase trim UI). A SECOND trim
  retires the existing undo point before installing a new one, so this is
  one level, not a history: undoing twice does not reach further back than
  the immediately-prior state. `undoPoint` is zero-filled the moment it can
  no longer be reached — a newer trim, an undo, or a discard — so at most
  two `SealedClip`s are ever resident (current + one undo step), bounded the
  same way a single trim already is (`TRIM_MAX_CIPHER_BYTES`): steady-state
  memory while an undo point exists can reach ~2× the clip instead of ~1×,
  on top of the ring. If a partial upload's parts get server-side-deleted
  because the clip they belonged to is about to become the undo point (a
  retry-then-trim sequence), that undo point's `uploadedIds` are cleared too
  — otherwise undoing back to it and retrying the upload would believe parts
  the server just deleted were still there, and post a manifest with dead
  part ids. `SealedInfo.canUndo` is computed once, at the single call site
  that turns `sealed` into an outgoing message (`postSealed` in
  replayWorker.ts), so it can never drift from whichever operation
  (seal/trim/undo) most recently ran. `trim` and `undoTrim` mutually exclude
  each other and drain against `discardSeal`/`wipe` via a shared `reshapeRun`
  promise (the same pattern `previewRun`/`uploadRun` already use) — decrypting
  a part has no per-part cancellation check the way `preview()`'s loop does,
  so an unguarded `wipe` (reachable outside any UI gate — Chromium's "Stop
  sharing" control, a system suspend) landing mid-decrypt would zero-fill the
  exact ciphertext array a trim/undo is still reading, surfacing a raw
  AES-GCM error instead of a clean "discarded" outcome.
- **A posted clip can be downloaded by anyone who can see the message.**
  Once posted, every required approver already agreed to release it; the
  Download button (`ClipAttachment`) fetches + decrypts every part and
  concatenates them — the same bytes that were sealed (the muxer's output for
  an untrimmed clip, the re-mux's output for a trimmed one), not a re-encode
  (`downloadClipBytes`, tested round-trip). It is refused for the same
  reason Play is: a manifest whose parts are not a subset of what was
  actually approved — and above 1 GiB (`CLIP_DOWNLOAD_MAX_BYTES`), because
  the download is built whole in the renderer's memory. On desktop it is
  written through the native `attachment_save` command (a bare `<a
  download>` is not honoured in the Tauri webview); on the web it is a
  transient anchor.

## What is NOT guaranteed — read this

- **Pagefile / hibernation / crash dumps / GPU memory** can hold plaintext
  transiently (JavaScript cannot `VirtualLock`). Hibernation writes all of RAM
  to `hiberfil.sys` — which is why **system suspend or session lock disarms
  and wipes** (`src-tauri/src/session_events.rs`).
- `Uint8Array.fill(0)` is best effort: V8 may already have copied a small
  buffer. The ring is stored as few large per-GOP buffers for that reason.
- The WebView2 "… is sharing your screen" bar is hidden while armed **in the
  getDisplayMedia (manual/prompt) path**, exactly as it is for screen share
  (`api/captureBar.ts`). For a **native (`auto`)** arm there was never a bar
  to hide — DXGI Desktop Duplication has no OS-drawn indicator of any kind,
  the same reason it's what the unattended remote-desktop agent uses. That is
  a UX choice either way, not a protection: it only ever informed the
  clipper's own machine. The **roster badge** (a `ClipIcon` next to your
  name, sent on arm/disarm and on every status re-assert) is what reaches the
  people whose voices are being recorded — and it is **advisory**: a
  cooperating client asserts it; a modified client can omit it. Only room
  members see it (bystanders in the sidebar don't; do not "fix" that by
  widening the fan-out). `armNative()` fires it as soon as native capture
  actually starts (not once a codec is parsed from the stream — see the
  settings section below), so this is the ONLY on-screen cue at all for a
  native arm; there is no equivalent of Chromium's own picker/consent step.
- **Native (`auto`) capture always rings the WHOLE monitor**, chosen
  automatically (see below) with no per-arm confirmation of which one and no
  window/tab scoping — the picker's ability to share a single window/tab is
  gone in this mode. The target is chosen ONCE, ~800 ms after joining, and
  never re-evaluated for the life of the session.
- **A modified client can do anything.** This is a consent feature, not DRM.
  Nothing stops anyone from running OBS.
- **Deafened means no voices in the clip**: deafened audio is never rendered,
  so it never reaches the system loopback.
- **No revocation** of a key already delivered (Phase 2): deleting the message
  deletes the server-side parts, but anyone who saw the message may have kept
  the video.
- Watching a clip caches plaintext on the **viewer's** device like any
  attachment (MSE buffers; the small-clip Blob fallback).

## Wipe table

| exit | what happens |
|---|---|
| Disarm button | worker zero-fills + exits; tracks stopped; AudioContext closed; capture bar released |
| Leave voice / disconnect | `disarm('leave-voice')` before the room is left |
| Channel switch (incl. VoiceMoved) | the panel remounts → `disarm('channel-switch')` — the ring must not span two rooms' rosters |
| Chromium "Stop sharing" (manual/prompt arm only) | `disarm('capture-ended')` + notice |
| Native VIDEO capture error (`clip_capture.rs` mid-session) | `disarm('capture-error')` + notice; an encoder that never produces a usable H.264 sequence header fails outright after 5 consecutive SPS-less keyframes rather than hanging silently |
| Native desktop-AUDIO error (`clip_desktop_audio.rs` mid-session) | notice only — the session stays armed and continues mic-only (deliberate: matches the manual arm's no-system-audio behaviour; the ring is not wiped for an audio device hiccup) |
| Page/webview reload or navigation (native arm only) | `pagehide`/`beforeunload`'s `bail()` also calls `session.nativeStop` (best effort, not awaited) — otherwise the Rust-side DXGI/WASAPI threads would keep running with no session to stop them |
| System suspend / session lock | `disarm('system-suspend')` + notice |
| Window close to tray | **stays armed** (that is what a replay buffer is for; the roster badge keeps it visible) |
| App quit | `pagehide`/`beforeunload` terminate the worker |
| Composer Discard / Escape / Cancel | sealed parts zeroed; the ring keeps running |
| Someone declines / request expires / Cancel request | the protocol module's discard handoff zeroes the sealed clip exactly once (`setClipDiscardHandler` → `discardSeal`); nothing was uploaded |
| Leave voice / channel switch while a request is pending | the request is WITHDRAWN (`DELETE /clips/:id`, approvers see `closed`) before the wipe — a sealed clip does not survive leaving the room |
| Post fails after the upload | the uploaded parts are deleted server-side (`discardSeal({token, baseUrl})` → `DELETE /files/:id` per part) and the seal is zeroed |
| Upload fails | the seal is KEPT until the proposal's TTL; "Try again" re-sends only the missing parts |
| Posted | the sealed copy is zeroed; the ring keeps running |

## Settings (Voice & Video › Clips)

Quality preset (its resolution cap applies only to manual/prompt arms — see
below), buffer length, memory limit (slider max derived from the machine's
memory budget so the ring clamp can never reject it), mic level in clips,
"When I join a voice call" — `clipArmOnJoin`: *Do nothing* / *Remind me to
arm* (highlights the Arm button for ~12 s) / **Arm automatically**, and the
**Save clip** hotkey (works from a fullscreen game via the native hook).
Arming is gated only by the server owner's per-server clips switch — there
is no client-side experimental toggle (`settingsClips.test.ts` pins its
absence).

**Arm automatically genuinely has no popup** (SHIPPED in 0.8.108, hotfixed in
0.8.109 — the force-keyframe fix, without which a native clip could not be
packaged at all; the on-device walk at the end of this section is still
outstanding): it calls
`armNative()`, which drives DXGI Desktop Duplication + the MFT hardware
H.264 encoder directly (`frontend/src-tauri/src/clip_capture.rs`) — the exact
same no-gesture, no-picker primitive the unattended remote-desktop agent
uses, not a variant of `getDisplayMedia` (which can never be made
picker-free — Chromium always draws the source dialog). System audio is
classic WASAPI loopback (`clip_desktop_audio.rs`, a separate module/event
name from the per-app "game audio" capture so a live screen share using that
feature is unaffected). Mic capture is unchanged (`getUserMedia` already
needs no picker).

- **Target selection** (`clip_capture.rs::choose_target`, pure + unit
  tested): whichever monitor the foreground window is CHROMELESS on (no
  title bar, no resize border — this excludes an ordinary **maximized**
  window, which still has both and whose rect can exceed the monitor's own
  by its invisible resize border) AND covering ≥95% of that monitor's area;
  otherwise the primary monitor. Chosen once, ~800 ms after joining, never
  re-evaluated.
- **Bitrate is scaled** to the captured monitor's actual resolution relative
  to the quality preset's assumed one (clamped 1.5–20 Mbps) — native capture
  always runs at the monitor's NATIVE resolution, never scaled down to the
  preset's max width/height the way a manual/prompt arm is.
- **The bitstream is Annex-B**, unconverted — mediabunny (the muxer) derives
  the AVCDecoderConfigurationRecord from the SPS/PPS in the first keyframe it
  is given, the same way it already handles a WebCodecs `annexb` stream. A
  Windows H.264 MFT is not guaranteed to repeat the sequence header before
  every IDR, so `ParamSetCache` caches the first SPS/PPS seen and prepends
  them to any later keyframe missing its own — otherwise a `seal()`/`trim()`
  primed from a LATER keyframe could throw an opaque mediabunny error.
- **The pointer on repeated frames (2026-09-21).** DXGI reports a
  pointer-only change as a frame with `LastPresentTime == 0`, which
  `next_frame` answers as `Timeout`; the loops then re-send the stored
  frame, whose pointer was drawn at the last present, so over a still
  window it froze and jumped at the next present. Both loops now call
  `puca_clip_wire::refresh_repeat`, which calls
  `ScreenCapture::redraw_cursor` and bumps `picture` only when that
  changed the pixels, so the NV12 is converted again exactly then.
  `redraw_cursor` is a save-under (puca-capture `CursorOverlay`): the
  pixels under the pointer are kept at each present, put back, and the
  pointer drawn at its new spot; restore before save, never
  undo-by-redraw. Cost: the pointer's rectangle (4 KB at 32x32), and one
  conversion per slot while the pointer moves over a still screen. The
  remote-control stream never calls it, so a pointer-only update still
  sends nothing there.
- **A/V anchoring (2026-09-21).** The video timestamps count from the
  capture loop's own start (never 0 at the first chunk); the AudioData
  timestamps are on another clock entirely (~30 h at the first sample).
  Until then the worker rebased audio against its own time origin, so
  audio in every native clip was LATE by the agent's start-up time plus
  the picker path's 40 ms. Now the worker estimates each clock's origin
  in its own time as the running MIN of (arrival - ts): video stamped
  when onmessage receives a chunk (never when a parked chunk is drained),
  audio when the pump reads a sample. Audio entries stay on the audio
  clock and `seal()` applies one shift per clip, so a later, tighter
  estimate cannot make a clip's audio go backwards (mediabunny throws on
  that). The native offset is 0 (`NATIVE_AUDIO_OFFSET_US`); the 40 ms is
  the picker's. Residual, not corrected and not visible to the anchor:
  the desktop-audio leg's own latency (WASAPI buffer, IPC, the loopback
  AudioContext's scheduling lead, ~50 ms and drifting up to 500 ms before
  it re-primes), minus the video stamp's lag behind the present (it is
  taken after acquire and readback). Only an end-to-end sync test (flash
  plus click) can calibrate that. `clip-video-chunk` carries the capture
  generation (as `clip-audio-data` does) and `startNativeVideo` drops any
  other capture's chunks, so the old capture's tail after "Restart
  buffer" never reaches the new ring; as a backstop, a video timestamp
  going BACKWARDS is treated as another capture's clock and restarts the
  estimate. Silent field check: once both clocks have
  5 s of samples, puca.log gets `[stream-diag] clip-av video-origin=..
  shift=.. legacy-late=..` (again if the shift moves 10 ms), where
  `legacy-late` is how much later the old code placed the audio.
- **Indicator**: `armNative()` fires the roster "buffering" badge, the
  local status pill AND the tray tooltip ("Púca — clip buffer armed
  (recording your fullscreen app / primary monitor)",
  `set_clip_armed_indicator`, composed with the device-session tooltip so
  neither clobbers the other) as soon as native capture actually starts —
  capture and encoding are already running by then, and behind a fullscreen
  game the tray is the only indicator that survives. It deliberately does NOT wait for
  the worker to parse a codec string out of the first real chunk (which can
  take a moment, or — if the encoder never produces a keyframe with a usable
  SPS at all — never happen; `clip_capture.rs` now fails the capture outright
  after 5 such keyframes, and a 10 s watchdog in `armNative()` disarms with
  an error as a second line of defence, rather than a session sitting
  "armed" forever with nothing seal-able).
- **ONE attempt per room**: a failure falls back to the *Remind me* nudge and
  does not retry in the same room; a manual disarm stays disarmed; a
  VoiceMoved (new room id) tries again, because the buffer must never span
  two rooms' rosters. `clipAutoArm.test.tsx`; the pre-0.8.106 checkbox
  `clipArmPromptOnJoin: true` loads as *Remind me*.
- **The frame rate is capped (2026-09-19).** Until then neither native loop
  (the agent's `clip_host.rs`, the app's in-process fallback) capped
  anything: `fps` set only the longest wait for a frame, and a frame arrives
  on every present. Measured on the agent host itself (2560x1440 @ 165 Hz,
  NVENC, `--fps 30 --bitrate 8000000`, a stream playing on that screen): the
  shipped loop encoded **63-78 fps at 15-21 Mbit/s for 81-95% of one core**.
  The bitrate follows the frame count because the encoder's sample clock
  advances 1/fps per submitted frame. With `FramePacer`
  (`crates/puca-clip-wire/src/pacer.rs`, shared by both loops): **29.9-30.0
  fps, 7.1-7.2 Mbit/s, 36-39% of one core**, frame gaps p5 31 / p95 35 /
  max 37 ms. (A first version that polled once per slot measured 29-29.6
  fps, 6-7 Mbit/s and 33-36%, with gaps out to 104 ms: it re-sent more
  stored frames, which are cheap, and caught fewer new ones.) Each slot waits
  up to half a period for a new picture rather than polling once, so content
  at exactly the asked-for rate is captured once per frame instead of
  alternating duplicates and drops (`pacer.rs` explains why).
- **Per-frame cost, profiled (2026-09-21).** Thread-cycle counters around each
  stage of the capped loop, on the same screen, found 8.1-9.4 ms of CPU per
  slot on a mostly still screen (11-29% of slots a new picture):
  the BGRA→NV12 convert ~3.8-4 ms (on EVERY slot, including a still screen's
  re-send of the same picture), a 4 ms spin waiting for the encoder's output
  (~4 ms), the readback copy into a freshly allocated 14.7 MB buffer
  (~1.7 ms per new picture), and the sample build (~0.6 ms). Four
  changes, each byte-for-byte or behaviour-identical: a repeated picture
  reuses its NV12 (`encode_bgra_picture`); the clip loops poll the encoder
  by sleeping ~1 ms instead of spinning (`set_patient_output`; the
  remote-control stream keeps its spin); an AVX2 kernel does the convert
  (~1.4 ms, identical to the scalar loops, which remain the fallback); and
  the readback reuses the previous frame's buffer (`ScreenCapture::recycle`,
  ~0.6 ms). Result with every slot a new picture: **~3.3 ms of loop CPU per
  slot; the whole host process 13.5-13.7% of one core at 30 fps, against
  35-37% for the capped loop alone in the same conditions.** What remains:
  the convert, the sample copy, the readback, and the encoder itself. The
  next step down would be converting on the GPU, which also cuts what is
  read back to 37.5% (NV12 is 1.5 bytes a pixel against BGRA's 4).
- **Superseded bench (2026-08-20, `bench_clip_capture_encode_pacing` in
  `crates/puca-encode/tests/live_encode.rs`)**: ~8 ms per frame, "~50 fps",
  "cannot hold 60 fps at 1440p", "~24% of a core at 30 fps". It timed
  `encode_bgra` alone (no readback) on the uncapped loop, so treat those
  figures as history, not as the cost of the current loop. Follow-up if the
  per-frame cost matters: convert on the GPU (the MFT's VideoProcessor)
  instead of on the CPU. Relevant to the 2026-08-19 field report "puca was
  making games choppy"; whether native is lighter in-game is the A/B below.
- **NEEDS an on-device Windows walk** before this is trusted in the field: a
  real fullscreen game picked correctly over the primary monitor, WASAPI
  desktop-audio loopback actually capturing game + voice audio, a screen
  share using `api/appAudio.ts`'s per-app capture staying unaffected while
  the clip buffer is separately armed, the tray tooltip appearing/clearing
  on arm/disarm, and **game frame-pacing A/B: the same game with the buffer
  armed via the WebCodecs path vs the native path vs disarmed** (the field
  report above is the reason). The agent's `clip_host.rs` loop has been
  measured on real hardware for frame rate, bitrate and CPU (2026-09-19,
  above: a desktop showing a stream, not a game). Everything else in this
  list is still unwalked, and so is the app's in-process Lite loop
  (`clip_capture.rs`). The evidence for those is unit tests (pure logic,
  including `pacer.rs`), a headless-browser e2e that stands in a real
  WebCodecs Annex-B stream for the Rust encoder's output, and the superseded
  encode bench.

## Phase 2 — the consent protocol

**Backend (2a).** `src/clip_handlers.rs`, presence log in `src/state.rs`
(`PresenceLog`, keyed on room MEMBERSHIP, survives room deletion via
`orphan_presence_logs`), migrations `050_clips.sql` / `051_backfill_create_clips.sql`,
`CREATE_CLIPS = 1<<26` (on for @everyone), consent gate in
`upload_handlers::upload_file` (runs BEFORE the file body is read) and the
stamp in `message_handlers::send_message`. Frames: `ClipProposed` (doorbell),
`ClipPending` (content-free, parked for the delivery socket), `ClipVoteUpdate`
(proposer only), `ClipResolved` (proposer sees the real outcome; approvers only
`approved` | `closed`); the live `ChatMessage` frame carries `clip_consent` for
a clip post (absent otherwise).

**Client (2b).** `frontend/src/api/clips/clipProposals.ts` is the protocol/state
bus (doorbell → `GET /clips/:id` → prompt; votes; reconcile via
`GET /clips/pending` on every reconnect; a 5 s local expiry that is confirmed
by a re-fetch, never decided alone; the discard handoff that wipes the sealed
clip exactly once on any non-approved outcome). `ClipApprovalPrompt` (App.tsx,
z 2090, phones full-screen with Decline thumb-nearest; Decline owns focus;
Escape declines; expiry never approves; oldest first with a "1 of N" chip and a
400 ms hold-off; an APPROVED resolution auto-closes after ~1.4 s, the other
outcomes keep their Close). `ClipComposerModal` runs request → pending →
approved (preview + optional trim) → upload → post: `duration_ms` is the
SEALED length, `ended_ago_ms` counts from the seal, `declared_participants`
is everyone this client saw in the room whose presence OVERLAPS the clip's
window — `api/clips/clipParticipants.ts` keeps join/leave spans per user
while armed, mirroring the server's `PresenceLog`, and declares against
`[sealedAt − duration − 2 s, sealedAt]` with a 2-minute slack after a
departure and an SFU still-audible override (the server can only ADD
approvers from it, so the window bound has to be applied here: before
2026-09-02 this was a set that only grew from the arm, which with auto-arm
made everyone who had been in the call since you joined a required
approver, and an offline one blocked the clip for its whole 30-minute TTL —
2026-09-02). Each `ApproverView` now carries `in_window`: whether the
SERVER's log saw that person in the window, or they are required only
because this client declared them; the composer and the approver's own
prompt show it, `propose_clip` logs identity-free counts of each, and
`__pucaClipDiag()` dumps the spans and the live proposal (in memory only —
nothing about who was in which call is ever written down); the target is a
text channel of the VOICE server (pinned,
or a picker defaulting to the viewed channel); trim snaps outward to the
nearest keyframes (~2 s GOPs), Apply re-muxes and the preview re-attaches to
the new footage, and the readout then states the real new length (or that
nothing was cut); the final approval resets the server's deadline to the
15-minute upload grace (`CLIP_UPLOAD_GRACE`), which the composer re-reads
(`refreshOutgoingDeadline`) and shows as "Post within N min" — past it Post
is disabled and the clip must be discarded; the upload uses
the proposal id as its `clip_id`; the post carries `clip_id` and renders the
server's `clip_consent`. `ClipAttachment` plays a posted clip in place (MSE,
decrypted in the viewer's browser) and offers Download (the original bytes,
any viewer — see "guaranteed"), and shows the badge only when the manifest's
parts are a SUBSET of the stamped ids — mismatch refuses playback AND
download, no stamp = no badge. Copy Text / Quote scrub
the whole clip payload (the key is inside it). Owner switch: Server Settings ›
Overview › Clips. Android: a content-free "Approval needed" notification for a
backgrounded phone (`PushFrames.java`), a BLOCKED proposer's request still
shows (`PushGate.java`), and tapping it focuses the prompt (`nav clip:<id>`).
Rust pins the Java and TS copy to identical strings.

Walk: `node e2e/clips-mobile-walk.mjs <outdir> [baseURL]` drives
`e2e/clips-mobile.html` at 390×844 (fixtures + stubbed network): tap targets,
Decline bottom-most and focused, no overflow, badge/refusal per stamp, no
`<a href="sovereign-clip…">` anywhere. Look at the shots.

Server-side in-memory presence log per voice room; `POST /channels/:v/clips`
computes the approver set as UNION(server log, client-declared) − clipper;
approvers are prompted on any online device; a decline discards; all-approved
lets the client upload parts and post a message whose `clip_consent` the server
stamps with a **count and part ids only** (never identities). Votes are
anonymous on the wire; clip messages cannot be edited; deleting one deletes its
parts. Full design in the plan file.

Operator knobs (env, all optional): `CLIP_MAX_USER_BYTES` (per-user clip
storage, default 2 GiB — separate from the 512 MB attachment bucket),
`CLIP_RETENTION_DAYS` (0 = keep posted clips, the default; the ONLY timer here
that deletes user data), `CLIP_SWEEP_INTERVAL_SECS` (orphan/retention sweep,
default 3600), `CLIP_PROPOSAL_TTL_SECS` (default 1800; the e2e runs at 6).
Check free disk on both hosts before enabling clips in a server: 2 GiB/user is
real.

**Live proof:** `frontend/e2e/clip-consent-live.mjs` — 131 checks against a
throwaway Postgres (header of the file has the exact recipe). It found what
the 30 Rust unit tests could not: two queries naming the `channels` column
`channel_type` (the schema says `type`), which made EVERY proposal a 404 and
pinning a channel impossible; and the approver view reporting the padded
window as the clip length. Run it after any change to the handlers.

---

## Development history (not product documentation)

The status record the feature was built under, kept for whoever maintains it:

**Status (2026-08-20): Phases 1 + 2 built — desktop capture and seal (originally behind a
Settings › Advanced toggle, removed in Phase 3), the server presence log +
approval protocol (live-tested, 131 checks), and the client half: the approval
prompt on every device, the request → pending → upload → post composer flow,
the posted-clip player with its consent badge, the owner's per-server switch.
The native no-picker auto-arm SHIPPED in 0.8.108/0.8.109 (see "Arm
automatically" below) and still needs its on-device Windows walk.
Phase 3 landed 2026-09-02: the experimental flag is gone (the owner's
per-server switch is the only gate; members of a server with clips off see
nothing, the owner sees the disabled control with the reason), and
retention is surfaced — `GET /clips/usage` reports `retention_days` from
`CLIP_RETENTION_DAYS` and Settings › Clips says how long posted clips live.
Off per server until the owner turns it on.** spike numbers: `frontend/e2e/spike-clips/README.md`.

## Manual verifications (record date + machine here)

| what | how | last |
|---|---|---|
| system audio track from the WebView2 picker | real shell, toggle ON | 2026-08-18, desktop (spike S1) |
| hardware encoder engaged | encode call ≈0.02 ms/frame, keyframes 2 s | 2026-08-18 (spike S2, headless Edge) |
| A/V sync | flash/beep pairing, −42 ms → `AUDIO_OFFSET_US = 40_000` | 2026-08-18 (spike S4) |
| native A/V anchor's clock assumptions | `e2e/clip-audio-clock-headless.mjs` (muted, never connected to an output): AudioData clock vs worker `performance.now` drift 0.0 ms over 60 s, median 1.4 ms above the min; AAC encoder output ts = input ts, decoded content 5-11 ms later than its ts (varies by run) | 2026-09-21, headless Edge on the owner's desktop |
| native A/V sync end to end, EMULATED | `e2e/clip-av-emulation.mjs` (muted headless Edge): the real armNative -> nativeCapture -> worker -> seal -> upload against an emulated Rust side delivering a real H.264 flash stream and 10 ms WASAPI-shaped PCM on one clock; the sealed clip is decrypted, demuxed and decoded; a second flash+burst 300 ms apart in the same clip is the oracle's control (seen as 300.0 ms) | 2026-09-21: audio 106 and 215 ms LATE in two runs (JS side alone; the modelled Rust side adds ~15 ms); the spread is the loopback AudioContext's scheduling lead (`nativeCapture.ts` JITTER_S priming, up to MAX_BACKLOG_S), which the anchor cannot see |
| native A/V sync end to end, REAL | flash + click through the real app (the only way to add the real WASAPI and DXGI latencies to the number above) | — |
| pointer moves on repeated native frames | old vs new agent side by side on the same screen and mouse | 2026-09-21: NOT exercised: the screen presented every slot (754 new pictures, 0 repeats in 30 s); needs a genuinely still screen |
| 10-min ring memory plateau | ~500 MB renderer working set, flat through eviction | 2026-08-18 (spike S6) |
| no clip-sized files in the profile | profile scan | 2026-08-18 (spike S9) |
| Android WebView plays the sealed MP4 | on-device | — (Phase 2) |
| decline ⇒ private bytes drop | Task Manager | — |
| lock the session while armed ⇒ disarmed | real shell | — |
