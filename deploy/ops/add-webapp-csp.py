#!/usr/bin/env python3
"""Add a Content-Security-Policy to the webapp vhost of a live Caddyfile.

Idempotent, backs up first, and refuses to write anything it cannot verify.

WHY IT BUILDS THE POLICY HERE rather than taking it as an argument: connect-src
has to name this deployment's API host AND its SFU, and the SFU URL only exists
in the backend's .env on this machine. Reading it locally keeps infrastructure
identity on the box instead of travelling through an operator's shell history.

Usage:  add-webapp-csp.py <caddyfile> <env-file> <app-host> <api-host> [--dry-run]
"""
import datetime
import re
import shutil
import sys


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: add-webapp-csp.py <caddyfile> <env-file> <app-host> <api-host> [--dry-run]")
        return 2
    caddyfile, envfile, app_host, api_host = sys.argv[1:5]
    dry = "--dry-run" in sys.argv

    text = open(caddyfile, encoding="utf-8").read()

    # Locate the app vhost block: from "<app_host> {" to the line with the
    # matching closing brace at column 0.
    start = re.search(rf"^{re.escape(app_host)}\s*\{{", text, re.M)
    if not start:
        print(f"REFUSING: no vhost block for {app_host} in {caddyfile}")
        return 1
    end = text.find("\n}\n", start.end())
    if end == -1:
        print("REFUSING: could not find the end of that vhost block")
        return 1
    block = text[start.start():end]

    if "Content-Security-Policy" in block:
        print(f"already present on {app_host}; nothing to do")
        return 0

    # The SFU the browser opens a WebSocket to. Without it in connect-src,
    # voice silently stops working for browser users — the failure this whole
    # step is most likely to cause, so it is read, not assumed.
    livekit = ""
    try:
        for line in open(envfile, encoding="utf-8"):
            if line.startswith("LIVEKIT_URL="):
                livekit = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    except OSError as e:
        print(f"REFUSING: cannot read {envfile}: {e}")
        return 1
    if not livekit:
        print(f"REFUSING: no LIVEKIT_URL in {envfile}. A connect-src without the "
              f"SFU would break voice for every browser user; refusing to guess.")
        return 1

    connect = f"'self' https://{api_host} wss://{api_host} {livekit}"
    csp = (
        "default-src 'self'; "
        f"connect-src {connect}; "
        "script-src 'self' 'wasm-unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' blob: https:; "
        "font-src 'self' data:; "
        "worker-src 'self' blob:; "
        "child-src 'self' blob:; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "frame-ancestors 'none'"
    )

    # Insert inside the block's existing header { } group.
    anchor = re.search(r"^(\s*)X-Frame-Options\s+\"[^\"]*\"\s*$", block, re.M)
    if not anchor:
        print("REFUSING: no X-Frame-Options line to anchor to inside that block; "
              "the header group is not shaped as expected.")
        return 1
    indent = anchor.group(1)
    new_block = block[:anchor.end()] + f'\n{indent}Content-Security-Policy "{csp}"' + block[anchor.end():]
    updated = text[:start.start()] + new_block + text[end:]

    if dry:
        print("--- would insert ---")
        print(f'{indent}Content-Security-Policy "{csp}"')
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{caddyfile}.bak-csp-{stamp}"
    shutil.copy2(caddyfile, backup)
    open(caddyfile, "w", encoding="utf-8").write(updated)
    print(f"backed up to {backup}")
    print(f"added CSP to {app_host} (connect-src names the API host and the SFU)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
