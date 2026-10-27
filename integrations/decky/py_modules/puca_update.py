"""Updates for the plugin itself: what the Púca server's download site offers.

The download site is the one the person's own Púca server names (its
/app-version download_url, read by the page: docs/EMBEDDING.md,
downloadSite). It publishes

    steam-deck/puca-decky.json          {"version", "file", "sha256", "signature"}
    steam-deck/puca-decky-<version>.zip

(deploy/ops/dual-ship.sh decky). This side only fetches, because Steam's own
page cannot read another site without its permission (CORS) and cannot write
the file Decky installs from. Whether an update may be installed at all is
decided in the frontend, by its signature (src/update.ts): nothing here makes
an offer trustworthy, so everything here is only careful about what it reads.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import ssl
from typing import Any
from urllib.parse import urlsplit

MANIFEST = "steam-deck/puca-decky.json"
MAX_MANIFEST_BYTES = 16 * 1024
MAX_ZIP_BYTES = 32 * 1024 * 1024
UPDATES_DIR = "updates"

# [0-9], never \d: in Python \d is any Unicode digit, so "٠.٥.٠" would read as
# 0.5.0, and int() takes those digits too. The frontend's \d (src/update.ts) is
# ASCII only, so the backend would download a release the plugin can never
# accept. scripts/verify_update.py reads versions through here as well.
_VERSION = re.compile(r"[0-9]{1,6}(\.[0-9]{1,6}){0,3}")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_BASE64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")


def parse_version(v: Any) -> tuple[int, ...] | None:
    """"0.2.0" as numbers; None for anything that is not a plain version."""
    if not isinstance(v, str) or not _VERSION.fullmatch(v):
        return None
    return tuple(int(p) for p in v.split("."))


def is_newer(a: Any, b: Any) -> bool:
    """Is a newer than b? Missing parts count as 0. False unless both are versions."""
    x, y = parse_version(a), parse_version(b)
    if x is None or y is None:
        return False
    n = max(len(x), len(y))
    return x + (0,) * (n - len(x)) > y + (0,) * (n - len(y))


def download_origin(site: Any) -> str | None:
    """The download site as an origin ("https://host[:port]"), or None.

    https only, except plain http on the loopback (a local test server). The
    page hands over an origin; anything with a path, credentials or a query
    is refused rather than trimmed."""
    if not isinstance(site, str) or len(site) > 512:
        return None
    try:
        parts = urlsplit(site.strip())
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.path not in ("", "/") or parts.query or parts.fragment or parts.username or parts.password or not host:
        return None
    if parts.scheme == "https":
        pass
    elif parts.scheme == "http" and _loopback(host):
        pass
    else:
        return None
    netloc = f"[{host}]" if ":" in host else host
    return f"{parts.scheme}://{netloc}" + (f":{port}" if port is not None else "")


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def manifest_url(origin: str) -> str:
    return f"{origin}/{MANIFEST}"


def zip_url(origin: str, offer: dict) -> str:
    return f"{origin}/steam-deck/{offer['file']}"


def read_manifest(raw: bytes) -> dict | None:
    """The offer, if the manifest is well formed; None otherwise."""
    if len(raw) > MAX_MANIFEST_BYTES:
        return None
    try:
        o = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(o, dict):
        return None
    version, file, sha, sig = o.get("version"), o.get("file"), o.get("sha256"), o.get("signature")
    if parse_version(version) is None or file != f"puca-decky-{version}.zip":
        return None
    if not isinstance(sha, str) or not _SHA256.fullmatch(sha):
        return None
    if not isinstance(sig, str) or len(sig) > 1024 or not _BASE64.fullmatch(sig):
        return None
    return {"version": version, "file": file, "sha256": sha, "signature": sig}


def read_key(plugin_dir: str) -> dict | None:
    """The release key's public half that this build carries (update-key.json
    beside main.py), or None when it was built without one: then it cannot be
    updated from here, only reinstalled."""
    try:
        with open(os.path.join(plugin_dir, "update-key.json"), "rb") as f:
            raw = f.read(16 * 1024)
        k = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(k, dict) or k.get("kty") != "RSA":
        return None
    n, e = k.get("n"), k.get("e")
    if not isinstance(n, str) or not isinstance(e, str):
        return None
    return {"kty": "RSA", "n": n, "e": e}


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ssl_context() -> ssl.SSLContext:
    """Certificate checks that work inside Decky's bundled Python, whose
    built-in certificate path need not exist on SteamOS: certifi (which Decky
    itself uses) first, then the system's bundle."""
    try:
        import certifi  # noqa: PLC0415 (bundled with Decky; optional here)
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for path in ("/etc/ssl/certs/ca-certificates.crt", "/etc/ca-certificates/extracted/tls-ca-bundle.pem"):
        if os.path.isfile(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


def clear_updates(runtime_dir: str) -> None:
    """Remove downloaded updates: one that was installed, or abandoned."""
    folder = os.path.join(runtime_dir, UPDATES_DIR)
    try:
        names = os.listdir(folder)
    except OSError:
        return
    for name in names:
        try:
            os.remove(os.path.join(folder, name))
        except OSError:
            pass


def save_update(runtime_dir: str, offer: dict, data: bytes) -> str:
    """Write the checked zip where Decky can install it from, alone in its
    folder. Returns its path."""
    folder = os.path.join(runtime_dir, UPDATES_DIR)
    os.makedirs(folder, exist_ok=True)
    clear_updates(runtime_dir)
    path = os.path.join(folder, offer["file"])
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return path
