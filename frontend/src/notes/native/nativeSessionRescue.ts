/**
 * The Android app's background job may renew the session token while the
 * page sleeps. NativeTokenGate adopts that renewal at LAUNCH; this covers the
 * other way back into the page — the process survived in the background for
 * a day and the page simply resumes. Its token has expired by then, so its
 * first request 401s; without this, the page would soft-expire to sign-in and
 * the sign-out path would then delete the job's still-valid token too.
 *
 * So, before any expiry, and whenever the page becomes visible again: adopt
 * the job's token if it is the same account and lives longer
 * (pickAdoptableToken), and only when there is nothing to adopt, expire.
 * Inert in the browser and in an older APK: adoption answers false there, so
 * expiry happens exactly as before.
 */
import { getToken, storeRenewedToken } from '../../api/auth';
import { adoptNativeRenewedToken } from './notesNative';

export interface RescueDeps {
    /** Try to take over the job's renewed token; true when it was adopted. */
    adopt: () => Promise<boolean>;
    /** The session continues on the adopted token (re-arm the expiry signal,
     *  refetch what failed). */
    onAdopted: () => void;
    /** Nothing to adopt: the session really is over. */
    expire: () => void;
}

/** A 401 (or a token seen to be expired): rescue if we can, else expire. */
export async function rescueOrExpire(deps: RescueDeps): Promise<'adopted' | 'expired'> {
    let adopted = false;
    try {
        adopted = await deps.adopt();
    } catch {
        adopted = false;
    }
    if (adopted) {
        deps.onAdopted();
        return 'adopted';
    }
    deps.expire();
    return 'expired';
}

/**
 * The token ran out while OFFLINE (NotesApp keeps the cached notes on screen
 * rather than a sign-in that cannot work). When the network comes back, the
 * background job may have renewed the session meanwhile: rescue first, and
 * expire only when there is nothing to adopt — the same order as every other
 * way into expiry. One shot; returns an unsubscribe.
 */
export function rescueWhenOnline(deps: RescueDeps): () => void {
    if (typeof window === 'undefined') return () => {};
    let done = false;
    const back = () => {
        if (done) return;
        done = true;
        window.removeEventListener('online', back);
        void rescueOrExpire(deps);
    };
    window.addEventListener('online', back);
    return () => { done = true; window.removeEventListener('online', back); };
}

/** The real adoption, against the page's own token store. */
export function adoptFromNative(): Promise<boolean> {
    return adoptNativeRenewedToken(getToken, storeRenewedToken);
}

/**
 * Re-run adoption each time the page comes back into view (the app resumed),
 * BEFORE the reminder loop's next poll can 401 on the stale token. Returns an
 * unsubscribe.
 */
export function adoptOnResume(adopt: () => Promise<boolean>, onAdopted: () => void): () => void {
    if (typeof document === 'undefined') return () => {};
    const h = () => {
        if (document.visibilityState !== 'visible') return;
        void adopt().then(ok => { if (ok) onAdopted(); }).catch(() => { /* next 401 decides */ });
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
}
