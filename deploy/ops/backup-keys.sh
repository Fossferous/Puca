#!/usr/bin/env bash
# Gather every irreplaceable signing/identity key into ONE artifact so it can be
# moved to durable off-machine storage. Run on the DEV machine (Git Bash on
# Windows or any bash) — these keys live on the developer box, not the server.
#
# Losing any one of these permanently breaks that distribution channel:
#   - Tauri updater key  -> desktop auto-update dies; users must manually reinstall
#   - mobile OTA RSA key -> no new signed OTA bundle can EVER be produced; a new
#                           signed APK (new embedded key) is the only recovery
#   - Android keystore   -> cannot publish an APK update under the same identity;
#                           a new keystore = new app identity (fresh install)
#   - CF origin key      -> re-issuable from the Cloudflare dashboard, but bundled
#                           here so a restore is one step
#
# WHY EVERY PATH IS A LIST, AND WHY MISSING IS FATAL
#
# Key files are named after whatever the project was called when they were
# generated, and they are never regenerated — that is the entire point of them.
# So each entry lists the names it may legitimately have and takes the first
# that exists.
#
# Getting that wrong used to be silent. The script found nothing, wrote a
# tarball containing only a manifest of "*** MISSING ***" lines, printed a
# WARNING, and exited 0. You would then encrypt it, ship it offsite, delete the
# plaintext, and believe you had a backup. This has already happened once in a
# narrower form: a bundle reported per-file success while omitting the Tauri
# updater key entirely, which is why this now verifies the TAR CONTENTS rather
# than trusting that `cp` did what the log said.
#
# A missing key is therefore a non-zero exit. Set ALLOW_MISSING=1 only when you
# genuinely mean "back up what exists".
#
# The bundle contains PLAINTEXT private keys. It is written OUTSIDE the repo and
# is NOT transmitted anywhere. Encrypt it before it leaves your control (e.g.
#   gpg -c <bundle>.tar   ->  .tar.gpg
#   7z a -p <bundle>.7z <bundle>.tar
# ) and store the result in a password-manager file vault / offline encrypted
# drive — somewhere that is NOT this one machine.
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
ALLOW_MISSING="${ALLOW_MISSING:-0}"

# Where the loose keys live. First one that exists wins.
KEY_HOME="${KEY_HOME:-}"
if [ -z "$KEY_HOME" ]; then
	for cand in "$HOME/.puca" "$HOME/.sovereign"; do
		[ -d "$cand" ] && { KEY_HOME="$cand"; break; }
	done
fi
KEY_HOME="${KEY_HOME:-$HOME/.puca}"

OUT_DIR="${OUT_DIR:-$KEY_HOME/key-backups}"
TS=$(date +%Y%m%d-%H%M%S)
STAGE="$OUT_DIR/stage-$TS"

TAURI_DIR="$REPO/frontend/src-tauri/.tauri"

# name!!candidate-path[!!candidate-path...]!!description
# '!!' because Windows paths contain no '!' but do contain ':' and '\'.
KEYS=(
	"tauri-updater.key!!$TAURI_DIR/puca-updater.key!!$TAURI_DIR/sovereign-updater.key!!$KEY_HOME/tauri-updater.key!!Tauri desktop updater private key (minisign)"
	"tauri-updater.key.password!!$TAURI_DIR/puca-updater.key.password!!$TAURI_DIR/sovereign-updater.key.password!!$KEY_HOME/tauri-updater.key.password!!Password for the Tauri updater key"
	"mobile-updater-rsa.key!!$KEY_HOME/mobile-updater-rsa.key!!Mobile OTA signing key (Capgo RSA private)"
	"mobile-updater-rsa.pub!!$KEY_HOME/mobile-updater-rsa.pub!!Mobile OTA public key (embedded in the APK)"
	"cf-origin-key.pem!!$KEY_HOME/cf-origin-key.pem!!Cloudflare Origin CA private key (re-issuable from dashboard)"
	"cf-origin-cert.pem!!$KEY_HOME/cf-origin-cert.pem!!Cloudflare Origin CA certificate"
	"release.keystore!!$HOME/.android/puca-release.keystore!!$HOME/.android/sovereign-release.keystore!!Android release signing keystore"
	"keystore.properties!!$HOME/.android/puca-keystore.properties!!$HOME/.android/sovereign-keystore.properties!!Android keystore store/key passwords + alias"
	"fcm-service-account.json!!$KEY_HOME/fcm-service-account.json!!FCM wake-doorbell credential (re-issuable from Firebase Console; sends only the constant signal)"
	"google-services.json!!$KEY_HOME/google-services.json!!Firebase Android config (re-downloadable; baked into the APK)"
)

mkdir -p "$STAGE"
MANIFEST="$STAGE/MANIFEST.txt"
{
	echo "Puca signing-key backup — $TS"
	echo "Restore each file to the path shown. Keep this bundle ENCRYPTED and OFF this machine."
	echo
} > "$MANIFEST"

missing=0
declare -a EXPECTED=()
for entry in "${KEYS[@]}"; do
	# Split on '!!' into: name, candidate paths..., description (last field).
	# NOT `IFS='!!' read`: bash reads IFS as a SET of single characters, so '!!'
	# means '!' and every field would split twice into empties.
	mapfile -t parts < <(printf '%s\n' "$entry" | sed 's/!!/\n/g')
	name="${parts[0]}"
	desc="${parts[${#parts[@]}-1]}"
	found=""
	for ((i = 1; i < ${#parts[@]} - 1; i++)); do
		if [ -s "${parts[$i]}" ]; then found="${parts[$i]}"; break; fi
	done

	if [ -n "$found" ]; then
		cp "$found" "$STAGE/$name"
		sum=$(sha256sum "$found" | cut -d' ' -f1)
		size=$(wc -c < "$found" | tr -d ' ')
		printf '%-32s %8s bytes  sha256:%s\n    from: %s\n    what: %s\n\n' \
			"$name" "$size" "$sum" "$found" "$desc" >> "$MANIFEST"
		echo "  OK       $name  <- $found"
		EXPECTED+=("$name")
	else
		{
			printf '%-32s  *** MISSING/EMPTY ***\n' "$name"
			for ((i = 1; i < ${#parts[@]} - 1; i++)); do printf '    looked at: %s\n' "${parts[$i]}"; done
			echo
		} >> "$MANIFEST"
		echo "  MISSING  $name"
		for ((i = 1; i < ${#parts[@]} - 1; i++)); do echo "             looked at: ${parts[$i]}"; done
		missing=$((missing + 1))
	fi
done

TARBALL="$OUT_DIR/puca-keys-$TS.tar"
if ! tar -cf "$TARBALL" -C "$STAGE" .; then
	echo "FATAL: tar failed; no bundle written." >&2
	rm -rf "$STAGE"
	exit 1
fi
rm -rf "$STAGE"

# Verify what is ACTUALLY inside the artifact. `cp` reporting success and the
# tarball containing the file are different claims, and only the second one is
# the backup.
listing="$(tar -tf "$TARBALL" 2>/dev/null)"
absent=0
for name in "${EXPECTED[@]}"; do
	if ! printf '%s\n' "$listing" | grep -qx "\./$name"; then
		echo "FATAL: '$name' was copied but is NOT inside $TARBALL" >&2
		absent=$((absent + 1))
	fi
done
if [ "$absent" -gt 0 ]; then
	echo "FATAL: bundle is incomplete — do NOT rely on it." >&2
	exit 1
fi

echo
echo "Bundle: $TARBALL"
echo "Verified inside the tar: ${#EXPECTED[@]} file(s) + MANIFEST.txt"

if [ "$missing" -gt 0 ]; then
	echo
	echo "FATAL: $missing key(s) missing — see the manifest inside the bundle." >&2
	echo "This bundle CANNOT restore your release channels. Locate the missing" >&2
	echo "keys, or re-run with ALLOW_MISSING=1 if you truly meant a partial backup." >&2
	[ "$ALLOW_MISSING" = "1" ] || exit 1
	echo "(ALLOW_MISSING=1 set — continuing anyway.)" >&2
fi

echo
echo "NEXT: encrypt it, then move it OFF this machine:"
echo "  gpg -c \"$TARBALL\"    # or: 7z a -p \"${TARBALL%.tar}.7z\" \"$TARBALL\""
echo "  # then store the encrypted file in a password-manager vault / offline drive"
echo "  # and shred the plaintext .tar:  shred -u \"$TARBALL\"  (or delete securely)"
