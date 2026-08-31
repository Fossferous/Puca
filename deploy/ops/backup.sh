#!/usr/bin/env bash
# Nightly Puca backup: Postgres dump + uploaded E2EE attachment blobs,
# gzip'd, 14-day local rotation, with an OPTIONAL offsite copy.
#
# WHY uploads too: the DB does NOT contain the uploaded file ciphertext (it
# lives on the local filesystem under /opt/puca/uploads). A DB-only backup
# silently loses every shared attachment on a disk loss — the message keys
# survive, but the blobs they decrypt do not.
#
# OFFSITE IS OFF until you set OFFSITE_DEST (or OFFSITE_CMD). Local-only backups
# sit on the SAME disk as the database — a box/disk failure takes the data AND
# its backups together. Set an offsite target to actually be recoverable.
#
# Not `set -e`: a single failing stage (e.g. an unreachable offsite host) must
# not abort the run and skip rotation/logging of the good local artifacts.
set -uo pipefail

# Optional site config (offsite target, retention). Kept out of this script so
# credentials/paths aren't committed; sourced here so it applies whether run by
# cron or by hand. `set -a` exports everything it sets so the OFFSITE_CMD child
# (ship-offsite.sh) inherits RCLONE_REMOTE etc. See deploy/ops/README.md.
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
	log "ERROR db dump failed"; rm -f "$DB_FILE"; DB_FILE=""
fi

# --- 2. Uploaded attachment ciphertext ---
UP_FILE="$DIR/$DB_NAME-uploads-$TS.tar.gz"
if [ -d "$UPLOADS" ]; then
	if tar -czf "$UP_FILE" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"; then
		log "uploads ok -> $(basename "$UP_FILE") ($(du -h "$UP_FILE" | cut -f1))"
	else
		log "ERROR uploads tar failed"; rm -f "$UP_FILE"; UP_FILE=""
	fi
else
	log "WARN uploads dir $UPLOADS missing — skipped"; UP_FILE=""
fi

# --- 3. Offsite copy (optional, strongly recommended) ---
#
# ENCRYPT BEFORE OFFSITE. The DB dump contains SRP verifiers, password-wrapped
# E2EE seeds, and plaintext password-reset tokens; gzip is not encryption. The
# offsite target is a THIRD PARTY (Drive/R2/B2/a NAS), so the artifact must be
# encrypted to a key whose PRIVATE half lives OFF this box — then a compromise
# of the backup target (or this box) does not hand over every account's
# credentials. Opt-in, like offsite itself: set ONE recipient and the offsite
# copy is encrypted; set neither and behaviour is exactly as before (with a
# loud warning, since shipping these unencrypted is a real exposure).
#
#   BACKUP_AGE_RECIPIENT="age1..."          # preferred; `age -r`
#   BACKUP_GPG_RECIPIENT="ops@example.com"  # `gpg --encrypt -r`
#
# The recipient is a PUBLIC key — no secret is stored on this box. Keep the
# matching private key offline; without it these backups cannot be read, which
# is the entire point. Test recovery before you rely on it.
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"

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
	log "WARN offsite copy of $(basename "$f") is UNENCRYPTED (set BACKUP_AGE_RECIPIENT or BACKUP_GPG_RECIPIENT) — it contains SRP verifiers and reset tokens"
	echo "$f"
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
	ship "$DB_FILE"; ship "$UP_FILE"
fi

# --- 4. Rotation (both artifact types; also sweeps legacy puca-*.sql.gz) ---
find "$DIR" -name "$DB_NAME-*.sql.gz"         -mtime +"$KEEP_DAYS" -delete
find "$DIR" -name "$DB_NAME-uploads-*.tar.gz" -mtime +"$KEEP_DAYS" -delete
