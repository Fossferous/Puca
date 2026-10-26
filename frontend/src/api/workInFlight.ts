/**
 * Work in this app that a restart would lose: an upload on its way to the
 * server, and a message written but not sent.
 *
 * WHY. A PC set up for remote control installs updates by itself and
 * restarts (components/HostAutoUpdate.tsx), and the review of 2026-10-26
 * found two things it could not see: an attachment or a Clip still
 * uploading (cut off, and the message that carries it never sent), and the
 * composer's text (React state only, so a restart drops it). Both count
 * here, and the host update waits for them.
 *
 * Counted, not stored: nothing here says WHAT is uploading or written.
 */
import { useEffect } from 'react';

const uploads = new Set<symbol>();
const unsent = new Set<string>();

/** Count `p` as an upload in flight until it settles, and hand it back. */
export function trackUpload<T>(p: Promise<T>): Promise<T> {
    const token = Symbol('upload');
    uploads.add(token);
    return p.finally(() => { uploads.delete(token); });
}

/** How many uploads are on their way now. */
export function uploadsInFlight(): number {
    return uploads.size;
}

/** `owner` (one composer) holds, or no longer holds, something unsent. */
export function noteUnsent(owner: string, holding: boolean): void {
    if (holding) unsent.add(owner);
    else unsent.delete(owner);
}

/** Does any composer hold a message that has not been sent? */
export function hasUnsent(): boolean {
    return unsent.size > 0;
}

/** A composer's hold, kept in step with what it shows, and let go when it
 *  unmounts. */
export function useUnsentWork(owner: string, holding: boolean): void {
    useEffect(() => {
        noteUnsent(owner, holding);
        return () => noteUnsent(owner, false);
    }, [owner, holding]);
}
