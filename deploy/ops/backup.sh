#!/usr/bin/env bash
# Nightly Puca backup: Postgres dump + uploaded E2EE attachment blobs + the
# service's configuration, gzip'd, 14-day local rotation, with an OPTIONAL
# offsite copy.
#
# WHY uploads too: the DB does NOT contain the uploaded file ciphertext (it
# lives on the local filesystem under /opt/puca/uploads). A DB-only backup
# silently loses every shared attachment on a disk loss — the message keys
# survive, but the blobs they decrypt do not.
#
# WHY the config too: /opt/puca/.env is the ONLY copy of JWT_SECRET, the
# database password, TURN_SECRET and the LiveKit secret. A restore of the
# database and uploads onto a rebuilt box without it gives you the data with a
# new identity for every secret — every session invalid, every TURN credential
# refused, the SFU unreachable. The dump is useless without it; it goes in the
# same rotation, through the same encryption gate (a plaintext .env offsite is
# strictly worse than a plaintext dump).
#
# OFFSITE IS OFF until you set OFFSITE_DEST (or OFFSITE_CMD). Local-only backups
# sit on the SAME disk as the database — a box/disk failure takes the data AND
# its backups together. Set an offsite target to actually be recoverable.
#
# THE DISK IT PROTECTS IS THE DISK IT FILLS. Every night archives the ENTIRE
# uploads tree (E2EE ciphertext, so gzip recovers nothing), and 14 days of
# that is ~14x the uploads footprint next to Postgres on the same partition.
# So the uploads stage checks free space first and SKIPS itself rather than
# filling the disk (BACKUP_MIN_FREE_BYTES below), MAX_LOCAL_UPLOAD_ARCHIVES
# caps the local count independently of age, and every run logs the backups
# directory size and the remaining free space so backup.log carries a trend.
#
# Not `set -e`: a single failing stage (e.g. an unreachable offsite host) must
# not abort the run and skip rotation/logging of the good local artifacts.
set -uo pipefail

# Optional site config (offsite target, retention). Kept out of this script so
# credentials/paths aren't committed; sourced here so it applies whether run by
# cron or by hand. `set -a` exports everything it sets so the OFFSITE_CMD child
# (ship-offsite.sh) inherits RCLONE_REMOTE etc. See deploy/ops/README.md.
# shellcheck disable=SC1091
if [ -f /etc/default/puca-backup ]; then set -a; . /etc/default/puca-backup; set +a; fi

# Names are resolved, not hardcoded. `pg_dump` against a database that is not
# there fails, gets logged to a directory that is not there, and the job still
# exits 0 — a nightly backup of nothing that looks healthy. See names.sh.
. "$(dirname "$0")/names.sh"
ops_require_install backup
ops_require_db backup

DIR=$INSTALL_DIR/backups
UPLOADS=$INSTALL_DIR/uploads
LOG=$INSTALL_DIR/backup.log
KEEP_DAYS="${KEEP_DAYS:-14}"
# Keep at most this many uploads archives locally, newest first, on top of the
# age rotation. 0 (the default) = age rotation only, i.e. today's behaviour;
# set it on a host whose uploads tree is large relative to its disk. The DB
# dump and config archive are small and stay on age rotation alone.
MAX_LOCAL_UPLOAD_ARCHIVES="${MAX_LOCAL_UPLOAD_ARCHIVES:-0}"
# The uploads archive is written only if at least this much space would
# remain afterwards (the archive is roughly the size of the tree — ciphertext
# does not compress). Default 1 GiB: Postgres shares the partition, and a
# full disk takes it down.
BACKUP_MIN_FREE_BYTES="${BACKUP_MIN_FREE_BYTES:-1073741824}"
TS=$(date +%Y%m%d-%H%M%S)

# --- Offsite target (choose ONE; leave both empty to stay local-only) ---
# rsync-over-ssh or a mounted path:
#   OFFSITE_DEST="backup@nas.local:/backups/puca"
#   OFFSITE_DEST="/mnt/nas/puca"
# ...or a custom push command invoked as `$OFFSITE_CMD <file>` (overrides DEST):
#   OFFSITE_CMD="rclone copy --config /root/.config/rclone/rclone.conf --to b2:bucket/puca"
#   OFFSITE_CMD="aws s3 cp --only-show-errors s3://your-bucket/puca/"
# Set these in the environment (e.g. an /etc/default/puca-backup sourced
# by cron, or export before running) — do NOT hardcode credentials in this file.
OFFSITE_DEST="${OFFSITE_DEST:-}"
OFFSITE_CMD="${OFFSITE_CMD:-}"

log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }
human(){ numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"; }
mkdir -p "$DIR"
# The dumps written below contain every user's SRP verifier and their
# password-wrapped E2EE seed — the offline-attack material for the whole
# instance. Without this they took the default mode (commonly 0755 on the
# directory, 0644 on the files), readable by every local account on the box.
# Set it on the directory AND via umask, so each file created below inherits it
# and a re-run over an existing directory is corrected too.
chmod 700 "$DIR" 2>/dev/null || true
umask 077

# --- 1. Postgres ---
DB_FILE="$DIR/$DB_NAME-db-$TS.sql.gz"
if sudo -u postgres pg_dump "$DB_NAME" | gzip > "$DB_FILE"; then
	log "db ok -> $(basename "$DB_FILE") ($(du -h "$DB_FILE" | cut -f1))"
else
	log "ERROR db dump failed"; rm -f "$DB_FILE"; DB_FILE=""; DB_DUMP_FAILED=1
fi

# --- 2. Uploaded attachment ciphertext ---
UP_FILE="$DIR/$DB_NAME-uploads-$TS.tar.gz"
if [ -d "$UPLOADS" ]; then
	need="$(du -sb "$UPLOADS" 2>/dev/null | cut -f1)"; need="${need:-0}"
	free="$(df -B1 --output=avail "$DIR" 2>/dev/null | tail -1 | tr -d ' ')"; free="${free:-0}"
	if [ "$free" -lt $(( need + BACKUP_MIN_FREE_BYTES )) ] 2>/dev/null; then
		log "ERROR insufficient free space for the uploads archive (tree is $(human "$need"), only $(human "$free") free, want $(human "$BACKUP_MIN_FREE_BYTES") left afterwards) — skipping it rather than filling the disk Postgres lives on; set MAX_LOCAL_UPLOAD_ARCHIVES, lower KEEP_DAYS, or add disk"
		UP_FILE=""
	elif tar -czf "$UP_FILE" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"; then
		log "uploads ok -> $(basename "$UP_FILE") ($(du -h "$UP_FILE" | cut -f1))"
	else
		log "ERROR uploads tar failed"; rm -f "$UP_FILE"; UP_FILE=""
	fi
else
	log "WARN uploads dir $UPLOADS missing — skipped"; UP_FILE=""
fi

# --- 3. Configuration: .env (JWT_SECRET, DB password, TURN/LiveKit secrets) ---
# Plus /etc/default/puca when present — the names override the ops scripts
# read, without which a restored box monitors and backs up the wrong names.
# NOT /etc/default/puca-backup: it holds the offsite credentials, which the
# offsite target already has by definition. Members are stored relative to /
# so the archive restores with `tar -xzf <file> -C / <member>`, one member at
# a time, by hand — restore.sh deliberately never applies it (see its header).
CFG_FILE="$DIR/$DB_NAME-config-$TS.tar.gz"
cfg_members=()
[ -f "$INSTALL_DIR/.env" ] && cfg_members+=("${INSTALL_DIR#/}/.env")
[ -f /etc/default/puca ]   && cfg_members+=("etc/default/puca")
if [ ${#cfg_members[@]} -gt 0 ]; then
	if tar -czf "$CFG_FILE" -C / "${cfg_members[@]}"; then
		log "config ok -> $(basename "$CFG_FILE") (${cfg_members[*]})"
	else
		log "ERROR config tar failed"; rm -f "$CFG_FILE"; CFG_FILE=""
	fi
else
	log "WARN no $INSTALL_DIR/.env to back up — a restore onto a rebuilt box will have NO secrets"; CFG_FILE=""
fi

# --- 4. Offsite copy (optional, strongly recommended) ---
#
# ENCRYPT BEFORE OFFSITE. The DB dump contains SRP verifiers, password-wrapped
# E2EE seeds, and plaintext password-reset tokens; the config archive contains
# JWT_SECRET, which forges a login for any account; gzip is not encryption. The
# offsite target is a THIRD PARTY (Drive/R2/B2/a NAS), so the artifact must be
# encrypted to a key whose PRIVATE half lives OFF this box — then a compromise
# of the backup target (or this box) does not hand over every account's
# credentials. Set ONE recipient and the offsite copy is encrypted. Set
# neither and NOTHING is shipped: the local dumps still happen, and backup.log
# says every night why the offsite copy was withheld. A plaintext offsite copy
# is available only by saying so explicitly (BACKUP_ALLOW_PLAINTEXT=1) — the
# dump holds every account's SRP verifier and every live reset token, so the
# default cannot be "ship it and warn".
#
#   BACKUP_AGE_RECIPIENT="age1..."          # preferred; `age -r`
#   BACKUP_GPG_RECIPIENT="ops@example.com"  # `gpg --encrypt -r`
#   BACKUP_ALLOW_PLAINTEXT=1                # accept an UNENCRYPTED offsite copy
#
# The recipient is a PUBLIC key — no secret is stored on this box. Keep the
# matching private key offline; without it these backups cannot be read, which
# is the entire point. Test recovery before you rely on it: restore-drill.sh
# consumes the encrypted artifact where the private half lives (it needs
# BACKUP_AGE_IDENTITY there), and `--local` on this box.
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
BACKUP_ALLOW_PLAINTEXT="${BACKUP_ALLOW_PLAINTEXT:-0}"

# Echo a path to ship for `$1`: the encrypted copy when a recipient is set (and
# the tool is present and succeeds), else the original. Encryption failures are
# FATAL for that artifact — better to skip the offsite copy than to ship the
# secrets in the clear after asking for them to be encrypted. Prints nothing on
# such a failure so the caller skips shipping.
encrypt_for_offsite(){
	local f="$1"
	if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
		if ! command -v age >/dev/null 2>&1; then
			log "ERROR age not installed but BACKUP_AGE_RECIPIENT set — refusing to ship $(basename "$f") unencrypted"; return 0
		fi
		if age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f"; then echo "$f.age"; else
			log "ERROR age encryption failed for $(basename "$f") — not shipping"; rm -f "$f.age"; fi
		return 0
	fi
	if [ -n "$BACKUP_GPG_RECIPIENT" ]; then
		if ! command -v gpg >/dev/null 2>&1; then
			log "ERROR gpg not installed but BACKUP_GPG_RECIPIENT set — refusing to ship $(basename "$f") unencrypted"; return 0
		fi
		if gpg --batch --yes --trust-model always --encrypt -r "$BACKUP_GPG_RECIPIENT" -o "$f.gpg" "$f"; then echo "$f.gpg"; else
			log "ERROR gpg encryption failed for $(basename "$f") — not shipping"; rm -f "$f.gpg"; fi
		return 0
	fi
	if [ "$BACKUP_ALLOW_PLAINTEXT" = "1" ]; then
		log "WARN offsite copy of $(basename "$f") is UNENCRYPTED (BACKUP_ALLOW_PLAINTEXT=1) — it contains SRP verifiers, reset tokens and/or JWT_SECRET"
		echo "$f"
		return 0
	fi
	# Fail closed: print nothing, and ship() skips the upload.
	log "ERROR offsite copy of $(basename "$f") WITHHELD — it would be unencrypted; set BACKUP_AGE_RECIPIENT or BACKUP_GPG_RECIPIENT (or BACKUP_ALLOW_PLAINTEXT=1 to accept the exposure)"
}

ship(){
	local f="$1"; [ -n "$f" ] && [ -f "$f" ] || return 0
	local out; out="$(encrypt_for_offsite "$f")"
	# encrypt_for_offsite prints nothing when a REQUESTED encryption failed —
	# skip shipping rather than fall back to plaintext.
	[ -n "$out" ] || return 0
	local encrypted=0; [ "$out" != "$f" ] && encrypted=1
	if [ -n "$OFFSITE_CMD" ]; then
		if $OFFSITE_CMD "$out"; then log "offsite ok (cmd, enc=$encrypted) -> $(basename "$out")"
		else log "ERROR offsite cmd failed: $(basename "$out")"; fi
	elif [ -n "$OFFSITE_DEST" ]; then
		if rsync -a "$out" "$OFFSITE_DEST"/; then log "offsite ok (rsync, enc=$encrypted) -> $(basename "$out")"
		else log "ERROR offsite rsync failed: $(basename "$out")"; fi
	fi
	# Remove the transient encrypted copy; the local backup keeps the plaintext
	# artifact for a direct on-box restore (same trust boundary as the live DB).
	[ "$encrypted" = 1 ] && rm -f "$out"
	return 0
}
if [ -z "$OFFSITE_DEST" ] && [ -z "$OFFSITE_CMD" ]; then
	log "WARN offsite disabled (OFFSITE_DEST/OFFSITE_CMD unset) — backups are LOCAL-ONLY and will NOT survive a box/disk loss"
else
	ship "$DB_FILE"; ship "$UP_FILE"; ship "$CFG_FILE"
fi

# --- 5. Rotation (every artifact type; also sweeps legacy puca-*.sql.gz) ---
#
# NOT WHEN TONIGHT'S DUMP FAILED. Rotation deletes by age, so a run that
# produced no new database backup and rotated anyway spends one day of the
# retention window for nothing. Repeat that for KEEP_DAYS nights — a full disk,
# a Postgres that will not start, a permissions change — and the last good
# backup is deleted by this script, on the night you most need it, having
# reported success every time.
#
# So: a failed dump skips rotation entirely (the uploads and config archives
# keep their own copies too — they are worth more than the disk they cost when
# the database side is already broken) and makes the whole run exit non-zero.
# Cron mails a non-zero exit; it does not read logs.
if [ "${DB_DUMP_FAILED:-0}" = "1" ]; then
	log "ERROR skipping rotation: tonight produced no database backup, and rotating would spend a day of the $KEEP_DAYS-day window for nothing"
else
find "$DIR" -name "$DB_NAME-*.sql.gz"         -mtime +"$KEEP_DAYS" -delete
find "$DIR" -name "$DB_NAME-uploads-*.tar.gz" -mtime +"$KEEP_DAYS" -delete
find "$DIR" -name "$DB_NAME-config-*.tar.gz"  -mtime +"$KEEP_DAYS" -delete
# Count cap on the uploads archives — the artifact that scales with the data —
# newest kept. Names carry no spaces (they are timestamps), so `ls -t` is safe.
if [ "$MAX_LOCAL_UPLOAD_ARCHIVES" -gt 0 ] 2>/dev/null; then
	ls -t "$DIR"/"$DB_NAME"-uploads-*.tar.gz 2>/dev/null | tail -n +$(( MAX_LOCAL_UPLOAD_ARCHIVES + 1 )) | while read -r old; do
		rm -f "$old" && log "rotated (count cap $MAX_LOCAL_UPLOAD_ARCHIVES) -> $(basename "$old")"
	done
fi

fi

# --- 6. The trend line: how much the backups hold, how much room is left ---
log "backups dir $(du -sh "$DIR" 2>/dev/null | cut -f1), free on that filesystem $(human "$(df -B1 --output=avail "$DIR" 2>/dev/null | tail -1 | tr -d ' ')")"

# --- 7. Tell the scheduler ------------------------------------------------
# The database dump is the artifact a restore cannot do without. Everything
# else here is recoverable or re-derivable; that one is not. Exit non-zero so
# `cron` mails the operator, `systemd` marks the unit failed, and any external
# monitor sees it. Logging an ERROR and exiting 0 is how a backup stops
# existing without anybody finding out.
if [ "${DB_DUMP_FAILED:-0}" = "1" ]; then
	log "FAILED no database backup was produced tonight"
	exit 1
fi
log "ok"
