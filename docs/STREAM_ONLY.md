# Stream-only accounts

Some servers run an **automated streaming account**: an ordinary Púca account,
signed in on a machine nobody sits at, whose only job is to join a voice call
and share its screen. Púca has no separate "bot" account type. Instead, an
ordinary account can be given three things, each enforced or honoured as
described below:

1. a **Stream only** role, which the server enforces: the account can see,
   join and share its screen in the voice channels the owner opens for it,
   and nothing else;
2. **No receive** (optional), so nobody's audio or video is sent to it;
3. **Join voice without a microphone**, so it joins with no microphone track
   at all, and nothing treats it as a broken or idle microphone.

The web client also carries stable automation hooks for the steps such an
account drives: see [AUTOMATION.md](AUTOMATION.md).

None of this needs a database migration: the two new permission bits live in
the existing role permissions column.

## Setting one up (server owner)

1. Create an ordinary account for the automation and invite it to the server.
   Sign it in with **Stay signed in on this device** ticked, so it does not
   need its password again (see the user guide, *Staying signed in*).
2. In **Server Settings → Roles**, click **+ Stream Only Role**. This creates a
   role named "Stream only" with **Stream** and **Stream only** ticked. Tick
   **No receive** under **Automated Streaming** as well if the account should
   hear and see nothing, then **Save Changes**.
3. Under **Voice channels this role may stream in**, tick the voice channels
   it may join. Each tick writes an ordinary channel permission (an Allow of
   View Channel, Connect and Stream for this role), so the channel's own
   **Permissions** tab shows the same thing.
4. Give the account the role (click it in the member list, tick the role under
   **Manage Roles**). Give it no other role: see *How the cap is decided*.

Only the server owner or an administrator can set or clear **Stream only** and
**No receive**, and neither can be put on @everyone. A member with Manage Roles
can still create, rename and recolour such a role; their edits keep whatever
the role had for these two.

## What the server enforces

A member whose roles carry **Stream only** (and who is not an administrator or
the owner) is capped, by the server, in three places that every other check
goes through, so there is no route that forgot the rule:

- **In every channel.** A text channel, a collection, and any voice channel
  that has not been opened for one of the member's roles resolve to *no
  permissions at all*: the channel is not listed, its messages, pins, files
  and history are refused, and the member cannot join its room. In a voice
  channel that has been opened, the member holds at most View Channel,
  Connect and Stream: no Send Messages, no Read Message History, no Speak, no
  camera, no clips, no card table.
- **Server-wide.** The member's server-level permissions are the same three
  bits: no invites, no tasks, no management of any kind.
- **Live.** The member is refused the text room of the voice channel it is in
  (`channel_<id>`), and the call's own chat is not sent to it; the call's
  roster state (who is muted, deafened, sharing) still is. Notices of new
  channels are not sent to it either.

"Opened" means: one of the member's roles (not @everyone) has a channel
permission on that voice channel that allows **Connect**. A new channel is
therefore closed to the account until the owner opens it.

Two things it still gets, by design or as a known limit:

- If someone posts a stored message *in a voice channel opened for it*, the
  account is sent the same content-free "a message landed" notice every
  member who can see the channel gets (which channel, which message id,
  who wrote it); the message itself is refused it.
- [Clips](CLIPS.md) need the approval of everyone in the call **except
  stream-only members**: an automated account cannot answer the prompt, so it
  is never asked, and a clip of a call it is in needs only the people's
  approval (a call of just you and the account needs none). This is why the
  role is for accounts run by automation and not for a person: whoever holds
  it is not asked before a clip of their call is posted. Only the owner or an
  administrator can give it, and its description in Roles says so. Clips are
  off unless the server owner turns them on.

### How the cap is decided

Permissions in Púca are otherwise additive: every role adds rights. **Stream
only** is the one bit that takes rights away, and it applies to the member as
a whole, not per channel (a channel permission cannot set or lift it). Any
role of the account that opens a voice channel (an Allow of Connect there)
opens it for the account, which is why it should hold the Stream only role and
nothing else.

## Encryption: what "cannot read text" means

Channel keys are generated and wrapped on people's own devices, for every
member who can **view** the channel; the server never sees them, but it
decides who counts as a viewer, with the same rule as above. So a stream-only
account receives the key of each voice channel opened for it, and of nothing
else: no text channel's key is ever wrapped for it. This is pinned by a
database-backed test of the viewer set the key distribution uses.

It does need that voice channel's key. On an SFU channel the call's media is
encrypted under a key derived from the channel key, so without it the account
could not encrypt its share and nobody could watch it. Peer-to-peer (mesh)
calls use per-pair keys instead and need no channel key.

The honest limit: the channel key that protects the call's media is the same
key that protects any text written in that voice channel. The account is not
*sent* that text (the server refuses it every route, live and stored), but the
protection is the server's refusal, not cryptography: a server operator who
wanted to could hand it the ciphertext. A key that encrypts media and cannot
read text would be a new kind of key in the protocol, which this does not add.

## No receive

**No receive** applies to any member whose roles carry it, stream-only or not.

- **SFU channels:** the member's join token says `canSubscribe: false`, so
  LiveKit itself forwards it nobody's tracks. A change mid-call reaches the
  live session at once (the same permission sweep that applies a change of
  Speak).
- **Mesh channels:** media goes directly between people's devices, so the
  server cannot withhold it. It tells everyone in the call which members are
  no-receive (`VoiceSpeakState` carries `receives: false`), and each current
  Púca client then sends that member no microphone, camera or screen share,
  from the start of the call and as soon as a change arrives. A client older
  than this change ignores the flag and keeps sending.
- **Either way** the account's own client plays nothing it is sent, and the
  others still see its stream.

## Join voice without a microphone

**Settings → Voice & Video → Join voice without a microphone** (per device),
and always for a stream-only account. The call is joined with no microphone
track: no permission prompt, no capture, nothing muted-but-open. Because there
is no microphone:

- the silent-microphone warning ("Your microphone is producing silence") and
  the "No microphone detected" help are not shown;
- the idle move to the server's AFK channel is never armed (it measures voice
  activity, which the member cannot have);
- everyone else's roster shows the member as having **No microphone** (a
  dashed microphone), not as muted.

The member can still share their screen, with its sound.

## How it shows up for the people in the call

Everyone's client is told which members of their call are stream-only: the
server adds `stream_only: true` to that member's `VoiceSpeakState` (the same
frame that carries Speak and No receive, so it arrives with the join, before
any announcement, and follows a role change mid-call). The server decides it,
from the same cap it enforces; no client works it out from role bits.

- **No spoken announcement.** With **Settings → Notifications → Speak
  Join/Leave (TTS)** on, people hear "X joined the channel" / "X left the
  channel" for real people only, never for a stream-only member. The join and
  leave chime (and a member's own join/leave sound, when they have one) is a
  separate path and plays as before. Púca has no join/leave toasts.
- **Its stream starts by itself.** When a stream-only member is sharing in
  your call (you join while it is live, or it goes live while you are there),
  your client starts watching it without a Watch click, once per share: close
  it, and it stays closed until its next share. From the call's view it opens
  the stream view; from the chat it opens in the small player over the chat
  (docked under the header on a phone), so nothing you are reading or typing
  is taken away. It plays at that stream's own volume and mute and the master
  Output Volume, like any stream you watch. Everyone else's shares still wait
  for a click.
- **The control**: **Settings → Voice & Video → Automatically watch streams
  from stream-only accounts**, on by default, per device. A stream costs data
  like any other, so a phone on mobile data may want it off; it never starts
  while the browser asks to save data (Chromium's Data Saver).
- **Autoplay.** The picture is a muted video and always starts. A browser
  starts a stream's sound only after you have used the page; you almost always
  have (you clicked to join the call), but if the call came back on its own
  after a reload, the sound starts at your first click or key press instead
  of never.

## What was verified, and what was not

Verified by tests that run in the gates (each one checked to fail when the
rule it pins is removed):

- the permission cap, channel by channel and server-wide, with negative
  controls (`src/permissions.rs`, `stream_only_tests`), and against a real
  database: the key-distribution viewer set and all three resolvers;
- the voice room end to end through the real socket handlers: the account
  joins the opened call, is refused the call's text room, a text channel and
  an unopened voice channel, gets roster pings but not chat, cannot chat, and
  a No receive change reaches the room (`src/ws.rs`, `stream_only_ws_tests`);
- the SFU token's `canSubscribe: false` and the mid-call grant
  (`src/sfu.rs`, `no_receive_grant_tests`); the role-editing rules
  (`src/role_handlers.rs`); the wire shape (`src/protocol.rs` and the client,
  one fixture);
- the client: mesh peers flagged no-receive are sent nothing, a no-receive
  member plays nothing, no microphone is ever opened when joining without one,
  and the AFK, silent-microphone, roster and setting wiring
  (`frontend/src/tests/streamOnly*.test.ts`); the automation hooks
  (`automationHooks.test.tsx`);
- how it shows up in the call: the room is told `stream_only` (the socket
  test above, and a third fixture); the auto-watch rule (`autoWatch.test.ts`:
  stream-only members only, once per share, not your own, the setting, data
  saving); and the wiring that leaves these members out of spoken
  announcements and opens their share in the small player from the chat
  (`streamOnlyWiring.test.ts`).

Verified live by `frontend/e2e/stream-only-live.mjs` on a mesh call, in
real browsers run with `--mute-audio` and the owner's `speechSynthesis`
replaced by a recorder (nothing is ever spoken): the account's joining and
leaving is never announced while a person's joining and leaving is (the
control); its share opens by itself in the owner's small player while the
chat stays, for a person joining while it is live, and in a 390x844 phone's
docked player; a person's share does not open by itself (the control); and a
closed share stays closed.

Not verified by an automated gate: a real browser streaming into a real SFU
call under a stream-only role (LiveKit is not part of the test rig). The SFU
half rests on the token LiveKit is handed, which is tested, and on LiveKit
honouring `canSubscribe`.
