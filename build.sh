#!/bin/bash
# Puca - Unified Build & Deploy Script
# Builds frontend and syncs to all platforms (desktop + mobile)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
VERSION=$(date +%Y.%m.%d.%H%M)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[BUILD]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Parse arguments
PLATFORM="all"  # all, web, ios, android, desktop
PROD=false
DEPLOY=false

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --platform|-p) PLATFORM="$2"; shift ;;
        --prod) PROD=true ;;
        --deploy|-d) DEPLOY=true ;;
        --version|-v) VERSION="$2"; shift ;;
        --help|-h) 
            echo "Usage: $0 [options]"
            echo "  --platform, -p  <all|web|ios|android|desktop>  Target platform (default: all)"
            echo "  --prod          Production build"
            echo "  --deploy, -d    Deploy after build"
            echo "  --version, -v   Version string"
            exit 0
            ;;
        *) error "Unknown parameter: $1" ;;
    esac
    shift
done

log "Starting build for platform: $PLATFORM (version: $VERSION)"

# Step 1: Build frontend
build_frontend() {
    log "Building frontend..."
    cd "$FRONTEND_DIR"
    
    # Install dependencies if needed.
    #
    # `npm ci`, not `npm install`: this script builds the artifacts that get
    # SIGNED and shipped, so its dependency tree has to be the one in
    # package-lock.json. `npm install` is free to pick up any newer version
    # inside each semver range, which means a release could contain a package
    # nobody reviewed — including the OTA updater plugin that verifies bundle
    # signatures. CI already uses `npm ci`; the release path did not.
    if [ ! -d "node_modules" ]; then
        log "Installing dependencies (npm ci, from the lockfile)..."
        npm ci
    fi
    
    # Run TypeScript check
    log "Type checking..."
    npm run lint || warn "Lint warnings found"
    
    # Build
    if [ "$PROD" = true ]; then
        log "Production build..."
        npm run build
    else
        log "Development build..."
        npm run build
    fi
    
    success "Frontend build complete"
}

# Step 2: Sync Capacitor (iOS/Android)
sync_capacitor() {
    log "Syncing Capacitor platforms..."
    cd "$FRONTEND_DIR"
    
    if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "all" ]; then
        log "Syncing iOS..."
        npx cap sync ios
        success "iOS synced"
    fi
    
    if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "all" ]; then
        log "Syncing Android..."
        npx cap sync android
        success "Android synced"
    fi
}

# Step 3: Build Desktop (Tauri)
build_desktop() {
    if [ "$PLATFORM" = "desktop" ] || [ "$PLATFORM" = "all" ]; then
        log "Building desktop app (Tauri)..."
        cd "$FRONTEND_DIR"
        
        if [ "$PROD" = true ]; then
            npm run tauri:build
        else
            log "Skipping desktop build (use --prod for release build)"
        fi
        
        success "Desktop build complete"
    fi
}

# Step 4: Deploy (if requested)
deploy_apps() {
    if [ "$DEPLOY" = false ]; then
        return
    fi
    
    log "Deploying..."
    
    # Web deployment (copy to server)
    if [ "$PLATFORM" = "web" ] || [ "$PLATFORM" = "all" ]; then
        log "Deploying web..."
        # Add your web deployment command here
        # e.g., rsync -avz dist/ user@server:/var/www/puca/
        warn "Web deployment not configured - add your deployment command"
    fi
    
    # Capacitor Live Update (Capgo)
    if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "all" ]; then
        log "Pushing OTA update via Capgo..."
        cd "$FRONTEND_DIR"
        
        if command -v npx &> /dev/null && npx cap-go --version &> /dev/null 2>&1; then
            npx @capgo/cli bundle upload --channel production
            success "OTA update pushed"
        else
            warn "Capgo CLI not configured - skipping OTA update"
        fi
    fi
}

# Main execution
log "=== Puca Build System ==="
log "Platform: $PLATFORM"
log "Production: $PROD"
log "Deploy: $DEPLOY"
echo ""

build_frontend

if [ "$PLATFORM" != "web" ] && [ "$PLATFORM" != "desktop" ]; then
    sync_capacitor
fi

if [ "$PLATFORM" = "desktop" ] || [ "$PLATFORM" = "all" ]; then
    build_desktop
fi

deploy_apps

echo ""
success "=== Build Complete ==="
echo ""
echo "Next steps:"
echo "  iOS:     cd frontend && npx cap open ios"
echo "  Android: cd frontend && npx cap open android"
echo "  Desktop: cd frontend && npm run tauri:dev"
echo "  Web:     cd frontend && npm run preview"
