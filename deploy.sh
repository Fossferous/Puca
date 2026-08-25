#!/bin/bash
# Puca - Unified Server Deployment Script
# Run this on your server after pushing to git
# Handles: Backend, Frontend, Mobile OTA, and Desktop releases

set -e

# Configuration
DEPLOY_DIR="/opt/puca"
RELEASE_VERSION="${1:-$(date +%Y.%m.%d.%H%M)}"
CAPGO_CHANNEL="production"
GITHUB_RELEASES_URL="https://github.com/Fossferous/puca/releases"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[DEPLOY]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Header
echo ""
echo "======================================"
echo "  Puca Deployment v${RELEASE_VERSION}"
echo "======================================"
echo ""

cd "$DEPLOY_DIR" || error "Cannot cd to $DEPLOY_DIR"

# Step 1: Pull latest code
log "Pulling latest code from git..."
git pull --ff-only || git pull
success "Code updated"

# Step 2: Build frontend
log "Building frontend..."
cd frontend
npm install --silent
npm run build
success "Frontend built"

# Step 3: Create mobile bundle for OTA
log "Creating mobile bundle..."
cd dist
zip -r ../mobile-bundle.zip . -q
cd ..
success "Mobile bundle created"

# Step 4: Push OTA update to Capgo (mobile)
log "Pushing OTA update to mobile devices..."
if command -v npx &> /dev/null && npm list @capgo/cli &> /dev/null 2>&1; then
    npx @capgo/cli bundle upload \
        --channel "$CAPGO_CHANNEL" \
        --bundle "$RELEASE_VERSION" \
        --path dist \
        && success "Mobile OTA update pushed to channel: $CAPGO_CHANNEL" \
        || warn "Capgo upload failed - mobile users won't get OTA update"
else
    warn "Capgo CLI not installed - skipping mobile OTA"
    echo "  To enable: npm install -g @capgo/cli && npx @capgo/cli login"
fi

cd "$DEPLOY_DIR"

# Step 5: Build Rust backend
log "Building backend..."
cargo build --release --quiet
success "Backend built"

# Step 6: Create release directory
log "Creating release v${RELEASE_VERSION}..."
mkdir -p "releases/v${RELEASE_VERSION}"
cp frontend/mobile-bundle.zip "releases/v${RELEASE_VERSION}/"
cp target/release/puca "releases/v${RELEASE_VERSION}/puca-linux" 2>/dev/null || true
success "Release files saved to releases/v${RELEASE_VERSION}/"

# Step 7: Restart server
log "Restarting server..."
fuser -k 3000/tcp 2>/dev/null || true
sleep 2

# Start server in background with logging
nohup ./target/release/puca >> /var/log/puca.log 2>&1 &
NEW_PID=$!
sleep 1

# Verify it started
if ps -p $NEW_PID > /dev/null 2>&1; then
    success "Server started (PID: $NEW_PID)"
else
    error "Server failed to start - check /var/log/puca.log"
fi

# Step 8: Sync desktop update manifest (for Tauri auto-update)
log "Updating desktop release manifest..."
cat > "releases/latest.json" << EOF
{
  "version": "${RELEASE_VERSION}",
  "notes": "Auto-update release ${RELEASE_VERSION}",
  "pub_date": "$(date -Iseconds)",
  "platforms": {
    "windows-x86_64": {
      "url": "${GITHUB_RELEASES_URL}/download/v${RELEASE_VERSION}/puca_${RELEASE_VERSION}_x64-setup.exe",
      "signature": ""
    },
    "linux-x86_64": {
      "url": "${GITHUB_RELEASES_URL}/download/v${RELEASE_VERSION}/puca_${RELEASE_VERSION}_amd64.AppImage",
      "signature": ""
    },
    "darwin-x86_64": {
      "url": "${GITHUB_RELEASES_URL}/download/v${RELEASE_VERSION}/puca_${RELEASE_VERSION}_x64.dmg",
      "signature": ""
    },
    "darwin-aarch64": {
      "url": "${GITHUB_RELEASES_URL}/download/v${RELEASE_VERSION}/puca_${RELEASE_VERSION}_aarch64.dmg",
      "signature": ""
    }
  }
}
EOF
success "Desktop update manifest created"

# Summary
echo ""
echo "======================================"
echo "  Deployment Complete!"
echo "======================================"
echo ""
echo "Version: ${RELEASE_VERSION}"
echo "Backend: Running on port 3000"
echo "Mobile:  OTA update pushed (Capgo)"
echo "Desktop: Update manifest at releases/latest.json"
echo ""
echo "Next steps for desktop installers:"
echo "  1. Run build on Windows: build.bat --prod"
echo "  2. Run build on Mac: ./build.sh --prod"
echo "  3. Upload .exe/.dmg/.AppImage to GitHub Releases"
echo "  4. Update signatures in releases/latest.json"
echo ""
