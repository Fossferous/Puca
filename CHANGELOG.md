# Changelog

User-facing changes per release, newest first. The desktop updater shows the
one-line summary; this file is the full story. Versions follow
`frontend/src-tauri/tauri.conf.json`.

## 0.9.3 — 2026-09-05

### Security
- **Direct messages are now sealed under keys your password cannot unlock.**
  Until now a DM was sealed under a key derived from both people's identity
  keys — and your identity key is what your password unwraps, so someone with
  a copy of the server's database who cracked your password could read every
  DM you ever exchanged. Each DM is now sealed under a fresh random key that is
  wrapped only to your devices' session keys and to your account's history key,
  whose private half is wrapped under your 12-word recovery code and nothing
  else. A cracked password reads none of them. On a new device, new messages
  arrive as usual; older ones show as locked until you enter the recovery code
  there — it stays until that device signs out. **Accounts from before this release turn it on by generating a
  new recovery code in Settings → My Account**; a conversation switches only
  when both people have, and every device either of you has used in the last
  two weeks can read the new format — nothing you have installed is sent a
  message it cannot open. Messages from before the switch stay as they were.
  This is not per-message forward secrecy; the security model says exactly
  what it is.
- **The server cannot add itself as a reader of those messages.** Every key a
  message is sealed to — each device's session key and the account's history
  key — is signed by the account, and a sender checks each signature before
  using it. The signing key itself is vouched for to each contact under the
  two identity keys already pinned between them (the ones the safety number
  covers), in a form the server cannot compute. A key the server lists on
  its own is ignored; a signing key it substitutes fails that check and the
  conversation stays as it was. Published keys are write-once, so a stolen
  session token cannot replace them.
- **Sign-in timing no longer depends on your password.** The secret exponents
  in the SRP exchange go through a fixed-width Montgomery ladder with exponent
  blinding.
- **A message that was never encrypted, in a conversation that is, is now
  labelled as such.** Every plaintext row already carried a "Not encrypted"
  tag. One that arrives *after* the conversation was carrying sealed messages
  — which no app of ours would write — is now badged "Not encrypted —
  unexpected" in red: the server, or someone with its database, put it there.
- **Your sign-in verifier is now derived with Argon2id.** The server never sees
  your password; what it stores is an SRP verifier, and until now that verifier
  was derived with two plain SHA-256 calls — so someone holding a copy of the
  database could test guesses against it about ten thousand times faster than
  against the Argon2id-wrapped identity key beside it. New accounts, password
  changes and every kind of reset now derive the verifier at the same Argon2id
  cost as that wrap. **Existing accounts move across automatically the next
  time you sign in** from a current client: the app proves your password the
  usual way and, in that same exchange, hands the server a replacement
  verifier, which it accepts only because the proof succeeded. There is no
  separate "upgrade" request that a stolen session could call. Until you sign
  in, your account keeps the old verifier; a database copy taken before then is
  as attackable as it always was.
- Older clients keep working: a client from before this release still signs in
  and can still register or reset a password, and the server records which
  derivation such a client used rather than assuming the new one — assuming it
  would have locked those accounts out of every current client. **One
  consequence:** once you have signed in from a current app, an app from before
  this release can no longer make a *fresh* sign-in to that account until it
  updates; already-signed-in ones are unaffected. Desktop updates itself and the
  mobile app updates over the air.
- **The Windows build can now sign its binaries.** Nothing changes until a
  certificate exists: with none configured the build is unsigned exactly as
  before. When one is (an environment variable; see `docs/CODE_SIGNING.md`),
  the app, the installer and the helper binaries are signed in the one order
  that keeps auto-update working.

### Added
- **Linux hosting transport (groundwork; the Linux desktop app is still
  unreleased).** The Linux helper that captures the screen and injects input
  (X11) has existed for a while; what it lacked was any way for the desktop app
  to reach it — on Windows that is a named pipe. It now has a Unix socket:
  owner-only (0700 directory, 0600 socket), one client at a time, and every
  connection's uid checked by the kernel before the token handshake. Exercised
  end to end against the built helper, headless. A full controller session
  through a Linux host has not yet been run; the FAQ says exactly where that
  stands.

### Changed
- The Lite build's description now says what it is: it cannot be remotely
  controlled (no host agent is installed), but it is not a build with the
  screen-capture code compiled out — no build that can share a screen could
  be. The README, the FAQ and the installer text were corrected.
- A new FAQ (`docs/FAQ.md`) says what works on each platform, and the security
  model now says that the client — not the server — is what marks a message
  that was never encrypted.
- **Opening a voice channel no longer drops you into a silent call.** On a
  browser that cannot end-to-end encrypt live media (Firefox, Safari, iOS) with
  “Require encryption for calls” on — the default — the app used to auto-join
  the channel anyway, muting you and everyone else by design, and only then
  show the notice explaining why. The notice now comes first and the auto-join
  does not fire; Join Voice is still there if you want it, and the notice says
  what to do instead: a Chromium-based browser, or the Windows or Android app.
- **Turning that setting off now says what you get.** With encryption not
  required, the same browsers used to join with no notice at all, which read as
  “encrypted anyway”. A warning now sits above Join: the call will be
  transport-encrypted only, and the server can access your voice and video.

### Fixed
- **Updating part of your profile no longer fails.** Changing, say, your bio
  without also changing your status hit a bad SQL placeholder and returned an
  error; the query is now built from the fields actually present.

### Upgrading
- **Update the server first, then the clients.** A current client refuses to
  create an account or change a password against a server older than this
  release: that server could not record which derivation produced the
  verifier, and the account would never sign in again. An older client keeps
  working against the new server — it signs in, reads and sends — as rehearsed
  with a real 0.9.2 client against this backend.
- If you have enrolled a computer as a remote-control host, its background
  service holds sessions of its own. Sessions it created before this update
  count as "recent" for up to two weeks, so forward-secret DMs to and from
  that account may start up to two weeks after the update rather than at once.

## 0.9.2 — 2026-09-03

A follow-up to 0.9.1 for one problem that could not fix itself, plus the
groundwork for publishing the source.

### Fixed
- **"Live connection failed" that never cleared.** If you updated from an older
  release, the pre-rename `app.exe` was left in your install folder, still
  launchable — and a taskbar pin aimed at it started a months-old client rather
  than failing. That client cannot open a live connection to a 0.9.1 or newer
  server: it signs in, then shows a connection error blaming your firewall,
  which nothing on that screen can fix. The installer now removes the
  superseded binary and stops the background helpers that were holding their
  own files open and preventing replacement. **If you have a pin that still
  misbehaves, unpin it and pin again from the Start Menu.**
- **That error screen told you two untrue things.** It said the problem
  "usually clears by itself" while nothing was retrying, and it blamed a
  firewall — the least likely cause. It now says what actually happened, and
  when your copy is out of date it says so and offers the update.
- **A backend restart no longer throws an error at everyone connected.** The
  app gave up reconnecting after about three seconds, which is shorter than a
  restart takes, so every server update produced an error dialog for a
  condition that resolves on its own. It now waits about fifteen.
- **The source link the licence requires is reachable.** Settings → App Info
  shows the licence and links the source of the version your server runs, which
  the AGPL entitles you to and which previously existed only as an endpoint
  nobody could find.

### Changed
- Documentation now states what the software does rather than what was once
  planned: that the installers are unsigned and warn on first run, that
  encrypted call media needs a Chromium-based browser, and that search runs on
  your own device over the conversation you have open.

## 0.9.1 — 2026-09-03 (the launch release)

Everything the launch-readiness pass found, in one update.

### Added
- **Download your data.** Settings → Privacy & Safety will produce a single
  JSON file holding your account's own rows — profile, memberships, friends,
  the messages you wrote, tasks, uploads, devices and preferences — decrypted
  on your own machine by your own keys, with anything this device cannot open
  left as ciphertext and counted in the summary. It asks for your password,
  and allows one export a minute. Other people's messages are not included:
  they are theirs.
- **A plain statement of what leaves your device and what your server can
  see**, in Settings → Privacy & Safety, next to the export. It names the
  metadata a server operator can read, what it cannot read, and the two
  places anything is fetched from a third party.

### Fixed
- **Voice hotkeys that worked about half the time.** Push-to-talk, mute and
  deafen from inside a game now come from two independent sources: the system
  hook, and a 20 ms check of the physical key state that catches a press or
  release the hook missed. Windows removes a hook without warning when the
  machine is loaded, and a key released on a security prompt was never seen
  at all; one lost release used to leave push-to-talk open and swallow the
  next press too, which is why it felt like every other press worked.
  Hotkeys could also vanish whenever the app wrongly believed it still had
  focus while a game was in front, and for a mouse button pressed with the
  pointer outside the window; the answer now comes from Windows itself. Keys
  sent by a gaming mouse's own software (G HUB, Synapse) or by AutoHotkey
  were being ignored as "injected"; only Púca's own remote-control input is
  now. A game going fullscreen mid-call used to restart the whole hotkey
  system, closing a held push-to-talk. A Ctrl or Shift pressed in the same
  instant as its key could go unseen by a toggle. A hotkey on a mouse button
  no longer stops working while the message box you type in has focus, and a
  quick settings change can no longer leave one keypress handled twice. If a
  game runs as administrator, Windows hides its keys from every program that
  does not, and Púca now says so in a banner instead of failing silently.
- **Taskbar pins and shortcuts left dead by the 0.9.0 rename.** 0.9.0 renamed
  the program file from `app.exe` to `Puca.exe` (`Puca-Lite.exe` for Lite), and
  a taskbar pin you made yourself kept pointing at the old name. This update's
  installer repairs every pin and shortcut of ours that no longer resolves. If
  a pin still shows an error afterwards, unpin it and pin Puca again from the
  Start Menu.
- Password-reset and email-verification tokens are stored hashed on the
  server; a database dump no longer contains a usable reset link.
- The obsolete `sessions` table (raw login session keys, written by nothing
  since 0.9.0) is dropped.
- **Updates could stop looking after one wrong answer.** The desktop and
  mobile update checks try more than one address; a reply from something that
  was not Púca used to end the search instead of moving on to the next one,
  leaving the app on an old version with no sign anything was wrong. The
  failure message now names what would help.
- Joining a call from Firefox, Safari or iOS now says up front that the
  browser cannot encrypt live media, and what your options are, instead of
  the call simply being silent in one direction.
- Sharing a folder that sits on a network drive is refused when you pick it,
  naming the reason, rather than being accepted and then failing on every
  browse.

### Security
- Keystrokes sent by someone controlling this machine through My Devices
  still cannot trigger its owner's hotkeys. The new key-state check added
  for reliability reads the same table Windows fills for injected input, so
  it is explicitly blinded to keys Púca itself is injecting.

### Changed
- **Deleting your account now also removes the files you uploaded** —
  attachments, your avatar, sounds — after a 30-day grace period (operators
  can set `DELETED_ACCOUNT_FILE_GRACE_DAYS`). Server icons and custom emoji
  you contributed stay with the server. The deletion screen says so.
- On the desktop, the "remember this device" seed for unattended remote
  control is sealed with Windows data protection (DPAPI) instead of being
  kept in the app's web storage.
- The WebSocket no longer accepts a session token in the URL; every app
  since 0.9.0 sends it in a header. A native background helper older than
  0.9.0 updates together with the desktop app.

### For self-hosters
- Relay (TURN) responses are verified for integrity end to end; the check has
  been proven against a production coturn.

## 0.9.0 — 2026-09-03

### Added
- Sign out on one device without touching the others, and revoking a device
  from the Devices tab now really ends its sessions.
- Invites are a permission (Create Invites); attaching files is honoured at
  the upload door; camera and screen share are permission-checked before a
  single frame is sent, and other people's video is shown only once the
  server has confirmed it.
- Messages show an "(edited)" marker.

### Fixed
- In-app password change was refused on 0.8.136; it works again.
- Invite links expired early on servers whose database runs in a non-UTC
  time zone.

### Security
- File transfers and mesh calls pin the other side's connection certificate
  through the identity-authenticated handshake; channel keys are bound to
  their channel and epoch; deleting an account scrubs device shares, wrapped
  keys and device names; the agent's file jail and relay handling were
  hardened; offsite backups refuse to ship unencrypted.

### Changed
- The Windows program file is now `Puca.exe` / `Puca-Lite.exe`.
- Existing remote-control file grants under system folders (AppData,
  Program Files) are refused from this version on.

Older releases: see the git history of `frontend/src-tauri/tauri.conf.json`.
