#!/usr/bin/env bash
# Tests for the REFUSAL gates in dual-ship.sh and the download-page check in
# check-versions.sh. Runs entirely offline against a sandbox: a throwaway
# hosts.conf, a fixture download page, and stub `ssh`/`scp`/`curl` on PATH.
# It never contacts a host and it never reads your real hosts.conf.
#
#   ./ship-gates.test.sh
#
# WHY. The download page is the one artefact whose content end users read, and
# it is hand-written HTML. The APK link has been gated since the page sat on
# 0.5.56 through six releases of OTAs; the installer link was not, so a
# Windows-only release published a new installer while the live page kept
# advertising the previous version. These gates close that, and a gate nobody
# has ever seen refuse is indistinguishable from no gate at all — so each
# refusal here has a matching case proving it does NOT fire when the page is
# right. Note that every refusal is asserted on the REFUSING message and not
# merely on a non-zero exit: dual-ship.sh also exits non-zero when a host
# verification fails, so an exit-code-only assertion passes even with the gate
# deleted — measured, while writing this.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
has() { printf '%s' "$1" | grep -qF "$2" && echo 1 || echo 0; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- sandbox tree, mirroring the layout the scripts expect -------------------
mkdir -p "$TMP/deploy/ops" "$TMP/deploy/download-site" "$TMP/bin" "$TMP/frontend/src-tauri" "$TMP/frontend/dist"
cp "$HERE/dual-ship.sh" "$HERE/check-versions.sh" "$TMP/deploy/ops/"

cat > "$TMP/deploy/ops/hosts.conf" <<'CONF'
HOSTS=("sandbox:root@127.0.0.1")
declare -A HOST_IPS=([sandbox]="127.0.0.1")
API_HOST="api.invalid"
APP_HOST="app.invalid"
DOWNLOAD_HOST="dl.invalid"
INSTALL_DIR="/tmp/sandbox-install"
SERVICE_NAME="sandbox"
SERVICE_USER="sandbox"
DB_NAME="sandbox"
HOST_HEADER="x-sandbox-host"
INSTALLER_NAME="Puca-Setup.exe"
MOBILE_BUNDLE_PREFIX="puca-web"
APK_PREFIX="Puca"
INSTALLER_NAME_LITE="Puca-Lite-Setup.exe"
MOBILE_BUNDLE_PREFIX_LITE="puca-web-lite"
APK_PREFIX_LITE="Puca-Lite"
SSH_OPTS=()
CONF

# The page under test. Written per-case by page_with().
page_with() { # <version>  [installer-name...]
	local v="$1"; shift
	{
		echo '<html><body>'
		for name in "$@"; do echo "<a href=\"/$name\">Download</a>"; done
		echo "<a href=\"/mobile/Puca-$v.apk\">Android</a>"
		echo "<a href=\"/mobile/Puca-Lite-$v.apk\">Android lite</a>"
		echo "<div class=\"meta\">v$v &middot; Windows</div>"
		echo '</body></html>'
	} > "$TMP/deploy/download-site/index.html"
}

# --- stubs. Recorded, so "it refused BEFORE touching a host" is checkable ----
LOG="$TMP/calls.log"
: > "$LOG"
for tool in ssh scp; do
	cat > "$TMP/bin/$tool" <<STUB
#!/usr/bin/env bash
echo "$tool \$*" >> "$LOG"
exit 0
STUB
	chmod +x "$TMP/bin/$tool"
done
# curl only ever runs LOCALLY here (the CDN check); serve the fixture exe so
# the hash matches and the 60-second negative-cache retry never happens.
cat > "$TMP/bin/curl" <<STUB
#!/usr/bin/env bash
echo "curl \$*" >> "$LOG"
for a in "\$@"; do case "\$a" in *.exe) cat "$TMP/setup.exe"; exit 0 ;; esac; done
exit 0
STUB
chmod +x "$TMP/bin/curl"

printf 'MZ fake installer\n' > "$TMP/setup.exe"
printf 'untrusted comment: fake\nfakesig\n' > "$TMP/setup.exe.sig"

ship() { # <subcommand> <args...>
	: > "$LOG"
	( cd "$TMP/deploy/ops" && PATH="$TMP/bin:$PATH" bash ./dual-ship.sh "$@" 2>&1 )
}

echo "--- dual-ship.sh installer: the page must advertise the release ---"

page_with 0.8.136 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the page names an older version" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and says which version is missing"            "$(has "$out" 'does not name v9.9.9')"
check "and refuses BEFORE touching any host"         "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"

page_with 9.9.9 Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the page does not link the installer" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and names the file it wanted"                      "$(has "$out" 'does not link Puca-Setup.exe')"
check "and refuses BEFORE touching any host"              "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"

# A page on a LONGER version that merely starts with the one being shipped must
# not satisfy the gate. A plain substring test does satisfy it, which would let
# an older build ship past a newer page — the precise thing this gate exists to
# stop, wearing the wrong shape.
page_with 9.9.90 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the page's version merely STARTS WITH this one" 	"$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and the reverse also refuses (page older, ship longer)" 	"$(page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
	   o="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.90 'notes')"
	   has "$o" 'REFUSING')"

# THE POSITIVE CONTROL. A gate that refuses everything is not a gate.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "does NOT refuse when the page is correct" "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"
check "and proceeds to ship"                     "$(has "$out" '=== installer 9.9.9 -> sandbox ===')"
check "and uploads the page alongside the exe"   "$(grep -q 'index.html' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"

echo
echo "--- the same gate on installer-lite ---"
page_with 9.9.9 Puca-Setup.exe
out="$(ship installer-lite "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the page does not link the lite installer" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and names it"  "$(has "$out" 'does not link Puca-Lite-Setup.exe')"

page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer-lite "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "does NOT refuse when the page is correct" "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- the pre-existing APK gate still behaves ---"
page_with 0.8.136 Puca-Setup.exe Puca-Lite-Setup.exe
printf 'fake apk\n' > "$TMP/app.apk"
out="$(ship apk "$TMP/app.apk" 9.9.9)"; rc=$?
check "REFUSES an APK the page does not link" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and names the file"                    "$(has "$out" 'does not link Puca-9.9.9.apk')"

page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship apk "$TMP/app.apk" 9.9.9)"
check "does NOT refuse when the page links it" "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- check-versions.sh: the download page's version label ---"
# check-versions.sh reads the local tauri.conf.json for the expected version and
# talks to the host through `body()`, i.e. ssh. The stub below answers per path,
# so the page it "serves" is under this test's control.
printf '{\n  "version": "9.9.9"\n}\n' > "$TMP/frontend/src-tauri/tauri.conf.json"
printf '<script src="/assets/index-abc123.js"></script>\n' > "$TMP/frontend/dist/index.html"

serve_page_version() { # <version-on-the-live-page> [an-older-version-mentioned-in-prose]
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<div class="meta">v$1 &middot; Windows</div>'
	              ${2:+echo '<p>what is new since v$2</p>'} ;;
esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
}

versions() { ( cd "$TMP/deploy/ops" && PATH="$TMP/bin:$PATH" bash ./check-versions.sh 2>&1 ); }

serve_page_version 0.8.136
out="$(versions)"
check "FAILS on a page whose label trails the release" "$(has "$out" 'FAIL  download-page version')" "$out"
check "and says what it expected"                      "$(has "$out" 'expected 9.9.9')"

serve_page_version 9.9.9
out="$(versions)"
check "PASSES once the label is bumped" "$(has "$out" 'PASS  download-page version')" "$out"

# A page that names the release AND mentions an older one in prose is correct,
# not stale. Failing on that would be crying wolf, and an operator who learns to
# ignore this line learns to ignore the real failure with it.
serve_page_version 9.9.9 0.8.130
out="$(versions)"
check "PASSES when the page also names an older version" "$(has "$out" 'PASS  download-page version')" "$out"
check "and says which other versions it saw"             "$(has "$out" 'page also names')" "$out"

echo
echo "--- check-versions.sh: the web origin must carry a CSP ---"
# The API origin deliberately has no CSP (the SPA is a different origin), and
# whether add-webapp-csp.py was ever run on a box is not knowable from the tree.
# So it is probed. Drop the header and the check must go red.
serve_page_version 9.9.9
out="$(versions)"
check "PASSES when the app origin sends one" "$(has "$out" 'PASS  webapp CSP header')" "$out"

cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<div class="meta">v9.9.9 &middot; Windows</div>' ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/ssh"
out="$(versions)"
check "FAILS when it is absent" "$(has "$out" 'FAIL  webapp CSP header')" "$out"

echo
echo "--- check-versions.sh: a page with NO version label at all ---"
# Under `set -e` + pipefail an empty grep result aborts the script before the
# FAIL branch can print, so a page with no label would report NOTHING rather
# than a failure. That is a worse outcome than either, and it is invisible in
# any run against a page that does have one.
cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>' ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/ssh"
out="$(versions)"
check "reports the missing label instead of dying" "$(has "$out" 'no version label on the download page')" "$out"
check "and still reaches the end of the run"       "$(has "$out" 'VERSIONS DISAGREE')" "$out"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all ship-gate checks passed"
