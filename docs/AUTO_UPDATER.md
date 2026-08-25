# Púca Desktop App Auto-Updater Setup

## Overview

Tauri's updater allows your users to automatically receive updates without manually downloading new installers.

## Setup Steps

### 1. Generate Signing Keys (One-time)

Run this command in `frontend/` folder:

```bash
npx tauri signer generate -w .tauri/puca.key
```

You'll be prompted for a password. **Remember this password!** You'll need it when building releases.

This creates:
- `.tauri/puca.key` - Your **PRIVATE key** (keep secret!)
- Outputs a **PUBLIC key** - Put this in `tauri.conf.json`

### 2. Update tauri.conf.json

Replace `REPLACE_WITH_YOUR_PUBLIC_KEY` with the public key from step 1:

```json
"plugins": {
  "updater": {
    "endpoints": [
      "https://YOUR_SERVER/api/updates/{{target}}/{{arch}}/{{current_version}}"
    ],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu..."
  }
}
```

### 3. Build a Signed Release

Set environment variables before building:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ".tauri/puca.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "your-password-here"

npm run tauri:build
```

This creates signed update artifacts in:
- `src-tauri/target/release/bundle/`

### 4. Host Updates

You need a server endpoint that returns JSON like this:

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2024-12-12T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNv...",
      "url": "https://yourserver.com/releases/Púca_0.2.0_x64-setup.exe"
    }
  }
}
```

You can use:
- **GitHub Releases** (Tauri has built-in support)
- **Your own backend** (add an endpoint in the Rust server)
- **Static JSON file** on any CDN

### 5. Version Bump Workflow

When releasing a new version:

1. Update version in `frontend/src-tauri/tauri.conf.json`
2. Update version in `frontend/package.json`
3. Build with signing keys (step 3)
4. Upload artifacts to your server
5. Update the JSON endpoint with new version info

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
