/**
 * Microphone device diagnostics that reach puca.log on the desktop.
 *
 * Why: on 2026-10-07 the OS default microphone moved mid-call and the call
 * kept recording the old one, and puca.log had nothing to say about it — no
 * line for a devicechange, a default change or a mic restart existed, so the
 * report could only be reconstructed from the owner's memory and the
 * [mic-level] call start/end lines. The device watchdog
 * (rtc/micDeviceWatchdog.ts) now writes one line per settled burst of device
 * events (what it heard, what the default names, what the call captures, and
 * what it decided) and one per restart (how long it took, onto what), and the
 * desktop shell logs every Windows default-input change itself
 * (mic_default_watch.rs).
 *
 * Console everywhere; puca.log through the shell where there is one (a
 * release WebView keeps no console). Lines are written in order.
 */
import { isTauri } from './platform';
import type { NativeDefaultChange } from './rtc/micDeviceWatchdog';

/** The desktop shell's event (mic_default_watch.rs EVENT, pinned by a Rust
 *  test against this file). */
export const MIC_DEFAULT_EVENT = 'mic-default-changed';

let chain: Promise<void> = Promise.resolve();

export function logMicDiag(line: string): void {
    console.info(line);
    if (!isTauri()) return;
    chain = chain.then(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_stream_diag', { line });
        } catch { /* best effort — a missing line is not worth an error */ }
    });
}

/** Hear the desktop shell's Windows default-input notification. Returns
 *  the unsubscribe; safe to call before the listener has attached. */
export function subscribeNativeMicDefault(fn: (n: NativeDefaultChange) => void): () => void {
    let disposed = false;
    let un: (() => void) | null = null;
    void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<NativeDefaultChange>(MIC_DEFAULT_EVENT, e => {
            if (!disposed) fn(e.payload ?? {});
        }))
        .then(u => { if (disposed) u(); else un = u; })
        .catch(() => { /* no shell event channel: devicechange still covers it */ });
    return () => {
        disposed = true;
        un?.();
        un = null;
    };
}
