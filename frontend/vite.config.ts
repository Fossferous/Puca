import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { APP_VERSION, RC_ENABLED, defineFlags, liteAliases, rcExclusionGuard, vendorChunks } from './vite.shared'

// The main app. Everything shared with the Púca Keep build (vite.keep.config.ts)
// — the version define, the lite build's remote-control exclusion, the vendor
// chunking — lives in vite.shared.ts; this file is only what is specific to
// THIS bundle. Keep is a separate build on purpose: see vite.shared.ts's
// header for the two ways a second entry here would break the release path.

/**
 * Emit `dist/version.json` = `{ "version": "<tauri.conf.json version>" }`.
 *
 * The mobile OTA manifest's version is a hand-typed argument to dual-ship.sh
 * with no tie to the bytes it points at, and the installed app used to record
 * that label as "what I am running" — one slip locked every phone that took it
 * out of OTA until an APK reinstall (0.9.810 audit, C-04). This file is the
 * bundle's own word: encrypt-bundle.mjs copies it into a `<bundle>.version`
 * sidecar and dual-ship.sh refuses a manifest that disagrees with it.
 */
function emitVersionJson(): Plugin {
  return {
    name: 'puca-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: APP_VERSION }) + '\n' })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: defineFlags,
  resolve: {
    alias: liteAliases,
  },
  plugins: [react(), emitVersionJson(), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
  build: {
    // NO `rollupOptions.input` here, ever: the entry chunk must stay
    // `assets/index-*.js` (deploy/ops/dual-ship.sh and check-versions.sh grep
    // that literal name) and the baked API host must stay IN that chunk —
    // scripts/check-dist-entries.mjs asserts both after every build.
    rollupOptions: {
      output: {
        manualChunks: vendorChunks,
      },
    },
    // Vendor chunks legitimately exceed the default 500 kB hint; raise it so the
    // build output isn't cluttered with an expected warning.
    chunkSizeWarningLimit: 700,
  },
})
