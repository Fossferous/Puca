#!/usr/bin/env bash
# Ship a release artifact to EVERY host in hosts.conf, not just the one DNS
# currently points at.
#
# WHY THIS EXISTS. A second host kept as a rollback target — DNS can be pointed
# back at it with no server-side action — is only a real rollback if it has kept
# receiving every release. Ship one place and forget the other, and "rolling back" means
# silently handing users an OLDER build than the one they were just on: a
# desktop client mid-update-check gets offered a stale signature, a phone gets
# an OTA manifest for a version it already has (or worse, one newer than the
# bundle actually on disk there). This script makes forgetting the second host
# require deliberately skipping a step, not just an oversight.
#
# Only pushes/installs artifacts you already built locally exactly as before —
# it does not change what gets built, just how many places it lands.
#
# Usage:
#   dual-ship.sh webapp    <dist-tarball.tar.gz>
#   dual-ship.sh mobile    <enc-bundle.zip> <version> <sessionKey> <checksum>
#   dual-ship.sh installer <setup.exe> <sig-file> <version> <notes>
#   dual-ship.sh backend   <src-tarball.tar.gz>
#   dual-ship.sh apk       <Puca-x.y.z.apk> <version>
#
# Each subcommand loops over every host, then verifies by running curl ON
# that host against its own loopback — never from wherever this script
# happens to run.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=hosts.conf
source "$HERE/hosts.conf"

FAILED=()

ssh_to() { ssh "${SSH_OPTS[@]}" "${1#*:}" "${@:2}"; }
# The label:target entry is only needed by ssh_to's own stripping; every
# scp_to call site already builds its destination as "${entry#*:}:/path"
# itself, so scp_to just has to drop that redundant leading arg and forward
# the rest untouched. The first version re-appended a stripped-but-pathless
# target too, corrupting the scp invocation into "src dest bare-host" — three
# positional args scp cannot make sense of.
scp_to() { shift; scp "${SSH_OPTS[@]}" "$@"; }

# label:target -> just the label, for readable output.
label_of() { echo "${1%%:*}"; }

# Run curl ON the target host against ITS OWN loopback, not from wherever
# this script happens to execute.
#
# The first version verified with `curl --resolve host:443:<box-ip>` run from
# the CALLER's machine — and every box here has the Cloudflare origin lock
# applied (deploy/cloudflare/origin-firewall.sh), which exists specifically to
# drop non-Cloudflare traffic on 80/443. That made verification depend on the
# caller's current source IP happening to be exempt, which it never durably
# is. Confirmed live: a caller whose IP had simply changed since an earlier,
# unrelated check got a connection timeout against a host that was actually
# completely healthy — indistinguishable from a real outage from the output
# alone. Piped through `| grep | head`/`| sha256sum`, curl's own timeout
# (nonzero) got masked by `pipefail`'s "last command in the pipe wins" rule,
# since head/sha256sum both exit 0 on empty input — so the failure surfaced as
# a silent `set -e` abort with no message, not a clear error.
#
# Loopback traffic never crosses the public interface the origin lock
# filters, so this is deterministic regardless of whatever network the
# tester's own machine is on.
remote_body() {
	local entry="$1" host="$2" path="$3"
	ssh_to "$entry" "curl -sk --resolve '${host}:443:127.0.0.1' 'https://${host}${path}' --max-time 20"
}
# Confirms the box we just shipped to is the one whose Caddy answers, by
# reading the $HOST_HEADER label it sets on itself. Catches a host whose
# Caddy is serving a DIFFERENT vhost config than expected.
remote_host_label() {
	local entry="$1"
	ssh_to "$entry" "curl -sk -I --resolve '$API_HOST:443:127.0.0.1' https://$API_HOST/ --max-time 20 \
		| grep -i '^$HOST_HEADER:' | cut -d' ' -f2- | tr -d '\r\n'"
}
remote_code() {
	local entry="$1" host="$2" path="$3"
	ssh_to "$entry" "curl -sk -o /dev/null -w '%{http_code}' --resolve '${host}:443:127.0.0.1' 'https://${host}${path}' --max-time 20"
}

cmd_webapp() {
	local tarball="${1:?usage: dual-ship.sh webapp <tarball>}"
	# The API base is BAKED at build time from frontend/.env.production, which
	# is GITIGNORED — a build from a fresh clone/worktree silently falls back
	# to localhost:3000 and every login breaks with "failed to fetch". Shipped
	# exactly that way as 0.8.24/0.8.25 on 2026-08-03 (web, desktop AND mobile
	# broken until a rebuilt 0.8.26): the hash verification below can't catch
	# it, because the hash of a wrong build matches itself. Refuse any bundle
	# whose index.html entry chunk doesn't name the production API. The mobile
	# OTA can't be checked here (it arrives pre-encrypted) but is zipped from
	# the same dist/, so this gate covers it in practice — build webapp first.
	# grep -c, NOT grep -q: -q exits at the first match and SIGPIPEs tar, and
	# under `pipefail` that reads as a failed pipeline — the first version of
	# this guard refused every GOOD bundle. -c drains the stream to EOF.
	local entry_rel matches
	entry_rel="$(tar xzOf "$tarball" ./index.html 2>/dev/null | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
	matches="$(tar xzOf "$tarball" "./${entry_rel:-nonexistent}" 2>/dev/null | grep -c "$API_HOST" || true)"
	if [ -z "$entry_rel" ] || [ "${matches:-0}" -eq 0 ]; then
		echo "REFUSING to ship: bundle entry '${entry_rel:-<none found>}' does not contain $API_HOST."
		echo "Was it built without frontend/.env.production (gitignored — fresh clones/worktrees lack it)?"
		exit 1
	fi
	echo "PASS  bundle preflight: entry $entry_rel bakes the production API base ($matches occurrences)"
	local local_sha
	local_sha="$(sha256sum "$tarball" | cut -d' ' -f1)"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== webapp -> $label ==="
		scp_to "$entry" "$tarball" "${entry#*:}:/tmp/webapp-dual.tar.gz"
		ssh_to "$entry" 'set -e
			cd '"$INSTALL_DIR"'
			[ -d webapp ] && cp -a webapp "webapp.bak-dual-$(date +%Y%m%d-%H%M%S)"
			rm -rf webapp/*
			tar xzf /tmp/webapp-dual.tar.gz -C webapp --no-same-owner
			find webapp -exec touch {} +
			rm -f /tmp/webapp-dual.tar.gz'
		# Find-then-hash runs entirely ON the host over loopback, in one SSH
		# call — never as a multi-step pipeline on the machine running this
		# script (see remote_body's header for why that was unreliable).
		local served_sha local_entry_sha entry_js
		served_sha="$(ssh_to "$entry" '
			JS=$(curl -sk --resolve '"$APP_HOST"':443:127.0.0.1 https://'"$APP_HOST"'/ --max-time 20 \
				| grep -oE "assets/index-[A-Za-z0-9_-]+\.js" | head -1)
			curl -sk --resolve '"$APP_HOST"':443:127.0.0.1 "https://'"$APP_HOST"'/$JS" --max-time 20 | sha256sum | cut -d" " -f1
			echo "$JS" >&2
		' 2>/tmp/dual-ship-entry-js)"
		entry_js="$(cat /tmp/dual-ship-entry-js 2>/dev/null)"; rm -f /tmp/dual-ship-entry-js
		local_entry_sha="$(tar xzOf "$tarball" "./$entry_js" 2>/dev/null | sha256sum | cut -d' ' -f1 || echo mismatch)"
		if [ -n "$entry_js" ] && [ "$served_sha" = "$local_entry_sha" ]; then
			echo "PASS  $label serving $entry_js (hash matches)"
		else
			echo "FAIL  $label — served hash does not match the tarball (bundle: '${entry_js:-<none found>}')"
			FAILED+=("$label:webapp")
		fi
	done
}

cmd_mobile() {
	local bundle="${1:?enc bundle}" version="${2:?version}" session_key="${3:?sessionKey}" checksum="${4:?checksum}"
	# Same lengths verify.sh and the original ship enforce — a manifest with
	# either wrong silently ships an unusable OTA every installed app rejects.
	[ "${#session_key}" -eq 369 ] || { echo "REFUSING: sessionKey is ${#session_key} chars, expected 369"; exit 1; }
	[ "${#checksum}" -eq 512 ] || { echo "REFUSING: checksum is ${#checksum} chars, expected 512"; exit 1; }
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== mobile OTA $version -> $label ==="
		scp_to "$entry" "$bundle" "${entry#*:}:$INSTALL_DIR/downloads/mobile/$MOBILE_BUNDLE_PREFIX-$version.enc.zip"
		ssh_to "$entry" "set -e
			cd $INSTALL_DIR
			[ -f mobile-update.json ] && cp -a mobile-update.json mobile-update.json.bak-dual-\$(date +%Y%m%d-%H%M%S)
			cat > mobile-update.json <<'MEOF'
{
  \"version\": \"$version\",
  \"url\": \"https://$DOWNLOAD_HOST/mobile/$MOBILE_BUNDLE_PREFIX-$version.enc.zip\",
  \"sessionKey\": \"$session_key\",
  \"checksum\": \"$checksum\"
}
MEOF
			chown $SERVICE_USER:$SERVICE_USER mobile-update.json"
		local check seen_version
		check="$(remote_body "$entry" "$API_HOST" /api/mobile-updates/check)"
		seen_version="$(printf '%s' "$check" | grep -oE '"version":[[:space:]]*"[^"]*"' | head -1 | grep -oE '[0-9][0-9.]*' | head -1)"
		if [ "$seen_version" = "$version" ]; then
			echo "PASS  $label OTA endpoint reports $seen_version"
		else
			echo "FAIL  $label OTA endpoint reports '$seen_version', expected $version"
			FAILED+=("$label:mobile")
		fi
		local bundle_code
		bundle_code="$(remote_code "$entry" "$DOWNLOAD_HOST" "/mobile/$MOBILE_BUNDLE_PREFIX-$version.enc.zip")"
		[ "$bundle_code" = "200" ] && echo "PASS  $label bundle downloadable" \
			|| { echo "FAIL  $label bundle -> HTTP $bundle_code"; FAILED+=("$label:mobile-bundle"); }
	done
}

# Build the two updater manifests LOCALLY, then ship them as files.
#
# They used to be written by remote heredocs with UNQUOTED delimiters
# (`<<JEOF`, `<<VEOF`) whose bodies interpolated $notes — the release-notes
# string taken straight off the command line. An unquoted delimiter means the
# REMOTE shell performs command substitution on the body, and hosts.conf wires
# every host as root@… , so `$(...)` or a stray backtick anywhere in a changelog
# line executed as root on every production box. No attacker required: a normal
# note like "fixed `useEffect` ordering" was enough. (cmd_mobile had it right all
# along with <<'MEOF'.)
#
# Quoting the delimiters would stop the execution but still emit invalid JSON for
# any note containing a quote, backslash or newline, so the manifests are built
# here instead — values passed through the ENVIRONMENT, never interpolated into
# the generator's source, and serialised by json.dump which escapes correctly by
# construction.
write_installer_manifests() {
	local out_latest="$1" out_appver="$2" version="$3" notes="$4" pub_date="$5" sig="$6"
	local py; py="$(command -v python3 || command -v python || true)"
	[ -n "$py" ] || { echo "REFUSING to ship: python3 (or python) is required to build the updater manifests" >&2; exit 1; }
	OUT_LATEST="$out_latest" OUT_APPVER="$out_appver" \
	VERSION="$version" NOTES="$notes" PUB_DATE="$pub_date" SIG="$sig" \
	DL_HOST="$DOWNLOAD_HOST" INSTALLER="$INSTALLER_NAME" \
	"$py" -c '
import json, os
e = os.environ
with open(e["OUT_LATEST"], "w") as f:
    json.dump({
        "version": e["VERSION"],
        "notes": e["NOTES"],
        "pub_date": e["PUB_DATE"],
        "platforms": {"windows-x86_64": {
            "signature": e["SIG"],
            "url": "https://%s/%s" % (e["DL_HOST"], e["INSTALLER"]),
        }},
    }, f, indent=2)
with open(e["OUT_APPVER"], "w") as f:
    json.dump({
        "version": e["VERSION"],
        "download_url": "https://%s" % e["DL_HOST"],
        "notes": e["NOTES"],
    }, f, indent=2)
'
}

cmd_installer() {
	local exe="${1:?setup.exe}" sig_file="${2:?sig file}" version="${3:?version}" notes="${4:?notes}"
	local sig; sig="$(cat "$sig_file")"
	local local_sha; local_sha="$(sha256sum "$exe" | cut -d' ' -f1)"
	local pub_date; pub_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	local tmp_latest tmp_appver
	tmp_latest="$(mktemp)"; tmp_appver="$(mktemp)"
	write_installer_manifests "$tmp_latest" "$tmp_appver" "$version" "$notes" "$pub_date" "$sig"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== installer $version -> $label ==="
		scp_to "$entry" "$exe" "${entry#*:}:/tmp/Puca-Setup-dual.exe"
		scp_to "$entry" "$tmp_latest" "${entry#*:}:/tmp/latest-dual.json"
		scp_to "$entry" "$tmp_appver" "${entry#*:}:/tmp/app-version-dual.json"
		ssh_to "$entry" "set -e
			cd $INSTALL_DIR/downloads
			[ -f $INSTALLER_NAME ] && cp -a $INSTALLER_NAME $INSTALLER_NAME.bak-dual-\$(date +%Y%m%d-%H%M%S)
			[ -f latest.json ] && cp -a latest.json latest.json.bak-dual-\$(date +%Y%m%d-%H%M%S)
			mv /tmp/Puca-Setup-dual.exe $INSTALLER_NAME
			chmod 644 $INSTALLER_NAME
			mv /tmp/latest-dual.json latest.json
			chmod 644 latest.json
			mv /tmp/app-version-dual.json $INSTALL_DIR/app-version.json
			chmod 644 $INSTALL_DIR/app-version.json"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -sk --resolve $DOWNLOAD_HOST:443:127.0.0.1 https://$DOWNLOAD_HOST/$INSTALLER_NAME --max-time 120 | sha256sum | cut -d' ' -f1")"
		if [ "$served_sha" = "$local_sha" ]; then
			echo "PASS  $label installer hash matches"
		else
			echo "FAIL  $label installer hash mismatch"
			FAILED+=("$label:installer")
		fi
	done
	rm -f "$tmp_latest" "$tmp_appver"
}

# Refuse to ship a backend whose migration BYTES don't match what a target
# database already recorded. sqlx checksums the embedded migration files and
# compares them against _sqlx_migrations at startup; a mismatch panics
# (VersionMismatch) and the service crash-loops. This exact failure took the
# primary down on 2026-08-03: the tarball was built from a FRESH worktree
# checkout, which materialises uniform CRLF — but prod's recorded byte history
# is MIXED (migrations 1-13 applied from CRLF bytes, 14+ from LF), so versions
# 14+ mismatched and the primary crash-looped until a binary rollback. Only a tree
# that byte-matches every host's recorded checksums may ship; this makes that
# a hard gate instead of tribal knowledge (see .gitattributes for the history).
verify_migrations_against() {
	local entry="$1" tarball="$2"
	local label; label="$(label_of "$entry")"
	local tmp; tmp="$(mktemp -d)"
	tar xzf "$tarball" -C "$tmp" migrations
	local recorded
	recorded="$(ssh_to "$entry" "sudo -u postgres psql -d $DB_NAME -t -A -c \"SELECT version, encode(checksum,'hex') FROM _sqlx_migrations ORDER BY version\"")"
	local fails=0 ver sum f local_sum
	while IFS='|' read -r ver sum; do
		[ -n "$ver" ] || continue
		f="$(ls "$tmp"/migrations/"$(printf '%03d' "$ver")"_*.sql 2>/dev/null | head -1)"
		if [ -z "$f" ]; then
			echo "FAIL  $label: no migration file for applied version $ver in the tarball"
			fails=1
			continue
		fi
		local_sum="$(sha384sum "$f" | cut -d' ' -f1)"
		if [ "$local_sum" != "$sum" ]; then
			echo "FAIL  $label: migration v$ver ($(basename "$f")) does not byte-match this host's database (line endings?)"
			fails=1
		fi
	done <<< "$recorded"
	rm -rf "$tmp"
	return "$fails"
}

cmd_backend() {
	local src_tarball="${1:?src tarball}"
	local primary="${HOSTS[0]}"
	local primary_label; primary_label="$(label_of "$primary")"

	echo "=== pre-flight: migration checksums vs every host's database ==="
	local preflight_failed=0
	for entry in "${HOSTS[@]}"; do
		if verify_migrations_against "$entry" "$src_tarball"; then
			echo "PASS  $(label_of "$entry") migrations byte-match"
		else
			preflight_failed=1
		fi
	done
	if [ "$preflight_failed" -ne 0 ]; then
		echo "REFUSING to ship: the backend would crash-loop on VersionMismatch at startup."
		echo "Build the tarball from a tree whose migrations byte-match production"
		echo "(the long-lived main checkout — NOT a fresh clone/worktree, which"
		echo "re-materialises line endings)."
		exit 1
	fi

	echo "=== building ONCE on $primary_label, then copying the binary ==="
	echo "    (verified identical OS/glibc/arch across every host in hosts.conf —"
	echo "     re-check that assumption before trusting this if a host ever changes.)"
	scp_to "$primary" "$src_tarball" "${primary#*:}:/root/dual-src.tar.gz"
	ssh_to "$primary" 'set -e
		rm -rf /root/dual-build && mkdir -p /root/dual-build && cd /root/dual-build
		tar xzf /root/dual-src.tar.gz --no-same-owner --touch
		find . -exec touch {} +
		export PATH=/root/.cargo/bin:$PATH
		time cargo build --release'

	local built="/tmp/puca-dual-bin"
	rm -f "$built"
	scp "${SSH_OPTS[@]}" "${primary#*:}:/root/dual-build/target/release/puca" "$built"
	local bin_sha; bin_sha="$(sha256sum "$built" | cut -d' ' -f1)"
	echo "binary sha256: $bin_sha"

	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== installing backend -> $label ==="
		scp_to "$entry" "$built" "${entry#*:}:/tmp/puca-dual-bin"
		ssh_to "$entry" 'set -e
			install -o '"$SERVICE_USER"' -g '"$SERVICE_USER"' -m 755 /tmp/puca-dual-bin '"$INSTALL_DIR/$SERVICE_NAME"'
			rm -f /tmp/puca-dual-bin
			systemctl restart '"$SERVICE_NAME"'
			sleep 4
			systemctl is-active '"$SERVICE_NAME"
		# IDENTITY, not just liveness. `GET /` returns the constant
		# "Puca Backend Online" (src/main.rs), compiled into every build ever
		# shipped — so grepping it proves only that SOME puca is answering. It
		# passes just as happily when `install` wrote to the wrong path, when the
		# restart silently failed and the OLD process is still serving, or when
		# the binary copied from the primary never landed. The webapp and
		# installer paths above both compare hashes; this one is the only artifact
		# built remotely and copied host-to-host, so it needs it most.
		#
		# Three checks, each catching a different half-failure:
		#   1. the installed FILE is byte-identical to what we built and verified;
		#   2. the unit is actually active;
		#   3. the RUNNING process is executing that file — `install` replaces the
		#      inode, so a process that never restarted still points at the old,
		#      now-unlinked one and /proc/PID/exe reads "… (deleted)". That is the
		#      exact signature of "new binary on disk, old binary serving", which
		#      checks 1 and 2 both pass.
		local remote_state installed_sha unit_active exe_path
		remote_state="$(ssh_to "$entry" "
			sha256sum '$INSTALL_DIR/$SERVICE_NAME' | cut -d' ' -f1
			systemctl is-active '$SERVICE_NAME' || true
			readlink /proc/\$(systemctl show -p MainPID --value '$SERVICE_NAME')/exe 2>/dev/null || echo UNKNOWN
		")"
		installed_sha="$(printf '%s\n' "$remote_state" | sed -n 1p)"
		unit_active="$(printf '%s\n' "$remote_state" | sed -n 2p)"
		exe_path="$(printf '%s\n' "$remote_state" | sed -n 3p)"

		if [ "$installed_sha" != "$bin_sha" ]; then
			echo "FAIL  $label installed binary sha256 $installed_sha != built $bin_sha"
			FAILED+=("$label:backend")
		elif [ "$unit_active" != "active" ]; then
			echo "FAIL  $label $SERVICE_NAME is '$unit_active', not active"
			FAILED+=("$label:backend")
		elif [ "$exe_path" != "$INSTALL_DIR/$SERVICE_NAME" ]; then
			# "(deleted)" suffix, UNKNOWN, or a different path all mean the live
			# process is not the binary we just installed.
			echo "FAIL  $label running process is not the installed binary (/proc exe -> '$exe_path')"
			FAILED+=("$label:backend")
		else
			local health
			health="$(remote_body "$entry" "$API_HOST" /)"
			if printf '%s' "$health" | grep -q "Backend Online"; then
				echo "PASS  $label backend healthy (sha256 matches, running the installed binary)"
			else
				echo "FAIL  $label backend did not respond as expected: $health"
				FAILED+=("$label:backend")
			fi
		fi
	done
	rm -f "$built"
}

# A new APK is only reachable through the download page, whose Android link is
# hand-written HTML — the file without the link (or the link without the file)
# strands users on whatever the page last pointed at. It said 0.5.56 across six
# releases of OTAs. So the page and the APK ship TOGETHER, and shipping refuses
# to start until the page in this checkout actually links the version being
# shipped.
cmd_apk() {
	local apk="${1:?usage: dual-ship.sh apk <APK> <version>}" version="${2:?version}"
	# Prefer an untracked local page when one exists. The TRACKED page is a
	# generic template that names example.com — shipping it to a real download
	# host would tell your users to connect to a domain that is not yours, and
	# it is the one artefact here whose content end users actually read.
	local page="$HERE/../download-site/index.html"
	[ -f "$HERE/../download-site/index.local.html" ] && page="$HERE/../download-site/index.local.html"
	if ! grep -q "$APK_PREFIX-$version.apk" "$page"; then
		echo "REFUSING: $page does not link $APK_PREFIX-$version.apk."
		echo "Update the Android href + the version label there first — the page and the APK ship together."
		exit 1
	fi
	local local_sha; local_sha="$(sha256sum "$apk" | cut -d' ' -f1)"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== apk $version -> $label ==="
		scp_to "$entry" "$apk" "${entry#*:}:$INSTALL_DIR/downloads/mobile/$APK_PREFIX-$version.apk"
		scp_to "$entry" "$page" "${entry#*:}:$INSTALL_DIR/downloads/index.html"
		ssh_to "$entry" "chmod 644 $INSTALL_DIR/downloads/mobile/$APK_PREFIX-$version.apk $INSTALL_DIR/downloads/index.html"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -sk --resolve $DOWNLOAD_HOST:443:127.0.0.1 'https://$DOWNLOAD_HOST/mobile/$APK_PREFIX-$version.apk' --max-time 120 | sha256sum | cut -d' ' -f1")"
		if [ "$served_sha" = "$local_sha" ]; then
			echo "PASS  $label apk hash matches"
		else
			echo "FAIL  $label apk hash mismatch"
			FAILED+=("$label:apk")
		fi
		local page_links
		page_links="$(remote_body "$entry" "$DOWNLOAD_HOST" / | grep -c "$APK_PREFIX-$version.apk" || true)"
		if [ "${page_links:-0}" -gt 0 ]; then
			echo "PASS  $label download page links the new APK"
		else
			echo "FAIL  $label download page does not link $APK_PREFIX-$version.apk"
			FAILED+=("$label:apk-page")
		fi
	done
}

main() {
	local sub="${1:-}"; shift || true
	case "$sub" in
		webapp)    cmd_webapp "$@" ;;
		mobile)    cmd_mobile "$@" ;;
		installer) cmd_installer "$@" ;;
		backend)   cmd_backend "$@" ;;
		apk)       cmd_apk "$@" ;;
		*) echo "usage: dual-ship.sh {webapp|mobile|installer|backend|apk} ..." >&2; exit 2 ;;
	esac

	# Independent of what was shipped: confirm each host identifies as itself,
	# and report which one the PUBLIC domain currently resolves to. The second
	# line is the answer to "is the app talking to the new box?".
	echo
	echo "=== host identity ==="
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		local seen; seen="$(remote_host_label "$entry" || true)"
		if [ "$seen" = "$label" ]; then
			echo "PASS  $label self-identifies correctly"
		else
			echo "FAIL  $label reports $HOST_HEADER '${seen:-<none>}'"
			FAILED+=("$label:identity")
		fi
	done
	# Double quotes, NOT single: inside $( ) the quoting restarts, so a
	# single-quoted '^$HOST_HEADER:' greps for that literal string and always
	# reports <unknown>. Line 77's copy sits inside an outer double-quoted
	# string, where the same single quotes are literal and the variable DOES
	# expand -- the two forms are not interchangeable.
	local live; live="$(curl -sI https://$API_HOST/ --max-time 20 2>/dev/null | grep -i "^$HOST_HEADER:" | cut -d' ' -f2- | tr -d '\r\n' || true)"
	echo "LIVE  $API_HOST is currently served by: ${live:-<unknown>}"

	echo
	if [ "${#FAILED[@]}" -eq 0 ]; then
		echo "ALL HOSTS CONFIRMED."
	else
		echo "FAILED on: ${FAILED[*]}"
		echo "Do NOT consider this release shipped until every host is fixed and re-verified —"
		echo "a host silently left behind is exactly the stale-rollback problem this script exists to prevent."
		exit 1
	fi
}

main "$@"
