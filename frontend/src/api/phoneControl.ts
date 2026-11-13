/**
 * Control of THIS phone from a call: the page's side of the Android app's
 * SovereignPhoneControl plugin (frontend/android/phone-control/: an
 * AccessibilityService that taps, swipes and types). FULL build only: its
 * importers are remoteControl.ts and RemoteControlOverlay.tsx, both of which
 * Lite leaves out (vite.shared.ts aliases the first and RC_MODULE_PATTERNS
 * lists both, with this file), so it never enters a Lite bundle either, and
 * the Lite APK does not even carry the plugin.
 *
 * The rules, all enforced natively too (PhoneControl.java):
 *   - offered only while this phone shares its WHOLE screen from the app;
 *   - a session starts only when the person at the phone presses Allow for
 *     that one viewer, in the page's prompt AND then in Android's own dialog
 *     naming them (Consent.java: nothing the page can do presses that one),
 *     and the service is switched on in Android's settings;
 *   - while it lasts the phone shows who is in control over every app, with
 *     a Stop; the share's notification has "Stop control";
 *   - locking the phone, its screen going off, the service being switched
 *     off or the share ending end it at once, and the page is told
 *     (`controlEnded`), which tells the viewer.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { nativeShareStats } from './nativeScreenShare';

/** What the native side says may not happen now (PhoneControl.beginRefusal). */
export type PhoneControlRefusal =
    | 'service-disabled' // not switched on in Android's Accessibility settings
    | 'service-off'      // switched on, not bound by Android (yet)
    | 'not-sharing'
    | 'one-app'          // Android 14+ "Share one app": not the whole screen
    | 'locked'
    | 'screen-off'
    | 'no-indicator'     // the on-screen sign of control could not be shown
    | 'unsupported'      // Android 7: no continued strokes (ControlGate.MIN_SDK)
    | 'declined'         // Cancel in Android's own dialog (Consent)
    | 'not-confirmed'    // that dialog unanswered, or it could not be shown
    | 'withdrawn'        // the page took the request back while it asked
    | 'busy'             // a session, or another question, already there
    | string;

export interface PhoneControlStatus {
    enabled: boolean;
    connected: boolean;
    active: boolean;
    refusal: PhoneControlRefusal | null;
    sdk: number;
}

/** One event to inject, as validated by remoteControl.ts, with the page's
 *  arrival time. */
export type PhoneControlEvent = Record<string, unknown> & { t: string; at: number };

export interface SovereignPhoneControlPlugin {
    status(): Promise<PhoneControlStatus>;
    openSettings(options: { page: 'accessibility' | 'app' }): Promise<void>;
    begin(options: { viewer: string }): Promise<{ ok: boolean; refusal: PhoneControlRefusal | null }>;
    inject(options: { events: PhoneControlEvent[] }): Promise<void>;
    end(): Promise<void>;
    addListener(event: 'controlEnded', cb: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
    addListener(event: 'statusChanged', cb: () => void): Promise<PluginListenerHandle>;
}

const PLUGIN = 'SovereignPhoneControl';
export const SovereignPhoneControl = registerPlugin<SovereignPhoneControlPlugin>(PLUGIN);

/** This is the Android app, and its APK carries the plugin (the full APK
 *  from the release that added it; OTA JavaScript can be newer). */
export function phoneControlInstalled(): boolean {
    return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable(PLUGIN);
}

/** Could this page be a controlled phone right now: the plugin is there and
 *  this page is sharing the phone's screen from the app. Synchronous, for
 *  the request handler; the native side has the last word. */
export function phoneHostPossible(): boolean {
    return phoneControlInstalled() && nativeShareStats() !== null;
}

export async function phoneControlStatus(): Promise<PhoneControlStatus | null> {
    if (!phoneControlInstalled()) return null;
    try {
        return await SovereignPhoneControl.status();
    } catch {
        return null;
    }
}

/** The person-facing words for a refusal: what to do about it. */
export function refusalWords(r: PhoneControlRefusal | null | undefined): string | null {
    switch (r) {
        case null:
        case undefined:
            return null;
        case 'service-disabled':
        case 'service-off':
            return 'Púca remote control is off in Android\'s Accessibility settings.';
        case 'one-app':
            return 'You are sharing one app, not your whole screen. Control needs the whole screen: stop sharing and share again with "Entire screen".';
        case 'not-sharing':
            return 'Share your screen from Púca first.';
        case 'locked':
        case 'screen-off':
            return 'Unlock the phone first.';
        case 'no-indicator':
            return 'Android did not let Púca show who is in control on the screen, so control cannot start.';
        case 'unsupported':
            return 'Control of a phone needs Android 8 or newer.';
        case 'declined':
            return 'you chose Cancel.';
        case 'not-confirmed':
            return 'it was not confirmed on the phone in time.';
        case 'withdrawn':
            return 'the request was taken back.';
        case 'busy':
            return 'someone is already in control of this phone.';
        default:
            return 'Control of this phone is not available right now.';
    }
}

/** What the page says when the phone itself ended a session. */
export function endedWords(reason: string): string {
    switch (reason) {
        case 'notification':
        case 'indicator':
            return 'You stopped remote control.';
        case 'locked':
        case 'screen-off':
            return 'Remote control ended: the phone was locked.';
        case 'service-off':
            return 'Remote control ended: Púca remote control was switched off in Android\'s settings.';
        case 'not-sharing':
            return 'Remote control ended: the screen share stopped.';
        case 'one-app':
            return 'Remote control ended: the share is no longer of the whole screen.';
        default:
            return 'Remote control ended.';
    }
}

/** Open Púca's entry in Android's Accessibility settings, or its App info
 *  (where Android 13+ keeps "Allow restricted settings"). */
export async function openPhoneControlSettings(page: 'accessibility' | 'app'): Promise<boolean> {
    if (!phoneControlInstalled()) return false;
    try {
        await SovereignPhoneControl.openSettings({ page });
        return true;
    } catch {
        return false;
    }
}

/** The person pressed Allow in the page for this viewer: Android's own
 *  dialog asks them again (up to PHONE_CONFIRM_MS), and its Allow starts the
 *  session. */
export async function beginPhoneControl(viewer: string): Promise<{ ok: boolean; refusal: PhoneControlRefusal | null }> {
    if (!phoneControlInstalled()) return { ok: false, refusal: 'not-sharing' };
    try {
        return await SovereignPhoneControl.begin({ viewer });
    } catch {
        return { ok: false, refusal: 'service-off' };
    }
}

export function endPhoneControl(): void {
    if (!phoneControlInstalled()) return;
    void SovereignPhoneControl.end().catch(() => { /* no session there */ });
}

/** The granted viewer's input, in order. The plugin call returns as soon as
 *  the events are queued natively, so awaiting it keeps batches in order
 *  without waiting for the gestures to play. */
export async function injectPhoneControl(events: PhoneControlEvent[]): Promise<void> {
    if (events.length === 0) return;
    await SovereignPhoneControl.inject({ events });
}

/** Listen for the phone ending a session itself; returns an unsubscribe. */
export function onPhoneControlEnded(cb: (reason: string) => void): () => void {
    if (!phoneControlInstalled()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    void SovereignPhoneControl.addListener('controlEnded', (e) => cb(typeof e?.reason === 'string' ? e.reason : 'ended'))
        .then((h) => { if (gone) void h.remove(); else handle = h; })
        .catch(() => { /* an APK without the event: the next input finds the session gone */ });
    return () => { gone = true; void handle?.remove(); };
}

/** Listen for the service coming or going (Android's settings); returns an unsubscribe. */
export function onPhoneControlStatusChanged(cb: () => void): () => void {
    if (!phoneControlInstalled()) return () => {};
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    void SovereignPhoneControl.addListener('statusChanged', () => cb())
        .then((h) => { if (gone) void h.remove(); else handle = h; })
        .catch(() => { /* polled instead */ });
    return () => { gone = true; void handle?.remove(); };
}
