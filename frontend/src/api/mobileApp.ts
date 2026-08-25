/**
 * The JS handle on SovereignAppPlugin (Android): staying alive in the
 * background, posting message notifications, and receiving navigation intents
 * from the home-screen widget and notification taps.
 *
 * KEEP-ALIVE. Two independent reasons keep the process running — an active
 * remote-control session, and the user's opt-in to background notification
 * delivery. They are declared by different modules at different times, so this
 * module owns the merge: each setter records its reason and the COMPLETE
 * desired state is pushed to the native side, latest-state-wins under a
 * single in-flight call so a burst of changes cannot interleave.
 *
 * DEGRADES SILENTLY AND ON PURPOSE, exactly like mobileTransferService: the
 * native half only exists in APKs from 0.8.33; this code reaches older APKs
 * over the air, where every call rejects and the app behaves as those builds
 * always did (sessions and notifications end when the app does).
 */
import { registerPlugin, Capacitor, type PluginListenerHandle } from '@capacitor/core';

interface SovereignAppPlugin {
    /** `blocked` (APKs from 0.8.58): notifications are OFF at the app or
     *  Messages-channel level — a state POST_NOTIFICATIONS being granted
     *  cannot see, and re-requesting cannot fix. Absent on older APKs. */
    notificationStatus(): Promise<{ granted: boolean; needsRequest: boolean; blocked?: boolean }>;
    requestNotificationPermission(): Promise<{ granted: boolean }>;
    /** `geofence` (APKs with location reminders): unknown extras are ignored
     *  by older APKs, so sending it is always safe. */
    setKeepAlive(opts: { control: boolean; notify: boolean; geofence: boolean }): Promise<void>;
    notify(opts: { key: string; title: string; body: string; nav?: string }): Promise<void>;
    clearNotifications(opts: { key?: string }): Promise<void>;
    consumeLaunchNav(): Promise<{ target: string | null }>;
    setConversationShortcuts(opts: { items: ConversationShortcut[] }): Promise<void>;
    reportShortcutUsed(opts: { id: string }): Promise<void>;
    batteryStatus(): Promise<{ ignoring: boolean }>;
    requestIgnoreBatteryOptimizations(): Promise<void>;
    openNotificationSettings(): Promise<void>;
    /** Native delivery (APKs from 0.8.66): hand the background socket its
     *  connection credentials — OUR server's WS URL + the session JWT. Null
     *  token clears them. No third party in this path, by design. `deviceId`
     *  (APKs from 0.8.67) is CLAIMED at connect so "sign out this device"
     *  can hang the socket up; kill-only server-side. */
    setNativeDelivery(opts: { wsUrl: string | null; token: string | null; deviceId?: string | null }): Promise<void>;
    /** The FCM wake-doorbell token (APKs from 0.8.67). Constant payload —
     *  the token is the only device fact that ever reaches Google. */
    wakeToken(): Promise<{ token: string | null; reason?: string }>;
    syncPushGates(opts: {
        mutedServers: Record<string, boolean | string>;
        mutedChannels: Record<string, boolean>;
        blockedIds: number[];
        pushEnabled: boolean;
    }): Promise<void>;
    setPushAccount(opts: { userId: string | null }): Promise<void>;
    /** Where the soft keyboard's top edge is, for a listener that subscribed
     *  after the keyboard was already up (an OTA WebView reload is exactly that
     *  case). RAW PIXELS, both of them: JS converts with the layout viewport's
     *  own height, because a density-based conversion is wrong whenever the
     *  WebView's CSS scale is not 1/density and the error is a plausible-looking
     *  10-30% offset. `topPx: -1, viewHeightPx: -1` means nothing has been
     *  observed yet — unknown, not zero. APKs from 0.8.88; older reject. */
    keyboardState(): Promise<{ visible: boolean; topPx: number; viewHeightPx: number }>;
    /** Raise the IME for whatever the WebView has focused, OUTSIDE a user
     *  gesture (APKs from 0.8.104). The remote-control view opens the keyboard
     *  when a tap lands in a text box on the other machine, which it only
     *  learns from the host's caret report ~100-900 ms after the tap — past
     *  the point Blink will raise the IME for a programmatic focus. `ok` is
     *  the FIRST showSoftInput's answer, diagnostic only; older APKs reject. */
    showKeyboard(): Promise<{ ok: boolean; reason?: string }>;
    /** The phone's clipboard as text (APKs from 0.8.91). Native or nothing:
     *  the Android WebView cannot READ the clipboard from JS at all. `ok:false`
     *  = the clip could not be read; older APKs reject the call. */
    readClipboard(): Promise<{ ok: boolean; text?: string; reason?: string }>;
    /** OS picture-in-picture for a watched stream (APKs from 0.8.96). The
     *  Android WebView has no web PiP API, so the native side floats the
     *  WebView itself in a PiP window shaped like the video; PipActivity.java
     *  is the whole story. Older APKs reject all three. */
    pipSupported(): Promise<{ supported: boolean }>;
    enterPip(opts: { width: number; height: number }): Promise<{ ok: boolean; reason?: string }>;
    exitPip(): Promise<{ ok: boolean }>;
    addListener(
        eventName: 'navigate',
        listener: (data: { target: string }) => void,
    ): Promise<PluginListenerHandle>;
    /** The IME's inset changed (opened, closed, resized by a language switch).
     *  Deliberately not retained natively — a retained event replays a stale
     *  band after an OTA apply's WebView reload, the same shape of bug the
     *  static nav target caused below; keyboardState() is the late-subscriber
     *  answer instead. APKs from 0.8.88; older reject. */
    addListener(
        eventName: 'keyboard',
        listener: (data: { visible: boolean; topPx: number; viewHeightPx: number }) => void,
    ): Promise<PluginListenerHandle>;
    /** The floating window appeared / went away — every exit path fires
     *  {active:false} (expand, swipe-away, an OS refusal, exitPip). */
    addListener(
        eventName: 'pipModeChanged',
        listener: (data: { active: boolean }) => void,
    ): Promise<PluginListenerHandle>;
}

const App = registerPlugin<SovereignAppPlugin>('SovereignApp');

/** null = not yet determined. Set on the first real call. */
let usable: boolean | null = null;

function android(): boolean {
    return Capacitor.getPlatform() === 'android';
}

export function mobileAppAvailable(): boolean {
    return android() && usable !== false;
}

// --- keep-alive -----------------------------------------------------------

let controlReason = false;
let notifyReason = false;
let geofenceReason = false;
let pushed: string | null = null;      // last state the native side ACCEPTED
let refusedKey: string | null = null;  // last state the native side REFUSED
let inFlight = false;

function pushKeepAlive(): void {
    if (!android() || usable === false) return;
    const key = `${controlReason}|${notifyReason}|${geofenceReason}`;
    // A key the native side just refused is NOT retried until something
    // changes. Without the refusedKey guard, a rejection (Android refusing a
    // foreground-service start from the background, the expected case on
    // 12+) left `pushed` behind the desired state, and the convergence
    // re-push in `finally` span an unbounded native-call loop — measured at
    // ~70 bridge round-trips per second, each throwing a Java exception, on
    // the JS thread of the session it exists to preserve. Recovery is the
    // next state change, or the app coming to the foreground (below), where
    // a foreground start is always allowed.
    if (key === pushed || key === refusedKey || inFlight) return;
    inFlight = true;
    const sent = key;
    void App.setKeepAlive({ control: controlReason, notify: notifyReason, geofence: geofenceReason })
        .then(() => { usable = true; pushed = sent; refusedKey = null; })
        .catch(() => {
            // Old APK (no plugin — permanent), or a background-start refusal
            // (transient). Both stop retrying THIS state; only the first
            // stops the module entirely.
            if (usable === null) usable = false;
            refusedKey = sent;
        })
        .finally(() => {
            inFlight = false;
            // State may have moved while the call was out; converge on it.
            // The guards above make this re-entry terminate.
            pushKeepAlive();
        });
}

/** Declared by the device-session layer: is any session active right now? */
export function setControlKeepAlive(active: boolean): void {
    if (controlReason === active) return;
    controlReason = active;
    pushKeepAlive();
}

/** Declared by settings: has the user opted into background delivery? */
export function setNotifyKeepAlive(on: boolean): void {
    if (notifyReason === on) return;
    notifyReason = on;
    pushKeepAlive();
}

/** Declared by taskPlaces.ts: are there location-reminder fences to watch?
 *  The service adds the FGS location type for this reason (permission
 *  allowing) so the OS keeps feeding fixes while backgrounded. */
export function setGeofenceKeepAlive(on: boolean): void {
    if (geofenceReason === on) return;
    geofenceReason = on;
    pushKeepAlive();
}

/** Re-send the CURRENT state even though it hasn't changed. A permission
 *  grant changes what the service may do with the same state (it recomputes
 *  its FGS type and location watch in onStartCommand), so after one the
 *  dedupe above is exactly wrong. Also clears a refused-state latch — the
 *  grant flow foregrounded the app, where a service start is always legal. */
export function repushKeepAlive(): void {
    pushed = null;
    refusedKey = null;
    pushKeepAlive();
}

// --- notifications --------------------------------------------------------

export async function mobileNotificationStatus(): Promise<{ granted: boolean; needsRequest: boolean; blocked?: boolean } | null> {
    if (!android() || usable === false) return null;
    try {
        const s = await App.notificationStatus();
        usable = true;
        return s;
    } catch {
        // `usable === null` only: the FIRST-ever call failing means no plugin
        // (old APK) — latch off. But once anything has succeeded, a transient
        // bridge error here must not poison the whole module: this used to
        // flip `usable` unconditionally, and one hiccup silently killed the
        // keep-alive service and every notification for the rest of the
        // session while "Send test" blamed the APK.
        if (usable === null) usable = false;
        return null;
    }
}

/**
 * Boot-time reconciliation: `mobileNotifications` defaults ON, so on a fresh
 * Android 13+ install the Settings checkbox renders already-checked and its
 * onChange — previously the only requester — never runs, leaving
 * POST_NOTIFICATIONS unasked and every post silently dropped by the OS.
 * Ask once here, like any messenger's first run. A user who denies twice
 * makes further requests silent no-ops (Android's own rule), so this cannot
 * nag; flipping the Settings toggle re-asks explicitly.
 */
export async function ensureMobileNotificationPermission(): Promise<void> {
    const status = await mobileNotificationStatus();
    if (status?.needsRequest) {
        await requestMobileNotificationPermission();
    }
}

export async function requestMobileNotificationPermission(): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        const r = await App.requestNotificationPermission();
        usable = true;
        return r.granted;
    } catch {
        // Same first-call-only latch as mobileNotificationStatus. This one is
        // reachable from Settings ("Send test", the notifications toggle) —
        // an unconditional latch here let one mid-session hiccup permanently
        // disable notifications and misreport the APK as too old.
        if (usable === null) usable = false;
        return false;
    }
}

// --- battery optimisation (APKs from 0.8.57) ------------------------------

/** Whether THIS pair of methods exists natively — same deliberate separation
 *  from `usable` as the shortcuts latch below: on APKs 0.8.34-0.8.37 the
 *  plugin is present (notifications work) but these methods are not, and
 *  their rejection must not convince the module the whole plugin is gone. */
let batterySupported: boolean | null = null;

/**
 * Is the app exempt from battery optimisations? Doze suspends a non-exempt
 * app's network REGARDLESS of the foreground service, which starves the
 * WebSocket that carries all notification DATA (any relay involvement is
 * the constant-payload wake signal only). null =
 * not Android, or an APK without the method — callers show nothing.
 */
export async function mobileBatteryStatus(): Promise<{ ignoring: boolean } | null> {
    if (!android() || usable === false || batterySupported === false) return null;
    try {
        const s = await App.batteryStatus();
        usable = true;
        batterySupported = true;
        return s;
    } catch {
        // First-call-only, like the `usable` latch: the first-ever rejection
        // is an APK without the method; after a success it is a transient
        // error and must not blind the battery surface for the session.
        if (batterySupported === null) batterySupported = false;
        return null;
    }
}

/**
 * Fire the system "always run in background?" dialog. Resolves true if the
 * dialog was shown; the outcome is read by re-polling mobileBatteryStatus
 * when the app regains visibility (the dialog is another activity, so the
 * app backgrounds and returns). No two-denial lockout applies — this can
 * always be asked again, unlike POST_NOTIFICATIONS.
 */
export async function requestIgnoreBatteryOptimizations(): Promise<boolean> {
    if (!android() || usable === false || batterySupported === false) return false;
    try {
        await App.requestIgnoreBatteryOptimizations();
        usable = true;
        batterySupported = true;
        return true;
    } catch {
        // Deliberately does NOT demote batterySupported: every call site
        // probes mobileBatteryStatus first, so a rejection here means "this
        // ROM has no handler for the dialog", not "method absent" — and
        // latching it off would hide the battery health row (the one place
        // that can still explain the manual fix) for the rest of the session.
        return false;
    }
}

/** Same APK generation as the battery methods, separate concern: deep-link
 *  to Android's notification settings for this app — the only recovery once
 *  POST_NOTIFICATIONS hits Android's two-denial silent lockout. */
let notifSettingsSupported: boolean | null = null;

export async function openMobileNotificationSettings(): Promise<boolean> {
    if (!android() || usable === false || notifSettingsSupported === false) return false;
    try {
        await App.openNotificationSettings();
        usable = true;
        notifSettingsSupported = true;
        return true;
    } catch {
        notifSettingsSupported = false;
        return false;
    }
}

/**
 * Post (or replace — `key` is stable per conversation/channel) a message
 * notification. `nav` is where a tap lands: 'friends', 'tasks', 'devices',
 * 'settings', 'dms', 'notes', 'dm:<conversationId>' or 'server:<serverId>'.
 */
export async function postMobileNotification(
    key: string, title: string, body: string, nav?: string,
): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await App.notify({ key, title, body, nav });
        usable = true;
    } catch {
        if (usable === null) usable = false;
    }
}

// --- native background delivery (self-hosted push) -------------------------

/**
 * Hand the native delivery socket its credentials, or clear them (null).
 * The socket runs in KeepAliveService and delivers message notifications
 * while the WebView is throttled or gone — to OUR server only; there is
 * deliberately no third-party relay in this app.
 */
export async function setMobileNativeDelivery(
    creds: { wsUrl: string; token: string; deviceId?: string | null } | null,
): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await App.setNativeDelivery(creds ?? { wsUrl: null, token: null });
    } catch {
        // Old APK — no native delivery there; the WebView path still works
        // while the app is open, exactly as before.
    }
}

/**
 * This device's FCM WAKE token — the doorbell address (constant payload; the
 * only thing about this phone that ever reaches Google's push service), so JS
 * can register it with the server. Null: old APK, no Firebase in this build,
 * or no Play Services — the socket still delivers while alive; only the
 * Doze-piercing doorbell is absent.
 */
export async function getMobileWakeToken(): Promise<string | null> {
    if (!android() || usable === false) return null;
    try {
        const r = await App.wakeToken();
        usable = true;
        return r.token ?? null;
    } catch {
        return null; // old APK without the method
    }
}

/**
 * Write the notification gates into the native mirror the FCM handler reads.
 * The handler runs with no WebView — it cannot see localStorage — so this is
 * load-bearing, not an optimisation: a stale mirror means push quietly stops
 * honouring mutes and blocks.
 */
export async function syncMobilePushGates(gates: {
    mutedServers: Record<string, boolean | string>;
    mutedChannels: Record<string, boolean>;
    blockedIds: number[];
    pushEnabled: boolean;
    /** The "deliver in the background" switch, mirrored so the wake service
     *  can refuse a doorbell without a WebView. Separate from `pushEnabled`,
     *  which is the master notification switch. */
    backgroundDelivery: boolean;
}): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await App.syncPushGates(gates);
    } catch {
        // Old APK — no push there either, so a stale mirror gates nothing.
    }
}

/** Bind (login) or clear (logout) the account the FCM handler shows pushes
 *  for. Clearing also wipes the mirrored gates on the native side. */
export async function setMobilePushAccount(userId: number | null): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await App.setPushAccount({ userId: userId === null ? null : String(userId) });
    } catch {
        // Old APK.
    }
}

/** Clear all message notifications (app came to the foreground), or one key's. */
export async function clearMobileNotifications(key?: string): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await App.clearNotifications({ key });
    } catch {
        // Nothing to clear on an old APK.
    }
}

// --- the soft keyboard's inset (APKs from 0.8.88) -------------------------

/** Whether THIS pair exists natively. Deliberately separate from `usable`, like
 *  the battery and shortcuts latches: on every APK before 0.8.88 the plugin is
 *  present (notifications, keep-alive and native delivery all work) and these
 *  two methods are not, and their rejection must not convince the module the
 *  whole plugin is gone. */
let keyboardSupported: boolean | null = null;

/**
 * The IME's top edge right now, in RAW px alongside the WebView's own raw
 * height. null = not Android, or an APK without the method — the caller then
 * falls through to its own ladder (visualViewport, then an assumed fraction).
 */
export async function mobileKeyboardState(): Promise<{ visible: boolean; topPx: number; viewHeightPx: number } | null> {
    if (!android() || usable === false || keyboardSupported === false) return null;
    try {
        const s = await App.keyboardState();
        usable = true;
        keyboardSupported = true;
        return s;
    } catch {
        // First-call-only, like the battery latch: the first-ever rejection is
        // an APK without the method; after a success it is a transient bridge
        // error and must not blind the inset source for the session.
        if (keyboardSupported === null) keyboardSupported = false;
        return null;
    }
}

/** Whether showKeyboard exists natively. Its own latch, like keyboardSupported:
 *  the plugin is present on every APK since 0.8.33 and this method only since
 *  0.8.104, so a rejection here must not blind anything else. */
let showKeyboardSupported: boolean | null = null;

/**
 * Raise the soft keyboard for the field the web layer has focused, from
 * OUTSIDE a user gesture.
 *
 * Returns true when the native method exists and RAN — not whether Android
 * actually showed the IME (showSoftInput's boolean is racy against the
 * renderer's text-input-state update; the native side calls it twice for
 * that reason and the second call's answer is not awaited). false = not
 * Android, or an APK without the method: the caller then falls back to what
 * Blink will do for a programmatic focus on its own.
 */
export async function showMobileKeyboard(): Promise<boolean> {
    if (!android() || usable === false || showKeyboardSupported === false) return false;
    try {
        await App.showKeyboard();
        usable = true;
        showKeyboardSupported = true;
        return true;
    } catch {
        // First-ever rejection = an APK without the method. After a success it
        // is a transient bridge error and the next call may still work.
        if (showKeyboardSupported === null) showKeyboardSupported = false;
        return false;
    }
}

/**
 * Read the phone's clipboard natively. Result:
 *  - `{ text }`      — a text clip ("" when the clipboard is empty)
 *  - `{ unsupported }` — not Android, or an APK older than the method
 *  - `{ reason }`    — a non-text clip (an image, a file), or Android refused
 *                      the read (should not happen right after a tap)
 * Discriminated on purpose: "this device can't hand the app its clipboard"
 * and "the clipboard is empty" must read differently to the user.
 */
export async function readMobileClipboard(): Promise<{ text: string } | { unsupported: true } | { reason: string }> {
    if (!android() || usable === false) return { unsupported: true };
    try {
        const r = await App.readClipboard();
        usable = true;
        if (r.ok) return { text: typeof r.text === 'string' ? r.text : '' };
        return { reason: r.reason || 'the clipboard could not be read' };
    } catch {
        // An APK without the method rejects — the caller says so honestly.
        return { unsupported: true };
    }
}

// --- picture-in-picture -------------------------------------------------

/** Cached answer of the native probe; null until asked. A LEVEL, like
 *  keyboardSupported: an old APK (rejects) or a phone without the feature
 *  both read as false, and the Pop-out control is simply not offered. */
let pipNative: boolean | null = null;

/** Can this device float the app in an OS picture-in-picture window?
 *  Android app only; false on iOS (WebKit has its own web API), the web, and
 *  APKs older than the method. */
export async function nativePipSupported(): Promise<boolean> {
    if (!android() || usable === false) return false;
    if (pipNative !== null) return pipNative;
    try {
        const r = await App.pipSupported();
        usable = true;
        pipNative = r.supported === true;
    } catch {
        pipNative = false;
    }
    return pipNative;
}

/** Synchronous read of the probe (for render-time feature detection). false
 *  until nativePipSupported() has answered once. */
export function nativePipKnownSupported(): boolean {
    return pipNative === true;
}

/** Float the WebView in a PiP window shaped like a `width`x`height` video.
 *  Resolves false when the OS or the APK cannot; a refusal AFTER launch (the
 *  user turned PiP off for the app) arrives as a pipModeChanged {active:false}. */
export async function enterNativePip(width: number, height: number): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        const r = await App.enterPip({ width, height });
        usable = true;
        return r.ok === true;
    } catch {
        return false;
    }
}

/** Take the floating window down without bringing the app forward. */
export async function exitNativePip(): Promise<void> {
    if (!android() || usable === false) return;
    try { await App.exitPip(); } catch { /* old APK, or already gone */ }
}

export async function onNativePipChange(
    cb: (d: { active: boolean }) => void,
): Promise<PluginListenerHandle | null> {
    if (!android() || usable === false) return null;
    try {
        return await App.addListener('pipModeChanged', cb);
    } catch {
        return null;
    }
}

/** Subscribe to IME inset changes. null on an old APK — the caller's ladder
 *  then owns the measurement, which is the API 24-29 path too (Type.ime() is
 *  not reliably reported below R and minSdk here is 24). */
export async function onMobileKeyboard(
    cb: (d: { visible: boolean; topPx: number; viewHeightPx: number }) => void,
): Promise<PluginListenerHandle | null> {
    if (!android() || usable === false || keyboardSupported === false) return null;
    try {
        const h = await App.addListener('keyboard', cb);
        // `usable`, yes — the plugin answered. NOT `keyboardSupported`:
        // addListener is the base Plugin's method and resolves on EVERY APK,
        // including the ones without the keyboard pair, so its success says
        // nothing about this feature. Only keyboardState() is evidence.
        usable = true;
        return h;
    } catch {
        return null;
    }
}

// --- launcher shortcuts ---------------------------------------------------

export interface ConversationShortcut {
    /** Shortcut id — the nav string, so notifications can link to it. */
    id: string;
    label: string;
    nav: string;
    /** Raw base64 PNG (no data: prefix), or absent for the launcher default. */
    icon?: string;
}

/**
 * Whether THIS pair of methods exists natively. Deliberately separate from
 * `usable`: APKs 0.8.33-0.8.35 have the plugin (notifications work) but not
 * these methods, and their rejection must not convince the module the whole
 * plugin is gone.
 */
let shortcutsSupported: boolean | null = null;

/** Replace the launcher's dynamic long-press shortcuts (recent DMs). An empty
 *  list clears them — that is the "turn the setting off" path, so it must go
 *  through, not short-circuit. */
export async function syncConversationShortcuts(items: ConversationShortcut[]): Promise<void> {
    if (!android() || usable === false || shortcutsSupported === false) return;
    try {
        await App.setConversationShortcuts({ items });
        usable = true;
        shortcutsSupported = true;
    } catch {
        shortcutsSupported = false;
    }
}

/** Opening a conversation bumps its launcher ranking. Fire-and-forget. */
export function reportConversationShortcutUsed(id: string): void {
    if (!android() || usable === false || shortcutsSupported === false) return;
    void App.reportShortcutUsed({ id }).catch(() => { shortcutsSupported = false; });
}

/**
 * A launcher tile for a conversation with no image: its initials on a hue
 * derived from the name. Returns raw base64 PNG, or undefined where canvas
 * cannot rasterise (jsdom) — the shortcut then ships without an icon.
 */
export function initialsIconPng(label: string): string | undefined {
    try {
        const canvas = document.createElement('canvas');
        // Adaptive-bitmap size; the launcher masks it, so paint edge to edge.
        canvas.width = 108;
        canvas.height = 108;
        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;
        let hash = 0;
        for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
        const hue = ((hash % 360) + 360) % 360;
        ctx.fillStyle = `hsl(${hue} 45% 38%)`;
        ctx.fillRect(0, 0, 108, 108);
        const initials = label.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 44px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Nudged below centre: alphabetic glyphs sit high in their em box.
        ctx.fillText(initials, 54, 58);
        return canvas.toDataURL('image/png').split(',')[1];
    } catch {
        return undefined;
    }
}

// --- navigation intents ---------------------------------------------------

let pendingNav: string | null = null;

/**
 * Boot-time install (main.tsx): fetch the nav target this launch carried, and
 * listen for targets arriving while the app runs (widget tap on a live app,
 * notification tap). Both are held in `pendingNav` — the consumer (Chat) may
 * mount seconds later, behind the OTA gate and the connect screen — and each
 * arrival is also announced for a consumer that is already alive.
 */
export function installMobileNav(): void {
    if (!android()) return;
    void App.consumeLaunchNav()
        .then(({ target }) => {
            usable = true;
            if (target) {
                pendingNav = target;
                window.dispatchEvent(new CustomEvent('sovereign-navigate'));
            }
        })
        // First-call-only latch (see mobileNotificationStatus): this runs at
        // the most bridge-fragile moment of boot, and poisoning `usable` on a
        // transient error here disabled notifications for the whole session.
        .catch(() => { if (usable === null) usable = false; });
    void App.addListener('navigate', ({ target }) => {
        if (!target) return;
        pendingNav = target;
        // Drain the NATIVE copy too: the plugin stores every warm target in a
        // static that only consumeLaunchNav clears, and main.tsx calls that
        // once per JS boot — so an OTA apply's WebView reload (same process,
        // fresh JS) replayed the last widget tap as if it had just happened.
        void App.consumeLaunchNav().catch(() => undefined);
        window.dispatchEvent(new CustomEvent('sovereign-navigate'));
    }).catch(() => { /* old APK */ });
    // A keep-alive push the OS refused (foreground-service starts are blocked
    // from the background) becomes legal the moment the app is foregrounded —
    // retry then, or an active session would stay unprotected until its next
    // state change.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // Both beliefs are dropped together, never in either/or branches: a
        // refusal and a stale `pushed` are independent, and clearing only
        // whichever was noticed first left the other in place. (That is a real
        // hole: a refused state that later became wanted again matches
        // `pushed`, so the re-push is skipped and the divergence survives the
        // repair meant to fix it.)
        const hadRefusal = refusedKey !== null;
        refusedKey = null;
        // JS is no longer the only writer of the native reason state — the
        // wake doorbell starts the service too. `pushed` records what the
        // native side last ACCEPTED, which is a claim about the past; if
        // anything moved it since, every later push is deduped against a state
        // that no longer exists and the divergence is PERMANENT (nothing else
        // re-triggers: setControlKeepAlive early-returns while the session's
        // own view is unchanged).
        //
        // Foreground return is the repair point: the one moment a
        // foreground-service start is always legal, and the only moment the
        // user could notice. Forget what we believe and re-assert the truth.
        const anyReason = controlReason || notifyReason || geofenceReason;
        if (anyReason) pushed = null;
        // Both beliefs are dropped above before either is acted on — a refusal
        // and a stale `pushed` are independent, and clearing only whichever
        // was noticed first left the other in place. But push only when there
        // is something to assert: with no reasons held, the service should
        // stay stopped rather than be started and immediately stop itself.
        if (hadRefusal || anyReason) pushKeepAlive();
    });
}

/**
 * One-shot read. The consumer calls this on mount and on every
 * 'sovereign-navigate' event; a target it cannot act on YET (a DM whose
 * conversation list has not loaded) is put back with `deferNav`.
 */
export function consumePendingNav(): string | null {
    const t = pendingNav;
    pendingNav = null;
    return t;
}

/** Put a target back to retry once more state has loaded. */
export function deferNav(target: string): void {
    pendingNav = target;
}
