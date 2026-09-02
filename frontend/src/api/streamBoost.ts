/**
 * Streaming priority boost (desktop only — no-op in browsers and on mobile).
 *
 * Field-confirmed 2026-08-20: with an uncapped fullscreen game in the
 * foreground, the outgoing screen share collapses because the WebView2
 * processes doing the capture and the (software VP8) encode run at NORMAL
 * priority while the game gets the foreground boost — the stream is laggy
 * until the game is tabbed out or fps-capped. While any holder is active,
 * the Rust side (src-tauri/src/stream_boost.rs) raises our WebView2 child
 * processes to ABOVE_NORMAL so the pipeline keeps its frame cadence under a
 * saturating game, and restores them when the last holder releases.
 *
 * HOLDER-KEYED like captureBar.ts, and for the same reason: captures overlap
 * and their start/stop calls are not balanced against each other. But the
 * holder SETS differ deliberately — the boost is only for captures a human is
 * WATCHING live (voice screen share, device-control host capture). The armed
 * clip replay buffer hides the capture bar too, yet must NOT boost: nobody
 * sees that capture live, and taking CPU from the game to feed it would trade
 * this bug for the "Púca makes games choppy" one.
 */
import { isTauri } from './platform';

const holders = new Set<string>();

// Serialize the on/off invokes: activation and release are fire-and-forget,
// and an off overtaking an on across the IPC boundary would strand the boost
// in the wrong state for the rest of the session.
let chain: Promise<void> = Promise.resolve();

function send(active: boolean): void {
    chain = chain.then(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke<number>('set_stream_boost', { active });
        } catch {
            /* best effort — an unboosted share still works, just degrades
               under a saturating game exactly as before this existed */
        }
    });
}

/** Hold the boost on behalf of `holder` (idempotent per holder). */
export function holdStreamBoost(holder: string): void {
    if (!isTauri()) return;
    const wasEmpty = holders.size === 0;
    holders.add(holder);
    if (wasEmpty && holders.size > 0) send(true);
}

/** Release `holder`; the boost drops only when no holder remains. */
export function releaseStreamBoost(holder: string): void {
    if (!holders.delete(holder)) return;
    if (holders.size === 0) send(false);
}

/** Test/diagnostic hook: which holders currently keep the boost active. */
export function streamBoostHolders(): string[] {
    return [...holders];
}

/** Test hook: await all in-flight boost IPC (the sends are fire-and-forget). */
export function streamBoostSettled(): Promise<void> {
    return chain;
}
