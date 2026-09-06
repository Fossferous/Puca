# Púca API Reference

Quick reference for the commonly used REST endpoints. `src/main.rs` registers
the complete list — remote-control devices (except revocation, below), clips,
checklists, admin reports, key custody and recovery and `/app-version` are not
tabulated here. `scripts/check-api-docs.mjs` (part of `npm run lint`) fails when a path
in this file is not registered there, so what IS listed is real.

**Base URL:** `http://localhost:3000`
**Auth Header:** `Authorization: Bearer <JWT>`

---

## Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | ❌ | Create account (SRP salt+verifier) |
| POST | `/auth/login/step1` | ❌ | Start login (send A_pub, get B_pub) |
| POST | `/auth/login/step2` | ❌ | Complete login (send proof, get JWT). A successful exchange also records a **password proof** for the session the JWT belongs to; endpoints that rewrite credentials or key custody (`/keys/change-password`, `/keys/wrap`, `/keys/rewrap-pw`, `PATCH /keys/public`, `DELETE /account`) require one made within the last few minutes. To re-prove from a session you are already signed into, send the exchange **with your bearer token**: the proof then binds to that session and the response returns the same token (no second session is opened). |
| POST | `/auth/logout-session` | ✅ | Sign out **this** session only: revokes the token's `sid` (every token carries one since 0.9.0; older tokens get one at their first sliding renewal) and closes its live sockets. Other devices keep working. |
| POST | `/auth/logout` | ✅ | Sign out **everywhere**: bumps `token_version` and marks every session of the account revoked. |
| DELETE | `/account` | ✅ | Tombstone the account. Body `{"confirm_username"}`; requires a recent password proof; refused while the caller still owns servers. |
| PATCH | `/keys/public` | ✅ | Set the identity public key. Write-once for v3 accounts; requires a recent password proof. |
| POST | `/auth/reset-password-migration` | ❌ | Operator-gated recovery for an account the server has flagged `force_password_reset`: 403 unless the server runs with `ALLOW_MIGRATION_PASSWORD_RESET=true`, and 403 for an account not flagged. A successful reset installs the new SRP material **and signs the account out everywhere** — `token_version` bump, every session and every enrolled device revoked, every socket closed (until 0.9.5 old tokens and devices stayed valid). A deleted account is a 404. |

---

## Public information

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/config` | ❌ | What a client needs before signing in: `app_url` (the web app, so invite links are `<app_url>/invite/<code>`; null when the operator has not set `APP_URL`) and `registration_invite_required` (boolean — whether the sign-up form must ask for an invite code; the code itself is never exposed). |
| GET | `/source` | ❌ | `repository` (the operator's `SOURCE_URL`), `commit` (what the binary was built from) and `license` — the AGPL §13 offer of source to the people using this server. A fork must set `SOURCE_URL` to its own repository. |
| GET | `/ice-config` | ❌ (TURN credentials only with a bearer token) | STUN servers, and for a signed-in caller 4-hour credentials for the operator's TURN relay. |

---

## Servers

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers` | ✅ | List user's servers. `clip_channel_id` is `null` unless the caller can VIEW the pinned clips channel; the owner's pin itself is unchanged. |
| POST | `/servers` | ✅ | Create new server |
| POST | `/servers/:id/join` | ✅ | Join server by ID |
| PATCH | `/servers/:id/settings` | ✅ | Update server settings |
| POST | `/servers/:id/read` | ✅ | Mark the whole server read — every channel the caller can VIEW, that is: a hidden channel gets no read-state row (until 0.9.5 it did, so restoring VIEW later hid what had been posted meanwhile). Bare 200 either way; no channel ids in the answer. |

---

## Channels

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/channels` | ✅ | List channels |
| POST | `/servers/:id/channels` | ✅ | Create channel |
| POST | `/servers/:id/channels/reorder` | ✅ | Reorder channels |
| GET | `/servers/:id/voice-users` | ✅ | Who is in which voice channel of this server, limited to the channels the caller can VIEW. Rooms are matched by channel **id** only (`voice_<id>`); a channel's name is never read as a room id, so a channel called `voice_42` in a server you own no longer shows you the occupants of channel 42 somewhere else. |

---

## Messages

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/channels/:id/messages` | ✅ | Get messages (paginated) |
| POST | `/channels/:id/messages` | ✅ | Send message. A `reply_to_id` must name a message in **this** channel; one from any other channel (or a DM) is a 400. |
| PATCH | `/channels/:id/messages/:message_id` | ✅ | Edit message |
| DELETE | `/channels/:id/messages/:message_id` | ✅ | Delete message |
| GET | `/channels/:id/messages/:message_id/edits` | ✅ | Edit history of a message. Needs `READ_MESSAGE_HISTORY` in the channel, the same bit `GET /messages` checks; without it, 403. |
| GET | `/channels/:id/pins` | ✅ | List pinned messages. Needs `READ_MESSAGE_HISTORY` in the channel (pins are message bodies); without it, 403. |
| POST | `/channels/:id/messages/:message_id/pin` | ✅ | Pin message |
| DELETE | `/channels/:id/messages/:message_id/pin` | ✅ | Unpin message |
| POST | `/channels/:id/read` | ✅ | Mark the channel read. Gated on VIEW like every other channel route: 404 when the channel does not exist **or** the caller is a member who cannot see it (deliberately the same answer, so the route is not an existence check for hidden channels), and the same 404 for a non-member: nothing needs the 403 distinction on a write of read-state, and 403-vs-404 would confirm to an outsider which channel ids exist. |

> **There is no server-side message search, and there cannot be one.** Message
> content is stored end-to-end encrypted, so the column holds ciphertext. A
> `GET /channels/:id/messages/search` endpoint existed until 2026-07-28 and was
> removed: it ran SQL `LIKE` against that column, so it could never match a term
> a user typed — and because the envelope is JSON, its wrapper matched every
> row, making `q=ch` or `q=epoch` return the whole channel as confident false
> positives. Search is client-side over decrypted content
> (`frontend/src/api/searchMessages.ts`).

---

## Roles

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/roles` | ✅ | List roles |
| POST | `/servers/:id/roles` | ✅ | Create role |
| PATCH | `/servers/:id/roles/:role_id` | ✅ | Update role |
| DELETE | `/servers/:id/roles/:role_id` | ✅ | Delete role |
| PUT | `/servers/:id/members/:user_id/roles/:role_id` | ✅ | Assign role. Needs Manage Roles, a role below your highest, and no bit you lack. A caller who is not an administrator (or the owner) may not target **themselves**: 403 `Cannot change your own roles`. A role's channel overwrites are not bits, so without this a Manage Roles holder could give themselves a permission-less role whose allow overwrite opens a hidden channel. |
| DELETE | `/servers/:id/members/:user_id/roles/:role_id` | ✅ | Remove role. Same rules as assign, including the self-target refusal — removing from yourself the role that carries a deny overwrite would restore the channel it hides. |

---

## Invites

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/invites` | ✅ | List invites (Manage Server). Each row carries `creator_id` and `creator_username`. |
| POST | `/servers/:id/invites` | ✅ | Create invite. Needs the Create Invites permission; otherwise 403 with `You don't have permission to create invites on this server`. `expires_in_hours` absent means **168 h** (7 days); `0` means never expires and has to be sent explicitly (a 0.9.4 client choosing Never omits the field and gets 7 days); any other value is clamped to 1…8760. Written to the audit log as `invite_create`. |
| DELETE | `/servers/:id/invites/:code` | ✅ | Delete invite (Manage Server). A database refusal is a 500, not a false 200; an actual removal is written to the audit log as `invite_delete`. An invite is also removed automatically when its creator is kicked, banned, leaves, or deletes their account (migration 062). |
| GET | `/invites/:code` | ❌ | Get invite info (preview) |
| POST | `/invites/:code/join` | ✅ | Join via invite. 404 `Invite not found or expired` for an expired code and for one whose creator has left the server. The returned server's `clip_channel_id` is `null` unless the joiner can VIEW it. |

---

## Members & Moderation

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/members` | ✅ | List members. `is_online` is false for anyone hiding their online status, and (since 0.9.5) for anyone with a block against the caller in either direction — the same rule as the live presence frames; if the block lookup fails, every member in that response reads offline. |
| GET | `/servers/:id/members-with-roles` | ✅ | List members with roles. Same `is_online` rule as `/members`. |
| POST | `/servers/:id/kick/:user_id` | ✅ | Kick member |
| POST | `/servers/:id/bans/:user_id` | ✅ | Ban member |
| DELETE | `/servers/:id/bans/:user_id` | ✅ | Unban member |
| GET | `/servers/:id/bans` | ✅ | List bans |
| POST | `/servers/:id/voice-move/:user_id` | ✅ | Move a member between this server's voice channels (Move Members). 409 `That member is not in a voice channel` for **any** target not currently in a voice channel of this server — a non-member, a member who is in a call in some other server, and a member who is simply not in voice all get the same answer, so the route says nothing about where anyone else is. Since 0.9.5 the **caller** must also be able to VIEW the channel the target is in; otherwise the same 409, so a Move Members holder hidden from a channel cannot learn who is in it, disconnect them, or use the destination checks as an oracle. |
| POST | `/servers/:id/reports` | ✅ | Report a message or a member to the server's moderators (any member). `reported_message_id` must be a message in this server **that the reporter can VIEW** — a hidden, foreign-server, DM or unknown id all get the same 400 `reported_message_id is not a message in this server` — and `reported_user_id` must be a member of it (or the author of that message); anything else is a 400, so a report cannot plant a foreign or hidden message id, or a stranger's name, in the moderators' queue. |
| GET | `/servers/:id/reports` | ✅ | List reports (moderators) |
| POST | `/users/:user_id/block` | ✅ | Block a user: empty 200. In one transaction it also removes the friendship and any pending friend request between you, and revokes device shares between you. From then on you read as offline to them everywhere (presence frames, member lists, user search), and a friend request between you is visible only to whoever sent it (see `POST /friends/request`). The **same** empty 200, with nothing written, for an id that was never issued, one outside the 32-bit range, or a deleted account — the foreign-key 500 those used to raise was an existence oracle over the id space. 400 `Cannot block yourself`. A block does **not** affect the identity key (`/users/:id/public-key`), so a shared voice call stays end-to-end encrypted and an existing DM thread stays readable. |
| DELETE | `/users/:user_id/block` | ✅ | Unblock. Does **not** restore the friendship: when a block row is actually removed, any friends row still beside it and any friend request sent across it are deleted (to that request's sender this looks like a rejection). Pairs blocked before 0.9.5 had their friends and pending-request rows removed once at upgrade by migration 063. |
| GET | `/blocked` | ✅ | The users you have blocked (your own direction only). |
| GET | `/users/search` | ✅ | Search users by name. `is_online` is false for anyone hiding their online status and for anyone with a block against the caller in either direction (fail closed: a failed block lookup reads every result as offline). Deleted accounts are never listed. |

---

## Reactions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/messages/:id/reactions` | ✅ | Who reacted with what. Needs `READ_MESSAGE_HISTORY` in the channel as well as VIEW — the bit `GET /messages` checks; a roster of who was in the conversation is history — otherwise 403 `You do not have permission to read message history in this channel`. DM participants always pass. |
| POST | `/messages/:id/reactions` | ✅ | Add reaction. Same gate as GET (since 0.9.5). |
| DELETE | `/messages/:id/reactions/:emoji` | ✅ | Remove reaction. Same gate as GET (since 0.9.5). |

---

## File Uploads

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/upload` | ✅ | Upload file (multipart). With request header `X-Puca-Want-Cap: 1` the response also carries `cap`, a per-file capability returned exactly once (the server stores only its SHA-256). With request header `X-Puca-Channel: <channel id>` (sent by the official apps for chat and checklist attachments) the upload is refused with 403 unless the caller holds `ATTACH_FILES` in that channel — checked before any body byte is read. Uploads naming no channel are not gated. |
| GET | `/files/:id` | ✅ | Get file. A file uploaded with a capability is served only to a caller presenting it in request header `X-Puca-File-Cap`; a missing or wrong one is a 404 (no existence oracle). This enforcement is **on by default**; `FILES_ENFORCE_CAP=0` on the server drops back to checking a capability only when one is presented, which lets a client older than 0.8.134 keep fetching but also lets any signed-in account that learns a file id fetch it. Files without a capability (older uploads, avatars, icons, sounds, emoji, clip parts) are never gated. |
| DELETE | `/files/:id` | ✅ | Delete a file you uploaded. 404 unless the caller is the uploader — decided **before** the in-use check, so the 409 for a file still referenced as an avatar, sound, icon or emoji is only ever seen by its owner and does not confirm other people's file ids. |

---

## Direct Messages

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/dms` | ✅ | List DM conversations |
| POST | `/dms` | ✅ | Create/get a DM conversation with a user. 404 for an id that does not exist **or** belongs to a deleted account (a tombstone is not DM-able). 403 `DMS_NOT_ACCEPTED` unless the recipient is a friend, has already written to you, or shares a server with you **and** has "Allow DMs from server members" on — a stranger who shares no server is refused whatever the flag says. A blocked pair gets the **same** 403 and body (since 0.9.5; a distinct "You cannot message this user" told the sender they were blocked). An existing conversation is still returned across a block — history stays readable; only sending is refused. |
| GET | `/dms/:conversation_id/messages` | ✅ | Get DM messages |
| POST | `/dms/:conversation_id/messages` | ✅ | Send DM. 403 `DMS_NOT_ACCEPTED` when the consent rule above no longer holds, and the same 403 across a block. |
| GET | `/users/:user_id/dm-keys` | ✅ | The signed per-device DM keys a sender wraps a v4 message to. Same relationship rule as `POST /dms` (friends, or a shared server while their "Allow DMs from server members" is on, or they already wrote to you), and 404 rather than 403 when it fails — how many devices someone uses is not a stranger's to count, and having opened a conversation yourself no longer satisfies the check. Never while either of you has blocked the other (until 0.9.5 a block left a former friend or server-mate polling the target's live session list). An id outside the 32-bit range is a 404, not an alias of your own account. |

---

## Identity keys

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/users/:user_id/public-key` | ✅ | The user's X25519 identity public key. 404 unless the caller is that user, a friend, a member of **any** shared server (regardless of the target's "Allow DMs from server members" setting: this key is what channel keys and voice media keys derive from, and `GET /channels/:id/member-keys` already serves it to every viewing member), or someone the user has already written to. The same 404 for a deleted account, a stranger and an id outside the 32-bit range. A block is **not** a refusal: this key is what a shared voice call's pairwise media key and DTLS pin derive from, and what decrypts a DM thread you already hold, and a block evicts nobody from a call — so blocking someone changes nothing about call encryption or DM history (unlike `/dm-keys`, which only serves new DMs and is refused across a block). Until 0.9.5 any signed-in account could read any id. |
| GET | `/users/:user_id/signing-key` | ✅ | The user's Ed25519 account signing key (device enrolment records, DM v4 key records). Same gate and same 404 as `/public-key`. |

---

## Clips

The consent protocol is in [`docs/CLIPS.md`](CLIPS.md); these are the
boundary rules added in 0.9.5.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/clips/pending` | ✅ | Proposals awaiting the caller's vote. A proposal is listed only while the caller can still VIEW its voice channel. `target_channel_id` and `target_channel_name` are both `null` when the caller cannot VIEW the text channel the clip would be posted to — they keep their consent seat, but not the channel's identity. |
| GET | `/clips/:clip_id` | ✅ | One proposal. 404 unless the caller is a participant who can still VIEW the voice channel (a kicked, banned or newly hidden-from member gets the same 404 as an unknown id). Same target redaction as `/clips/pending`. |
| POST | `/clips/:clip_id/vote` | ✅ | Approve or decline. Needs VIEW on the voice channel only; an approver hidden from the target channel can still vote, and approval is unanimous, so without this every proposal in such a call would have expired unanswered. 404 otherwise. |

---

## Enrolled devices

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| DELETE | `/devices/:device_id` | ✅ | Revoke one of your enrolled devices (idempotent 200). Revokes every session that device proved and hangs up every socket authenticated on any of them — including a second socket on the same token, or one opened with a device-minted token, which until 0.9.5 stayed up because only the connection that had attested as the device was killed. A later request on a revoked session is a 401; a later socket upgrade is refused. |

---

## Push Notifications (Mobile)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/device/register` | ✅ | Register device for push (token, platform) |
| DELETE | `/device/unregister` | ✅ | Unregister device |
| GET | `/device/list` | ✅ | List registered devices |
| DELETE | `/device/:id` | ✅ | Remove specific device |
| GET | `/notifications/preferences` | ✅ | Get notification preferences |
| PATCH | `/notifications/preferences` | ✅ | Update preferences |
| POST | `/notifications/test` | ✅ | Send test notification |

---

## Friends

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/friends` | ✅ | List friends. Never a deleted account, and never someone with a block in either direction, even where a friends row from before 0.9.5 survives. |
| GET | `/friends/:user_id/status` | ✅ | Friendship status with a user (`is_friend`, pending direction). Across a block `is_friend` is false and a request *received* from that user is masked (`request_received` false, `request_id` null); a request you *sent* across a block is reported as sent, like any other. |
| GET | `/friends/requests/incoming` | ✅ | List incoming friend requests. Never a deleted account, and never a request from someone with a block against you in either direction (a failed block lookup lists nothing). |
| GET | `/friends/requests/outgoing` | ✅ | List outgoing friend requests (deleted accounts are never listed). A request you sent across a block is listed — it is a real pending request on your side. |
| POST | `/friends/request` | ✅ | Send friend request: 201 with an empty body. 404 `User not found` for an unknown **or deleted** account; 400 for yourself; 409 when already friends or a request is pending. When either of you has blocked the other the request is written and behaves exactly like any other on the **sender's** side — the same bare 201, 409 `Friend request already pending` on a repeat, listed outgoing, `request_sent` true — but does not exist on the recipient's: it is absent from their incoming list and status, and accept or reject on its id answer 404. Unblocking deletes it. Before 0.9.5 a 403 told the sender who had blocked whom (`GET /blocked` shows your own direction). |
| POST | `/friends/requests/:id/accept` | ✅ | Accept request. 404 `Request not found` across a block (or when the block lookup fails), the same as for a request that does not exist. |
| POST | `/friends/requests/:id/reject` | ✅ | Reject request. Same 404 rule as accept. |
| DELETE | `/friends/:user_id` | ✅ | Remove friend |

---

## WebSocket

**URL:** `ws://localhost:3000/ws`, authenticated with the WebSocket
subprotocol header `Sec-WebSocket-Protocol: bearer, <JWT>` (the server echoes
`bearer` back as the selected protocol). A token in the query string
(`?token=`) is **refused** since 0.9.1 — it used to land verbatim in every
proxy access log.

Frames are `{"type": "<Variant>", "payload": {...}}`; the variants and their
payloads are defined in `src/protocol.rs` (`ClientMessage` / `ServerMessage`),
which is the source of truth — the list is long and changes with every release.

**Media announcements are permission-gated and come first.** `CameraStart` and
`ScreenShareStart` are refused with an `Error` frame when the caller lacks
`VIDEO` / `STREAM` in the voice channel (`"You don't have permission to turn on
your camera in this channel"`, `"…to share your screen in this channel"`) or is
not in the room (`"Not in this room"`). An accepted announcement is broadcast to
every member **including the sender** as `CameraStarted` / `ScreenShareStarted`;
the official client publishes its tracks only after that echo, and mesh
receivers render a peer's video only while the server has announced it — a
track that arrives without an announcement is held, not shown.

**Rooms (0.9.5).** A `LeaveRoom` for a room this connection never joined is
ignored — no `UserLeft` is broadcast (it used to be, into rooms the caller
could not see). Fully leaving a voice room retracts the leaver's media to the
room (`StreamStopped`, plus `ScreenShareStopped` / `CameraStopped` for what
this connection had announced) whether or not `StopStream` was sent first; the
official client closes its peer connection to anyone the roster drops. A
`ChatMessage` into a `voice_<id>` room is gated like one into `channel_<id>`:
VIEW and `SEND_MESSAGES` (`Not a member of this channel's server` otherwise),
then the member-timeout deny list (`Could not verify timeout status` when the
database cannot answer) — with one carve-out: a `content` that starts with
`__VOICE_STATUS__` (the mute / deafen / clip-armed ping) sent by a connection
currently joined to that voice room is admitted on VIEW + `CONNECT` alone and
skips the timeout check. A ping from a connection not in the room, or any
other content, keeps the full gate.

**Frames parked for an offline device are re-authorised when it connects.** A
`MessageNotification` is dropped when the channel is no longer visible; a
`ClipPending` when the recipient can no longer VIEW the clip's voice channel
(the same rule as the REST clip routes: the voice channel gates participation,
and a target channel the approver cannot view is redacted, never a refusal); a
`DirectMessage` and a `FileOffered` when a block or a DM-consent change now
forbids the pair (the file offer stays parked and later expires as "never came
online"). `UserOnline` / `UserOffline` are never sent to an account with a
block in either direction, and the REST member lists and user search report
the same pair as offline.

---

*Last Updated: 2026-09-06*
