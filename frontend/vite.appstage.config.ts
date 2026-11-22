import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineFlags, liteAliases, vendorChunks } from './vite.shared'

/**
 * The REAL APP (index.html, the whole Chat) with the device session layer's
 * stage half played by the device-stage harness's stand-in host
 * (e2e/app-stage/session.ts), so a remote-control session can be put on
 * screen in a real browser with no PC at the other end. Built into the
 * gitignored e2e-artifacts/ by hand for e2e/return-pill-live.mjs; never part
 * of a release.
 *
 *   VITE_API_URL=<throwaway API> npx vite build --config vite.appstage.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const SESSION = path.normalize(here('./src/api/devices/session.ts'))
const BRIDGE = path.normalize(here('./e2e/app-stage/session.ts'))
const FAKE = path.normalize(here('./e2e/device-stage/fakeSession.ts'))

/** Every import of the session module, except the bridge's own, gets the bridge. */
function swapSession(): Plugin {
  return {
    name: 'app-stage-swap-session',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null
      const from = path.normalize(importer)
      if (from === BRIDGE || from === FAKE) return null
      if (!/devices\/session(\.ts)?$|^\.\/session$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved && path.normalize(resolved.id) === SESSION) return BRIDGE
      return null
    },
  }
}

export default defineConfig({
  define: defineFlags,
  resolve: { alias: liteAliases },
  plugins: [swapSession(), react()],
  cacheDir: here('./node_modules/.vite-appstage'),
  build: {
    outDir: here('./e2e-artifacts/app-stage-dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { manualChunks: vendorChunks } },
    chunkSizeWarningLimit: 8000,
  },
})
