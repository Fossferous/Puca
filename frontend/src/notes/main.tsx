/**
 * Púca Notes — entry point. Served at /notes/ (frontend/notes/index.html, built
 * by vite.notes.config.ts into dist/notes/).
 *
 * A second document on the web app's origin: same account, same E2EE seed,
 * same settings, same task API — its own shell. What Púca's main.tsx boots
 * that Notes does NOT: the WebSocket (see model/notesQueries.ts — a bare
 * socket would eat parked file offers), the P2P transfer wiring, device
 * attestation, the remote-control globals, the Tauri hooks. Notes never runs
 * inside PÚCA's shells (scripts/strip-notes-from-native.mjs keeps it out of
 * them) — but it IS the whole page of its own Android app (notes-app/), and
 * there it blesses its OTA bundle first and runs NotesUpdateGate. What it MUST
 * replay: the appearance boot below, or the theme, contrast, text scale and
 * icon style a user chose in Púca do nothing here.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import '../index.css'
import { applyAppearance, loadSettings } from '../components/settingsStore'

// FIRST STATEMENT ON PURPOSE, as in Púca's main.tsx (read the comment there):
// inside the Notes Android app, bless the running OTA bundle before anything
// can be slow, or Capgo's appReadyTimeout (notes-app/capacitor.config.ts)
// rolls it back and the gate re-downloads it forever. A bundle that never
// gets this far — a white screen, a wrong base — is rolled back, which is the
// point. The browser page skips it.
if (typeof window !== 'undefined'
    && 'Capacitor' in window
    && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor?.isNativePlatform?.()) {
    void import('@capgo/capacitor-updater')
        .then(({ CapacitorUpdater }) => CapacitorUpdater.notifyAppReady())
        .catch(() => { /* plugin absent (a Notes APK from before OTA) — nothing to bless */ })
}

// BEFORE the first render, exactly as main.tsx does: the login screen renders
// long before anything else could apply the theme, and every appearance
// setting lives in root attributes / vars that CSS reads. The icon style is a
// module store the icons subscribe to, so CSS alone could never swap it.
applyAppearance(loadSettings())

import './notes.css'
// LAST — its coarse-pointer block must win the cascade at equal specificity
// (docs/DESIGN_PHILOSOPHY.md §6). It also defines the --safe-area-* vars and
// the blanket 44px touch-target rule Notes' own mobile block builds on.
import '../mobile.css'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { NotesApp } from './NotesApp'
import { NotesUpdateGate } from './components/NotesUpdateGate'
import { makeNotesQueryClient } from './model/notesQueries'
import { bootNotesOffline } from './model/notesBoot'

const queryClient = makeNotesQueryClient()
// The sealed on-device cache and the web-only offline worker (never awaited:
// the first render does not wait on IndexedDB).
void bootNotesOffline(queryClient)

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
                <NotesUpdateGate>
                    <NotesApp />
                </NotesUpdateGate>
            </QueryClientProvider>
        </ErrorBoundary>
    </StrictMode>,
)
