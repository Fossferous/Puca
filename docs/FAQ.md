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
over: there is no forward secrecy for message history, and identity keys are
trust-on-first-use, so a server that is malicious *the first time* you meet
someone can substitute a key. [`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md) is
the honest version, written for a reader who does not trust the project.

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
| **Being** controlled | **yes** | not yet | no | no | no |
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

**Being controlled is Windows-only today**, and that is the one real gap. See
below for why.

## Why is remote control one-way outside Windows?

Because controlling and being controlled are completely different jobs.

**Controlling** is web code. The controller sends input over the same sealed
channel that carries everything else, so any browser can do it — there is nothing
platform-specific to port.

**Being controlled** needs native screen capture and input injection. On Windows
that is DXGI Desktop Duplication and `SendInput`. Ports of both **already exist
for Linux** — X11 capture via MIT-SHM and injection via XTEST — and their live
tests pass against a real X server. What is missing is the pipe between the
desktop app and the helper process that does the capturing: on Windows it is a
named pipe, and there is no Unix-socket equivalent yet. Until that exists, a
Linux machine cannot be a host no matter how good the capture code is.

macOS has no capture or injection backend at all. That is genuinely unwritten,
not merely unwired.

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
you have to choose **More info → Run anyway**. Antivirus heuristics sometimes go
further: Defender quarantined v0.8.82 as a false positive.

That is also why **Púca Lite** exists — it compiles the screen-capture and
input-injection machinery out of the binary entirely, which is what those
heuristics react to. Lite is unsigned too and gets the same prompt. Verify any
download against the published `SHA256SUMS.txt`.

## Full or Lite — which do I want?

Both do chat, voice, video, screen-share *viewing* and file transfer. **Full**
adds My Devices: remote desktop, remote input and Wake-on-LAN. **Lite** has that
code compiled out, not merely switched off, for people who would rather not have
capture machinery on their machine at all.

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
