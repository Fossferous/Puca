/**
 * Is the app on screen? Hidden for SUSPEND_AFTER_HIDDEN_MS, it gives back
 * every decrypted attachment it is not using (the message attachments, and
 * the pictures and voice notes of Tasks and Notes), so none of them is left
 * as a plaintext file in the engine's blob storage while the app sits in the
 * background — where a phone kills it without warning and the file would
 * stay on disk until the app's next start (measured 2026-10-05 in the
 * Android WebView: 79 MB of a channel's pictures and videos, as written,
 * until the next launch removed them).
 *
 * One in use stays: playing, open in the lightbox, being saved.
 *
 * In the Android WebView the page keeps running in the background
 * (visibilitychange, timers and React all ran with the app behind the home
 * screen, measured), so the copies are let go within about two seconds of
 * leaving the app. Back on screen, they are decrypted again from the
 * ciphertext the cache kept: nothing is downloaded again.
 */
import { useSyncExternalStore } from 'react';

/** Hidden this long, the app lets go of what it is not using. Short enough
 *  that a phone killing it right after it went to the background finds
 *  nothing; long enough that a glance at another app costs nothing. */
export const SUSPEND_AFTER_HIDDEN_MS = 2000;

let suspendAfterMs = SUSPEND_AFTER_HIDDEN_MS;
let awake = true;
let timer: ReturnType<typeof setTimeout> | null = null;
const subs = new Set<() => void>();
let installed = false;

function set(next: boolean): void {
    if (awake === next) return;
    awake = next;
    for (const s of [...subs]) s();
}

function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
        timer ??= setTimeout(() => { timer = null; set(false); }, suspendAfterMs);
    } else {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        set(true);
    }
}

function install(): void {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    document.addEventListener('visibilitychange', onVisibility);
    // Loaded while already hidden (a phone restoring the app behind the lock screen).
    if (document.visibilityState === 'hidden') onVisibility();
}

/** False once the app has been hidden for SUSPEND_AFTER_HIDDEN_MS. */
export function attachmentsAwake(): boolean {
    install();
    return awake;
}

export function subscribeAttachmentsAwake(cb: () => void): () => void {
    install();
    subs.add(cb);
    return () => { subs.delete(cb); };
}

/** attachmentsAwake, re-rendering when it changes. */
export function useAttachmentsAwake(): boolean {
    return useSyncExternalStore(subscribeAttachmentsAwake, attachmentsAwake, () => true);
}

/** Tests only: another delay (null: the real one). */
export function __setSuspendAfterHiddenMs(ms: number | null): void {
    suspendAfterMs = ms ?? SUSPEND_AFTER_HIDDEN_MS;
}

/** Tests only: forget the state (the listener stays installed). */
export function __resetAttachmentsAwake(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    set(true);
}
