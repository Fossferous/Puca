import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineFlags } from './vite.shared'

/**
 * The clip-share harness (e2e/clip-share/): the REAL api/clips/replayBuffer.ts
 * and its replay worker, and the REAL rtc/media.ts MediaManager that starts a
 * screen share, built the way the app builds them. Stand-ins only for what a
 * headless browser does not have: the desktop shell (replayBuffer asks
 * `isTauri()` before it arms) and the rest of the call stack behind
 * `webrtcManager` (no server, no peers). Built into the gitignored
 * e2e-artifacts/ by e2e/clip-share-follow-real-browser.mjs; never part of a
 * release.
 *
 *   npx vite build --config vite.clipshareharness.config.ts
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLIPS = path.normalize(here('./src/api/clips'))
const STUBS = here('./e2e/clip-share/stubs')

/** What the clip modules import that needs the desktop shell or a call.
 *  Forward slashes: vite keys modules by id, and the page imports the same
 *  webrtc stand-in itself, so a backslash spelling of it would be a SECOND
 *  module (a second MediaManager the share never goes through). */
const posix = (p: string) => p.split(path.sep).join('/')
const STAND_INS: Record<string, string> = {
  '../webrtc': posix(path.join(STUBS, 'webrtc.ts')),
  '../platform': posix(path.join(STUBS, 'platform.ts')),
}

function standIns(): Plugin {
  return {
    name: 'clip-share-harness-stand-ins',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || path.dirname(path.normalize(importer)) !== CLIPS) return null
      return STAND_INS[source] ?? null
    },
  }
}

export default defineConfig({
  root: here('./e2e/clip-share'),
  base: './',
  envDir: here('.'),
  publicDir: false,
  cacheDir: here('./node_modules/.vite-clipshareharness'),
  // Nothing here may reach a real server: the API is a closed port.
  define: { ...defineFlags, __RC_ENABLED__: 'false', 'import.meta.env.VITE_API_URL': JSON.stringify('http://127.0.0.1:9') },
  plugins: [standIns()],
  build: {
    outDir: here('./e2e-artifacts/clip-share-dist'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
  },
})
