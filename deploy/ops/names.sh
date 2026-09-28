#!/usr/bin/env bash
# Resolve a deployment's names ONCE, for every server-side ops script.
# Sourced, never executed: `. "$(dirname "$0")/names.sh"`.
#
# WHY THIS FILE EXISTS. A fresh install created by deploy/migrate/provision.sh
# names everything `puca`: /opt/puca, the `puca` systemd unit, the `puca`
# Postgres role and database. A deployment created before the project was
# renamed names all four `sovereign`, and renaming a live install is not
# something an ops script may do behind the operator's back.
#
# Hardcoding either name breaks the other, and it breaks it SILENTLY, which is
# the actual danger:
#
#   - `pg_dump puca` against a `sovereign` database fails, the error is logged
#     to a /opt/puca/backup.log that does not exist, and the nightly backup
#     still exits 0. You have a backup job that has been backing up nothing.
#   - `systemctl is-active --quiet puca` is false on such a box, so the 5-minute
#     healthcheck "restarts" a unit that does not exist and never once looks at
#     the service that is actually running. Monitoring is dead and reports
#     nothing.
#
# Both failures look exactly like a healthy system from the outside. So the
# names are detected, and a script that cannot find its deployment says so
# loudly instead of running against nothing.
#
# Resolution order: explicit environment wins, then /etc/default/puca, then
# whatever is actually installed on this box, then the fresh-install default.

# shellcheck disable=SC1091
[ -f /etc/default/puca ] && { set -a; . /etc/default/puca; set +a; }

# Detect from the installed unit. `systemctl cat` distinguishes "no such unit"
# from "unit exists but is stopped" — `is-active` cannot, and a stopped service
# is precisely the case these scripts exist to handle.
if [ -z "${SERVICE_NAME:-}" ]; then
	for _ops_cand in puca sovereign; do
		if systemctl cat "$_ops_cand" >/dev/null 2>&1; then
			SERVICE_NAME="$_ops_cand"
			break
		fi
	done
	unset _ops_cand
fi

SERVICE_NAME="${SERVICE_NAME:-puca}"
INSTALL_DIR="${INSTALL_DIR:-/opt/$SERVICE_NAME}"
DB_NAME="${DB_NAME:-$SERVICE_NAME}"
DB_USER="${DB_USER:-$SERVICE_NAME}"
SERVICE_USER="${SERVICE_USER:-$SERVICE_NAME}"

# --- The listener -------------------------------------------------------------
#
# PORT and BIND_ADDR are operator knobs (.env.example), and the same argument
# this file makes about names applies to them: a probe hardcoded to
# 127.0.0.1:3000 against a backend on PORT=8080 can never succeed, so the
# 5-minute healthcheck would restart a perfectly healthy service forever —
# dropping every WebSocket and every call each time. Read ONLY the two lines
# needed, never source the file: .env also holds JWT_SECRET and the database
# password, and sourcing it would hand both to every child process.
#
# `|| true` inside each substitution: restore.sh sources this under
# `set -euo pipefail`, and a grep that finds no PORT= line exits 1 — which would
# abort the WHOLE script, silently, before it printed a word. (Found by the
# restore test on its first run.)
if [ -z "${HEALTH_URL:-}" ]; then
	_ops_port="${HEALTH_PORT:-}"
	_ops_bind=""
	if [ -r "$INSTALL_DIR/.env" ]; then
		[ -n "$_ops_port" ] || _ops_port="$( { grep -m1 -E '^PORT=' "$INSTALL_DIR/.env" 2>/dev/null || true; } | cut -d= -f2- | tr -d '[:space:]"'"'")"
		_ops_bind="$( { grep -m1 -E '^BIND_ADDR=' "$INSTALL_DIR/.env" 2>/dev/null || true; } | cut -d= -f2- | tr -d '[:space:]"'"'")"
	fi
	case "$_ops_port" in ''|*[!0-9]*) _ops_port=3000 ;; esac
	case "$_ops_bind" in
		''|0.0.0.0|127.0.0.1|localhost|::|'[::]') _ops_host=127.0.0.1 ;;
		*:*) _ops_host="[$_ops_bind]" ;;   # a v6 literal binds only that address
		*)   _ops_host="$_ops_bind" ;;      # a specific v4 address: loopback would not answer
	esac
	HEALTH_PORT="$_ops_port"
	HEALTH_URL="http://${_ops_host}:${_ops_port}/"
	unset _ops_port _ops_bind _ops_host
fi

# Abort loudly when the resolved deployment is not on this box. Exit 78 is
# EX_CONFIG, and a non-zero exit is what makes cron mail the operator rather
# than swallow it.
ops_require_install() {
	local what="${1:-ops}"
	if ! systemctl cat "$SERVICE_NAME" >/dev/null 2>&1; then
		echo "FATAL($what): no systemd unit '$SERVICE_NAME' on this host." >&2
		echo "  This script would monitor/back up nothing. Set SERVICE_NAME" >&2
		echo "  (and DB_NAME / INSTALL_DIR if they differ) in /etc/default/puca." >&2
		logger -t "${SERVICE_NAME}-ops" "FATAL($what): unit '$SERVICE_NAME' missing; aborted"
		exit 78
	fi
	if [ ! -d "$INSTALL_DIR" ]; then
		echo "FATAL($what): install dir '$INSTALL_DIR' does not exist." >&2
		logger -t "${SERVICE_NAME}-ops" "FATAL($what): '$INSTALL_DIR' missing; aborted"
		exit 78
	fi
}

# Confirm the database is actually reachable under the resolved name. A dump of
# a database that is not there is the failure this whole file is about.
ops_require_db() {
	local what="${1:-ops}"
	if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
		echo "FATAL($what): no Postgres database named '$DB_NAME'." >&2
		echo "  Set DB_NAME in /etc/default/puca to the real database." >&2
		logger -t "${SERVICE_NAME}-ops" "FATAL($what): database '$DB_NAME' missing; aborted"
		exit 78
	fi
}

# --- Root writing inside a directory it does not own -----------------------------
#
# INSTALL_DIR belongs to the service user (provision.sh chowns it), and these
# scripts run as root. Any NAME in a directory someone else owns is theirs to
# redirect: a symlink planted as `health.log`, `.health-http-ok` or `backups`
# turns root's next `>`, `>>`, `chmod` or extraction into a write wherever it
# points — truncate /etc/shadow, chmod /etc, drop a file in /etc/profile.d.
#
# Today that needs more than a compromised backend: the unit runs with
# ProtectSystem=strict and may write only uploads/ and releases/. That is one
# line of a unit file, though, and not every host was built from it — so root
# does not rely on it. Two rules:
#
#  - A LOG in such a directory is only appended with O_NOFOLLOW and created
#    with O_EXCL (ops_append): a planted symlink is refused, not followed; a
#    FIFO cannot hang the run; nothing is created through a dangling link.
#    State that is REWRITTEN does not live there at all (healthcheck.sh keeps
#    it in OPS_STATE_DIR).
#  - A DIRECTORY root fills with files is entered, not addressed
#    (ops_enter_private_dir): cd into it, prove that what was entered is the
#    real path and that nobody else can write it, then work relative to `.`.
#    From then on the process holds the directory itself, so renaming or
#    replacing the path cannot redirect a write, and no one can plant a name
#    inside it.
#
# A hard link would get past O_NOFOLLOW; fs.protected_hardlinks (on by default
# on every distro this targets) stops a user linking a file it does not own.

#   ops_append <file> <line>  -> 0 when the line was appended; 1 when <file>
#   is a symlink, FIFO, directory or anything else that is not a plain file.
ops_append() {
	printf '%s\n' "$2" | dd of="$1" oflag=append,nofollow,nonblock conv=notrunc,nocreat status=none 2>/dev/null && return 0
	printf '%s\n' "$2" | dd of="$1" oflag=append,nofollow,nonblock conv=notrunc,excl status=none 2>/dev/null
}

#   ops_enter_private_dir <dir> [create]  -> cd into <dir> and return 0, or
#   return 1 from `/` with the reason in OPS_DIR_ERR. <dir> must be a real
#   directory at exactly that path (not reached through a symlink), owned by
#   the user running this, and writable by no one else. With `create`, a
#   missing <dir> is made 0700 first.
ops_enter_private_dir() {
	local d="${1%/}" parent want got owner mode
	OPS_DIR_ERR=""
	parent="$(cd -P -- "$(dirname -- "$d")" 2>/dev/null && pwd -P)" ||
		{ OPS_DIR_ERR="$(dirname -- "$d") does not exist"; return 1; }
	want="${parent%/}/$(basename -- "$d")"
	if [ "${2:-}" = create ] && [ ! -e "$d" ] && [ ! -L "$d" ]; then
		mkdir -m 700 -- "$d" 2>/dev/null || true   # a race either way is settled by the checks below
	fi
	cd -P -- "$d" 2>/dev/null || { OPS_DIR_ERR="$d is not a directory"; cd /; return 1; }
	got="$(pwd -P)"
	if [ "$got" != "$want" ]; then
		OPS_DIR_ERR="$d leads to $got, not to itself — something replaced it with a symlink"; cd /; return 1
	fi
	# `.` is the directory now held, whatever the path points at by now.
	owner="$(stat -c %u .)"; mode="$(stat -c %a .)"
	if [ "$owner" != "$(id -u)" ]; then
		OPS_DIR_ERR="$d is owned by uid $owner, not by uid $(id -u), which writes into it"; cd /; return 1
	fi
	if (( 8#$mode & 8#022 )); then
		OPS_DIR_ERR="$d is mode $mode — writable by others, who could plant names in it"; cd /; return 1
	fi
	return 0
}

# --- Offsite artifacts are encrypted; the restore path must be able to open them.
#
# backup.sh ships `<name>.age` / `<name>.gpg` offsite (and nothing else — see
# its encrypt_for_offsite). Until this existed, neither restore.sh nor
# restore-drill.sh could consume one: the drill's rclone filter never matched
# the `.age` suffix and reported "no db backup found", and both piped the file
# straight into gunzip. So the only copy that survives a disk loss was the one
# copy the tooling could not read.
#
#   ops_decrypt_artifact <file> <workdir>
#
# Prints the plaintext path (the file itself when it is not encrypted; a copy
# under <workdir> otherwise). Returns 1 with the reason on stderr when the
# artifact is encrypted and this host cannot open it — the caller decides
# whether that is fatal (restore.sh) or a drill failure (restore-drill.sh).
#
# The age identity comes from BACKUP_AGE_IDENTITY (a path; set it in
# /etc/default/puca-backup or the environment). It is EXPECTED to be absent on
# the server — the whole point of encrypting offsite is that the private half
# lives elsewhere — so the offsite drill runs where the key lives, and on the
# box you run `restore-drill.sh --local`. gpg uses the caller's keyring.
ops_decrypt_artifact() {
	local f="$1" work="$2" out
	case "$f" in
		*.age)
			if [ -z "${BACKUP_AGE_IDENTITY:-}" ] || [ ! -r "${BACKUP_AGE_IDENTITY:-}" ]; then
				echo "$(basename "$f") is age-encrypted but no identity is available on this host (BACKUP_AGE_IDENTITY unset or unreadable)" >&2
				return 1
			fi
			command -v age >/dev/null 2>&1 || { echo "$(basename "$f") is age-encrypted and \`age\` is not installed here" >&2; return 1; }
			out="$work/$(basename "${f%.age}")"
			if ! age -d -i "$BACKUP_AGE_IDENTITY" -o "$out" "$f" 2>/dev/null; then
				rm -f "$out"; echo "age could not decrypt $(basename "$f") with $BACKUP_AGE_IDENTITY (wrong identity?)" >&2; return 1
			fi
			echo "$out" ;;
		*.gpg)
			command -v gpg >/dev/null 2>&1 || { echo "$(basename "$f") is gpg-encrypted and \`gpg\` is not installed here" >&2; return 1; }
			out="$work/$(basename "${f%.gpg}")"
			if ! gpg --batch --yes --quiet --decrypt -o "$out" "$f" 2>/dev/null; then
				rm -f "$out"; echo "gpg could not decrypt $(basename "$f") — the secret key is not in this user's keyring (it is meant to live off the box)" >&2; return 1
			fi
			echo "$out" ;;
		*) echo "$f" ;;
	esac
}
