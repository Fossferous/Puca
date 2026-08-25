/**
 * Asking the user for the unattended passphrase, without `session.ts` knowing
 * anything about UI.
 *
 * `session.ts` owns protocol and sockets; it must not import a React component
 * or it becomes untestable and unmountable in a worker. So the request is a
 * plain promise here, and whichever component is mounted resolves it. If nothing
 * is listening the request resolves to `null` — refused — rather than hanging a
 * session forever waiting for a dialog nobody can see.
 *
 * The passphrase passes through as a plain string and is deliberately NOT cached:
 * a remembered unattended passphrase would defeat the point of having one
 * separate from the account password.
 */

export interface PassphraseRequest {
    /** Which device is asking, so the prompt can name it. */
    peerDevice: string;
    /** Resolve with the passphrase, or null to refuse. */
    resolve: (value: string | null) => void;
}

type Handler = (req: PassphraseRequest) => void;

let handler: Handler | null = null;

/**
 * Register the UI that answers passphrase requests. Returns an unregister
 * function; the last registration wins, so a remounting component replaces
 * rather than stacks.
 */
export function setUnattendedPassphraseHandler(h: Handler): () => void {
    handler = h;
    return () => {
        if (handler === h) handler = null;
    };
}

/**
 * Ask for the passphrase. Resolves null when refused, or when no UI is mounted
 * to ask — a headless host must not sit waiting on a dialog that cannot appear.
 */
export function requestUnattendedPassphrase(peerDevice: string): Promise<string | null> {
    if (!handler) return Promise.resolve(null);
    // A promise's resolve is ALREADY idempotent, so a second call from a
    // double-clicking UI is a no-op without any guard of ours. Stated here
    // because it is the kind of guarantee worth relying on deliberately rather
    // than re-implementing: if this ever stops being promise-backed, the
    // single-answer contract has to be re-established explicitly.
    return new Promise<string | null>(resolve => {
        handler!({ peerDevice, resolve });
    });
}

/** Test seam: forget any registered handler. */
export function resetUnattendedPassphraseHandler(): void {
    handler = null;
}
