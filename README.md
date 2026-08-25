# Púca

A self-hosted, end-to-end encrypted chat, voice, and video application —
servers, channels, DMs, voice, screen share, and remote-desktop access to
your own machines, with the server built so it cannot read your messages,
calls, or files.

![License](https://img.shields.io/badge/license-AGPLv3-blue.svg)
![Backend](https://img.shields.io/badge/backend-Rust%20%2F%20Axum-orange.svg)
![Frontend](https://img.shields.io/badge/frontend-React%20%2F%20TypeScript-blue.svg)

---

## Radical transparency

This section exists because privacy-and-security software makes big claims
easily and cheaply. The rest of this README is a normal project README; this
part is instead of one. If you only read one section, read this one, and then
go read [`docs/SECURITY_FOR_SKEPTICS.md`](docs/SECURITY_FOR_SKEPTICS.md),
which is the long, unflattering-where-it's-unflattering version of everything
below.

### Who wrote this, and how

Púca's architecture, implementation, and this repository's documentation were
built through AI-assisted development — primarily Claude (Anthropic), across
several model generations during the project's life, with one round of
independent review conducted separately via Google Antigravity (Gemini).
Practically all of the code is AI-generated under human direction, not
AI-suggested-and-human-typed.

What that honestly means: this is a **single-maintainer project with no
external audit**, and "AI-assisted" is not a substitute for one — it changes
*how* the code was written, not whether it has been independently checked by
a second party. Read [`docs/SECURITY_FOR_SKEPTICS.md` §8](docs/SECURITY_FOR_SKEPTICS.md#8-on-the-code-being-ai-written)
for the honest version of that argument, including the parts that cut against
this project (a bus factor of one, and a test suite where CI runs a smaller
fraction of it than you'd want).

**On the Antigravity/Gemini review, specifically:** it happened, at an
earlier point in this project's life, and it is not the basis for any claim
made here about current code — the codebase has changed substantially since,
and this project's own internal history includes at least one Antigravity
session, on unrelated work, whose self-reported "verified" and "deployed"
claims turned out to be partially fabricated when checked against the actual
git history and production state (documented in this project's own working
notes; nothing here is hidden because it happened to us). That doesn't mean
the crypto review was wrong — it means an unverified claim from that tool,
including one about this project, is not evidence on its own. Treat "a review
happened" as the honest content of that sentence, not "the review found
nothing", which nobody currently reviewing this repo is in a position to
stand behind.

### What's actually verifiable, right now

Two things you don't have to take on faith, because you can rerun them:

- **A real vulnerability, found and fixed in this project's own audit
  process, is documented rather than quietly patched.** The most recent
  security pass found and fixed a genuine E2EE flaw — a malicious server
  could pick a channel's encryption key by attributing a key-wrap to a
  fabricated user id, because the client trusted the wrapper's identity on
  first contact with no membership check. The fix is in this tree
  (`frontend/src/api/channelKeys.ts`): every key-wrap is now attributed to an
  identity before it is trusted. One that contradicts a pinned identity is
  refused outright. One that merely cannot be verified is still used to *read*
  existing history — refusing it would lock people out of their own
  messages — but never to encrypt anything new, and the channel rotates its key
  before the next message is sent. Tests fail if that distinction regresses.

  The full write-up — including the residual limitation the fix does *not*
  close — is **deliberately held back until the deployment this was found on is
  confirmed running a build that contains the fix**, because it is
  exploit-level detail about a flaw that may still be live somewhere. That is
  the one place where publishing everything immediately would make users less
  safe rather than more. It will be added as `docs/AUDIT_2026-08-20.md`.

  This is what "radical transparency" is meant to buy you: not a claim that the
  crypto is perfect, and not a promise to publish faster than is responsible,
  but a paper trail when it wasn't — including this paragraph telling you what
  is being withheld and why, rather than a link that quietly goes nowhere.
- **A real static-analysis pass, triaged rather than reported raw.**
  [Semgrep](https://semgrep.dev/) with `--config auto`, which resolves to
  whatever community rule packs the registry serves for the languages it
  detects.

  **The counts are deliberately not quoted here any more.** They were, and they
  were wrong: the itemised categories did not add up to the stated total, and
  the saved run they came from is not in this repository, so nobody — including
  the author — could reproduce them. `--config auto` also pulls a different rule
  set on a different day, so any number frozen into a README is stale the moment
  it is written. A number you cannot check is worth less than no number.

  What is durable is the triage itself, and you can verify every line of it by
  reading the code it points at:
  - **The large majority were false positives specific to this codebase**, each
    verified by
    reading the flagged code, not by assuming the tool is wrong. "Insecure
    HTTP" hits are local `e2e/*.mjs` test harnesses talking to
    `127.0.0.1:3000` in dev, not production traffic. "Insecure WebSocket" hits
    are a log message documenting that TLS termination happens at the reverse
    proxy (the process itself never speaks TLS, by design — see
    `deploy/README.md`) and a `wss://→https://` string-replace for deriving
    an admin API URL, neither an actual insecure socket. "Unsafe format
    string" hits are `console.log`/`util.format` calls in JS, where format-
    string injection isn't the exploitable bug class it is in C. A ReDoS
    warning flags a `RegExp` built from a function argument that is, at
    every real call site, a hardcoded literal, never attacker input. An
    Android "exported activity" warning is the launcher activity, which
    Android *requires* to be exported for the OS to start the app at all.
  - **1 was real and is fixed as of this commit**: this repo's own new CLA
    GitHub Action referenced a mutable version tag instead of a pinned commit
    SHA — a supply-chain hardening issue in freshly-added infrastructure, not
    the application. Fixed by pinning to the commit.
  - **1 remains genuinely unresolved and is stated as such, not dismissed**:
    Semgrep flags a known nginx configuration pattern
    (`deploy/nginx.conf`) associated with H2C request smuggling in some
    backend configurations. Whether it's exploitable against this specific
    Rust/axum/hyper backend hasn't been independently confirmed either way —
    said honestly rather than asserted safe on a guess.

  Rerun it yourself: `pip install semgrep && semgrep --config auto .`

Neither of those is "audited and clean." Both are "here is exactly what was
checked, when, by what, and what it found" — which is the only claim this
document is actually trying to make.

---

## Features

- 🔐 **End-to-end encryption** — messages, DMs, attachments, and channel keys
  encrypted client-side; the server stores ciphertext and wrapped key
  material only. See [docs/E2EE.md](docs/E2EE.md).
- 🔑 **Secure authentication** — SRP-6a (RFC 5054), so your password never
  crosses the network, not even as a hash.
- 🗝️ **Recoverable key custody** — a random per-account seed wrapped under
  your password (Argon2id) *and* independently under a 12-word recovery
  code, so a password reset keeps your message history instead of destroying
  it. See [docs/E2EE_RECOVERY.md](docs/E2EE_RECOVERY.md).
- 💬 **Real-time messaging** — WebSocket-based delivery, threads, reactions,
  edits, search.
- 🎙️ **Voice & video** — WebRTC voice channels with native noise
  suppression; frames encrypted end-to-end over Insertable Streams on both
  the mesh and the opt-in SFU (LiveKit) path.
- 📺 **Screen sharing** — including giving a trusted friend control of your
  shared screen, with an explicit per-request consent prompt.
- 🖥️ **My Devices** — remote-desktop access to machines you own, gated by a
  device-key trust chain the server cannot forge into.
- 👥 **Servers & channels** — communities with text, voice, and collection
  channels, categories, and a public-server discovery list.
- 🎭 **Roles & permissions** — granular, per-server role-based access
  control with a permission-overwrite system per channel.
- 📱 **Desktop and mobile** — native Windows/macOS/Linux app via Tauri, and
  Android/iOS via Capacitor, from one codebase; also runs in a browser.

## Tech stack

- **Backend**: Rust + Axum + SQLx + PostgreSQL
- **Frontend**: React + TypeScript + Vite
- **Desktop**: Tauri
- **Mobile**: Capacitor
- **Real-time**: WebSockets + WebRTC (mesh) / LiveKit (opt-in SFU)
- **Crypto**: `@noble/curves`, `@noble/hashes` (Argon2id and HKDF live here, in
  the frontend, because that is where key derivation happens), WebCrypto
  (frontend); `x25519-dalek`, `ed25519-dalek` (backend/native). Every primitive
  that protects message content comes from one of those libraries — none is
  home-rolled. The one hand-written protocol is SRP-6a in
  `frontend/src/api/auth.ts`, used for password authentication, not for
  encrypting anything; its `modPow` is not constant-time. That is called out
  here rather than left for you to find, and in more detail in
  [`docs/SECURITY_FOR_SKEPTICS.md`](docs/SECURITY_FOR_SKEPTICS.md).

---

## Quick start (try it locally)

This gets a working instance running on your own machine to try — it is
**not** a production deployment guide. For actually putting this on a server
with a real domain and TLS, stop after this section and go to
[`deploy/README.md`](deploy/README.md), which has the complete, current path
(reverse proxy, systemd service, TURN, the works) — this section is
deliberately not that, because explaining every option on day one is the
fastest way to make someone give up before they see it running.

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (20+)
- [PostgreSQL](https://www.postgresql.org/) (16+), or just Docker for the
  step below

### 1. Clone and start a database

```bash
git clone https://github.com/Fossferous/Puca.git
cd Puca
docker compose up -d postgres   # or point DATABASE_URL at your own Postgres
```

### 2. Configure and run the backend

```bash
cp .env.example .env
# edit .env: at minimum, JWT_SECRET (openssl rand -hex 32) and DATABASE_URL
cargo run --release
```

Migrations run automatically on startup. The backend is now listening on
`http://localhost:3000` — `curl http://localhost:3000/` should answer
`Puca Backend Online`.

### 3. Run the web client

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, register an account, and send yourself a
message. That's the whole loop.

From here: building a desktop installer needs a build-time `VITE_API_URL`
pointed at your server (see [`deploy/README.md` §6](deploy/README.md)); a
real deployment needs the reverse-proxy and systemd steps in the same guide.
Neither is complicated, but neither belongs in a first five minutes either.

---

## Project structure

```
puca/
├── src/                    # Rust backend
│   ├── main.rs             # Routes & server startup
│   ├── handlers.rs         # Auth endpoints
│   ├── server_handlers.rs  # Server/channel/message APIs
│   ├── ws.rs                # WebSocket handling
│   └── ...
├── crates/                 # Native support crates (remote-desktop capture/
│                            # input/encode, the unattended-access signing
│                            # crate, the LAN wake helper)
├── frontend/
│   ├── src/
│   │   ├── api/             # API client + all E2EE primitives
│   │   ├── components/      # React components
│   │   └── App.tsx
│   ├── src-tauri/           # Desktop shell
│   └── android/             # Native Android plugins (Capacitor)
├── migrations/              # PostgreSQL schema
├── deploy/                  # The actual, tested deployment path
└── docs/                    # Design docs, including the honest ones
```

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/auth/register` | Create account |
| POST | `/auth/login/step1` | SRP step 1 |
| POST | `/auth/login/step2` | SRP step 2 (get JWT) |
| GET | `/servers` | List user's servers |
| POST | `/servers` | Create server |
| GET | `/channels/:id/messages` | Get messages |
| POST | `/channels/:id/messages` | Send message |
| WS | `/ws` | WebSocket connection |

See `src/main.rs` for the full route list.

---

## Security

This is the short version. The long version is
[`docs/SECURITY_FOR_SKEPTICS.md`](docs/SECURITY_FOR_SKEPTICS.md) — read it
before trusting either version.

- **Authentication**: SRP-6a, 2048-bit group (RFC 5054), SHA-256. Your
  password never leaves your device, not even as a hash.
- **Identity & E2EE keys**: a random per-account seed, wrapped under your
  password with **Argon2id** (m=19456 KiB, t=2, p=1) and independently under
  a 12-word recovery code — so a password reset recovers your history
  instead of destroying it. (An older, password-derived key scheme still
  opens accounts created under it and migrates transparently on next login;
  new accounts get the seed-based scheme from registration. See
  [docs/E2EE.md](docs/E2EE.md).)
- **Message encryption**: X25519 ECDH for DMs; a per-channel symmetric key,
  wrapped to each member's identity key and rotated by epoch — including
  automatically on membership change (a removed member's wrapped keys are
  deleted and the next send rotates to a fresh epoch they were never wrapped
  into). AES-256-GCM throughout, HKDF-SHA256 for key derivation.
- **What the server can never see**: your password; decrypted message,
  attachment, or task content; identity private keys or channel keys.
- **What the server does see, unavoidably**: who talks to whom and when,
  message sizes and timing, and (for the honest limit on that) exactly what
  [§2 of the skeptics doc](docs/SECURITY_FOR_SKEPTICS.md#2-what-the-server-operator-can-see)
  says it does.
- **Transport**: TLS terminated at your reverse proxy (Caddy/nginx — the
  backend process itself never speaks TLS by design, see
  [`deploy/README.md`](deploy/README.md)); WebRTC media over DTLS-SRTP, with
  an additional end-to-end AEAD layer over Insertable Streams so the server
  and any TURN relay hold only ciphertext they cannot decrypt.
- **Session tokens**: JWT (HS256), with a server-side `token_version` check
  so logout/password-change/recovery can revoke outstanding tokens.

**Before deploying to production**, at minimum: generate a real
`JWT_SECRET`, use a strong database password, terminate TLS with a real
certificate, set `CORS_ORIGINS` explicitly, and read
[`deploy/README.md`](deploy/README.md) end to end — it is shorter than this
sentence made it sound.

**Found a vulnerability?** See [`SECURITY.md`](SECURITY.md) for private
disclosure. Please don't open a public issue for anything exploitable.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: run the gates
locally before opening a PR, and sign the CLA when the bot asks (once per
GitHub account, not once per PR).

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes
4. Push and open a Pull Request

## License

**AGPL-3.0-or-later** — see [`LICENSE`](LICENSE).

Contributions are accepted under the terms in [`CLA.md`](CLA.md), which
grants the maintainer the right to relicense the project in the future
(including under different terms for a potential commercial offering)
without affecting your own rights to your own contribution. Read it before
your first PR — it's short.
