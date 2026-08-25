/**
 * Keeps the phone working on a transfer after you leave the app.
 *
 * Android freezes a cached process, which stalls a transfer running in the
 * WebView. The fix is a foreground service (TransferService.java) whose
 * ongoing notification is also the honest signal to the user that the app is
 * still doing something. This module is the JS handle on it: brought up when
 * the first transfer starts, kept in step with progress, torn down with the
 * last one.
 *
 * DEGRADES SILENTLY AND ON PURPOSE. The native half only exists in APKs from
 * 0.8.31; this code reaches phones on older APKs over the air, where every
 * call rejects. Availability is therefore decided by CALLING it and watching
 * — `isPluginAvailable` cannot tell an old APK's plugin set from a new one —
 * and a failure downgrades to "transfers stop when you leave the app", which
 * is exactly the behaviour those builds already had.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

interface SovereignTransfersPlugin {
    notificationStatus(): Promise<{ granted: boolean; needsRequest: boolean }>;
    requestNotificationPermission(): Promise<{ granted: boolean }>;
    start(opts: { title?: string; text?: string; progress?: number }): Promise<void>;
    update(opts: { title?: string; text?: string; progress?: number }): Promise<void>;
    stop(): Promise<void>;
}

const Transfers = registerPlugin<SovereignTransfersPlugin>('SovereignTransfers');

/** null = not yet determined. Set on the first real call. */
let usable: boolean | null = null;
let running = false;

function android(): boolean {
    return Capacitor.getPlatform() === 'android';
}

/**
 * Ask for notification permission, once, at a moment the user understands —
 * i.e. when a transfer is about to start, not at launch. Refusing is fine:
 * the service still runs, it just cannot draw its notification.
 */
export async function ensureTransferNotificationPermission(): Promise<void> {
    if (!android() || usable === false) return;
    try {
        const status = await Transfers.notificationStatus();
        if (status.needsRequest) await Transfers.requestNotificationPermission();
    } catch {
        usable = false;   // old APK: nothing to ask for
    }
}

/**
 * Begin, or refresh, the background transfer notification.
 *
 * `progress` is 0-100; omit it for an indeterminate bar (a transfer whose
 * total size is not known yet).
 */
export async function beginBackgroundTransfer(text: string, progress?: number): Promise<void> {
    if (!android() || usable === false) return;
    try {
        await Transfers.start({
            title: 'Transferring files',
            text,
            progress: typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : -1,
        });
        usable = true;
        running = true;
    } catch {
        // An old APK, or Android refusing to start a foreground service from
        // the background (12+). Either way, stop trying for this session.
        usable = false;
    }
}

export async function updateBackgroundTransfer(text: string, progress?: number): Promise<void> {
    if (!running || usable !== true) return;
    try {
        await Transfers.update({
            title: 'Transferring files',
            text,
            progress: typeof progress === 'number' ? Math.max(0, Math.min(100, Math.round(progress))) : -1,
        });
    } catch {
        // A dropped update is cosmetic; the transfer itself is unaffected.
    }
}

/** Stop the service and clear the notification. Safe to call when not running. */
export async function endBackgroundTransfer(): Promise<void> {
    if (!running || usable !== true) { running = false; return; }
    running = false;
    try {
        await Transfers.stop();
    } catch {
        // Already gone.
    }
}
