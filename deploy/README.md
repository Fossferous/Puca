# Deploying Puca to production

This directory contains the canonical, tested-against-the-code deployment
artifacts. The older prose guides in `docs/` predate them; where they
disagree, **these files win**.

> **Self-hosting on Proxmox / a home server (example.com)?** Follow
> [`SELF_HOSTING_PROXMOX.md`](SELF_HOSTING_PROXMOX.md) — it's this guide
> tailored to an LXC container + Caddy + a subdomain, and covers coexisting
> with an existing Matrix service. Config file: [`Caddyfile.example.com`](Caddyfile.example.com).

Architecture: the Rust backend binds `127.0.0.1:3000` and a reverse proxy
(Caddy *or* nginx) terminates TLS in front of it. The **entire origin** is
proxied — the API lives at the root (`/auth/...`, `/servers/...`, `/ws`,
`/files/:id`). There is **no `/api` prefix**. Clients are the Tauri desktop
app (and mobile builds); nothing serves a web page at `/` besides the
backend's own health message.

## 1. Server prep (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y postgresql
# Pick ONE proxy:
sudo apt install -y caddy                        # option A (auto-HTTPS)
sudo apt install -y nginx certbot python3-certbot-nginx   # option B

# Database
sudo -u postgres psql -c "CREATE DATABASE puca;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '<strong-db-password>';"

# Service user + directory layout
sudo useradd --system --home /opt/puca --shell /usr/sbin/nologin puca
sudo mkdir -p /opt/puca/uploads /opt/puca/releases
sudo chown -R puca:puca /opt/puca
```

> `uploads/` and `releases/` must exist before first start: the systemd unit
> mounts the rest of the filesystem read-only (`ProtectSystem=strict`).

## 2. Build and install the backend

Build on the server (or cross-compile) for the target platform:

```bash
cargo build --release
sudo cp target/release/puca /opt/puca/puca
```

Migrations run automatically at startup; no manual step.

## 3. Configure

```bash
sudo cp .env.example /opt/puca/.env
sudo chown puca:puca /opt/puca/.env && sudo chmod 600 /opt/puca/.env
sudoedit /opt/puca/.env
```

Required values (see `.env.example` for the full documented list):

| Var | Value |
|---|---|
| `APP_ENV` | `production` — enables the JWT-secret boot guard |
| `JWT_SECRET` | output of `openssl rand -hex 32` |
| `DATABASE_URL` | `postgres://postgres:<db-password>@localhost/puca` |
| `CORS_ORIGINS` | `https://chat.example.com` (+ `tauri://localhost,http://tauri.localhost` for the desktop app — mac/Linux and Windows origins respectively; + `https://localhost,capacitor://localhost` for the Android/iOS Capacitor apps) |
| `RUST_LOG` | `puca=info,tower_http=warn` |

The server **refuses to boot** in production with a missing/weak/placeholder
`JWT_SECRET` — that's intentional.

## 4. Reverse proxy + TLS

**Option A — Caddy** (recommended; certificates are automatic):

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy
```

**Option B — nginx + certbot:**

```bash
sudo certbot certonly --nginx -d chat.example.com
sudo cp deploy/nginx.conf /etc/nginx/sites-available/puca   # edit the domain first
sudo ln -s /etc/nginx/sites-available/puca /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Run as a service

```bash
sudo cp deploy/puca.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now puca
journalctl -u puca -f     # watch the boot: migrations + "listening on"
```

## 6. Build the clients against the deployment

Do **not** edit `frontend/src/api/config.ts` (older docs said to — that has
been superseded). The API base URL is a build-time env var read by
`frontend/src/api/platform.ts`:

```bash
cd frontend
echo 'VITE_API_URL=https://chat.example.com' > .env.production
npm run build          # web assets / desktop webview
npm run tauri:build    # desktop installer (NOT `npm run tauri build` — the
                       # colon script also builds the native agent and merges
                       # your untracked src-tauri/tauri.release.json overlay,
                       # which is what points the auto-updater at YOUR host;
                       # see src-tauri/tauri.release.example.json)
```

The WebSocket URL is derived automatically (`wss://chat.example.com/ws`).

### The Lite variant (no remote control)

Every release exists in two builds. **Full** is everything. **Lite** contains
ZERO remote-control code — no screen capture, no input injection, no system
service; the code is excluded at compile time, not merely hidden — for people
who don't want that machinery installed at all (it is also what antivirus
heuristics sometimes flag in the full build). Chat, voice, watching a
screen-share and file transfer are identical in both. The two installs are
mutually exclusive on a machine but share their data, so switching keeps the
session and history.

```bash
npm run tauri:build:lite        # lite desktop installer ("Puca Lite")
npm run cap:build:android:lite  # lite Android project (then build the APK)
```

Ship lite artifacts alongside full ones under distinct names
(`Puca-Lite-Setup.exe`, `Puca-Lite-<ver>.apk`, `latest-lite.json`,
`mobile-update-lite.json`) — `deploy/ops/dual-ship.sh` has
`installer-lite` / `apk-lite` / `mobile-lite` subcommands that do this and
verify it; both variants always ship the same version number. The download
page (`deploy/download-site/index.html`) offers both behind a Full/Lite
picker, and the mobile OTA endpoint serves each variant its own manifest
(`GET /api/mobile-updates/check?variant=lite`).

## 7. Smoke test

```bash
curl -s https://chat.example.com/            # -> "Puca Backend Online"
curl -s https://chat.example.com/ice-config  # -> JSON with STUN/TURN servers
```

Then register a user from the desktop app and exchange a message.

## Optional: self-hosted TURN (coturn)

Voice/video NAT traversal works out of the box via public STUN + the
OpenRelay public TURN fallback. For scale/privacy, run your own coturn with
`use-auth-secret`, then set `TURN_SERVER=turn:chat.example.com:3478` and
`TURN_SECRET=<coturn static-auth-secret>` in `/opt/puca/.env` — the
backend mints 24 h HMAC credentials for clients automatically.
