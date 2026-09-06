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
  `OPS_MANAGE_UFW=1`); checks Postgres; and on a host behind Cloudflare
  asserts that the Caddyfile carries the global `servers { trusted_proxies …
  client_ip_headers CF-Connecting-IP }` block from
  `deploy/cloudflare/caddy-behind-cloudflare.snippet` — without it every
  per-IP rate limit is one bucket for the whole Cloudflare edge, and nothing
  else notices (see **Abuse runbook** §5). Logs to `<install dir>/health.log`.
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
# CADDYFILE=/etc/caddy/Caddyfile     # the file the Cloudflare client-IP assertion reads
# OPS_BEHIND_CLOUDFLARE=1            # force that assertion (0 = never; default: detect from the Caddyfile / cf-origin ufw rules)
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

## Abuse runbook: the instance just got a public audience

Everything below runs **on the box** as root against the names `names.sh`
resolves (`puca` on a fresh install; substitute yours). Every behaviour cites
the file that defines it — when this page and the code disagree, the code wins,
so open the cited file before acting on the disagreement.

There is **no instance-level admin API**. Every moderation route is scoped to
one server (`/servers/:server_id/…`, `src/moderation_handlers.rs`), and
`DELETE /account` is self-service only: it demands a fresh password proof that
only `login_step_2` records (`require_password_proof`,
`src/recovery_handlers.rs`), which an operator cannot mint. The operator's
levers are the sign-up gate, `psql`, and the disk. That is by design — the
server cannot read messages, so it cannot judge them either.

### 1. Rotate the sign-up gate

`REGISTRATION_INVITE_CODE` in `/opt/puca/.env` is ONE shared string. `register`
(`src/handlers.rs`) compares what the sign-up form sent against it in constant
time and answers `403 A valid invite code is required to register on this
server.` on a mismatch. Unset or empty means registration is OPEN to anyone who
finds the origin, and every account carries a storage entitlement with no
global cap (section 3). There is no list of codes, no per-code expiry and no
overlap window.

**What a rotation does to codes already handed out: every old copy dies the
instant the restarted process is listening.** The variable comes from the
process environment (`EnvironmentFile=/opt/puca/.env`, `deploy/puca.service`),
so an edit takes effect only on `systemctl restart puca`; from then on anyone
still holding the old code — including someone with the sign-up form open at
that moment — gets the 403 and the client's "That invite code wasn't
accepted" copy (`registerRejectedMessage`,
`frontend/src/components/Login.tsx`). Accounts already created are untouched;
the gate is checked only at `POST /auth/register`. Server invite links
(`<APP_URL>/invite/<code>`, `src/invite_handlers.rs`) are a different thing and
keep working — but a newcomer arriving by one who has no account still needs
the NEW sign-up code, and the client says so.

So rotating without stranding anyone mid-signup is ordering, not a server
feature: mint the new code, hand it to everyone you are still expecting
BEFORE the restart, restart at a quiet moment (the restart drops every live
WebSocket and every call on the box — clients reconnect on their own, calls do
not), then tell whoever had the old code that it is dead.

```bash
NEW=$(openssl rand -hex 12)                                       # 24 chars; the check is exact-match
sudo sed -i "s|^#\? *REGISTRATION_INVITE_CODE=.*|REGISTRATION_INVITE_CODE=$NEW|" /opt/puca/.env
grep -c '^REGISTRATION_INVITE_CODE=' /opt/puca/.env               # must print 1 — append the line if it prints 0
sudo systemctl restart puca
curl -s https://chat.example.com/config | grep -o '"registration_invite_required":[a-z]*'   # :true
```

`GET /config` (`src/public_config.rs`) tells clients only THAT a code is
required, never the code. To close registration outright, set a code you give
to nobody; never "close" it by unsetting the variable — that opens it.

The sign that the code has leaked, before you rotate:

```bash
sudo -u postgres psql -d puca -c "SELECT id, username, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 25"
```

### 2. Find an account and remove it, with its uploads

Find it. Logins match on `LOWER(username)` (`src/handlers.rs`), so search the
same way, then look at its footprint — owned servers, memberships, storage:

```bash
sudo -u postgres psql -d puca -c "SELECT id, username, created_at, deleted_at FROM users WHERE LOWER(username) = LOWER('the-name')"
sudo -u postgres psql -d puca -v uid=42 <<'SQL'
SELECT id, name FROM servers WHERE owner_id = :uid;
SELECT s.id, s.name FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.user_id = :uid;
SELECT kind, COUNT(*), pg_size_pretty(SUM(size_bytes)) FROM uploaded_files WHERE uploader_id = :uid GROUP BY kind;
SQL
```

Then delete exactly as `delete_account` (`src/handlers.rs`) would: a
**tombstone**, not `DELETE FROM users` — messages, tasks and moderation rows
reference the account by foreign key, and `docs/SECURITY_MODEL.md` §11 is the
contract for what stays. The handler refuses (`409`) while the account owns a
server, because an ownerless server strands its members: if the first query
returned rows, transfer the server in the app or delete it first
(`DELETE FROM servers WHERE id = '<id>'` — every table keyed on `server_id`
cascades, and channels take their messages with them; `delete_server` in
`src/server_handlers.rs` runs the same statement. The one thing neither
cascades nor is swept is `message_reactions`, which has no foreign key to
messages — see section 2; sweep it first with
`DELETE FROM message_reactions WHERE message_id IN (SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = '<id>')`
or accept the orphaned rows — no message view can reach them, but each
reacting user's data export (`REACTIONS_SQL`, `src/export_handlers.rs`) still
lists them).

The transaction below is the handler's own SQL: the anonymising `UPDATE`, then
`ACCOUNT_DELETE_CLEANUP` in the order the code runs it, then the upload stamp.
**If the array in `src/handlers.rs` and this list ever differ, the array is
right** — copy it, do not trust this page. Two deliberate departures, both
marked in the SQL: the SRP salt and verifier are randomised with the
`random()/md5` idiom of `migrations/040_account_deletion_hardening.sql` (the
code uses `OsRng`; this deployment has no pgcrypto, and the bytes only have to
be non-zero, because `deleted_at` is what refuses the login), and the uploads
are stamped `purge_after = NOW()` instead of `NOW() + DELETED_ACCOUNT_FILE_GRACE_DAYS`
— an abuser's files do not get the grace period a mistaken self-deletion gets.

```bash
sudo -u postgres psql -d puca -v ON_ERROR_STOP=1 -v uid=42 <<'SQL'
BEGIN;
-- src/handlers.rs delete_account: the anonymising UPDATE. deleted_at is what the
-- login path checks; token_version + 1 evicts every JWT on every device.
UPDATE users SET
    username = 'deleted#' || id, display_name = NULL, avatar_file_id = NULL,
    join_sound_file_id = NULL, leave_sound_file_id = NULL, email = NULL,
    email_verified = FALSE, public_key = NULL,
    salt = decode(md5(random()::text || id::text), 'hex'),                      -- migration 040's idiom (no pgcrypto)
    verifier = (SELECT decode(string_agg(md5(random()::text || g || users.id::text), ''), 'hex')
                FROM generate_series(1, 16) g),                                 -- 256 random bytes, never zero
    wrap_salt = NULL, recovery_salt = NULL, seed_wrapped_pw = NULL, seed_wrapped_rc = NULL,
    history_pubkey = NULL, history_wrapped_rc = NULL, history_pubkey_sig = NULL,
    account_sign_pub = NULL, deleted_at = NOW(), token_version = token_version + 1
WHERE id = :uid AND deleted_at IS NULL;
-- ACCOUNT_DELETE_CLEANUP, src/handlers.rs, in order:
DELETE FROM device_tokens WHERE user_id = :uid;
UPDATE devices SET revoked_at = NOW() WHERE user_id = :uid AND revoked_at IS NULL;
DELETE FROM notification_preferences WHERE user_id = :uid;
DELETE FROM friends WHERE user1_id = :uid OR user2_id = :uid;
DELETE FROM friend_requests WHERE sender_id = :uid OR receiver_id = :uid;
DELETE FROM blocked_users WHERE blocker_id = :uid OR blocked_id = :uid;
DELETE FROM member_roles WHERE user_id = :uid;
DELETE FROM server_members WHERE user_id = :uid;
DELETE FROM server_nicknames WHERE user_id = :uid;
DELETE FROM email_verification_tokens WHERE user_id = :uid;
DELETE FROM password_reset_tokens WHERE user_id = :uid;
DELETE FROM device_share_invites WHERE owner_user = :uid OR grantee_user = :uid;
DELETE FROM channel_keys WHERE recipient_id = :uid;
UPDATE devices SET name = 'removed', lan_info = NULL WHERE user_id = :uid;
UPDATE token_sessions SET revoked_at = NOW() WHERE user_id = :uid AND revoked_at IS NULL;
-- UPLOAD_GRACE_STAMP_SQL, src/handlers.rs, with the grace set to zero. A server
-- icon or custom emoji the account uploaded belongs to the server and stays.
UPDATE uploaded_files SET purge_after = NOW()
 WHERE uploader_id = :uid AND purge_after IS NULL
   AND id::text NOT IN (SELECT icon_file_id FROM servers WHERE icon_file_id IS NOT NULL)
   AND id::text NOT IN (SELECT file_id FROM custom_emojis WHERE file_id IS NOT NULL)
   AND id::text NOT IN (SELECT file_id FROM server_emojis WHERE file_id IS NOT NULL);
COMMIT;
SQL
```

What SQL cannot do is hang up the account's live sockets (the handler calls
`disconnect_user` after its commit). The `token_version` bump refuses the
account's NEXT request and NEXT WebSocket upgrade, but a socket that is already
open keeps its in-memory room membership until it drops. To cut it now,
`systemctl restart puca` (everyone reconnects; calls drop) — or accept that it
ends at that client's next disconnect.

The stamped uploads are removed by the retention sweep in `src/main.rs`: every
6 hours, 200 rows per pass, row first and then `uploads/<stored_name>` under
`WorkingDirectory=/opt/puca` (`deploy/puca.service`). To reclaim the disk now,
in the sweep's order:

```bash
sudo -u postgres psql -d puca -tAc "DELETE FROM uploaded_files WHERE uploader_id = 42 AND purge_after IS NOT NULL RETURNING stored_name" \
  | while IFS= read -r f; do case "$f" in ''|*/*|*..*) continue ;; esac; sudo rm -f -- "/opt/puca/uploads/$f"; done
```

Their messages stay, as ciphertext attributed to `deleted#<id>`: the server
cannot read them, and they are other people's conversations too. Spam that
must go is a moderator's job in the app (`MANAGE_MESSAGES`); for a flood, two
statements, reactions FIRST:

```sql
DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE user_id = :uid);
DELETE FROM messages WHERE user_id = :uid;
```

Pins, edit history and thread children cascade from the message
(`migrations/018_create_pinned_messages.sql`, `001_init.sql` `message_edits`,
`013_message_tasks.sql`). Reactions do NOT: the table the app uses is
`message_reactions` (`migrations/009_reactions_emojis.sql`), whose
`message_id` carries no foreign key — `001_init.sql`'s `reactions` table does
cascade, but nothing in `src/` reads or writes it. `delete_message` in
`src/message_handlers.rs` sweeps `message_reactions` by hand after every
single-message delete for exactly this reason; run the sweep first here because
once the messages are gone nothing links the orphans to the account. Open
clients see the change on their next history fetch, not by a WebSocket frame.

### 3. Watch storage

Quotas are per ACCOUNT and there is no global cap (`src/upload_handlers.rs`):
512 MiB of attachments (`UPLOAD_MAX_USER_BYTES`, floor 1 MiB), 5000 files
(`MAX_USER_FILES`, a constant), and 2 GiB of clip parts (`CLIP_MAX_USER_BYTES`).
The ceiling on the disk is therefore `accounts × 2.5 GiB`, and the sign-up gate
is the only global cap. The check is coarse on purpose — it reads the SUM
before the write, so concurrent uploads can each pass it by one file.

```bash
du -sh /opt/puca/uploads; df -h /opt/puca                  # what is there, and what is left
sudo -u postgres psql -d puca <<'SQL'
SELECT COUNT(*) AS accounts, pg_size_pretty(COUNT(*) * 2560::bigint * 1024 * 1024) AS worst_case FROM users WHERE deleted_at IS NULL;
SELECT u.id, u.username, COUNT(*) AS files, pg_size_pretty(SUM(f.size_bytes)) AS bytes
  FROM uploaded_files f JOIN users u ON u.id = f.uploader_id
 GROUP BY u.id, u.username ORDER BY SUM(f.size_bytes) DESC LIMIT 15;
SELECT pg_size_pretty(pg_database_size('puca')) AS database;
SQL
grep 'backups dir' /opt/puca/backup.log | tail -3           # backup.sh logs the backups size + free space nightly
```

Every byte of uploads is also archived nightly into `backups/` and kept 14 days
(`KEEP_DAYS`), so 1 GB of uploads costs up to 15 GB on the same partition until
`MAX_LOCAL_UPLOAD_ARCHIVES` caps it; `backup.sh` skips the archive rather than
fill the disk once `BACKUP_MIN_FREE_BYTES` would be breached (see **Backup
knobs**). Lower the per-user quotas in `.env` (restart to apply) before the disk
is the thing that says no.

### 4. Ban, block, report — what each is and where it lives

| Lever | Scope | Who may | Route (`src/main.rs`) | Writes | Effect |
|---|---|---|---|---|---|
| Kick | one server | `KICK_MEMBERS`, outranking the target | `POST /servers/:id/kick/:uid` | deletes the membership + roles | can rejoin by any invite |
| Timeout | one server | `KICK_MEMBERS`, outranking the target (lifting it needs only `KICK_MEMBERS`) | `POST /servers/:id/timeout/:uid` (`DELETE` lifts it) | `member_timeouts` row with `expires_at` | muted in that server until it expires |
| Ban | one server | `BAN_MEMBERS`, outranking the target | `POST /servers/:id/bans/:uid` (`GET …/bans` lists, `DELETE` lifts) | `bans` row; membership + `member_roles` deleted | invite join and public join refuse (`src/invite_handlers.rs`, `src/server_handlers.rs`) |
| Block | personal | anyone | `POST /users/:uid/block` (`DELETE` unblocks) | `blocked_users`; the friendship and pending requests are torn down in the same transaction | DMs, presence and friend surfaces hide the pair from each other; unblocking does not restore the friendship (`block_user`, `src/moderation_handlers.rs`) |
| Report | one server | any member, 15 per hour per server | `POST /servers/:id/reports` | `reports` row, `status = 'pending'` | read by `MANAGE_MESSAGES` holders at `GET /servers/:id/reports`, closed by `PATCH /servers/:id/reports/:rid`; resolved rows pruned after `REPORTS_RETENTION_DAYS`, pending never |

"Outranking the target" is `can_moderate` in `src/permissions.rs`, called by
`kick_member`, `timeout_member` and `ban_member` in `src/moderation_handlers.rs`
alike: the owner may act on anyone, an administrator on anyone but the owner,
everyone else only on a member ranked strictly below their own highest role.
The owner is never kickable, timeout-able or bannable — not by an
administrator, not by anyone. Kick and ban also refuse yourself outright
(`Cannot kick yourself`); timeout relies on the rank rule alone, which stops
everyone but an administrator from timing themselves out. A compromised
`KICK_MEMBERS` account therefore reaches neither the owner nor an
administrator.

In the app: right-click a member (`frontend/src/components/UserContextMenu.tsx`
— Kick, Ban, Report, Block); the ban list and the report queue are in Server
settings (`frontend/src/components/ServerSettingsModal.tsx`). Kicks, bans and
timeouts land in that server's audit log (`GET /servers/:id/audit-log`,
pruned after `AUDIT_RETENTION_DAYS`).

None of these reaches past one server: a banned account keeps its login and
every other server it is in. The instance-wide equivalents are section 1
(nobody new gets in) and section 2 (this account is gone). The pending queue
across every server, for the operator — reasons are what the reporter typed;
the reported message itself is ciphertext the server cannot show you:

```bash
sudo -u postgres psql -d puca -c "SELECT r.id, s.name AS server, r.report_type, left(r.reason, 60) AS reason, r.created_at FROM reports r JOIN servers s ON s.id = r.server_id WHERE r.status = 'pending' ORDER BY r.created_at"
```

### 5. Is the rate limiter per visitor behind Cloudflare?

Every per-IP ceiling keys on `real_client_ip` (`src/state.rs`): the 5/s auth
and 50/s API limiters (`src/middleware/rate_limit.rs`), `WS_MAX_CONNS_PER_IP`,
`UPLOAD_MAX_CONCURRENT_PER_IP`, `FILE_MAX_CONCURRENT_PER_IP`. From a loopback
or private peer — Caddy — it believes `X-Forwarded-For`, so the answer is
whatever Caddy wrote there. Behind Cloudflare that is the real visitor ONLY
with the global `servers { trusted_proxies … client_ip_headers CF-Connecting-IP }`
block of `deploy/cloudflare/caddy-behind-cloudflare.snippet` installed; without
it `{client_ip}` is the edge address and the whole internet shares one bucket —
one visitor's burst 429s everyone, and an attacker is indistinguishable from
the crowd. Three checks, cheapest first:

1. **The healthcheck asserts it** every 5 minutes on any box that is behind
   Cloudflare (a `{client_ip}` placeholder in the Caddyfile, or
   `origin-firewall.sh`'s `cf-origin` ufw rules, or `OPS_BEHIND_CLOUDFLARE=1`):

   ```bash
   grep -c 'one bucket for the whole Cloudflare edge' /opt/puca/health.log    # 0, or you have work to do
   ```

2. **What Caddy actually loaded**, not what the file looks like:

   ```bash
   caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null | python3 -c '
   import json, sys
   for name, srv in json.load(sys.stdin)["apps"]["http"]["servers"].items():
       print(name, srv.get("trusted_proxies", {}).get("source"), srv.get("client_ip_headers"))'
   # expect one line per server like:  srv0 static ['CF-Connecting-IP']  — a None in either column is the collapse
   ```

3. **From outside**, on a machine that is not on the box's LAN — the snippet's
   own closing check, with the second half it needs. Two properties, and each
   test proves only one: headers you send must NOT re-key you (a), and a
   second visitor must NOT share your bucket (b).

   ```bash
   # (a) 15 login attempts, each claiming a DIFFERENT origin: the auth limiter
   #     (5/s, burst 10) must still bite — some 429s — which proves the key is
   #     your real address, not the header you typed.
   for i in $(seq 1 15); do
     curl -s -o /dev/null -w '%{http_code}\n' -X POST https://chat.example.com/auth/login/step1 \
       -H 'content-type: application/json' -H "X-Forwarded-For: 203.0.113.$i" -H "CF-Connecting-IP: 203.0.113.$i" \
       -d '{"username":"nobody-here"}'
   done | sort | uniq -c
   # (b) in the same second, ONE request from a second public IP (a phone off
   #     Wi-Fi will do) must NOT be 429. If it is, everyone is one bucket.
   ```

   A 429 from the backend is a one-line plain-text body; Cloudflare's own rate
   rule answers with its HTML error page — tell them apart before drawing a
   conclusion. And one sign from production itself: `journalctl -u puca | grep
   'WS upgrade refused'` names the address it keyed on (`src/ws.rs`); if that is
   a Cloudflare range rather than a visitor, the collapse is live.

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
