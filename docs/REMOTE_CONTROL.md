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
  so. The unattended sampler (desktop only) now prints the lane
  (`lane=mesh-dc|sfu-data|relay`) for every live session, and `[p2p-input]
  peer N: no P2P lane after 2 s` is logged when a session stays on the relay.
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
     (non-injected) host input and drops control instantly. This one is
     opt-in (Settings); the kill-switch key needs only a keyboard hook, so
     the guard installs its system-wide mouse hook only while it is on.
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
- **An elevated window swallows My Devices input, and the viewer is told.**
  The same UIPI rule applies to the My Devices agent the desktop app starts
  (`crates/puca-agent`, medium integrity): a window whose program runs as
  administrator — a game started by an elevated launcher, Task Manager on an
  administrator account, an installer — silently drops every injected click
  and key while the picture keeps updating. Windows says nothing: `SendInput`
  answers as if it worked (Microsoft's documentation: neither the return value
  nor `GetLastError` reveals a UIPI block), so the agent's own input tallies
  read `failed=0`. The agent now asks, on the 1 Hz status poll, whether the
  window in front (keys) or the one under the pointer (clicks) belongs to a
  process above it (`crates/puca-agent/src/input_reach.rs`: the process's
  integrity level, or a token it cannot even open), logs each change once
  (`[input] Windows is dropping this agent's input to valheim.exe …`), and the
  host relays the program's file name to the viewer (`input-blocked`), which
  shows a banner naming it and what to do: close it, or start it again without
  administrator rights. Found on 2026-10-23: a scheduled task started Steam
  with highest privileges, so every game it launched was elevated. The
  sign-in-screen (SYSTEM) agent sits above every application and never
  reports it. Controlling an elevated window from an ordinary session is still
  out of scope (see the bridge paragraph above for why the SYSTEM service
  stays absent during an ordinary session).
- **A game holding the pointer for mouse-look.** A game that hides the
  pointer AND confines it (`ClipCursor`) re-centres it every frame and reads
  raw motion, so absolute moves cannot turn its camera. The agent reports that
  pair (`pointer_captured`; either alone is ordinary — a video player hides
  the pointer, a windowed game confines it in its menus) and the desktop viewer
  offers **Use Game mode**: relative moves under pointer lock, engaged by the
  same click.
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
- **A fullscreen app holding the pointer.** A game that confines the pointer to
  its own window (`ClipCursor`) makes every other screen unreachable: Windows
  clamps injected moves back into the game and still reports success, so
  nothing in Púca can override it without fighting the game every frame. The
  viewer is told instead — a banner on the stage, read from the host on the
  1 Hz status poll. On one screen it shows when the watched screen is entirely
  outside the clip; on **All Displays** it shows when ANY captured screen in the
  picture is (each screen is checked on its own, matched to the capture by
  `HMONITOR`), and its wording says the app's own screen still works. Closing
  the app or switching away from it (Alt+Tab) releases the clip. A game that
  re-centres the pointer every frame without a clip is not detected. A
  controller from before the All Displays check shows its only wording ("on
  another screen... switch to that screen") there too; harmless, but not quite
  right until it is updated.

## A laptop with its lid closed

A laptop with its lid shut and no monitor plugged in has **no active display**,
even when it is kept awake ("When I close the lid: Do nothing"). There is
nothing for the agent to capture. Until 2026-10-21 the phone could only say
"could not connect to the device". The agent answered the offer, its capture
failed eight seconds later on a stream thread that had not yet serviced a
single ICE check, and the phone's connection timed out against a socket nobody
answered.

Two things changed.

**The phone is told why.** Before the host hands its agent an offer, it asks
`prepare_screen` (`crates/puca-agent/src/virtual_screen.rs`, polled by
`session.ts` `prepareHostScreen`). With a screen on, the answer is immediate
and nothing else changes. With none, the agent first wakes the displays (a
sleeping monitor that detached its output usually comes back within 3 s). If
there is still no screen, the session ends with a code the phone turns into a
sentence (`frontend/src/api/devices/noScreen.ts`): "Work Laptop's screen is off —
is its lid closed? Turn on 'Allow remote control with the lid closed' on that
PC." The host sends the code followed by a plain sentence (`noScreenEndReason`),
so a phone from before this shows words rather than a bare code. The
sign-in-screen path does the same inside the agent, because no app is there to
ask; it sends the bare code.

**A closed lid does not always remove the panel.** On some laptops, the
owner's included (0.9.842 field report), the built-in panel stays an ACTIVE
output with the lid shut and Windows simply never presents a frame to it.
The first version counted that as "a screen", answered, and ended twelve
seconds later with no picture. The agent now reads the lid switch
(`crates/puca-agent/src/lid.rs`, the `GUID_LIDSWITCH_STATE_CHANGE`
notification) and each active display's output technology, and treats a
built-in panel (embedded DisplayPort, LVDS) behind a closed lid as DARK. A PC
whose only screens are dark has no screen, at once: no wake grace, because a
lid is not a sleeping monitor. When another screen is lit beside a dark panel
(the virtual screen, or an external monitor), StartStream captures that one
instead and the host tells the viewer which screen it got (`monitor-active`).
A stream that still never shows a picture is ended by the host with its own
reason ("<PC>'s screen did not show anything — it may be asleep, or its lid
closed"). Before this, the phone's connection timed out first and said "could
not connect to the device". An unknown lid state (a desktop PC, or no
notification) changes nothing.

**The PC can have a screen in software.** "Allow remote control with the lid
closed" (Devices, on the PC itself, below the remote-access service it needs)
installs the open-source **Virtual Display Driver** (MIT;
`crates/puca-service/vdd/NOTICE.md` records the release, the SHA-256 of each
file and the signature). In detail:

- **Consent is Windows' own.** The driver is signed by SignPath Foundation, not
  by Microsoft, so Windows asks "Would you like to install this device
  software?" and names the publisher. Púca does not add that certificate to the
  machine's Trusted Publishers to skip the question. The certificate signs many
  unrelated projects, and trusting it machine-wide would trust all of them. The
  install runs as an elevated helper in the user's own session
  (`sovereign-service.exe virtual-screen-install`), because a service in
  session 0 has no desktop to ask on. The admin-only installed copy of that
  binary is the one raised, and the driver files are embedded in it, so nothing
  installed comes from the user-writable app folder.
- **Off unless needed.** The device rests DISABLED (Device Manager shows it
  disabled). A virtual monitor that is always on would extend the desktop with
  the lid open, and windows would open on a screen nobody can see. It is
  switched on only when a remote session starts and the PC has no screen on,
  through the service's control pipe (`virtual_screen_hold`, a 30 s lease the
  agent renews every 10 s, `crates/puca-service/src/virtual_screen.rs`). It goes
  off when the last session holding it stops streaming, or as soon as a real
  screen is back (the lid opened).
- **It cannot stay on by accident.** If the agent dies, its renewals stop and
  the lease lapses. If the service dies, or the power fails mid-session, the
  device's own persisted state is the crash marker. A service that is just
  starting holds no leases, so it switches off any virtual screen it finds on.
- **One mode.** 1920x1080 at 60 Hz, written to the driver's `vdd_settings.xml`
  on every switch-on. The driver reads that file from the folder named by
  `HKLM\SOFTWARE\MikeTheTech\VirtualDisplayDriver\VDDPATH`. Púca points it at
  `%ProgramFiles%\Sovereign\service\virtual-screen`, which only administrators
  can write. Unset, the driver would fall back to `C:\VirtualDisplayDriver`,
  which any signed-in user can create.
- **Not over someone else's copy.** The same driver is popular with
  game-streaming setups. If another copy is installed (a `Root\MttVDD` device,
  or that registry key without Púca's mark on it), the install refuses rather
  than share its hardware ID, its settings and its control pipe.
- **Removal.** Turning the option off, turning remote access off
  (`deprovision`), and uninstalling Púca all remove the device, the driver
  package (`oemNN.inf`, only after checking it still names this driver), the
  settings key and the files. The uninstaller does it before it deletes the
  service folder, which holds the record of what to remove
  (`npm run check:installer-hooks` pins that order). By hand, from an
  administrator prompt:
  `"C:\Program Files\Sovereign\service\sovereign-service.exe" virtual-screen-remove`.

**A property of the driver, recorded.** While the device is ON it serves a
control pipe, `\\.\pipe\MTTVirtualDisplayPipe`, that any local process may
open (`D:(A;;GA;;;WD)`, in the shipped binary). Its commands reload the driver,
change the number of virtual screens and choose the GPU. The on-demand design
limits that to remote sessions, and the read-only settings folder means
nothing sent over the pipe can last into the next session.

**What is verified, and what is not.** Every decision is unit-tested: when to
switch on and off, the lease, the crash recovery, the real-or-virtual check
and its positive control, the messages, and the wire on all three sides.
Installing, enabling and removing the driver were NOT run on the developer's
machine, deliberately: they change the machine's displays. They are verified
on a real laptop, with its owner's permission. Look for the agent log's
`[virtual-screen]` lines (`%LOCALAPPDATA%\Púca\agent.log`) and the service
log's (`C:\ProgramData\Sovereign\service.log`). The first `holding …; active
display adapters: …` line is the field check that the virtual screen's adapter
is recognised as its own.

## My Devices file browser — big folders

A folder listing travels as ONE data-channel message, and the limit that
matters is bytes: the agent's WebRTC stack refuses a message over its 128 KiB
send budget outright, and a browser controller refuses one over its 256 KiB
`maxMessageSize`. So the host (the desktop agent, or a phone sharing a folder)
answers a big folder a page at a time — at most 2,000 entries and 96 KiB of
JSON per page, whichever comes first — and names the next page's cursor. The
browser shows "N items loaded so far" with a **Load more** button until the
folder is complete. Pages arrive in the host's own order and are shown sorted,
so later pages can land anywhere in the list; the row being read stays where
it is.

The cursor is a position in the folder, so a folder that changes between pages
shifts it. Each further page is asked for a few entries early and resumes after
the last name already shown, which absorbs files created or deleted meanwhile.
When that name cannot be found, the browser says "This folder changed while it
was loading" — **Refresh** is the only way to get an exact listing of a folder
that keeps changing.

A phone host from before paging sends one capped page and no cursor; the
browser then says "the first N are listed" and offers no button. A **desktop
agent** from before paging never gets that far on a big folder: its reply for
a folder of more than about 1,700-2,700 entries (depending on name length) is
too large to send at all, so the browser times out after 15 s and later file
actions in that session stall until the agent is updated. If a current host
ever produces a reply too large to send, it answers that request with an error
instead, so later file requests in the session are not stuck behind it.

## Audio Hub from My Devices

Audio Hub is a separate tray app some owners run on their Windows PC (AirPods
and Sony XM6 hand-over). When it runs, the card for that PC in My Devices
offers **Audio Hub**: the panel shows the AirPods and XM6 status lines and four
buttons — AirPods to phone / to PC, XM6 to phone / to PC — with Audio Hub's own
message or error underneath. After a successful "to phone" the Android app
opens Bluetooth settings, because Android lets no ordinary app connect a
headset itself; the owner taps it there. (An Android app older than this
feature has no shortcut to that page, and the panel says where to go instead.)

Each headset's line says where it is now. When FlooCast is not running the XM6
buttons are replaced by a line saying so (Audio Hub could only refuse them). A
200 from Audio Hub means the hand-over was QUEUED, not finished, so the panel
re-reads the status about 2.5, 6 and 12 seconds later, stopping as soon as the
headset is where it was sent; nothing polls after that.

How it travels:

- **Same session, same seal.** The panel rides a session already open to that
  PC (Control or Files), or opens a files-only session of its own — no screen
  captured — and ends it when the panel closes. The request
  `{kind: 'audio-hub', op, rid}` and the answer `audio-hub-ack` /
  `audio-hub-result` are ordinary device-session signals: sealed under the
  session key, bound to the session and strictly ordered, so the server
  relays them without being able to read, forge, splice or replay one. The
  server needed no change.
- **The PC's Púca app makes the call**, not the agent or the lock-screen
  service: it runs as the signed-in user, which is whose `%APPDATA%` holds
  Audio Hub's token (`frontend/src-tauri/src/audio_hub.rs`). So the button is
  offered only while that PC's app is online — never at its sign-in screen.
- **Five calls, nothing else.** `status` (`GET /api/hello`, then
  `GET /api/status`), and `POST /api/airpods/phone`, `/api/airpods/pc`,
  `/api/xm6/phone`, `/api/xm6/pc` with an empty body. The request carries only
  the op's name and an id; the address (`127.0.0.1:47392`), method, path and
  headers are fixed in the app, so there is no way to reach any other port,
  path or host. The token is read fresh from the user's
  `%APPDATA%\airpods-app\phone-token.txt` on every call, sent only after
  `/api/hello` has answered as Audio Hub, never logged, and never sent with an
  `Origin` header (Audio Hub refuses those). Audio Hub's JSON comes back as it
  was, including its 409 / 503 refusals; a 401 is shown in Púca's own words
  (Audio Hub's "not paired" is written for its own phone app — here it means
  the token Púca read was stale or belongs to another Windows user).
- **Who may ask.** Only the owner's own enrolled devices: a friend's device
  share, whatever it allows, never reaches Audio Hub, and on a machine armed
  for unattended access the request waits until the passphrase is proved. On
  an unarmed machine opening the panel asks the person at the PC first, the
  same as Files.
- **Asked, not advertised.** Whether Audio Hub runs is asked when the panel
  opens (and on Refresh), never published through presence: the server has no
  reason to know, and nothing on the PC polls for it in the background.
- **Older versions.** A PC whose Púca predates this drops the request it does
  not know, and the panel says to update Púca there after a few seconds. A
  phone whose Púca predates it never sends one, so nothing changes for it.

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
  either end **on desktop**, plus `rc=viewer|host peer=N lane=…`. It only runs
  in the Tauri app (`holdStreamDiag` returns at once elsewhere), so a browser
  or phone viewer produces no sampler line — read `await __pucaMeshDiag(5000)`
  from DevTools on that end instead. The log rotates at 2 MB, two archives
  kept (`puca.log` plus dated copies), so a whole session's samples stay
  readable.
- The host page's main thread is the contention-sensitive half: with it 60%
  busy, pointer-to-inject-call measured p50 25 ms / p90 65 ms while the video
  leg moved 5 ms — which is what the coalescer and the batched IPC address.
  The stream boost additionally raises the app process (it owns the IPC
  servicing thread and the inject worker, the hops the rig cannot reach) and
  the worker runs at HIGHEST.

### My Devices: the loop, measured on one clock

A My Devices session has its own loop: pointer → the agent's direct input
channel (one SCTP message, no server) → the agent's stream thread injects it →
the next capture → encode → network → jitter buffer → decode → the stage's
`<video>`. Four things in it were cut, and one instrument measures the whole:

- **The latency probe** (`frontend/src/api/devices/latencyProbe.ts`,
  `crates/puca-agent/src/latency.rs`). The desktop stage sends
  `{t:'probe', p}` on the direct channel once a second; the agent injects
  nothing, takes a frame as soon as the floor below allows and sends it even
  on a still screen (re-sending the held picture, with a 1 ms acquire so the
  wait is not counted; never while a security screen blocks the capture, where
  a re-send would hide the blockage), and answers on the caret channel with
  that frame's RTP timestamp, which str0m writes into the header unchanged. `requestVideoFrameCallback` reports each presented frame's
  `rtpTimestamp` and when it is expected on screen, so the probe resolves on
  the viewer's clock alone: input to picture, including both networks and the
  far machine, with no clock agreement between them. The stats chip shows the
  median; the stats panel shows it with the agent's share (`host`: the probe's
  arrival to its frame's send) and **Compare with the old timing** runs eight
  probes each way, alternating, with `q:1` asking the agent for the old
  capture timing — a before-and-after on the same machines in the same minute.
  A probe stands for an input whose change is on screen at once, so it
  measures the loop's own delays and none of an app's redraw. An agent older
  than the probe never answers: three misses while pictures are arriving and
  the stage says so and asks again every half minute (a miss with no picture
  arriving — the stage minimised, a hidden window — proves nothing and is not
  counted). Nothing is probed while control is paused, and a probe is not
  activity: it never feeds an unattended session's idle clock. Only the direct
  channel carries a probe: on the relay it would reach the host app, which has
  no frame to answer with. A media restart starts the RTP clock again; frames
  from before it are dropped, so they cannot answer a new probe.
- **A change is taken as it appears** (`latency.rs`, `may_capture_early`).
  The agent captures on a fixed clock, so a change an input made waited for
  the next tick once it was on screen: half a frame on average, a whole one at
  worst (17 / 33 ms at 30 fps). After an input the agent now watches for up to
  100 ms, looking for a new frame every 2 ms, and takes the first one the
  compositor presents; the clock carries on from it. A look that finds nothing
  leaves the clock alone, and no frame is ever taken sooner than a whole frame
  interval after the last one sent, so the session's frame rate — and with it
  the encoder's bitrate, spent as bitrate/fps per frame — is never exceeded.
  Nothing is watched while a security screen blocks the capture: each look
  would ask DXGI to rebuild the lost duplication, and input kept re-arming
  the watch. The gain is on a screen that was still, most of what a pointer and keyboard
  do on a desktop: a menu, a typed letter or a highlight is captured within
  about 2 ms of being drawn. A screen that changes every frame by itself (a
  game, a video) is captured at the frame rate as before; only a higher frame
  rate helps it. The first version pulled the next tick in to 2 ms after the
  input and allowed half an interval: it usually captured before the app had
  redrawn and then waited a whole frame from there, which could show a change
  LATER than the old clock, and under continuous input on a busy screen it
  doubled the frames and the bitrate. Measured in `latency.rs`'s tests: input
  every 8 ms on a picture that changes every frame stays at 30 frames a second
  at 30 fps.
- **60 fps on your own network.** A desktop stage whose picture comes over
  the local network itself — both ends of the selected ICE pair host
  candidates, the far one on a private or link-local address
  (`frontend/src/api/devices/lanPath.ts`; the stats' "direct" alone means
  "not relayed", which includes a NAT-traversed path across the internet) —
  over UDP with a round trip under 15 ms, still on the default quality, steps
  up once to 60 fps / 10 Mbps and says so. It steps back down once, and says
  why, if the path stops being the local network or two readings in a row
  lose 2% of their packets (the agent has no congestion control to do it);
  a quality somebody picked since is left alone.
- **8 ms move coalescing on the direct channel** (`MOVE_INTERVAL_DIRECT_MS`):
  the relay's 16 ms exists for the relay's per-event cost, which the direct
  channel does not pay.
- **The pointer drawn here.** A desktop stage takes the pointer from the host
  (the `set-cursor-owner` handshake the phone's trackpad uses), so the browser
  draws your own mouse pointer over the picture with no delay, and the agent
  reports the host's pointer SHAPE as a CSS keyword when it changes
  (`crates/puca-agent/src/pointer_shape.rs`: the standard Windows pointers by
  their shared handles, the arrow for one an application drew itself, and
  `none` only while a program has TAKEN the pointer — hidden and confined, a
  game in mouse-look; Windows also hides it on a machine with no mouse and
  while you type in some apps, and then the arrow is drawn, since the agent is
  not drawing one). **Mouse › Draw the pointer here (no delay)** turns it off;
  Game mode hands the pointer back, because pointer lock hides this one, and
  so does pausing control: watching, the host's own pointer is the one to
  see. An agent too old to report shapes (it still gives the pointer up when
  asked) is found by its silence: no shape within 3 s of the hand-over, and
  the pointer goes back to the host for the rest of the session. Such an
  agent reports no captured pointer either, so the Game mode hint never
  appears for it; the Mouse menu's Game mode still works.

## Testing note

Everything up to the OS boundary is verified with automated tests (relay
round-trips, session binding, teardown, rate limiting, release-on-teardown,
the negotiated lane and its valve). The raw `SendInput` injection and the
low-level hook can only be exercised in a real desktop build with a live share
— build with `npm run tauri:build`, share a screen, and have a second user
request control. The end-to-end latency of the whole loop is measured by
`frontend/e2e/rc-latency-2peer.mjs` (header explains what it can and cannot
reproduce).
