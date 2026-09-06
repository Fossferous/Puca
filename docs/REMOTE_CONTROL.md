# Remote screen control

Lets a viewer of a screen share drive the **host's** mouse and keyboard (e.g. a
friend keeps your game going while you step away). This document records what the
feature does, its trust model, and — importantly — the boundaries it does **not**
cross, so nobody ships or markets it beyond what it actually guarantees.

## How it works

- **Transport:** the handshake (`ControlRequest/Response/End`) is relayed over
  the existing WebSocket, exactly like the WebRTC signaling. The server is a
  dumb relay; the **host's client is the authoritative gate**. Input frames
  (`ControlInput`, sealed under a per-session key) ride the call's own path
  when it exists: on a mesh call a single **negotiated data channel** on the
  peer connection (`rtc/controlDc.ts`, stream id `CTL_STREAM_ID`), on an SFU
  call the room's data path; the WebSocket relay is the permanent fallback
  and the only path that always exists. A lane carries input only after a
  sealed HELLO arrives on it — an open channel proves SCTP, not that the
  peer's app reads it. Until 0.9.6 the mesh lane never carried a frame: both
  ends created it in-band and each closed the copy that arrived, which is
  the peer's own channel, so every session fell back to the relay (two WAN
  legs through the edge proxy per mouse move) with nothing in any log to say
  so. The unattended sampler now prints the lane (`lane=mesh-dc|sfu-data|
  relay`) for every live session, and `[p2p-input] peer N: no P2P lane after
  2 s` is logged when a session stays on the relay.
- **Injection:** only the **Windows desktop app** can inject input, via Win32
  `SendInput` (`src-tauri/src/remote_control.rs`). Keys are injected by hardware
  **scan code** (many games ignore virtual-key input). Web/mobile hosts cannot
  inject and auto-deny requests.
- **Roles:** the controller (viewer) can be on any platform; only the host must
  be the Windows desktop app.

## Safety model

- **Strict session binding.** The host injects input *only* from the one viewer
  it granted, *only* while it is actively sharing. Requests are refused if
  already controlled or not sharing.
- **Emergency revocation, three independent ways:**
  1. the visible **Stop** button on the banner,
  2. the **Esc** hotkey (when the Púca window has focus),
  3. **touching your own mouse/keyboard** — a low-level hook detects real
     (non-injected) host input and drops control instantly.
  Control also ends on the partner disconnecting, the host's own WS dropping,
  stopping the share, leaving voice, an inactivity timeout, and app exit.
- **No stuck input.** The host tracks every held key/button and releases them all
  on any teardown (revoke, timeout, disconnect, exit). Repeated presses are
  de-duplicated so a flood can't amplify.
- **Input hygiene.** Malformed payloads are rejected, pointer motion is coalesced,
  values are bounded, and the total event rate is capped.
- **Display correctness.** The host sends the shared monitor's virtual-desktop
  bounds + the virtual-desktop origin/size, so absolute moves map to the correct
  screen. Secondary monitors legitimately have **negative** coordinates; a
  primary-monitor-only assumption would misplace the cursor.

## Boundaries — what this does NOT do

- **Privilege boundary (UIPI), for THIS transport.** `SendInput` from the
  desktop app is subject to User Interface Privilege Isolation: a lower-integrity
  process cannot inject input into a higher-integrity window, and cannot
  interact with the **secure desktop** (UAC elevation prompts, the lock/login
  screen). For the ordinary desktop-app remote-control path documented here,
  that is **out of scope**. See Microsoft's `SendInput` documentation:
  <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput>

  This boundary does NOT apply to the separate SYSTEM-service transport
  (`crates/puca-service`, `crates/puca-agent`), which exists
  specifically to reach the lock and sign-in screens — see
  `crates/puca-input/src/desktop.rs`, whose header documents the whole
  mechanism. That path runs as LocalSystem and attaches the calling thread
  to the input desktop with `DESKTOP_JOURNALPLAYBACK`, which is the access
  right `SendInput` requires there and which a lower-integrity process could
  never be granted regardless.

  **What to do about a UAC prompt mid-session.** A prompt that appears while you
  are signed in and using the machine freezes the picture and swallows input: the
  secure desktop has taken the display and this transport cannot follow it.
  Approving one remotely needs SYSTEM — not merely an administrator account — so
  no setting inside Púca fixes it. The options, cheapest first:
  - **Start the elevated program before you connect**, so the prompt is answered
    while you are still at the machine.
  - **Turn on lock-screen access** (Devices → "Let me reach this computer's lock
    screen"). This covers a machine that is LOCKED or signed out, which is the
    common case — but deliberately NOT a prompt that appears while you are signed
    in and unlocked, because the service stays absent during an ordinary session
    (`puca-service/src/supervisor.rs`, `desired()`).
  - **Set UAC to "Never notify"** on that machine. Elevation then happens silently
    for an administrator account, with no prompt and no secure-desktop switch, so
    admin programs start without freezing the session. It does NOT let you type
    into an already-elevated window — that is UIPI, a separate boundary, and it
    still applies. The cost: anything that asks for administrator rights gets them
    without asking you.
  - **Disabling UAC entirely** (`EnableLUA=0`, needs a reboot) collapses the
    integrity split, so elevated windows become drivable too. The cost is worth
    stating plainly: every process on that machine then runs with full
    administrator rights, including your browser, so one bad download is no longer
    contained. Not recommended for a machine reachable from the internet.

  A mid-session bridge — momentarily borrowing a SYSTEM helper to serve just the
  secure desktop, then handing back — was designed and proved feasible
  (`crates/puca-spike-fswap` measured a live Chrome decoder surviving the
  cross-process frame-source swap: 0 dropped frames, 0 freezes, no reconnect). It
  is deliberately NOT shipped. It would put a SYSTEM injector on the machine
  during ordinary use, for a case very few installs ever hit, and every guard
  around it would be software rather than the OS's own ceiling. What ships instead
  is honesty: the viewer is told a Windows security screen is up, rather than
  being left looking at a frozen picture.
- **No "anti-cheat safe" promise.** The process-name blocklist
  (`detect_anticheat`) is **risk reduction, not a guarantee**. It denies control
  by default when a known protected title is running, but:
  - unlisted anti-cheat may still be present,
  - protected games may simply **ignore** injected input, and
  - injecting into such a game can **still get the account banned**.
  Users are warned in the approval prompt; do not describe the feature as
  anti-cheat–safe.
- **Multi-monitor edge:** a host sharing a **window** (not a full monitor), or an
  unusual scaled/rotated layout, may map approximately; full-monitor share is the
  supported path.

## Latency — what to read when it feels behind

The loop a viewer feels is: pointer → sealed frame → lane → host coalescer →
`inject_input_batch` (one IPC round trip per coalesced motion + click,
batches queued in order) → `SendInput` → the host's desktop → capture →
encode → network → jitter buffer → decode → the viewer's `<video>`. Measured
on one machine, headless Chromium, loopback
(`frontend/e2e/rc-latency-2peer.mjs`): viewer pointer to the host page's
inject call p50 1 ms (the rig's host is a browser with a fake shell, so the
IPC hop, the worker and `SendInput` are outside it), glass-to-glass p50
40–60 ms at 1080p30 — that is the floor the app's own pipeline sets; a
reported "second" lives in the field's part of the loop, and the diagnostics
exist to say where:

- `await __pucaMeshDiag(5000)` / `await __pucaVoiceDiag(5000)` — the delay
  fields over a 5 s window of real use (`latency` per peer / `remoteRtp` per
  subscribed track): `jitterBufferMs` (with the target the estimator wants and
  the hint the app asked for, read back), `processingMs`, `decodeMs`,
  `encodeMs`, `sendDelayMs` (the sender's pacer), `encodeSentGap` (frames
  parked in the media-E2EE transform), and the selected pair's `protocol` and
  `rttMs` — anything but `udp` turns loss into a standing queue.
- The unattended sampler (`%LOCALAPPDATA%\com.sovereign.chat\logs\puca.log`)
  writes the same fields every second while a control session is live on
  either end, plus `rc=viewer|host peer=N lane=…`.
- The host page's main thread is the contention-sensitive half: with it 60%
  busy, pointer-to-inject-call measured p50 25 ms / p90 65 ms while the video
  leg moved 5 ms — which is what the coalescer and the batched IPC address.
  The stream boost additionally raises the app process (it owns the IPC
  servicing thread and the inject worker, the hops the rig cannot reach) and
  the worker runs at HIGHEST.

## Testing note

Everything up to the OS boundary is verified with automated tests (relay
round-trips, session binding, teardown, rate limiting, release-on-teardown,
the negotiated lane and its valve). The raw `SendInput` injection and the
low-level hook can only be exercised in a real desktop build with a live share
— build with `npm run tauri:build`, share a screen, and have a second user
request control. The end-to-end latency of the whole loop is measured by
`frontend/e2e/rc-latency-2peer.mjs` (header explains what it can and cannot
reproduce).
