# Deterministic fingerprint of the LAN waker's source, shared by the script
# that ships it and the check that verifies it.
#
# WHY NOT HASH THE BINARY. `ship-waker.sh` builds on Linux, on the deploy host;
# `check-versions.sh` runs from a Windows working tree. Those two binaries can
# never have the same hash, so comparing them produces a gate that fails on
# every release forever — and a gate nobody can pass is one nobody reads, which
# is how the waker came to sit five days behind the server in the first place.
#
# So fingerprint the SOURCE instead, and have the ship record what it shipped
# in /opt/<unit>/SOURCE_SHA.
#
# Only files that can change the binary are included: the crate's Rust sources
# and its manifest, plus the workspace lock — ship-waker.sh copies that lock in
# beside the crate, so a dependency bump with no source change still produces a
# different waker and must still count.
#
# LINE ENDINGS ARE NORMALISED, and that is not cosmetic. Git checks these files
# out with CRLF on Windows and LF elsewhere, so hashing the bytes as they sit
# on disk answers differently per machine: the gate would fail on a colleague's
# clone, or in CI, for a waker that is perfectly current. This repo has been
# bitten by exactly that before — production's sqlx migration checksums are a
# mix of CRLF and LF, and a fresh clone crash-looped on it.
#
# The path is included alongside each hash so that renaming a file changes the
# fingerprint even when its contents do not.

waker_source_sha() {
	local root="$1"   # repository root
	local f
	{
		find "$root/crates/puca-waker" -type f \( -name '*.rs' -o -name 'Cargo.toml' \) -print |
			LC_ALL=C sort |
			while IFS= read -r f; do
				printf '%s ' "${f#"$root/"}"
				tr -d '\r' < "$f" | sha256sum | cut -d' ' -f1
			done
		printf '%s ' Cargo.lock
		tr -d '\r' < "$root/Cargo.lock" | sha256sum | cut -d' ' -f1
	} | sha256sum | cut -d' ' -f1
}
