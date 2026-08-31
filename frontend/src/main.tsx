import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { applyAppearance, loadSettings, syncCloseToTray } from './components/settingsStore'

// FIRST STATEMENT ON PURPOSE — bless the running OTA bundle before anything
// else gets a chance to be slow. Capgo's native appReadyTimeout (10s, baked
// into the APK via capacitor.config.ts) rolls the app back to the PREVIOUS
// bundle if notifyAppReady hasn't run by then, and it used to run inside
// UpdateGate's mount effect, behind settings I/O, module evaluation of the
// whole app, and React's first render. On a slow boot of a large bundle —
// or a boot frozen because the user backgrounded the app mid-update — the
// deadline fired, the rollback RELOADED the old bundle, the gate then
// re-downloaded the update it just lost, and the visible result was the
// launch screen holding forever (field report, 2026-08-05, after 0.8.35).
// Capgo's own docs: "Call this BEFORE any network requests … as soon as
// your JavaScript bundle starts executing." UpdateGate still calls it too;
// the call is idempotent and never fails.
if (typeof window !== 'undefined'
    && 'Capacitor' in window
    && (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor?.isNativePlatform?.()) {
    void import('@capgo/capacitor-updater')
        .then(({ CapacitorUpdater }) => CapacitorUpdater.notifyAppReady())
        .catch(() => { /* plugin absent (old shell) — nothing to bless */ })
}

// Settings that must take effect BEFORE any UI renders. A setting applied only
// when the settings modal mounts is a setting that does nothing until then:
//  - close-to-tray: the Rust shell defaults ON and only hears about OFF when a
//    setting is next saved, so a fresh launch would ignore the user's choice.
//  - theme/appearance: the Login screen renders long before Chat (which owns
//    the modal), so a Light-theme user got a dark login and a dark flash every
//    launch — and compact/animations/text-scale would not apply until the
//    first settings save.
const bootSettings = loadSettings()
syncCloseToTray(bootSettings.closeToTray)
applyAppearance(bootSettings)
// Desktop shell: clicking an external link must open the system browser.
// Tauri v2 denies target=_blank/new-window by default (no opener plugin is
// registered), so without this interceptor links silently do nothing.
import { installTauriLinkInterceptor } from './api/openExternal'
installTauriLinkInterceptor()

// P2P transfer handlers, wired SYNCHRONOUSLY at startup — not in Chat's mount
// effect, which runs a React tree later. The server sweeps PARKED file offers
// to a connection the moment it registers, so the very first frames after the
// socket opens can be FileOffered — and an unwired handler map drops unknown
// types silently, consuming a delivered-once offer into nothing. Wiring here
// closes the gap: no socket message can precede the initial script execution.
// wire() is idempotent; Chat's own call becomes a harmless re-entry.
import { fileTransferManager } from './api/fileTransferManager'
fileTransferManager.wire()
// Measure whether this page is actually being PAINTED. Every watchdog in the
// device-session layer defers while the app is backgrounded, and after a long
// screen-lock an Android WebView can report itself hidden while the user is
// looking straight at it — which deferred all of them for ever. Frame
// callbacks cannot get stuck that way, so they are what the deferrals are
// corroborated against, and their restarting after a gap is what notices a
// resume when `visibilitychange` never arrives. Shared infrastructure, not
// RC-only: websocket.ts also subscribes to it for core reconnect timing.
import { installPaintProbe } from './api/pagePainting'
installPaintProbe()
// Everything below answers this machine acting as a remote-control HOST —
// attesting its device identity, accepting an incoming control/file-browse
// session, and responding to a Wake-on-LAN request from another of the
// account's devices. Absent entirely from a lite build (RC_ENABLED false):
// wiring these listeners regardless of whether the UI to manage them exists
// would leave a lite install still silently answerable as an RC target.
// Answer the server's per-connection device challenge, and enrol this device
// if it has not been. NOT gated on remote control: this is what gives the
// machine an id, which Android native push delivery addresses frames to.
// Armed before the first socket opens — a challenge that arrives with no
// listener is simply lost, and the connection stays unattested for its life.
import { installDeviceAttestation } from './api/deviceIdentity/attest'
installDeviceAttestation()
// The injected LITERAL, not the RC_ENABLED const re-exported from platform.ts.
// Measured: with the const, Rollup did not fold this branch and every dynamic
// import below stayed in the graph — the whole remote-control surface shipped
// in a lite bundle that could never reach it. As a literal the branch is
// `if (false)` right here and the import edges go with it.
if (__RC_ENABLED__) {
    // Fire-and-forget dynamic imports, not top-level await: this must stay
    // synchronous with the rest of main.tsx's boot sequence (React's root
    // render follows below) in every build, including this one. Each import
    // resolves in well under a frame; a device challenge or wake request
    // arriving in that window is no worse off than before this file wired
    // these handlers via a static import.
    //
    // Passive notice when a friend's session goes live on another of this
    // account's devices (cross-user device shares).
    void import('./api/devices').then(({ installShareNotifications }) => installShareNotifications())
    // Device-control sessions. Registered here, not in a component, so a
    // request that arrives before any UI has mounted is still answered — an
    // unanswered DeviceConnectRequested looks to the controller exactly like
    // an offline device.
    void import('./api/devices/session').then(({ installDeviceSessions }) => installDeviceSessions())
    // Wake-on-LAN responder: another of your devices may ask THIS one to
    // broadcast a magic packet, since a sleeping machine has no socket of its
    // own.
    void import('./api/devices/wake').then(({ installWakeResponder }) => installWakeResponder())
    // And hear the server's verdict on a wake WE asked for. Without this every
    // refusal — no waker online, rate-limited, asking to wake yourself —
    // arrives as a generic Error frame that only the chat view listens for, so
    // the device card waits out its full three minutes and then blames the
    // BIOS.
    void import('./api/devices/wakeSession').then(({ installWakeResultListener, cancelAllWakes }) => {
        installWakeResultListener()
        // auth.ts used to import and call this directly; that edge is what put
        // the RC stack in every build's main chunk. It now registers itself.
        void import('./api/logoutHooks').then(({ registerLogoutCleanup }) => registerLogoutCleanup(cancelAllWakes))
    })
    // Remembered unattended seeds must not survive a sign-out — same inversion.
    void import('./api/devices/unattended').then(({ clearRememberedUaSeeds }) => {
        void import('./api/logoutHooks').then(({ registerLogoutCleanup }) => registerLogoutCleanup(clearRememberedUaSeeds))
    })
    // The other half: record THIS machine's LAN details (MAC / IP / broadcast)
    // so another of your devices can wake it later. Sealed client-side before
    // it leaves — the server never learns which MAC belongs to which device.
    void import('./api/devices/lanInfo').then(({ installLanPublisher }) => installLanPublisher())
}
// Android: catch the navigation intent this launch carried (widget button,
// notification tap) BEFORE React renders — Chat consumes it whenever it
// finally mounts — and declare the background-delivery keep-alive from the
// saved settings so it survives a process restart, not just a settings visit.
// Background delivery is ANDed with the notifications toggle: the service
// exists only to deliver notifications, so switching those off must also
// stop it — the sub-checkbox goes disabled at that point and could otherwise
// never be unstuck. All of it no-ops off Android and degrades silently on an
// APK without the plugin.
import { ensureMobileNotificationPermission, installMobileNav, setNotifyKeepAlive } from './api/mobileApp'
import { syncTaskPlacesToNative } from './api/taskPlaces'
import { installReconnectCatchup } from './api/reconnectCatchup'
installMobileNav()
// Android: after a socket gap (Doze window, network handover), reconnecting
// while still backgrounded notifies for what arrived during the gap — the
// backend has no queue or replay, so without this every gap is silent loss.
installReconnectCatchup()
// The keep-alive's boot-time state is owned by App.tsx (it follows the auth
// state — a signed-out app must not hold a "Connected" service). This module
// only reconciles later Settings toggles.
// First-run permission ask: the notifications setting defaults ON, so the
// Settings checkbox's own onChange (the other requester) never fires on a
// fresh install, and Android 13+ silently drops every unpermissioned post.
if (bootSettings.mobileNotifications) void ensureMobileNotificationPermission()
window.addEventListener('settingsChanged', e => {
    const s = (e as CustomEvent<{ mobileBackgroundDelivery?: boolean; mobileNotifications?: boolean }>).detail
    if (s && typeof s.mobileBackgroundDelivery === 'boolean' && typeof s.mobileNotifications === 'boolean') {
        setNotifyKeepAlive(s.mobileBackgroundDelivery && s.mobileNotifications)
    }
    // Location reminders ride the same reconciliation: any settings save
    // re-syncs the native fence set (deduped inside — a no-op push is free).
    // This is what clears the fences when locationReminders OR the parent
    // notifications toggle goes off, whatever UI wrote the save.
    void syncTaskPlacesToNative()
})
import './mobile.css'
import App from './App.tsx'
import { UpdateGate } from './components/UpdateGate.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { queryClient } from './api/queryClient.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <UpdateGate>
            <App />
          </UpdateGate>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
