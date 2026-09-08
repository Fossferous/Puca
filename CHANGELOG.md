# Changelog

User-facing changes per release, newest first. The desktop updater shows the
one-line summary; this file is the full story. Versions follow
`frontend/src-tauri/tauri.conf.json`.

## Unreleased

### Security
- **A file uploaded without a capability could be downloaded by any signed-in
  account that learned its id.** Message and DM attachments were never
  exposed (the apps ask for a capability and encrypt them), but avatars,
  custom join/leave sounds, server icons and emoji are uploaded without one,
  and `GET /files/:id` served any capability-less file to whoever held a
  valid session — including someone you had banned, for as long as they kept
  the id. Found by a live access-control probe on 2026-09-07. Such a file is
  now served only to its uploader, to the people its owner is visible to
  (friends, a shared server, a conversation they started) for avatars and
  sounds, to members of the server (or anyone, once it is public) for icons
  and emoji, and to viewers of the channel a clip was posted in for its
  parts. Uploads older than the capability migration keep working for every
  account, since nothing can scope them. An attachment a client forgot to
  protect is no longer readable by strangers: it is its uploader's alone.
  No change for ordinary use; `FILES_ENFORCE_CAP=0` lifts the scoping as it
  already did for capabilities.

## 0.9.8 — 2026-09-08

Two failures reported on the same evening — the always-on wake box offline
since the 2nd, and a PC that could not be reached at its Windows sign-in
screen — turned out to be one stale binary and one uninstalled service.
Investigating them turned up a set of defects worth more than either, most of
them things that were quietly costing performance or telling you something
untrue.

### Fixed
- **Sharing your screen no longer takes CPU priority away from your game.** A
  change in 0.9.6 raised the whole app to above-normal priority while a share
  was live, which swept up the clip replay buffer's screen capture along with
  it — the one thing that was never supposed to compete with a game. Only the
  capture and encode processes are raised now.
- **Webcams look far better.** A camera you were not focused on was pinned to
  the lowest quality rung — 320x180 at 15 fps — for the whole call, and
  because nothing ever subscribed to a better one, the sender stopped
  producing it. Cameras now follow the size they are actually displayed at.
- **Remote control stops going the long way round.** The direct
  computer-to-computer path for your mouse and keys never activated for the
  person doing the controlling, so every click travelled to the server and
  back. The handshake that enables it is now answered in both directions.
- **The clip buffer records at the quality you chose.** On a monitor larger
  than the preset assumed, "1080p 60 fps" was recording your whole screen at
  its native resolution and nearly double the bitrate, costing most of a CPU
  core. The frame rate now follows the monitor, so the cost matches the label.
- **The wake button explains itself honestly.** When a machine did not come
  back, it blamed your BIOS even when the reason was that its sign-in-screen
  service had been removed, and it told you to switch on a computer that was
  already on rather than naming the one that was offline.

### Added
- **Watch a webcam beside a screen share.** Cameras now appear in a rail under
  the streams instead of only on the voice screen, and any camera — there or
  on the voice screen — can be made fullscreen. Fullscreen also asks for the
  sharper picture while it fills the display.
- **Automatic clip arming is agreed per server.** Choosing "arm automatically"
  once no longer starts a continuous recording of your screen in every other
  server whose owner turns clips on; each server is agreed to the first time
  you arm there yourself. The setting also explains what it does before you
  pick it, rather than after.

### Diagnostics
- The wake box now reports a refused connection as a refusal rather than a
  network blip, keeps the server's explanation, and fails visibly instead of
  retrying in silence — it had been locked out for five days while looking
  healthy. The server's own refusal now names the cause, the health check
  notices a wake box that is running but being turned away, and the app warns
  when its helper program is not the one it shipped with.
- Latency numbers in the diagnostics log were lifetime averages rather than
  what was happening at the time. They are now measured over a window.
## 0.9.7 — 2026-09-06

A hotfix for the remote-control work in 0.9.6, found by reviewing that change
after it shipped.

### Fixed
- **Ending a control session while input was still queued could leave a key
  or mouse button held down on the shared machine.** The release that ends a
  session is now ordered behind every batch of input queued before it, and a
  batch that belonged to a session which has already ended is dropped instead
  of injected.
- **Refused injections no longer flood the diagnostics log.** When the shared
  machine refuses input (a lock screen, a security prompt, a window running as
  administrator), the log records the first refusal in full, then a short
  summary every ten-fold count or five seconds, then one line when injection
  works again.
- **The diagnostics log keeps about two hours of a control session** (three
  files of 2 MB) instead of truncating within minutes.

## 0.9.6 — 2026-09-06

Remote-controlling a friend's shared screen felt about a second behind. The
loop was measured end to end on one machine (a new rig, below) and the parts
of it the app owns were found and fixed; what a home network adds is now
readable from the app instead of guessed at.

### Fixed
- **Remote-control input now actually travels over the call's own
  peer-to-peer channel.** It never had: both ends created the channel and each
  closed the copy that arrived — which is the peer's own channel — so every
  mouse move and click went the long way round through the server (and the
  edge proxy in front of it) while the app believed it had a direct path,
  with nothing in any log to say so. The channel is now negotiated once per
  connection and survives the end of a control session, so the second session
  in a call is as direct as the first. On a distant server that is two
  internet legs per event less; on the test machine the lane opens on both
  ends within a second of the call connecting.
- **A stalled link no longer banks seconds of stale pointer motion.** The
  motion valve used to engage at 64 KiB of unsent input — five to ten seconds
  of movement replayed late once the link recovered — and, on the direct
  channel, to move frames onto the relay mid-session, where a press and its
  release could arrive out of order. On a direct peer-to-peer call (and on
  the relay) it engages at 4 KiB now (a few hundred milliseconds), holds
  motion in place until the pipe drains, and never changes pipe under a
  session. On an SFU call the valve cannot see the data path's queue yet, so
  it does not engage there.
- **Clicks cannot overtake the move that placed them.** The host used to hand
  the pointer position and the click to the desktop as two separate,
  un-awaited IPC calls with no ordering between them; a click and any motion
  still pending now go as one batch, successive batches are queued in order,
  and there is half the IPC traffic per click.
- **The host's input path keeps its CPU under a game.** The streaming priority
  boost skipped the app process itself — the one that services every IPC call
  and runs the injection worker, the two hops between the host page and the
  desktop — and the worker ran at normal priority. Both are raised while a
  share is watched. (What was measured: with the host page's main thread 60%
  busy, pointer-to-inject-call went from 1 ms to 25 ms typical / 65 ms at the
  90th percentile while the picture moved 5 ms — the input leg is the
  contention-sensitive one, which the batching addresses; the boost is for
  the hops the rig cannot reach.)

### Diagnostics
- `await __pucaMeshDiag(5000)` and `await __pucaVoiceDiag(5000)` measure the
  delay of a share over a five-second window of real use: jitter buffer (and
  the hint the app asked for, read back), processing, decode, encode, the
  sender's pacer, frames parked in the media-encryption transform, and the
  selected network path's protocol and round trip — enough to say which stage
  owns a slow share. An SFU viewer now gets numbers for the tracks it
  subscribes to; before it got none.
- The unattended log sampler runs on both ends of a remote-control session
  on desktop, every second, with the same fields and which pipe the input is
  on (`lane=mesh-dc|sfu-data|relay`); `[p2p-input] peer N: no P2P lane after
  2 s` is logged when a session stays on the relay. A browser or phone viewer
  writes no sampler line (there is no log file to write to): read
  `await __pucaMeshDiag(5000)` from DevTools there instead. The desktop log
  now rotates at 2 MB with two archives kept, so a session's samples survive;
  the default 40 KB file self-truncated within minutes of sampling. While the
  desktop refuses injected input (a lock screen, a UAC prompt, an admin
  window) the log gets the first refusal in full and a count after that, not
  one line per mouse move.
- `frontend/e2e/rc-latency-2peer.mjs` measures glass-to-glass and
  pointer-to-desktop latency of the in-call share on one machine (loopback,
  synthetic desktop): 1080p30 measures p50 ≈ 40–60 ms glass to glass and
  1 ms from the viewer's pointer to the host page's inject call — the floor
  the app's own pipeline sets (the IPC hop, the worker and the OS injection
  are outside the rig).

A readiness pass before the project is advertised looked at what a stranger
meets first — the user guide, the sign-up form at the end of an invite link,
the phone app's settings, the Android app's web view — and at what an operator
needs on the day strangers arrive. Nothing here changes the protocol or the
database.

### Changed
- **The user guide describes the app that ships.** `docs/USER_GUIDE.md` was
  rewritten against the current client: every control is named by the label
  or tooltip you will find in the app (Join a Server, Add Reaction, Edit
  Profile, Upload Avatar, Generate Invite Link, and so on), and the old
  layout drawing, the developer-server address, the emoji drawn as buttons
  and the "Create Text Channel" step that stood where "add a reaction" should
  have been are gone. A lint check now refuses a `localhost:` address or an
  emoji-as-button anywhere in that file, so it cannot drift that way again.
- **An invite link and a sign-up code are told apart on the sign-up form.**
  Some servers require a sign-up code from whoever runs them before an
  account can be created; that is not the code in an invite link, but the
  form called both "invite code". When you arrive by an invite link on such a
  server, the field is now labelled "Sign-up code for this server (not the
  invite link you clicked)" and a line under it explains that the link joins
  you to the server once your account exists. If you paste the link's own
  code there, the error says exactly that instead of telling you to check for
  typos. The invite dialog's share text tells the person sharing to send the
  sign-up code along with the link on such servers. Servers with open
  registration, and sign-ups that did not start from a link, read as before.
- **The phone app no longer offers settings that cannot do anything on a
  phone.** The Keybinds tab, and the Screen control group under Privacy &
  Safety (the remote-control kill-switch hotkey and "Stop when I touch my
  mouse or keyboard"), are hidden in the Android app: a phone has no host
  agent to inject input and no kill switch to bind. The Push-to-talk and
  Push-to-mute key rows under Voice & Video are still there when that input
  mode is selected. The desktop app and the browser are unchanged.
- The security model's "check this yourself" recipe and its threat table now
  say that encryption for calls is required by default (since 0.8.130),
  matching the setting's actual default.

### Security
- **The Android app's web view now carries a Content-Security-Policy.** The
  web origin and the desktop app already had one; the page bundled into the
  Android app had none. Every APK built through the Android build (full or
  Lite) now has a policy equivalent to the web origin's header written into
  its bundled page: scripts only from the app itself, connections only to the
  server the build was made for (and the call server it hands out per call),
  no embedded objects. A build without a usable server address fails at this
  step rather than shipping a policy naming the wrong server. The web app and
  the desktop app are untouched.

### For self-hosters
- **An abuse runbook for the day the instance gets a public audience.**
  `deploy/ops/README.md` now walks through, with every command real and every
  behaviour cited to the file that defines it: rotating the sign-up code and
  exactly what that does to codes already handed out (server invite links
  are unaffected); removing an account and its uploads with `psql`, since
  there is no instance-level admin API; watching storage against the
  per-user quotas, which have no global cap; what kick, timeout, ban, block
  and report each do and where they live; and proving that the rate limiter
  counts per visitor behind Cloudflare. Linked from the deployment guide.
- **The health check now catches a collapsed rate limiter.** On a box behind
  Cloudflare, `healthcheck.sh` asserts every five minutes that the Caddyfile
  carries the global `servers { trusted_proxies … client_ip_headers
  CF-Connecting-IP }` block from `deploy/cloudflare/caddy-behind-cloudflare.snippet`;
  without it every per-visitor limit is keyed on the edge address and the
  whole internet shares one bucket, so one visitor's burst rate-limits
  everyone. A missing block, an unreadable Caddyfile, or the nonexistent
  `{http.request.client_ip}` placeholder each write a FATAL line to
  `health.log` and syslog; the check never edits or reloads Caddy. Two knobs:
  `CADDYFILE` for a Caddyfile that lives elsewhere, and `OPS_BEHIND_CLOUDFLARE=1`
  (or `=0`) to override the Cloudflare detection.

## 0.9.5 — 2026-09-06

A second adversarial pass over the same boundary, this time against 0.9.4,
looked for what a member who has been removed, blocked, or hidden from a
channel could still do or learn. It found twenty-five smaller holes in that
family; all are closed here. The ones you will notice come first.

### Security
- **Invites expire after 7 days unless you choose otherwise, and stop working
  when the person who made them leaves.** Both invite dialogs now offer 1 hour
  to 30 days or Never and preselect 7 days; an invite created without choosing
  gets 7 days (a client older than this release that picks Never gets 7 days
  too, until it updates — never-expiring codes now have to be asked for
  explicitly). When the member who created an invite is kicked, banned, leaves
  the server, or deletes their account, every invite they created is revoked
  on the spot, and invites whose creator had already left are removed on
  upgrade. The invite list shows who created each code, and creating or
  deleting one is written to the server's audit log.
- **Blocking someone also unfriends them** and withdraws any pending friend
  request between you; unblocking does not put the friendship back. Someone
  you have blocked, or who has blocked you, no longer sees whether you are
  online anywhere: not in the live online/offline notices, and not in the
  member list of a server you share, its members-with-roles list, or user
  search, where you now always read as offline to them. A friend request
  across a block is a real request on the sender's side — sending it again
  says "already pending", it sits in their outgoing list — but the other
  person never sees it: it is missing from their incoming list, and accepting
  or rejecting it by id answers "not found"; unblocking discards it, which to
  the sender looks like a rejection. Blocking an id that does not exist, or a
  deleted account, answers the same empty success as blocking a real one and
  writes nothing. On upgrade, every friendship and every pending friend
  request still sitting beside a block made before this release is removed
  once (migration 063), so people you had blocked disappear from your friends
  list without any action from you; unblocking one of those older blocks
  clears anything that pass left behind.
- **A role with Manage Channels no longer sees channels hidden from it**
  unless it is Administrator (or the owner). Until now Manage Channels
  anywhere in your roles — `@everyone` included — quietly overrode every "hide
  this channel from that role" rule for you; on a server where `@everyone`
  carried it, hiding a channel did nothing at all. A channel manager who is
  hidden from a channel cannot open its settings in the app (that editor
  lives inside the channel); the overwrite API still accepts their
  server-level Manage Channels, and an administrator or the owner can undo
  the override for them.
- **Leaving a call now cuts your media off from the others immediately, and
  theirs from you**, whether you left or were removed: the remaining
  participants close the connection the moment the roster drops you, rather
  than waiting for a separate "stopped streaming" signal that a client could
  skip.
- **Your keys are handed out only to people who have a reason to hold
  them.** A user's identity and signing public keys could be read by any
  signed-in account for any id; now only that user, their friends, members of
  a server they share, and people they have written to get them, and a
  deleted account, a stranger and an impossible id all get the same "not
  found". A block does not withhold these keys: they are what a shared voice
  call's media encryption and its connection pin are built from, and what
  decrypts the direct messages you already have, so blocking someone changes
  nothing about call encryption or about reading an old conversation. The
  per-device DM key list, which exists only to send a new direct message, is
  refused across a block.
- **Revoking a device signs out every connection that device signed in**, not
  only the one that proved it was that device.
- Seeing who reacted to a message, and reacting or un-reacting yourself, now
  need "Read Message History" in the channel, like the message list does.
- "Mark server as read" no longer marks channels you cannot see, so getting
  access to one later no longer hides what was posted in the meantime.
- A chat message sent into a voice channel now needs Send Messages there and
  honours timeouts, exactly like a message into a text channel. The mute,
  deafen and clip-armed status pings of someone who is in the call are
  exempt: they need only the right to see and connect to the channel, so a
  member who can join but not send still shows their state to the room.
- Clip proposals are re-checked against what each person can see at the
  moment every frame is sent: a proposer or approver who has been removed
  from the voice channel stops receiving them, cannot vote, and cannot fetch
  the proposal, and a consent prompt that was waiting for their device to
  come online is dropped instead of ringing for a call they were removed
  from. An approver who cannot see the text channel the clip would be posted
  to is still asked and their vote still counts, but the proposal no longer
  tells them which channel that is. A server's pinned clips channel is not
  shown to members who cannot see it.
- File offers and direct messages waiting for a device to come online are
  re-checked at delivery: one that a block, or a change to "Allow DMs from
  server members", now forbids is not handed over.
- Sending a file to someone who hides their online status now looks the same
  to the sender whether that person is online or not; the file still reaches
  them when they are.
- Moving or disconnecting someone from voice requires being able to see the
  channel they are in; reporting a message requires being able to read its
  channel; a friend request to a deleted account answers "User not found",
  and deleted accounts never appear in friend or request lists; leaving a
  room you never joined no longer announces you leaving it to the people in
  it; and the operator-only migration password reset now signs the account
  out everywhere instead of leaving old sessions and devices valid.

## 0.9.4 — 2026-09-06

An adversarial audit of the boundary between members and non-members confirmed
that nobody outside a server can read its content, and found a set of smaller
leaks and stale grants around that line. All of them are closed here; most are
invisible in normal use, and the ones you may notice are listed first.

### Security
- **Members of the oldest servers may lose channel and role management they
  never should have had.** A very early database migration gave the
  `@everyone` role of every server that already existed when it ran a
  permission mask copied from another product's number layout; under ours it
  read as Manage Channels, Manage Roles, Kick and Ban for every member, and
  Manage Channels also made every "hide this channel from that role" rule
  inert (the same mask also handed everyone the voice moderation controls:
  mute, move, priority speaker). Servers created since were never affected.
  Those `@everyone` rows are now reset to the ordinary member defaults plus
  the anyone-can-manage-checklists behaviour those servers were deliberately
  left with, and the affected servers' channel keys rotate; if a control
  disappeared from your sidebar, that is why, and the owner can grant it back
  through a real role.
- **Revoking "Connect" on a voice channel now removes the person from the
  call**, in both mesh and SFU calls. Until now it only stopped them
  rejoining.
- **You cannot use Manage Roles on yourself** unless you are an administrator
  or the owner. A role's per-channel overrides are not permissions, so a
  moderator could give themselves a permission-less role whose override opened
  a hidden channel, or remove from themselves the role whose override hid it.
- **Losing access to a channel now stops its notifications too.** Message
  notifications that were waiting for you to come back online, and clip
  proposals still open for a vote, are re-checked against what you can see
  now: a kicked, banned or newly hidden-from member no longer receives them,
  cannot vote, and cannot fetch the proposal.
- **Direct messages between two people who share no server are refused**
  unless they are friends or the recipient wrote first. The Settings toggle
  "Allow DMs from server members" now means exactly that: with it on, people
  who share a server with you can write to you; with it off, only friends and
  people you have written to. A deleted account can no longer be messaged, and
  the per-device keys a sender needs are handed out under the same rule.
- **Pinned messages and edit histories respect "Read Message History".** A
  member denied that permission could read message bodies through both.
- **A private moderator queue can no longer be salted.** A report must name a
  message in this server, and a person who is a member of it (or the author of
  that message); the moderators' list no longer shows names or ids that were
  planted from elsewhere.
- **Attachment capabilities are enforced by default.** A file uploaded with a
  capability is served only to a client presenting it, so an account that has
  been kicked, or that merely learned a file id, no longer fetches the blob.
  Every official client has sent the capability since 0.8.134; self-hosters
  with older clients still in the field can set `FILES_ENFORCE_CAP=0` while
  they update.
- **Several routes gave away whether an id exists, or where someone else
  is.** Marking a channel read, deleting someone else's file, moving a member
  who is in a call on another server, reading a stranger's personal checklist,
  parenting a task to one in another list, and replying to a message from
  another channel all answered differently for "does not exist" and "not
  yours"; each now gives one answer that says nothing about what you cannot
  see. Listing who is in voice accepted a channel's *name* as a room id, so a
  channel named after another server's room showed its occupants; rooms are
  now matched by id only.
- **Safety checks no longer fail open on a database error.** Ban, timeout,
  block and accepts-DMs lookups refuse when the database cannot answer,
  rather than treating "no answer" as "allowed"; the same for whether a clip
  approver shows as online, which also now honours "Show online status".

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
