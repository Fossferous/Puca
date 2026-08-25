# Ops scripts (installed on the server)

- `names.sh` — **sourced by all of the below; install it alongside them.**
  Resolves the service/database/install-dir names for this deployment instead of
  hardcoding them, and aborts loudly when it cannot find the deployment at all.
- `backup.sh` — nightly backup of **both** the database (`pg_dump`) **and**
  the uploaded E2EE attachment blobs (`<install dir>/uploads`) →
  `<install dir>/backups/<db>-db-*.sql.gz` + `<db>-uploads-*.tar.gz`,
  14-day rotation. Logs to `<install dir>/backup.log`. Optionally ships a copy
  off the box (see **Offsite** below).
- `restore.sh` — restore from a backup pair: `restore.sh <db.sql.gz> [uploads.tar.gz]`.
  DESTRUCTIVE (drops+recreates the DB, replaces uploads); stops/starts the service.
- `restore-drill.sh` — non-destructive rehearsal: proves a backup actually
  restores, into a throwaway database.
- `healthcheck.sh` — every 5 min: restarts the service if it's inactive or
  HTTP-hung; checks Postgres; logs issues to `<install dir>/health.log`.
- `puca.cron` — the `/etc/cron.d/puca` schedule wiring backup + health up.

Install: copy `names.sh` + `backup.sh` + `restore.sh` + `restore-drill.sh` +
`healthcheck.sh` to your install dir (default `/opt/puca`, `chmod +x` the
scripts), `puca.cron` to `/etc/cron.d/puca`, ensure `cron` is enabled.

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
```

## Offsite (REQUIRED to actually be recoverable)

Local-only backups sit on the **same disk** as the database — a box/disk failure
loses the data *and* its backups together. Point `backup.sh` at an off-box
target by exporting one of these (e.g. in `/etc/default/puca-backup`, then
`EnvironmentFile`/source it from cron — never hardcode creds in the script):

```sh
# rsync over ssh, or a mounted volume:
OFFSITE_DEST="backup@nas.local:/backups/puca"
# ...or a custom push command run as `$OFFSITE_CMD <file>` (overrides DEST):
OFFSITE_CMD="rclone copy --config /root/.config/rclone/rclone.conf --to b2:bucket/puca"
```

Until one is set, `backup.log` prints a `WARN offsite disabled … LOCAL-ONLY` line
every night. **Uploads are E2EE ciphertext, so an offsite host never sees
plaintext** — the keys stay on clients — making cheap untrusted storage (a VPS,
object storage) perfectly safe as a destination.

Config lives in `/etc/default/puca-backup` (sourced by `backup.sh`, `chmod
600`, off-repo) so no credentials are committed:

```sh
OFFSITE_CMD=/opt/puca/ship-offsite.sh
RCLONE_REMOTE=gdrive:puca-backups     # <rclone-remote>:<path>
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
   `offsite ok (cmd)` lines), and `rclone --config /root/.config/rclone/rclone.conf
   lsf gdrive:puca-backups`.

## Restore

Full restore (on the box): `restore.sh <db.sql.gz> <uploads.tar.gz>`.
Quick DB-only peek: `gunzip -c <file>.sql.gz | sudo -u postgres psql -d puca`.
Rehearse without touching prod by restoring the DB into a scratch database name
(see the header comment in `restore.sh`).
