# Púca API Reference

Quick reference for the commonly used REST endpoints. `src/main.rs` registers
the complete list — remote-control devices, clips, checklists, admin reports,
key custody and recovery, `/ice-config` and `/app-version` are not tabulated
here. `scripts/check-api-docs.mjs` (part of `npm run lint`) fails when a path
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
| GET | `/servers` | ✅ | List user's servers |
| POST | `/servers` | ✅ | Create new server |
| POST | `/servers/:id/join` | ✅ | Join server by ID |
| PATCH | `/servers/:id/settings` | ✅ | Update server settings |

---

## Channels

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/channels` | ✅ | List channels |
| POST | `/servers/:id/channels` | ✅ | Create channel |
| POST | `/servers/:id/channels/reorder` | ✅ | Reorder channels |

---

## Messages

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/channels/:id/messages` | ✅ | Get messages (paginated) |
| POST | `/channels/:id/messages` | ✅ | Send message |
| PATCH | `/channels/:id/messages/:message_id` | ✅ | Edit message |
| DELETE | `/channels/:id/messages/:message_id` | ✅ | Delete message |
| GET | `/channels/:id/messages/:message_id/edits` | ✅ | Edit history of a message |
| GET | `/channels/:id/pins` | ✅ | List pinned messages |
| POST | `/channels/:id/messages/:message_id/pin` | ✅ | Pin message |
| DELETE | `/channels/:id/messages/:message_id/pin` | ✅ | Unpin message |

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
| PUT | `/servers/:id/members/:user_id/roles/:role_id` | ✅ | Assign role |
| DELETE | `/servers/:id/members/:user_id/roles/:role_id` | ✅ | Remove role |

---

## Invites

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/invites` | ✅ | List invites |
| POST | `/servers/:id/invites` | ✅ | Create invite. Needs the Create Invites permission; otherwise 403 with `You don't have permission to create invites on this server`. |
| DELETE | `/servers/:id/invites/:code` | ✅ | Delete invite |
| GET | `/invites/:code` | ❌ | Get invite info (preview) |
| POST | `/invites/:code/join` | ✅ | Join via invite |

---

## Members & Moderation

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/:id/members` | ✅ | List members |
| GET | `/servers/:id/members-with-roles` | ✅ | List members with roles |
| POST | `/servers/:id/kick/:user_id` | ✅ | Kick member |
| POST | `/servers/:id/bans/:user_id` | ✅ | Ban member |
| DELETE | `/servers/:id/bans/:user_id` | ✅ | Unban member |
| GET | `/servers/:id/bans` | ✅ | List bans |
| POST | `/servers/:id/reports` | ✅ | Report a message or a member to the server's moderators (any member) |
| GET | `/servers/:id/reports` | ✅ | List reports (moderators) |

---

## Reactions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/messages/:id/reactions` | ✅ | Add reaction |
| DELETE | `/messages/:id/reactions/:emoji` | ✅ | Remove reaction |

---

## File Uploads

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/upload` | ✅ | Upload file (multipart). With request header `X-Puca-Want-Cap: 1` the response also carries `cap`, a per-file capability returned exactly once (the server stores only its SHA-256). With request header `X-Puca-Channel: <channel id>` (sent by the official apps for chat and checklist attachments) the upload is refused with 403 unless the caller holds `ATTACH_FILES` in that channel — checked before any body byte is read. Uploads naming no channel are not gated. |
| GET | `/files/:id` | ✅ | Get file. A file uploaded with a capability is checked against request header `X-Puca-File-Cap` when one is presented; a wrong one is a 404 (no existence oracle). With `FILES_ENFORCE_CAP=1` on the server the header is required for such files; files without a capability (older uploads, avatars, icons, sounds, emoji, clip parts) are never gated. |

---

## Direct Messages

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/dms` | ✅ | List DM conversations |
| POST | `/dms` | ✅ | Create/get a DM conversation with a user |
| GET | `/dms/:conversation_id/messages` | ✅ | Get DM messages |
| POST | `/dms/:conversation_id/messages` | ✅ | Send DM |

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
| GET | `/friends` | ✅ | List friends |
| GET | `/friends/requests/incoming` | ✅ | List incoming friend requests |
| GET | `/friends/requests/outgoing` | ✅ | List outgoing friend requests |
| POST | `/friends/request` | ✅ | Send friend request |
| POST | `/friends/requests/:id/accept` | ✅ | Accept request |
| POST | `/friends/requests/:id/reject` | ✅ | Reject request |
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

---

*Last Updated: 2026-09-02*
