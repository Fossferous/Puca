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
but messages from before that, and anything a stolen device was sent during its
session, are not covered, and there is no per-message ratchet.
[`docs/SECURITY_MODEL.md`](SECURITY_MODEL.md) is the honest version, written for
a reader who does not trust the project.

## Why does it ask for my recovery code on a new device?

Because your password deliberately cannot unlock your message history any more.
When you sign in on a new device with just the password, new direct messages
arrive normally; older ones show as locked until you enter the 12-word recovery
code on that device — once, and it stays there. Entering it is what proves you
are you and not someone who cracked the password against a copy of the server.
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
