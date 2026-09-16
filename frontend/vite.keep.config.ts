import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { RC_ENABLED, defineFlags, liteAliases, rcExclusionGuard, vendorChunks } from './vite.shared'

/**
 * Púca Keep — the notes front door, built as its OWN bundle into dist/keep/.
 *
 *   npx vite build --config vite.keep.config.ts      (npm run build runs it after the main build)
 *   npm run dev  →  http://localhost:5173/keep/      (the main dev server serves keep/index.html)
 *
 * A separate build, not a second entry of the main one: vite.shared.ts's
 * header has the two release-path reasons. The web deploy is the whole of
 * dist/ (deploy/webapp/README.md), so dist/keep/ ships with the webapp
 * tarball automatically; the native shells strip it back out
 * (scripts/strip-keep-from-native.mjs) because Keep is a browser surface —
 * the desktop and mobile shells run at their own origins where the session
 * and the E2EE seed are not shared with it.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * KEEP_TARGET=native builds the same page for the Púca Keep Android shell
 * (keep-app/): served from the WebView's root, so base is '/', and written
 * to its own dist-keep-app/ so the web tarball (dist/) is untouched. The
 * manifest and icons ride along there because nothing else supplies them.
 */
const NATIVE = process.env.KEEP_TARGET === 'native'

export default defineConfig({
  // The page lives in keep/, so its index.html is the root of this build and
  // lands at dist/keep/index.html (with root = frontend/ Vite would mirror the
  // path and write dist/keep/keep/index.html).
  root: here('./keep'),
  base: NATIVE ? '/' : '/keep/',
  // .env.production is read from the FRONTEND dir, not from keep/. Left at the
  // default (the root) this build would never see VITE_API_URL and would bake
  // the localhost fallback — the 2026-08-03 failure, on one page only.
  envDir: here('.'),
  // The manifest and icons are in public/keep/, which the MAIN build copies to
  // dist/keep/ (and the dev server serves at /keep/); this build adds only its
  // page and assets beside them.
  publicDir: NATIVE ? here('./public/keep') : false,
  cacheDir: here('./node_modules/.vite-keep'),
  define: defineFlags,
  resolve: {
    alias: liteAliases,
  },
  plugins: [react(), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
  build: {
    outDir: NATIVE ? here('./dist-keep-app') : here('./dist/keep'),
    // The main build empties dist/ (dist/keep included) before this one runs;
    // emptying dist/keep again here would delete the manifest and icons the
    // main build just placed there. The native output dir is this build's own.
    emptyOutDir: NATIVE,
    rollupOptions: {
      output: {
        manualChunks: vendorChunks,
      },
    },
    chunkSizeWarningLimit: 700,
  },
})
