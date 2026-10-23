"""Check a signed Púca for Steam Deck release before it is published.

    python scripts/verify_update.py <puca-decky-X.Y.Z.zip> <puca-decky.json> [--installed <published zip>]

The plugin checks an update's signature itself, with WebCrypto, before it
asks Decky to install anything (src/update.ts). This makes the same check
again before publishing, with a second implementation: a release that the
plugins out there would refuse never reaches the download site.

It refuses unless
  - the manifest is well formed and names this zip, its version and SHA-256;
  - the zip carries update-key.json, so this release can update itself in
    turn, and the signature verifies under that key;
  - with --installed (what the download site offers now): the signature also
    verifies under the key THAT release carries, the key every installed
    plugin actually holds, and the version is newer than it.

Exit 0 when it passes, 1 with the reasons when it does not.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "py_modules"))

from puca_update import is_newer, read_manifest  # noqa: E402

UPDATE_DOMAIN = "puca-decky-update/1"
# DER of SHA-256's AlgorithmIdentifier in a DigestInfo (RFC 8017, 9.2 note 1).
DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


def update_message(version: str, sha256: str) -> bytes:
    """The exact text the release key signs (src/update.ts, updateMessage)."""
    return f"{UPDATE_DOMAIN}\n{version}\n{sha256}\n".encode("ascii")


def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rsa_pkcs1_sha256_verify(n: int, e: int, message: bytes, signature: bytes) -> bool:
    """RSASSA-PKCS1-v1_5 with SHA-256 (RFC 8017, 8.2.2): the signature is
    opened and compared with the whole encoding expected for this message,
    never parsed, so nothing in it can be read leniently."""
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    t = DIGEST_INFO_SHA256 + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(pow(s, e, n).to_bytes(k, "big"), expected)


def read_jwk(raw: bytes) -> tuple[int, int] | None:
    """(n, e) of an RSA public key of at least 2048 bits, or None."""
    try:
        k = json.loads(raw.decode("utf-8"))
        if not isinstance(k, dict) or k.get("kty") != "RSA":
            return None
        n = int.from_bytes(_b64url(k["n"]), "big")
        e = int.from_bytes(_b64url(k["e"]), "big")
    except (KeyError, TypeError, ValueError, UnicodeDecodeError):
        return None
    if n.bit_length() < 2048 or e < 3 or e % 2 == 0:
        return None
    return n, e


def read_release(zip_path: str) -> tuple[str | None, tuple[int, int] | None]:
    """The version and update key a release zip carries."""
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        version = None
        if "puca/package.json" in names:
            try:
                version = json.loads(z.read("puca/package.json")).get("version")
            except ValueError:
                version = None
        key = read_jwk(z.read("puca/update-key.json")) if "puca/update-key.json" in names else None
    return (version if isinstance(version, str) else None), key


def check(zip_path: str, manifest_path: str, installed: str | None = None) -> list[str]:
    """Every reason not to publish; empty when there is none."""
    problems: list[str] = []
    with open(manifest_path, "rb") as f:
        offer = read_manifest(f.read())
    if offer is None:
        return [f"{manifest_path} is not a well-formed update manifest"]
    if offer["file"] != os.path.basename(zip_path):
        problems.append(f"the manifest names {offer['file']}, not {os.path.basename(zip_path)}")
    with open(zip_path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest != offer["sha256"]:
        problems.append(f"the manifest's SHA-256 is not the zip's ({digest})")
    try:
        version, key = read_release(zip_path)
    except zipfile.BadZipFile:
        return problems + [f"{zip_path} is not a zip"]
    if version != offer["version"]:
        problems.append(f"the zip is version {version}, the manifest says {offer['version']}")
    try:
        signature = base64.b64decode(offer["signature"], validate=True)
    except ValueError:
        return problems + ["the signature is not base64"]
    message = update_message(offer["version"], offer["sha256"])
    if key is None:
        problems.append("the zip carries no update-key.json: built without the release key, it could never update itself")
    elif not rsa_pkcs1_sha256_verify(key[0], key[1], message, signature):
        problems.append("the signature does not verify under the key inside the zip")
    if installed is not None:
        try:
            old_version, old_key = read_release(installed)
        except zipfile.BadZipFile:
            return problems + [f"{installed} is not a zip"]
        if old_key is None:
            problems.append(f"{installed} carries no update key: installs of it cannot update themselves (one manual reinstall)")
        elif not rsa_pkcs1_sha256_verify(old_key[0], old_key[1], message, signature):
            problems.append("the signature does not verify under the key the published release carries: installed plugins would refuse it")
        if old_version is not None and not is_newer(offer["version"], old_version):
            problems.append(f"{offer['version']} is not newer than the published {old_version}: installed plugins would not offer it")
    return problems


def main(argv: list[str]) -> int:
    args = list(argv)
    installed = None
    if "--installed" in args:
        i = args.index("--installed")
        if i + 1 >= len(args):
            print(__doc__, file=sys.stderr)
            return 2
        installed = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    problems = check(args[0], args[1], installed)
    for p in problems:
        print(f"REFUSING: {p}", file=sys.stderr)
    if problems:
        return 1
    print(f"verified: {os.path.basename(args[0])} is signed by the release key"
          + (" and installed plugins will accept it" if installed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
