/**
 * Asking the user for the unattended passphrase (or, at a locked PC, the one
 * for its sign-in screen: `PassphraseRequest.signIn`), without `session.ts`
 * knowing anything about UI.
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
    /** Which device row is asking (its id). */
    peerDevice: string;
    /** What the person calls that PC ("Desk-PC"), when the caller said; the
     *  prompt names it. Null: it says "This device". */
    peerName: string | null;
    /** The row is the PC's SIGN-IN-SCREEN row (machines.ts `signInRow`): the
     *  PC is locked, at its sign-in screen, or just restarted or woken, and
     *  what answers is its lock-screen service, which checks its OWN record,
     *  "Passphrase for the sign-in screen", set apart from "Unattended
     *  access" with its own salt. The prompt asks for that one by name: when
     *  it said "Unattended passphrase" here too, a person whose two differ
     *  typed the wrong one at every locked PC. Display only — the host checks
     *  whatever it is handed against its own record. */
    signIn: boolean;
    /** Resolve with the passphrase, or null to refuse. */
    resolve: (value: string | null) => void;
}

/** What the caller knows about the PC asking, for the prompt's words. */
export interface PassphraseAbout {
    peerName?: string | null;
    signIn?: boolean;
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
export function requestUnattendedPassphrase(peerDevice: string, about?: PassphraseAbout): Promise<string | null> {
    if (!handler) return Promise.resolve(null);
    const peerName = about?.peerName?.trim() || null;
    const signIn = about?.signIn === true;
    // A promise's resolve is ALREADY idempotent, so a second call from a
    // double-clicking UI is a no-op without any guard of ours. Stated here
    // because it is the kind of guarantee worth relying on deliberately rather
    // than re-implementing: if this ever stops being promise-backed, the
    // single-answer contract has to be re-established explicitly.
    return new Promise<string | null>(resolve => {
        handler!({ peerDevice, peerName, signIn, resolve });
    });
}

/** Test seam: forget any registered handler. */
export function resetUnattendedPassphraseHandler(): void {
    handler = null;
}
