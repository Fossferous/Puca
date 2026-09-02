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
# TWO BUNDLES, NOT ONE, AND WHY
#
# This used to emit a single tar holding the Tauri updater key AND its password,
# and the Android keystore AND the properties file with its store/key passwords.
# A key protected by a passphrase that travels in the same archive is a key with
# no passphrase: one compromised bundle yields both halves. So the output is
#
#   puca-keys-<ts>.tar            key material
#   puca-key-passwords-<ts>.tar   the passphrases that unlock it
#
# and they are only a real separation if you STORE THEM IN DIFFERENT PLACES.
# Putting both in the same vault reproduces exactly what this replaced.
#
# Both bundles contain PLAINTEXT secrets. They are written OUTSIDE the repo and
# are NOT transmitted anywhere. `umask 077` below means the staging directory,
# the copies and the tarballs are 0600/0700 from the moment they are created —
# not chmod-ed afterwards, which leaves a window in which they are world-readable
# on a typical dev box. Encrypt each before it leaves your control (e.g.
#   gpg -c <bundle>.tar   ->  .tar.gpg
#   7z a -p <bundle>.7z <bundle>.tar
# ) and store the results in a password-manager file vault / offline encrypted
# drive — somewhere that is NOT this one machine.
set -uo pipefail

# Before anything is created. Every mkdir, cp and tar below inherits it.
umask 077



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

# name!!candidate-path[!!candidate-path...]!!description!!class
# '!!' because Windows paths contain no '!' but do contain ':' and '\'.
#
# CLASS is `keys` or `passwords` and decides which bundle the file lands in.
# Exactly the two entries that unlock another entry are `passwords`: the Tauri
# updater key's passphrase, and the properties file holding the Android
# keystore's store/key passwords. Everything else is key material or public
# config. A credential that is a secret in its OWN right (the FCM service
# account) is key material, not a password — it unlocks nothing else here.
KEYS=(
	"tauri-updater.key!!$TAURI_DIR/puca-updater.key!!$TAURI_DIR/sovereign-updater.key!!$KEY_HOME/tauri-updater.key!!Tauri desktop updater private key (minisign)!!keys"
	"tauri-updater.key.password!!$TAURI_DIR/puca-updater.key.password!!$TAURI_DIR/sovereign-updater.key.password!!$KEY_HOME/tauri-updater.key.password!!Password for the Tauri updater key!!passwords"
	"mobile-updater-rsa.key!!$KEY_HOME/mobile-updater-rsa.key!!Mobile OTA signing key (Capgo RSA private)!!keys"
	"mobile-updater-rsa.pub!!$KEY_HOME/mobile-updater-rsa.pub!!Mobile OTA public key (embedded in the APK)!!keys"
	"cf-origin-key.pem!!$KEY_HOME/cf-origin-key.pem!!Cloudflare Origin CA private key (re-issuable from dashboard)!!keys"
	"cf-origin-cert.pem!!$KEY_HOME/cf-origin-cert.pem!!Cloudflare Origin CA certificate!!keys"
	"release.keystore!!$HOME/.android/puca-release.keystore!!$HOME/.android/sovereign-release.keystore!!Android release signing keystore!!keys"
	"keystore.properties!!$HOME/.android/puca-keystore.properties!!$HOME/.android/sovereign-keystore.properties!!Android keystore store/key passwords + alias!!passwords"
	"fcm-service-account.json!!$KEY_HOME/fcm-service-account.json!!FCM wake-doorbell credential (re-issuable from Firebase Console; sends only the constant signal)!!keys"
	"google-services.json!!$KEY_HOME/google-services.json!!Firebase Android config (re-downloadable; baked into the APK)!!keys"
)

CLASSES=(keys passwords)
mkdir -p "$STAGE/keys" "$STAGE/passwords"
for class in "${CLASSES[@]}"; do
	{
		echo "Puca $class backup — $TS"
		echo "Restore each file to the path shown. Keep this bundle ENCRYPTED and OFF this machine."
		echo "This is the '$class' half of a SPLIT backup: the other half is"
		echo "puca-$([ "$class" = keys ] && echo key-passwords || echo keys)-$TS.tar."
		echo "Store the two in DIFFERENT places, or the split has bought you nothing."
		echo
	} > "$STAGE/$class/MANIFEST.txt"
done

missing=0
declare -a EXPECTED_KEYS=()
declare -a EXPECTED_PASSWORDS=()
for entry in "${KEYS[@]}"; do
	# Split on '!!' into: name, candidate paths..., description (last field).
	# NOT `IFS='!!' read`: bash reads IFS as a SET of single characters, so '!!'
	# means '!' and every field would split twice into empties.
	mapfile -t parts < <(printf '%s\n' "$entry" | sed 's/!!/\n/g')
	name="${parts[0]}"
	# Last field is the class, second-to-last the description; everything
	# between the name and those is a candidate path.
	class="${parts[${#parts[@]}-1]}"
	desc="${parts[${#parts[@]}-2]}"
	case "$class" in
		keys|passwords) ;;
		*) echo "FATAL: entry '$name' has unknown class '$class'" >&2; rm -rf "$STAGE"; exit 1 ;;
	esac
	manifest="$STAGE/$class/MANIFEST.txt"
	found=""
	for ((i = 1; i < ${#parts[@]} - 2; i++)); do
		if [ -s "${parts[$i]}" ]; then found="${parts[$i]}"; break; fi
	done

	if [ -n "$found" ]; then
		cp "$found" "$STAGE/$class/$name"
		sum=$(sha256sum "$found" | cut -d' ' -f1)
		size=$(wc -c < "$found" | tr -d ' ')
		printf '%-32s %8s bytes  sha256:%s\n    from: %s\n    what: %s\n\n' \
			"$name" "$size" "$sum" "$found" "$desc" >> "$manifest"
		echo "  OK       $name  <- $found  [$class]"
		if [ "$class" = keys ]; then EXPECTED_KEYS+=("$name"); else EXPECTED_PASSWORDS+=("$name"); fi
	else
		{
			printf '%-32s  *** MISSING/EMPTY ***\n' "$name"
			for ((i = 1; i < ${#parts[@]} - 2; i++)); do printf '    looked at: %s\n' "${parts[$i]}"; done
			echo
		} >> "$manifest"
		echo "  MISSING  $name"
		for ((i = 1; i < ${#parts[@]} - 2; i++)); do echo "             looked at: ${parts[$i]}"; done
		missing=$((missing + 1))
	fi
done

TARBALL_KEYS="$OUT_DIR/puca-keys-$TS.tar"
TARBALL_PASSWORDS="$OUT_DIR/puca-key-passwords-$TS.tar"
for class in "${CLASSES[@]}"; do
	tar_path="$OUT_DIR/puca-$([ "$class" = keys ] && echo keys || echo key-passwords)-$TS.tar"
	if ! tar -cf "$tar_path" -C "$STAGE/$class" .; then
		echo "FATAL: tar failed for $class; no usable bundle written." >&2
		rm -rf "$STAGE"
		exit 1
	fi
	# Belt and braces: umask 077 already made it 0600 at creation, but a tar
	# built under an inherited umask on some other machine would not be.
	chmod 600 "$tar_path"
done
rm -rf "$STAGE"

# Verify what is ACTUALLY inside each artifact. `cp` reporting success and the
# tarball containing the file are different claims, and only the second one is
# the backup. The cross-checks matter as much as the presence ones: a bundle
# that quietly carried BOTH halves would look exactly like a correct one.
absent=0
crossed=0
verify_bundle() { # tar_path  class  expected-names...
	local tar_path="$1" class="$2"; shift 2
	local listing name
	# grep -c throughout, never -q. `set -o pipefail` is on, and -q exits at the
	# first match, SIGPIPEing the printf feeding it — the pipeline then reports
	# failure and this reads a perfectly good bundle as a missing file, aborting
	# a backup that actually worked.
	listing="$(tar -tf "$tar_path" 2>/dev/null)"
	for name in "$@"; do
		if [ "$(printf '%s\n' "$listing" | grep -cx "\./$name" || true)" -eq 0 ]; then
			echo "FATAL: '$name' was copied but is NOT inside $tar_path" >&2
			absent=$((absent + 1))
		fi
	done
	local stray
	if [ "$class" = keys ]; then
		stray="$(printf '%s\n' "$listing" | grep -cE '\.password$|keystore\.properties$' || true)"
		if [ "${stray:-0}" -gt 0 ]; then
			echo "FATAL: $tar_path carries a PASSWORD — the split is defeated" >&2
			crossed=$((crossed + 1))
		fi
	else
		stray="$(printf '%s\n' "$listing" | grep -cE '\.key$|\.keystore$|\.pem$' || true)"
		if [ "${stray:-0}" -gt 0 ]; then
			echo "FATAL: $tar_path carries KEY MATERIAL — the split is defeated" >&2
			crossed=$((crossed + 1))
		fi
	fi
}
verify_bundle "$TARBALL_KEYS" keys ${EXPECTED_KEYS[@]+"${EXPECTED_KEYS[@]}"}
verify_bundle "$TARBALL_PASSWORDS" passwords ${EXPECTED_PASSWORDS[@]+"${EXPECTED_PASSWORDS[@]}"}
if [ "$absent" -gt 0 ] || [ "$crossed" -gt 0 ]; then
	echo "FATAL: bundles are incomplete or mixed — do NOT rely on them." >&2
	exit 1
fi

echo
echo "Bundles:"
echo "  keys      $TARBALL_KEYS   (${#EXPECTED_KEYS[@]} file(s) + MANIFEST.txt)"
echo "  passwords $TARBALL_PASSWORDS   (${#EXPECTED_PASSWORDS[@]} file(s) + MANIFEST.txt)"

if [ "$missing" -gt 0 ]; then
	echo
	echo "FATAL: $missing key(s) missing — see the manifest inside the bundle." >&2
	echo "This bundle CANNOT restore your release channels. Locate the missing" >&2
	echo "keys, or re-run with ALLOW_MISSING=1 if you truly meant a partial backup." >&2
	[ "$ALLOW_MISSING" = "1" ] || exit 1
	echo "(ALLOW_MISSING=1 set — continuing anyway.)" >&2
fi

echo
echo "NEXT: encrypt BOTH, then move them OFF this machine — TO DIFFERENT PLACES."
echo "Storing the key bundle and the password bundle in the same vault recreates"
echo "the single-artifact backup this split replaced: one compromise, both halves."
echo
for t in "$TARBALL_KEYS" "$TARBALL_PASSWORDS"; do
	echo "  gpg -c \"$t\"    # or: 7z a -p \"${t%.tar}.7z\" \"$t\""
done
echo "  # then store each encrypted file in a SEPARATE vault / offline drive"
echo "  # and shred the plaintext tars:"
echo "  shred -u \"$TARBALL_KEYS\" \"$TARBALL_PASSWORDS\"   (or delete securely)"
echo
echo "BUILDING A RELEASE now needs both: the Tauri updater key comes out of the"
echo "keys bundle and its password out of the passwords bundle (see CLAUDE.md)."
