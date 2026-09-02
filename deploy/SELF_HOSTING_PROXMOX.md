# Self-hosting Puca on Proxmox (example.com)

A tailored runbook for the common home-lab setup: the backend in an LXC
container on a Proxmox host, fronted by Caddy for automatic HTTPS, reachable at
`chat.example.com`. For the generic/cloud version, the full list of pieces
(download site, web app, backups, the keys you must generate) and the raw
config files, see [`README.md`](README.md) — this page covers the container
and the router; the rest of that guide applies unchanged.

Architecture:

```
Internet ──(443/80)──> home router ──forward──> Caddy (LXC) ──(127.0.0.1:3000)──> puca
         ──(UDP/TCP 3479, UDP 49180-49220)──────────────────> coturn (same LXC)
                                                    │
                                                    └──(optional)──> your existing Matrix box
Desktop app  ──https://chat.example.com / wss://chat.example.com/ws──┘
```

The backend binds `127.0.0.1:3000` and only ever talks to Postgres on
localhost; Caddy terminates TLS and, with coturn, is the only thing exposed.

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
- Resources: 2 vCPU, 2 GB RAM, 16 GB disk (more disk if you expect many
  attachments: the nightly backup keeps 14 copies of the uploads tree)
- Network: assign a **static internal IP** (e.g. `192.168.1.50`) — you forward to this
- Start it, open `Console` (or `ssh` in)

```bash
apt update && apt upgrade -y
apt install -y postgresql coturn curl git gnupg apt-transport-https build-essential pkg-config libssl-dev

# Caddy is NOT in the Ubuntu archive — `apt install caddy` fails, and if it
# shares an apt line with postgresql the whole line fails. Its own repository:
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

> Alternatively run [`migrate/provision.sh`](migrate/provision.sh) inside the
> container (`--public-ip <your WAN IP> --uplink-mbps <your upload speed>`):
> it does Phases 1–2, the coturn setup and the firewall in one go, and detects
> that the container is behind NAT.

## Phase 2 — Database + Rust toolchain

```bash
# Database: a dedicated role that owns the database (not the postgres superuser —
# the backup/restore scripts assume a `puca` role)
sudo -u postgres psql -c "CREATE ROLE puca LOGIN PASSWORD 'PICK_A_STRONG_DB_PASSWORD';"
sudo -u postgres createdb -O puca puca

# Rust — the backend must be built on Linux; a Windows build won't run here
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

## Phase 3 — DNS + router

1. **DNS** (at your example.com DNS host): add **A records** `chat`, `app`
   and `download` → your home **public IP** (`curl ifconfig.me`), and `turn`
   for the relay (it must stay a plain A record even if you later put the
   others behind a CDN — UDP cannot be proxied). On a dynamic residential IP,
   enable **dynamic DNS** so the names follow your IP (most routers have this,
   or run a DDNS client).
2. **Router**: forward external **80 and 443 → the container** (`192.168.1.50`).
   Port 80 is required for Let's Encrypt's HTTP challenge. For calls across
   the internet also forward **UDP+TCP 3479** and **UDP 49180–49220** to the
   container (the relay — [`turn/README.md`](turn/README.md)).

## Phase 4 — Build + configure the backend

Get the code onto the container (`git clone` or `scp`), then:

```bash
cd puca
cargo build --release            # -> target/release/puca (migrations are compiled in)

sudo useradd --system --home /opt/puca --shell /usr/sbin/nologin puca
sudo mkdir -p /opt/puca/uploads /opt/puca/releases /opt/puca/downloads/mobile /opt/puca/webapp
sudo cp target/release/puca /opt/puca/
sudo cp .env.example /opt/puca/.env
```

Edit `/opt/puca/.env` (`.env.example` explains every line):

```ini
APP_ENV=production
JWT_SECRET=<paste output of: openssl rand -hex 32>
DATABASE_URL=postgres://puca:PICK_A_STRONG_DB_PASSWORD@127.0.0.1/puca
CORS_ORIGINS=https://chat.example.com,https://app.example.com,tauri://localhost,http://tauri.localhost,https://localhost,capacitor://localhost
RUST_LOG=puca=info,tower_http=warn
REGISTRATION_INVITE_CODE=<a code you hand to the people you invite>
APP_URL=https://app.example.com
TURN_SERVER=turn:turn.example.com:3479?transport=udp,turn:turn.example.com:3479?transport=tcp
TURN_SECRET=<coturn's static-auth-secret, from turn/README.md>
```

> **Desktop app origins:** the Tauri client's web origin differs by OS —
> `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows.
> Include **both** in `CORS_ORIGINS` or the desktop app's API calls are blocked
> on the platforms you omit.

> **Mobile app origins:** the Capacitor app serves its bundled assets from a
> local origin — `https://localhost` on Android (`capacitor://localhost` on
> iOS). Without them in `CORS_ORIGINS`, every API call from the app fails with
> "Failed to fetch".

> **Registration:** without `REGISTRATION_INVITE_CODE`, anyone who finds
> `chat.example.com` can create an account. Set it before you forward 443.

Lock it down:

```bash
sudo chown -R puca:puca /opt/puca
sudo chmod 600 /opt/puca/.env
```

> With `APP_ENV=production` the server **refuses to boot** on a weak/placeholder
> `JWT_SECRET` or without `CORS_ORIGINS` — that's intentional.

## Phase 5 — Caddy (TLS) + systemd

```bash
sudo cp deploy/Caddyfile.example.com /etc/caddy/Caddyfile
# edit: confirm chat.example.com, and fill in / delete the Matrix block (Phase 0);
# append download-site/Caddyfile.snippet (Phase 7) and the app.example.com block is already there
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy

sudo cp deploy/puca.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now puca
journalctl -u puca -f       # expect: "Migrations complete" then "listening on 127.0.0.1:3000"
```

Size the unit's memory ceiling to the container (README §5): for the 2 GB
container above, a drop-in with `MemoryHigh=1228M` / `MemoryMax=1536M`.

## Phase 6 — Build the desktop app (on your dev machine)

Generate the updater signing key **first** and put its public half in
`frontend/src-tauri/tauri.release.json` with your download host — README §6.1
explains why an installer built without that step can never update. Then:

```bash
cd frontend
echo "VITE_API_URL=https://chat.example.com" > .env.production
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.puca/tauri-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='...'
npm run tauri:build              # NOT `npm run tauri build` — the colon script merges tauri.release.json
```

Don't hand-edit `src/api/config.ts`; the URL comes from `VITE_API_URL` and the
WebSocket URL (`wss://chat.example.com/ws`) is derived automatically. The
Android APK and its two keys: README §6.2.

## Phase 7 — Smoke test → live

```bash
curl https://chat.example.com/            # -> "Puca Backend Online"
curl https://chat.example.com/ice-config  # -> JSON with STUN, and your TURN once signed in
```

Open the desktop app, register with the invite code, create a server, send a
message. Then the rest of the README: the download site (§10 — install
[`download-site/Caddyfile.snippet`](download-site/Caddyfile.snippet) and ship
with `dual-ship.sh`), the web app (§9), and **backups** (next).

---

## Operating notes

- **Logs:** `journalctl -u puca -f` (backend), `journalctl -u caddy -f` (proxy).
- **Update the backend:** rebuild, `sudo systemctl stop puca`, copy the new
  binary to `/opt/puca/puca`, `sudo systemctl start puca`.
  Migrations apply automatically on start. (Or `deploy/ops/dual-ship.sh
  backend`, which builds on the container and verifies.)
- **Backups and the health check — install them, this is not optional:**

  ```bash
  sudo cp deploy/ops/{names.sh,backup.sh,restore.sh,restore-drill.sh,healthcheck.sh,ship-offsite.sh} /opt/puca/
  sudo chmod +x /opt/puca/*.sh
  sudo cp deploy/ops/puca.cron /etc/cron.d/puca && sudo systemctl enable --now cron
  sudo /opt/puca/backup.sh && tail -5 /opt/puca/backup.log     # db ok / uploads ok / config ok
  sudo /opt/puca/restore-drill.sh --local                       # RESTORE DRILL PASSED
  ```

  The durable state is Postgres, `/opt/puca/uploads` (attachment ciphertext)
  and `/opt/puca/.env` (the secrets) — `backup.sh` keeps all three nightly.
  A backup on the container's own disk does not survive the container: set
  an offsite target and an `age` recipient in `/etc/default/puca-backup`
  ([`ops/README.md`](ops/README.md)). The Proxmox snapshot below is a
  convenience, not a backup.
- **Proxmox:** take a container snapshot before big changes — instant rollback.
