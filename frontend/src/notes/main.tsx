/**
 * Púca Notes — entry point. Served at /notes/ (frontend/notes/index.html, built
 * by vite.notes.config.ts into dist/notes/).
 *
 * A second document on the web app's origin: same account, same E2EE seed,
 * same settings, same task API — its own shell. What Púca's main.tsx boots
 * that Notes does NOT: the WebSocket (see model/notesQueries.ts — a bare
 * socket would eat parked file offers), the P2P transfer wiring, device
 * attestation, the remote-control globals, the Capacitor/Tauri hooks (Notes
 * never runs inside either shell — scripts/strip-notes-from-native.mjs keeps
 * it out of them). What it MUST replay: the appearance boot below, or the
 * theme, contrast, text scale and icon style a user chose in Púca do nothing
 * here.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import '../index.css'
import { applyAppearance, loadSettings } from '../components/settingsStore'

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
import { makeNotesQueryClient } from './model/notesQueries'

const queryClient = makeNotesQueryClient()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
                <NotesApp />
            </QueryClientProvider>
        </ErrorBoundary>
    </StrictMode>,
)
