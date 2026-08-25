/**
 * Hides WebView2's built-in "… is sharing a window and audio" bar while a
 * capture is active (desktop only — no-op in browsers). The app has its own
 * indicators (stream tiles, the clip roster badge), so the OS bar is redundant.
 * The Rust side (src-tauri/src/capture_bar.rs) conservatively matches only that
 * bar's window.
 *
 * A one-shot hide isn't enough: the bar appears a beat after getDisplayMedia
 * resolves, and Chromium re-creates/re-shows it (e.g. after its own "Hide"
 * button, on focus changes, or when the share is re-negotiated). So we run a
 * lightweight poll for as long as ANY holder is active and re-hide it each time
 * it comes back.
 *
 * HOLDER-KEYED, not a counter. Three independent captures can overlap — a voice
 * screen share, a device-control session per capture, the clip replay buffer —
 * and their start/stop calls are not balanced against each other (VoicePanel
 * calls stop twice per share; hostWebview starts per capture and stops once).
 * A plain refcount under those callers either never stops polling or un-hides
 * the bar in the middle of someone else's capture. A Set of holder ids is
 * idempotent per holder and stops exactly when the last holder releases.
 */
import { isTauri } from './platform';

const POLL_MS = 700;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const holders = new Set<string>();

async function hideOnce(): Promise<void> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke<number>('hide_screen_capture_bar');
    } catch {
        /* best effort — the bar staying visible is harmless */
    }
}

/** Keep the WebView2 sharing bar hidden on behalf of `holder` (idempotent per holder). */
export function hideCaptureBar(holder: string): void {
    if (!isTauri()) return;
    holders.add(holder);
    void hideOnce(); // hide the current bar immediately
    if (pollTimer) return; // already polling
    pollTimer = setInterval(() => void hideOnce(), POLL_MS);
}

/** Release `holder`; the poll stops only when no holder remains. */
export function releaseCaptureBar(holder: string): void {
    holders.delete(holder);
    if (holders.size > 0) return;
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/** Test/diagnostic hook: which holders currently keep the bar hidden. */
export function captureBarHolders(): string[] {
    return [...holders];
}

/** Legacy name kept for the voice screen share — it is exactly one holder. */
export function startHidingCaptureBar(): void { hideCaptureBar('voice-share'); }
/** Legacy name — releases the voice-share holder only. */
export function stopHidingCaptureBar(): void { releaseCaptureBar('voice-share'); }
