/**
 * Asking the person at the HOST whether to let the controller browse files,
 * and which folder.
 *
 * WHY THIS IS SEPARATE FROM THE SESSION CONSENT.
 *
 * Agreeing to share a screen is not agreeing to hand over the disk, but both
 * ride the same WebRTC connection. The first version of file transfer had no
 * gate at all: the agent answered any `FsRequest` that arrived on any data
 * channel with an unjailed read or write of any absolute path. Someone granted
 * a look at your screen could read your SSH keys and overwrite your documents,
 * and nothing on the host said a word about it.
 *
 * So file access is its own capability, asked for separately, scoped to ONE
 * folder, and revoked when the session ends. The agent refuses every request
 * until `Request::SetFileAccess` names a root, and confines everything
 * underneath it — this module is what causes that request to be sent.
 *
 * Same shape as hostConsent.ts and unattendedPrompt.ts, and for the same
 * reason: session.ts owns protocol and sockets and must not import a React
 * component. If nothing is mounted to ask, this DENIES rather than hanging.
 */

export interface FileAccessRequest {
    /** Which device is asking, so the prompt can name it. */
    peerDevice: string;
    /** Resolve with the folder to share, or null to refuse. */
    resolve: (value: { root: string } | null) => void;
}

type Handler = (req: FileAccessRequest) => void;

/** How long the person at the host has to answer before it is treated as No.
 *
 *  Shorter than the session consent deadline: the controller is sitting in a
 *  file browser waiting for a directory listing, not watching a video, so a
 *  long silence is worse than a quick refusal it can retry. */
const FILE_CONSENT_DEADLINE_MS = 30_000;

let handler: Handler | null = null;

/**
 * Register the UI that answers file-access requests. Returns an unregister
 * function; the last registration wins, so a remounting component replaces
 * rather than stacks.
 */
export function setFileAccessHandler(h: Handler): () => void {
    handler = h;
    return () => {
        if (handler === h) handler = null;
    };
}

/**
 * Ask whether to allow file access, and for which folder. Resolves null when
 * refused, when nothing is mounted to ask, or on the deadline — never allow by
 * default, because the caller is about to expose a folder to another machine.
 */
export function requestFileAccessConsent(peerDevice: string): Promise<{ root: string } | null> {
    if (!handler) return Promise.resolve(null);
    return new Promise<{ root: string } | null>(resolve => {
        let done = false;
        const answer = (value: { root: string } | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => answer(null), FILE_CONSENT_DEADLINE_MS);
        handler!({ peerDevice, resolve: answer });
    });
}

/** Test seam: forget any registered handler. */
export function resetFileAccessHandler(): void {
    handler = null;
}
