"""Package the plugin for Decky Loader's "Install Plugin from ZIP File" / "from URL".

    npm run package          (builds first, then runs this)

Writes out/puca-decky-<version>.zip and a .sha256 beside it. The zip holds one
folder, puca/, with what Decky runs: plugin.json, package.json, main.py,
py_modules/, dist/ (the frontend and the page shim), the licence and the
notices for the third-party code inside dist/index.js. The archive is
deterministic: the same inputs give the same bytes, so its hash can be
published.
"""
import hashlib
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(PLUGIN))
FOLDER = "puca"
STAMP = (1980, 1, 1, 0, 0, 0)

NOTICE = """Púca for Steam Deck
Copyright (C) 2025-2026 Fossferous and contributors

Licensed under the GNU Affero General Public License, version 3 or any later
version: see LICENSE. The source is in the Púca repository, integrations/decky/.

dist/index.js includes @decky/api {api_version} (https://github.com/SteamDeckHomebrew/loader-api),
licensed under the GNU Lesser General Public License, version 2.1: see
LICENSES/LGPL-2.1.txt. It is included unmodified and its source is published
at the address above.
"""


def add(z: zipfile.ZipFile, arcname: str, data: bytes) -> None:
    info = zipfile.ZipInfo(f"{FOLDER}/{arcname}", date_time=STAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    z.writestr(info, data)


def read(*parts: str) -> bytes:
    with open(os.path.join(*parts), "rb") as f:
        return f.read()


def main() -> int:
    pkg = json.loads(read(PLUGIN, "package.json"))
    version = pkg["version"]
    for needed in ("index.js", "page-shim.js"):
        if not os.path.isfile(os.path.join(PLUGIN, "dist", needed)):
            print(f"dist/{needed} is missing: run npm run build first", file=sys.stderr)
            return 1
    api_version = json.loads(read(PLUGIN, "node_modules", "@decky", "api", "package.json"))["version"]

    files = {
        "plugin.json": read(PLUGIN, "plugin.json"),
        # Decky reads the version shown in its plugin list from package.json.
        "package.json": json.dumps({"name": pkg["name"], "version": version, "license": pkg["license"]}, indent=2).encode() + b"\n",
        "main.py": read(PLUGIN, "main.py"),
        "dist/index.js": read(PLUGIN, "dist", "index.js"),
        "dist/page-shim.js": read(PLUGIN, "dist", "page-shim.js"),
        "LICENSE": read(REPO, "LICENSE"),
        "NOTICE": NOTICE.format(api_version=api_version).encode(),
        "LICENSES/LGPL-2.1.txt": read(PLUGIN, "node_modules", "@decky", "api", "LICENSE"),
    }
    for name in sorted(os.listdir(os.path.join(PLUGIN, "py_modules"))):
        if name.endswith(".py"):
            files[f"py_modules/{name}"] = read(PLUGIN, "py_modules", name)

    out_dir = os.path.join(PLUGIN, "out")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"puca-decky-{version}.zip")
    with zipfile.ZipFile(out, "w") as z:
        for arcname in sorted(files):
            add(z, arcname, files[arcname])
    digest = hashlib.sha256(read(out)).hexdigest()
    with open(out + ".sha256", "w", encoding="utf-8") as f:
        f.write(f"{digest}  {os.path.basename(out)}\n")
    print(f"{out}\n{len(files)} files, sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
