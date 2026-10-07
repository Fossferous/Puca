import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineFlags, liteAliases } from './vite.shared'

/**
 * The remote-control stage harness (e2e/device-stage/): the REAL DeviceStage,
 * its menus, keyboard bar and zoom maths, with the session module swapped for
 * a stand-in host (e2e/device-stage/fakeSession.ts). Built into the gitignored
 * e2e-artifacts/ by e2e/device-stage-real-browser.mjs; never part of a release.
 *
 *   npx vite build --config vite.stageharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const SESSION = path.normalize(here('./src/api/devices/session.ts'))
const FAKE = here('./e2e/device-stage/fakeSession.ts')

/** Every import that resolves to the session module gets the stand-in. */
function swapSession(): Plugin {
  return {
    name: 'stage-harness-swap-session',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || path.normalize(importer) === path.normalize(FAKE)) return null
      if (!/devices\/session(\.ts)?$|^\.\/session$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved && path.normalize(resolved.id) === SESSION) return FAKE
      return null
    },
  }
}

export default defineConfig({
  root: here('./e2e/device-stage'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-stageharness'),
  // Nothing here may reach a real server: the API is a closed port.
  define: { ...defineFlags, 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  resolve: { alias: liteAliases },
  plugins: [swapSession(), react()],
  build: {
    outDir: here('./e2e-artifacts/device-stage-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
  },
})
