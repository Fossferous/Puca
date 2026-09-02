# Deploying Puca

This directory holds the canonical, tested-against-the-code deployment path.
The older prose guides in `docs/` predate it; where they disagree, **these
files win**. Following this page end to end on a fresh Ubuntu 24.04 box gets
you: the backend and Postgres, Caddy in front, a TURN relay so calls work
across the internet, the browser web app, a download site your users install
from, working desktop auto-update and mobile OTA, nightly backups with an
offsite copy, and a health check — and the list of keys that are **yours**,
not this repository's.

> **Self-hosting on Proxmox / a home server?** [`SELF_HOSTING_PROXMOX.md`](SELF_HOSTING_PROXMOX.md)
> is this guide tailored to an LXC container behind a home router, coexisting
> with an existing Matrix service. Config file: [`Caddyfile.example.com`](Caddyfile.example.com).

## What you end up with

```
                    ┌──────────────────────── your server ────────────────────────┐
users ── 443 ──►    │ Caddy (TLS)                                                  │
                    │   chat.example.com      ──► puca backend 127.0.0.1:3000 ──► PostgreSQL
                    │   app.example.com       ──► /opt/puca/webapp   (browser client)
                    │   download.example.com  ──► /opt/puca/downloads (installers, APKs, latest.json)
                    │   sfu.example.com       ──► livekit 127.0.0.1:7880   (optional SFU)
users ── UDP/TCP ─► │ coturn  turn.example.com:3479  (media relay; DNS-only, no CDN)      │
                    └──────────────────────────────────────────────────────────────┘
```

The backend binds `127.0.0.1:3000` and Caddy (or nginx) terminates TLS. The
**entire origin** is proxied — the API lives at the root (`/auth/...`,
`/servers/...`, `/ws`, `/files/:id`); the one route with an `/api` prefix is
the mobile OTA check, `GET /api/mobile-updates/check`, so proxy everything and
never carve out `/api`. The backend serves no web page at `/` besides its own
health string; the browser client is static files on a **separate origin**
(section 9).

## Keys that are yours — generate, then back up

Everything below is an identity your deployment signs with. **None of them is
in this repository, and the ones that are compiled into clients cannot be
changed later without every user reinstalling.** Generate each once, before
the step that needs it, and back it up the same day.

| Key | Generated in | Lives | Losing it means |
|---|---|---|---|
| `JWT_SECRET` (session tokens) | §3, `openssl rand -hex 32` | `/opt/puca/.env` | every user is logged out; otherwise survivable (a new one works) |
| Postgres password for the `puca` role | §1 | `.env` (`DATABASE_URL`) | reset it in Postgres; survivable |
| `TURN_SECRET` (relay credentials) | §8 | `.env` + `/etc/turnserver.conf` | rotate both; calls fall back to direct-only for up to 4 h |
| LiveKit API key/secret | §12 | `.env` + `/opt/livekit/livekit.yaml` | rotate both; SFU rooms reconnect |
| **Tauri updater keypair** (minisign) | §6 | private: `~/.puca/tauri-updater.key` (+ `.password`); public: your `tauri.release.json` | **no desktop update can ever be signed again**: every installed client is stuck on its version until each user reinstalls by hand |
| **Mobile OTA RSA key** | §6 | private: `~/.puca/mobile-updater-rsa.key`; public: `capacitor.config.ts` | **no signed OTA bundle can ever be produced again**; a new APK (new key) is the only recovery, installed by hand on every phone |
| **Android release keystore** | §6 | `~/.android/puca-release.keystore` + `puca-keystore.properties` | **no APK can upgrade the installed app**: Android refuses a different signature, so every user must uninstall (losing local data) and reinstall |
| age recipient for offsite backups | §11 | public half in `/etc/default/puca-backup`; private half OFF the server | the offsite copies are unreadable — which is the point; keep the private half where you keep the keys above |

`.env` is captured nightly by `deploy/ops/backup.sh` (section 11). The three
client-signing keys never touch the server: bundle them with
[`deploy/ops/backup-keys.sh`](ops/backup-keys.sh) — it writes the keys and
their passphrases as **two separate tarballs**, which are only a real
separation if you store them in different places.

## 0. Fastest path: `provision.sh`

[`migrate/provision.sh`](migrate/provision.sh) does sections 1, 8 and 12 and
most of 5 on a fresh Ubuntu 24.04 host, as root: packages (Postgres, Caddy from
its own apt repository, coturn, LiveKit, the Rust toolchain), the `puca`
service user, the directory layout, a least-privilege `puca` Postgres role
and empty database, coturn and LiveKit configured for this host's address
model and **enabled**, ufw with exactly the ports below open, a memory
ceiling sized to the host's RAM, and an `.env` skeleton with fresh secrets.
It refuses to run where `/opt/puca/puca` already exists, so it cannot be
pointed at a live box by accident, and it is re-runnable.

```bash
git clone <this repository> && cd puca
bash deploy/migrate/render-turn-conf.test.sh                        # first, anywhere
sudo deploy/migrate/provision.sh --public-ip <this host's public IP> --uplink-mbps <your uplink> --realm example.com --dry-run
sudo deploy/migrate/provision.sh --public-ip <this host's public IP> --uplink-mbps <your uplink> --realm example.com
sudo deploy/migrate/verify.sh                                        # the silent-failure checks
```

It does **not** write Caddy's config, start the backend, or touch DNS — its
closing message lists what is still yours to do, which is sections 2–4 and 9–11
of this page. If you would rather do everything by hand, section 1 is what it
did. [`migrate/README.md`](migrate/README.md) covers the UDP soak you should
run on a rented host before trusting it with calls.

## 1. Server prep (Ubuntu/Debian, by hand)

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib coturn ufw curl openssl gnupg apt-transport-https build-essential pkg-config libssl-dev

# Caddy is NOT in the Ubuntu/Debian archive — `apt install caddy` fails outright.
# Add its repository first (this is what provision.sh does):
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
#   (option B, nginx instead: sudo apt install -y nginx certbot python3-certbot-nginx)

# Database: a dedicated role that OWNS the database. Do not run the backend as
# the postgres superuser — the ops scripts (restore.sh's createdb -O) and the
# principle of least privilege both assume a `puca` role.
sudo -u postgres psql -c "CREATE ROLE puca LOGIN PASSWORD '<strong-db-password>';"
sudo -u postgres createdb -O puca puca

# Service user + directory layout. downloads/ and webapp/ are what Caddy
# serves (sections 9-10); uploads/ and releases/ must exist before first start
# because the unit mounts everything else read-only.
sudo useradd --system --home /opt/puca --shell /usr/sbin/nologin puca
sudo mkdir -p /opt/puca/uploads /opt/puca/releases /opt/puca/downloads/mobile /opt/puca/webapp
sudo chown -R puca:puca /opt/puca

# Firewall: SSH first, then the web ports and the relay ports of section 8.
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw allow 3479/tcp && sudo ufw allow 3479/udp && sudo ufw allow 49180:49220/udp
sudo ufw --force enable
```

## 2. Build and install the backend

Build on the server (or cross-compile) for the target platform:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
cargo build --release
sudo cp target/release/puca /opt/puca/puca
```

Migrations are compiled into the binary and run automatically at startup; no
manual step and nothing to copy.

## 3. Configure

```bash
sudo cp .env.example /opt/puca/.env
sudo chown puca:puca /opt/puca/.env && sudo chmod 600 /opt/puca/.env
sudoedit /opt/puca/.env
```

`.env.example` documents every variable the server reads; these are the ones
you must decide:

| Var | Value |
|---|---|
| `APP_ENV` | `production` — enables the boot guards below |
| `JWT_SECRET` | output of `openssl rand -hex 32` |
| `DATABASE_URL` | `postgres://puca:<db-password>@127.0.0.1/puca` |
| `CORS_ORIGINS` | `https://chat.example.com,https://app.example.com,tauri://localhost,http://tauri.localhost,https://localhost,capacitor://localhost` — the desktop and Android apps send their own origins; list them or every installed app is blocked while the web app keeps working |
| `RUST_LOG` | `puca=info,tower_http=warn` |
| `REGISTRATION_INVITE_CODE` | **set it before the server is reachable.** Unset means anyone who finds the origin can register, and every account carries a storage entitlement with no global cap. With it set, the sign-up form asks for the code on every client — `GET /config` tells clients only *that* one is required (`registration_invite_required`, a boolean; the code itself is never advertised). Hand it to the people you invite; changing it invalidates every invite link already given out |
| `APP_URL` | `https://app.example.com` — the web app's public URL. `GET /config` advertises it and every client (desktop, Android, web) builds invite links as `<APP_URL>/invite/<code>`; unset, clients hand out the bare invite code instead. It is also the base of password-reset and verification links, so it is **required if you configure SMTP**: the mail default is `http://localhost:5173`, and every reset mail would point at the recipient's own machine |
| `TURN_SERVER`, `TURN_SECRET` | section 8 — required for calls between people on different networks |
| `DATABASE_MAX_CONNECTIONS` | leave unset (20). Keep below Postgres's `max_connections` (default 100) minus headroom for `pg_dump` and psql |
| `SOURCE_URL` | **a fork must set this to its own repository.** `GET /source` answers with it plus the commit the binary was built from — the AGPL §13 offer of source to the people who use your server |
| `UPLOAD_MAX_USER_BYTES` | per-user attachment quota, default 512 MiB; clips have their own (`CLIP_MAX_USER_BYTES`) |

Retention is configurable and documented in `.env.example`:
`REPORTS_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, and
`DELETED_ACCOUNT_FILE_GRACE_DAYS` (default 30 — how long a deleted account's
uploads stay before the sweep removes them; the grace is the warning, because
the server cannot see which channels a file was shared in).

The server **refuses to boot** in production with a missing/weak/placeholder
`JWT_SECRET` or without `CORS_ORIGINS` — that's intentional.

## 4. Reverse proxy + TLS

**Option A — Caddy** (recommended; certificates are automatic):

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first; sections 9, 10 and 12 add their own blocks
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**Option B — nginx + certbot:**

```bash
sudo certbot certonly --nginx -d chat.example.com
sudo cp deploy/nginx.conf /etc/nginx/sites-available/puca   # edit the domain first
sudo ln -s /etc/nginx/sites-available/puca /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Both shipped configs overwrite `X-Forwarded-For` with the real peer (the rate
limiter keys on it), clear `CF-Connecting-IP`, and allow the 32 MB request
body uploads need — keep those if you write your own. Fronting the origin with
Cloudflare is a separate, optional step: [`cloudflare/README.md`](cloudflare/README.md).

## 5. Run as a service

```bash
sudo cp deploy/puca.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now puca
journalctl -u puca -f     # watch the boot: migrations + "listening on"
```

The unit ships with `MemoryMax=1G` / `MemoryHigh=768M`. Size them to the host
(roughly 75% / 60% of RAM) with a drop-in rather than by editing the unit,
so a later unit-file update does not undo it — `provision.sh` writes exactly
this from `/proc/meminfo`:

```bash
sudo mkdir -p /etc/systemd/system/puca.service.d
printf '[Service]\nMemoryHigh=1228M\nMemoryMax=1536M\n' | sudo tee /etc/systemd/system/puca.service.d/limits.conf   # a 2 GB host
sudo systemctl daemon-reload && sudo systemctl restart puca
```

## 6. Build the clients against your deployment

The clients are built **on your machine**, for the server they will talk to.
Launch scope is the Windows desktop app (Full and Lite), the Android APK and
the browser app; macOS, Linux and iOS projects exist in the tree but are not
released or tested, and this page does not cover them.

### 6.1 The desktop updater key — before the first build

Every installer carries a minisign **public** key, and the app accepts an
update only if `latest.json` was signed by the matching **private** key. The
tracked `tauri.conf.json` carries this project's public key; a build that
inherits it trusts a private key you do not have, so every update you publish
would be refused ("update could not be installed") and could only be fixed by
each user reinstalling. Generate your own pair once:

```bash
cd frontend
npx tauri signer generate -w ~/.puca/tauri-updater.key     # choose a password; note the PUBLIC key it prints
cp src-tauri/tauri.release.example.json src-tauri/tauri.release.json
#   -> set plugins.updater.endpoints to https://download.example.com/latest.json
#   -> set plugins.updater.pubkey to the public key printed above
```

`tauri.release.json` is gitignored and merged over the tracked config by
`npm run tauri:build`, which prints the endpoint and the key id it baked in
every time — read that line. Then, before **every** release build:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.puca/tauri-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<the password you chose>'
```

Without them the build fails (`createUpdaterArtifacts` is on). Back the key
and its password up now — [`ops/backup-keys.sh`](ops/backup-keys.sh) — losing
it strands every installed client on its current version forever.

### 6.2 The Android keys — before the first APK

- **Release keystore.** `frontend/android/app/build.gradle` reads
  `~/.android/puca-keystore.properties` (`storeFile`, `storePassword`,
  `keyAlias`, `keyPassword`) and refuses to produce an unsigned release APK.
  Create one with `keytool -genkeypair -v -keystore ~/.android/puca-release.keystore -alias puca -keyalg RSA -keysize 4096 -validity 10000`
  and write the properties file. Android only upgrades an app whose new APK is
  signed by the **same** key: lose it and every user must uninstall (losing
  local data) and reinstall.
- **Mobile OTA signing key.** Web-bundle updates reach installed phones without
  a new APK, and the app rejects any bundle not signed by the RSA private key
  whose public half is compiled into it (`capacitor.config.ts` →
  `CapacitorUpdater.publicKey`). Generate it once and paste the public key
  there before the first APK build — [`mobile/README.md`](mobile/README.md)
  has the exact commands. Losing the private key means no OTA can ever be
  produced again; a new APK with a new key is the only recovery.

### 6.3 Build

Do **not** edit `frontend/src/api/config.ts` (older docs said to). The API
base URL is a build-time env var read by `frontend/src/api/platform.ts`:

```bash
cd frontend && npm install
echo 'VITE_API_URL=https://chat.example.com' > .env.production   # see .env.production.example
# Every build below starts with scripts/check-api-url.mjs, which REFUSES a
# missing or localhost VITE_API_URL — a build that baked in localhost could
# never reach a server and never be offered a fix. PUCA_ALLOW_LOCAL_BUILD=1 is
# the deliberate local-only override; hosted CI is exempt (test builds).
npm run build                   # web assets (section 9) / desktop webview
npm run tauri:build             # desktop installer + .sig  (NOT `npm run tauri build`: the colon
                                # script builds the native agent and merges tauri.release.json)
npm run cap:build:android && (cd android && ./gradlew assembleRelease)   # Puca-<ver>.apk
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
`mobile-update-lite.json`) — `dual-ship.sh` has `installer-lite` /
`apk-lite` / `mobile-lite` subcommands that do this and verify it; both
variants always ship the same version number. The download page offers both
behind a Full/Lite picker, and the mobile OTA endpoint serves each variant its
own manifest (`GET /api/mobile-updates/check?variant=lite`).

## 7. Smoke test

```bash
curl -s https://chat.example.com/            # -> "Puca Backend Online"
curl -s https://chat.example.com/ice-config  # -> JSON with your STUN/TURN servers (TURN only with a bearer token)
```

Then register a user from the desktop app (with the invite code) and exchange
a message.

## 8. TURN — required for calls across the internet

The server ships **no third-party relay**. `GET /ice-config` hands clients STUN
for address discovery and, for signed-in callers, time-limited credentials for
**your** coturn; with `TURN_SERVER` unset there is no relay at all, and two
peers who both sit behind symmetric NAT or CGNAT never connect — the call
just stays "connecting", with nothing in any log. Run coturn:

- [`turn/README.md`](turn/README.md) — install, the config template
  [`turn/turnserver.conf`](turn/turnserver.conf) (non-standard port **3479**;
  keep the port and the relay range `49180-49220/udp` in step with your
  firewall and `TURN_SERVER`), and the open-relay negative test.
- `provision.sh` does all of it and registers the secret with `turnadmin`,
  which this coturn version needs in addition to `static-auth-secret`.

Then in `/opt/puca/.env`, using the relay's **own** hostname (DNS-only if you
use a CDN — UDP cannot be proxied):

```
TURN_SERVER=turn:turn.example.com:3479?transport=udp,turn:turn.example.com:3479?transport=tcp
TURN_SECRET=<coturn's static-auth-secret>
```

and `systemctl restart puca`. The backend mints **4 h** HMAC credentials per
signed-in user; clients cache ICE config for up to 2 h, so after changing
these expect some clients to stay on STUN-only for that long before
concluding coturn is misconfigured. Users can force media through the relay
("Hide my IP in calls") once one exists. Sequence a port or secret change as:
firewall, coturn, then `.env` + backend — never the reverse.

## 9. The browser client

The same SPA the desktop and Android shells embed, served as static files
from `app.example.com` → `/opt/puca/webapp`. Native-only features degrade
gracefully; everything else works in Chromium-based browsers (Firefox/Safari
fall back to transport-only media encryption and say so).
[`webapp/README.md`](webapp/README.md) has the Caddy site block, the DNS
record and the update procedure. Two things bite:

- **The Content-Security-Policy is applied with
  [`ops/add-webapp-csp.py`](ops/add-webapp-csp.py), dry-run first.** Its
  `connect-src` must name the API host and, if you run one, the SFU
  (`LIVEKIT_URL`); a policy missing either white-screens the app with the error
  only in the browser console. `check-versions.sh` fails until the header is
  live.
- Add `https://app.example.com` to `CORS_ORIGINS` (section 3).

## 10. The download site and publishing releases

`download.example.com` → `/opt/puca/downloads` serves the installers, the
APKs, the OTA bundles (`mobile/`), `latest.json` for the desktop updater,
`SHA256SUMS.txt`, and the release notes. Install the vhost from
[`download-site/Caddyfile.snippet`](download-site/Caddyfile.snippet) and
publish with the ship scripts — never by hand-copying files:

```bash
cp deploy/ops/hosts.conf.example deploy/ops/hosts.conf   # your hosts, domains, names — gitignored
# + the deploy key and known_hosts: "Before your first release" in ops/README.md
deploy/ops/check-versions.sh --preflight                 # is this version number still free?
deploy/ops/dual-ship.sh installer <Puca-Setup.exe> <.sig> <version> "<one-line notes>"
deploy/ops/dual-ship.sh apk       <Puca-<version>.apk> <version>
deploy/ops/dual-ship.sh mobile    <bundle.enc.zip> <version> <sessionKey> <checksum>   # mobile/README.md
deploy/ops/dual-ship.sh webapp    <dist.tar.gz>
git rev-parse HEAD > SOURCE_COMMIT                       # the tarball has no .git; build.rs embeds this for GET /source
deploy/ops/dual-ship.sh backend   <src.tar.gz>           # builds ON the first host, copies the binary to the rest (tarball incl. SOURCE_COMMIT)
deploy/ops/check-versions.sh                             # every surface, every host, one version
```

Order: **clients before the backend**, unless a client needs a server change
to exist first. Each subcommand uploads to **every** host in `hosts.conf`,
verifies over that host's own loopback, publishes each artifact's SHA-256 in
`SHA256SUMS.txt` (the installers are not code-signed — the checksum is what
users compare; the page tells them how), ships the download page with the
artifact and refuses when the page does not advertise the version or still
names a placeholder domain, and uploads `CHANGELOG.md` and `docs/PRIVACY.md`
beside the installers so the page can link them. **Release notes live in
`CHANGELOG.md`**, not only in the updater's one-line summary — write the
entry there before shipping.

The tracked [`download-site/index.html`](download-site/index.html) is a
template: `dual-ship.sh` fills its `__API_HOST__` token from `hosts.conf`, and
an untracked `index.local.html` beside it is used instead when present. Its
version label and the APK href must name the release being shipped — the
gates check.

The mobile OTA manifest must be at **`/opt/puca/mobile-update.json`** (the
backend serves it from its working directory at `/api/mobile-updates/check`);
`dual-ship.sh mobile` writes it there and verifies through the endpoint, and
[`mobile/README.md`](mobile/README.md) explains why a copy anywhere else
froze phones on an old bundle for six releases.

## 11. Keep it recoverable: backups, health check, key custody

Nothing so far backs anything up or notices a dead service. Install the ops
scripts — [`ops/README.md`](ops/README.md) documents each:

```bash
sudo cp deploy/ops/{names.sh,backup.sh,restore.sh,restore-drill.sh,healthcheck.sh,ship-offsite.sh} /opt/puca/
sudo chmod +x /opt/puca/*.sh
sudo cp deploy/ops/puca.cron /etc/cron.d/puca && sudo systemctl enable --now cron
sudo /opt/puca/backup.sh && tail -5 /opt/puca/backup.log     # db ok / uploads ok / config ok
sudo /opt/puca/restore-drill.sh --local                       # RESTORE DRILL PASSED, or do not go on
```

[`ops/backup.sh`](ops/backup.sh) runs nightly and keeps three things: the
database, `/opt/puca/uploads` (attachment ciphertext — a DB-only backup loses
every shared file), and `/opt/puca/.env` (without it a restored box has a new
identity for every secret). **A local backup on the same disk is not a
backup**: set an offsite target and an `age` recipient in
`/etc/default/puca-backup` — the offsite copy is encrypted or it is not
shipped, and the private half of that key belongs with your signing keys, off
the server. Drill it where the key lives (`restore-drill.sh`) and on the box
(`--local`). `healthcheck.sh` runs every five minutes: it restarts a dead or
hung backend, reports a crash-looping unit, supervises coturn and LiveKit, and
re-asserts ufw only where ufw was configured.

The client-signing keys of section 6 never touch the server: run
[`ops/backup-keys.sh`](ops/backup-keys.sh) on your machine and store its two
tarballs in two different places.

## 12. Optional: the SFU (LiveKit)

Voice channels are peer-to-peer mesh by default (comfortable to ~4 people). A
LiveKit SFU lets 5–8 people watch each other's cameras and screens
concurrently, still as ciphertext only. [`livekit/README.md`](livekit/README.md)
has the install, the Caddy block for `sfu.example.com`, the ports
(`7881/tcp`, `7882/udp`) and the `LIVEKIT_*` variables; `provision.sh` installs
and enables it. Two rules: the backend mints join tokens from `LIVEKIT_*`
alone and cannot tell whether the SFU is running (the health check and
`verify.sh` can), and the web app's CSP must name the SFU (section 9).

## Map of this directory

| Path | What |
|---|---|
| [`Caddyfile`](Caddyfile), [`nginx.conf`](nginx.conf) | the API vhost, either proxy |
| [`Caddyfile.example.com`](Caddyfile.example.com) | one Caddy fronting the API, the web app and an existing Matrix service |
| [`puca.service`](puca.service) | the systemd unit (hardened; tune memory with a drop-in) |
| [`app-version.example.json`](app-version.example.json) | shape of the file `/app-version` serves (`dual-ship.sh` writes it) |
| [`migrate/`](migrate/README.md) | `provision.sh`, `verify.sh`, the UDP soak, coturn config rendering — and their tests |
| [`ops/`](ops/README.md) | backups, restore, health check, the ship pipeline, key custody — and their tests |
| [`turn/`](turn/README.md) | coturn config template and install |
| [`livekit/`](livekit/README.md) | SFU config, unit and install |
| [`webapp/`](webapp/README.md) | serving the browser client |
| [`download-site/`](download-site/Caddyfile.snippet) | the download page template and its vhost |
| [`mobile/`](mobile/README.md) | signed OTA bundles: keys, publish steps, the manifest path |
| [`cloudflare/`](cloudflare/README.md) | optional: proxying the web origins through Cloudflare and locking the origin |
| [`waker/`](waker/puca-waker.service) | the LAN Wake-on-LAN helper (one host only; `ops/ship-waker.sh`) |
