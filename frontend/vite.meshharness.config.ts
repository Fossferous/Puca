import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineFlags } from './vite.shared'

/**
 * The mesh E2EE interop harness (e2e/mesh-e2ee/): the REAL rtc/manager.ts,
 * mediaCrypto.ts, frameCrypto.ts, scriptTransform.ts and its worker, and
 * e2ee.ts, built the way the app builds them, with stand-ins only for the
 * manager's dependencies on a server or a capture graph. Built into the
 * gitignored e2e-artifacts/ by e2e/mesh-e2ee-interop-real-browser.mjs; never
 * part of a release.
 *
 *   npx vite build --config vite.meshharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const RTC = path.normalize(here('./src/api/rtc'))
const STUBS = here('./e2e/mesh-e2ee/stubs')

/** What the rtc modules import that needs a server or a capture graph. */
const STAND_INS: Record<string, string> = {
  '../websocket': path.join(STUBS, 'websocket.ts'),
  '../iceConfig': path.join(STUBS, 'iceConfig.ts'),
  '../keyVerification': path.join(STUBS, 'keyVerification.ts'),
  './media': path.join(STUBS, 'media.ts'),
  // No remote control in the harness: the lane registry's stand-in, as the lite build uses.
  './controlDc': here('./src/api/rtc/controlDc.lite.ts'),
}

function standIns(): Plugin {
  return {
    name: 'mesh-harness-stand-ins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || path.dirname(path.normalize(importer)) !== RTC) return null
      return STAND_INS[source] ?? null
    },
  }
}

export default defineConfig({
  root: here('./e2e/mesh-e2ee'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-meshharness'),
  // Nothing here may reach a real server: the API is a closed port.
  define: { ...defineFlags, __RC_ENABLED__: 'false', 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  plugins: [standIns()],
  build: {
    outDir: here('./e2e-artifacts/mesh-e2ee-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
  },
})
