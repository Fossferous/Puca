import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The version lives in tauri.conf.json and NOWHERE else (see CLAUDE.md), so read
// it from there rather than duplicating it. Injected as a define so the web and
// mobile builds can report a version without asking Tauri, which does not exist
// on either.
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
).version

// ---------------------------------------------------------------------------
// Remote control: present, or physically absent
//
// A "lite" build (VITE_ENABLE_RC=false) must not merely hide remote control —
// the code must not be in the artifact. Gating renders and deferring imports
// was tried and is NOT sufficient: a chunk that is never fetched is still a
// chunk that ships, and a single static import from preserved code keeps the
// whole graph alive regardless of any runtime flag.
//
// Three things make it real, and all three are needed:
//   1. __RC_ENABLED__ is a raw boolean literal, so a gate compiles to
//      `if (false)` IN THE CONSUMING MODULE and Rollup drops the branch and
//      the dynamic import edge inside it. Reading a const from another module
//      folds too, but only after cross-module analysis — this does not rely on
//      that inference.
//   2. Two aliases swap the always-mounted RC surface for real stand-ins
//      (RcGlobals.lite, remoteControl.lite), so the originals never enter the
//      module graph at all.
//   3. rcExclusionGuard() FAILS THE BUILD if any RC module got in anyway.
//      Without it, a future static import would quietly restore the code and
//      the build would still look green.
// ---------------------------------------------------------------------------
const RC_ENABLED = process.env.VITE_ENABLE_RC !== 'false'

const src = (p: string) => fileURLToPath(new URL('./src/' + p, import.meta.url))

/**
 * Module ids that must never appear in a lite bundle.
 *
 * Directory-level for api/devices (everything shared has been moved out of it:
 * pagePainting, thisDevice, deviceIdentity/*, androidStorage, logoutHooks,
 * rmoveScale) plus the RC-only components and the real remoteControl module.
 *
 * Matched against resolved ids, so it catches a module reached by any path —
 * a re-export, a dynamic import, or an alias someone adds later.
 */
const RC_MODULE_PATTERNS: RegExp[] = [
  /[\\/]src[\\/]api[\\/]devices[\\/]/,
  /[\\/]src[\\/]api[\\/]remoteControl\.ts$/,
  /[\\/]src[\\/]components[\\/]RcGlobals\.tsx$/,
  // Device* components. DELIBERATELY a prefix match on DeviceStage rather than
  // an enumeration: the first version listed `Stage|StageMobile\w*|…` and so
  // missed DeviceStageVirtualMouse.tsx — the phone's virtual mouse pad, which
  // is remote-control code. It happened not to ship (DeviceStage imports it and
  // that is excluded), so the gap was invisible; the backstop would have missed
  // it the moment anything preserved imported it. RcGlobals.lite.tsx is
  // excluded from this by the `s` in the alternation never matching it.
  /[\\/]src[\\/]components[\\/]DeviceStage\w*\.tsx$/,
  /[\\/]src[\\/]components[\\/]Device(sView|FileBrowser|FileManager|Downloads|ShareModal)\.tsx$/,
  /[\\/]src[\\/]components[\\/](RemoteControlOverlay|HostConsentPrompt|HostFilesIndicator|FileAccessPrompt|UnattendedPassphrasePrompt|ServiceUpdateBanner)\.tsx$/,
  /[\\/]src[\\/]components[\\/]device(AutoKeyboard|StageStall)\.ts$/,
]

// SHARED DESPITE THE NAME — do not add these to the list above.
//
// deviceStageResume.ts and deviceZoomFollow.ts are named for the remote-control
// stage they were written for, but both are pure leaf modules (zero imports)
// holding generic logic that preserved features depend on:
//   - deviceStageResume: re-plays a <video> that the OS paused when the app was
//     backgrounded. VoiceStage, StreamStage, StreamPip and StreamDocPipWindow
//     all use it for ORDINARY voice screen shares.
//   - deviceZoomFollow: zoom/pan geometry, reused by ImageLightbox and
//     imageZoom for pinch-zooming a picture in chat.
// Excluding them broke the lite build here, which is how they were found.

/**
 * Fail the lite build if remote-control code entered the module graph.
 *
 * This is the backstop that turns "we believe it tree-shook" into "the build
 * fails if it did not". It reports EVERY offending module and who pulled it
 * in, because the fix is always at the importer, not the imported file.
 */
function rcExclusionGuard(): Plugin {
  const seen = new Set<string>()
  return {
    name: 'rc-exclusion-guard',
    apply: 'build',
    moduleParsed(info) {
      if (RC_MODULE_PATTERNS.some(re => re.test(info.id))) seen.add(info.id)
    },
    generateBundle() {
      // Importers are resolved late, so they are read HERE rather than in
      // moduleParsed — where the list is still empty and every offender looks
      // like a graph entry point, which hides the one thing needed to fix it.
      const offenders = new Map<string, string[]>()
      for (const id of seen) {
        const info = this.getModuleInfo(id)
        offenders.set(id, [
          ...(info?.importers ?? []),
          ...(info?.dynamicImporters ?? []).map(i => i + '  (dynamic)'),
        ])
      }
      if (offenders.size === 0) return
      const lines = [...offenders.entries()].map(([id, who]) => {
        const importers = who.filter(Boolean)
        return `  ${id}\n` + (importers.length
          ? importers.map(i => `      imported by ${i}`).join('\n')
          : '      (entry / no recorded importer)')
      })
      this.error(
        'rc-exclusion-guard: this is a lite build (VITE_ENABLE_RC=false) but '
        + `${offenders.size} remote-control module(s) are still in the graph, so they `
        + 'would ship in the bundle:\n' + lines.join('\n')
        + '\n\nFix the IMPORTER: gate it behind __RC_ENABLED__, move the shared '
        + 'helper it needs out of api/devices/, or add an alias in vite.config.ts.',
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    // A literal, so every `if (__RC_ENABLED__)` folds in place. See above.
    __RC_ENABLED__: JSON.stringify(RC_ENABLED),
  },
  resolve: {
    alias: RC_ENABLED ? [] : [
      // Swap the always-mounted RC surface for stand-ins that render nothing
      // and offer no control. Both are REAL modules with the same exported
      // shape, never empty stubs: an empty module makes the component
      // undefined and React throws at render.
      { find: /^\.\/components\/RcGlobals$/, replacement: src('components/RcGlobals.lite.tsx') },
      { find: /^(\.\.?\/)+api\/remoteControl$/, replacement: src('api/remoteControl.lite.ts') },
    ],
  },
  plugins: [react(), ...(RC_ENABLED ? [] : [rcExclusionGuard()])],
  build: {
    // Split large third-party libraries into their own cached chunks so the
    // main app bundle stays small and vendor code isn't re-downloaded on every
    // app change.
    rollupOptions: {
      output: {
        // Function form so sub-path imports (e.g. @noble/hashes/pbkdf2) are
        // matched too — the object form only matches bare package entry points.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('@noble')) return 'crypto-vendor'
          if (id.includes('@tanstack')) return 'query-vendor'
          // NOT the e2ee worker chunk — Vite emits that separately via the
          // `?worker` import; this only splits the main-thread SDK.
          if (id.includes('livekit-client')) return 'livekit-vendor'
          if (
            id.includes('/react-router') ||
            id.includes('/react-dom/') ||
            id.includes('/react/') ||
            id.includes('/scheduler/')
          ) return 'react-vendor'
        },
      },
    },
    // Vendor chunks legitimately exceed the default 500 kB hint; raise it so the
    // build output isn't cluttered with an expected warning.
    chunkSizeWarningLimit: 700,
  },
})
