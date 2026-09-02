/**
 * Platform detection and abstraction layer
 *
 * This module provides unified APIs that work across:
 * - Web browser
 * - Tauri (desktop)
 * - Capacitor (iOS/Android)
 */

import { Capacitor } from '@capacitor/core';

type Platform = 'web' | 'ios' | 'android' | 'tauri';

/**
 * Whether we're running inside the Tauri desktop app.
 *
 * IMPORTANT: check `__TAURI_INTERNALS__`, which Tauri v2 always injects.
 * `window.__TAURI__` only exists with `app.withGlobalTauri: true` in
 * tauri.conf.json (which we don't set) — guards checking only `__TAURI__`
 * silently fail in the installed app.
 */
export function isTauri(): boolean {
    return typeof window !== 'undefined' &&
        ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/** Whether we're running as the Capacitor mobile app (iOS/Android). */
export function isMobile(): boolean {
    return Capacitor.isNativePlatform();
}

/**
 * Whether this build contains remote control: My Devices screen share +
 * input control, Wake-on-LAN + device presence, the remote file browser, and
 * in-call control of a screen share. A compile-time flag, not a runtime
 * setting — a lite build sets VITE_ENABLE_RC=false.
 *
 * This re-exports the injected LITERAL rather than deriving a value from
 * import.meta.env, so a gate compiles to `if (false)` in the module that
 * writes it and Rollup can drop the branch without cross-module analysis.
 * Excluding the code is enforced by vite.config.ts's rc-exclusion-guard, which
 * fails the build if any remote-control module is still reachable.
 */
export const RC_ENABLED = __RC_ENABLED__;

/**
 * The Capacitor ANDROID app specifically. iOS is a native platform too
 * (isMobile() is true there) but carries none of the SovereignApp plugin's
 * features — notifications, keep-alive, the widget — so UI for those must
 * gate on this, not on isMobile(), or iOS renders controls wired to nothing.
 */
export function isAndroidApp(): boolean {
    return Capacitor.getPlatform() === 'android';
}

/**
 * Is the user actually looking at the app right now?
 *
 * The answer to "should I raise an OS notification" is the NEGATION of this, so
 * getting it wrong in the true direction silences every notification.
 *
 * On DESKTOP the question is window focus: the app can be fully visible behind
 * another window, and a notification there is wanted.
 *
 * On MOBILE `document.hasFocus()` is the wrong question and answers it wrongly.
 * It reports DOM focus WITHIN the document, and an Android WebView keeps that
 * while its Activity is paused — so a backgrounded Capacitor app reports
 * `hasFocus() === true` and every message notification is suppressed as
 * "you're already looking at it". That was the 0813 report: task reminders
 * arrived (they have no focus gate) while messages never did, from the same
 * WebView, the same setting and the same native plugin. There is no window
 * manager on a phone — the app is either foregrounded or it is not, and
 * `visibilityState` is the signal that actually tracks it.
 */
export function appIsForeground(): boolean {
    if (typeof document === 'undefined') return false;
    if (isMobile()) return document.visibilityState === 'visible';
    return document.hasFocus();
}

/**
 * Detect the current platform
 */
function getPlatform(): Platform {
    // Check for Capacitor native platforms first
    if (Capacitor.isNativePlatform()) {
        const platform = Capacitor.getPlatform();
        if (platform === 'ios') return 'ios';
        if (platform === 'android') return 'android';
    }

    // Check for Tauri (desktop)
    if (isTauri()) {
        return 'tauri';
    }

    // Default to web
    return 'web';
}

/**
 * Get the appropriate API base URL for the current platform
 *
 * On mobile, we need to use the actual server URL since
 * localhost doesn't work on physical devices.
 */
export function getApiBaseUrl(): string {
    const platform = getPlatform();

    // The base is VITE_API_URL, baked in at BUILD time from
    // frontend/.env.production — which is gitignored, so it is per-deployment
    // and never a hardcoded domain in this repo.
    //
    // The localhost fallback is a development convenience and a shipping
    // hazard, not a default: a release built without .env.production takes it
    // silently. That happened on 2026-08-03 and stranded every updated client
    // (login broke, and the update checks used the same broken base, so no
    // client could reach the fixed release) — see api/updateCheckBases.ts, which
    // exists because of it. Check the value the build printed before shipping.
    //
    // Both branches resolve the same way; they are kept apart because on a
    // physical handset localhost is the HANDSET, so a mobile build that falls
    // back here cannot reach a dev server at all — set VITE_API_URL to the
    // machine's LAN address for on-device development.
    if (platform === 'ios' || platform === 'android') {
        return import.meta.env.VITE_API_URL || 'http://localhost:3000';
    }

    return import.meta.env.VITE_API_URL || 'http://localhost:3000';
}

/**
 * Get WebSocket URL for the current platform
 */
export function getWebSocketUrl(): string {
    const baseUrl = getApiBaseUrl();
    return baseUrl.replace(/^http/, 'ws');
}
