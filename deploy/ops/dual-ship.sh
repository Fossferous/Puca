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
#   dual-ship.sh webapp        <dist-tarball.tar.gz>
#   dual-ship.sh mobile        <enc-bundle.zip> <version> <sessionKey> <checksum>
#   dual-ship.sh mobile-lite   <enc-bundle.zip> <version> <sessionKey> <checksum>
#   dual-ship.sh installer     <setup.exe> <sig-file> <version> <notes>
#   dual-ship.sh installer-lite <setup.exe> <sig-file> <version> <notes>
#   dual-ship.sh backend       <src-tarball.tar.gz>
#   dual-ship.sh apk           <Puca-x.y.z.apk> <version>
#   dual-ship.sh apk-lite      <Puca-Lite-x.y.z.apk> <version>
#
# The *-lite subcommands ship the build with NO remote control (see
# CLAUDE.md's "Lite variant" section) ALONGSIDE the corresponding full one —
# under INSTALLER_NAME_LITE / APK_PREFIX_LITE / MOBILE_BUNDLE_PREFIX_LITE, a
# separate latest-lite.json / mobile-update-lite.json — never overwriting the
# full artifact. There is no lite webapp or lite backend: both are shared
# unconditionally; only the desktop installer and the two mobile channels
# differ between the variants. A release that ships lite always ships full
# too — full is not lite's dependency, but every release described in
# CLAUDE.md's Deploying section produces both, and shipping one without the
# other just means half your users are one version behind.
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
# TLS on the loopback self-checks: `-k` unless hosts.conf pins a CA.
#
# Every self-check below is `curl --resolve <host>:443:127.0.0.1` run over SSH
# ON the target box, against that box's own Caddy. `-k` is load-bearing rather
# than lazy: a deployment fronted by Cloudflare serves an Origin CA certificate
# on the origin, and that CA is deliberately not in any system trust store — so
# dropping the flag outright would fail every check on every host.
#
# What that means for a reader, spelled out because nothing here used to say it:
# the trust boundary on these checks is the SSH SESSION, not TLS. The connection
# never leaves the box's loopback interface, and the property the checks
# actually establish is a sha256 of the served bytes against the local artifact,
# which TLS was not providing anyway. Do not copy `-k` into a check that runs
# over a network — the CDN verification in verify_cdn_exe runs from the
# operator's machine and correctly does NOT use it.
#
# Set ORIGIN_CA in hosts.conf (see hosts.conf.example) to a CA bundle present on
# every host and these checks verify the certificate instead. The negative
# control for that pin is trivial and worth running once: point ORIGIN_CA at an
# unrelated CA and confirm the checks FAIL. If they still pass, the pin is doing
# nothing.
if [ -n "${ORIGIN_CA:-}" ]; then
	CURL_TLS="--cacert '$ORIGIN_CA'"
else
	CURL_TLS="-k"
fi


# label:target -> just the label, for readable output.
label_of() { echo "${1%%:*}"; }

# The download page to publish with whatever we are shipping.
#
# Prefer an untracked local page when one exists. The TRACKED page is a generic
# template that names example.com — shipping it to a real download host would
# tell your users to connect to a domain that is not yours, and it is the one
# artefact here whose content end users actually read. (.gitignore covers
# index.local.html.)
download_page() {
	if [ -f "$HERE/../download-site/index.local.html" ]; then
		printf '%s' "$HERE/../download-site/index.local.html"
	else
		printf '%s' "$HERE/../download-site/index.html"
	fi
}

# Refuse to ship an artifact the page does not advertise.
#
# The APK gate has existed since the page sat on 0.5.56 through six releases of
# OTAs. The installer had no such gate, and the page's own comment conceded it:
# "the installer link is not, so keep it in step by hand." So a Windows-only
# release published a new installer while the live page kept advertising the
# previous version number — the identical failure, in the other column. Both
# facts are checked: the exact installer filename being uploaded, and the
# version label a human reads before clicking it.
#
# grep -F for the filename: a version is full of dots and `0.8.136` as a REGEX
# also matches `0X8Y136`. The version label needs a real regex, though — a plain
# substring test for "v0.8.13" MATCHES a page that says "v0.8.136", so shipping
# an older build past a newer page would sail through the gate that exists to
# stop exactly that. version_on_page pins both ends.
require_page_advertises() {
	local page="$1" version="$2" artifact="$3" what="$4"
	if ! grep -qF "$artifact" "$page"; then
		echo "REFUSING: $page does not link $artifact."
		echo "Update the $what href there first — the page and the artifact ship together."
		exit 1
	fi
	if ! version_on_page "$(cat "$page")" "$version"; then
		echo "REFUSING: $page does not name v$version."
		echo "Update the version label (the .meta line) there first, or the live page keeps"
		echo "advertising the previous release to everyone who visits it."
		exit 1
	fi
}

# Does this text name exactly v<version>, not a longer version that starts with
# it? `v0.8.13` must not match `v0.8.136`. The dots are escaped so they are not
# regex wildcards, and the match must end at a character that cannot continue a
# version number.
version_on_page() {
	local text="$1" version="$2" escaped
	escaped="${version//./\\.}"
	# grep -c, never -q: -q exits at the first match and SIGPIPEs the writer,
	# which under `pipefail` reads as a failed pipeline.
	[ "$(printf '%s\n' "$text" | grep -cE "v${escaped}([^0-9.]|\$)" || true)" -gt 0 ]
}

# Publish the page alongside the artifact, and confirm the LIVE page names the
# version — the served page, not the file we uploaded, because a correct file
# in the wrong place looks identical to a successful deploy.
ship_download_page() {
	local entry="$1" page="$2" version="$3" label="$4" tag="$5"
	scp_to "$entry" "$page" "${entry#*:}:$INSTALL_DIR/downloads/index.html"
	ssh_to "$entry" "chmod 644 $INSTALL_DIR/downloads/index.html"
	local served
	served="$(remote_body "$entry" "$DOWNLOAD_HOST" / || true)"
	if version_on_page "$served" "$version"; then
		echo "PASS  $label download page advertises v$version"
	else
		echo "FAIL  $label download page does not name v$version"
		FAILED+=("$label:$tag-page")
	fi
}

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
	ssh_to "$entry" "curl -s $CURL_TLS --resolve '${host}:443:127.0.0.1' 'https://${host}${path}' --max-time 20"
}
# Confirms the box we just shipped to is the one whose Caddy answers, by
# reading the $HOST_HEADER label it sets on itself. Catches a host whose
# Caddy is serving a DIFFERENT vhost config than expected.
remote_host_label() {
	local entry="$1"
	ssh_to "$entry" "curl -s $CURL_TLS -I --resolve '$API_HOST:443:127.0.0.1' https://$API_HOST/ --max-time 20 \
		| grep -i '^$HOST_HEADER:' | cut -d' ' -f2- | tr -d '\r\n'"
}
# The one property `-k` throws away: WHICH certificate the box is serving.
#
# The self-checks deliberately skip verification (see the CURL_TLS block), so
# nothing else here would notice a host answering on 443 with a certificate for
# somebody else's name — a stray vhost, a half-finished migration, a box that
# was re-imaged and picked up a default. This asserts the name without needing
# the issuing CA in a trust store, which is exactly the gap.
#
# A wildcard is accepted, because that is what a Cloudflare Origin CA
# certificate normally carries: `example.com, *.example.com` covers
# `chat.example.com` and matching only the exact name would fail every
# perfectly healthy host of that shape.
remote_cert_names() {
	local entry="$1" host="$2"
	ssh_to "$entry" "command -v openssl >/dev/null 2>&1 || exit 3
		echo | openssl s_client -connect 127.0.0.1:443 -servername '$host' 2>/dev/null \
			| openssl x509 -noout -subject -ext subjectAltName 2>/dev/null"
}

remote_code() {
	local entry="$1" host="$2" path="$3"
	ssh_to "$entry" "curl -s $CURL_TLS -o /dev/null -w '%{http_code}' --resolve '${host}:443:127.0.0.1' 'https://${host}${path}' --max-time 20"
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
			JS=$(curl -s '"$CURL_TLS"' --resolve '"$APP_HOST"':443:127.0.0.1 https://'"$APP_HOST"'/ --max-time 20 \
				| grep -oE "assets/index-[A-Za-z0-9_-]+\.js" | head -1)
			curl -s '"$CURL_TLS"' --resolve '"$APP_HOST"':443:127.0.0.1 "https://'"$APP_HOST"'/$JS" --max-time 20 | sha256sum | cut -d" " -f1
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
  \"checksum\": \"$checksum\",
  \"variant\": \"full\"
}
MEOF
			chown $SERVICE_USER:$SERVICE_USER mobile-update.json"
		local check seen_version
		check="$(remote_body "$entry" "$API_HOST" /api/mobile-updates/check)"
		seen_version="$(printf '%s' "$check" | grep -oE '"version":[[:space:]]*"[^"]*"' | head -1 | grep -oE '[0-9][0-9.]*' | head -1 || true)"
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

# Same shape as cmd_mobile, for the build with no remote control. Writes a
# SEPARATE manifest (mobile-update-lite.json) that only
# GET /api/mobile-updates/check?variant=lite serves — see
# src/update_routes.rs. Never touches mobile-update.json or the full bundle,
# so running this alone cannot regress an existing full install.
#
# The "variant":"lite" field in the manifest is what the app's own
# bundleVariantMatches (frontend/src/components/updateGate.utils.ts) checks
# before installing ANY downloaded bundle — belt and braces on top of the
# endpoint split: even a manifest served from the wrong file, or copy-pasted
# by hand, still gets refused client-side if the tag doesn't match the build
# that's asking.
cmd_mobile_lite() {
	local bundle="${1:?enc bundle}" version="${2:?version}" session_key="${3:?sessionKey}" checksum="${4:?checksum}"
	[ "${#session_key}" -eq 369 ] || { echo "REFUSING: sessionKey is ${#session_key} chars, expected 369"; exit 1; }
	[ "${#checksum}" -eq 512 ] || { echo "REFUSING: checksum is ${#checksum} chars, expected 512"; exit 1; }
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== mobile OTA (lite) $version -> $label ==="
		# Snapshot the FULL endpoint before touching anything, so "the full
		# channel was not disturbed" can be PROVEN by comparison afterwards.
		# The first version of this check accepted any 200-or-404 answer —
		# and 404 is exactly what a deleted full manifest produces, so it
		# could not detect the one regression it existed to rule out.
		local full_before full_after
		full_before="$(remote_code "$entry" "$API_HOST" /api/mobile-updates/check):$(remote_body "$entry" "$API_HOST" /api/mobile-updates/check)"
		scp_to "$entry" "$bundle" "${entry#*:}:$INSTALL_DIR/downloads/mobile/$MOBILE_BUNDLE_PREFIX_LITE-$version.enc.zip"
		ssh_to "$entry" "set -e
			cd $INSTALL_DIR
			[ -f mobile-update-lite.json ] && cp -a mobile-update-lite.json mobile-update-lite.json.bak-dual-\$(date +%Y%m%d-%H%M%S)
			cat > mobile-update-lite.json <<'MEOF'
{
  \"version\": \"$version\",
  \"url\": \"https://$DOWNLOAD_HOST/mobile/$MOBILE_BUNDLE_PREFIX_LITE-$version.enc.zip\",
  \"sessionKey\": \"$session_key\",
  \"checksum\": \"$checksum\",
  \"variant\": \"lite\"
}
MEOF
			chown $SERVICE_USER:$SERVICE_USER mobile-update-lite.json"
		local check seen_version tag_hits
		check="$(remote_body "$entry" "$API_HOST" "/api/mobile-updates/check?variant=lite")"
		seen_version="$(printf '%s' "$check" | grep -oE '"version":[[:space:]]*"[^"]*"' | head -1 | grep -oE '[0-9][0-9.]*' | head -1 || true)"
		# The version alone cannot prove the LITE manifest answered: both
		# variants ship the same version number, so a backend that predates
		# the variant-aware route ignores the query param, serves the FULL
		# manifest, and still matches on version — a false PASS while every
		# lite phone silently stops updating (the client refuses a full
		# manifest, fail-closed, and is then never offered anything else).
		# The variant tag is the only discriminator, so demand it.
		# grep -c, not -q: -q SIGPIPEs the writer under pipefail (see the
		# webapp preflight above for the history).
		tag_hits="$(printf '%s' "$check" | grep -cE '"variant"[[:space:]]*:[[:space:]]*"lite"' || true)"
		if [ "$seen_version" != "$version" ]; then
			echo "FAIL  $label lite OTA endpoint reports '$seen_version', expected $version"
			FAILED+=("$label:mobile-lite")
		elif [ "${tag_hits:-0}" -eq 0 ]; then
			echo "FAIL  $label ?variant=lite answered version $seen_version WITHOUT \"variant\":\"lite\" —"
			echo "      this host's backend predates the variant-aware route and is serving the FULL"
			echo "      manifest on the lite channel. Ship the backend here, then re-run mobile-lite."
			FAILED+=("$label:mobile-lite-variant")
		else
			echo "PASS  $label lite OTA endpoint reports $seen_version with variant:lite"
		fi
		# Confirm the FULL endpoint was NOT disturbed by this ship — the two
		# manifests live in different files specifically so one can never
		# clobber the other, and comparing the endpoint's answer before vs
		# after is what actually proves that in practice, rather than by
		# inspecting the code. (Status-only checks cannot: a deleted full
		# manifest and a never-shipped one both answer 404.)
		full_after="$(remote_code "$entry" "$API_HOST" /api/mobile-updates/check):$(remote_body "$entry" "$API_HOST" /api/mobile-updates/check)"
		if [ "$full_after" = "$full_before" ]; then
			echo "PASS  $label full OTA endpoint undisturbed"
		else
			echo "FAIL  $label full OTA endpoint CHANGED during a lite ship (HTTP ${full_before%%:*} -> ${full_after%%:*}; bodies compared)"
			FAILED+=("$label:mobile-lite-isolation")
		fi
		local bundle_code
		bundle_code="$(remote_code "$entry" "$DOWNLOAD_HOST" "/mobile/$MOBILE_BUNDLE_PREFIX_LITE-$version.enc.zip")"
		[ "$bundle_code" = "200" ] && echo "PASS  $label lite bundle downloadable" \
			|| { echo "FAIL  $label lite bundle -> HTTP $bundle_code"; FAILED+=("$label:mobile-lite-bundle"); }
	done
}

# Build an updater manifest LOCALLY, as a file, and ship it. Never build one
# with a heredoc inside an ssh command string.
#
# WHY. Both installer paths used to do:
#     ssh_to "$entry" "... cat > latest.json <<JEOF
#     { \"notes\": \"$notes\", ... }
#     JEOF"
# The delimiter was UNQUOTED (contrast the mobile paths, which correctly use
# <<'MEOF'), and the whole body sat inside a double-quoted string handed to
# ssh. So the body was expanded TWICE: once here, and again by the REMOTE
# shell — running as root, on every host. A release-notes string containing a
# backtick or $( ) therefore executed as root everywhere. That is not an
# exotic input: it is what an ordinary changelog line looks like the first
# time someone writes "fixed `useEffect` ordering" or "bumped $PATH handling".
# The notes string comes straight from argv, so this was reachable by anyone
# who could talk the operator into shipping their changelog text.
#
# json.dump also fixes a second, quieter bug in the same lines: the heredoc
# pasted $notes between two literal quotes with no escaping, so a notes string
# containing a double quote, a backslash or a newline silently produced a
# manifest no client could parse — a release that looks successful here and
# breaks every updater.
#
# Values travel through the ENVIRONMENT, so nothing is re-parsed as shell.
#
# Pick an interpreter that actually RUNS, not merely one that is on PATH:
# Windows ships a `python3` App-Execution-Alias stub in WindowsApps that
# resolves to a real path, satisfies `command -v`, and then exits with
# "Python was not found" the moment you use it. Probing with -c is the only
# check that distinguishes the stub from an interpreter.
PY=""
for _cand in python3 python py; do
	if command -v "$_cand" >/dev/null 2>&1 && "$_cand" -c '' >/dev/null 2>&1; then
		PY="$_cand"; break
	fi
done
if [ -z "$PY" ]; then
	echo "REFUSING: no working python found (tried python3, python, py)." >&2
	echo "It is needed to build the updater manifests safely." >&2
	exit 1
fi

# Hand the interpreter a path IT understands.
#
# On Git Bash/MSYS — how this script is normally run — the shell's /tmp is
# %LOCALAPPDATA%\Temp, but a native Windows python resolves the same "/tmp/x"
# string to C:\tmp\x, a different directory that often exists. So `mktemp`
# followed by a python write followed by `scp` silently ships a MISSING or
# STALE manifest: the shell and the interpreter are looking at two different
# files, and nothing errors. Command-line arguments get mangled into Windows
# form by MSYS automatically; values passed through the ENVIRONMENT (which is
# what makes this injection-proof) do not, so translate explicitly.
# cygpath is absent on Linux/macOS, where the path is already native.
to_native_path() {
	if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
build_installer_manifest() {
	local out="$1" version="$2" notes="$3" pub_date="$4" sig="$5" url="$6"
	PUCA_OUT="$(to_native_path "$out")" PUCA_VERSION="$version" PUCA_NOTES="$notes" \
	PUCA_PUB_DATE="$pub_date" PUCA_SIG="$sig" PUCA_URL="$url" \
	"$PY" -c '
import json, os
m = {
    "version": os.environ["PUCA_VERSION"],
    "notes": os.environ["PUCA_NOTES"],
    "pub_date": os.environ["PUCA_PUB_DATE"],
    "platforms": {"windows-x86_64": {
        "signature": os.environ["PUCA_SIG"],
        "url": os.environ["PUCA_URL"],
    }},
}
with open(os.environ["PUCA_OUT"], "w", encoding="utf-8", newline="\n") as f:
    json.dump(m, f, indent=2)
'
}

# Same, for the plain app-version.json the in-app banner reads.
build_app_version_json() {
	local out="$1" version="$2" notes="$3" download_url="$4"
	PUCA_OUT="$(to_native_path "$out")" PUCA_VERSION="$version" PUCA_NOTES="$notes" PUCA_DL="$download_url" \
	"$PY" -c '
import json, os
m = {
    "version": os.environ["PUCA_VERSION"],
    "download_url": os.environ["PUCA_DL"],
    "notes": os.environ["PUCA_NOTES"],
}
with open(os.environ["PUCA_OUT"], "w", encoding="utf-8", newline="\n") as f:
    json.dump(m, f, indent=2)
'
}

cmd_installer() {
	local exe="${1:?setup.exe}" sig_file="${2:?sig file}" version="${3:?version}" notes="${4:?notes}"
	# The page ships with the installer, and refuses first — same rule the APK
	# has had since 0.5.56 sat on the page through six releases. The installer
	# href carries no version, so BOTH facts are checked: the filename it links
	# and the version label a human reads next to it.
	local page; page="$(download_page)"
	require_page_advertises "$page" "$version" "$INSTALLER_NAME" "Windows"
	local sig; sig="$(cat "$sig_file")"
	local local_sha; local_sha="$(sha256sum "$exe" | cut -d' ' -f1)"
	local pub_date; pub_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	# THE UPDATER MANIFEST POINTS AT A VERSIONED NAME, NEVER THE STABLE ONE.
	#
	# Cloudflare caches .exe at the edge (measured: Cache-Control max-age=14400,
	# a 4-hour TTL) while latest.json is no-store — so after a release, a
	# client's fresh manifest carried the NEW signature while the stable
	# $INSTALLER_NAME URL still served the PREVIOUS release's bytes from the
	# edge. Signature verification then fails on every retry until the TTL
	# expires — surfaced to users as "This update could not be installed", and
	# invisible to this script because its per-host verification deliberately
	# runs over loopback, which bypasses the CDN entirely (a machine sat
	# unupdatable on 0.8.117 for exactly this on 2026-08-31). A versioned URL
	# has never been fetched before a release exists, so it can never be
	# stale. The stable name is still uploaded — it is what the download page
	# links for humans, where an edge-TTL of staleness is tolerable.
	local versioned="${INSTALLER_NAME%.exe}-$version.exe"
	local tmp_latest tmp_appver
	tmp_latest="$(mktemp)"; tmp_appver="$(mktemp)"
	build_installer_manifest "$tmp_latest" "$version" "$notes" "$pub_date" "$sig" \
		"https://$DOWNLOAD_HOST/$versioned"
	build_app_version_json "$tmp_appver" "$version" "$notes" "https://$DOWNLOAD_HOST"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== installer $version -> $label ==="
		scp_to "$entry" "$exe" "${entry#*:}:/tmp/Puca-Setup-dual.exe"
		scp_to "$entry" "$tmp_latest" "${entry#*:}:/tmp/puca-latest-dual.json"
		scp_to "$entry" "$tmp_appver" "${entry#*:}:/tmp/puca-appver-dual.json"
		ssh_to "$entry" "set -e
			cd $INSTALL_DIR/downloads
			[ -f $INSTALLER_NAME ] && cp -a $INSTALLER_NAME $INSTALLER_NAME.bak-dual-\$(date +%Y%m%d-%H%M%S)
			[ -f latest.json ] && cp -a latest.json latest.json.bak-dual-\$(date +%Y%m%d-%H%M%S)
			cp /tmp/Puca-Setup-dual.exe $versioned
			mv /tmp/Puca-Setup-dual.exe $INSTALLER_NAME
			chmod 644 $INSTALLER_NAME $versioned
			mv /tmp/puca-latest-dual.json latest.json
			mv /tmp/puca-appver-dual.json $INSTALL_DIR/app-version.json
			chmod 644 latest.json $INSTALL_DIR/app-version.json"
		ship_download_page "$entry" "$page" "$version" "$label" "installer"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -s $CURL_TLS --resolve $DOWNLOAD_HOST:443:127.0.0.1 https://$DOWNLOAD_HOST/$INSTALLER_NAME --max-time 120 | sha256sum | cut -d' ' -f1")"
		if [ "$served_sha" = "$local_sha" ]; then
			echo "PASS  $label installer hash matches"
		else
			echo "FAIL  $label installer hash mismatch"
			FAILED+=("$label:installer")
		fi
	done
	rm -f "$tmp_latest" "$tmp_appver"
	verify_cdn_exe "$versioned" "$local_sha" "installer" "$INSTALLER_NAME"
}

# Fetch the updater's exe through the CDN — the path CLIENTS actually take —
# and hash-compare. The loopback checks above prove each ORIGIN is right;
# this proves the edge is handing out the same bytes the manifest's
# signature was made for, which is the exact thing that silently broke on
# 2026-08-31. Runs ONCE (the edge is global, not per-host), from this
# machine over normal DNS — that traffic goes THROUGH Cloudflare, so the
# origin lock does not apply to it (only direct-to-origin checks are the
# trap CLAUDE.md warns about). The stable page name is checked too, but only
# WARNS when stale: its edge copy lags by up to the cache TTL by design, and
# a human who grabs the previous installer just auto-updates on first run.
verify_cdn_exe() {
	local versioned="$1" local_sha="$2" tag="$3" stable="$4"
	local cdn_sha
	cdn_sha="$(curl -sL "https://$DOWNLOAD_HOST/$versioned" --max-time 300 | sha256sum | cut -d' ' -f1 || true)"
	if [ "$cdn_sha" != "$local_sha" ]; then
		# One retry after a minute: Cloudflare negative-caches a 404 for a few
		# minutes, so any probe of the versioned URL from before this ship
		# (a curious curl, a client that raced the upload) leaves a brief
		# window where the edge answers with the cached error. Measured live
		# on this check's very first run, 2026-08-31.
		echo "  ...  CDN bytes for $versioned don't match yet (negative-cache window?) — retrying in 60s"
		sleep 60
		cdn_sha="$(curl -sL "https://$DOWNLOAD_HOST/$versioned" --max-time 300 | sha256sum | cut -d' ' -f1 || true)"
	fi
	if [ "$cdn_sha" = "$local_sha" ]; then
		echo "PASS  CDN serves the versioned $tag correctly ($versioned)"
	else
		echo "FAIL  CDN returned wrong bytes for $versioned — the UPDATER url is bad; do not trust this release until this passes"
		FAILED+=("cdn:$tag-versioned")
	fi
	local stable_sha
	stable_sha="$(curl -sL "https://$DOWNLOAD_HOST/$stable" --max-time 300 | sha256sum | cut -d' ' -f1 || true)"
	if [ "$stable_sha" = "$local_sha" ]; then
		echo "PASS  CDN serves the stable page name fresh ($stable)"
	else
		echo "WARN  CDN still serves an older $stable at the edge (expected for up to its cache TTL; page downloads lag, the updater does not)"
	fi
}

# Same shape as cmd_installer, for the build with no remote control. Writes
# latest-lite.json instead of latest.json — the desktop Tauri updater reads
# whichever URL was baked into the binary at build time (tauri.conf.json vs
# tauri.lite.conf.json), so this needs no query-param trick the way mobile
# does; each variant only ever asks for its own manifest.
#
# Deliberately does NOT touch app-version.json: that file drives the
# in-browser fallback download page, is identical for both variants (same
# version number, same notes — see CLAUDE.md), and the frontend already
# appends ?variant=lite itself before opening it (api/appVersion.ts). Writing
# it twice would only risk the two ships disagreeing about its content.
cmd_installer_lite() {
	local exe="${1:?setup.exe}" sig_file="${2:?sig file}" version="${3:?version}" notes="${4:?notes}"
	local page; page="$(download_page)"
	require_page_advertises "$page" "$version" "$INSTALLER_NAME_LITE" "lite Windows"
	local sig; sig="$(cat "$sig_file")"
	local local_sha; local_sha="$(sha256sum "$exe" | cut -d' ' -f1)"
	local pub_date; pub_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	# Versioned updater URL for the same reason as cmd_installer (see its
	# header comment): the stable name can be stale at the CDN edge for its
	# whole cache TTL, and a fresh manifest + stale exe = signature failure
	# on every client until the edge expires.
	local versioned="${INSTALLER_NAME_LITE%.exe}-$version.exe"
	local tmp_latest; tmp_latest="$(mktemp)"
	build_installer_manifest "$tmp_latest" "$version" "$notes" "$pub_date" "$sig" \
		"https://$DOWNLOAD_HOST/$versioned"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== installer (lite) $version -> $label ==="
		scp_to "$entry" "$exe" "${entry#*:}:/tmp/Puca-Lite-Setup-dual.exe"
		scp_to "$entry" "$tmp_latest" "${entry#*:}:/tmp/puca-latest-lite-dual.json"
		ssh_to "$entry" "set -e
			cd $INSTALL_DIR/downloads
			[ -f $INSTALLER_NAME_LITE ] && cp -a $INSTALLER_NAME_LITE $INSTALLER_NAME_LITE.bak-dual-\$(date +%Y%m%d-%H%M%S)
			[ -f latest-lite.json ] && cp -a latest-lite.json latest-lite.json.bak-dual-\$(date +%Y%m%d-%H%M%S)
			cp /tmp/Puca-Lite-Setup-dual.exe $versioned
			mv /tmp/Puca-Lite-Setup-dual.exe $INSTALLER_NAME_LITE
			chmod 644 $INSTALLER_NAME_LITE $versioned
			mv /tmp/puca-latest-lite-dual.json latest-lite.json
			chmod 644 latest-lite.json"
		ship_download_page "$entry" "$page" "$version" "$label" "installer-lite"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -s $CURL_TLS --resolve $DOWNLOAD_HOST:443:127.0.0.1 https://$DOWNLOAD_HOST/$INSTALLER_NAME_LITE --max-time 120 | sha256sum | cut -d' ' -f1")"
		if [ "$served_sha" = "$local_sha" ]; then
			echo "PASS  $label lite installer hash matches"
		else
			echo "FAIL  $label lite installer hash mismatch"
			FAILED+=("$label:installer-lite")
		fi
	done
	rm -f "$tmp_latest"
	verify_cdn_exe "$versioned" "$local_sha" "installer-lite" "$INSTALLER_NAME_LITE"
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
		local health
		health="$(remote_body "$entry" "$API_HOST" /)"
		if printf '%s' "$health" | grep -q "Backend Online"; then
			echo "PASS  $label backend healthy"
		else
			echo "FAIL  $label backend did not respond as expected: $health"
			FAILED+=("$label:backend")
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
	local page; page="$(download_page)"
	if ! grep -qF "$APK_PREFIX-$version.apk" "$page"; then
		echo "REFUSING: $page does not link $APK_PREFIX-$version.apk."
		echo "Update the Android href + the version label there first — the page and the APK ship together."
		exit 1
	fi
	local local_sha; local_sha="$(sha256sum "$apk" | cut -d' ' -f1)"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== apk $version -> $label ==="
		scp_to "$entry" "$apk" "${entry#*:}:$INSTALL_DIR/downloads/mobile/$APK_PREFIX-$version.apk"
		ssh_to "$entry" "chmod 644 $INSTALL_DIR/downloads/mobile/$APK_PREFIX-$version.apk"
		ship_download_page "$entry" "$page" "$version" "$label" "apk"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -s $CURL_TLS --resolve $DOWNLOAD_HOST:443:127.0.0.1 'https://$DOWNLOAD_HOST/mobile/$APK_PREFIX-$version.apk' --max-time 120 | sha256sum | cut -d' ' -f1")"
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

# Same shape as cmd_apk, for the build with no remote control. Same
# page-must-already-link-it refusal, checked against APK_PREFIX_LITE. Each
# APK subcommand guards only ITS OWN link — apk does not require the lite
# link and apk-lite does not require the full one, deliberately: a full-only
# release (an operator who never adopted lite) must stay shippable. What
# keeps the two Android links moving together is the release process
# shipping both variants at the same version, plus check-versions.sh
# flagging a lite surface that trails once lite is deployed — not a
# cross-gate here.
cmd_apk_lite() {
	local apk="${1:?usage: dual-ship.sh apk-lite <APK> <version>}" version="${2:?version}"
	local page; page="$(download_page)"
	if ! grep -qF "$APK_PREFIX_LITE-$version.apk" "$page"; then
		echo "REFUSING: $page does not link $APK_PREFIX_LITE-$version.apk."
		echo "Update the lite Android href + version label there first — the page and the APK ship together."
		exit 1
	fi
	local local_sha; local_sha="$(sha256sum "$apk" | cut -d' ' -f1)"
	for entry in "${HOSTS[@]}"; do
		local label; label="$(label_of "$entry")"
		echo "=== apk (lite) $version -> $label ==="
		scp_to "$entry" "$apk" "${entry#*:}:$INSTALL_DIR/downloads/mobile/$APK_PREFIX_LITE-$version.apk"
		ssh_to "$entry" "chmod 644 $INSTALL_DIR/downloads/mobile/$APK_PREFIX_LITE-$version.apk"
		ship_download_page "$entry" "$page" "$version" "$label" "apk-lite"
		local served_sha
		served_sha="$(ssh_to "$entry" "curl -s $CURL_TLS --resolve $DOWNLOAD_HOST:443:127.0.0.1 'https://$DOWNLOAD_HOST/mobile/$APK_PREFIX_LITE-$version.apk' --max-time 120 | sha256sum | cut -d' ' -f1")"
		if [ "$served_sha" = "$local_sha" ]; then
			echo "PASS  $label lite apk hash matches"
		else
			echo "FAIL  $label lite apk hash mismatch"
			FAILED+=("$label:apk-lite")
		fi
		local page_links
		page_links="$(remote_body "$entry" "$DOWNLOAD_HOST" / | grep -c "$APK_PREFIX_LITE-$version.apk" || true)"
		if [ "${page_links:-0}" -gt 0 ]; then
			echo "PASS  $label download page links the new lite APK"
		else
			echo "FAIL  $label download page does not link $APK_PREFIX_LITE-$version.apk"
			FAILED+=("$label:apk-lite-page")
		fi
	done
}

main() {
	local sub="${1:-}"; shift || true
	case "$sub" in
		webapp)         cmd_webapp "$@" ;;
		mobile)         cmd_mobile "$@" ;;
		mobile-lite)    cmd_mobile_lite "$@" ;;
		installer)      cmd_installer "$@" ;;
		installer-lite) cmd_installer_lite "$@" ;;
		backend)        cmd_backend "$@" ;;
		apk)            cmd_apk "$@" ;;
		apk-lite)       cmd_apk_lite "$@" ;;
		*) echo "usage: dual-ship.sh {webapp|mobile|mobile-lite|installer|installer-lite|backend|apk|apk-lite} ..." >&2; exit 2 ;;
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
		local certnames rc=0 wildcard
		certnames="$(remote_cert_names "$entry" "$API_HOST")" || rc=$?
		wildcard="*.${API_HOST#*.}"
		if [ "$rc" = "3" ]; then
			echo "INFO  $label no openssl on the box — served certificate name unchecked"
		elif [ -z "$certnames" ]; then
			echo "INFO  $label could not read the served certificate — name unchecked"
		elif [ "$(printf '%s\n' "$certnames" | grep -cF -e "$API_HOST" -e "$wildcard" || true)" -gt 0 ]; then
			echo "PASS  $label serves a certificate naming $API_HOST"
		else
			echo "FAIL  $label serves a certificate for something else:"
			printf '%s\n' "$certnames" | sed 's/^/        /'
			FAILED+=("$label:cert-name")
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
