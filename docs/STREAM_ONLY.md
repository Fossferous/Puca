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
- [Clips](CLIPS.md) need the approval of everyone in the call, and an
  automated account cannot give it: a clip proposed while it is in the call
  will not post. Clips are off unless the server owner turns them on.

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
  (`automationHooks.test.tsx`).

Not verified by an automated gate: a real browser streaming into a real SFU
call under a stream-only role (LiveKit is not part of the test rig). The SFU
half rests on the token LiveKit is handed, which is tested, and on LiveKit
honouring `canSubscribe`.
