# Clips spike (Phase 0) — results, 2026-08-18

Question: can the WebView2 shell keep an OBS-style rolling buffer of screen +
system audio + mic entirely in memory, seal it into a playable MP4, and never
touch disk? Answer: **yes**. Numbers below drove `api/clips/` (presets, codecs,
`AUDIO_OFFSET_US`, the init-part split, the blob-fallback cap).

Two harnesses:

- `probe.js` + `runner.mjs` — the REAL WebView2 shell (`tauri dev` under a spike
  identifier with `--remote-debugging-port`, raw CDP, `pick-screen.ps1` drives
  the OS picker via UI Automation). **It takes over the display and speakers —
  do not run it while someone is using the machine; ask first.** Only the
  shell-specific questions needed it (S0, S1, S3, S8, S9, S10).
- `headless.mjs` — headless **Edge** (same Chromium 151 as WebView2, same
  platform codecs) with a synthetic canvas + oscillator source. Runs invisibly;
  use it for everything else (S2, S4, S6, S7).

Results (`results/*.json`; machine: 16-thread desktop, 32 GB, WebView2 151.0.4129.86):

| id | question | result | verdict |
|---|---|---|---|
| S0 | WebCodecs / MSTP / MediaSourceHandle / subtle in main + module worker | all present; `MediaStreamTrackProcessor` is **main-thread only** (create there, transfer `.readable`) | pass |
| S1 | `getDisplayMedia` system audio in WebView2 | picker offers **"Also share system audio"** (default OFF, on the "Entire Screen" tab); track `System Audio` deviceId `loopback`, 48 kHz stereo, latency 10 ms, live level. `--auto-select-desktop-capture-source` bypasses the toggle ⇒ no audio | pass — UI must handle "no audio → pick again" |
| S2 | H.264 encode | `avc1.640033` accepted (encoder reports **`avc1.640029`** in decoderConfig — carry the ACTUAL string in the manifest); keyframes every 2.0 s (±0.1), drops ≤0.3 %, `encodeQueueSize` ≤4, encode call ~0.02 ms/frame ⇒ hardware. SW fallback = +35 % of a core | pass |
| S3 | audio codecs | `mp4a.40.2` and `opus` encode; MSE + canPlayType 'probably' for both | AAC chosen |
| S4 | mux + playback + A/V sync | mediabunny fMP4 (2 s fragments), `<video>` plays, **MSE with AAC plays**; decode-side flash/beep pairing: audio **~40 ms early** ⇒ `AUDIO_OFFSET_US = 40_000` | pass |
| S6 | 10-min ring memory | ring 185 MB @ 300 s (synthetic ~5 Mbps); renderer working set **plateaus ~500 MB** through 200 s of eviction; jsHeap growth was garbage (GC collapsed 731→105 MB) | pass |
| S7 | AES-GCM at GOP size | 2.3 MB in 1.3–1.9 ms (1.1–1.6 GB/s) | negligible |
| S8 | second `getDisplayMedia` while one is live | both deliver frames (141/10 s each) | pass — arm while sharing is fine |
| S9 | plaintext on disk | profile grew only Chromium caches (GPU/shader/HTTP); no clip-sized files | pass (Process Monitor not available; dir-size + large-file scan used) |
| S10 | viewer-side Blob spill | `blob_storage` stayed at 0 bytes for 32/128/512 MiB blobs on this 32 GB machine; cap kept conservative (32 MiB) for phones | informational |

Not measured (needs a device): Android WebView playback of the sealed MP4 —
covered when the first clip is posted; AAC was chosen partly for that.

Design consequences already applied: manifest carries the actual avc codec;
part 0 = init segment only; `MediaStreamTrackProcessor` on the main thread with
transferred readables; audio timeline rebased by first sample + wall skew +
40 ms; UI must surface "no system audio" with a re-pick.
