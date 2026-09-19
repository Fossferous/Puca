import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { RC_ENABLED, defineFlags, emitVersionJson, liteAliases, rcExclusionGuard, vendorChunks } from './vite.shared'

/**
 * Púca Notes — the notes front door, built as its OWN bundle into dist/notes/.
 *
 *   npx vite build --config vite.notes.config.ts      (npm run build runs it after the main build)
 *   npm run dev  →  http://localhost:5173/notes/      (the main dev server serves notes/index.html)
 *
 * A separate build, not a second entry of the main one: vite.shared.ts's
 * header has the two release-path reasons. The web deploy is the whole of
 * dist/ (deploy/webapp/README.md), so dist/notes/ ships with the webapp
 * tarball automatically; Púca's phone shells strip it back out
 * (scripts/strip-notes-from-native.mjs) and the desktop installer embeds a
 * copy of dist/ without it (scripts/stage-desktop-dist.mjs), because in the
 * browser Notes is a page of the web app's origin — Púca's shells run at their
 * own origins, where the session and the E2EE seed are not shared with it.
 * Notes' OWN Android app is the native build below.
 */
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * NOTES_TARGET=native builds the same page for the Púca Notes Android shell
 * (notes-app/): served from the WebView's root, so base is '/', and written
 * to its own dist-notes-app/ so the web tarball (dist/) is untouched. The
 * manifest and icons ride along there because nothing else supplies them.
 * Only this build emits version.json ({"app": "notes"}): it is the one that
 * becomes an OTA bundle for the Notes app (scripts/build-notes-app.mjs --ota),
 * and encrypt-bundle.mjs --notes refuses anything that does not say "notes".
 * The web build writes none, so dist/notes/ can never pass for a Notes bundle.
 */
const NATIVE = process.env.NOTES_TARGET === 'native'

export default defineConfig({
  // The page lives in notes/, so its index.html is the root of this build and
  // lands at dist/notes/index.html (with root = frontend/ Vite would mirror the
  // path and write dist/notes/notes/index.html).
  root: here('./notes'),
  base: NATIVE ? '/' : '/notes/',
  // .env.production is read from the FRONTEND dir, not from notes/. Left at the
  // default (the root) this build would never see VITE_API_URL and would bake
  // the localhost fallback — the 2026-08-03 failure, on one page only.
  envDir: here('.'),
  // The manifest and icons are in public/notes/, which the MAIN build copies to
  // dist/notes/ (and the dev server serves at /notes/); this build adds only its
  // page and assets beside them.
  publicDir: NATIVE ? here('./public/notes') : false,
  cacheDir: here('./node_modules/.vite-notes'),
  define: defineFlags,
  resolve: {
    alias: liteAliases,
  },
  plugins: [react(), ...(NATIVE ? [emitVersionJson('notes')] : []), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
  build: {
    outDir: NATIVE ? here('./dist-notes-app') : here('./dist/notes'),
    // The main build empties dist/ (dist/notes included) before this one runs;
    // emptying dist/notes again here would delete the manifest and icons the
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
