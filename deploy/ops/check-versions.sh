#!/usr/bin/env bash
# Every surface must report the SAME version, on EVERY host.
#
# WHY THIS EXISTS. A release does not have one version, it has five: the
# Tauri config the installer is built from, the desktop updater manifest
# (latest.json), the version endpoint the desktop app polls (/app-version),
# the mobile OTA manifest, and whatever webapp bundle is actually served.
# Nothing in the pipeline ties them together, so shipping a subset — a
# web-only fix that skips the installer, say — silently leaves them
# disagreeing. Deployments that ship the LITE variant add three more
# (latest-lite.json, the ?variant=lite OTA manifest, the lite APK link),
# checked below only once they exist — a full-only deployment stays green.
#
# That drift is not cosmetic. The desktop app decides whether to prompt by
# comparing /app-version against its own version and then downloads whatever
# latest.json points at, so the two disagreeing means either a prompt for a
# build that does not exist, or a fixed release nobody is ever offered. And
# the NATIVE AGENT ships only inside the installer: if the installer lags,
# every encoder change is absent from the machines being controlled while
# the UI insists it is up to date.
#
# Usage:
#   check-versions.sh            # AFTER shipping: every surface must match
#   check-versions.sh 0.8.31     # ...against an explicit expected version
#   check-versions.sh --preflight  # BEFORE building: is this version free?
#
# Exit 0 only when every surface on every host matches.
#
# --preflight answers a different question, and it exists because of a real
# near-miss: two sessions working in this repo at once each planned to ship
# "0.8.33", one of them not knowing the other had already put it live. Version
# numbers are the ONLY thing the desktop updater and the mobile OTA compare, so
# two different artifacts sharing one number is undiagnosable from a client —
# whoever is already on it is never offered the other, and monotonic-version
# enforcement in the OTA path refuses anything <= what it holds. Run it before
# you spend two minutes on a release build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=hosts.conf
source "$HERE/hosts.conf"

REPO="$(cd "$HERE/../.." && pwd)"
CONF="$REPO/frontend/src-tauri/tauri.conf.json"

# The version lives in tauri.conf.json ONLY (see CLAUDE.md); everything else
# is meant to be a copy of it, which is exactly why they can drift.
LOCAL="$(grep -m1 '"version"' "$CONF" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

PREFLIGHT=0
if [ "${1:-}" = "--preflight" ]; then
	PREFLIGHT=1
	shift
fi

EXPECTED="${1:-$LOCAL}"

if [ -z "$EXPECTED" ]; then
	echo "FAIL  could not read a version from $CONF"
	exit 1
fi

ssh_to() { ssh "${SSH_OPTS[@]}" "${1#*:}" "${@:2}"; }

# curl ON the host against its own loopback — never from here. The origin
# lock drops non-Cloudflare traffic, so an external check depends on the
# caller's current source IP being exempt, which it is not.
body() {
	local entry="$1" host="$2" path="$3"
	ssh_to "$entry" "curl -sk --resolve '${host}:443:127.0.0.1' 'https://${host}${path}' --max-time 25" 2>/dev/null || true
}

ver_of() { grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

# --- preflight: is the version we are ABOUT to build still free? -------------
#
# Answers the question that matters before a release build, not after: has
# anyone (another session, another machine, an earlier run) already put this
# number live? If so, building it again produces a second artifact wearing a
# number that is already spoken for.
if [ "$PREFLIGHT" = "1" ]; then
	echo "preflight for $EXPECTED (tauri.conf.json says $LOCAL)"
	echo
	CLASH=0
	for entry in "${HOSTS[@]}"; do
		label="${entry%%:*}"
		live="$(body "$entry" "$DOWNLOAD_HOST" /latest.json | ver_of || true)"
		if [ -z "$live" ]; then
			printf 'WARN  %-6s could not read latest.json — cannot rule out a clash\n' "$label"
			CLASH=1
		elif [ "$live" = "$EXPECTED" ]; then
			printf 'CLASH %-6s already serving %s\n' "$label" "$live"
			CLASH=1
		else
			printf 'ok    %-6s serving %s, so %s is free\n' "$label" "$live" "$EXPECTED"
		fi
		# The LITE channel wears the same version numbers (both variants ship
		# each release under one number), so a number the lite channel already
		# serves is just as spoken-for as one the full channel does — a
		# mid-release crash could leave lite@X live with full@X never shipped.
		# Absence is fine: a deployment that never shipped lite has no
		# latest-lite.json and this stays silent.
		live_lite="$(body "$entry" "$DOWNLOAD_HOST" /latest-lite.json | ver_of || true)"
		if [ -n "$live_lite" ] && [ "$live_lite" = "$EXPECTED" ]; then
			printf 'CLASH %-6s lite channel already serving %s\n' "$label" "$live_lite"
			CLASH=1
		fi
	done
	echo
	if [ "$CLASH" = "1" ]; then
		cat <<'MSG'
DO NOT BUILD THIS VERSION.

Bump frontend/src-tauri/tauri.conf.json (the version lives there and nowhere
else) and run this again. Shipping a second artifact under a live version
number is not recoverable from the client side: the desktop updater and the
mobile OTA both decide purely by comparing versions, so whoever already has
that number is never offered the new bytes, and the OTA refuses anything <=
what it holds.

If another session is working in this repo, agree who takes which number
BEFORE either of you builds.
MSG
		exit 1
	fi
	echo "$EXPECTED is free on every host."
	exit 0
fi

echo "expecting $EXPECTED (tauri.conf.json says $LOCAL)"
echo

FAILED=()

for entry in "${HOSTS[@]}"; do
	label="${entry%%:*}"
	echo "=== $label ==="

	check() { # name expected_actual
		local name="$1" got="$2"
		if [ "$got" = "$EXPECTED" ]; then
			printf 'PASS  %-22s %s\n' "$name" "$got"
		else
			printf 'FAIL  %-22s %s (expected %s)\n' "$name" "${got:-<empty>}" "$EXPECTED"
			FAILED+=("$label/$name")
		fi
	}

	check "desktop latest.json"  "$(body "$entry" "$DOWNLOAD_HOST" /latest.json      | ver_of)"
	check "desktop /app-version" "$(body "$entry" "$API_HOST"     /app-version       | ver_of)"
	check "mobile OTA manifest"  "$(body "$entry" "$API_HOST"     /api/mobile-updates/check | ver_of)"

	# The APK is the fifth surface, and the historic blind spot: OTAs shipped
	# for six releases while the download page still linked 0.5.56, and this
	# script's first version never looked. The APK legitimately TRAILS on an
	# OTA-only release (web changes ride the OTA; only native changes need a
	# new shell), so its version is REPORTED, not asserted — what is asserted
	# is that the page links an APK at all and that the linked file actually
	# serves, because a href pointing at a missing file is a 404 wearing a
	# version number.
	apk_href="$(body "$entry" "$DOWNLOAD_HOST" / | grep -oE "$APK_PREFIX-[0-9.]+\.apk" | head -1 || true)"
	if [ -z "$apk_href" ]; then
		printf 'FAIL  %-22s no Android link on the download page\n' "download-page APK"
		FAILED+=("$label/apk-link")
	else
		apk_code="$(ssh_to "$entry" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$DOWNLOAD_HOST:443:127.0.0.1' 'https://$DOWNLOAD_HOST/mobile/$apk_href' --max-time 25" 2>/dev/null || true)"
		apk_ver="$(printf '%s' "$apk_href" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
		if [ "$apk_code" = "200" ]; then
			if [ "$apk_ver" = "$EXPECTED" ]; then
				printf 'PASS  %-22s %s (current)\n' "download-page APK" "$apk_ver"
			else
				printf 'INFO  %-22s %s (trails %s — fine for OTA-only releases; NATIVE changes need a new APK here)\n' \
					"download-page APK" "$apk_ver" "$EXPECTED"
			fi
		else
			printf 'FAIL  %-22s %s linked but serves HTTP %s\n' "download-page APK" "$apk_href" "${apk_code:-<none>}"
			FAILED+=("$label/apk-file")
		fi
	fi

	# --- LITE surfaces (the build with no remote control) -------------------
	# A deployment that never shipped lite is legitimate: absence of EVERY
	# lite surface is INFO, not FAIL. But once lite IS deployed, the
	# same-version contract covers it too (both variants ship each release
	# under one number — CLAUDE.md), so a present lite surface is asserted
	# exactly like its full sibling. The OTA check additionally demands the
	# "variant":"lite" tag: the version alone cannot tell the lite manifest
	# from the full one (same number by design), and a backend that predates
	# the variant-aware route answers ?variant=lite with the FULL manifest —
	# which would leave lite phones silently never updating while every
	# version here still matched.
	lite_latest="$(body "$entry" "$DOWNLOAD_HOST" /latest-lite.json | ver_of || true)"
	lite_ota_body="$(body "$entry" "$API_HOST" '/api/mobile-updates/check?variant=lite')"
	lite_ota_ver="$(printf '%s' "$lite_ota_body" | ver_of || true)"
	# grep -c, not -q: -q SIGPIPEs the writer under pipefail.
	lite_ota_tagged="$(printf '%s' "$lite_ota_body" | grep -cE '"variant"[[:space:]]*:[[:space:]]*"lite"' || true)"
	if [ -z "$lite_latest" ] && [ "${lite_ota_tagged:-0}" -eq 0 ]; then
		printf 'INFO  %-22s not deployed on this host (no latest-lite.json, no lite OTA manifest)\n' "lite surfaces"
	else
		check "lite latest-lite.json" "$lite_latest"
		if [ "${lite_ota_tagged:-0}" -gt 0 ]; then
			check "lite OTA manifest" "$lite_ota_ver"
		else
			printf 'FAIL  %-22s ?variant=lite answered "%s" WITHOUT variant:lite — backend predates the variant-aware route\n' \
				"lite OTA manifest" "${lite_ota_ver:-<empty>}"
			FAILED+=("$label/lite-ota-variant")
		fi
		# Same reported-not-asserted rule as the full APK above: the lite APK
		# legitimately trails on OTA-only releases; what must hold is that the
		# page links one and the linked file actually serves. Needs the
		# APK_PREFIX_LITE name from hosts.conf — an older hosts.conf without
		# the *_LITE variables skips this one check rather than dying on
		# set -u (see hosts.conf.example for the variables to add).
		if [ -n "${APK_PREFIX_LITE:-}" ]; then
			lite_apk_href="$(body "$entry" "$DOWNLOAD_HOST" / | grep -oE "$APK_PREFIX_LITE-[0-9.]+\.apk" | head -1 || true)"
			if [ -z "$lite_apk_href" ]; then
				printf 'FAIL  %-22s no lite Android link on the download page\n' "download-page liteAPK"
				FAILED+=("$label/lite-apk-link")
			else
				lite_apk_code="$(ssh_to "$entry" "curl -sk -o /dev/null -w '%{http_code}' --resolve '$DOWNLOAD_HOST:443:127.0.0.1' 'https://$DOWNLOAD_HOST/mobile/$lite_apk_href' --max-time 25" 2>/dev/null || true)"
				lite_apk_ver="$(printf '%s' "$lite_apk_href" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
				if [ "$lite_apk_code" = "200" ]; then
					if [ "$lite_apk_ver" = "$EXPECTED" ]; then
						printf 'PASS  %-22s %s (current)\n' "download-page liteAPK" "$lite_apk_ver"
					else
						printf 'INFO  %-22s %s (trails %s — same OTA-only rule as the full APK)\n' \
							"download-page liteAPK" "$lite_apk_ver" "$EXPECTED"
					fi
				else
					printf 'FAIL  %-22s %s linked but serves HTTP %s\n' "download-page liteAPK" "$lite_apk_href" "${lite_apk_code:-<none>}"
					FAILED+=("$label/lite-apk-file")
				fi
			fi
		else
			printf 'WARN  %-22s APK_PREFIX_LITE not set in hosts.conf — lite APK link unchecked (see hosts.conf.example)\n' "download-page liteAPK"
		fi
	fi

	# The webapp carries no version string, so compare the ENTRY BUNDLE the
	# host serves against the one in the local dist/ — a hash match is the
	# only honest way to say "this host is serving the build I just made".
	#
	# READ index.html, DO NOT LIST THE DIRECTORY. vite does not empty
	# dist/assets between builds, so it accumulates every previous entry
	# bundle — eight of them when this was written. Listing and taking the
	# first match picks an arbitrary STALE hash and reports a perfectly
	# correct deployment as drifted, which is exactly what it did on its
	# first run. index.html names the one entry that is actually loaded.
	served="$(body "$entry" "$APP_HOST" / | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
	local_entry="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$REPO/frontend/dist/index.html" 2>/dev/null | head -1 | sed 's#^assets/##')"
	if [ -z "$local_entry" ]; then
		printf 'SKIP  %-22s no local dist/index.html to compare (run npm run build)\n' "webapp bundle"
	elif [ "$served" = "$local_entry" ]; then
		printf 'PASS  %-22s %s\n' "webapp bundle" "$served"
	else
		printf 'FAIL  %-22s %s (local dist has %s)\n' "webapp bundle" "${served:-<empty>}" "$local_entry"
		FAILED+=("$label/webapp")
	fi
	echo
done

if [ ${#FAILED[@]} -gt 0 ]; then
	echo "VERSIONS DISAGREE: ${FAILED[*]}"
	echo
	echo "Ship the missing surface(s) with dual-ship.sh. Remember the native"
	echo "agent — and therefore every encoder change — ships ONLY in the"
	echo "installer, so a webapp/OTA-only release never delivers it."
	exit 1
fi

echo "ALL SURFACES AGREE ON $EXPECTED, ON EVERY HOST."
