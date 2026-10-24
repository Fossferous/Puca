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
# waker-source-sha.sh travels with them: check-versions.sh sources it, so a
# sandbox without it fails every case with "No such file or directory" rather
# than testing anything. Add any future sourced helper here too.
cp "$HERE/dual-ship.sh" "$HERE/check-versions.sh" "$HERE/waker-source-sha.sh" "$TMP/deploy/ops/"
# The mobile subcommands verify a bundle's signature against the key the
# target app's capacitor.config.ts embeds (deploy/mobile/verify-bundle.mjs).
# The sandbox gets the verifier and two FIXTURE configs, each carrying the
# public half of a throwaway key made below — never the real ones.
mkdir -p "$TMP/deploy/mobile" "$TMP/frontend/notes-app"
cp "$REPO/deploy/mobile/verify-bundle.mjs" "$TMP/deploy/mobile/"
cat > "$TMP/mkkey.js" <<'JS'
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(process.argv[2], privateKey.export({ type: 'pkcs1', format: 'pem' }));
const lines = String(publicKey.export({ type: 'pkcs1', format: 'pem' })).trim().split(/\r?\n/);
const lit = lines.map((l, i) => "'" + l + (i < lines.length - 1 ? '\\n' : '') + "'").join(' +\n        ');
fs.writeFileSync(process.argv[3], 'const config = { plugins: { CapacitorUpdater: {\n    publicKey:\n        ' + lit + ',\n} } };\nexport default config;\n');
JS
fixture_key() { node "$TMP/mkkey.js" "$1" "$2"; } # <private key out> <capacitor.config.ts out>
fixture_key "$TMP/puca-fixture.key" "$TMP/frontend/capacitor.config.ts"
fixture_key "$TMP/notes-fixture.key" "$TMP/frontend/notes-app/capacitor.config.ts"

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
APK_PREFIX_NOTES="Puca-Notes"
MOBILE_BUNDLE_PREFIX_NOTES="puca-notes-web"
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
		echo "<a href=\"/mobile/Puca-Notes-$v.apk\">Android notes</a>"
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
echo "--- the Púca Notes APK gate: same rule, its own link ---"
page_with 0.8.136 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship apk-notes "$TMP/app.apk" 9.9.9)"; rc=$?
check "REFUSES a notes APK the page does not link" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && echo 1 || echo 0)" "$out"
check "and names the file"                          "$(has "$out" 'does not link Puca-Notes-9.9.9.apk')"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship apk-notes "$TMP/app.apk" 9.9.9)"
check "does NOT refuse when the page links it"      "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"

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
	*ios-web-clip*) cat "$TMP/clip-answer" 2>/dev/null ;;
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*variant=notes*) cat "$TMP/notes-ota.json" 2>/dev/null ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) ${CLIP_LINK:+echo '<a href="https://api.invalid/api/ios-web-clip">one tap</a>'}
	              echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<a href="/mobile/Puca-Notes-${NOTES_APK_VER:-9.9.9}.apk">c</a>'
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

# The iPhone one-tap profile, as the live page and the backend answer it. Only a page
# that LINKS it is held to it; the probe reads the type, the address and the payload
# count out of what the API host really answers.
node "$REPO/deploy/ops/make-web-clip-profile.mjs" https://app.invalid/ "$REPO/frontend/public/apple-touch-icon.png" > "$TMP/clip.good"
clip_answer() { # <status> <content-type or ""> <body file>
	{ printf 'HTTP/2 %s\r\n' "$1"; [ -n "$2" ] && printf 'content-type: %s\r\n' "$2"; printf '\r\n'; cat "$3"; } > "$TMP/clip-answer"
}
out="$(versions)"
check "a page that does not link the iPhone profile is INFO, not held to it" "$([ "$(has "$out" 'INFO  iPhone profile')" = 1 ] && [ "$(has "$out" 'ios-profile')" = 0 ] && echo 1 || echo 0)" "$out"
CLIP_LINK=1 serve_page_version 9.9.9
clip_answer 200 application/x-apple-aspen-config "$TMP/clip.good"
out="$(versions)"
check "a linked profile the backend serves right PASSES" "$([ "$(has "$out" 'PASS  iPhone profile')" = 1 ] && [ "$(has "$out" 'ios-profile')" = 0 ] && echo 1 || echo 0)" "$out"
clip_answer 200 text/xml "$TMP/clip.good"
out="$(versions)"
check "FAILS when it is served as the wrong type" "$([ "$(has "$out" 'FAIL  iPhone profile')" = 1 ] && [ "$(has "$out" 'aspen-config=NO')" = 1 ] && [ "$(has "$out" 'sandbox/ios-profile')" = 1 ] && [ "$(has "$out" 'ALL SURFACES AGREE')" = 0 ] && echo 1 || echo 0)" "$out"
clip_answer 404 "" /dev/null
out="$(versions)"
check "FAILS on a 404 (a backend older than the route), saying to ship the backend" "$([ "$(has "$out" 'FAIL  iPhone profile')" = 1 ] && [ "$(has "$out" 'dual-ship.sh backend')" = 1 ] && echo 1 || echo 0)" "$out"
node "$REPO/deploy/ops/make-web-clip-profile.mjs" https://other.invalid/ "$REPO/frontend/public/apple-touch-icon.png" > "$TMP/clip.other"
clip_answer 200 application/x-apple-aspen-config "$TMP/clip.other"
out="$(versions)"
check "FAILS when the profile opens another address than the web app" "$([ "$(has "$out" 'FAIL  iPhone profile')" = 1 ] && [ "$(has "$out" 'opens https://app.invalid/=NO')" = 1 ] && echo 1 || echo 0)" "$out"
sed 's|<key>PayloadVersion</key>|<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key>|' "$TMP/clip.good" > "$TMP/clip.two"
clip_answer 200 application/x-apple-aspen-config "$TMP/clip.two"
out="$(versions)"
check "FAILS when a payload beyond the one Web Clip rides along" "$([ "$(has "$out" 'FAIL  iPhone profile')" = 1 ] && [ "$(has "$out" 'payload types=')" = 1 ] && echo 1 || echo 0)" "$out"
rm -f "$TMP/clip-answer"
serve_page_version 9.9.9

# Púca Notes' Android app has NO OTA. The other two APKs may trail after an
# OTA-only release because their web layer updates itself; a trailing Notes APK
# never catches up, so it is a disagreement, and it must reach the verdict line
# (a FAIL that is printed but not counted still ends in "ALL SURFACES AGREE").
NOTES_APK_VER=9.9.8 serve_page_version 9.9.9
out="$(versions)"
check "FAILS on a Notes APK that trails the release" "$(has "$out" 'FAIL  download-page notesAPK 9.9.8 (trails 9.9.9')" "$out"
check "and counts it in the verdict"                 "$([ "$(has "$out" 'sandbox/notes-apk-trails')" = 1 ] && [ "$(has "$out" 'ALL SURFACES AGREE')" = 0 ] && echo 1 || echo 0)" "$out"
serve_page_version 9.9.9
out="$(versions)"
check "PASSES a current Notes APK (positive control)" "$([ "$(has "$out" 'PASS  download-page notesAPK 9.9.9 (current)')" = 1 ] && [ "$(has "$out" 'notes-apk-trails')" = 0 ] && echo 1 || echo 0)" "$out"

# Once a Notes OTA is deployed (a manifest TAGGED "variant":"notes" answers
# ?variant=notes), it is a surface like any other OTA, and a trailing APK is
# INFO: the OTA brings the web layer up. Except when that manifest's
# native.min is newer than the APK the page links — a fresh install would then
# refuse its own first update — which stays a FAIL.
check "with no notes OTA deployed, says so" "$(has "$out" 'INFO  notes OTA manifest     not deployed')" "$out"
printf '{"version":"9.9.9","variant":"notes"}\n' > "$TMP/notes-ota.json"
NOTES_APK_VER=9.9.8 serve_page_version 9.9.9
out="$(versions)"
check "a current notes OTA is checked like the others"            "$(has "$out" 'PASS  notes OTA manifest     9.9.9')" "$out"
check "and makes a trailing Notes APK INFO, not FAIL"             "$([ "$(has "$out" 'INFO  download-page notesAPK 9.9.8 (trails 9.9.9')" = 1 ] && [ "$(has "$out" 'notes-apk-trails')" = 0 ] && echo 1 || echo 0)" "$out"
printf '{"version":"9.9.9","variant":"notes","native":{"min":"9.9.9","download_url":"https://dl.invalid/#notes-app"}}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "but FAILS when native.min is newer than the linked APK"    "$([ "$(has "$out" 'FAIL  download-page notesAPK 9.9.8 (the notes OTA needs native.min 9.9.9')" = 1 ] && [ "$(has "$out" 'sandbox/notes-apk-below-native-min')" = 1 ] && echo 1 || echo 0)" "$out"
printf '{"version":"9.9.9","variant":"notes","native":{"min":"9.9.8"}}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "and not when the APK meets it (positive control)"          "$([ "$(has "$out" 'below-native-min')" = 0 ] && [ "$(has "$out" 'INFO  download-page notesAPK 9.9.8')" = 1 ] && echo 1 || echo 0)" "$out"
printf '{"version":"9.9.8","variant":"notes"}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "a notes OTA that trails the release FAILS"                 "$([ "$(has "$out" 'FAIL  notes OTA manifest     9.9.8 (expected 9.9.9)')" = 1 ] && [ "$(has "$out" 'sandbox/notes-apk-trails')" = 1 ] && echo 1 || echo 0)" "$out"
# A CURRENT APK used to PASS without native.min being looked at, so a floor
# mistyped past the release (every Notes app then refuses the update) read as
# a healthy release.
NOTES_APK_VER=9.9.9 serve_page_version 9.9.9
printf '{"version":"9.9.9","variant":"notes","native":{"min":"9.9.10"}}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "native.min newer than a CURRENT linked APK still FAILS"   "$([ "$(has "$out" 'FAIL  download-page notesAPK 9.9.9 (the notes OTA needs native.min 9.9.10')" = 1 ] && [ "$(has "$out" 'sandbox/notes-apk-below-native-min')" = 1 ] && echo 1 || echo 0)" "$out"
check "and a native.min newer than the manifest itself FAILS"    "$([ "$(has "$out" 'FAIL  notes OTA manifest     native.min 9.9.10 is newer than the manifest itself (9.9.9)')" = 1 ] && [ "$(has "$out" 'sandbox/notes-native-min-above-release')" = 1 ] && echo 1 || echo 0)" "$out"
printf '{"version":"9.9.9","variant":"notes","native":{"min":"9.9.9"}}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "a floor equal to the current APK PASSES (positive control)" "$([ "$(has "$out" 'PASS  download-page notesAPK 9.9.9 (current)')" = 1 ] && [ "$(has "$out" 'native-min')" = 0 ] && echo 1 || echo 0)" "$out"
printf '{"version":"9.9.9","native":{"min":"9.9.10"}}\n' > "$TMP/notes-ota.json"
out="$(versions)"
check "an UNTAGGED answer's min is never read as the Notes floor" "$([ "$(has "$out" 'native-min')" = 0 ] && [ "$(has "$out" 'PASS  download-page notesAPK 9.9.9 (current)')" = 1 ] && echo 1 || echo 0)" "$out"
rm -f "$TMP/notes-ota.json"

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
	              echo '<a href="/mobile/Puca-Notes-9.9.9.apk">c</a>'
	              echo '<div class="meta">v9.9.9 &middot; Windows</div>' ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/ssh"
out="$(versions)"
check "FAILS when it is absent" "$(has "$out" 'FAIL  webapp CSP header')" "$out"

echo
echo "--- check-versions.sh: Notes' service worker must not be cacheable ---"
# A CDN-cached /notes/sw.js pins installed Notes pages to an old build. The
# stub answers the sw.js HEAD separately from the page, per case.
serve_sw() { # <header lines for /notes/sw.js>
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*notes/sw.js*) printf '%b' "$1" ;;
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<a href="/mobile/Puca-Notes-9.9.9.apk">c</a>'
	              echo '<div class="meta">v9.9.9 &middot; Windows</div>' ;;
esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
}
serve_sw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\ncache-control: no-cache\n'
out="$(versions)"
check "PASSES a no-cache worker" "$(has "$out" 'PASS  notes worker cache')" "$out"
serve_sw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\ncache-control: max-age=14400\n'
out="$(versions)"
check "FAILS a cacheable worker" "$(has "$out" 'FAIL  notes worker cache')" "$out"
check "and counts it in the verdict" "$([ "$(has "$out" 'sandbox/notes-sw-cache')" = 1 ] && [ "$(has "$out" 'ALL SURFACES AGREE')" = 0 ] && echo 1 || echo 0)" "$out"
# The operator reads the FAIL line, not the README: it must carry the fix.
check "and the FAIL carries the exact Caddy lines, the reload and the CDN purge" "$([ "$(has "$out" '@notesSw path /notes/sw.js')" = 1 ] && [ "$(has "$out" 'header @notesSw Cache-Control "no-cache"')" = 1 ] && [ "$(has "$out" 'systemctl reload caddy')" = 1 ] && [ "$(has "$out" 'purge https://app.invalid/notes/sw.js')" = 1 ] && echo 1 || echo 0)" "$out"
# The FAIL line is what an EXISTING deployment's operator reads. A fresh
# self-hoster never sees it: they copy deploy/Caddyfile.example.com, and the
# upgrade note in deploy/webapp/README.md is what an existing one follows by
# hand. All three must say the same two lines, so the two lines are taken OUT
# of the FAIL output and required verbatim in both files — whichever of the
# three is edited next, the other two are held to it.
sw_lines="$(printf '%s
' "$out" | grep -oE '@notesSw path /notes/sw\.js|header @notesSw Cache-Control "no-cache"' | sort -u)"
check "the FAIL names exactly the two @notesSw lines" "$([ "$(printf '%s
' "$sw_lines" | grep -c .)" = 2 ] && echo 1 || echo 0)" "$sw_lines"
for sw_f in deploy/Caddyfile.example.com deploy/webapp/README.md; do
	sw_missing=""
	[ "$(grep -c . <<< "$sw_lines")" = 2 ] || sw_missing="fewer than two lines to check; "
	while IFS= read -r sw_line; do
		[ -n "$sw_line" ] || continue
		grep -qF "$sw_line" "$REPO/$sw_f" || sw_missing="$sw_missing$sw_line; "
	done <<< "$sw_lines"
	check "$sw_f carries both lines verbatim" "$([ -z "$sw_missing" ] && echo 1 || echo 0)" "missing: $sw_missing"
done
serve_sw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\n'
out="$(versions)"
check "FAILS a worker with no Cache-Control at all" "$(has "$out" 'FAIL  notes worker cache')" "$out"
serve_sw 'HTTP/2 200\ncontent-type: text/html; charset=utf-8\n'
out="$(versions)"
check "an older webapp (SPA fallback HTML) is INFO, not FAIL" "$([ "$(has "$out" 'INFO  notes worker cache')" = 1 ] && [ "$(has "$out" 'notes-sw-cache')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- check-versions.sh: the web app's push worker must not be cacheable ---"
# /sw.js (Web Push) gets the same rule as Notes' worker. Its pattern comes
# first: "app.invalid/sw.js" is not a substring of ".../notes/sw.js", so each
# probe gets its own answer, and Notes' is a passing one throughout.
serve_psw() { # <header lines for /sw.js>
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*app.invalid/sw.js*) printf '%b' "$1" ;;
	*notes/sw.js*) printf 'HTTP/2 200\ncontent-type: text/javascript\ncache-control: no-cache\n' ;;
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<a href="/mobile/Puca-Notes-9.9.9.apk">c</a>'
	              echo '<div class="meta">v9.9.9 &middot; Windows</div>' ;;
esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
}
serve_psw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\ncache-control: no-cache\n'
out="$(versions)"
check "PASSES a no-cache push worker" "$(has "$out" 'PASS  push worker cache')" "$out"
check "and Notes' probe still reads its own path" "$(has "$out" 'PASS  notes worker cache')" "$out"
serve_psw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\ncache-control: max-age=14400\n'
out="$(versions)"
check "FAILS a cacheable push worker" "$(has "$out" 'FAIL  push worker cache')" "$out"
check "and counts it in the verdict" "$([ "$(has "$out" 'sandbox/push-sw-cache')" = 1 ] && [ "$(has "$out" 'ALL SURFACES AGREE')" = 0 ] && echo 1 || echo 0)" "$out"
check "and the FAIL carries the exact Caddy lines, the reload and the CDN purge" "$([ "$(has "$out" '@pushSw path /sw.js')" = 1 ] && [ "$(has "$out" 'header @pushSw Cache-Control "no-cache"')" = 1 ] && [ "$(has "$out" 'systemctl reload caddy')" = 1 ] && [ "$(has "$out" 'purge https://app.invalid/sw.js')" = 1 ] && echo 1 || echo 0)" "$out"
# The same three-way agreement as Notes' lines: the FAIL output, the example
# Caddyfile and the README's upgrade note must say the same two lines.
psw_lines="$(printf '%s
' "$out" | grep -oE '@pushSw path /sw\.js|header @pushSw Cache-Control "no-cache"' | sort -u)"
check "the FAIL names exactly the two @pushSw lines" "$([ "$(printf '%s
' "$psw_lines" | grep -c .)" = 2 ] && echo 1 || echo 0)" "$psw_lines"
for psw_f in deploy/Caddyfile.example.com deploy/webapp/README.md; do
	psw_missing=""
	[ "$(grep -c . <<< "$psw_lines")" = 2 ] || psw_missing="fewer than two lines to check; "
	while IFS= read -r psw_line; do
		[ -n "$psw_line" ] || continue
		grep -qF "$psw_line" "$REPO/$psw_f" || psw_missing="$psw_missing$psw_line; "
	done <<< "$psw_lines"
	check "$psw_f carries both @pushSw lines verbatim" "$([ -z "$psw_missing" ] && echo 1 || echo 0)" "missing: $psw_missing"
done
serve_psw 'HTTP/2 200\ncontent-type: text/javascript; charset=utf-8\n'
out="$(versions)"
check "FAILS a push worker with no Cache-Control at all" "$(has "$out" 'FAIL  push worker cache')" "$out"
serve_psw 'HTTP/2 200\ncontent-type: text/html; charset=utf-8\n'
out="$(versions)"
check "a webapp older than the push worker (SPA fallback HTML) is INFO, not FAIL" "$([ "$(has "$out" 'INFO  push worker cache')" = 1 ] && [ "$(has "$out" 'push-sw-cache')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- check-versions.sh: the iPhone web app's manifest and icon ---"
# try_files answers a MISSING file with the page and a 200, so a manifest that did
# not deploy passes a status check; the probe reads the body, the type and the
# icon's first bytes. The stub answers those paths per case.
serve_mf() { # <manifest response, printf %b> <icon bytes as od prints them>
	# The response goes through a file: its JSON quotes would end a quoted
	# string inside the unquoted heredoc below.
	printf '%b' "$1" > "$TMP/mf.resp"
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
cmd="\$*"
case "\$cmd" in
	*manifest.json*) cat "$TMP/mf.resp" ;;
	*icon-192.png*) printf '%s\n' "$2" ;;
	*notes/sw.js*) printf 'HTTP/2 200\ncontent-type: text/javascript\ncache-control: no-cache\n' ;;
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
	              echo '<a href="/mobile/Puca-Lite-9.9.9.apk">b</a>'
	              echo '<a href="/mobile/Puca-Notes-9.9.9.apk">c</a>'
	              echo '<div class="meta">v9.9.9 &middot; Windows</div>' ;;
esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
}
GOODMF='HTTP/2 200\ncontent-type: application/json\n\n{"name":"Púca","start_url":"/"}\n'
PNG=' 89 50 4e 47'
serve_mf "$GOODMF" "$PNG"
out="$(versions)"
check "PASSES JSON named Púca with a PNG icon" "$(has "$out" 'PASS  web app manifest')" "$out"
serve_mf 'HTTP/2 200\ncontent-type: text/plain; charset=utf-8\n\n{"name":"Púca","start_url":"/"}\n' "$PNG"
out="$(versions)"
check "FAILS a manifest served as text/plain" "$([ "$(has "$out" 'FAIL  web app manifest')" = 1 ] && [ "$(has "$out" 'content-type JSON=NO')" = 1 ] && echo 1 || echo 0)" "$out"
check "and counts it in the verdict" "$([ "$(has "$out" 'sandbox/web-app-manifest')" = 1 ] && [ "$(has "$out" 'ALL SURFACES AGREE')" = 0 ] && echo 1 || echo 0)" "$out"
serve_mf 'HTTP/2 200\ncontent-type: application/json\n\n{"name":"Somebody Else","start_url":"/"}\n' "$PNG"
out="$(versions)"
check "FAILS a manifest with the wrong name" "$([ "$(has "$out" 'FAIL  web app manifest')" = 1 ] && [ "$(has "$out" 'name Púca=NO')" = 1 ] && echo 1 || echo 0)" "$out"
serve_mf "$GOODMF" ' 3c 21 64 6f'
out="$(versions)"
check "FAILS an icon that is the page (the SPA fallback), not a PNG" "$([ "$(has "$out" 'FAIL  web app manifest')" = 1 ] && [ "$(has "$out" 'PNG=NO')" = 1 ] && echo 1 || echo 0)" "$out"
serve_mf '<!doctype html><title>the page</title>\n' ' 3c 21 64 6f'
out="$(versions)"
check "only says INFO for a webapp that predates it (the page answers the path)" "$([ "$(has "$out" 'INFO  web app manifest')" = 1 ] && [ "$(has "$out" 'FAIL  web app manifest')" = 0 ] && echo 1 || echo 0)" "$out"

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
echo "--- dual-ship.sh: the download page is RENDERED and must not name a placeholder domain ---"
# The check-versions cases above swapped in a non-logging ssh stub; restore the
# recording one, and make scp also keep a copy of every existing file it is
# handed, so the page that would have reached the host can be inspected.
mkdir -p "$TMP/uploaded" "$TMP/docs"
printf '# Changelog\n' > "$TMP/CHANGELOG.md"
printf '# Privacy\n' > "$TMP/docs/PRIVACY.md"
# ...and answers a fetch of SHA256SUMS.txt with whatever $TMP/served-sums holds,
# so the "the served file lists the shipped hash" check is under test control.
cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in *SHA256SUMS.txt*curl*|*curl*SHA256SUMS.txt*) cat "$TMP/served-sums" 2>/dev/null ;; esac
# ...and a backend pre-flight's migration read by RUNNING the remote command
# here, against the fake sudo/psql in $TMP/remote-bin (below), so the remote
# script's own error handling is what is under test, not a canned answer.
# $TMP/ssh_down plays a host ssh cannot reach (exit 255, nothing on stdout);
# $TMP/ssh_silent a session that ends at once with status 0 and no output.
# The host's INSTALL_DIR maps to $TMP/remote-install.
case "\$*" in *_sqlx_migrations*)
	[ -f "$TMP/ssh_down" ] && { echo 'ssh: connect to host 127.0.0.1 port 22: Connection refused' >&2; exit 255; }
	[ -f "$TMP/ssh_silent" ] && exit 0
	remote="\${@: -1}"
	PATH="$TMP/remote-bin:\$PATH" bash -c "\${remote//\/tmp\/sandbox-install/$TMP/remote-install}"
	exit \$? ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/ssh"
# The host's \`sudo -u postgres psql -d <db> ... -c <sql>\`; the SQL is the last
# argument. The history is $TMP/sqlx_rows; no such file is a database with no
# _sqlx_migrations table at all (psql exits 1 on the query, as the real one
# does), and $TMP/sqlx_fail a psql that cannot connect (exit 2, stderr only).
mkdir -p "$TMP/remote-bin"
cat > "$TMP/remote-bin/sudo" <<STUB
#!/usr/bin/env bash
sql="\${@: -1}"
if [ -f "$TMP/sqlx_fail" ]; then
	echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "sandbox" does not exist' >&2
	exit 2
fi
case "\$sql" in
	*to_regclass*) if [ -f "$TMP/sqlx_rows" ]; then echo f; else echo t; fi ;;
	*_sqlx_migrations*) if [ -f "$TMP/sqlx_rows" ]; then cat "$TMP/sqlx_rows"; else echo 'ERROR:  relation "_sqlx_migrations" does not exist' >&2; exit 1; fi ;;
	*) echo "fake sudo: unexpected SQL: \$sql" >&2; exit 3 ;;
esac
STUB
chmod +x "$TMP/remote-bin/sudo"
cat > "$TMP/bin/scp" <<STUB
#!/usr/bin/env bash
echo "scp \$*" >> "$LOG"
for a in "\$@"; do [ -f "\$a" ] && cp "\$a" "$TMP/uploaded/\$(basename "\$a")"; done
exit 0
STUB
chmod +x "$TMP/bin/scp"

# The tracked template's shape: the API host is a token, filled from hosts.conf.
page_with_token() { # <version>
	{
		echo '<html><body>'
		echo '<a href="/Puca-Setup.exe">Download</a><a href="/Puca-Lite-Setup.exe">Lite</a>'
		echo "<a href=\"/mobile/Puca-$1.apk\">Android</a><a href=\"/mobile/Puca-Lite-$1.apk\">Android lite</a>"
		echo "<div class=\"meta\">v$1 &middot; Windows</div>"
		echo 'The app connects to <a href="https://__API_HOST__">__API_HOST__</a>.'
		echo '</body></html>'
	} > "$TMP/deploy/download-site/index.html"
}
page_with_token 9.9.9
rm -f "$TMP/uploaded/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "the token page is not refused"                       "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"
check "and the page that ships names the REAL API host"     "$(grep -q 'https://api.invalid' "$TMP/uploaded/index.html" 2>/dev/null && echo 1 || echo 0)" "$(cat "$TMP/uploaded/index.html" 2>/dev/null)"
check "with no token left in it"                            "$([ -f "$TMP/uploaded/index.html" ] && ! grep -q '__API_HOST__' "$TMP/uploaded/index.html" && echo 1 || echo 0)"

# The tracked template as it was shipped for months: a literal chat.example.com.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
echo 'The app connects to <a href="https://chat.example.com">chat.example.com</a>.' >> "$TMP/deploy/download-site/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES a page that still names example.com"         "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && [ "$(has "$out" 'placeholder domain')" = 1 ] && echo 1 || echo 0)" "$out"
check "naming the domain it found"                          "$(has "$out" 'chat.example.com')"
check "and refuses BEFORE touching any host"                "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
out="$(ship apk "$TMP/app.apk" 9.9.9)"; rc=$?
check "the APK path refuses the same page"                  "$([ $rc -ne 0 ] && [ "$(has "$out" 'placeholder domain')" = 1 ] && echo 1 || echo 0)" "$out"

# POSITIVE CONTROL for the placeholder gate: the same page without the line ships.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "a page naming no placeholder is not refused"         "$([ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- dual-ship.sh: the download directories are created on EVERY host before the first upload ---"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
first="$(head -1 "$LOG")"
check "the first host contact is the mkdir preflight"       "$(has "$first" 'mkdir -p')" "$first"
check "for \$INSTALL_DIR/downloads/mobile"                  "$(has "$first" '/tmp/sandbox-install/downloads/mobile')" "$first"
check "and it precedes the first scp"                       "$([ "$(grep -n 'mkdir -p' "$LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n '^scp' "$LOG" | head -1 | cut -d: -f1)" ] && echo 1 || echo 0)" "$(cat "$LOG")"
out="$(ship apk "$TMP/app.apk" 9.9.9)"
check "the APK path preflights too"                         "$(has "$(head -1 "$LOG")" 'mkdir -p')" "$(head -1 "$LOG")"

echo
echo "--- dual-ship.sh: every artifact's SHA-256 is published and verified through the download host ---"
exe_sha="$(sha256sum "$TMP/setup.exe" | cut -d' ' -f1)"
printf '%s  Puca-Setup-9.9.9.exe\n%s  Puca-Setup.exe\n' "$exe_sha" "$exe_sha" > "$TMP/served-sums"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "the installer's hash is written to SHA256SUMS.txt on the host" "$(grep -q "SHA256SUMS.txt" "$LOG" && grep -q "$exe_sha  Puca-Setup.exe" "$LOG" && echo 1 || echo 0)" "$(grep SHA256 "$LOG")"
check "and the versioned name too"                                   "$(grep -q "$exe_sha  Puca-Setup-9.9.9.exe" "$LOG" && echo 1 || echo 0)"
check "and the SERVED file is checked for both"                      "$([ "$(has "$out" 'PASS  sandbox SHA256SUMS.txt lists Puca-Setup.exe')" = 1 ] && [ "$(has "$out" 'PASS  sandbox SHA256SUMS.txt lists Puca-Setup-9.9.9.exe')" = 1 ] && echo 1 || echo 0)" "$out"
check "the release notes and privacy statement ship beside it"       "$(grep -q 'CHANGELOG.md' "$LOG" && grep -q 'PRIVACY.md' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
# NEGATIVE CONTROL: a served file that does not carry the shipped hash is a FAIL.
printf '%s  Puca-Setup.exe\n' "0000000000000000000000000000000000000000000000000000000000000000" > "$TMP/served-sums"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "a served SHA256SUMS.txt with the wrong hash FAILS the ship"   "$(has "$out" 'FAIL  sandbox SHA256SUMS.txt does not list Puca-Setup.exe')" "$out"
apk_sha="$(sha256sum "$TMP/app.apk" | cut -d' ' -f1)"
printf '%s  mobile/Puca-9.9.9.apk\n' "$apk_sha" > "$TMP/served-sums"
out="$(ship apk "$TMP/app.apk" 9.9.9)"
check "the APK is listed under mobile/"                              "$(has "$out" 'PASS  sandbox SHA256SUMS.txt lists mobile/Puca-9.9.9.apk')" "$out"

echo
echo "--- a clone with no hosts.conf gets a sentence, not a bash error ---"
mv "$TMP/deploy/ops/hosts.conf" "$TMP/deploy/ops/hosts.conf.away"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "dual-ship.sh exits non-zero"                          "$([ $rc -ne 0 ] && echo 1 || echo 0)" "$out"
check "and says to copy hosts.conf.example"                  "$(has "$out" 'hosts.conf.example')" "$out"
check "and points at the README"                             "$(has "$out" 'deploy/ops/README.md')" "$out"
check "without a raw 'No such file' from source"             "$([ "$(has "$out" 'No such file or directory')" = 0 ] && echo 1 || echo 0)" "$out"
out="$(versions)"; rc=$?
check "check-versions.sh does the same"                      "$([ $rc -ne 0 ] && [ "$(has "$out" 'hosts.conf.example')" = 1 ] && echo 1 || echo 0)" "$out"
mv "$TMP/deploy/ops/hosts.conf.away" "$TMP/deploy/ops/hosts.conf"

echo
echo "--- a token nobody substituted must not reach a visitor either ---"
# The other way this page lies: an unsubstituted __TOKEN__ renders literally,
# so a button points at https://__APP_HOST__ and simply fails. Added when the
# page gained an "Open in your browser" link for iPhone/Mac visitors, whose
# href is exactly such a token.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
echo '<a href="https://__SOME_UNKNOWN_HOST__">Open in your browser</a>' >> "$TMP/deploy/download-site/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES a page with an unsubstituted token"          "$([ $rc -ne 0 ] && [ "$(has "$out" 'unsubstituted token')" = 1 ] && echo 1 || echo 0)" "$out"
check "naming the token it found"                           "$(has "$out" '__SOME_UNKNOWN_HOST__')" "$out"
check "and refuses BEFORE touching any host"                "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"

# POSITIVE CONTROL: the known tokens ARE substituted, so a normal page ships.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
rm -f "$TMP/uploaded/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "a page whose tokens are all known is NOT refused"    "$([ "$(has "$out" 'unsubstituted token')" = 0 ] && echo 1 || echo 0)" "$out"
check "and nothing __LIKE_THIS__ survives into it"          "$([ -f "$TMP/uploaded/index.html" ] && ! grep -qE '__[A-Z_]+__' "$TMP/uploaded/index.html" && echo 1 || echo 0)" "$(cat "$TMP/uploaded/index.html" 2>/dev/null | head -5)"

echo
echo "--- the iPhone section's QR code is made at render time, locally ---"
# __APP_QR_SVG__ is not a host, so render_download_page makes it with
# deploy/ops/make-qr-svg.mjs. Two ways to lie to a visitor: leave the token (the
# check above catches that) or ship an empty box where the code should be.
cp "$REPO/deploy/ops/make-qr-svg.mjs" "$TMP/deploy/ops/"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
echo '<figure class="qr">__APP_QR_SVG__</figure>' >> "$TMP/deploy/download-site/index.html"
rm -f "$TMP/uploaded/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "a page with the QR token is NOT refused"              "$([ "$(has "$out" 'unsubstituted token')" = 0 ] && [ "$(has "$out" 'could not make one')" = 0 ] && echo 1 || echo 0)" "$out"
check "its token became an inline SVG"                       "$([ -f "$TMP/uploaded/index.html" ] && grep -q '<figure class="qr"><svg xmlns=' "$TMP/uploaded/index.html" && echo 1 || echo 0)" "$(head -c 300 "$TMP/uploaded/index.html" 2>/dev/null)"
check "that encodes the web app's host, not a placeholder"   "$([ -f "$TMP/uploaded/index.html" ] && grep -q 'aria-label="QR code for app.invalid"' "$TMP/uploaded/index.html" && echo 1 || echo 0)" "$(grep -o 'aria-label="[^"]*"' "$TMP/uploaded/index.html" 2>/dev/null | head -2)"
check "and no token survives"                                "$([ -f "$TMP/uploaded/index.html" ] && ! grep -qE '__[A-Z_]+__' "$TMP/uploaded/index.html" && echo 1 || echo 0)"
rm -f "$TMP/deploy/ops/make-qr-svg.mjs"
: > "$LOG"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the QR maker is missing"                 "$([ $rc -ne 0 ] && [ "$(has "$out" 'could not make one')" = 1 ] && echo 1 || echo 0)" "$out"
check "before touching any host"                             "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe

echo
echo "--- the iPhone one-tap profile: rendered at ship time, served by the backend, proved on every host ---"
# The page links https://__API_HOST__/api/ios-web-clip. dual-ship.sh renders the
# profile (deploy/ops/make-web-clip-profile.mjs) from APP_HOST and the 180 px icon,
# puts it on every host, and demands that host's backend answers it as
# application/x-apple-aspen-config with the bytes it rendered, BEFORE any artifact
# or the page goes up. A page without the link is not touched by any of it.
cp "$REPO/deploy/ops/make-web-clip-profile.mjs" "$TMP/deploy/ops/"
mkdir -p "$TMP/frontend/public"
cp "$REPO/frontend/public/apple-touch-icon.png" "$TMP/frontend/public/"
page_with_clip() {
	page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
	echo '<a href="https://__API_HOST__/api/ios-web-clip">Install with one tap</a>' >> "$TMP/deploy/download-site/index.html"
}
node "$TMP/deploy/ops/make-web-clip-profile.mjs" https://app.invalid/ "$TMP/frontend/public/apple-touch-icon.png" > "$TMP/expected.mobileconfig"
# What the host's backend answers. The probe asks three things of it, each by its own
# curl: the status, the headers, the body. Anything else goes to the recording stub.
mv "$TMP/bin/ssh" "$TMP/bin/ssh.orig"
cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
case "\$*" in
	*"-D -"*ios-web-clip*) echo "ssh \$*" >> "$LOG"; printf 'HTTP/2 %s\r\ncontent-type: %s\r\nx-other: 1\r\n\r\n' "\$(cat "$TMP/clip_code")" "\$(cat "$TMP/clip_type")"; exit 0 ;;
	*http_code*ios-web-clip*) echo "ssh \$*" >> "$LOG"; cat "$TMP/clip_code"; exit 0 ;;
	*ios-web-clip.mobileconfig*) ;;
	*ios-web-clip*) echo "ssh \$*" >> "$LOG"; cat "$TMP/clip_body"; exit 0 ;;
esac
exec "$TMP/bin/ssh.orig" "\$@"
STUB
chmod +x "$TMP/bin/ssh"
serve_clip() { echo "$1" > "$TMP/clip_code"; echo "$2" > "$TMP/clip_type"; cp "$3" "$TMP/clip_body"; }

page_with_clip
rm -f "$TMP/deploy/ops/make-web-clip-profile.mjs"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES when the profile maker is missing"            "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && [ "$(has "$out" 'could not render the profile')" = 1 ] && echo 1 || echo 0)" "$out"
check "before touching any host"                             "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
cp "$REPO/deploy/ops/make-web-clip-profile.mjs" "$TMP/deploy/ops/"

cp "$TMP/frontend/public/apple-touch-icon.png" "$TMP/icon-180.png"
cp "$REPO/frontend/public/icon-192.png" "$TMP/frontend/public/apple-touch-icon.png"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "REFUSES an icon that is not 180x180, saying so"       "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING')" = 1 ] && [ "$(has "$out" 'must be 180x180')" = 1 ] && echo 1 || echo 0)" "$out"
check "before touching any host"                             "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
cp "$TMP/icon-180.png" "$TMP/frontend/public/apple-touch-icon.png"

# POSITIVE CONTROL: the backend serves it as iOS needs.
serve_clip 200 application/x-apple-aspen-config "$TMP/expected.mobileconfig"
rm -f "$TMP/uploaded/ios-web-clip.mobileconfig" "$TMP/uploaded/index.html"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "a backend that serves it right is NOT refused"        "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'FAIL  sandbox: api.invalid/api/ios-web-clip')" = 0 ] && echo 1 || echo 0)" "$out"
check "and each host is reported as serving the profile"     "$(has "$out" 'PASS  sandbox serves the iPhone profile at /api/ios-web-clip as application/x-apple-aspen-config')" "$out"
check "the profile went up beside the binary"                "$(grep -q 'ios-web-clip.mobileconfig' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
check "and it is the one rendered for the WEB APP host"      "$([ -f "$TMP/uploaded/ios-web-clip.mobileconfig" ] && cmp -s "$TMP/uploaded/ios-web-clip.mobileconfig" "$TMP/expected.mobileconfig" && grep -q '<string>https://app.invalid/</string>' "$TMP/uploaded/ios-web-clip.mobileconfig" && echo 1 || echo 0)"
check "before the first artifact"                            "$([ "$(grep -n 'ios-web-clip.mobileconfig' "$LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n 'Puca-Setup-dual.exe' "$LOG" | head -1 | cut -d: -f1)" ] && echo 1 || echo 0)" "$(cat "$LOG")"
check "and the page link is rendered, no token left"         "$([ -f "$TMP/uploaded/index.html" ] && grep -q 'href="https://api.invalid/api/ios-web-clip"' "$TMP/uploaded/index.html" && ! grep -qE '__[A-Z_]+__' "$TMP/uploaded/index.html" && echo 1 || echo 0)" "$(tail -3 "$TMP/uploaded/index.html" 2>/dev/null)"

# NEGATIVE CONTROLS: each of the three facts, wrong in turn. All stop the run
# before any artifact leaves, and say what to do.
serve_clip 200 text/xml "$TMP/expected.mobileconfig"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "FAILS when the type is not application/x-apple-aspen-config" "$([ $rc -ne 0 ] && [ "$(has "$out" "type 'text/xml'")" = 1 ] && echo 1 || echo 0)" "$out"
check "uploading no installer"                                      "$(grep -q 'Puca-Setup-dual.exe' "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"
serve_clip 404 "" "$TMP/expected.mobileconfig"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "FAILS on a 404 (a backend older than the route), saying to ship the backend first" "$([ $rc -ne 0 ] && [ "$(has "$out" "status '404'")" = 1 ] && [ "$(has "$out" 'ship the backend')" = 1 ] && echo 1 || echo 0)" "$out"
check "uploading no installer"                                      "$(grep -q 'Puca-Setup-dual.exe' "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"
printf 'something else\n' > "$TMP/other.mobileconfig"
serve_clip 200 application/x-apple-aspen-config "$TMP/other.mobileconfig"
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"; rc=$?
check "FAILS when the host serves different bytes than were rendered" "$([ $rc -ne 0 ] && [ "$(has "$out" 'hash match: NO')" = 1 ] && echo 1 || echo 0)" "$out"
check "uploading no installer"                                      "$(grep -q 'Puca-Setup-dual.exe' "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"
serve_clip 200 application/x-apple-aspen-config "$TMP/expected.mobileconfig"
out="$(ship apk "$TMP/app.apk" 9.9.9)"
check "the APK path proves it too"                                  "$(has "$out" 'PASS  sandbox serves the iPhone profile')" "$out"
serve_clip 404 "" "$TMP/expected.mobileconfig"
out="$(ship apk "$TMP/app.apk" 9.9.9)"; rc=$?
check "and refuses on a 404 the same way"                           "$([ $rc -ne 0 ] && [ "$(has "$out" "status '404'")" = 1 ] && echo 1 || echo 0)" "$out"

# A page without the link (an operator's own, or the template before this feature)
# neither renders nor uploads a profile, and so never depends on the route.
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe
out="$(ship installer "$TMP/setup.exe" "$TMP/setup.exe.sig" 9.9.9 "notes")"
check "a page that does not link the profile ships as before"       "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'iPhone profile')" = 0 ] && [ "$(has "$out" '=== installer 9.9.9 -> sandbox ===')" = 1 ] && echo 1 || echo 0)" "$out"
check "and no profile is uploaded or probed"                        "$(grep -q 'ios-web-clip' "$LOG" && echo 0 || echo 1)" "$(grep ios-web-clip "$LOG")"
mv -f "$TMP/bin/ssh.orig" "$TMP/bin/ssh"
rm -f "$TMP/deploy/ops/make-web-clip-profile.mjs"
page_with 9.9.9 Puca-Setup.exe Puca-Lite-Setup.exe

echo
echo "--- dual-ship.sh mobile: the manifest version must match the bundle's own .version sidecar ---"
# encrypt-bundle.mjs writes <bundle>.version from the build's version.json; a
# manifest that disagrees with it is the one-slip lockout 0.9.811 closes.
SK="$(head -c 369 /dev/zero | tr '\0' 'A')"; CK="$(head -c 512 /dev/zero | tr '\0' 'b')"
printf 'enc\n' > "$TMP/bundle.enc.zip"
rm -f "$TMP/bundle.enc.zip.version"
out="$(ship mobile "$TMP/bundle.enc.zip" 1.2.3 "$SK" "$CK")"
check "no sidecar at all REFUSES" "$(has "$out" "REFUSING: no $TMP/bundle.enc.zip.version sidecar")" "$out"
printf '1.2.4\n' > "$TMP/bundle.enc.zip.version"
out="$(ship mobile "$TMP/bundle.enc.zip" 1.2.3 "$SK" "$CK")"
check "a sidecar that disagrees REFUSES and names both versions" "$(has "$out" "REFUSING: the manifest says 1.2.3 but $TMP/bundle.enc.zip was built as 1.2.4")" "$out"
printf '1.2.3\n' > "$TMP/bundle.enc.zip.version"
out="$(ship mobile "$TMP/bundle.enc.zip" 1.2.3 "$SK" "$CK")"
check "a matching sidecar does NOT fire the refusal (positive control)" "$([ "$(has "$out" "REFUSING: the manifest says")" = 0 ] && [ "$(has "$out" "sidecar")" = 0 ] && echo 1 || echo 0)" "$out"
rm -f "$TMP/bundle.enc.zip.version"
out="$(PUCA_ALLOW_UNVERIFIED_BUNDLE=1 ship mobile "$TMP/bundle.enc.zip" 1.2.3 "$SK" "$CK")"
check "PUCA_ALLOW_UNVERIFIED_BUNDLE=1 downgrades a missing sidecar to a WARNING" "$([ "$(has "$out" "WARNING: shipping")" = 1 ] && [ "$(has "$out" "REFUSING: no")" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- dual-ship.sh webapp: the tarball must carry the Notes page, built against production ---"
mkweb() { # <dir> <with-notes 0|1> <api host baked into the Notes entry>
	local d="$1"; rm -rf "$d" "$d.tgz"; mkdir -p "$d/assets"
	echo '<script type="module" src="/assets/index-abc123.js"></script>' > "$d/index.html"
	echo 'const api="https://api.invalid";' > "$d/assets/index-abc123.js"
	if [ "$2" = 1 ]; then
		mkdir -p "$d/notes/assets"
		echo '<script type="module" src="/notes/assets/index-n0tes1.js"></script>' > "$d/notes/index.html"
		echo "const api=\"https://$3\";" > "$d/notes/assets/index-n0tes1.js"
	fi
	tar czf "$d.tgz" -C "$d" .
}
mkweb "$TMP/web-nonotes" 0 ""
out="$(ship webapp "$TMP/web-nonotes.tgz")"; rc=$?
check "REFUSES a web tarball with no Notes page" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING to ship: the tarball carries no Notes page')" = 1 ] && echo 1 || echo 0)" "$out"
check "and refuses BEFORE touching a host" "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
mkweb "$TMP/web-localnotes" 1 "localhost:3000"
out="$(ship webapp "$TMP/web-localnotes.tgz")"; rc=$?
check "REFUSES a Notes page built against localhost" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING to ship: Notes entry 'notes/assets/index-n0tes1.js'")" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
mkweb "$TMP/web-good" 1 "api.invalid"
out="$(ship webapp "$TMP/web-good.tgz")"
check "a tarball with a production Notes page passes the preflight (positive control)" "$([ "$(has "$out" 'PASS  bundle preflight: Notes entry notes/assets/index-n0tes1.js')" = 1 ] && [ "$(has "$out" 'REFUSING to ship')" = 0 ] && echo 1 || echo 0)" "$out"

echo
echo "--- dual-ship.sh backend: the migration pre-flight, including a rollback ---"
# A backend source tarball: migrations 001-002, and a migrator that does or
# does not tolerate a newer database (src/migrator.rs, ignore_missing). The
# stub ssh (above) answers the _sqlx_migrations query from $TMP/sqlx_rows, so each
# case is "what this host's database has applied". DUAL_SHIP_PREFLIGHT_ONLY
# stops after the pre-flight: nothing here builds or copies anything.
mksrc() { # <dir> <tolerant 0|1|comment|noflag>
	local d="$1"; rm -rf "$d" "$d.tgz"; mkdir -p "$d/migrations" "$d/src"
	printf 'CREATE TABLE a (id INT);\n' > "$d/migrations/001_a.sql"
	printf 'CREATE TABLE b (id INT);\n' > "$d/migrations/002_b.sql"
	case "$2" in
		1) printf 'pub fn app_migrator() { let mut m = sqlx::migrate!("./migrations"); m.set_ignore_missing(true); }\n' > "$d/src/migrator.rs"
		   printf 'fn main() {\n    migrator::app_migrator().run(&pool);\n}\n' > "$d/src/main.rs" ;;
		comment) printf 'pub fn app_migrator() { let mut m = sqlx::migrate!("./migrations"); m.set_ignore_missing(true); }\n' > "$d/src/migrator.rs"
		   printf 'fn main() {\n    // one day: migrator::app_migrator()\n    sqlx::migrate!("./migrations").run(&pool);\n}\n' > "$d/src/main.rs" ;;
		noflag) printf 'pub fn app_migrator() { sqlx::migrate!("./migrations") }\n' > "$d/src/migrator.rs"
		   printf 'fn main() {\n    migrator::app_migrator().run(&pool);\n}\n' > "$d/src/main.rs" ;;
		# The flag only in a comment: that binary still refuses a newer database.
		commentflag) printf 'pub fn app_migrator() {\n    let mut m = sqlx::migrate!("./migrations");\n    // m.set_ignore_missing(true);\n    m\n}\n' > "$d/src/migrator.rs"
		   printf 'fn main() {\n    migrator::app_migrator().run(&pool);\n}\n' > "$d/src/main.rs" ;;
		# What is actually in this tree: the check must pass its own source.
		real) cp "$REPO/src/migrator.rs" "$REPO/src/main.rs" "$d/src/" ;;
		# The real main.rs is past 50 KB with app_migrator() early in it. A
		# reader that stops at the first match while a writer still has most
		# of the file to send dies of SIGPIPE under pipefail, so this one is
		# padded to ~300 KB AFTER the call (well past a 64 KB pipe buffer).
		big) printf 'pub fn app_migrator() { let mut m = sqlx::migrate!("./migrations"); m.set_ignore_missing(true); }\n' > "$d/src/migrator.rs"
		   { printf 'fn main() {\n    migrator::app_migrator().run(&pool);\n'
		     local i; for i in $(seq 1 3000); do printf '    let padding_%05d = "the rest of a large main.rs, kept going well past the pipe buffer";\n' "$i"; done
		     printf '}\n'; } > "$d/src/main.rs" ;;
		*) printf 'fn main() {\n    sqlx::migrate!("./migrations").run(&pool);\n}\n' > "$d/src/main.rs" ;;
	esac
	tar czf "$d.tgz" -C "$d" migrations src
}
sum_of() { sha384sum "$1" | cut -d' ' -f1; }
preflight() { # <tarball>
	: > "$LOG"
	( cd "$TMP/deploy/ops" && PATH="$TMP/bin:$PATH" DUAL_SHIP_PREFLIGHT_ONLY=1 bash ./dual-ship.sh backend "$1" 2>&1 )
}
mksrc "$TMP/src-new" 1
mksrc "$TMP/src-old" 0
mksrc "$TMP/src-comment" comment
mksrc "$TMP/src-noflag" noflag
mksrc "$TMP/src-commentflag" commentflag
mksrc "$TMP/src-big" big
mksrc "$TMP/src-real" real
S1="$(sum_of "$TMP/src-new/migrations/001_a.sql")"; S2="$(sum_of "$TMP/src-new/migrations/002_b.sql")"

printf '1|%s\n2|%s\n' "$S1" "$S2" > "$TMP/sqlx_rows"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "a database at the tarball's own level passes (positive control)" "$([ $rc -eq 0 ] && [ "$(has "$out" 'PASS  sandbox migrations byte-match')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"
check "and the pre-flight-only run touches nothing past the query" "$([ "$(grep -c '^scp' "$LOG")" = 0 ] && echo 1 || echo 0)" "$(cat "$LOG")"

printf '1|%s\n2|%s\n3|%s\n' "$S1" "$S2" "$S2" > "$TMP/sqlx_rows"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "ROLLBACK: a newer applied version passes when the tarball's migrator tolerates it" "$([ $rc -eq 0 ] && [ "$(has "$out" 'NOTE  sandbox: applied version 3 is newer than this tarball')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"
out="$(preflight "$TMP/src-old.tgz")"; rc=$?
check "the same database REFUSES a tarball whose migrator predates ignore_missing" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && [ "$(has "$out" 'no migration file for applied version 3')" = 1 ] && [ "$(has "$out" 'needs the database dump')" = 1 ] && echo 1 || echo 0)" "$out"
out="$(preflight "$TMP/src-comment.tgz")"; rc=$?
check "and one whose main.rs only NAMES app_migrator in a comment" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && echo 1 || echo 0)" "$out"
out="$(preflight "$TMP/src-noflag.tgz")"; rc=$?
check "and one whose app_migrator does not set ignore_missing" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && echo 1 || echo 0)" "$out"
out="$(preflight "$TMP/src-commentflag.tgz")"; rc=$?
check "and one whose set_ignore_missing is commented out" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && [ "$(has "$out" 'no migration file for applied version 3')" = 1 ] && echo 1 || echo 0)" "$out"
# A pipe race passes most runs and fails some, so one green run proves little:
# the same rollback, twenty times in a row, with a main.rs far past 64 KB.
# This is the suite's slowest case by design (twenty full pre-flights, two
# tar extractions each); the count IS the proof (0/20 with the old pipeline),
# so do not trim it on runtime grounds.
big_ok=0; big_last=""
for _ in $(seq 1 20); do
	out="$(preflight "$TMP/src-big.tgz")"; rc=$?
	if [ $rc -eq 0 ] && [ "$(has "$out" 'NOTE  sandbox: applied version 3 is newer than this tarball')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ]; then
		big_ok=$((big_ok + 1))
	else
		big_last="$out"
	fi
done
check "ROLLBACK with a main.rs well past 64 KB passes 20 runs in a row ($big_ok/20)" "$([ "$big_ok" = 20 ] && echo 1 || echo 0)" "$big_last"
out="$(preflight "$TMP/src-real.tgz")"; rc=$?
check "ROLLBACK with this tree's own src/main.rs and src/migrator.rs passes" "$([ $rc -eq 0 ] && [ "$(has "$out" 'NOTE  sandbox: applied version 3 is newer than this tarball')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"

printf '1|%s\n2|%s\n3|%s\n' "$S1" "0000" "$S2" > "$TMP/sqlx_rows"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "a tolerant tarball still REFUSES a checksum mismatch" "$([ $rc -ne 0 ] && [ "$(has "$out" 'migration v2 (002_b.sql) does not byte-match')" = 1 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && echo 1 || echo 0)" "$out"

# SOURCE_COMMIT: a tarball that does not say which commit it is ships a
# backend whose GET /source says "unknown" (0.9.8, 0.9.817). A FULL run (not
# pre-flight only) must refuse it before any upload; the same tarball with a
# commit id gets past the guard (positive control). Nothing is built either
# way: the stub scp never produces a binary, so the positive run stops at the
# build, after the guard has spoken.
printf '1|%s\n2|%s\n' "$S1" "$S2" > "$TMP/sqlx_rows"
fullship() { : > "$LOG"; ( cd "$TMP/deploy/ops" && PATH="$TMP/bin:$PATH" bash ./dual-ship.sh backend "$1" 2>&1 ); }
out="$(fullship "$TMP/src-new.tgz")"; rc=$?
check "a backend tarball with no SOURCE_COMMIT is REFUSED" "$([ $rc -ne 0 ] && [ "$(has "$out" 'carries no SOURCE_COMMIT')" = 1 ] && echo 1 || echo 0)" "$out"
check "and nothing was uploaded" "$([ "$(grep -c '^scp' "$LOG")" = 0 ] && echo 1 || echo 0)" "$(cat "$LOG")"
printf 'not-a-commit\n' > "$TMP/src-new/SOURCE_COMMIT"; tar czf "$TMP/src-badcommit.tgz" -C "$TMP/src-new" migrations src SOURCE_COMMIT
out="$(fullship "$TMP/src-badcommit.tgz")"; rc=$?
check "and so is one whose SOURCE_COMMIT is not a commit id" "$([ $rc -ne 0 ] && [ "$(has "$out" 'carries no SOURCE_COMMIT')" = 1 ] && echo 1 || echo 0)" "$out"
printf '0123456789abcdef0123456789abcdef01234567\n' > "$TMP/src-new/SOURCE_COMMIT"; tar czf "$TMP/src-withcommit.tgz" -C "$TMP/src-new" migrations src SOURCE_COMMIT
out="$(fullship "$TMP/src-withcommit.tgz")"
check "one that names its commit gets past the guard (positive control)" "$([ "$(has "$out" 'PASS  the tarball names its commit: 0123456789abcdef0123456789abcdef01234567')" = 1 ] && [ "$(has "$out" 'carries no SOURCE_COMMIT')" = 0 ] && echo 1 || echo 0)" "$out"
rm -f "$TMP/src-new/SOURCE_COMMIT" /tmp/puca-dual-bin

# AN UNREADABLE HISTORY IS NOT A MATCHING ONE. The query's exit status used to
# be ignored: a failed read left nothing on stdout, zero rows "matched", and
# the pre-flight printed PASS for a history nobody had seen — in the rollback
# check (PREFLIGHT_ONLY) too. Each way the read can fail must now refuse.
printf '1|%s\n2|%s\n' "$S1" "$S2" > "$TMP/sqlx_rows"
unread_refused() { # <output> <rc>
	[ "$2" -ne 0 ] && [ "$(has "$1" 'could not read _sqlx_migrations')" = 1 ] && [ "$(has "$1" 'REFUSING to ship')" = 1 ] \
		&& [ "$(has "$1" 'PASS  sandbox migrations byte-match')" = 0 ] && [ "$(has "$1" 'PASS  pre-flight only')" = 0 ] && echo 1 || echo 0
}
touch "$TMP/sqlx_fail"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "a history psql cannot read (exit 2, no rows) REFUSES the pre-flight" "$(unread_refused "$out" $rc)" "rc=$rc $out"
out="$(fullship "$TMP/src-withcommit.tgz")"; rc=$?
check "and a full ship, before anything is uploaded" "$([ "$(unread_refused "$out" $rc)" = 1 ] && [ "$(grep -c '^scp' "$LOG")" = 0 ] && echo 1 || echo 0)" "rc=$rc $out"
rm -f "$TMP/sqlx_fail"
touch "$TMP/ssh_down"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "a host ssh cannot reach (exit 255) REFUSES the pre-flight" "$(unread_refused "$out" $rc)" "rc=$rc $out"
rm -f "$TMP/ssh_down"
touch "$TMP/ssh_silent"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "an answer with no end marker (status 0, nothing on stdout) REFUSES the pre-flight" "$(unread_refused "$out" $rc)" "rc=$rc $out"
rm -f "$TMP/ssh_silent"
# A database nothing has migrated yet is its own case, handled on purpose: a
# freshly provisioned host (provision.sh makes an EMPTY database) passes with a
# NOTE; the same answer from a host that already runs a backend means DB_NAME
# names some other database, and the check would be comparing nothing.
rm -f "$TMP/sqlx_rows"; rm -rf "$TMP/remote-install"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "no _sqlx_migrations table and no backend installed (a fresh host) passes, with a NOTE" "$([ $rc -eq 0 ] && [ "$(has "$out" "NOTE  sandbox: database 'sandbox' has no _sqlx_migrations table and no backend is installed")" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "rc=$rc $out"
# ...and says it compared nothing: a fresh host is not a byte-match, and the
# pre-flight summary must not claim one.
check "a fresh host reports 'nothing to compare', not 'migrations byte-match'" "$([ "$(has "$out" 'PASS  sandbox nothing to compare (fresh host, no migration history yet)')" = 1 ] && [ "$(has "$out" 'migrations byte-match')" = 0 ] && echo 1 || echo 0)" "rc=$rc $out"
mkdir -p "$TMP/remote-install"; printf 'binary\n' > "$TMP/remote-install/sandbox"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "no _sqlx_migrations table on a host WITH a backend installed REFUSES (wrong DB_NAME)" "$([ $rc -ne 0 ] && [ "$(has "$out" "database 'sandbox' has no _sqlx_migrations table, but a backend is installed")" = 1 ] && [ "$(has "$out" 'or the backend installed there has never started against it')" = 1 ] && [ "$(has "$out" 'REFUSING to ship')" = 1 ] && [ "$(has "$out" 'PASS  sandbox migrations byte-match')" = 0 ] && echo 1 || echo 0)" "rc=$rc $out"
# ...and with the history readable again, the installed host passes: the
# end-marker parsing leaves the last real row intact.
printf '1|%s\n2|%s\n' "$S1" "$S2" > "$TMP/sqlx_rows"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "a readable history on the same host still passes (positive control)" "$([ $rc -eq 0 ] && [ "$(has "$out" 'PASS  sandbox migrations byte-match')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "rc=$rc $out"
printf '1|%s\n2|%s\n' "$S1" "0000" > "$TMP/sqlx_rows"
out="$(preflight "$TMP/src-new.tgz")"; rc=$?
check "and a mismatch in the LAST row, just above the end marker, is still caught" "$([ $rc -ne 0 ] && [ "$(has "$out" 'migration v2 (002_b.sql) does not byte-match')" = 1 ] && echo 1 || echo 0)" "rc=$rc $out"
rm -rf "$TMP/remote-install"

rm -f "$TMP/src-new/migrations/002_b.sql"
printf '1|%s\n2|%s\n' "$S1" "$S2" > "$TMP/sqlx_rows"
printf 'CREATE TABLE c (id INT);\n' > "$TMP/src-new/migrations/003_c.sql"; tar czf "$TMP/src-gap.tgz" -C "$TMP/src-new" migrations src
out="$(preflight "$TMP/src-gap.tgz")"; rc=$?
check "a missing version BELOW the tarball's newest is refused even when tolerant (not a rollback)" "$([ $rc -ne 0 ] && [ "$(has "$out" 'no migration file for applied version 2')" = 1 ] && echo 1 || echo 0)" "$out"
rm -f "$TMP/sqlx_rows"

echo
echo "--- encrypt-bundle.mjs: a bundle that still carries notes/ is never signed ---"
# The OTA serves every file in the zip from the WebView's one origin, and the
# Notes page has no CSP meta of its own. The staging recipe removes it by hand;
# the signer is the gate. Fixture zips come from python's zipfile (Git Bash has
# no zip); `python` first, because on Windows `python3` can be the Store stub.
PY=""
for c in python python3; do if "$c" -c 'import zipfile' >/dev/null 2>&1; then PY="$c"; break; fi; done
if [ -z "$PY" ]; then
	check "python (zipfile) is available to build the fixture bundles" 0 "neither python nor python3 runs"
else
	EB="$REPO/deploy/mobile/encrypt-bundle.mjs"
	node -e "const{generateKeyPairSync}=require('crypto');const{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});require('fs').writeFileSync(process.argv[1],privateKey.export({type:'pkcs1',format:'pem'}))" "$TMP/ota-fixture.key"
	echo '{"version":"1.2.3"}' > "$TMP/ota-version.json"
	"$PY" - "$TMP" <<'PYEOF'
import sys, zipfile
t = sys.argv[1]
def mk(name, entries):
    with zipfile.ZipFile(t + '/' + name, 'w', zipfile.ZIP_DEFLATED) as z:
        for e in entries:
            z.writestr(e, 'x' * 64)
# Names that merely CONTAIN "notes" must not trip the gate (over-match control).
mk('ota-clean.zip', ['index.html', 'assets/notes-helper.js', 'release-notes/readme.txt', 'version.json'])
mk('ota-dirty.zip', ['index.html', 'notes/index.html', 'notes/assets/index-n0tes1.js'])
mk('ota-dirty-dot.zip', ['index.html', './notes/assets/a.js'])
# An archive comment carrying a fake, all-zero end-of-central-directory record.
# A backward scan meets it first; trusted, it says "0 entries" and the notes/
# filter passes a dirty bundle.
with zipfile.ZipFile(t + '/ota-dirty-comment.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', 'x' * 64); z.writestr('notes/index.html', 'x' * 64)
    z.comment = b'PK\x05\x06' + b'\x00' * 40
with zipfile.ZipFile(t + '/ota-clean-comment.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', 'x' * 64)
    z.comment = b'PK\x05\x06' + b'\x00' * 40
open(t + '/ota-notazip.zip', 'wb').write(b'this is not a zip archive at all, only some bytes ' * 4)
PYEOF
	out="$(node "$EB" "$TMP/ota-dirty.zip" "$TMP/ota-fixture.key" "$TMP/ota-dirty.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "REFUSES (exit 2) a bundle with notes/ entries and names one" "$([ $rc -eq 2 ] && [ "$(has "$out" 'contains 2 notes/ entries (e.g. notes/index.html)')" = 1 ] && echo 1 || echo 0)" "rc=$rc $out"
	check "and writes NOTHING: no encrypted bundle, no .version sidecar" "$([ ! -e "$TMP/ota-dirty.enc.zip" ] && [ ! -e "$TMP/ota-dirty.enc.zip.version" ] && echo 1 || echo 0)" "$(ls "$TMP" | grep ota-dirty)"
	out="$(node "$EB" "$TMP/ota-dirty-dot.zip" "$TMP/ota-fixture.key" "$TMP/ota-dirty-dot.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "a ./notes/ spelling is refused too" "$([ $rc -eq 2 ] && [ ! -e "$TMP/ota-dirty-dot.enc.zip" ] && echo 1 || echo 0)" "rc=$rc $out"
	out="$(node "$EB" "$TMP/ota-dirty-comment.zip" "$TMP/ota-fixture.key" "$TMP/ota-dirty-comment.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "a fake end record in the archive comment does not hide notes/" "$([ $rc -eq 2 ] && [ "$(has "$out" 'contains 1 notes/ entry (e.g. notes/index.html)')" = 1 ] && [ ! -e "$TMP/ota-dirty-comment.enc.zip" ] && echo 1 || echo 0)" "rc=$rc $out"
	out="$(node "$EB" "$TMP/ota-clean-comment.zip" "$TMP/ota-fixture.key" "$TMP/ota-clean-comment.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "and the same comment on a clean bundle still signs (the check is not 'any comment')" "$([ $rc -eq 0 ] && [ -s "$TMP/ota-clean-comment.enc.zip" ] && echo 1 || echo 0)" "rc=$rc $out"
	out="$(node "$EB" "$TMP/ota-notazip.zip" "$TMP/ota-fixture.key" "$TMP/ota-notazip.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "a file whose entry list cannot be read is refused, not signed" "$([ $rc -eq 2 ] && [ "$(has "$out" 'Refusing to sign what cannot be checked')" = 1 ] && [ ! -e "$TMP/ota-notazip.enc.zip" ] && echo 1 || echo 0)" "rc=$rc $out"
	out="$(node "$EB" "$TMP/ota-clean.zip" "$TMP/ota-fixture.key" "$TMP/ota-clean.enc.zip" "$TMP/ota-version.json" 2>&1)"; rc=$?
	check "a clean bundle is signed, 'notes' inside another name notwithstanding (positive control)" "$([ $rc -eq 0 ] && [ -s "$TMP/ota-clean.enc.zip" ] && [ "$(cat "$TMP/ota-clean.enc.zip.version" 2>/dev/null | tr -d '\r\n')" = "1.2.3" ] && [ "$(has "$out" 'ivSessionKey')" = 1 ] && echo 1 || echo 0)" "rc=$rc $out"
fi

echo
echo "--- dual-ship.sh mobile / mobile-notes: the right app, the right key ---"
# Real signed bundles, made by the real signer with the fixture keys above.
if [ -z "$PY" ]; then
	check "python (zipfile) is available to build the fixture bundles" 0 "neither python nor python3 runs"
else
	restore_recording_ssh() {
		cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in
	# The download host's copy of an OTA bundle is \$TMP/served-bundle: its
	# status, and what the remote \`curl … | sha256sum\` would print for it.
	*curl*http_code*.enc.zip*) if [ -f "$TMP/served-code" ]; then cat "$TMP/served-code"; elif [ -f "$TMP/served-bundle" ]; then echo 200; else echo 404; fi ;;
	*curl*.enc.zip*sha256sum*) if [ -f "$TMP/served-bundle" ]; then sha256sum < "$TMP/served-bundle"; else sha256sum < /dev/null; fi | cut -d' ' -f1 ;;
	*http_code*variant=notes*) if [ -f "$TMP/notes-code" ]; then cat "$TMP/notes-code"; elif [ -f "$TMP/notes-ota.json" ]; then echo 200; else echo 404; fi ;;
	*variant=notes*) cat "$TMP/notes-ota.json" 2>/dev/null ;;
	*'test -e '*mobile-update-notes.json*) if [ -f "$TMP/notes-file" ]; then echo present; else echo absent; fi ;;
esac
exit 0
STUB
		chmod +x "$TMP/bin/ssh"
	}
	restore_recording_ssh
	echo '{"version":"9.9.9","app":"notes","nativeMin":"9.9.7","nativeLatest":"9.9.8"}' > "$TMP/notes-version.json"
	echo '{"version":"9.9.9","app":"puca"}' > "$TMP/puca-version.json"
	"$PY" - "$TMP" <<'PYEOF'
import sys, zipfile
t = sys.argv[1]
csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
with zipfile.ZipFile(t + '/notes-app.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', '<html><head>' + csp + '</head></html>')
    z.writestr('version.json', '{"version":"9.9.9","app":"notes","nativeMin":"9.9.7","nativeLatest":"9.9.8"}')
with zipfile.ZipFile(t + '/puca-app.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', '<html><head></head></html>')
    z.writestr('version.json', '{"version":"9.9.9","app":"puca"}')
PYEOF
	signed() { # <var-prefix> <flag|""> <zip> <key> <version.json>
		local json
		json="$(node "$EB" $2 "$3" "$4" "$TMP/$1.enc.zip" "$5" 2>&1)" || { echo "signing $1 failed: $json" >&2; return 1; }
		eval "${1//-/_}_SK=\"$(printf '%s' "$json" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["ivSessionKey"])')\""
		eval "${1//-/_}_CK=\"$(printf '%s' "$json" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["checksum"])')\""
	}
	signed notes-good --notes "$TMP/notes-app.zip" "$TMP/notes-fixture.key" "$TMP/notes-version.json"
	# The Notes build signed with PÚCA's key: channel says notes, the key is wrong.
	signed notes-wrongkey --notes "$TMP/notes-app.zip" "$TMP/puca-fixture.key" "$TMP/notes-version.json"
	signed puca-good "" "$TMP/puca-app.zip" "$TMP/puca-fixture.key" "$TMP/puca-version.json"
	check "the signer writes the Notes bundle's native floor beside it" "$([ "$(tr -d '\r\n' < "$TMP/notes-good.enc.zip.native-min" 2>/dev/null)" = 9.9.7 ] && [ ! -e "$TMP/puca-good.enc.zip.native-min" ] && echo 1 || echo 0)" "$(ls "$TMP" | grep native-min)"
	check "and the newest native APK (native-min.json \"latest\") beside that" "$([ "$(tr -d '\r\n' < "$TMP/notes-good.enc.zip.native-latest" 2>/dev/null)" = 9.9.8 ] && [ ! -e "$TMP/puca-good.enc.zip.native-latest" ] && echo 1 || echo 0)" "$(ls "$TMP" | grep native-latest)"

	out="$(ship mobile "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile REFUSES a Púca Notes bundle, and names mobile-notes" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: $TMP/notes-good.enc.zip was signed for the 'notes' app")" = 1 ] && [ "$(has "$out" 'dual-ship.sh mobile-notes')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile-lite "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-lite REFUSES it too" "$([ $rc -ne 0 ] && [ "$(has "$out" "signed for the 'notes' app")" = 1 ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile "$TMP/puca-good.enc.zip" 9.9.9 "$puca_good_SK" "$puca_good_CK")"
	check "mobile verifies a Púca bundle under Púca's key and ships it (positive control)" "$([ "$(has "$out" 'PASS  OK ')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && grep -q 'mobile-update.json' "$LOG" && echo 1 || echo 0)" "$out"

	out="$(ship mobile-notes "$TMP/puca-good.enc.zip" 9.9.9 "$puca_good_SK" "$puca_good_CK")"; rc=$?
	check "mobile-notes REFUSES a Púca bundle" "$([ $rc -ne 0 ] && [ "$(has "$out" "signed for the 'puca' app")" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	cp "$TMP/notes-good.enc.zip" "$TMP/nochan.enc.zip"; cp "$TMP/notes-good.enc.zip.version" "$TMP/nochan.enc.zip.version"
	out="$(ship mobile-notes "$TMP/nochan.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a bundle with no .channel sidecar" "$([ $rc -ne 0 ] && [ "$(has "$out" 'nothing says this is a Púca Notes bundle')" = 1 ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile-notes "$TMP/notes-wrongkey.enc.zip" 9.9.9 "$notes_wrongkey_SK" "$notes_wrongkey_CK")"; rc=$?
	check "mobile-notes REFUSES a Notes bundle signed with Púca's key" "$([ $rc -ne 0 ] && [ "$(has "$out" 'does not verify under the key the Púca Notes app embeds')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version)"; rc=$?
	check "mobile-notes REFUSES a --native-version with no value (and does not loop on it)" "$([ $rc -eq 2 ] && [ "$(has "$out" 'REFUSING: --native-version needs a value')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "rc=$rc $out"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version --lower-native-min)"; rc=$?
	check "mobile-notes REFUSES a --native-version whose 'value' is the next flag (never swallows --lower-native-min)" "$([ $rc -eq 2 ] && [ "$(has "$out" "got the flag '--lower-native-min'")" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "rc=$rc $out"
	# The floor is not a flag any more: a flag applied to ONE release, and the
	# next release shipped without it published no floor at all.
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-min 9.9.9)"; rc=$?
	check "mobile-notes REFUSES --native-min and points at native-min.json" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: --native-min is gone')" = 1 ] && [ "$(has "$out" 'notes-app/native-min.json')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nomin() { cp "$TMP/notes-good.enc.zip" "$TMP/$1.enc.zip"; cp "$TMP/notes-good.enc.zip.version" "$TMP/$1.enc.zip.version"; cp "$TMP/notes-good.enc.zip.channel" "$TMP/$1.enc.zip.channel"; }
	nomin nomin
	out="$(ship mobile-notes "$TMP/nomin.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a bundle with no .native-min sidecar" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: no '"$TMP"'/nomin.enc.zip.native-min')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nomin typo; printf '9.9.9160\n' > "$TMP/typo.enc.zip.native-min"
	out="$(ship mobile-notes "$TMP/typo.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a native.min newer than the release (the 0.9.9160 typo)" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: native.min 9.9.9160')" = 1 ] && [ "$(has "$out" 'is newer than this release (9.9.9)')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nomin next; printf '9.9.10\n' > "$TMP/next.enc.zip.native-min"
	out="$(ship mobile-notes "$TMP/next.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "and one naming the NEXT release" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: native.min 9.9.10')" = 1 ] && echo 1 || echo 0)" "$out"
	# native.version rides with the bundle the same way (<bundle>.native-latest).
	nolatest() { nomin "$1"; cp "$TMP/notes-good.enc.zip.native-min" "$TMP/$1.enc.zip.native-min"; }
	nolatest nolatest
	out="$(ship mobile-notes "$TMP/nolatest.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a bundle with no .native-latest sidecar" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: no '"$TMP"'/nolatest.enc.zip.native-latest')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nolatest badlatest; printf '9.9\n' > "$TMP/badlatest.enc.zip.native-latest"
	out="$(ship mobile-notes "$TMP/badlatest.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a malformed .native-latest" "$([ $rc -ne 0 ] && [ "$(has "$out" "native-latest says '9.9', not a MAJOR.MINOR.PATCH version")" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nolatest nextlatest; printf '9.9.10\n' > "$TMP/nextlatest.enc.zip.native-latest"
	out="$(ship mobile-notes "$TMP/nextlatest.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a native.version newer than the release (no such APK is on the page)" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: native.version 9.9.10')" = 1 ] && [ "$(has "$out" 'is newer than this release (9.9.9)')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	nolatest oldlatest; printf '9.9.6\n' > "$TMP/oldlatest.enc.zip.native-latest"
	out="$(ship mobile-notes "$TMP/oldlatest.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a native.version older than its own native.min" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: native.version 9.9.6')" = 1 ] && [ "$(has "$out" 'is older than its native.min 9.9.7')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.8 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a manifest version the bundle was not built as" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: the manifest says 9.9.8 but')" = 1 ] && echo 1 || echo 0)" "$out"

	# What a backend from before the notes route answers on ?variant=notes:
	# Púca's FULL manifest, untagged, for the SAME release number — so the
	# version alone would read as a successful ship. Only the tag tells.
	printf '{"version":"9.9.9","url":"x"}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a good Notes bundle passes every gate and is uploaded" "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'PASS  OK ')" = 1 ] && grep -q 'puca-notes-web-9.9.9.enc.zip' "$LOG" && echo 1 || echo 0)" "$out"
	check "its manifest is mobile-update-notes.json, tagged notes, with the bundle's native floor" "$(grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -q '"variant": "notes"' "$LOG" && grep -q '"min": "9.9.7"' "$LOG" && grep -q '"version": "9.9.9",' "$LOG" && grep -q '"download_url": "https://dl.invalid/#notes-app"' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	# min (9.9.7), latest (9.9.8) and the release (9.9.9) are all different,
	# so neither a swap of the two native fields nor the release number in
	# either can pass.
	check "and native.version is the bundle's newest native APK (9.9.8), NOT the release (9.9.9)" "$(grep -A3 '"native": {' "$LOG" | grep -q '"version": "9.9.8",' && ! grep -A3 '"native": {' "$LOG" | grep -q '"version": "9.9.9"' && echo 1 || echo 0)" "$(cat "$LOG")"
	check "and the native block is exactly min 9.9.7 + version 9.9.8 (not swapped)" "$([ "$(grep -A2 '"native": {' "$LOG" | tr -d ' \r\n')" = '"native":{"min":"9.9.7","version":"9.9.8",' ] && echo 1 || echo 0)" "$(grep -A3 '"native": {' "$LOG")"
	check "it never writes the full or lite manifest" "$(! grep -q 'cat > mobile-update.json' "$LOG" && ! grep -q 'cat > mobile-update-lite.json' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	check "an UNTAGGED answer on ?variant=notes FAILS and says to ship the backend first" "$([ $rc -ne 0 ] && [ "$(has "$out" 'WITHOUT "variant":"notes"')" = 1 ] && [ "$(has "$out" 'Ship the backend first')" = 1 ] && echo 1 || echo 0)" "$out"
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.7","version":"9.9.8"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"
	check "a tagged answer with the version PASSES (positive control)" "$([ "$(has "$out" 'PASS  sandbox notes OTA endpoint reports 9.9.9 with variant:notes')" = 1 ] && [ "$(has "$out" 'mobile-notes-variant')" = 0 ] && echo 1 || echo 0)" "$out"
	# THE FLOOR CARRIES OVER. The release after the one that raised it is
	# shipped with the plain recipe — no flags — and must still publish it.
	check "with NO flags the manifest still carries native.min from the bundle (the floor carries over)" "$(grep -q '"native": {' "$LOG" && grep -q '"min": "9.9.7"' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	check "and the served floor is verified back" "$([ "$(has "$out" 'PASS  sandbox notes OTA endpoint serves native.min 9.9.7')" = 1 ] && [ "$(has "$out" 'mobile-notes-native-min')" = 0 ] && echo 1 || echo 0)" "$out"
	check "and the served native.version is verified back" "$([ "$(has "$out" 'PASS  sandbox notes OTA endpoint serves native.version 9.9.8')" = 1 ] && [ "$(has "$out" 'mobile-notes-native-version')" = 0 ] && echo 1 || echo 0)" "$out"
	# TRANSITION. The out-of-repo release tools still pass --native-version
	# "$VER", and mobile-notes is the LAST step of ship-clients.sh: refusing
	# the flag there would abort a release after every other surface shipped.
	# So it is ignored, loudly, and the sidecar wins.
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version 9.9.9)"; rc=$?
	check "a stray --native-version (the release tools' \"\$VER\") is IGNORED with a warning, and the ship goes through (exit code not asserted: this stub serves no SHA256SUMS.txt)" "$([ "$(has "$out" 'WARNING: --native-version 9.9.9 IGNORED')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'PASS  sandbox notes OTA endpoint serves native.version 9.9.8')" = 1 ] && echo 1 || echo 0)" "rc=$rc $out"
	check "and the manifest still carries the sidecar's native.version (9.9.8), not the flag's" "$(grep -A3 '"native": {' "$LOG" | grep -q '"version": "9.9.8",' && ! grep -A3 '"native": {' "$LOG" | grep -q '"version": "9.9.9"' && echo 1 || echo 0)" "$(cat "$LOG")"
	# The FIRST release after native.version stopped being the release number
	# publishes the tree's 0.9.827 to hosts serving 0.9.830. Lowering it is the
	# point, so nothing may refuse it (the floor, native.min, still only rises).
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.7","version":"9.9.9"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a native.version LOWER than a host serves ships (no monotonic rule on the nudge)" "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'WARNING')" = 0 ] && grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -A3 '"native": {' "$LOG" | grep -q '"version": "9.9.8",' && echo 1 || echo 0)" "$out"
	check "and a host still serving the old native.version after the write FAILS the ship" "$([ $rc -ne 0 ] && [ "$(has "$out" "FAIL  sandbox notes OTA endpoint serves native.version '9.9.9', expected 9.9.8")" = 1 ] && [ "$(has "$out" 'sandbox:mobile-notes-native-version')" = 1 ] && echo 1 || echo 0)" "$out"
	printf '{"version":"9.9.9","url":"x","variant":"notes"}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a host that serves NO floor after the write FAILS the ship" "$([ $rc -ne 0 ] && [ "$(has "$out" "FAIL  sandbox notes OTA endpoint serves native.min '<none>', expected 9.9.7")" = 1 ] && [ "$(has "$out" 'sandbox:mobile-notes-native-min')" = 1 ] && echo 1 || echo 0)" "$out"

	# THE FLOOR ONLY GOES UP. A host already serving a HIGHER native.min
	# means this bundle would re-expose every APK in between.
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.9"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES to lower the native.min a host serves" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: this bundle'"'"'s native.min 9.9.7 is LOWER than a host already serves (sandbox serves 9.9.9)')" = 1 ] && echo 1 || echo 0)" "$out"
	check "and writes nothing: no upload, no manifest" "$(! grep -q '^scp' "$LOG" && ! grep -q 'cat > mobile-update-notes.json' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --lower-native-min)"; rc=$?
	check "--lower-native-min lowers it on purpose, and says so" "$([ "$(has "$out" 'WARNING: lowering native.min to 9.9.7 (sandbox serves 9.9.9)')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -q '"min": "9.9.7"' "$LOG" && echo 1 || echo 0)" "$out"
	# Only a TAGGED answer is a floor: an old backend's untagged answer is Púca's.
	printf '{"version":"9.9.9","url":"x","native":{"min":"9.9.9"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"
	check "an UNTAGGED answer's min is not read as a floor (control)" "$([ "$(has "$out" 'LOWER than a host')" = 0 ] && grep -q 'cat > mobile-update-notes.json' "$LOG" && echo 1 || echo 0)" "$out"
	# A host whose current manifest cannot be read cannot be proved safe.
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in *variant=notes*) exit 255 ;; esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "an unreadable host REFUSES the ship before anything is written" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: could not read sandbox's current Notes manifest")" = 1 ] && ! grep -q '^scp' "$LOG" && echo 1 || echo 0)" "$out"
	restore_recording_ssh

	# A host whose backend is restarting answers 502 with Caddy's HTML page.
	# That is not "no floor served": it proves nothing, so it must refuse, and
	# so must a 200 whose body is not a JSON manifest. Only a 404 (no Notes
	# manifest on that host yet) is an answer with no floor in it.
	printf '<html><body>502 Bad Gateway</body></html>\n' > "$TMP/notes-ota.json"
	echo 502 > "$TMP/notes-code"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a host answering 502 on ?variant=notes REFUSES the ship before anything is written" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: sandbox answered HTTP 502 for its current Notes manifest")" = 1 ] && ! grep -q '^scp' "$LOG" && ! grep -q 'cat > mobile-update-notes.json' "$LOG" && echo 1 || echo 0)" "$out"
	echo 503 > "$TMP/notes-code"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "and one answering 503" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: sandbox answered HTTP 503")" = 1 ] && ! grep -q '^scp' "$LOG" && echo 1 || echo 0)" "$out"
	echo 200 > "$TMP/notes-code"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "and a 200 whose body is an HTML page, not a manifest" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: sandbox answered its Notes manifest with something that is not JSON")" = 1 ] && ! grep -q '^scp' "$LOG" && echo 1 || echo 0)" "$out"
	# The backend also answers 404 for a manifest file it cannot parse
	# (src/update_routes.rs serve_json_file), and a corrupt manifest still
	# carried a floor: a 404 makes the ship probe the file, and only a
	# missing file means "no floor".
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.7","version":"9.9.8"}}
' > "$TMP/notes-ota.json"
	echo 404 > "$TMP/notes-code"
	touch "$TMP/notes-file"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a 404 with the manifest FILE still on the host (corrupt) REFUSES before anything is written" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: sandbox answers 404 for its Notes manifest, but')" = 1 ] && [ "$(has "$out" 'mobile-update-notes.json exists on it')" = 1 ] && ! grep -q '^scp' "$LOG" && echo 1 || echo 0)" "$out"
	rm -f "$TMP/notes-file"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "and a 404 with no file (before the first Notes OTA) ships: no floor to keep (positive control)" "$(grep -q 'test -e' "$LOG" && grep -q 'cat > mobile-update-notes.json' "$LOG" && [ "$(has "$out" 'PASS  sandbox notes OTA endpoint serves native.min 9.9.7')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && echo 1 || echo 0)" "$out"
	rm -f "$TMP/notes-code"
	rm -f "$TMP/notes-code" "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a 404 (no Notes manifest on the host yet) proceeds to write one (positive control)" "$([ "$(has "$out" 'REFUSING')" = 0 ] && grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -q '"min": "9.9.7"' "$LOG" && echo 1 || echo 0)" "$out"

	# THE ISOLATION CHECK MUST BE ABLE TO FAIL. The recording stub answers the
	# full and lite endpoints with the same (empty) body before and after, so
	# a check that compared nothing would pass there too. Here the stub's full
	# (then lite) answer changes between the two reads.
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.7","version":"9.9.8"}}\n' > "$TMP/notes-ota.json"
	for which in full lite; do
		rm -f "$TMP/reads"
		cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in
	*http_code*variant=notes*) echo 200 ;;
	*variant=notes*) cat "$TMP/notes-ota.json" ;;
	*variant=lite*) [ "$which" = lite ] && { n=\$(( \$(cat "$TMP/reads" 2>/dev/null || echo 0) + 1 )); echo \$n > "$TMP/reads"; echo "{\"version\":\"9.9.\$n\",\"variant\":\"lite\"}"; } ;;
	*mobile-updates/check*) [ "$which" = full ] && { n=\$(( \$(cat "$TMP/reads" 2>/dev/null || echo 0) + 1 )); echo \$n > "$TMP/reads"; echo "{\"version\":\"9.9.\$n\"}"; } ;;
esac
exit 0
STUB
		chmod +x "$TMP/bin/ssh"
		out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
		check "a $which endpoint that CHANGES during a Notes ship FAILS mobile-notes-isolation" "$([ $rc -ne 0 ] && [ "$(has "$out" 'FAIL  sandbox the full or lite OTA endpoint CHANGED during a Notes ship')" = 1 ] && [ "$(has "$out" 'sandbox:mobile-notes-isolation')" = 1 ] && echo 1 || echo 0)" "$out"
	done
	restore_recording_ssh
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"
	check "and the unchanged endpoints PASS it (positive control)" "$([ "$(has "$out" 'PASS  sandbox full and lite OTA endpoints undisturbed')" = 1 ] && [ "$(has "$out" 'mobile-notes-isolation')" = 0 ] && echo 1 || echo 0)" "$out"
	rm -f "$TMP/notes-ota.json" "$TMP/reads"

	# THE BYTES, NOT JUST THE STATUS. The three OTA paths used to accept any
	# 200 at the bundle's URL, so a download host serving OTHER bytes there (a
	# hand-edited per-path reroot) read as shipped while every phone refused
	# the update. The installer and APK paths already compared hashes. The
	# stub serves $TMP/served-bundle at the bundle URL. (Every run here also
	# FAILs SHA256SUMS.txt — this stub serves none — so the exit code proves
	# nothing: the assertions are on the bundle lines.)
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.7","version":"9.9.8"}}\n' > "$TMP/notes-ota.json"
	for sub in mobile mobile-lite mobile-notes; do
		case "$sub" in
			mobile)       b=puca-good;  b_sk="$puca_good_SK";  b_ck="$puca_good_CK";  what='bundle';       id=mobile-bundle ;;
			mobile-lite)  b=puca-good;  b_sk="$puca_good_SK";  b_ck="$puca_good_CK";  what='lite bundle';  id=mobile-lite-bundle ;;
			mobile-notes) b=notes-good; b_sk="$notes_good_SK"; b_ck="$notes_good_CK"; what='notes bundle'; id=mobile-notes-bundle ;;
		esac
		printf 'a stale bundle, not the one that was signed\n' > "$TMP/served-bundle"
		out="$(ship "$sub" "$TMP/$b.enc.zip" 9.9.9 "$b_sk" "$b_ck")"
		check "$sub: a bundle URL answering 200 with OTHER bytes FAILS $id" "$([ "$(has "$out" "=== mobile OTA")" = 1 ] && [ "$(has "$out" "FAIL  sandbox $what served sha256")" = 1 ] && [ "$(has "$out" "sandbox:$id")" = 1 ] && [ "$(has "$out" "PASS  sandbox $what ")" = 0 ] && echo 1 || echo 0)" "$out"
		cp "$TMP/$b.enc.zip" "$TMP/served-bundle"
		out="$(ship "$sub" "$TMP/$b.enc.zip" 9.9.9 "$b_sk" "$b_ck")"
		check "$sub: the signed bundle's own bytes PASS (positive control)" "$([ "$(has "$out" "PASS  sandbox $what served byte-identical")" = 1 ] && [ "$(has "$out" "sandbox:$id")" = 0 ] && echo 1 || echo 0)" "$out"
		# The RIGHT bytes under a failing status (a proxy that answers the
		# archive with a 404 or 500 page code): the hash matches, and the
		# first cut of this check stopped there and printed PASS, but the
		# phone's downloader refuses anything but a 200.
		echo 404 > "$TMP/served-code"
		out="$(ship "$sub" "$TMP/$b.enc.zip" 9.9.9 "$b_sk" "$b_ck")"
		check "$sub: the right bytes under HTTP 404 FAIL $id" "$([ "$(has "$out" "FAIL  sandbox $what answered HTTP 404")" = 1 ] && [ "$(has "$out" "sandbox:$id")" = 1 ] && [ "$(has "$out" "PASS  sandbox $what ")" = 0 ] && echo 1 || echo 0)" "$out"
		rm -f "$TMP/served-code"
	done
	rm -f "$TMP/served-bundle" "$TMP/served-code" "$TMP/notes-ota.json"
fi

echo
echo "--- dual-ship.sh decky: the Steam Deck plugin, linked, signed, newer ---"
# Installed plugins install an update only when it verifies under the key they
# carry (integrations/decky/src/update.ts). dual-ship.sh checks that against
# the release the download site offers NOW, with the release verifier, before
# it uploads anything. Releases here are made by the release script's own
# signer (scripts/signing.mjs) with throwaway keys.
if [ -z "$PY" ]; then
	check "python (zipfile) is available to build the fixture plugin zips" 0 "neither python nor python3 runs"
else
	mkdir -p "$TMP/integrations/decky/scripts" "$TMP/integrations/decky/py_modules" "$TMP/deck"
	cp "$REPO/integrations/decky/scripts/verify_update.py" "$TMP/integrations/decky/scripts/"
	cp "$REPO/integrations/decky/py_modules/puca_update.py" "$TMP/integrations/decky/py_modules/"
	SIGNER="$REPO/integrations/decky/scripts/signing.mjs"
	deck_key() { # <name>: $TMP/deck/<name>.pem and its public half, <name>.json
		node --input-type=module -e "
			import { generateKeyPairSync } from 'node:crypto'; import { writeFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url';
			const m = await import(pathToFileURL(process.argv[1]).href);
			const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
			writeFileSync(process.argv[2], pem); writeFileSync(process.argv[3], JSON.stringify(m.publicJwk(pem)));
		" "$SIGNER" "$TMP/deck/$1.pem" "$TMP/deck/$1.json"
	}
	deck_release() { # <version> <signing key> <embedded key, or none> <dir>: <dir>/puca-decky-<version>.zip + <dir>/puca-decky.json
		mkdir -p "$4"
		"$PY" - "$1" "$( [ "$3" = none ] || echo "$TMP/deck/$3.json")" "$4" <<'PYEOF'
import json, sys, zipfile
version, key, out = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(f"{out}/puca-decky-{version}.zip", "w") as z:
    z.writestr("puca/package.json", json.dumps({"name": "puca-decky", "version": version}))
    if key:
        z.writestr("puca/update-key.json", open(key, encoding="utf-8").read())
PYEOF
		node --input-type=module -e "
			import { readFileSync, writeFileSync } from 'node:fs'; import { basename } from 'node:path'; import { pathToFileURL } from 'node:url';
			const m = await import(pathToFileURL(process.argv[1]).href);
			const [zip, version, pem, out] = process.argv.slice(2);
			writeFileSync(out, JSON.stringify(m.signRelease(readFileSync(zip), basename(zip), version, readFileSync(pem))));
		" "$SIGNER" "$4/puca-decky-$1.zip" "$1" "$TMP/deck/$2.pem" "$4/puca-decky.json"
	}
	deck_page() { # <plugin version on the page> [nolink]
		{
			echo '<html><body>'
			[ "${2:-}" = nolink ] || echo '<a href="/steam-deck/puca-decky.zip">Púca for Steam Deck</a>'
			echo "<div class=\"meta\">v$1 &middot; Steam Deck</div>"
			echo '</body></html>'
		} > "$TMP/deploy/download-site/index.html"
	}
	# The download host: $TMP/deck/published.zip is what it offers now (none: 404).
	cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in
	*curl*http_code*steam-deck/puca-decky.zip*) if [ -f "$TMP/deck/code" ]; then cat "$TMP/deck/code"; elif [ -f "$TMP/deck/published.zip" ]; then echo 200; else echo 404; fi ;;
	*curl*steam-deck/*sha256sum*) sha256sum < /dev/null | cut -d' ' -f1 ;;
	*curl*steam-deck/puca-decky.zip*) cat "$TMP/deck/published.zip" 2>/dev/null ;;
esac
exit 0
STUB
	chmod +x "$TMP/bin/ssh"
	deck_key a; deck_key b
	deck_release 0.1.0 a a "$TMP/deck/a-0.1.0"
	deck_release 0.2.0 a a "$TMP/deck/a-0.2.0"
	deck_release 0.2.0 b b "$TMP/deck/b-0.2.0"
	deck_release 0.3.0 a a "$TMP/deck/a-0.3.0"
	deck_release 0.2.0 a none "$TMP/deck/keyless-0.2.0"
	good=("$TMP/deck/a-0.2.0/puca-decky-0.2.0.zip" "$TMP/deck/a-0.2.0/puca-decky.json")

	deck_page 0.2.0 nolink
	out="$(ship decky "${good[@]}")"; rc=$?
	check "REFUSES when the page does not link the plugin" "$([ $rc -ne 0 ] && [ "$(has "$out" 'does not link steam-deck/puca-decky.zip')" = 1 ] && echo 1 || echo 0)" "$out"
	check "and refuses BEFORE touching any host"           "$([ ! -s "$LOG" ] && echo 1 || echo 0)" "$(cat "$LOG")"
	deck_page 0.1.0
	out="$(ship decky "${good[@]}")"; rc=$?
	check "REFUSES when the page names another plugin version" "$([ $rc -ne 0 ] && [ "$(has "$out" 'does not name v0.2.0')" = 1 ] && echo 1 || echo 0)" "$out"

	deck_page 0.2.0
	rm -f "$TMP/deck/published.zip" "$TMP/deck/code"
	out="$(ship decky "${good[@]}")"
	check "the first release ever (nothing published) is NOT refused" "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'this is the first')" = 1 ] && [ "$(has "$out" '=== Steam Deck plugin 0.2.0 -> sandbox ===')" = 1 ] && echo 1 || echo 0)" "$out"
	check "and uploads the manifest AFTER the zip"                   "$(awk '/scp .*puca-decky-0\.2\.0\.zip/{z=NR} /scp .*puca-decky\.json\.new/{m=NR} END{print (z && m && z < m) ? 1 : 0}' "$LOG")" "$(cat "$LOG")"

	cp "$TMP/deck/a-0.1.0/puca-decky-0.1.0.zip" "$TMP/deck/published.zip"
	out="$(ship decky "${good[@]}")"
	check "a newer release under the published key is NOT refused (positive control)" "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'installed plugins will accept it')" = 1 ] && echo 1 || echo 0)" "$out"
	out="$(ship decky "$TMP/deck/b-0.2.0/puca-decky-0.2.0.zip" "$TMP/deck/b-0.2.0/puca-decky.json")"; rc=$?
	check "REFUSES a release signed with another key than the published one" "$([ $rc -ne 0 ] && [ "$(has "$out" 'installed plugins would refuse it')" = 1 ] && echo 1 || echo 0)" "$out"
	check "and uploads nothing"                                              "$(grep -q '^scp ' "$LOG" && echo 0 || echo 1)" "$(cat "$LOG")"

	cp "$TMP/deck/a-0.3.0/puca-decky-0.3.0.zip" "$TMP/deck/published.zip"
	out="$(ship decky "${good[@]}")"; rc=$?
	check "REFUSES a release that is not newer than the published one" "$([ $rc -ne 0 ] && [ "$(has "$out" 'is not newer than the published 0.3.0')" = 1 ] && echo 1 || echo 0)" "$out"

	rm -f "$TMP/deck/published.zip"
	out="$(ship decky "$TMP/deck/keyless-0.2.0/puca-decky-0.2.0.zip" "$TMP/deck/keyless-0.2.0/puca-decky.json")"; rc=$?
	check "REFUSES a zip built without the update key" "$([ $rc -ne 0 ] && [ "$(has "$out" 'no update-key.json')" = 1 ] && echo 1 || echo 0)" "$out"
	cp "$TMP/deck/a-0.2.0/puca-decky.json" "$TMP/deck/tampered.json"
	"$PY" -c "import json,sys; m=json.load(open(sys.argv[1])); m['sha256']='0'*64; json.dump(m, open(sys.argv[1],'w'))" "$TMP/deck/tampered.json"
	out="$(ship decky "$TMP/deck/a-0.2.0/puca-decky-0.2.0.zip" "$TMP/deck/tampered.json")"; rc=$?
	check "REFUSES a manifest that does not match its zip" "$([ $rc -ne 0 ] && [ "$(has "$out" "manifest's SHA-256 is not the zip's")" = 1 ] && echo 1 || echo 0)" "$out"

	echo 500 > "$TMP/deck/code"
	out="$(ship decky "${good[@]}")"; rc=$?
	check "REFUSES when the published release cannot be read" "$([ $rc -ne 0 ] && [ "$(has "$out" 'could not read the published Steam Deck plugin')" = 1 ] && echo 1 || echo 0)" "$out"
	rm -f "$TMP/deck/code"
	restore_recording_ssh 2>/dev/null || true
fi

if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all ship-gate checks passed"
