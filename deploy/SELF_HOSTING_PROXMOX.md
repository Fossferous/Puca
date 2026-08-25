# Self-hosting Puca on Proxmox (example.com)

A tailored runbook for the common home-lab setup: the backend in an LXC
container on a Proxmox host, fronted by Caddy for automatic HTTPS, reachable at
`chat.example.com`. For the generic/cloud version and the raw config files, see
[`README.md`](README.md).

Architecture:

```
Internet ──(443/80)──> home router ──forward──> Caddy (LXC) ──(127.0.0.1:3000)──> puca
                                                    │
                                                    └──(optional)──> your existing Matrix box
Desktop app  ──https://chat.example.com / wss://chat.example.com/ws──┘
```

The backend binds `127.0.0.1:3000` and only ever talks to Postgres on
localhost; Caddy terminates TLS and is the only thing exposed.

---

## Phase 0 — Decide how Puca coexists with Matrix on example.com

`example.com` already serves Matrix, and a home router forwards port **443 to a
single machine**, so two services can't independently answer on
`example.com:443`. Pick one:

1. **Recommended — subdomain + one front door.** Use `chat.example.com` for
   Puca and run **one Caddy** as the single public entry point for 443.
   Caddy routes by hostname (`example.com` → Matrix, `chat.example.com` → Puca)
   and auto-manages certificates for both. See
   [`Caddyfile.example.com`](Caddyfile.example.com) for the merged draft.
2. **Separate port.** If Matrix keeps its own proxy and you don't want to
   touch it, forward a different external port (e.g. `8443`) to Puca and
   use `chat.example.com:8443`. Works, but a non-standard port is ugly and some
   networks block it.

This runbook assumes option 1 with `chat.example.com`.

> Before editing Caddy, know how Matrix is currently fronted (its own nginx?
> Caddy? a separate VM/LXC and at what internal IP:port?). That determines
> whether you consolidate onto one Caddy or keep them separate. The Matrix
> block in `Caddyfile.example.com` is a template — fill in your real upstream.

---

## Phase 1 — Create the container

Proxmox web UI → **Create CT** (LXC is lighter than a full VM):

- Template: **Ubuntu 24.04**
- Resources: 2 vCPU, 2 GB RAM, 16 GB disk
- Network: assign a **static internal IP** (e.g. `192.168.1.50`) — you forward to this
- Start it, open `Console` (or `ssh` in)

```bash
apt update && apt upgrade -y
apt install -y postgresql caddy curl git build-essential pkg-config libssl-dev
```

## Phase 2 — Database + Rust toolchain

```bash
# Database
sudo -u postgres psql -c "CREATE DATABASE puca;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'PICK_A_STRONG_DB_PASSWORD';"

# Rust — the backend must be built on Linux; a Windows build won't run here
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

## Phase 3 — DNS + router

1. **DNS** (at your example.com DNS host): add an **A record** `chat` → your home
   **public IP** (`curl ifconfig.me`). On a dynamic residential IP, enable
   **dynamic DNS** so `chat.example.com` follows your IP (most routers have this,
   or run a DDNS client).
2. **Router**: forward external **80 and 443 → the container** (`192.168.1.50`).
   Port 80 is required for Let's Encrypt's HTTP challenge.

## Phase 4 — Build + configure the backend

Get the code onto the container (`git clone` or `scp`), then:

```bash
cd puca
cargo build --release            # -> target/release/puca

sudo useradd --system --home /opt/puca --shell /usr/sbin/nologin puca
sudo mkdir -p /opt/puca/uploads /opt/puca/releases
sudo cp target/release/puca /opt/puca/
sudo cp -r migrations /opt/puca/     # run automatically on startup
sudo cp .env.example /opt/puca/.env
```

Edit `/opt/puca/.env`:

```ini
APP_ENV=production
JWT_SECRET=<paste output of: openssl rand -hex 32>
DATABASE_URL=postgres://postgres:PICK_A_STRONG_DB_PASSWORD@localhost/puca
CORS_ORIGINS=https://chat.example.com,tauri://localhost,http://tauri.localhost,https://localhost,capacitor://localhost
RUST_LOG=puca=info,tower_http=warn
```

> **Desktop app origins:** the Tauri client's web origin differs by OS —
> `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows.
> Include **both** in `CORS_ORIGINS` or the desktop app's API calls are blocked
> on the platforms you omit.

> **Mobile app origins:** the Capacitor apps serve their bundled assets from a
> local origin — `https://localhost` on Android and `capacitor://localhost` on
> iOS. Without them in `CORS_ORIGINS`, every API call from the mobile apps
> fails with "Failed to fetch".

Lock it down:

```bash
sudo chown -R sovereign:puca /opt/puca
sudo chmod 600 /opt/puca/.env
```

> With `APP_ENV=production` the server **refuses to boot** on a weak/placeholder
> `JWT_SECRET` — that's intentional. Use a real `openssl rand -hex 32`.

## Phase 5 — Caddy (TLS) + systemd

```bash
sudo cp deploy/Caddyfile.example.com /etc/caddy/Caddyfile
# edit: confirm chat.example.com, and fill in / delete the Matrix block (Phase 0)
sudo systemctl reload caddy

sudo cp deploy/puca.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now puca
journalctl -u puca -f       # expect: "Migrations complete" then "listening on 127.0.0.1:3000"
```

## Phase 6 — Build the desktop app (on your dev machine)

```bash
cd frontend
echo "VITE_API_URL=https://chat.example.com" > .env.production
npm run tauri build              # installers in src-tauri/target/release/bundle
```

Don't hand-edit `src/api/config.ts`; the URL comes from `VITE_API_URL` and the
WebSocket URL (`wss://chat.example.com/ws`) is derived automatically.

## Phase 7 — Smoke test → live

```bash
curl https://chat.example.com/            # -> "Puca Backend Online"
curl https://chat.example.com/ice-config  # -> JSON with STUN/TURN servers
```

Open the desktop app, register, create a server, send a message. Voice/video
work out of the box via the public STUN/TURN fallback; for scale/privacy you
can self-host coturn later (see the TURN note in `README.md`).

---

## Operating notes

- **Logs:** `journalctl -u puca -f` (backend), `journalctl -u caddy -f` (proxy).
- **Update the backend:** rebuild, `sudo systemctl stop puca`, copy the new
  binary to `/opt/puca/puca`, `sudo systemctl start puca`.
  Migrations apply automatically on start.
- **Backups:** the durable state is Postgres (`pg_dump puca`) plus
  `/opt/puca/uploads` (user files). Back up both.
- **Proxmox:** take a container snapshot before big changes — instant rollback.
