# Púca API Reference

Quick reference for all REST API endpoints.

**Base URL:** `http://localhost:3000`
**Auth Header:** `Authorization: Bearer <JWT>`

---

## Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | ❌ | Create account (SRP salt+verifier) |
| POST | `/auth/login/step1` | ❌ | Start login (send A_pub, get B_pub) |
| POST | `/auth/login/step2` | ❌ | Complete login (send proof, get JWT) |

---

## Servers

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers` | ✅ | List user's servers |
| POST | `/servers` | ✅ | Create new server |
| GET | `/servers/default` | ✅ | Get or create default server |
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
| PATCH | `/messages/:id` | ✅ | Edit message |
| DELETE | `/messages/:id` | ✅ | Delete message |
| POST | `/messages/:id/pin` | ✅ | Pin message |
| DELETE | `/messages/:id/pin` | ✅ | Unpin message |

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
| POST | `/servers/:id/invites` | ✅ | Create invite |
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
| POST | `/upload` | ✅ | Upload file (multipart). With request header `X-Puca-Want-Cap: 1` the response also carries `cap`, a per-file capability returned exactly once (the server stores only its SHA-256). |
| GET | `/files/:id` | ✅ | Get file. A file uploaded with a capability is checked against request header `X-Puca-File-Cap` when one is presented; a wrong one is a 404 (no existence oracle). With `FILES_ENFORCE_CAP=1` on the server the header is required for such files; files without a capability (older uploads, avatars, icons, sounds, emoji, clip parts) are never gated. |

---

## Direct Messages

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/dm/channels` | ✅ | List DM channels |
| POST | `/dm/channels` | ✅ | Create/get DM channel |
| GET | `/dm/channels/:id/messages` | ✅ | Get DM messages |
| POST | `/dm/channels/:id/messages` | ✅ | Send DM |

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
| GET | `/friends/requests` | ✅ | List friend requests |
| POST | `/friends/request` | ✅ | Send friend request |
| POST | `/friends/accept/:user_id` | ✅ | Accept request |
| DELETE | `/friends/:user_id` | ✅ | Remove friend |

---

## WebSocket

**URL:** `ws://localhost:3000/ws?token=<JWT>`

### Message Types (Client → Server)
```json
{"type": "message", "channel_id": "...", "content": "..."}
{"type": "typing", "channel_id": "..."}
{"type": "join_voice", "channel_id": "..."}
{"type": "leave_voice"}
```

### Message Types (Server → Client)
```json
{"type": "message", "message": {...}}
{"type": "typing", "user_id": "...", "channel_id": "..."}
{"type": "presence", "user_id": "...", "status": "online"}
{"type": "voice_user_joined", ...}
```

---

*Last Updated: 2025-12-12*
