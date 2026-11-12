import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineFlags, liteAliases } from './vite.shared'

/**
 * The Devices page harness (e2e/devices-power/): the REAL DevicesView, its
 * cards and CSS, the real api/devices/powerOff.ts and the app's own question
 * (AppDialogs), with three modules swapped for stand-ins — the device list,
 * the incoming shares and the device-session layer, which plays each PC the
 * way the real hosts answer a power-off. Built into the gitignored
 * e2e-artifacts/ by e2e/devices-power-real-browser.mjs; never part of a
 * release.
 *
 *   npx vite build --config vite.devicesharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const norm = (p: string) => path.normalize(p).toLowerCase()

/** Real module -> its stand-in. Each stand-in re-exports the real module
 *  and overrides only what it plays, so nothing else in the graph breaks. */
const SWAPS = new Map<string, string>([
  [norm(here('./src/api/devices/session.ts')), here('./e2e/devices-power/fakeSession.ts')],
  [norm(here('./src/api/devices/index.ts')), here('./e2e/devices-power/fakeDevices.ts')],
  [norm(here('./src/api/devices/shares.ts')), here('./e2e/devices-power/fakeShares.ts')],
])
const FAKES = new Set([...SWAPS.values()].map(norm))

function swapModules(): Plugin {
  return {
    name: 'devices-harness-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // A stand-in's own import of the real module must reach the real one.
      if (!importer || FAKES.has(norm(importer))) return null
      if (!/devices|session|shares/.test(source)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      return SWAPS.get(norm(resolved.id)) ?? null
    },
  }
}

export default defineConfig({
  root: here('./e2e/devices-power'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-devicesharness'),
  // Nothing here may reach a real server: the API is a closed port.
  define: { ...defineFlags, 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  resolve: { alias: liteAliases },
  plugins: [swapModules(), react()],
  build: {
    outDir: here('./e2e-artifacts/devices-power-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
  },
})
