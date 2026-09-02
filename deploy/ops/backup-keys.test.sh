#!/usr/bin/env bash
# Tests for backup-keys.sh, run against FIXTURE files — never your real keys.
#
# Runs anywhere bash + tar + sha256sum exist, including Git Bash on Windows.
# Same reasoning as deploy/migrate/render-turn-conf.test.sh: this script is
# exercised once, by hand, at the moment you most need it to be right, and its
# failure mode (a bundle that looks fine and cannot restore anything) is silent.
#
#   ./backup-keys.test.sh
#
# WHAT IT PINS
#   1. Two bundles, and the SPLIT holds: no password in the keys tar, no key
#      material in the passwords tar. A key and its passphrase in one archive
#      is a key with no passphrase.
#   2. Both tars are mode 600 — from creation (umask 077), not chmod-ed after.
#   3. A missing key is still a non-zero exit, and ALLOW_MISSING=1 still
#      overrides it. That behaviour predates the split and must survive it.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/backup-keys.sh"

fails=0
check() { if [ "$2" = 1 ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  — $3}"; fails=$((fails + 1)); fi; }
yes_no() { [ "$1" = 0 ] && echo 1 || echo 0; }   # exit code -> 1 when it succeeded

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A fixture "key home" and a fixture HOME, so the Android paths resolve into
# the sandbox too. Every file has content: the script skips empty ones.
FAKE_HOME="$TMP/home"
KEYS="$FAKE_HOME/.puca"
mkdir -p "$KEYS" "$FAKE_HOME/.android" "$TMP/repo/frontend/src-tauri/.tauri"
printf 'not-a-real-key\n'        > "$KEYS/tauri-updater.key"
printf 'not-a-real-password\n'   > "$KEYS/tauri-updater.key.password"
printf 'not-a-real-rsa\n'        > "$KEYS/mobile-updater-rsa.key"
printf 'not-a-real-pub\n'        > "$KEYS/mobile-updater-rsa.pub"
printf 'not-a-real-cfkey\n'      > "$KEYS/cf-origin-key.pem"
printf 'not-a-real-cfcert\n'     > "$KEYS/cf-origin-cert.pem"
printf 'not-a-real-fcm\n'        > "$KEYS/fcm-service-account.json"
printf 'not-a-real-gservices\n'  > "$KEYS/google-services.json"
printf 'not-a-real-keystore\n'   > "$FAKE_HOME/.android/puca-release.keystore"
printf 'storePassword=nope\n'    > "$FAKE_HOME/.android/puca-keystore.properties"

OUT="$TMP/out"
run() { HOME="$FAKE_HOME" REPO="$TMP/repo" KEY_HOME="$KEYS" OUT_DIR="$OUT" bash "$SCRIPT" "$@"; }

echo "--- complete fixture set ---"
# umask 000 deliberately: if the script relied on the CALLER's umask rather
# than setting its own, the mode assertions below would catch it.
out="$(umask 000; run 2>&1)"; rc=$?
check "exits 0 when every key is present" "$(yes_no $rc)" "$out"

keys_tar="$(ls "$OUT"/puca-keys-*.tar 2>/dev/null | head -1)"
pw_tar="$(ls "$OUT"/puca-key-passwords-*.tar 2>/dev/null | head -1)"
check "writes a keys bundle"      "$([ -f "$keys_tar" ] && echo 1 || echo 0)"
check "writes a passwords bundle" "$([ -f "$pw_tar" ] && echo 1 || echo 0)"
check "no staging directory is left behind" "$([ -z "$(ls -d "$OUT"/stage-* 2>/dev/null)" ] && echo 1 || echo 0)"

if [ -f "$keys_tar" ] && [ -f "$pw_tar" ]; then
	keys_list="$(tar -tf "$keys_tar")"
	pw_list="$(tar -tf "$pw_tar")"

	check "keys bundle holds the updater key"   "$(printf '%s\n' "$keys_list" | grep -qx './tauri-updater.key' && echo 1 || echo 0)"
	check "keys bundle holds the keystore"      "$(printf '%s\n' "$keys_list" | grep -qx './release.keystore' && echo 1 || echo 0)"
	# THE POINT OF THE SPLIT.
	check "keys bundle holds NO password"       "$(printf '%s\n' "$keys_list" | grep -qE '\.password$|keystore\.properties$' && echo 0 || echo 1)" \
		"$(printf '%s\n' "$keys_list" | grep -E '\.password$|keystore\.properties$' || true)"
	check "passwords bundle holds the passphrase" "$(printf '%s\n' "$pw_list" | grep -qx './tauri-updater.key.password' && echo 1 || echo 0)"
	check "passwords bundle holds keystore.properties" "$(printf '%s\n' "$pw_list" | grep -qx './keystore.properties' && echo 1 || echo 0)"
	check "passwords bundle holds NO key material" "$(printf '%s\n' "$pw_list" | grep -qE '\.key$|\.keystore$|\.pem$' && echo 0 || echo 1)" \
		"$(printf '%s\n' "$pw_list" | grep -E '\.key$|\.keystore$|\.pem$' || true)"
	check "each bundle carries its own manifest" \
		"$(printf '%s\n' "$keys_list" | grep -qx './MANIFEST.txt' && printf '%s\n' "$pw_list" | grep -qx './MANIFEST.txt' && echo 1 || echo 0)"

	# Permissions, in two independent places, because they fail differently.
	#
	# (a) The tarballs themselves. This is what leaves the machine.
	# (b) The modes RECORDED INSIDE the tar, which are the modes the staged
	#     copies had while they existed. That is the half `umask 077` buys and
	#     a post-hoc `chmod` on the tarball cannot: without the umask the stage
	#     dir and every plaintext key in it are world-readable for the life of
	#     the run. The whole test runs under `umask 000`, so if the script did
	#     not set its own, these entries would come out group/other-readable.
	#
	# stat's flags differ across platforms and Git Bash reports a synthetic
	# mode, so a SKIP is honest where the filesystem cannot express it rather
	# than a green tick that proves nothing. On Linux — where these bundles
	# actually get made — both are real assertions.
	if [ "$(uname -s)" = "Linux" ]; then
		check "keys bundle is mode 600"      "$([ "$(stat -c %a "$keys_tar")" = 600 ] && echo 1 || echo 0)" "got $(stat -c %a "$keys_tar")"
		check "passwords bundle is mode 600" "$([ "$(stat -c %a "$pw_tar")" = 600 ] && echo 1 || echo 0)" "got $(stat -c %a "$pw_tar")"
		leaky="$(tar -tvf "$keys_tar" | awk '{print $1}' | grep -vE '^.rw.------$' || true)"
		check "nothing inside the keys bundle was group/other-readable" \
			"$([ -z "$leaky" ] && echo 1 || echo 0)" "$(printf '%s' "$leaky" | tr '\n' ' ')"
		leaky_pw="$(tar -tvf "$pw_tar" | awk '{print $1}' | grep -vE '^.rw.------$' || true)"
		check "nothing inside the passwords bundle was group/other-readable" \
			"$([ -z "$leaky_pw" ] && echo 1 || echo 0)" "$(printf '%s' "$leaky_pw" | tr '\n' ' ')"
	else
		echo "SKIP  file-mode assertions (no POSIX modes here: $(uname -s))"
	fi
fi

echo
echo "--- a missing key is still fatal ---"
rm -f "$OUT"/*.tar
rm -f "$KEYS/mobile-updater-rsa.key"
out="$(run 2>&1)"; rc=$?
check "exits non-zero when a key is missing" "$([ $rc -ne 0 ] && echo 1 || echo 0)"
check "says which one"                       "$(printf '%s' "$out" | grep -q 'MISSING  mobile-updater-rsa.key' && echo 1 || echo 0)"

rm -f "$OUT"/*.tar
out="$(ALLOW_MISSING=1 run 2>&1)"; rc=$?
check "ALLOW_MISSING=1 still overrides"      "$(yes_no $rc)" "$out"

echo
if [ "$fails" -gt 0 ]; then
	echo "$fails FAILED"
	exit 1
fi
echo "all backup-keys.sh checks passed"
