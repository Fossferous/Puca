# Púca Auto-Updater Guide

This guide explains how to push updates to users on **Desktop (Windows/Mac/Linux)** and **Mobile (Android/iOS)** platforms without requiring manual reinstallation.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Mobile (Capacitor) Live Updates](#mobile-capacitor-live-updates)
3. [Desktop (Tauri) Updates](#desktop-tauri-updates)
4. [Server Setup](#server-setup)
5. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         YOUR SERVER (example.com)                      │
│                                                                     │
│  ┌─────────────────┐     ┌──────────────────────────────────────┐  │
│  │ Backend (Rust)  │     │ Static Files (/releases)              │  │
│  │                 │     │                                        │  │
│  │ /api/updates    │────▶│ /v0.2.0/Púca_0.2.0_x64-setup.exe │  │
│  │ /api/mobile-    │     │ /v0.2.0/mobile-bundle.zip             │  │
│  │   updates/check │     │ /v0.2.0/Púca_0.2.0_x64.dmg       │  │
│  └─────────────────┘     └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                    ▲                           ▲
                    │                           │
         ┌──────────┴───────────┐    ┌─────────┴──────────┐
         │   Desktop App        │    │   Mobile App       │
         │   (Tauri)            │    │   (Capacitor)      │
         │                      │    │                    │
         │ 1. Check version API │    │ 1. Check API       │
         │ 2. Download .exe/.dmg│    │ 2. Download .zip   │
         │ 3. Install & relaunch│    │ 3. Apply & reload  │
         └──────────────────────┘    └────────────────────┘
```

---

## Mobile (Capacitor) Live Updates

Mobile live updates push new web assets (HTML/JS/CSS) to the app **without requiring users to reinstall the APK**.

### Prerequisites

- Backend server running at `example.com` (or your domain)
- SSH access to your server
- Node.js installed on your **local development PC**

---

### Step-by-Step: Pushing a Mobile Update

#### Step 1: Make Your Code Changes

📍 **Where:** Your local development PC  
📁 **Directory:** `<repo>\frontend`

Edit any frontend files (React components, CSS, etc.)

#### Step 2: Build the Frontend

📍 **Where:** Your local development PC  
📁 **Directory:** `<repo>\frontend`

```powershell
npm run build
```

This creates the `dist/` folder with compiled assets.

#### Step 3: Create the Mobile Bundle

📍 **Where:** Your local development PC  
📁 **Directory:** `<repo>\frontend`

```powershell
Compress-Archive -Path dist\* -DestinationPath mobile-bundle.zip -Force
```

This creates `mobile-bundle.zip` (~250KB) containing all web assets.

#### Step 4: Update the Version Number

📍 **Where:** Your local development PC  
📁 **Directory:** `<repo>\src`  
📄 **File:** `update_routes.rs`

Change the version constant:

```rust
// Change from:
pub const CURRENT_VERSION: &str = "0.2.0";

// To:
pub const CURRENT_VERSION: &str = "0.3.0";  // Increment version
```

#### Step 5: Upload Bundle to Server

📍 **Where:** Your local development PC (uploading TO server)

**Option A: Using SCP**
```powershell
# Create the version directory on server first
ssh user@example.com "mkdir -p /var/www/puca/releases/v0.3.0"

# Upload the bundle
scp mobile-bundle.zip user@example.com:/var/www/puca/releases/v0.3.0/
```

**Option B: Using SFTP Client (FileZilla, WinSCP)**
1. Connect to `example.com`
2. Navigate to `/var/www/puca/releases/`
3. Create folder `v0.3.0`
4. Upload `mobile-bundle.zip`

#### Step 6: Deploy Updated Backend

📍 **Where:** Your local development PC (building), then server (running)

**Build on local PC:**
```powershell
cd <repo>
cargo build --release
```

**Upload to server:**
```powershell
scp target\release\sovereign.exe user@example.com:/var/www/puca/
```

**Restart backend on server:**
📍 **Where:** SSH session to your server

```bash
ssh user@example.com
cd /var/www/puca
./stop-backend.sh    # Your stop script
./puca &        # Start new version
```

#### Step 7: Verify

Open the mobile app on any device. It will:
1. Show "Checking for updates..."
2. Download the new bundle
3. Apply it and reload with new UI

---

## Desktop (Tauri) Updates

Desktop updates download a new installer and prompt users to update.

### Important: Signing Keys

Desktop updates MUST be signed for security. The signature prevents malicious updates.

---

### One-Time Setup: Generate Signing Key

📍 **Where:** Your local development PC (keep a backup!)  
📁 **Directory:** `<repo>\frontend`

```powershell
npx tauri signer generate -w src-tauri/.tauri/puca.key --ci
```

This creates:
- `src-tauri/.tauri/puca.key` - **PRIVATE KEY (keep secret!)**
- `src-tauri/.tauri/puca.key.pub` - Public key (goes in config)

> ⚠️ **BACKUP YOUR PRIVATE KEY!** If you lose it, you cannot push updates.

---

### Step-by-Step: Pushing a Desktop Update

#### Step 1: Make Your Code Changes

📍 **Where:** Your local development PC  
Same as mobile - edit frontend files.

#### Step 2: Update Version Numbers

📍 **Where:** Your local development PC

**File 1:** `frontend/src-tauri/tauri.conf.json`
```json
{
  "version": "0.3.0",
  // ... rest of config
}
```

**File 2:** `src/update_routes.rs`
```rust
pub const CURRENT_VERSION: &str = "0.3.0";
```

#### Step 3: Build Signed Release

📍 **Where:** Your local development PC  
📁 **Directory:** `<repo>\frontend`

```powershell
# Set the signing key as environment variable
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content src-tauri\.tauri\puca.key -Raw)

# Build the release
npx tauri build
```

This creates in `src-tauri/target/release/bundle/`:
- `nsis/Púca_0.3.0_x64-setup.exe` - Windows installer
- `nsis/Púca_0.3.0_x64-setup.exe.sig` - Signature file

#### Step 4: Upload to Server

📍 **Where:** Your local development PC (uploading TO server)

```powershell
# Create version directory
ssh user@example.com "mkdir -p /var/www/puca/releases/v0.3.0"

# Upload installer and signature
scp src-tauri\target\release\bundle\nsis\Púca_0.3.0_x64-setup.exe user@example.com:/var/www/puca/releases/v0.3.0/
scp src-tauri\target\release\bundle\nsis\Púca_0.3.0_x64-setup.exe.sig user@example.com:/var/www/puca/releases/v0.3.0/
```

#### Step 5: Update Backend Manifest

📍 **Where:** Your local development PC  
📁 **File:** `src/update_routes.rs`

Update the signature in `get_platform_info()` function with the actual signature from the `.sig` file:

```rust
fn get_platform_info(platform: &str) -> Platforms {
    // Read the actual signature from the .sig file and paste here
    let windows_sig = "dW50cnVzdGVkIGNv..."; // From .exe.sig file
    // ...
}
```

#### Step 6: Deploy Updated Backend

📍 **Where:** Same as mobile - build locally, upload, restart on server.

#### Step 7: Verify

Open the desktop app. It will:
1. Check for updates on startup
2. Show "Updating to v0.3.0..."
3. Download installer
4. Prompt to install and relaunch

---

## Server Setup

### Directory Structure on Server

```
/var/www/puca/
├── puca              # Backend executable
├── releases/
│   ├── v0.1.0/
│   │   └── Púca_0.1.0_x64-setup.exe
│   ├── v0.2.0/
│   │   ├── mobile-bundle.zip
│   │   ├── Púca_0.2.0_x64-setup.exe
│   │   └── Púca_0.2.0_x64-setup.exe.sig
│   └── v0.3.0/
│       ├── mobile-bundle.zip
│       ├── Púca_0.3.0_x64-setup.exe
│       └── Púca_0.3.0_x64-setup.exe.sig
└── .env                   # Environment variables
```

### Nginx Configuration (if using reverse proxy)

📍 **Where:** SSH session to your server  
📄 **File:** `/etc/nginx/sites-available/puca`

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    # API requests
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }

    # Static release files
    location /releases {
        root /var/www/puca;
        autoindex off;
    }
}
```

---

## Quick Reference: Where to Run Each Command

| Command | Location | Directory |
|---------|----------|-----------|
| `npm run build` | Local PC | `frontend/` |
| `Compress-Archive ...` | Local PC | `frontend/` |
| `cargo build --release` | Local PC | Root project |
| `npx tauri build` | Local PC | `frontend/` |
| `scp ...` | Local PC | Anywhere |
| `ssh user@example.com` | Local PC | Anywhere |
| `./puca` | Server (SSH) | `/var/www/puca/` |
| `systemctl restart puca` | Server (SSH) | Anywhere |

---

## Troubleshooting

### Mobile: "Checking for updates..." never finishes

1. Check backend is running: `curl https://example.com/api/mobile-updates/check`
2. Check bundle exists: `ls /var/www/puca/releases/v0.X.0/mobile-bundle.zip`
3. Check CORS is enabled in backend

### Desktop: "Wrong password for key"

1. Regenerate key with `--ci` flag (no password)
2. Make sure `TAURI_SIGNING_PRIVATE_KEY` is set correctly

### Desktop: Signature verification failed

1. Make sure the `.sig` file was uploaded
2. Verify the signature in `update_routes.rs` matches the `.sig` file
3. Ensure the `pubkey` in `tauri.conf.json` matches your key

### Both: Update not detected

1. Check version numbers are incremented
2. Backend `CURRENT_VERSION` must be higher than installed version
3. Restart the backend after changing version

---

## Version Checklist

When releasing a new version, update these files:

- [ ] `src/update_routes.rs` → `CURRENT_VERSION`
- [ ] `frontend/src-tauri/tauri.conf.json` → `version`
- [ ] `frontend/src-tauri/Cargo.toml` → `version` (optional)
- [ ] Upload mobile-bundle.zip
- [ ] Upload desktop installer + .sig
- [ ] Deploy updated backend
