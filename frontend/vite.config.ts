import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { RC_ENABLED, defineFlags, emitVersionJson, liteAliases, rcExclusionGuard, vendorChunks } from './vite.shared'

// The main app. Everything shared with the Púca Notes build (vite.notes.config.ts)
// — the version define, the lite build's remote-control exclusion, the vendor
// chunking — lives in vite.shared.ts; this file is only what is specific to
// THIS bundle. Notes is a separate build on purpose: see vite.shared.ts's
// header for the two ways a second entry here would break the release path.

// https://vite.dev/config/
export default defineConfig({
  define: defineFlags,
  resolve: {
    alias: liteAliases,
  },
  // dist/version.json = {"version", "app": "puca"} — see emitVersionJson.
  plugins: [react(), emitVersionJson('puca'), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
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
