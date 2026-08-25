import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// The version lives in tauri.conf.json and NOWHERE else (see CLAUDE.md), so read
// it from there rather than duplicating it. Injected as a define so the web and
// mobile builds can report a version without asking Tauri, which does not exist
// on either.
const APP_VERSION = JSON.parse(
  readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
).version

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [react()],
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
