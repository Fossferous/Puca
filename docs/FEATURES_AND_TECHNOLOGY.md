# Púca — Features & Technology

*A complete guide to what Púca does and how it works, followed by a plain‑English FAQ.*

Púca is a **self‑hosted, end‑to‑end‑encrypted** communication app: servers, channels, DMs, voice, video, screen share — plus things most chat platforms don't have, like giving a trusted friend control of your shared screen. It runs on **desktop, mobile, and in a browser** from a single codebase, and it's built so that the server you run **cannot read your messages, calls, or files**.

- **Web app:** `https://app.example.com`
- **Desktop / mobile installers:** `https://download.example.com`
- **API + realtime:** `https://chat.example.com`

---

## Table of contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Accounts & sign‑in](#2-accounts--sign-in)
3. [Servers, channels & categories](#3-servers-channels--categories)
4. [Messaging](#4-messaging)
5. [Direct messages, friends & blocking](#5-direct-messages-friends--blocking)
6. [Reactions & emojis](#6-reactions--emojis)
7. [Roles & permissions](#7-roles--permissions)
8. [Invites](#8-invites)
9. [Presence & typing](#9-presence--typing)
10. [Task lists & checklists](#10-task-lists--checklists)
11. [Profiles, nicknames & moderation](#11-profiles-nicknames--moderation)
12. [Voice, video & screen share](#12-voice-video--screen-share)
13. [Remote screen control](#13-remote-screen-control)
14. [Noise suppression](#14-noise-suppression)
15. [The encryption model, in depth](#15-the-encryption-model-in-depth)
16. [Platforms & how updates work](#16-platforms--how-updates-work)
17. [How it's hosted](#17-how-its-hosted)
18. [Technology reference](#18-technology-reference)
19. [Known rough edges](#19-known-rough-edges)
20. [FAQ (for everyone)](#20-faq-for-everyone)

---

## 1. Architecture at a glance

**One app, three shells.** The interface is a single **React + TypeScript** app (built with **Vite**). It's loaded three ways:

- **Desktop** — wrapped in **Tauri 2** (a Rust shell around the OS webview). Windows is the fully‑featured target.
- **Mobile** — wrapped in **Capacitor 8** (Android; an iOS project exists in the tree but is not released or tested).
- **Browser** — the same build served as a plain website.

A small module (`frontend/src/api/platform.ts`) detects which shell it's in and lights up or hides native‑only features accordingly.

**The backend** is a **Rust** service using the **axum** web framework, **sqlx** for **PostgreSQL**, and a **WebSocket** for realtime. It does two jobs: a REST API (`/auth`, `/servers`, `/channels`, `/messages`, …) and a live message bus over WebSocket. In‑memory state (who's online, who's in which voice room) lives in a concurrent map (`dashmap`); everything durable lives in Postgres.

**The golden rule — the server is "zero‑knowledge" for your content.** It only ever stores and relays *ciphertext*, wrapped‑key blobs, public keys, salts, and opaque call‑setup data. Your identity private keys, channel keys, message and file plaintext, live audio/video frames, and remote‑control keystrokes **never reach the server in a form it can decrypt**.

---

## 2. Accounts & sign‑in

**What it does.** You create an account with a username and password and sign in. On this instance, sign‑up requires an **invite code** (the owner shares it), so only invited people can register.

**How it works.**
- **Password‑authenticated sign‑in (SRP‑6a).** Púca uses the **Secure Remote Password** protocol (RFC 5054, 2048‑bit group, SHA‑256). Your password *never leaves your device* — not even during sign‑up. At registration the client derives a "verifier" (`v = g^x mod N`, where `x` is hashed from your salt + username + password) and sends only that. At login the client and server do a two‑step challenge/response and each proves to the other that they know the shared secret without transmitting it. The client even verifies the *server's* proof, which detects a man‑in‑the‑middle.
- **Sessions (JWT).** After a successful SRP handshake the server issues a **JSON Web Token** (HS256, 24‑hour expiry) carrying your user id. REST calls send it as a `Bearer` token; the WebSocket validates it *before* the connection is upgraded.
- **Registration gate.** When the server has `REGISTRATION_INVITE_CODE` set, `/auth/register` requires a matching code (compared in **constant time** so the code can't be guessed by timing) and returns 403 otherwise. Clearing the setting reopens sign‑up. Because the check is in the backend, it covers web, desktop, and mobile identically.

---

## 3. Servers, channels & categories

**What it does.** Create servers (organizational containers for a community), organize them with categories, and add text, voice, and "collection" channels. There's a shared default server everyone lands in, plus a public‑server discovery list.

**How it works.**
- **Servers** (`server_handlers.rs`, table `servers`). Creating one also creates a `general` channel, an `@everyone` role, and an `Owner` role, and makes you the owner. Owners can rename, toggle public/private, set a description, and upload a server icon (stored as an uploaded file, served from `/files/:id`). A hard‑coded "Main Server" auto‑joins every new user so nobody starts on an empty screen.
- **Channels** (`channel_handlers.rs`, table `channels`) come in three types: **text**, **voice**, and **collection** (an aggregated feed of its child channels). They can nest under a parent and sit inside categories, support drag‑to‑reorder, per‑channel **slowmode**, and an optional **checklist**. Creating a channel broadcasts a realtime `ChannelCreated` event so everyone's sidebar updates instantly.
- **Categories** (`category_handlers.rs`) group channels; deleting a category just un‑files its channels.

---

## 4. Messaging

**What it does.** Send and receive messages, edit them (with history), delete, reply, pin, search, and scroll back through history. Messages arrive in realtime.

**How it works.**
- **Sending** (`message_handlers.rs → send_message`). The server checks you're a member of the channel, validates the content (non‑empty, ≤ 8000 bytes, no null bytes), enforces any **timeout** or **slowmode**, stores the (already‑encrypted) message, and **broadcasts** it over WebSocket to everyone else in that channel's "room". The realtime fan‑out primitive is `AppState::broadcast_to_room` (`state.rs`), which pushes to each connected member's private channel.
- **History & search.** `get_messages` is paginated with a "load older" timestamp cursor; `search_messages` does a safe wildcard `LIKE`.
- **Edit / delete / pin.** Edits snapshot the previous text into an edit‑history table; deletes are allowed for the author or anyone with *Manage Messages*; pins require *Manage Messages*.
- **Encryption is transparent to the server.** What's stored in a message's `content` is an **encrypted envelope** (see §15). The server relays those bytes verbatim; only the members' devices can read them.

---

## 5. Direct messages, friends & blocking

**What it does.** One‑to‑one conversations, a friends list, and the ability to block someone.

**How it works.**
- **DMs** (`dm_handlers.rs` + the WebSocket path in `ws.rs`). A conversation is a single row for the ordered pair of user ids (`UNIQUE`), created race‑safely so two people opening a chat at once converge on one thread. Live DMs go over the WebSocket and are echoed to *both* participants. DMs are end‑to‑end encrypted with a key only the two of you can compute (see §15).
- **Blocking** (`moderation_handlers.rs`, table `blocked_users`) is enforced on **both** DM paths (REST and WebSocket), so a blocked user can't reach you either way.
- **Friends** (`friend_handlers.rs`) back the DM list and also widen who can see you're online (see §9). Requests are send/accept/reject; the panel polls for updates.

---

## 6. Reactions & emojis

**What it does.** React to any message with standard emoji or your server's **custom** emoji, from a searchable, categorized picker.

**How it works.** `reaction_handlers.rs` stores reactions uniquely per (message, user, emoji), gated by channel/DM membership. Custom emojis are uploaded images stored per‑server (unique name), referenced in reactions as `:name:`. Every add/remove broadcasts a `ReactionUpdate` so counts refresh live. The picker's dataset and name‑keyword search live in `frontend/src/api/emojis.ts`.

---

## 7. Roles & permissions

**What it does.** Role-based access control with granular permissions per server.

**How it works.** Permissions are **64‑bit flags** (`permissions.rs`): view/send/manage messages, attach files, add reactions, voice connect/speak/video/stream, and admin bits (manage channels/roles/server, kick, ban, administrator). Your effective permissions in a server are the **OR** of all your roles plus the default `@everyone` role — and the server **owner** is short‑circuited to full Administrator. Role management itself requires *Manage Roles* (which stops privilege escalation). Assigning/removing roles, kicking, and banning happen through role‑gated handlers.

---

## 8. Invites

**What it does.** Two different "invites":

- **Server invites** — short codes that let an *existing* account join one of your servers (with optional expiry and max‑uses). `invite_handlers.rs`; redeeming one adds a `server_members` row and grants `@everyone`. A public preview endpoint shows the server name + member count before you join.
- **Registration invite code** — the single shared code that gates *account creation* on this instance (see §2). Distinct from server invites.

---

## 9. Presence & typing

**What it does.** Shows who's online and who's typing — but only to people who should see you.

**How it works.** Presence is **in‑memory only** (no database table): when your WebSocket connects, the server marks you online and notifies a **scoped audience** — people who share a server with you *plus* your accepted friends — and notifies the same set when you disconnect. This deliberately avoids leaking your online status to strangers. Typing indicators are ephemeral WebSocket events that expire after a few seconds. Voice presence (who's in a call, sharing, or on camera) is tracked per room and broadcast as it changes.

---

## 10. Task lists & checklists

**What it does.** Two kinds of Google‑Keep‑style lists: **channel checklists** shared by a server's members, and **personal task lists** only you can see. One level of subtasks, drag‑to‑reorder, and a completion cascade (checking a parent checks its subtasks).

**How it works.** `task_handlers.rs` with tables that scope each task to *either* a channel *or* a personal list (enforced by a database check). Personal lists are **encrypted to yourself** (only your identity key can read them); channel checklists are encrypted under the **channel key** just like messages (see §15). The UI (`ChecklistPanel`, `TasksView`, `TaskTree`) mirrors the server's cascade optimistically for snappy interaction.

---

## 11. Profiles, nicknames & moderation

- **Profiles** (`handlers.rs`): a display name and avatar, editable in settings, plus per‑server **nicknames** (set with the `/nick` command). A profile popup shows top‑role color, online status, and quick actions (message, add friend, verify encryption, and — for admins — role management, kick, ban).
- **Moderation** (`moderation_handlers.rs`): kick, ban/unban, **timeout** (enforced when sending), reports, and an admin **audit log**. Kicks and bans send a realtime event that boots the removed user's client immediately.

---

## 12. Voice, video & screen share

**What it does.** Group voice calls, camera video, and screen sharing — peer‑to‑peer, encrypted, with a live 🔒 indicator.

**How it works.**
- **Mesh peer‑to‑peer (WebRTC).** Each participant opens a direct `RTCPeerConnection` to every other participant. The Rust server is only a **dumb signaling relay** — it forwards the call‑setup messages (SDP/ICE) and never inspects the media. This keeps ~4 participants comfortable (a full mesh; not a central media server).
- **Connectivity (STUN/TURN).** To punch through home routers, clients use **STUN** for address discovery (the operator's own relay when one is configured; Google's public STUN only as a last resort on a deployment without one) and, when direct connection fails, the operator's **self‑hosted TURN relay** (coturn) that only relays. There is no third‑party relay fallback: TURN credentials are **time‑limited and issued only to signed‑in users** (a 4‑hour HMAC token tied to your account), and anonymous callers get STUN only. Even when media flows through TURN, the relay only ever sees ciphertext.
- **End‑to‑end media encryption.** On top of WebRTC's built‑in transport encryption (DTLS‑SRTP), Púca encrypts **each audio/video frame itself** with AES‑256‑GCM using **Insertable Streams**, so a compromised or malicious relay can't watch or listen. Each call also negotiates a **forward‑secret** key from fresh per‑call ephemeral keys, so a future compromise of your identity key can't decrypt a past recorded call. The voice panel shows **🔒 Encrypted / 🔓 Partial / 🔓 Not E2EE** so any downgrade is visible. (Frame E2EE needs a Chromium‑based browser; Firefox/Safari fall back to transport‑only and say so.)
- **Screen‑share tuning.** Up to 8 Mbps / 60 fps, biased toward keeping framerate smooth for gaming.

---

## 13. Remote screen control

**What it does.** While you share your screen, a trusted friend can request control and drive your mouse and keyboard — e.g. to play your game while you're briefly away.

**How it works.**
- **Host is desktop‑only.** Only the Windows desktop app can *receive* control, because it injects input through the OS (`SendInput`). Keys are sent by **hardware scan code** (many games ignore key‑code‑only injection), and mouse moves map correctly across multiple monitors.
- **Encrypted control channel.** Every keystroke and mouse move is **end‑to‑end encrypted** with a per‑session key derived from a fresh ephemeral handshake (an X3DH/Noise‑style exchange), sealed with AES‑256‑GCM and a sequence number to stop replay/reorder. If the key is missing, input is **dropped, never sent in the clear**.
- **You stay in control.** Explicit approval per request; one controller at a time; and multiple kill‑switches: touching your own mouse/keyboard instantly revokes control (a low‑level input hook that ignores the app's own injected events), an Escape hotkey, an inactivity timeout, and automatic teardown if the call drops or sharing stops.
- **Anti‑cheat aware.** The host **refuses to grant control while a kernel anti‑cheat is running** (Easy Anti‑Cheat, BattlEye, Vanguard, FACEIT, etc.), because injected input is unreliable there and could get an account banned.

---

## 14. Noise suppression

**What it does.** Cleans up your microphone. Four tiers, selectable in settings.

**How it works.** `off` (raw mic); **standard** (the browser's built‑in noise suppression + echo cancel + auto‑gain — zero cost, works everywhere); **RNNoise** (a small machine‑learning model running in an audio worklet — better on keyboards/fans, works in the browser too); and **DeepFilterNet** (the highest‑quality ML model — the DFN3 WebAssembly build running in a dedicated background worker fed by an audio worklet, ~60 ms added latency — 30 ms is the model's own look‑ahead — real CPU cost). The mode is picked in Settings → Voice (Voice Processing → Noise Suppression Mode) or from the voice panel — one setting, two pickers, applied live mid‑call — and Settings → Voice → Mic Test records a few seconds of the raw mic and loops the take back through whatever mode and input volume are selected — change them while it loops and the same take changes (no live monitoring, so no feedback). DeepFilter is experimental: it appears in the picker only after enabling it under Settings → Advanced → Experimental, falls back to RNNoise if it can't start, and downgrades itself mid‑call if the device can't keep up. It is a *speech* model — it will also suppress music and other non‑voice audio, so RNNoise remains the better pick for instruments. Voice is captured mono; the mic can be hot‑swapped between modes mid‑call.

---

## 15. The encryption model, in depth

This is the heart of Púca. Everything below happens **on your device**; the server only sees the encrypted results.

**Identity keys.** Each account has an **X25519** key pair. In the current scheme the private key is a **random 32‑byte seed** generated once; your public key is derived from it and published so others can encrypt to you.

**Direct messages.** Both people compute the *same* key from their own private key and the other's public key (an **X25519 Diffie‑Hellman**), run it through **HKDF‑SHA256**, and encrypt with **AES‑256‑GCM**. No key exchange through the server is needed.

**Channels (group chat).** Each channel has a symmetric **channel key**; messages are AES‑256‑GCM‑encrypted under it for a given **epoch**. The key is delivered to each member by "wrapping" it: the distributor derives a per‑member key from Diffie‑Hellman and encrypts the channel key for them. When membership changes, a **new epoch key** is minted and wrapped only for current members — so someone removed from a channel **cannot read future messages** (forward secrecy), while past messages they legitimately had stay readable.

**Notes to yourself** (personal task lists) are encrypted with a key derived from your own identity — only you can read them, and they follow you through a password change.

**Files.** Each attachment is encrypted on your device with its own random AES‑256‑GCM key and uploaded as an anonymous blob (`attachment.enc`) — the server never sees the filename, type, or contents. The key travels *inside* the (already‑encrypted) message. Only people who can read the message can open the file.

**Account recovery (without weakening encryption).** Because the identity seed is random (not derived from your password), Púca stores **two encrypted copies** of it: one unlocked by your password, one unlocked by a **12‑word recovery phrase** (BIP39) shown once at sign‑up. Forgetting your password no longer means losing your history — recover with the phrase, set a new password, keep your keys. The password‑unlock uses **Argon2id** (m=19 MiB, t=2, p=1 — the 2026 OWASP minimum, memory‑hard so a GPU farm gains little); accounts created under the older PBKDF2‑SHA256 wrap are upgraded transparently on their next login, with a clamp so a hostile server can't stall your login by demanding an absurd work factor. A **proof‑of‑possession** step stops a database thief from resetting anyone's password without actually holding their key.

**Verifying there's no man‑in‑the‑middle (safety numbers).** Two people can compare an **8×5‑digit safety number** (a hash of both their public keys) out loud. If they match, no one swapped a key in the middle. Púca also **pins** each contact's key the first time it sees it and refuses to proceed if it ever silently changes (trust‑on‑first‑use, fail‑closed).

**What the server can and can't do.** It can see *who talks to whom and when* (metadata), relay your traffic, and — as the operator — deny service. It **cannot** read message/file/task contents, listen to or watch calls, read remote‑control input, or forge a valid update or media stream. Downgrade attempts (e.g. stripping media encryption) fail *safe* to a weaker‑but‑not‑broken state and are shown in the UI.

---

## 16. Platforms & how updates work

**Desktop (Tauri).** A signed installer. The app checks a small version file on launch and every few hours; when there's a newer version it shows a banner and does a **one‑click, signed, in‑place update** verified by a **minisign** signature baked into the app, so a tampered installer is rejected.

**Mobile (Capacitor + authenticated OTA).** The web part of the app updates **over‑the‑air** without an app‑store round trip, and those updates are **cryptographically signed**: each bundle is encrypted and its hash is RSA‑signed with a private key kept **off the server**, and the app verifies it against a public key baked into the install. A tampered or forged bundle is rejected. The client also refuses to *downgrade* to an older bundle and only accepts bundles from the right host. (Native changes still ship as a normal APK.)

**Browser.** The same app, served as a static site — nothing to install. Native‑only features (being the *host* of remote control, per‑app audio capture) gracefully turn off; everything else — including all four noise‑suppression tiers — works.

---

## 17. How it's hosted

A deployment is **self‑hosted** and fits on a single small server — a VPS or a container on a home machine. **Caddy** sits in front and automatically provisions HTTPS certificates for `chat.example.com` (API/WebSocket), `download.example.com` (installers/updates), and `app.example.com` (the web app), with **coturn** beside it as the media relay. The Rust backend runs as a hardened **systemd** service against **PostgreSQL**; database migrations apply automatically on startup. The shipped ops scripts give you nightly backups (database, attachments and configuration, encrypted offsite) and a 5‑minute health‑check that restarts the service if it ever stops responding. Auth endpoints and the general API are **rate‑limited**, CORS is locked to the known origins, and the server refuses to boot in production without a strong secret. The full path is `deploy/README.md`.

---

## 18. Technology reference

**Frontend:** React 19, TypeScript, Vite, TanStack Query, React Router. Crypto: `@noble/curves` (X25519), `@noble/hashes` (Argon2id, HKDF/HMAC/SHA‑256, PBKDF2 for legacy wraps), `@scure/bip39` (recovery phrase), Web Crypto (`crypto.subtle`) for AES‑GCM and native PBKDF2. Audio: `@sapphi-red/web-noise-suppressor` (RNNoise) + an in‑repo DeepFilterNet WebAssembly build.

**Backend:** Rust, axum, sqlx (PostgreSQL), tokio, dashmap; `srp` (SRP‑6a), `x25519-dalek` + `hkdf`/`hmac`/`sha1` (recovery DH proof + TURN credentials), `jsonwebtoken`, `tower_governor` (rate limiting), `lettre` (email).

**Shells:** Tauri 2 (desktop) with Windows crates for input injection, window/audio capture, and process enumeration; Capacitor 8 (mobile) with the Capgo updater.

**Crypto primitives used:**

| Purpose | Primitive |
|---|---|
| Sign‑in | SRP‑6a (RFC 5054 2048‑bit, SHA‑256) → JWT (HS256, 24h) |
| Identity keys | X25519 |
| DM / channel‑key wrap | X25519 ECDH → HKDF‑SHA256 → AES‑256‑GCM |
| Channel messages | AES‑256‑GCM per epoch |
| Files | AES‑256‑GCM (per‑file random key) |
| Media frames | AES‑256‑GCM (Insertable Streams) + per‑call forward secrecy |
| Remote control | AES‑256‑GCM over an ephemeral X25519 handshake, sequence‑numbered |
| Password → key wrap | Argon2id (m=19 MiB, t=2, p=1); legacy accounts on PBKDF2‑SHA256 migrate on next login |
| Recovery phrase | BIP39 (128‑bit) |
| Safety number | SHA‑256 of both public keys |
| Desktop update | minisign signature |
| Mobile update | AES‑128‑CBC bundle + RSA‑signed SHA‑256 |
| TURN credentials | HMAC‑SHA1, 4‑hour expiry, per‑user |

---

## 19. Known limitations

Things a reader should know before relying on them:

- **@mentions** are highlighted on your device only. Message bodies are ciphertext to the server, so it cannot see a mention and cannot send a mention‑specific notification; the notification preferences still offer the setting, and it applies to what the app itself can detect.
- **Frame‑level media encryption needs a Chromium‑based browser** (Insertable Streams). Firefox and Safari fall back to transport encryption only and the call indicator says so.
- **Mesh voice is comfortable for about four participants**; larger rooms need the optional LiveKit SFU, which is a separate service the operator runs.
- **Calls across the internet need the operator's TURN relay** — there is no third‑party fallback, by design.
- Several **legacy `001` tables** (`roles`, `reactions`, `invites`, …) are superseded by later‑migration tables and are effectively dead; they are kept because applied migrations are frozen.

---

## 20. FAQ (for everyone)

**What is Púca, in one sentence?**
A private, self‑run chat and voice app — you host it, and no one (not even the server) can read your messages or listen to your calls.

**Is it really private? What can the person running the server see?**
Your messages, files, task notes, calls, and screen‑control input are **end‑to‑end encrypted** — the server stores only scrambled data it can't unlock. What it *can* see is metadata: usernames, who talks to whom and when, and how big things are. As with any messenger, the operator could also choose to shut the service down. It can't read your content.

**Do I need to understand any of the crypto to use it?**
No. It's on by default and automatic. The only optional bit is the "verify encryption" / safety‑number feature, which lets two careful people double‑check no one's snooping — you can ignore it and everything still works.

**I forgot my password. Am I locked out forever?**
No. When you signed up you got a **12‑word recovery phrase** — keep it somewhere safe (a password manager). With it you can reset your password *and keep all your history*, because your encryption keys survive the reset. Without your password *and* without the phrase, though, your data genuinely can't be recovered — that's the price of real encryption.

**Why does sign‑up ask for an invite code?**
This instance is invite‑only so only people the owner trusts can create accounts (and use the owner's resources). Ask them for the code; you enter it once when signing up.

**Which should I use — the desktop app, the phone app, or the website?**
Whatever's handy — it's the same app and the same account. The desktop app has the most features (it can be the one whose screen gets remote‑controlled, has the best noise suppression, and can capture game audio). The website needs nothing installed. On phones, install the app.

**Can my friend really play my game while I'm away?**
Yes — if you share your screen, they can request control of your mouse and keyboard, and you approve it. You can take control back instantly just by touching your own mouse or hitting Escape. Note: it won't work in games with kernel anti‑cheat (it refuses, to avoid bans), and only the Windows desktop app can be the one being controlled.

**Are voice and screen share encrypted too?**
Yes — end‑to‑end, on top of WebRTC's own encryption, and each call uses fresh keys so a future breach can't unlock a past call. A little lock icon shows the status. (Full media encryption needs a Chromium browser — Chrome/Edge; Firefox and Safari fall back to standard transport encryption and tell you so.)

**Is my microphone being cleaned up?**
If you want. There are four noise‑suppression levels from "off" to a high‑quality AI filter (DeepFilterNet on desktop), so keyboards, fans, and background chatter can be filtered out.

**How do updates work — will it nag me or break?**
Desktop shows a one‑click "update available" banner and installs a **signed** update in place. Mobile updates the app **over the air**, also **signed**, so a tampered update is rejected. The website is always current. If a signed update can't be verified, it simply isn't applied.

**Is it open about how it works?**
Yes — this document describes the real mechanisms, and the encryption uses standard, well‑known building blocks (X25519, AES‑GCM, HKDF, SRP, PBKDF2, BIP39), not home‑made secrecy.
