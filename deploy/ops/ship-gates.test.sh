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
	*app.invalid*) echo '<script src="/assets/index-abc123.js"></script>'
	                echo 'content-security-policy: default-src self' ;;
	*latest-lite.json*) ;;
	*latest.json*) echo '{"version":"9.9.9"}' ;;
	*app-version*) echo '{"version":"9.9.9"}' ;;
	*variant=notes*) cat "$TMP/notes-ota.json" 2>/dev/null ;;
	*mobile-updates/check*) echo '{"version":"9.9.9"}' ;;
	*http_code*) echo 200 ;;
	*dl.invalid*) echo '<a href="/mobile/Puca-9.9.9.apk">a</a>'
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
exit 0
STUB
chmod +x "$TMP/bin/ssh"
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
case "\$*" in *variant=notes*) cat "$TMP/notes-ota.json" 2>/dev/null ;; esac
exit 0
STUB
		chmod +x "$TMP/bin/ssh"
	}
	restore_recording_ssh
	echo '{"version":"9.9.9","app":"notes","nativeMin":"9.9.8"}' > "$TMP/notes-version.json"
	echo '{"version":"9.9.9","app":"puca"}' > "$TMP/puca-version.json"
	"$PY" - "$TMP" <<'PYEOF'
import sys, zipfile
t = sys.argv[1]
csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
with zipfile.ZipFile(t + '/notes-app.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('index.html', '<html><head>' + csp + '</head></html>')
    z.writestr('version.json', '{"version":"9.9.9","app":"notes","nativeMin":"9.9.8"}')
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
	check "the signer writes the Notes bundle's native floor beside it" "$([ "$(tr -d '\r\n' < "$TMP/notes-good.enc.zip.native-min" 2>/dev/null)" = 9.9.8 ] && [ ! -e "$TMP/puca-good.enc.zip.native-min" ] && echo 1 || echo 0)" "$(ls "$TMP" | grep native-min)"

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
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version 9.9)"; rc=$?
	check "mobile-notes REFUSES a malformed native version" "$([ $rc -ne 0 ] && [ "$(has "$out" "REFUSING: '9.9' is not a MAJOR.MINOR.PATCH version")" = 1 ] && echo 1 || echo 0)" "$out"
	# The floor is not a flag any more: a flag applied to ONE release, and the
	# next release shipped without it published no floor at all.
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-min 9.9.9)"; rc=$?
	check "mobile-notes REFUSES --native-min and points at native-min.json" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: --native-min is gone')" = 1 ] && [ "$(has "$out" 'notes-app/native-min.json')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version 9.9.10)"; rc=$?
	check "mobile-notes REFUSES a --native-version newer than the release" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: --native-version 9.9.10 is newer than this release (9.9.9)')" = 1 ] && [ ! -s "$LOG" ] && echo 1 || echo 0)" "$out"
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
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.8 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES a manifest version the bundle was not built as" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: the manifest says 9.9.8 but')" = 1 ] && echo 1 || echo 0)" "$out"

	# What a backend from before the notes route answers on ?variant=notes:
	# Púca's FULL manifest, untagged, for the SAME release number — so the
	# version alone would read as a successful ship. Only the tag tells.
	printf '{"version":"9.9.9","url":"x"}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --native-version 9.9.9)"; rc=$?
	check "a good Notes bundle passes every gate and is uploaded" "$([ "$(has "$out" 'REFUSING')" = 0 ] && [ "$(has "$out" 'PASS  OK ')" = 1 ] && grep -q 'puca-notes-web-9.9.9.enc.zip' "$LOG" && echo 1 || echo 0)" "$out"
	check "its manifest is mobile-update-notes.json, tagged notes, with the bundle's native floor" "$(grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -q '"variant": "notes"' "$LOG" && grep -q '"min": "9.9.8"' "$LOG" && grep -q '"version": "9.9.9",' "$LOG" && grep -q '"download_url": "https://dl.invalid/#notes-app"' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	check "it never writes the full or lite manifest" "$(! grep -q 'cat > mobile-update.json' "$LOG" && ! grep -q 'cat > mobile-update-lite.json' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	check "an UNTAGGED answer on ?variant=notes FAILS and says to ship the backend first" "$([ $rc -ne 0 ] && [ "$(has "$out" 'WITHOUT "variant":"notes"')" = 1 ] && [ "$(has "$out" 'Ship the backend first')" = 1 ] && echo 1 || echo 0)" "$out"
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.8"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"
	check "a tagged answer with the version PASSES (positive control)" "$([ "$(has "$out" 'PASS  sandbox notes OTA endpoint reports 9.9.9 with variant:notes')" = 1 ] && [ "$(has "$out" 'mobile-notes-variant')" = 0 ] && echo 1 || echo 0)" "$out"
	# THE FLOOR CARRIES OVER. The release after the one that raised it is
	# shipped with the plain recipe — no flags — and must still publish it.
	check "with NO flags the manifest still carries native.min from the bundle (the floor carries over)" "$(grep -q '"native": {' "$LOG" && grep -q '"min": "9.9.8"' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	check "and the served floor is verified back" "$([ "$(has "$out" 'PASS  sandbox notes OTA endpoint serves native.min 9.9.8')" = 1 ] && [ "$(has "$out" 'mobile-notes-native-min')" = 0 ] && echo 1 || echo 0)" "$out"
	printf '{"version":"9.9.9","url":"x","variant":"notes"}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "a host that serves NO floor after the write FAILS the ship" "$([ $rc -ne 0 ] && [ "$(has "$out" "FAIL  sandbox notes OTA endpoint serves native.min '<none>', expected 9.9.8")" = 1 ] && [ "$(has "$out" 'sandbox:mobile-notes-native-min')" = 1 ] && echo 1 || echo 0)" "$out"

	# THE FLOOR ONLY GOES UP. A host already serving a HIGHER native.min
	# means this bundle would re-expose every APK in between.
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.9"}}\n' > "$TMP/notes-ota.json"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK")"; rc=$?
	check "mobile-notes REFUSES to lower the native.min a host serves" "$([ $rc -ne 0 ] && [ "$(has "$out" 'REFUSING: this bundle'"'"'s native.min 9.9.8 is LOWER than a host already serves (sandbox serves 9.9.9)')" = 1 ] && echo 1 || echo 0)" "$out"
	check "and writes nothing: no upload, no manifest" "$(! grep -q '^scp' "$LOG" && ! grep -q 'cat > mobile-update-notes.json' "$LOG" && echo 1 || echo 0)" "$(cat "$LOG")"
	out="$(ship mobile-notes "$TMP/notes-good.enc.zip" 9.9.9 "$notes_good_SK" "$notes_good_CK" --lower-native-min)"; rc=$?
	check "--lower-native-min lowers it on purpose, and says so" "$([ "$(has "$out" 'WARNING: lowering native.min to 9.9.8 (sandbox serves 9.9.9)')" = 1 ] && [ "$(has "$out" 'REFUSING')" = 0 ] && grep -q 'cat > mobile-update-notes.json' "$LOG" && grep -q '"min": "9.9.8"' "$LOG" && echo 1 || echo 0)" "$out"
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

	# THE ISOLATION CHECK MUST BE ABLE TO FAIL. The recording stub answers the
	# full and lite endpoints with the same (empty) body before and after, so
	# a check that compared nothing would pass there too. Here the stub's full
	# (then lite) answer changes between the two reads.
	printf '{"version":"9.9.9","url":"x","variant":"notes","native":{"min":"9.9.8"}}\n' > "$TMP/notes-ota.json"
	for which in full lite; do
		rm -f "$TMP/reads"
		cat > "$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
echo "ssh \$*" >> "$LOG"
case "\$*" in
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
fi

if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all ship-gate checks passed"
