# Púca Desktop App Auto-Updater Setup

## Overview

Tauri's updater allows your users to automatically receive updates without manually downloading new installers.

## Setup Steps

The deployment guide covers this end to end — [`deploy/README.md`](../deploy/README.md)
section 6.1 — and is the version to follow. In short:

### 1. Generate a signing keypair (once, on your machine)

```bash
cd frontend
npx tauri signer generate -w ~/.puca/tauri-updater.key
```

You'll be prompted for a password. **Remember this password**, and back the
key up with `deploy/ops/backup-keys.sh` the same day: the public half is
compiled into every installer, and an app accepts an update only if it was
signed by the matching private key. Lose the key and no update can ever be
signed again — every installed client stays on its version until its user
reinstalls by hand.

### 2. Put the public key and your download host in the overlay

Do **not** edit the tracked `src-tauri/tauri.conf.json` (it carries this
project's key and a placeholder endpoint). Copy
`src-tauri/tauri.release.example.json` to the gitignored
`src-tauri/tauri.release.json` and set both:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://download.example.com/latest.json"],
    "pubkey": "<the public key `tauri signer generate` printed>"
  }
}
```

`npm run tauri:build` merges it and prints the endpoint and the key id it
baked in, every time. The endpoint is a **static file**: `latest.json` at the
download host's root, written by `deploy/ops/dual-ship.sh installer` (the
Lite build reads `latest-lite.json` beside it, derived automatically).

### 3. Build a signed release

Set the two environment variables before building — the build fails without
them, because `createUpdaterArtifacts` is on:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "~/.puca/tauri-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password-here"

npm run tauri:build
```

This creates the installer and its `.sig` in `src-tauri/target/release/bundle/nsis/`.

### 4. Publish

`deploy/ops/dual-ship.sh installer <Puca-Setup.exe> <.sig> <version> "<notes>"`
uploads the installer under a versioned name, writes `latest.json` with the
signature from the `.sig` file, writes the `/app-version` file that drives the
in-app prompt, and verifies each through the download host. `latest.json`
has the shape Tauri expects:

```json
{
  "version": "0.9.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2026-09-02T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNv...",
      "url": "https://download.example.com/Puca-Setup-0.9.0.exe"
    }
  }
}
```

### 5. Version bump workflow

1. Bump `version` in `frontend/src-tauri/tauri.conf.json` — the only place
   the version lives (`frontend/package.json` and the root `Cargo.toml` carry
   frozen values nothing reads).
2. Write the release notes entry in `CHANGELOG.md`.
3. Build with the signing keys (step 3).
4. Ship with `dual-ship.sh` (step 4); `deploy/ops/check-versions.sh` confirms
   every surface agrees.

---

## Quick Commands

```bash
# Development (for testing, no signing)
npm run tauri:dev

# Production build (requires signing keys)
npm run tauri:build

# Check for signing key
ls .tauri/puca.key
```

## Files Changed for Auto-Updater

| File | Change |
|------|--------|
| `package.json` | Added `@tauri-apps/plugin-updater` |
| `src-tauri/Cargo.toml` | Added `tauri-plugin-updater` |
| `src-tauri/src/lib.rs` | Registered updater plugin |
| `src-tauri/tauri.conf.json` | Added updater config |
| `src-tauri/capabilities/default.json` | Added updater permissions |
| `src/api/appVersion.ts` | Detection (`checkForNewVersion` against `GET /app-version`) + in-place install (`installUpdateInPlace`) |
| `src/components/UpdateBanner.tsx` | The prompt: shows a newer release, installs only on click |
| `src/components/UpdateGate.tsx` | Pre-load gate; installs desktop updates automatically ONLY when `autoInstallUpdates` is on |
| `src/components/updateGate.utils.ts` | Pure decisions: `shouldAutoInstallOnLaunch`, once-per-version key |

(There is no `useUpdater` hook and never was — an earlier revision of this doc
described one that did not exist.)

## How the Desktop Update Actually Runs

1. **Detection.** `checkForNewVersion()` in `src/api/appVersion.ts` fetches
   `GET /app-version` (an operator-pushed JSON file, hardcoded production
   fallback base, 8 s per-base timeout) and compares it with the running
   version.
2. **The prompt.** `UpdateBanner` calls that 8 s after it mounts, then every 10
   minutes and on window focus, and shows an "Update available" banner. It
   **never installs on its own** — clicking Update runs
   `installUpdateInPlace()` (Tauri updater plugin: minisign-verified download,
   passive NSIS install, relaunch).
3. **Automatic installation (opt-in).** Settings → Advanced → Desktop App →
   "Install updates automatically" (`autoInstallUpdates`, default OFF). When
   on, `UpdateGate` — which renders at `main.tsx` before routing and before
   sign-in — checks and installs at startup, before the app loads, with the
   same visible progress screens as the mobile OTA. One automatic attempt per
   version (`sovereign_update_auto_attempted` in localStorage) so a failed
   install can never loop; every phase is bounded so the gate may delay the
   app but never hold it. Nothing installs mid-session, ever.
