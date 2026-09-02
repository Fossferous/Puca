# Ops scripts

Two families live here. The first runs **on the server** (cron and by hand);
the second runs **on your machine** and pushes releases to every server.

## On the server

- `names.sh` — **sourced by all of the below; install it alongside them.**
  Resolves the service/database/install-dir names and the listener
  (`HEALTH_URL`, from `PORT`/`BIND_ADDR` in the deployment's `.env`) instead
  of hardcoding them, and aborts loudly when it cannot find the deployment at
  all. Also holds `ops_decrypt_artifact`, which opens an encrypted offsite
  artifact for the two restore scripts.
- `backup.sh` — nightly backup of **three** things: the database (`pg_dump`),
  the uploaded E2EE attachment blobs (`<install dir>/uploads`), and the
  service configuration (`<install dir>/.env` — `JWT_SECRET`, the database
  password, the TURN and LiveKit secrets — plus `/etc/default/puca` when
  present) → `<install dir>/backups/<db>-db-*.sql.gz`,
  `<db>-uploads-*.tar.gz`, `<db>-config-*.tar.gz`, 14-day rotation. Logs to
  `<install dir>/backup.log`, including the backups directory size and the
  free space left. Optionally ships a copy off the box (see **Offsite**).
- `restore.sh` — restore from a backup set: `restore.sh <db.sql.gz> [uploads.tar.gz]`
  (encrypted `.age`/`.gpg` offsite artifacts accepted). DESTRUCTIVE
  (drops+recreates the DB, replaces uploads); stops/starts the service. Every
  precondition — the owner role, every role the dump names, the ability to
  decrypt — is checked **before** anything is stopped or dropped. It names
  the config archive and deliberately never applies it (see **Restore**).
- `restore-drill.sh` — non-destructive rehearsal: proves a backup actually
  restores, into a throwaway database created with the same `createdb -O` the
  real restore uses. `--local` uses the newest local set; no argument fetches
  the newest **offsite** set, which is encrypted and needs the identity (see
  **Offsite**).
- `healthcheck.sh` — every 5 min: restarts the backend if it is inactive or
  HTTP-hung (probing the port from `.env`); detects a crash-looping unit
  (`NRestarts` climbing) for the backend, coturn, LiveKit and the LAN waker;
  supervises coturn and LiveKit where their units are enabled (restart when
  down, one liveness probe each); re-asserts the origin firewall **only on a
  host where ufw was configured** (an SSH allow rule in `ufw show added`, or
  `OPS_MANAGE_UFW=1`); checks Postgres. Logs to `<install dir>/health.log`.
- `puca.cron` — the `/etc/cron.d/puca` schedule wiring backup + health up.
- `ship-offsite.sh` — the rclone uploader `backup.sh` calls when
  `OFFSITE_CMD` points at it (see **Offsite**).
- `add-webapp-csp.py` — adds the Content-Security-Policy to the web app's
  Caddy vhost (see **CSP**).

Install:

```bash
sudo cp deploy/ops/{names.sh,backup.sh,restore.sh,restore-drill.sh,healthcheck.sh,ship-offsite.sh} /opt/puca/
sudo chmod +x /opt/puca/*.sh
sudo cp deploy/ops/puca.cron /etc/cron.d/puca
sudo systemctl enable --now cron
sudo /opt/puca/backup.sh && tail -5 /opt/puca/backup.log      # db ok / uploads ok / config ok
sudo /opt/puca/restore-drill.sh --local                        # must print RESTORE DRILL PASSED
```

The tests beside them (`*.test.sh`) run offline against stubs — run them on
any Linux/WSL shell before trusting an edited script:
`bash deploy/ops/healthcheck.test.sh` etc.

### Names are resolved, not assumed

A fresh install names everything `puca`; a deployment predating the rename names
it `sovereign`. Hardcoding either breaks the other **silently**, which is the
reason `names.sh` exists: `pg_dump` against a database that isn't there fails,
logs into a directory that isn't there, and the job still exits 0 — a nightly
backup of nothing that looks perfectly healthy. The healthcheck equivalent
"restarts" a unit that doesn't exist and never looks at the one that does.

`names.sh` takes the first answer it finds: an explicit environment variable,
then `/etc/default/puca`, then whichever unit is actually installed, then the
fresh-install default. If it can't find a deployment it exits 78 — non-zero, so
cron mails you instead of swallowing it. Override when needed:

```sh
# /etc/default/puca
SERVICE_NAME=sovereign
INSTALL_DIR=/opt/sovereign
DB_NAME=sovereign
DB_USER=sovereign          # the Postgres role that owns the database (restore.sh's createdb -O)
# HEALTH_URL=http://127.0.0.1:3000/   # only if PORT/BIND_ADDR in .env are not what to probe
# OPS_MANAGE_UFW=1                    # force the ufw re-assert (0 = never touch ufw)
# COTURN_PROBE_PORT=3479              # default: listening-port from /etc/turnserver.conf
# LIVEKIT_PROBE_URL=http://127.0.0.1:7880/   # default: port: from /opt/livekit/livekit.yaml
```

`DB_USER` matters most on a host built by hand as the `postgres` superuser:
`restore.sh` uses the live database's current owner when one exists, and
falls back to `DB_USER` on a rebuilt box — where the role must exist before
the restore, which the script checks before it drops anything.

### Backup knobs (`/etc/default/puca-backup`)

```sh
KEEP_DAYS=14                     # age rotation for all three artifact types
MAX_LOCAL_UPLOAD_ARCHIVES=0      # >0 keeps only the N newest uploads archives locally (on top of age)
BACKUP_MIN_FREE_BYTES=1073741824 # the uploads archive is skipped unless this much stays free afterwards
```

The uploads archive is the one that scales with your data (ciphertext, so
gzip recovers nothing), and 14 nightly copies sit on the same partition as
Postgres. `backup.sh` therefore checks free space before writing it and skips
that stage — logging `ERROR insufficient free space` — rather than filling the
disk the database lives on; `backup.log` carries the size and free-space line
every night so the trend is visible before it is a problem.

## Offsite (REQUIRED to actually be recoverable)

Local-only backups sit on the **same disk** as the database — a box/disk failure
loses the data *and* its backups together. Point `backup.sh` at an off-box
target by exporting one of these (e.g. in `/etc/default/puca-backup`, which
`backup.sh`, `restore.sh` and `restore-drill.sh` all source — never hardcode
creds in a script):

```sh
# rsync over ssh, or a mounted volume:
OFFSITE_DEST="backup@nas.local:/backups/puca"
# ...or a custom push command run as `$OFFSITE_CMD <file>` (overrides DEST):
OFFSITE_CMD="rclone copy --config /root/.config/rclone/rclone.conf --to b2:bucket/puca"
```

Until one is set, `backup.log` prints a `WARN offsite disabled … LOCAL-ONLY` line
every night.

**The offsite copy is encrypted or it is not shipped.** The dump holds every
account's SRP verifier and every live password-reset token, and the config
archive holds `JWT_SECRET` (a login for any account), so set a recipient
whose private key lives OFF the box — `BACKUP_AGE_RECIPIENT="age1…"`
(preferred; `apt install age`) or `BACKUP_GPG_RECIPIENT="ops@example.com"`
— in the same config file. With neither set the local dumps still happen and
`backup.log` records `ERROR offsite copy … WITHHELD` nightly for all three
artifacts; `BACKUP_ALLOW_PLAINTEXT=1` is the only way to ship an unencrypted
copy, and it says so in the log every time. **Uploads are E2EE ciphertext, so
an offsite host never sees plaintext** — the keys stay on clients — making
cheap untrusted storage (a VPS, object storage) perfectly safe as a
destination once the dump and config are encrypted too.

**Drilling the offsite copy.** The encrypted artifact can only be opened where
the private half is, and that is deliberately not the server. So:

- on the box, run `restore-drill.sh --local` (the plaintext local set);
- wherever the age identity lives, set `BACKUP_AGE_IDENTITY=/path/to/key.txt`
  (a path, in `/etc/default/puca-backup` or the environment) and run
  `restore-drill.sh` with no argument — it fetches the newest offsite set,
  decrypts it and restores it into a scratch database;
- a drill on a host that cannot decrypt fails with **`encrypted but cannot be
  opened here`**, which is the finding it is reporting: do not "fix" it by
  copying the private key onto the server.

`restore.sh` accepts the same encrypted artifacts with the same variable, for
the day the box is gone: copy the identity in for the restore and remove it
afterwards.

Config lives in `/etc/default/puca-backup` (sourced by the three scripts,
`chmod 600`, off-repo) so no credentials are committed:

```sh
OFFSITE_CMD=/opt/puca/ship-offsite.sh
RCLONE_REMOTE=gdrive:puca-backups     # <rclone-remote>:<path>
BACKUP_AGE_RECIPIENT=age1...
```

### Free offsite via rclone (Google Drive / R2 / B2 / Mega …)

`ship-offsite.sh` uploads each artifact with `rclone`. One-time auth (rclone
needs a browser once to mint a token):

1. On any machine with a browser + rclone, create the remote, e.g. Google Drive
   (15 GB free, scoped so rclone only sees files it creates):
   `rclone config create gdrive drive scope=drive.file`  → sign in.
2. Copy the resulting `rclone.conf` to the box at
   `/root/.config/rclone/rclone.conf`.
3. Set `OFFSITE_CMD` + `RCLONE_REMOTE` as above; test:
   `sudo /opt/puca/backup.sh && tail /opt/puca/backup.log` (expect
   `offsite ok (cmd, enc=1)` lines), and `rclone --config /root/.config/rclone/rclone.conf
   lsf gdrive:puca-backups`.

## Restore

Full restore (on the box): `restore.sh <db.sql.gz> <uploads.tar.gz>` — local
plaintext files, or the `.age`/`.gpg` offsite copies with `BACKUP_AGE_IDENTITY`
set. It refuses, before touching anything, when the owner role or a role the
dump names is missing on this host (`CREATE ROLE <name> LOGIN PASSWORD '…'`
to match `DATABASE_URL`, or set `DB_USER`).

**The config archive is restored by hand, on purpose.** On a rebuilt box the
data is useless without the previous `.env` (every session token, TURN
credential and SFU token depends on its secrets), but swapping those under a
running host logs every user out — so `restore.sh` names the archive and does
not apply it:

```sh
tar -tzf /opt/puca/backups/puca-config-<ts>.tar.gz          # see what is in it
tar -xzf /opt/puca/backups/puca-config-<ts>.tar.gz -C / opt/puca/.env   # before the first start
```

Quick DB-only peek: `gunzip -c <file>.sql.gz | sudo -u postgres psql -d puca`.
Rehearse without touching prod with `restore-drill.sh` (above).

## Content-Security-Policy on the web origin

The API origin sets COOP/COEP, `nosniff`, `X-Frame-Options: DENY`, a strict
Referrer-Policy and a locked-down Permissions-Policy — and deliberately **no
CSP**. `src/main.rs` says why where it sets them: the web app is served from a
different origin, so a strict policy belongs on that host, not on the API. The
axum app never serves the SPA (its only `ServeDir` is `/releases`).

That makes the policy an ops fact rather than a code fact, and nothing in the
repository could assert it: the applied policy lives only in
`/etc/caddy/Caddyfile`. So it is now **probed**. `check-versions.sh` fetches
`https://$APP_HOST/` over each host's own loopback and FAILs when the response
carries no `Content-Security-Policy` — a one-time manual step turned into a
standing invariant. A host that has never had the policy applied now shows up on
every post-ship check instead of never.

Applying it:

```sh
# ALWAYS dry-run first. A CSP whose connect-src omits the SFU or the API host
# white-screens the SPA, and the failure is in the browser console, not in any
# server log.
python3 deploy/ops/add-webapp-csp.py /etc/caddy/Caddyfile /opt/puca/.env \
        app.your-domain chat.your-domain --dry-run
# review the diff, then re-run without --dry-run (it backs up the Caddyfile),
# then:
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

`add-webapp-csp.py` reads `LIVEKIT_URL` from the box's own `.env` so `connect-src`
names the real SFU and no infrastructure identity travels through an operator's
shell history. It is idempotent. A mesh-only deployment (no `LIVEKIT_URL`)
must say so with `--no-sfu`; the tool refuses to guess.

Verify, on the box:

```sh
curl -sI --resolve "app.your-domain:443:127.0.0.1" https://app.your-domain/ \
  | grep -i content-security-policy
```

and then let `check-versions.sh` keep verifying it for you.

**Known gap: the Android WebView has no CSP.** The desktop shell has one
(`frontend/src-tauri/tauri.conf.json`) and the web origin has the vhost policy
above, but Capacitor's WebView has neither, and it cannot simply be given a
`<meta http-equiv>` in `frontend/index.html`: `capacitor.config.ts` sets
`webDir: 'dist'` and the mobile OTA bundle is zipped from that same `dist/`, so
one `index.html` serves the web app, the OTA and the APK alike. A meta policy
added there would also apply to web users, where it INTERSECTS with the vhost
policy above — a too-tight intersection is a white screen for everyone, and no
unit test can see it. Closing it properly means a Capacitor-only build of the
index (a vite `transformIndexHtml` keyed on the Capacitor build, plus a separate
OTA build) and a real-device smoke test as the gate, staged after the web vhost
policy has been live for a release cycle. Do not ship it blind: on mobile it
arrives as an OTA the user cannot easily roll back.

## On your machine: shipping releases

- `dual-ship.sh` — pushes one artifact to **every** host in `hosts.conf` and
  verifies it on each over that host's own loopback:
  `webapp | mobile | mobile-lite | installer | installer-lite | backend | apk | apk-lite`.
  Also publishes `SHA256SUMS.txt`, the release notes and the privacy statement
  beside the installers, and refuses to ship a download page that does not
  advertise the release or still names a placeholder domain.
- `check-versions.sh` — every surface (desktop `latest.json`, `/app-version`,
  the mobile OTA manifest, the download page, the web bundle, the CSP header)
  must agree on one version on every host; `--preflight` says whether the
  version you are about to build is still free.
- `ship-waker.sh` — builds and installs the LAN waker on exactly one host
  (never a fleet artifact — see its header).
- `backup-keys.sh` — bundles the **developer-machine** signing keys (Tauri
  updater key, mobile OTA RSA key, Android keystore, FCM credential) into two
  tarballs, keys and passphrases SEPARATELY, for off-machine storage. Never
  runs on the server. Losing any of those keys permanently breaks that
  distribution channel; run this the day you generate them and after every
  change, and store the two bundles in different places.
- `hosts.conf.example`, `known_hosts.example` — templates for the two
  gitignored files below.
- `test-manifest-injection.sh` — a harness for the updater-manifest builder
  (release notes with shell metacharacters must not execute on the host).

### Before your first release

The ship scripts source `deploy/ops/hosts.conf`, which is **gitignored**: it
names your servers, and infrastructure identity does not belong in a public
repository. Without it every script above exits 78 and tells you this. Once:

```bash
cp deploy/ops/hosts.conf.example deploy/ops/hosts.conf     # then fill in HOSTS, HOST_IPS, the three domains, names
ssh-keygen -t ed25519 -f ~/.ssh/puca_deploy -C puca-deploy  # the deploy key hosts.conf's SSH_OPTS names
ssh-copy-id -i ~/.ssh/puca_deploy.pub root@<each host>       # or append the .pub to root's authorized_keys
ssh-keyscan -H <each host> >> deploy/ops/known_hosts        # pin host keys; gitignored too
deploy/ops/check-versions.sh --preflight                     # reaches every host = you are set up
```

`SSH_OPTS` pins `StrictHostKeyChecking=yes` and a seeded `known_hosts` on
purpose. Do not relax it to `accept-new` to get the first ship working:
`accept-new` trusts whatever key answers on first contact — the one connection
where a man in the middle is worth mounting — and trusts a rebuilt host again
silently. One `ssh-keyscan` per host is the price of a signed installer you
know was built from your own box.

Also on your machine, before the first client build: the signing keys, which
`deploy/README.md` section 6 walks through, and `backup-keys.sh` for them.
