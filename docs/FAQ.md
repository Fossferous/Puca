# FAQ

Written to be checked against the code rather than to sell anything. Where
something does not work, this says so.

## What is Púca?

Chat, voice, video, screen sharing and remote desktop access to your own
machines — running on a server **you** control. There is no hosted service, no
account with us, and nothing to opt out of. Your server talks to nobody but the
people you invite.

## What can the server see?

Not your messages. Message bodies, attachments, and call media are encrypted on
your device; the server stores ciphertext and forwards it. It necessarily sees
**metadata** — who talks to whom, when, and how much — because it has to route
the traffic.

Two things are deliberately not hidden, and are documented rather than glossed
over. Identity keys are trust-on-first-use, so a server that is malicious *the
first time* you meet someone can substitute a key. And forward secrecy is
partial: since 0.9.3, direct messages are sealed under keys your password cannot
unlock — a copy of the database plus a cracked password reads none of them —
but messages from before that, and anything a stolen device was sent while it was
signed in — and, if your server is dishonest, afterwards too, because revoking a
session is something the server enforces rather than the maths — are not covered,
and there is no per-message ratchet. A computer someone else has copied cannot be
un-trusted by revoking it; treat that as the account itself being compromised.
[`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md) is the honest version, written for
a reader who does not trust the project.

## Why does it ask for my recovery code on a new device?

Because your password deliberately cannot unlock your message history any more.
When you sign in on a new device with just the password, new direct messages
arrive normally; older ones show as locked until you enter the 12-word recovery
code on that device. It stays there until you sign out of that device (signing
out removes it, and you will be asked for the code again). Entering it is what
proves you are you and not someone who cracked the password against a copy of
the server. The server cannot quietly add itself as a reader either: every key
a message is sealed to is signed by the account it belongs to, that signing
key is vouched for between the two of you in a form the server cannot forge,
and the app checks both before using any key.
If you never saved your code, generate a new one in **Settings → My Account** on
a device that already has your history unlocked (the app refuses to let a device
that does not hold the history key retire the old code, because that would lock
your history for good).

Accounts created before 0.9.3 do not have this on until their owner generates a
new recovery code from a current client; a conversation moves to the new format
only when both people have done that and every device either of you has used in
the last two weeks can read it. Nothing you already have installed is ever sent
a message it cannot open.

## What does it cost to run?

One small VPS. Two vCPUs and 2 GB of RAM is enough for a group of friends. The
only recurring costs are that box and a domain. Voice beyond a couple of people
needs a TURN relay, which the deployment guide sets up on the same machine.

---

## What works on which platform?

This is the question with the most surprising answer, so it gets a table. "Works"
means someone has actually run it, not that the code exists.

| | Windows | Linux | macOS | Android | iOS / iPadOS |
|---|---|---|---|---|---|
| Chat, DMs, files (E2EE) | native app | browser | browser | native app | browser |
| Voice & video calls | yes | yes | yes | yes | yes |
| **Encrypted** call media | yes | Chromium browsers | Chromium browsers | yes | **no** |
| Watching a shared screen | yes | yes | yes | yes | yes |
| Sharing *your* screen | yes | browser | browser | — | — |
| **Controlling** another machine | yes | **yes, in a browser** | **yes, in a browser** | yes | yes |
| **Being** controlled | **yes** | in progress (below) | no | no | no |
| Native desktop app | **shipped** | builds, unreleased | builds, unreleased | n/a | n/a |
| Notifications while closed | yes | no | no | yes | no |

### The short version for non-Windows users

**You are not locked out.** Everything except *being remotely controlled* works
in a browser on Linux and macOS, including driving someone else's Windows
machine. The web app is the same application the desktop app runs, not a cut-down
version.

Controlling is also the best-exercised path in practice: **Android is where most
real-world remote-control use has happened**, and it works well. That matters for
Linux and macOS users because the controller is the same web code on every
platform — there is no per-platform controller to port, which is exactly why it
works everywhere and why the *host* side does not.

**Being controlled is Windows-only in the apps you can download today.** The
Linux desktop build now carries the piece that was missing (below); it is not
yet released. See below for what that does and does not mean.

## Why is remote control one-way outside Windows?

Because controlling and being controlled are completely different jobs.

**Controlling** is web code. The controller sends input over the same sealed
channel that carries everything else, so any browser can do it — there is nothing
platform-specific to port.

**Being controlled** needs native screen capture and input injection. On Windows
that is DXGI Desktop Duplication and `SendInput`. Ports of both **already exist
for Linux** — X11 capture via MIT-SHM and injection via XTEST — and their live
tests pass against a real X server. The last missing piece was the link between
the desktop app and the helper process that does the capturing: on Windows a
named pipe, and until 0.9.3 nothing at all on Linux. That link now exists — a
Unix socket, owner-only (a 0700 directory, a 0600 socket) and with every
connection's uid checked by the kernel before the token handshake — and the
Linux helper has been exercised over it end to end, headless. What has **not**
happened yet is a full session: a controller driving a Linux desktop through the
Linux app on a real X11 session. That needs the Linux desktop build to be built
and run, which nobody has done outside CI. So: the code is there; the claim is
not yet. Unattended access (the Windows service that answers at the lock screen)
has no Linux counterpart at all.

macOS has no capture or injection backend at all. That is genuinely unwritten,
not merely unwired.

## Remote control is laggy or soft on my phone. What can I do?

First, copy the diagnostics (the session menu has a **Copy diagnostics**
button) and look at three lines: `path`, `frameSize` and `decoder`.

**`path: RELAY (via TURN)` on your own network** means the two ends could not
reach each other directly and are bouncing off the server. Since 0.9.812 the
host advertises the address that actually reaches the viewer even when a VPN
holds its default route, so on a current host this should read direct. If it
still relays, the usual cause is a VPN on the *phone* or a guest Wi-Fi that
isolates clients; turning it off for the session is the quickest test.

**`frameSize`** is what the host is sending. Since 0.9.813 the viewer
tells the host how large it is showing the picture, and the host
scales the picture down to fit before encoding — a 1440x2560 monitor viewed on
a phone held sideways arrives as 720x1280, a quarter of the pixels to decode
and to send, and the same picture on screen. Pinch to zoom and the detail comes
back. If you would rather always have the native picture, the **Resolution**
control on the desktop stage (**Fit to this screen** / **Full resolution**), or
the **Scale the picture to this screen** switch in the phone's quality menu,
turns the fit off.

**`decoder`** names what your phone is decoding with, and `hardwareDecode`
whether that is the hardware decoder. A software decoder on a large picture is
the slow case the fit exists for; if you see one on a *small* picture, that is
worth reporting with the diagnostics attached.

## The keyboard works but the mouse does nothing. What do I send?

Keep driving while you copy the diagnostics: tap **Copy diagnostics** in the
phone's Mouse menu, close the menu, and drag a finger around for the five
seconds it measures. Then look at:

- **`windowInputByKind`**: what left the phone during those five seconds. No
  `move` while you were dragging means the phone never sent any; plenty of
  them means they reached the host and the question is on that side.
- **`stageInput`**: `mouseMode` (trackpad or touch), `gesturePhase` and
  `gestureContacts` (the trackpad reading `pinch` with one finger down is a
  stuck gesture; switching Touch and back clears it), and `cursorOwned` /
  `cursorDrawn` (whether the phone is drawing the pointer, since the host
  stops drawing its own once the phone takes over).
- **`inputLane`**: whether input is going over the direct channel or the relay.

On the host, the agent's log has one `[input-rx]` line a second per lane while
input arrives, plus one for the last burst when a session ends: exact counts of
moves and clicks and how many were refused, but keyboard activity only as
`keys=0`, `some` or `many` (the log is readable by anyone on that machine, and
an exact count would give away how long a PIN is). It also has an `[aim]` line
for each session, and again whenever the screen the mouse is aimed at changes,
and, at the sign-in screen only, an `[input] move on 'Winlogon'` line comparing
where a move asked the pointer to go with where it actually is. Send those
lines with the diagnostics.

## I pinned Púca to my integrated GPU. Does that cover screen sharing?

It does now. It did not before, and the reason is worth knowing.

Windows lets you pin an app to a GPU (**Settings > System > Display >
Graphics**). Some people pin Púca to the *power saving* GPU on purpose: with a
game using all of the discrete card, moving the app off it is what stops the
share looking choppy to viewers. The catch is that Windows keys the pin to one
executable path, and the share is not captured or encoded by `Puca.exe`. That
work happens in the WebView2 runtime the app is built on — a separate program,
`msedgewebview2.exe`, whose path includes the runtime version:

```
C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<version>\msedgewebview2.exe
```

WebView2 updates itself about once a month, the path changes, and a pin on the
old path quietly matches nothing.

So on every start the desktop app checks whether `Puca.exe` itself is pinned
and, if it is, writes the same preference for the runtime it is about to
start — before the runtime is up, so the current session is covered, not just
the next one. Entries for runtime versions that are no longer installed are
removed at the same time. It touches only your own user's settings, so there is
no administrator prompt, and only that one key.

- **If you have not pinned Púca, nothing happens.** No entry is created and the
  key is not touched. Pinning in Settings is the switch.
- **The runtime follows whatever you chose.** Pin Púca to *high performance*
  and the runtime gets that instead. Set Púca back to *Let Windows decide* and
  the runtime's entry follows at the next start.
- **WebView2 is shared.** Outlook, Teams, the Windows widgets and many other
  apps run the same `msedgewebview2.exe`, and Windows applies a pin to every
  process with that path — so pinning it for Púca pins it for them too. That
  is how the pin works, and it is exactly what pinning the runtime by hand
  does; there is no way to pin only Púca's copy.
- **To undo it,** set Púca back to *Let Windows decide* (or unpin it) and
  remove the `msedgewebview2.exe` entry from the same Settings page if it is
  still there. The app never removes an entry for a runtime that is still
  installed.
- The app's log (`%LOCALAPPDATA%\com.sovereign.chat\logs\puca.log`) records
  what was done in a line starting `[gpu-pin]`.

Clips are a separate story: the replay buffer records through the capture
helper precisely because a pinned process cannot duplicate the screen — see
[`docs/CLIPS.md`](CLIPS.md).

**Why the registry and not a browser flag?** (For self-hosters and the
curious.) Chromium accepts `--use-adapter-luid=<high>,<low>` to start its GPU
process on a particular adapter, and WebView2 appends the
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable to an app's
arguments, so Púca could pass that at startup instead of writing a pin. The
flag does work: measured on 2026-09-16 in headless Edge 153 — the same
Chromium build as that day's runtime — on a machine with an RTX 4080 SUPER and
an AMD integrated GPU, the flag moved the GPU process from the NVIDIA card to
the AMD one (`GL_RENDERER` went from `ANGLE (NVIDIA, ...)` to `ANGLE (AMD,
...)`). It was still not adopted: an adapter's LUID is assigned afresh at every
boot, so the value would have to be computed at every start anyway; the flag
steers only the GPU process's rendering device, while the Windows pin covers
every process of the runtime, including the browser process that captures the
display; and the Windows pin is the mechanism people have actually measured a
smooth stream with, so the flag would be a different configuration from the one
known to work. The app applies the OS feature to the right file, nothing more.

## I use Linux. Should I expect a desktop app?

Not yet, and the honest state is: the desktop app **compiles** for Linux and CI
now proves it on every push, but nobody has shipped or run it in anger. Several
features are deliberate stubs there — clip capture and per-app audio return "only
supported on Windows" rather than pretending.

Two limitations are worth knowing if you do build it, both **measured** rather
than assumed:

- On a **compositing** X server (which most modern desktops are), full-desktop
  capture returns black. Per-window capture works. The tests report this
  explicitly rather than failing on it.
- Under **Wayland/Xwayland**, absolute pointer positioning cannot reach the whole
  desktop — the server confines it to one output.

Neither affects a plain X11 session. Proper Wayland support means the PipeWire
and RemoteDesktop portals, which is a separate project.

## Why can't Firefox or Safari do encrypted calls?

Frame-level media encryption needs **Insertable Streams**, which only
Chromium-based browsers implement. Púca does not quietly downgrade you:
"Require encryption for calls" defaults on, so it tells you before you join and
blocks the media instead. You can turn that setting off in **Settings → Privacy
& Safety** to proceed with transport encryption only — the call is still
encrypted in transit, just not end-to-end.

## Is there an iPhone app?

No, and there is unlikely to be one soon. Publishing to iPhones requires a paid
Apple Developer account; without one, nothing built can be installed on anyone
else's device. The browser works well — add it to your home screen — but iOS
gives web apps no way to notify you while closed, so you will not get message
alerts.

## Why does Windows warn me when I install it?

Because the installers are **not code-signed**. There is no Authenticode
certificate, so SmartScreen shows "Windows protected your PC" on first run and
you have to choose **More info → Run anyway**. A certificate costs money
annually and ties a legal identity to the binary; there isn't one yet.

## After I updated, my old device can't sign in

Since 0.9.3 the first sign-in from a current app replaces your account's password
verifier with a much stronger one (Argon2id). Devices that are already signed in
keep working. A device still running an app from before 0.9.3 cannot make a
*fresh* sign-in to that account until it updates — it computes the old verifier
and the server, correctly, will not accept it. Desktop updates itself and the
Android app updates its bundle over the air, so this only affects an install that
has done neither.

## My antivirus called it a trojan. Is it?

No — but the warning is not stupid either, and you should understand why before
you dismiss it.

Microsoft Defender flagged the v0.8.82 build as **`Trojan:Win32/Bearfoos.B!ml`**
on a real user's machine. The `!ml` suffix means a machine-learning classifier,
not a signature match for known malware — nothing had been found *in* the file.

Look at what the remote-control agent legitimately does: it captures the screen
with no on-screen indicator, synthesises keyboard and mouse input, and opens
outbound network connections on its own. That is a precise description of Púca's
My Devices feature. It is also a precise description of a remote-access trojan.
A behavioural classifier cannot tell the difference from the binary alone, and an
**unsigned** binary that does those things scores worse still.

What is done about it:

- The agent and service binaries carry a full Windows version resource — product
  name, company, description — so they say what they are in Task Manager. A
  nameless process doing those things is exactly what someone hunting malware is
  taught to distrust, and they would be right.
- **Púca Lite** exists partly for this: it does not ship the agent or service
  binaries at all, so the executable that gets flagged is simply not on your
  disk. Be clear on what that does *not* mean, though — Lite still shares your
  screen and records clips, so screen-capture code is still inside the Lite app
  itself, and always will be. What is gone is the unattended host: nothing in a
  Lite install can capture your desktop without you starting it, or synthesise
  input at all. Lite is unsigned too, so SmartScreen still prompts.
- Every release publishes `SHA256SUMS.txt`. Check your download against it —
  that tells you the file is the one that was built, which is a different and
  more useful guarantee than an antivirus verdict.

Since the source is public, you can also read exactly what the agent does, or
build it yourself and trust your own binary. If Defender quarantines a build,
submitting it to Microsoft as a false positive genuinely helps, because these
classifications are per-file-hash and each release is a new file.

## Full or Lite — which do I want?

Both do chat, voice, video, screen sharing *and* clips, and file transfer.
**Full** adds My Devices: remote desktop, remote input, Wake-on-LAN and the
remote file browser. **Lite** has that code compiled out rather than switched
off, and does not bundle the agent or service helper binaries.

Take Lite if you do not want your machine to be remotely controllable. Note the
distinction, because it is easy to overstate: Lite is not a build with no
screen-capture code in it — sharing your screen and clipping both need that
code, so it is present. Lite removes the ability to *be a host*, not the ability
to capture.

They are mutually exclusive on one machine but share their data, so switching
keeps your session, keys and history.

## Do I have to use Firebase for notifications?

No. Push is optional. Without it the Android app keeps its own connection to
*your* server, and the wake signal — if you enable it — carries a fixed payload
of `{"w":"1"}` and nothing else: no sender, no preview, no content. A push
provider is told that something happened, never what or by whom.

## I found a security bug.

Please use GitHub's **private reporting** — the Security tab → *Report a
vulnerability*. Do not open a public issue for anything exploitable.
[`SECURITY.md`](../SECURITY.md) explains scope and what makes a report useful,
and lists the limits that are already known and accepted.

## Can I use it commercially? Can I fork it?

Yes to both. Púca is [AGPL-3.0-or-later](../LICENSE): use it, study it, modify
it, run it for your company, fork it. The main condition is that if you run a
**modified** version and let others use it over a network, you must offer them
your source.

If that does not fit — closed-source embedding, a hosted service keeping its
modifications private — [`COMMERCIAL-LICENSE.md`](../COMMERCIAL-LICENSE.md) is
an offer to negotiate other terms. The name and logo are separate from the code
licence; see [`TRADEMARK.md`](../TRADEMARK.md), which permits nearly everything
except shipping a modified build still called Púca.
