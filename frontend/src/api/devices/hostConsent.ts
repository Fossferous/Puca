/**
 * Asking the person at the HOST whether to allow a session, and which screen.
 *
 * WHY THIS HAS TO EXIST BEFORE THE AGENT SHIPS.
 *
 * Until 0.8.4 no installer contained the agent, so every host fell back to the
 * webview and every session opened `getDisplayMedia` — the browser's "Choose
 * what to share" dialog. That dialog was a usability disaster (it needs someone
 * at the keyboard, which defeats unattended access entirely, and it may not even
 * be presentable on a window minimised to the tray) but it was also, by pure
 * accident, the host's consent step: somebody had to click Share.
 *
 * The agent captures via DXGI with no prompt at all. Shipping it without
 * replacing that step would mean an UNARMED machine silently begins streaming
 * its screen to any device on the account, with nothing shown locally. That
 * trades a usability bug for a consent regression.
 *
 * So: a host that is ARMED with an unattended passphrase does not prompt — that
 * is what "unattended" means, and the passphrase is the gate. A host that is NOT
 * armed asks the person sitting at it, and gets to pick the monitor while it is
 * asking, which is the thing the OS picker was doing that was worth keeping.
 *
 * Same shape as unattendedPrompt.ts and for the same reason: session.ts owns
 * protocol and sockets and must not import a React component. If nothing is
 * mounted to ask, this DENIES rather than hanging — a host that cannot show a
 * dialog must not sit there while a controller waits forever.
 */

export interface ConsentRequest {
    /** Which device is asking, so the prompt can name it. */
    peerDevice: string;
    /** Monitors to choose between; empty when the host cannot enumerate them. */
    monitors: { id: number; label: string }[];
    /** Present when a FRIEND is asking under a device share: the prompt names
     *  the PERSON, not just a device id. Server-stamped from the requester's
     *  authenticated claims — never something the peer typed. Absent for
     *  same-account requests, where "one of your own devices" is the truth. */
    fromUsername?: string;
    /** The share's capabilities, when this is a cross-user request — so the
     *  prompt describes exactly what is being asked for (view-only vs control
     *  vs files) rather than always claiming full control. Absent same-account. */
    capabilities?: string[];
    /** Resolve with the chosen monitor, or null to refuse. */
    resolve: (value: { monitor: number } | null) => void;
}

type Handler = (req: ConsentRequest) => void;

/** How long the person at the host has to answer before it is treated as No.
 *
 *  Deliberately under the server's 60s reap of an unanswered connect request:
 *  the dialog must close itself while the thing it is asking about still
 *  exists, or the user answers a session that is already gone. */
const CONSENT_DEADLINE_MS = 45_000;

let handler: Handler | null = null;

/**
 * Register the UI that answers consent requests. Returns an unregister
 * function; the last registration wins, so a remounting component replaces
 * rather than stacks.
 */
export function setHostConsentHandler(h: Handler): () => void {
    handler = h;
    return () => {
        if (handler === h) handler = null;
    };
}

/**
 * Ask whether to allow this session. Resolves null when refused, or when there
 * is no UI mounted to ask — never allow by default, because the caller is about
 * to start capturing this machine's screen.
 */
export function requestHostConsent(
    peerDevice: string,
    monitors: { id: number; label: string }[],
    fromUsername?: string,
    capabilities?: string[],
): Promise<{ monitor: number } | null> {
    if (!handler) return Promise.resolve(null);
    return new Promise<{ monitor: number } | null>(resolve => {
        // DENY on a deadline, and answer exactly once.
        //
        // The server reaps an unanswered connect request at 60s, so without a
        // timeout the modal stayed up over the whole app after the session it
        // was asking about had already died — and a late Allow accepted a dead
        // session. Shorter than the server's reap so the dialog closes itself
        // before the request it refers to is gone.
        let done = false;
        const answer = (value: { monitor: number } | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => answer(null), CONSENT_DEADLINE_MS);
        handler!({ peerDevice, monitors, fromUsername, capabilities, resolve: answer });
    });
}

/** Test seam: forget any registered handler. */
export function resetHostConsentHandler(): void {
    handler = null;
}
