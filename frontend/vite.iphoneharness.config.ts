import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineFlags, liteAliases } from './vite.shared'

/**
 * The phone stream harness (e2e/iphone-stream/): the REAL StreamStage and
 * StreamPip inside the real phone chat chrome, with every stylesheet the app
 * loads. Built into the gitignored e2e-artifacts/ by
 * e2e/iphone-stream-real-browser.mjs; never part of a release.
 *
 *   npx vite build --config vite.iphoneharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('./e2e/iphone-stream'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-iphoneharness'),
  // Nothing here may reach a real server: the API is a closed port.
  define: { ...defineFlags, 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  resolve: { alias: liteAliases },
  plugins: [react()],
  build: {
    outDir: here('./e2e-artifacts/iphone-stream-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
  },
})
