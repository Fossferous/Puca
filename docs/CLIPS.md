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
- **The ring is sized to the call's server.** Both arm paths take the voice
  server's `clip_max_seconds` and keep at most that plus one 2 s keyframe
  interval (`ringSecondsFor`), whatever the buffer-length setting says: the
  composer never seals more than the cap and the server refuses more, so
  older footage could only cost memory. A repick keeps the cap it was armed
  under; an owner who RAISES the cap mid-call gets the longer buffer on the
  next arm, not the current one.
- **Clip** seals the last D seconds: units are decrypted, muxed by mediabunny
  into fragmented MP4, split into an **init part + moof-aligned ≤24 MiB
  parts**, each sealed under a fresh clip key bound to the clip id and part
  index (`clipCrypto.ts`). The first four media parts are SMALL on purpose
  (`PART_RAMP_FRAGMENTS`: 1, 2, 4 and 8 two-second fragments, then the
  24 MiB budget): a part is one AES-GCM unit, so a viewer can play nothing
  until all of the first one has arrived, and a full 24 MiB first part made
  a phone wait 6-26 s for a 2-minute clip's first frame (measured
  2026-10-04; ~1 s with the ramp at 50 Mbit/s). Each ramp part is twice as
  long as the one before, so it only arrives in time on a link of at least
  twice the clip's bitrate; on a slower one the player holds the start until
  the throughput it measures says the first ~40 s will not stall (the
  start-up gate, `startBytesNeeded` in `clipPlayback.ts`), never longer than
  one full 24 MiB part takes (a clip that IS cut flat has a first part up to
  one 2 s fragment under that, so on such a link it can also wait for up to
  one fragment of its second part — ~0.8 MB at 1440p — and the stall that
  follows anyway is that much shorter). Measured on a 12 Mbit/s link with a
  1440p clip (8.9 Mbit/s): starting on part 1 alone froze at 0:02, 0:06,
  0:14 and 0:30; gated, it starts after ~8.4 s and plays straight through
  (the same footage cut flat: 16.7 s). A clip the ramp would push
  past 64 parts is re-cut flat (`fitPartCount`), so the ramp never stops a
  clip from posting; a trim keeps the ramp too. The sealed bytes never leave the Worker before
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
  **A native seal waits for the sound under the press (2026-10-05).**
  Native audio reaches the worker a lead after it happened: the loopback
  context renders every sample that long after its capture, and the mic
  leg is delayed to match. So at the press the worker holds the picture up
  to its last frame and the sound only up to about a lead before it, and a
  clip sealed at once ended about a lead short of sound — ~0.15 s since
  the batched desktop-audio wire below raised the lead from ~60 ms. Under
  `e2e/clip-av-emulation.mjs` (2026-10-05) a seal that did not wait ended
  the sound 174-214 ms before the picture; with the wait, 0.2-19.8 ms after
  it (two sessions of four runs). The real app's figure is not measured.
  `seal()` now notes where the picture ends at the press, waits until the
  sound handed to the encoder reaches that point (with half a frame to
  spare), or at most the current lead plus 100 ms (never over 1.2 s) if it
  never does, flushes the audio encoder, and only then takes the snapshot,
  capped at the press: frames that arrived meanwhile and sound placed past
  the press stay out, and a unit opened meanwhile (a keyframe arrived)
  gives the clip only its sound, which is filed by arrival. Eviction waits
  from the press. The picker path does not wait. The half frame of spare
  is placeAudio's: it keeps an entry at its predecessor's offset until its
  target moves half a frame, so after a re-prime with a slightly smaller
  lead the placed sound sits up to that much earlier than the lead says.
  If another capture's clock arrives during the wait (restartNativeClock,
  which drops the open unit), the seal fails with "the capture restarted
  while the clip was being made" rather than muxing the new capture's first
  frames as the clip. Pinned by `clipRingNative.test.ts` ("a clip's sound
  runs right up to the press", six cases, each shown red without its part
  of the fix) and by `e2e/clip-av-emulation.mjs`'s per-run end check.
- **Discard / disarm / leave / channel switch / suspend / lock / quit** zero
  the buffers and drop the key (table below).

## What is guaranteed (mechanically checked)

- No file-writing or persistent-storage API is reachable from `api/clips/**`
  (`src/tests/clipNoDiskWrite.test.ts` greps for it; the spike scanned the
  WebView2 profile for clip-sized files and found only Chromium caches).
- The ring is ciphertext under a non-extractable key; plaintext exists only in
  flight (the open GOP, a seal's copy of it, the seal's transient mux
  buffers) and is zero-filled.
- **A native capture never outlives its session by more than two minutes.**
  Nothing on screen admits to a native capture except the session's own
  status and the roster badge, so one that outlived its session (a stop
  whose invoke failed, a raced teardown) would run unseen until the next
  page start's `reset_capture_state`. `replayBuffer.reapOrphanNativeCapture`
  asks the shell once a minute (`clip_capture_status`: the running video and
  audio GENERATIONS, `null` for none or stopping); with no session it stops
  what it saw, by generation, on the SECOND consecutive identical sighting
  (`disarm()` drops the session before its native stop lands, so one
  sighting may be a teardown in flight), and logs a `[stream-diag] clips:
  stopped a native capture …` line to puca.log. It never touches a capture
  while a session exists, including one armed during its status call.
  `clipOrphanReaper.test.ts` pins all of it, each guard positive-controlled.
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
  concatenates them — the same media bytes that were sealed (the muxer's output for
  an untrimmed clip, the re-mux's output for a trimmed one), not a re-encode
  (`downloadClipBytes`, tested round-trip), with the container fix below
  added (everywhere but an older APK's fallback path). It is refused for the same
  reason Play is: a manifest whose parts are not a subset of what was
  actually approved — and above 1 GiB (`CLIP_DOWNLOAD_MAX_BYTES`), because
  on desktop and the web the download is built whole in the renderer's
  memory. The cap also applies to the streamed Android download
  (`forEachClipPart`), although nothing there would need it. On desktop it is written through the native `attachment_save`
  command (a bare `<a download>` is not honoured in the Tauri webview); on
  the web it is a transient anchor. Desktop and web save the clip with the
  same duration and seek index the Android save adds, as the same bytes
  (`api/clips/fmp4SaveFix.ts`; *On desktop and the web* below).

- **In the Android app the download is NATIVE** (an APK from 0.9.834 on;
  `api/nativeDownloads.ts` → `SovereignDownloadsPlugin.java` →
  `NativeDownloads.java`). The page hands Java the part ids, the clip key,
  nonce prefix and clip id, its bearer and the API base it talks to; the
  phone fetches every part itself from `<API base>/files/<id>`, opens it
  (`DownloadCrypto.java`, byte-exact with `openPart`: the same header,
  nonce and AAD checks, proved against vectors the real `sealPart` wrote —
  `android/app/src/test/resources/download-vectors.json`, checked from both
  sides by `downloadVectors.test.ts` and `DownloadVectorsTest.java`) and
  streams it into **`Movies/Puca/puca-clip-<id>.mp4`** through MediaStore
  (`IS_PENDING` while it is written; a second save of the same clip becomes
  `puca-clip-<id> (1).mp4`). No byte of the clip crosses the WebView bridge.
  Memory is two reused buffers of one part each (~25 MiB + ~25 MiB, GCM
  verifies a whole part before releasing a byte), whatever the clip's
  length; they are dropped when the last download ends.
  - **Measured** on the emulator (2026-10-05, the same 129 MB 2:00 1440p
    clip and 22 MB video attachment over the same loopback link, old and new
    APK interleaved, 4 runs each): the clip took 22.3–23.9 s the old way and
    16.7–17.0 s natively, of which all but ~0.2 s is the network (decrypt
    ~30 ms, writes ~150 ms). Peak memory during it (dumpsys meminfo, PSS):
    app 196 MB + WebView renderer 401 MB the old way, 220 + 165 MB natively.
    The attachment is the one thing that got SLOWER: 1.9 s the old way
    (the page already held it decrypted, so only the bridge write was left)
    against 2.9–3.0 s natively, because the phone downloads it again.
  - **The saved clip gets its duration and a seek index**, without a
    re-encode or a moved media byte (`Fmp4SaveFix.java`). A sealed clip is
    fragmented MP4 whose init was written before its length was known:
    mvhd/tkhd/mdhd say 0, there is no `mehd`, and the only index is the
    `mfra` at the end — Android's MediaExtractor reports no duration and
    cannot seek, MediaStore stores no duration, Google Photos shows no length
    or working seek bar. The save inserts an `mehd` into `mvex`, reserves a
    region before the first `moof` that becomes `free` + a `sidx` (one
    reference per video fragment, ending exactly at the first `moof`), writes
    the real durations (read from the fragments' own `tfdt` + `trun`) into
    mvhd, every tkhd and mdhd and the `mehd`, and moves every `tfra`
    moof_offset by the bytes it inserted. Undoing exactly those changes gives
    back the sealed file byte for byte — `DownloadVectorsTest` checks that on
    a real mediabunny clip, and it held for a 129 MB 2:00 1440p clip saved on
    the emulator (2026-10-05: same SHA-256 after the undo; ffprobe lists the
    same 8,504 packets, every one with the same data hash). That clip then
    had duration 120000 and 2560x1440 in MediaStore, MediaExtractor reported
    120 s and sought to 28.6 s for a 30 s seek (before: no duration, every
    seek landed on 0), and Google Photos showed `2:00` and seeked to 1:29.
    An init it does not recognise (no `mvex`, an `mehd` already there,
    samples or chunk offsets in the moov, a box too short for its version
    byte, or another muxer's `sidx`/`ssix` in front of the media) is saved
    exactly as sealed; an `mfra` entry that points at no `moof` turns the
    `mfra` into a `free` box rather than leave a wrong index. A leading
    `sidx` counts its offsets from its own end, so the reserved region would
    land inside what it points at — measured 2026-10-05: ffmpeg's `+dash`
    output, once fixed, sought to 1 s for a 4 s seek (4 s as posted), and its
    `+global_sidx` output started its audio at 0.07 s with AAC decode errors;
    both are now saved byte for byte as posted. Púca's mediabunny clips never
    carry one. The save's log line says why a file
    got no index: `fragments not understood`, `fragments incomplete` (the
    clip ends inside a box), `no fragments to index`, `too many fragments`
    (more than the manifest reserved room for) or `fragments out of range`.
  - **A clip is the poster's file, so reading it is bounded.** Every count
    in it is theirs, and before these limits a crafted clip could hold the
    one download thread for minutes or run the app out of memory (JVM, 192 MiB
    heap, 2026-10-05: one `trun` claiming 2^32 samples took 1.3 s and 64 of
    them over 30 s, with Cancel unable to stop it; a 24 MB part of empty
    `moof`s, 72 MB of base-offset fragments, five 8 MB `mfra`s, or ONE 20 MB
    init of 8-byte boxes each ran out of memory — and every later download
    queued behind it). Now: a container of more than 1,024 boxes is not an
    MP4 this touches; a run with no per-sample fields is `count x default`
    with no loop, and more than 2^20 samples in one run is not understood;
    the scan keeps at most 65,536 `moof` starts and 65,536 patches, then
    stops reading boxes and retires the last `mfra` found through the
    trailing `mfro`; an `mfra` that would not fit the budget is retired
    whole. The same shapes now take under 0.2 s on that JVM and a few MB, and
    giving up costs the fix (the manifest's duration, no seek index), never the save.
    Cancel reaches inside a part: `ClipAssembler` and the scan poll it once
    per box (`Fmp4SaveFixHostileTest`).
  - **Why not at the seal.** The desktop seal could write the `mehd` (it
    knows the length when it seals), but every clip ALREADY posted would
    still need this on download, the `sidx` needs every fragment's size (the
    seal streams parts out as it cuts them), and the init is what every
    viewer's MSE player appends first — a change there reaches every client
    version for no gain on the phone, which fixes old and new clips alike.
  - **On desktop and the web** the same fix runs in the page
    (`api/clips/fmp4SaveFix.ts`, a line-for-line port of `Fmp4SaveFix.java`
    and `ClipAssembler.java`, driven by `downloadClipBytes(…, fixContainer)`
    from `api/clipDownload.ts`): the same decisions (only an MP4 by
    `SaveTarget`'s brand rules; an init it does not recognise is saved as
    sealed), the same limits, and Java's 64-bit `long` arithmetic and signed
    track ids reproduced with BigInt. **The phone and the PC save a clip as
    the same file — for every shared vector**, crafted ones included; that
    is what is checked, not a proof for every possible file. A review found
    two crafted shapes on which they did differ, both fixed on the Java side
    and now vectors: an 8-byte `mvhd`, `tkhd` or `mdhd` as the very last
    bytes of the init made Java read its version byte past the array and
    fail the download ("Could not save the file on this phone"), where TS
    saved the clip as sealed; and a 64-bit box size near 2^63 wrapped Java's
    `off + size` bound, so Java parsed boxes TS refused. Both sides now
    check a size against the room left, and every size before a version
    byte. `download-vectors.json` carries 45 `saveFix` cases (the real clip
    cut every way, edited inits, every `Fmp4SaveFixHostileTest` shape, 64-bit
    sizes, a track id past 2^31, a duration x timescale past 2^64, a leading
    `sidx`/`ssix`, an mvhd of version 1, the manifest's fallback durations
    and their rounding, an `mfro` arriving in a last part under 16 bytes, a
    `tfra` offset cut across two parts, a `moof` after the last `mdat`, every
    no-index reason) with the file both sides write for each, and
    `downloadVectors.test.ts` (TS) and `DownloadVectorsTest` (JUnit) must
    both write exactly that. 26 TS mutants and 13 Java mutants of the fix
    each fail it; one TS mutant cannot (looking up a `trex` by the signed
    instead of the unsigned id only differs for a track id of 2^31 or more,
    and such a track's `trex` defaults are never read: no `tfhd` id matches
    it on either side). The decrypted parts the page
    already holds ARE the output — the patches are written into them and only
    the init is a new (KB) array — so the fix costs no second copy of the
    clip. Measured 2026-10-05 against a throwaway server, headless Edge, the
    desktop path under a stubbed shell: the 129 MB 2:00 1440p clip's
    `attachment_save` bytes and its web download are SHA-identical to the
    file the emulator's native save wrote for the same clip; the assembler
    adds ~1 ms (download 2.6–3.0 s with the fix, 2.8–3.3 s without);
    `ffprobe -show_packets` data hashes are identical before and after; the
    fix undone gives back the sealed SHA-256. What changes on Windows:
    Explorer's Length (`System.Media.Duration`) was blank for a downloaded
    clip and now reads 2:00; Media Foundation (Media Player, Movies & TV)
    already found a length (119.957 s, from the fragments) and seeked, and
    now reports 120.000 s; ffmpeg seeked before and lands on the same
    keyframes after (VLC was not re-measured) — before by reading every
    fragment's header up to the target (60 for a 60 s seek: by default it
    ignores the `mfra`), now by jumping with the `sidx` (2). That last
    point holds because a recorded clip's audio fragment never starts after
    its video keyframe (every one of 89 fragments in two recorded clips): in
    an MP4 whose audio does (ffmpeg's own fragmented output), ffmpeg's demuxer
    jumps by a one-track `sidx` and then finds no earlier audio than the
    first fragment's, so `ffmpeg -ss 2` and `-ss 4` both landed on 1 s
    (ffmpeg's own `+global_sidx` files seek short too: 2 s to 1 s, 4 s to
    2 s). Only a non-Púca or crafted clip has that shape today. ffprobe reports durations
    differently: with a `sidx` it takes the format duration AND the duration
    of every track without one (the audio) from the video track's index —
    119.998 s instead of 120.000 s for both on the 2:00 clip (20.000 s
    instead of 20.011 s for a 20 s clip), though the audio's `mdhd` says
    exactly 120.000 s. The same packets, every one, are still listed. A crafted clip is bounded as on the
    phone: one posted with a 24 MiB part of 8-byte boxes, 3.1 M empty moofs,
    a 64 x 2^32-sample `trun` bomb and five 30,000-entry `mfra`s downloaded
    in 1.8 s (web) / 3.0 s (desktop), byte-identical to the Java save, with
    one ~245 ms main-thread task — the 8-byte boxes, the most header work per
    byte; a real clip's scan is ~1 ms.
  - **Liveness**: `DownloadService` (a dataSync foreground service with a
    wake lock and its own notification with a **Cancel** action) keeps it
    going with the screen locked
    or the app in the background; a download finished while the app is not
    on screen leaves a "Saved …" (tap to open) or "Download failed"
    notification. The plate has a **Cancel** button too (every platform),
    which aborts the fetch in flight and leaves nothing behind. The progress
    notification asks to be deferred, and Android 12+ then keeps it out of
    the shade for ~10 s, so a short download usually shows none (an explicit
    `FOREGROUND_SERVICE_DEFERRED` outranks the "action buttons show at once"
    rule, so the Cancel action does not matter). But Android grants an app
    one deferral per two minutes (`deferred_fgs_notification_exclusion_time`
    120000): within two minutes of the app's own keep-alive service starting
    — so just after the app opens — or of an earlier download, it shows at
    once and a short download flashes it. Measured 2026-10-05 on the
    emulator saving a 22 MB attachment: id 4714 at +0.5 s inside that window,
    never outside it, both with and without the Cancel action. Before
    Android 12 there is no deferral at all.
  - **Errors** come back as codes the plate already speaks: `gone` (404/410)
    is "This clip is no longer on the server", `decrypt` names the part,
    `network` is a connection that dropped four times in a row (a dropped
    part is fetched again from its first byte after 1, 3 and 10 s, which
    rides out a move between Wi-Fi and mobile data; a Cancel cuts a wait
    short), `write` is the phone's storage. An ordinary
    attachment saved the same way says the same reasons in a few words on
    its button (`saveFailureNote`), and shows the MB arriving while it saves
    (out of a total only when the response carries a Content-Length, which
    GET /files, a stream, does not).
  - **Where an attachment lands** is decided by its first 512 plaintext
    bytes (`SaveTarget.java`), never by the sender's MIME or name: a
    recognised picture, video or sound format goes to Pictures/Movies/Music
    (`Puca` under each) with that format's MIME and extension; anything else
    goes to Download/Puca. A name that CLAIMS media the bytes are not gets
    `.bin` appended, because MediaStore's scanner types a published item by
    its extension, not by the MIME it was created with (measured: an HTML
    file saved as `fake-video.mp4` with `application/octet-stream` came back
    as `video/mp4`, media_type VIDEO, in the video collection). That also
    catches text whose extension Android maps to media: a TypeScript
    `notes.ts` (`.ts` is MPEG-TS to `MimeTypeMap`) is saved as
    `notes.ts.bin` (seen on the emulator), and `logo.svg` as
    `logo.svg.bin`. The progress
    notification has its own id (4714): sharing KeepAliveService's 4712 made
    a download replace the keep-alive notification and leave it stuck on
    "Downloading …" (`NotificationIdsTest`).
  - **Security**: credentials go to ONE origin — the API base the APK was
    BUILT for (`plugins.SovereignDownloads.apiBase` in the APK's
    `capacitor.config.json`, written at `cap sync` from the same
    `VITE_API_URL` the bundle is built against). The page's own base must
    equal it or the plugin refuses; the URL is always `<base>/files/<uuid>`
    with the id checked as a UUID; redirects are not followed (they would
    carry the bearer); https only outside a debug build. Keys, tokens, ids
    and names are never logged. The consent check stays where it was: a
    clip whose manifest points at unapproved parts never gets a Download
    button, so nothing is sent to the plugin.
  - **Older APKs and Android 9 and older** (an over-the-air bundle arrives
    before the new APK) keep the previous path, unchanged: the plugin name is
    new, so `Capacitor.isPluginAvailable('SovereignDownloads')` is false
    there; Android 9 and older (no MediaStore pending items) and an APK built
    for another server than the page talks to say so through `status()`.
    That path STREAMS the clip into
  `Documents/Puca/puca-clip-<id>-<timestamp>.mp4`: parts fetched, decrypted
  and written in order with the NEXT part downloading while this one is
  written, never more than two in hand (≤ 48 MiB of plaintext; ~72 MiB of
  renderer memory at the moment the next part is decrypted;
  `forEachClipPart` →
  `api/clipDownload.ts` → `saveStreamToDevice`; fetching only after each
  write made the link idle 4-5 s per part, 51.5 s for a 129 MB clip on the
  measured emulator), each bridge call at most
  4 MiB of base64 (3 MiB of the file, encoded by the engine's
  `Uint8Array.toBase64` where it exists), into `<name>.part`, renamed to the
  real name only once complete — the plugin media-scans after every call,
  and a half-written mp4 under the real name, left by an app killed
  mid-download, would look like the clip. Building the whole clip and handing it to the filesystem
  plugin in one piece closed the app (a 2-minute 1080p clip was one 128 MB
  string; Android's bridge handler ran out of memory on the UI thread). The
  writer lives outside `api/clips/`, which `clipNoDiskWrite.test.ts` keeps
  free of every file API, the Capacitor filesystem included.
- **Not done: the container fix on that older-APK path.** It writes
  `Documents/Puca` through the filesystem plugin, which can only append, and
  the fix's last step is positional writes into what was already written
  (the durations, the `sidx`, the moved `tfra` offsets), so a clip saved
  there is still the sealed bytes. Every other Download — the native one,
  desktop, the web — gets the fix; the cure for this one is the new APK.

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
- **Your mic in a clip is RNNoise-quality while nobody else can hear you.**
  With DeepFilter as the noise mode, it pauses while you are alone in the
  call or everyone else is deafened (`api/dfPause.ts`), and its RNNoise
  bridge carries the mic - and so the clip's mic leg, which taps the
  published track. Decided on 2026-10-04 and accepted: keeping DeepFilter
  running whenever a clip is armed would have cancelled the saving entirely
  for the person it was built for (in the call logs it was measured from,
  about 2,100 call-minutes between 30 Sep and 4 Oct 2026, Clips were armed
  in 86% of them, and the caller was alone in about 8%), and RNNoise is the
  same suppressor that already covers every CPU
  spike in a clip. Muted, push-to-talk and the other
  mic-closed pauses change nothing here: the clip's mic leg is silent then
  anyway (it respects mute).
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

Quality preset — 480p30 (2 Mbps), 720p30/60, 1080p30/60, 1440p30, 4K30 and
Native (its resolution cap applies only to manual/prompt arms — see
below; so 480p saves memory only when armed by hand), buffer length, memory limit (slider max derived from the machine's
memory budget so the ring clamp can never reject it), mic level in clips,
"When I join a voice call" — `clipArmOnJoin`: *Do nothing* / *Remind me to
arm* (highlights the Arm button for ~12 s) / **Arm automatically**, and the
**Save clip** hotkey (works from a fullscreen game via the native hook).

What each choice costs is shown where it is made, all from one pure module
(`clipPresets.ts`): every buffer length is priced in memory and marked
*(longer than your servers allow)* when it exceeds every server's cap; a line
says how big a saved clip of the longest allowed length is and how many fit
in the member's clip storage (`GET /clips/usage`), and warns when that clip
would exceed the in-app download (1 GiB) or trim (768 MiB) limit, or the
64-part limit (`clipPartCount` counts parts the way `Fmp4Splitter` cuts them:
an init-only part 0, the ramp's 1, 2, 4 and 8 fragments, then whole 2 s
fragments under 24 MiB each, or flat when the ramp would pass 64 — a test
runs the real splitter to keep the two in step). The Quality line says what **automatic arming** really records
on a monitor like the current one — `nativeEncodeEstimate`, a TS port of
`clip_capture.rs::effective_encode_settings`, pinned to the Rust by a shared
table (`frontend/src/tests/fixtures/clip-native-encode-table.json`, asserted
by both `clipNativeEstimate.test.ts` and the Rust test that reads it). With
*Arm automatically* chosen, every figure is priced at that rate instead of
the preset's label, and each Quality option adds what it records on this
monitor (on 1080p, 480p records 24 fps at 8.1 Mbps — more than the
1080p 30 fps default's 6 Mbps, because automatic arming records the whole
monitor whatever the preset). The composer's duration chips carry their size (priced
from the ring's measured bytes once 10 s are buffered), and Server Settings'
*Longest clip* prices each length at the default quality, and its help line
gives the selected length at the default and at the largest preset. On web
and phones the card stays one line, plus the servers' longest clip.
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
classic WASAPI loopback (`clip_desktop_audio.rs`, a separate module and wire
from the per-app "game audio" capture so a live screen share using that
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
  preset's max width/height the way a manual/prompt arm is. When the monitor
  is bigger than the preset, the frame rate drops instead (24/30/48 fps
  cadences) and the bitrate follows it — so the 720p 60 fps preset records
  24 fps on a 1080p monitor. Settings says so (see above).
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
  the picker's (`NATIVE_AUDIO_OFFSET_US` is -30 ms, see its comment). The
  loopback AudioContext's SCHEDULING LEAD (JITTER_S at
  a prime, then whatever the loopback device's clock and the context's
  clock accumulate, up to MAX_BACKLOG_S before a reset) is A/V error the
  anchor cannot see, because the worker only ever sees render times:
  `e2e/clip-av-emulation.mjs` measured audio 106-215 ms late with the
  lead at 79-121 ms and the error tracking it packet for packet. So
  nativeCapture reports the lead (`onLead`), replayBuffer forwards it
  (`audioLead`), and seal() subtracts it (`placeAudio`).

  **The lead belongs to a SEGMENT, not a packet (2026-09-24).** The
  first version (2026-09-21) reported every packet's `playhead - now` and
  subtracted each audio entry's own figure, clamping an entry that landed
  on its predecessor to 1 µs past it. But between two primes the playhead
  advances by exactly each packet's duration, so render-minus-capture is
  the same for the whole segment; what `playhead - now` adds from packet
  to packet is IPC bunching (a busy main thread) and currentTime's steps.
  That noise reached the clip as a different shift per audio frame, and
  in an MP4 a sample lasts until the next one's timestamp: a field clip
  came back with choppy audio, and `e2e/clip-av-emulation.mjs` found
  ~60% of a clip's frames written too short or too long (0-48 ms for a
  frame holding 20), with the mic delay re-ramped ~50 times a second (a
  pitch wobble). Now:
  - nativeCapture reports a segment's START — at a prime, an underrun
    re-prime (from where the old content ended, i.e. where the underrun's
    silence began) or a drift reset (from the cut) — and after that only
    GROWTH of 5 ms or more. The segment's lead is the most seen: a packet
    that arrived late shows less, never more.
  - The worker reads an entry's segment lead as it stood 1 s after the
    entry (`LEAD_LOOKAHEAD_MS`), since the lead is learnt over the packets
    that bunch up behind a prime.
  - `placeAudio` keeps each entry at its predecessor's offset (the
    encoder's own spacing) while the target is within half a frame;
    entries that would overlap what is placed by more are DROPPED whole
    (an underrun's rendered silence, first), and a target further later is
    a real hole (a drift reset's discarded backlog), kept as one. So a
    clip's audio is one continuous timeline, and each entry sits within
    half a frame (~11 ms) of its segment's lead.
  - The mic delay moves only on those reports: a handful per segment.

  The MIC leg of the mix reaches the graph live, so it is delayed by the
  same lead (a DelayNode driven from the same reports) and the one
  subtraction is right for the whole mix; without that the mic would
  have been pulled early by the lead (caught in review). After a lead
  CHANGE the mic converges on its new delay over the size of the change
  (a linear ramp), so the mic sits off by up to that change for that
  long: 10-40 ms after an underrun re-prime. A drift reset (rare:
  MAX_BACKLOG_S of clock drift, or a suspended context) drops the
  backlog, so the clip's system audio has a hole of that size there and
  the mic converges across it. Before the first report the lead is 0, so
  system audio retried after a mic-only stretch is not applied
  backwards; the mic stretched by its delay's ramp at that seam is
  dropped like an underrun's silence.
  Residual, not corrected: the WASAPI period and IPC
  on the Rust side and the mixing hop, minus the video stamp's lag behind
  the present (it is taken after acquire and readback, and the async MFT
  holds a frame or two in flight); the emulation measures the JS part, a
  flash plus click through the real app the rest. Each video chunk reaches
  the page as one raw binary message on the Channel `start_clip_video_capture`
  was given (`clip_capture.rs` `chunk_frame`, read by `chunkWire.ts`; it used
  to be a base64 JSON event, ~1.3 MB/s of decoding on the main thread). The
  frame carries the capture generation (as every audio message does) and
  `startNativeVideo` drops any
  other capture's chunks, so the old capture's tail after "Restart
  buffer" never reaches the new ring; as a backstop, a video timestamp
  going BACKWARDS is treated as another capture's clock and restarts the
  estimate. Silent field check: once both clocks have
  5 s of samples, puca.log gets `[stream-diag] clip-av video-origin=..
  shift=.. legacy-late=..` (again if the shift moves 10 ms), where
  `legacy-late` is how much later the old code placed the audio.
- **The desktop-audio wire (2026-10-04).** The loopback PCM reaches the
  page on its own raw binary Channel, handed over by
  `start_clip_desktop_audio` (`onAudio`) — the same move 0.9.820 made for
  video. It used to be a Tauri event per WASAPI packet: ~100 a second, each
  10 ms of interleaved f32 base64-encoded inside a JSON payload inside an
  evaluated script, which the page's main thread then ran through `atob`, a
  byte loop and a de-interleave loop before building an AudioBuffer and a
  source; packets Windows flagged silent were sent as zeros and played.
  Now (`clip_audio_wire.rs` `AudioBatcher` / `audio_frame`, read by
  `audioWire.ts`):
  - **~100 ms a message** (`BATCH_MS`: a message goes once it holds 100 ms,
    so ten 10 ms packets; a part-filled one after 20 ms with no packet).
    Batching is the point, not just the missing base64: tauri sends a raw
    message of 1 KiB or more as an eval plus a fetch round trip
    (`ipc/channel.rs`), and the page pays for the round trip, not the bytes —
    about 1 ms of its main thread each in headless Edge, measured 2026-10-04
    (`fetch` alone, with nothing done with the bytes, was 95% of the cost). At
    40 ms a message, the size first planned, the binary wire cost the page MORE
    than the base64 event it replaced whenever sound played; at 100 ms it
    costs less. The batch is held up to 90 ms longer in the shell, and the
    lead (below) puts every ms of that back. That hold is real latency all
    the same: the loopback's lead went from about 60 ms to about 150, so
    the sound reaches the clip worker that much later than the picture, and
    the seal now waits for it (above, under **Clip**).
  - **Planar f32** after a little-endian header (version, flags,
    generation, rate, channels, frames, packet count) and a table of the
    WASAPI packets the message holds (each one's frames, and how long before
    the send it was read), so each channel goes into the AudioBuffer with one
    `copyToChannel` from a view of the message itself. Rate and channel count
    are per message and honoured: WASAPI's autoconvert gives this capture
    48 kHz stereo, but nothing downstream relies on it (44.1 kHz, 5.1 and 7.1
    are tested on both sides).
  - **A run of WASAPI-silent packets carries no samples** (flag bit 0), only
    the header and its packet table. The page schedules nothing for it and
    moves the playhead on by exactly that much, so silence costs ~nothing and
    the sound after it lands where it would have; a message never mixes sound
    and silence or two formats (a change sends what is pending first).
  - **The lead is measured as before, packet by packet.** On the one-packet
    wire every packet was one sample of the lead, and the page reported a
    segment's lead whenever a sample beat the last report by 5 ms. A batch
    holds its packets until its last is read, so it lists them with their
    ages; nativeCapture walks that list, adds each age back, and takes exactly
    the samples the old wire gave, in the same order, under the same rule —
    the measure `NATIVE_AUDIO_OFFSET_US` was calibrated on. The real latency a
    batch adds (up to 90 ms) is therefore in the lead, and the clip worker and
    the mic delay correct for it. (Sending one packet's age per message —
    the last packet's, or the one that would have shown the most lead — was
    tried first: it takes the same maximum but reports it at different
    points than the per-packet rule, so the table is what makes the measure
    the same one, not just a similar one.)
    Under `clip-av-emulation.mjs` (2026-10-04, four sessions of four runs
    each, interleaved with the old wire): 0 audio-timeline misfits on both,
    the sound after a 1.6 s silent run exactly that much later, and the
    clip's system audio 23.3 ms late on average (1.6 to 33.7) where the old
    wire gave 21.8 (13.7 to 25.5). The average is the same within a couple
    of ms; the spread is wider. The old wire's 16 runs fell in two groups
    10 ms apart (about 14-15 and 24-25 ms: the step AudioContext.currentTime
    moves in); the new wire's mostly near 20 and 30 ms, with two lower (1.6
    and 9.5). Every run is within about one AAC frame (21.3 ms) of the old
    wire's range — not the half frame an earlier version of this note
    claimed (1.6 is 12.1 below 13.7). Why batching widens it was not pinned
    down: it persisted with all three ways of sending the lead, and
    disappeared with one packet per message. Nor is the emulation a model of
    the real spread: its delivery delay is paid per packet BEFORE the read,
    so that jitter lands in the packets' ages, where the real shell pays its
    IPC once per message after the send, unseen by any age. A flash and a
    click through the real app is still the only measure of the real total.
  - **Lifecycle.** Each start has its own Channel; the capture thread owns
    the shell's end and drops it when it ends (a refused start drops it at
    once), which unregisters the page's end. A stopped handle ignores what
    is still in flight. A page reload is the same as for video: the new
    page's `reset_capture_state` ends the capture. There is no back-pressure
    beyond what the event had: a stalled page leaves messages queued in the
    shell (~0.4 MB/s of PCM, where the event queued ~0.5 MB/s of script), and
    the page's drift reset drops any backlog over MAX_BACKLOG_S when it
    resumes.
  Proved by `clip_audio_wire.rs`'s tests and `src/tests/audioWire.test.ts`
  (one byte fixture, `src/tests/fixtures/clip-audio-wire.json`, built by
  the Rust side and read by the page's), `nativeCaptureAudioWire.test.ts`
  (the lead of a batch, silence and a segment that silence opens, any format), `nativeCaptureAudioChannel.test.ts`
  (tauri's real `Channel`: no callback outlives its capture across restarts,
  and a silent run that overtakes the batch before it still plays in
  order), and `e2e/clip-av-emulation.mjs`, whose emulated shell now batches
  the same way and whose fourth run sends 1.6 s of silence with no samples.
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
decrypted in the viewer's browser; the part the playhead waits for is fetched
alone, the next one only once it is in, playback starts once the start-up
gate is met, and the plate counts the MB it is waiting for — with no total
until the player has measured the link, about a second in, and a bar that
only moves forwards unless a scrub before the first play starts the load
over; the player keeps the decrypted parts of its window and the clip's
first part, not every part it has played or scrubbed past; and an eviction
never leaves an audio-only remnant in the SourceBuffer — Chromium charged
the whole next part to that remnant's audio track and refused it, so a seek
~11 s past the buffered end used to stop the clip for good; a quota error
with nothing playable buffered clears any remnant once and retries) and offers Download (the original bytes, any viewer — see
"guaranteed"; the button counts the percent received, then says Saving),
and shows the badge only when the manifest's
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
| native A/V sync end to end, EMULATED | `e2e/clip-av-emulation.mjs` (muted headless Edge): the real armNative -> nativeCapture -> worker -> seal -> upload against an emulated Rust side delivering a real H.264 flash stream and 10 ms WASAPI-shaped PCM on one clock; the sealed clip is decrypted, demuxed and decoded; a second flash+burst 300 ms apart in the same clip is the oracle's control (seen as 300.0 ms) | 2026-09-21, before the lead fix: audio 106 and 215 ms LATE in two runs, the error tracking the loopback context's scheduling lead (79-121 ms) packet for packet; after `onLead`/`placeAudio` and `NATIVE_AUDIO_OFFSET_US = -30 ms`: 21.5 to 36.4 ms late over four runs (the last: 24.1 and 21.5, the mic leg 5.8 and 9.4) with the lead at 50-90 ms (the modelled Rust side contributes ~15-25 ms of that) |
| native clip audio is ONE continuous timeline, EMULATED | the same harness since 2026-09-24: a quiet continuous tone under the PCM (a gap in silence is silence, so the sync checks alone passed a chopped clip), a third run with the main thread stalled 30 ms every 200 ms, and a probe on the mic DelayNode. Every audio packet after the first must have a container duration equal to what it decodes to (misfits allowed only at a re-prime); the mic delay may ramp on fewer than 1 in 20 packets. `AV_BROWSER=chromium` runs it on Playwright's Chromium (Opus audio, video decoded by ffmpeg) | 2026-09-25, Linux Chromium: per-segment lead 0 misfits in 547/548/546 packets, 2-5 mic ramps over ~1360 packets; the per-packet code it replaced 322-365 misfits (worst 48 ms) and 663-724 ramps in the same runs. A/V: system audio 32.6-51.3 ms late and mic 19-43 ms with the fix, 32.6-52.6 and 9.3-61.7 ms before it (unchanged within run-to-run spread; Chromium on Linux, not the Edge calibration above) |
| native A/V sync end to end, REAL | flash + click through the real app (the only way to add the real WASAPI and DXGI latencies to the number above) | — |
| native capture with a real game running | the owner's installed app (0.9.822), auto-armed in a solo voice channel, Deadlock fullscreen on the primary monitor, all playback devices muted; the per-minute `clip_capture` lines and the health line in puca.log | 2026-09-26, desktop (4080S): 302 s at 30.0 fps (9043 frames, 2560×1440 at the 1080p60 preset's 30 fps cap), 7.4 Mbit/s, 0 dropped; page lag ≤11 ms; one WASAPI "fell behind" at capture start, none after; a 1:00 clip sealed as 55 MB in 4 parts, then DISCARDED before approval, so its picture and sound were NOT watched or heard |
| pointer moves on repeated native frames | old vs new agent side by side on the same screen and mouse | 2026-09-21: NOT exercised: the screen presented every slot (754 new pictures, 0 repeats in 30 s); needs a genuinely still screen |
| 10-min ring memory plateau | ~500 MB renderer working set, flat through eviction | 2026-08-18 (spike S6) |
| no clip-sized files in the profile | profile scan | 2026-08-18 (spike S9) |
| Android WebView plays the sealed MP4 | on-device | — (Phase 2) |
| decline ⇒ private bytes drop | Task Manager | — |
| lock the session while armed ⇒ disarmed | real shell | — |
