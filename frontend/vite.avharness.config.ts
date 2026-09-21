import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineFlags, liteAliases, RC_ENABLED, rcExclusionGuard } from './vite.shared'

/**
 * The clip A/V emulation harness (e2e/av-emulation/) as its own tiny bundle:
 * the REAL replayBuffer / nativeCapture / replay worker / clip crypto, driven
 * from a page with an emulated Rust side. Built into the gitignored
 * e2e-artifacts/ by e2e/clip-av-emulation.mjs; never part of a release.
 *
 *   npx vite build --config vite.avharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('./e2e/av-emulation'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-avharness'),
  // The app's modules fetch their API at import (the ICE config); the harness
  // must never reach a real server, so its API is a closed port.
  define: { ...defineFlags, 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  resolve: { alias: liteAliases },
  plugins: [react(), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
  build: {
    outDir: here('./e2e-artifacts/av-emulation-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
})
