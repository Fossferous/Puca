/**
 * Púca Keep — entry point. Served at /keep/ (frontend/keep/index.html, built
 * by vite.keep.config.ts into dist/keep/).
 *
 * A second document on the web app's origin: same account, same E2EE seed,
 * same settings, same task API — its own shell. What Púca's main.tsx boots
 * that Keep does NOT: the WebSocket (see model/notesQueries.ts — a bare
 * socket would eat parked file offers), the P2P transfer wiring, device
 * attestation, the remote-control globals, the Capacitor/Tauri hooks (Keep
 * never runs inside either shell — scripts/strip-keep-from-native.mjs keeps
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

import './keep.css'
// LAST — its coarse-pointer block must win the cascade at equal specificity
// (docs/DESIGN_PHILOSOPHY.md §6). It also defines the --safe-area-* vars and
// the blanket 44px touch-target rule Keep's own mobile block builds on.
import '../mobile.css'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { KeepApp } from './KeepApp'
import { makeKeepQueryClient } from './model/notesQueries'

const queryClient = makeKeepQueryClient()

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
                <KeepApp />
            </QueryClientProvider>
        </ErrorBoundary>
    </StrictMode>,
)
