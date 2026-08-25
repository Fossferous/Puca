# Púca — Install, Test & Hosting Guide

Three audiences:

1. **You (host)** — run the backend + Postgres on your server.
2. **You (builder)** — produce the desktop installers your friends download.
3. **Friends (clients)** — install the app and connect to your server.

## How the pieces fit together

```
          ┌───────────────────── your server ─────────────────────┐
Desktop /  │  Caddy/nginx (TLS 443)  ─►  puca backend :3000    │
web client │   forwards ALL paths, incl. /ws and /api/updates       │
   │       │              backend ─►  PostgreSQL :5432              │
   │       └────────────────────────────────────────────────────────┘
   └── points at VITE_API_URL (baked in at build time)
```

- The **backend** (`cargo build --release` → `puca`) is one binary serving
  the REST API + WebSocket on port `3000`; it needs PostgreSQL and **runs its own
  migrations on startup** (no manual `psql` needed).
- **Important routing fact:** the client calls the API at the *root* of
  `VITE_API_URL` (e.g. `POST https://…/auth/login/step1`, `GET https://…/servers`,
  `wss://…/ws`, `GET https://…/api/updates/…`). So the reverse proxy for the
  backend host must forward **every** path to `:3000` — not just `/api/`.
- The **client** (React app) is built once with `VITE_API_URL` pointing at your
  server, then shipped as a **Tauri desktop app** (main path for friends), a
  **web page**, or a **Capacitor mobile app**. The server URL is baked in at
  build time; friends don't configure anything. Current value:
  `http://localhost:3000` (`frontend/.env.production`) — a placeholder for local
  testing. Set it to your real host when you deploy (see Part 1).

---

## Part 1 — Hosting the backend

When you're ready to host for others, pick a domain (referred to below as
`your-server.example`) and give Púca its own hostname/subdomain.

### 1.1 DNS
Add `your-server.example → <your server IP>` (A/AAAA record).

### 1.2 PostgreSQL
Docker (`docker compose up -d postgres` uses the bundled `docker-compose.yml`) or
native (`apt install postgresql`, `createdb puca`). Keep the connection string.

### 1.3 Backend as a systemd service
Clone to `/opt/puca`, `cargo build --release`, and create
`/opt/puca/.env`:

```env
DATABASE_URL=postgres://postgres:STRONG_PASSWORD@localhost:5432/puca
JWT_SECRET=<64+ random chars — CHANGE THIS>
CORS_ORIGINS=https://your-server.example
PORT=3000
# Optional email (password reset / verification):
# SMTP_HOST=... SMTP_PORT=587 SMTP_USERNAME=... SMTP_PASSWORD=... SMTP_FROM=...
# APP_URL=https://your-server.example
```

`/etc/systemd/system/puca.service`:

```ini
[Unit]
Description=Púca backend
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/puca
ExecStart=/opt/puca/target/release/puca
EnvironmentFile=/opt/puca/.env
Restart=on-failure
User=puca

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now puca`, then `journalctl -u puca -f` — you want
`Running database migrations…` → `Migrations complete` → `listening on…`.

### 1.4 TLS reverse proxy (must forward WebSocket + all paths)
**Caddy** is the least effort (auto HTTPS, auto WebSocket):

```
your-server.example {
    reverse_proxy localhost:3000
}
```

That single line correctly forwards the API, `/ws`, and `/api/updates/*`.
(nginx works too, but you must proxy the **whole** `location /` to `:3000` with
`Upgrade`/`Connection` headers — do **not** split `/api/` vs `/` like the old
config did, or `/auth/*` and `/servers` will 404.)

> **Web SPA note:** the backend does not serve the React SPA itself. If you also
> want a browser version, host `frontend/dist/` as static files on a *separate*
> host (e.g. `app.your-server.example`) whose build has `VITE_API_URL=https://your-server.example`.
> You can't serve both the SPA and the API at the root of the same host.

### 1.5 Point clients at your host
The client config currently defaults to `http://localhost:3000` (placeholder).
When you host, update these **before building clients**:
- `frontend/.env.production` → `VITE_API_URL=https://your-server.example`
- `frontend/src-tauri/tauri.conf.json` → updater endpoint host `your-server.example`
- backend env `PUBLIC_BASE_URL=https://your-server.example` (used in update manifests)

---

## Part 2 — Build & test locally (you)

**Backend + DB (real end-to-end):**
```bash
docker compose up -d postgres      # or a native Postgres
cargo run                          # applies migrations, serves :3000
```
The dev env already points at `http://localhost:3000`, so `npm run dev` hits your
local backend out of the box:
```bash
cd frontend && npm install && npm run dev   # → http://localhost:5173
```

**Automated tests:**
```bash
cargo test               # backend, needs DATABASE_URL reachable
cd frontend && npm test  # crypto / parser / rotation unit tests (offline)
```

**Smoke checklist:** register → log in → create a server + text channel → send a
message (try **markdown**, an `@mention`, a pasted `.gif`/image URL) → open a DM →
join a voice channel → screen-share.

---

## Part 3 — Desktop installers (you build, friends install)

Build on each target OS (build Windows on Windows, macOS on macOS):
```bash
cd frontend
npm install
npm run tauri:build
```
Installers land in `frontend/src-tauri/target/release/bundle/`:
- Windows: `msi/Púca_x.y.z_x64_en-US.msi` (or NSIS `-setup.exe`)
- macOS: `dmg/Púca_x.y.z_x64.dmg`
- Linux: `appimage/*.AppImage`, `deb/*.deb`

**Friends install:** send the installer for their OS → run it → the app opens
already pointed at your server → they register and go. Nothing to configure.

**Zero-install option:** serve `frontend/dist/` (see the web-SPA note above) so
friends can just visit the URL in a browser to try it before installing.

---

## Known gaps to close before a wider release

- **Auto-updates need signing.** `tauri.conf.json` has `createUpdaterArtifacts`
  + a public key, and `deploy.sh` writes a manifest, but release **signatures
  are empty**. Generate the keypair (`npm run tauri signer generate`), set
  `TAURI_SIGNING_PRIVATE_KEY` at build time, and fill the `signature` fields.
  Until then the app installs fine but won't self-update.
- **Voice/screen-share across the internet needs a TURN server.** P2P WebRTC
  fails between friends on different NATs without one. Run `coturn` and return
  its credentials from `/ice-config`. Also note voice is **P2P mesh (no SFU)** —
  fine for small groups, not large audiences.
- **Set real secrets:** strong `JWT_SECRET` + Postgres password, and lock
  `CORS_ORIGINS` to your domain (the backend logs a loud warning otherwise).
- **TLS only via the proxy:** the backend is plain HTTP — never expose `:3000`
  directly; let Caddy/nginx terminate TLS.
