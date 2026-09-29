/**
 * The decisions NotesDesktopView.tsx makes on the page's behalf, kept out of
 * the component so they can be tested without mounting it: whose a key press
 * is, when Notes' sealed cache may be read back, and how its query client
 * ends.
 */
import type { QueryClient } from '@tanstack/react-query';
import { onIdentityRestoreChange } from '../api/auth';
import { getActiveIdentity, seedMatchesCurrentAccount } from '../api/e2ee';
import { matchesRegisteredHotkey } from '../api/hotkeys';
import { coveredAt } from './portalTarget';

/**
 * Whether a window-level key press is embedded Notes' to act on. The window
 * is Púca's as much as Notes', and Notes' shortcuts are single letters, so a
 * key is Notes' only when all of these hold:
 *
 *  - the view is on screen (not `inert`, which is how it is hidden);
 *  - it is not one of Púca's own hotkeys — push-to-talk bound to a bare `c`
 *    must not also start a note;
 *  - focus is in Notes, or nowhere (the body): not in the app's own chrome;
 *  - nothing of the app's is over the view — a dialog, the settings, a menu.
 *    Asked of the page itself, by what is on top at the view's centre, so no
 *    list of the app's dozens of modals has to be kept in step with it.
 */
export function notesOwnsKey(e: KeyboardEvent, host: HTMLElement | null): boolean {
    if (!host || host.hasAttribute('inert')) return false;
    if (matchesRegisteredHotkey(e)) return false;
    const t = e.target;
    if (t instanceof Node && t !== document.body && t !== document.documentElement && !host.contains(t)) return false;
    return !coveredAt(host);
}

/**
 * Empty the view's own query client for good, as the view goes (sign-out,
 * expiry). A clear alone is not the end of it: whatever is still on its way
 * in — the sealed cache being read back, a create's answer — lands after it
 * and builds a fresh query, with the signed-out account's decrypted rows in
 * it and a 30-minute gc timer holding them into the next account's session,
 * in a client nothing reads. From here on, anything added is dropped as it
 * arrives.
 */
export function retireQueryClient(qc: QueryClient): void {
    const cache = qc.getQueryCache();
    cache.subscribe(e => { if (e.type === 'added') cache.remove(e.query); });
    qc.clear();
}

/** This account's own identity is in hand, so its sealed cache opens. */
function identityReady(): boolean {
    return seedMatchesCurrentAccount() && getActiveIdentity() !== null;
}

/**
 * Run `onReady` once this account's identity can open Notes' sealed
 * on-device cache: now, or when a restore that failed at sign-in lands later
 * (IdentityBanner's retry). hydrateNotesCache opens nothing without it, and
 * `late` tells the caller that what Notes fetched meanwhile was fetched with
 * no keys and wants reading again. Returns the cancel.
 */
export function whenIdentityReady(onReady: (late: boolean) => void): () => void {
    if (identityReady()) {
        onReady(false);
        return () => {};
    }
    const off = onIdentityRestoreChange(() => {
        if (!identityReady()) return;
        off();
        onReady(true);
    });
    return off;
}
