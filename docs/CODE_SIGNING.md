# Code signing (Windows)

The Windows artefacts are **unsigned** as shipped: there is no Authenticode
certificate (see the FAQ, "Why does Windows warn me when I install it?"). The
build is ready to sign the moment one exists; nothing in the tree changes.

## What gets signed, and where

- **The app binary and the installer** — by Tauri, through
  `bundle.windows.signCommand` in `frontend/src-tauri/tauri.conf.json`, which
  runs `frontend/scripts/sign-windows.mjs` on each file **before** Tauri
  produces the updater's minisign `.sig`. That ordering is the whole point:
  signing the installer after the updater signature exists changes the bytes
  the `.sig` covers, and every auto-update then fails verification.
- **The helper binaries** (`puca-agent`, `puca-service`) — Tauri's hook does
  not cover sidecars, so `frontend/scripts/build-agent.mjs` signs them where it
  stages them, before Tauri bundles them.

With nothing configured the script prints one line per file and exits 0; the
artefact stays unsigned, exactly as today. With a certificate configured and
signing **failing**, the build fails — a configured-but-broken signer must not
ship an unsigned artefact everyone believes is signed.

## Configuring a certificate

Environment variables only; never commit any of this.

A certificate file:

```
AUTHENTICODE_PFX_PATH=C:\path\to\cert.pfx      # or AUTHENTICODE_PFX_BASE64=<base64 of the file>
AUTHENTICODE_PFX_PASSWORD=...                   # passed to signtool as /p, never printed
```

Azure Trusted Signing (signtool with Microsoft's dlib; the Azure CLI or an
environment credential signtool can pick up):

```
AZURE_TRUSTED_SIGNING_ENDPOINT=https://<region>.codesigning.azure.net
AZURE_TRUSTED_SIGNING_ACCOUNT=<account>
AZURE_TRUSTED_SIGNING_PROFILE=<profile>
AZURE_CODESIGNING_DLIB=C:\path\to\Azure.CodeSigning.Dlib.dll
```

Either way: `AUTHENTICODE_TIMESTAMP_URL` (default `http://timestamp.digicert.com`)
and `SIGNTOOL_PATH` (otherwise the newest Windows Kits `signtool.exe` is used).

## Checking it worked

```
signtool verify /pa /v path\to\Puca_x.y.z_x64-setup.exe
```

The pipeline was exercised with a throwaway self-signed certificate on
2026-09-05: unconfigured → exit 0 and unsigned; configured → signed with the
expected signer; wrong password → non-zero exit. A self-signed certificate
does not satisfy SmartScreen; only a certificate that chains to a trusted root
does, and reputation with SmartScreen is earned over time even then.
