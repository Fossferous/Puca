#!/usr/bin/env bash
# Does Windows Defender object to the installers we are about to ship?
#
# WHY THIS EXISTS. 0.9.806 shipped and immediately tripped
# `Trojan:Win32/Bearfoos.B!ml` on the desktop auto-updater, for every user who
# took the update. Nothing was wrong with it: the bytes served matched the bytes
# built, every binary inside was clean, and 0.9.803/804/805 all scanned clean
# under the SAME definitions. A rebuild of the identical commit scanned clean
# too. An `!ml` verdict is a machine-learning score over the whole installer,
# and an unsigned zero-reputation NSIS bundle sits close enough to the boundary
# that one rebuild lands the wrong side of it.
#
# That is not something we can fix in the source, but it IS something we can
# refuse to ship. This takes seconds and turns "a user's antivirus quarantines
# our update" into "build it again".
#
# THE REAL FIX is an Authenticode certificate — frontend/scripts/sign-windows.mjs
# is already written and wired into Tauri's signCommand, and does nothing only
# because no certificate is configured. Until then, this is the guard.
#
# Usage:  deploy/ops/scan-installers.sh <version>
#         deploy/ops/scan-installers.sh 0.9.807
set -uo pipefail

VER="${1:?usage: scan-installers.sh <version>}"
NSIS="$(dirname "${BASH_SOURCE[0]}")/../../frontend/src-tauri/target/release/bundle/nsis"
MP="/c/Program Files/Windows Defender/MpCmdRun.exe"
TMP="$(mktemp -d)"   # mktemp, not $TMPDIR/$USER: USER is unset in Git Bash under set -u

[ -x "$MP" ] || { echo "SKIP  MpCmdRun.exe not found — cannot scan on this machine"; exit 0; }
trap 'rm -rf "$TMP"' EXIT

status=0
for variant in "Púca_${VER}_x64-setup.exe" "Púca Lite_${VER}_x64-setup.exe"; do
    src="$NSIS/$variant"
    if [ ! -f "$src" ]; then
        echo "FAIL  missing: $variant"
        status=1
        continue
    fi

    # AN ASCII COPY, because MpCmdRun cannot open a path containing the fada in
    # "Púca": it prints "was skipped" and exits 0, which reads exactly like a
    # clean result and is how this check would silently never run.
    ascii="$TMP/$(echo "$variant" | tr -cd 'A-Za-z0-9._-')"
    cp "$src" "$ascii" 2>/dev/null || {
        echo "FLAGGED  $variant — real-time protection blocked even copying it"
        status=1
        continue
    }
    if [ ! -f "$ascii" ]; then
        echo "FLAGGED  $variant — the copy was removed by real-time protection"
        status=1
        continue
    fi

    out="$("$MP" -Scan -ScanType 3 -File "$(cygpath -w "$ascii")" 2>&1)"
    if grep -qi "skipped" <<<"$out"; then
        # NOT a pass. A scanner that skipped the file has told us nothing.
        echo "FAIL  $variant — the scanner SKIPPED it (checked nothing)"
        status=1
    elif grep -qi "no threats\|found no threats" <<<"$out"; then
        echo "ok    $variant"
    else
        echo "FLAGGED  $variant"
        grep -iE "threat|found" <<<"$out" | head -3 | sed 's/^/        /'
        status=1
    fi
done

if [ "$status" -ne 0 ]; then
    cat >&2 <<'MSG'

DO NOT SHIP THIS BUILD. Rebuild and scan again — an !ml verdict is a score, not
a signature, and a fresh build of the same commit usually lands clean. If two or
three rebuilds in a row are flagged, something really did change; look at the
diff rather than rebuilding a fourth time.
MSG
fi
exit $status
