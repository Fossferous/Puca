/**
 * One line per SFU or share EVENT, to the console and, in the desktop app, to
 * puca.log.
 *
 * WHY THIS EXISTS. A viewer's report on 2026-10-25 had a LiveKit
 * EncryptionError for the sharer, outages and a rejoin, and the only place any
 * of it was ever written was the WebView console, which a release build does
 * not keep: puca.log gets nothing but invoke('log_stream_diag') (lib.rs). The
 * minute health line (healthLog.ts) and the 5 s sampler (streamDiag.ts) carry
 * RATES; these are the moments between them: a decrypt failure and why, the
 * server pausing a watched share, a reconnect and how long it took, a watched
 * share arriving at another size, the viewer's own step to a smaller copy and
 * back, and the sharer's own share running short.
 *
 * In order (one chain), best effort, one line per event, never per frame. No
 * names: user ids are the pseudonymous numbers the SFU already uses, and the
 * per-connection suffix of a LiveKit identity is dropped (identityFree).
 */

let chain: Promise<void> = Promise.resolve();

export function logRtcEvent(line: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
    chain = chain.then(async () => {
        try {
            // Imported here, not at the top: a test that stands in for the
            // platform module with a partial mock must not lose the line's
            // caller to a missing export.
            const { isTauri } = await import('../platform');
            if (!isTauri()) return;
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('log_stream_diag', { line });
        } catch { /* best effort: a missing line is a gap, not a failure */ }
    });
}

/** Settle point for tests. */
export function rtcEventLogSettled(): Promise<void> {
    return chain;
}

/** `u<id>#<per-connection nonce>` (a LiveKit identity, sfu.rs) becomes
 *  `u<id>` wherever it appears in a text. */
export function identityFree(text: string): string {
    return text.replace(/\bu(\d+)#[\w-]+/g, 'u$1');
}

/** livekit-client's CryptorErrorReason, by number. Pinned against the real
 *  enum by a test, so an upgrade that renumbers it fails there. */
export const CRYPTOR_REASONS: Readonly<Record<number, string>> = {
    0: 'invalid-key',
    1: 'missing-key',
    2: 'internal',
};

/** The same reasons by the NAME livekit-client's frame worker writes them
 *  under (CryptorErrorReason[reason]), also pinned by a test. */
const CRYPTOR_REASON_NAMES: Readonly<Record<string, string>> = {
    InvalidKey: 'invalid-key',
    MissingKey: 'missing-key',
    InternalError: 'internal',
};

/**
 * The line for RoomEvent.EncryptionError: whose media, why (the reason LiveKit
 * gives: a key that does not open the frames is `invalid-key`, which is what
 * the badge calls verification-failed), and LiveKit's own words without the
 * identity's suffix.
 *
 * THE REASON IS IN THE MESSAGE. The frame worker cannot post a CryptorError
 * across to the page, so it posts `new Error("MissingKey: <its message>")`
 * (livekit-client e2ee.worker.ts setupCryptorErrorEvents): that plain Error,
 * with no `reason` field, is what the room emits. A `reason` number is read
 * as well, for an error raised on the page itself.
 */
export function encryptionErrorLine(error: unknown, userId: number | null): string {
    const e = (error && typeof error === 'object' ? error : {}) as { reason?: unknown; message?: unknown };
    let text = typeof e.message === 'string' && e.message ? e.message : String(error);
    let reason = typeof e.reason === 'number' ? (CRYPTOR_REASONS[e.reason] ?? `reason ${e.reason}`) : null;
    const named = /^(\w+): /.exec(text);
    if (named && CRYPTOR_REASON_NAMES[named[1]]) {
        reason ??= CRYPTOR_REASON_NAMES[named[1]];
        text = text.slice(named[0].length);
    }
    const whose = userId === null ? 'media' : `user ${userId}'s media`;
    return `[sfu-e2ee] ${whose} failed to decrypt: ${reason ?? 'unknown'} (${identityFree(text).slice(0, 200)})`;
}
