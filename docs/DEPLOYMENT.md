# Púca — who does what when you host it

> **The deployment guide is [`deploy/README.md`](../deploy/README.md).** It is
> the canonical, tested-against-the-code path and it covers everything this
> page used to: server prep, the systemd unit, the reverse proxy, the client
> builds and their signing keys, the download site, backups, TURN and the
> optional SFU. This page keeps only the framing — the three audiences and
> how the pieces fit — because that is the part a first-time host asks about
> before opening the guide.

Three audiences:

1. **You (host)** — run the backend + Postgres on your server.
2. **You (builder)** — produce the desktop installers and the Android APK your
   friends download, signed with keys that are yours.
3. **Friends (clients)** — install the app and connect to your server. Nothing
   to configure on their side: the server address is baked in when you build.

## How the pieces fit together

```
          ┌───────────────────── your server ─────────────────────┐
Desktop /  │  Caddy/nginx (TLS 443)  ─►  puca backend :3000        │
Android /  │   forwards ALL paths (the API lives at the root; the  │
web client │   only /api route is /api/mobile-updates/check)        │
   │       │              backend ─►  PostgreSQL :5432              │
   │       │  coturn :3479 (UDP/TCP) — the media relay for calls   │
   │       └────────────────────────────────────────────────────────┘
   └── points at VITE_API_URL (baked in at build time)
```

- The **backend** (`cargo build --release` → `puca`) is one binary serving
  the REST API + WebSocket on port `3000`; it needs PostgreSQL and **runs its own
  migrations on startup** (no manual `psql` needed). The systemd unit is
  [`deploy/puca.service`](../deploy/puca.service).
- **Routing:** the client calls the API at the *root* of `VITE_API_URL`
  (`POST https://…/auth/login/step1`, `GET https://…/servers`, `wss://…/ws`),
  so the reverse proxy must forward **every** path to `:3000` — not just
  `/api/`. The shipped [`deploy/Caddyfile`](../deploy/Caddyfile) and
  [`deploy/nginx.conf`](../deploy/nginx.conf) do; they also set the request
  body size uploads need and pin the forwarded client IP.
- The **client** (React app) is built once with `VITE_API_URL` pointing at your
  server (copy `frontend/.env.production.example` to the gitignored
  `frontend/.env.production`), then shipped as a **Tauri desktop app** for
  Windows (Full and Lite builds), a **web page** on its own origin, or the
  **Android app** (Capacitor). The desktop updater endpoint and its public
  key come from the gitignored `frontend/src-tauri/tauri.release.json`
  overlay, never from edits to the tracked `tauri.conf.json`.
- **Calls across the internet need the relay.** There is no third-party TURN
  fallback; run coturn ([`deploy/turn/README.md`](../deploy/turn/README.md)).
  Voice is peer-to-peer mesh by default; a LiveKit SFU is optional for larger
  rooms ([`deploy/livekit/README.md`](../deploy/livekit/README.md)).
- **Builds are signed.** Desktop installers carry a minisign signature the app
  verifies before self-updating; mobile OTA bundles are RSA-signed; the APK is
  signed with your Android keystore. The guide's "Keys that are yours" table
  says which key does what and what losing each one costs.

## Local try-out first

`README.md`'s Quick start runs everything on your own machine (`cargo run` +
`npm run dev` against a local Postgres). Do that before renting a server; the
production path starts at [`deploy/README.md`](../deploy/README.md) section 0.
