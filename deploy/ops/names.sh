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
