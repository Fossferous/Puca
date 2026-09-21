/**
 * A web sign-out's device revoke, made durable.
 *
 * Signing out of a BROWSER revokes its device row (DELETE /devices/:id) and
 * then forgets the web device key — but only once the server has confirmed
 * the revoke, because a key dropped while its row lives on strands that row
 * and enrols a ghost on the next sign-in. The confirmation can be lost while
 * the revoke itself lands: the tab closes straight after "Sign out" (the case
 * the keepalive fetch is there for), or the connection drops after the server
 * committed. The row is then revoked while the key is kept, and every later
 * enrolment from this browser is refused with `device_revoked` for good —
 * attest.ts, rightly, never lets the SERVER tell it to destroy a key.
 *
 * So the intent is written down HERE, locally, before the DELETE is sent:
 * `{devId, uid}`. The marker is what makes both recoveries safe:
 *
 *  - The next time this browser holds a token for the same account (a sign-in,
 *    or a page load while signed in) the DELETE is sent again. The server
 *    answers 200 for a row it has already revoked (its existence check does
 *    not filter `revoked_at`), and the key is forgotten on that 2xx.
 *  - An enrolment refused with `device_revoked` for the id in the marker may
 *    forget the key (attest.ts). The marker was written by this browser, not
 *    asserted by the server, so this hands a hostile server nothing.
 *
 * The marker names the device by its id, which is derived from the key's
 * PUBLIC halves — it never holds or hashes the private key. "The marker
 * matches the key" means the key in storage still derives that id: a key
 * minted since (a new enrolment) is never touched.
 *
 * Web only by construction: the marker is written only where the web key
 * lives in localStorage; the desktop and phone shells keep their identity
 * across a sign-out on purpose (see logout() in api/auth.ts).
 *
 * No import of api/auth.ts: auth.ts imports this. Tokens and user ids are
 * passed in.
 */
import { API_BASE_URL } from '../config';
import { WEB_KEY_STORAGE, peekWebDevicePublic } from './deviceKey';
import { deriveDeviceId } from './identity';

export const PENDING_REVOKE_KEY = 'pucaDeviceRevokePending';

export interface PendingRevoke {
    devId: string;
    /** The account the revoke belongs to; null when the token did not say. */
    uid: number | null;
    at: number;
}

export function readPendingRevoke(): PendingRevoke | null {
    try {
        const raw = localStorage.getItem(PENDING_REVOKE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw) as Partial<PendingRevoke>;
        if (typeof o.devId !== 'string' || o.devId === '') return null;
        return { devId: o.devId, uid: typeof o.uid === 'number' ? o.uid : null, at: typeof o.at === 'number' ? o.at : 0 };
    } catch {
        return null;
    }
}

export function writePendingRevoke(devId: string, uid: number | null): void {
    try {
        localStorage.setItem(PENDING_REVOKE_KEY, JSON.stringify({ devId, uid, at: Date.now() }));
    } catch { /* private mode: the revoke is then as good as this page's 2xx */ }
}

export function clearPendingRevoke(): void {
    try { localStorage.removeItem(PENDING_REVOKE_KEY); } catch { /* private mode */ }
}

/** The id the web key in storage derives, or null when there is none. */
export function storedWebDeviceId(): string | null {
    const pub = peekWebDevicePublic();
    return pub ? deriveDeviceId(pub.device_pub, pub.sign_pub) : null;
}

/** Whether the marker names THIS account's revoke of the key in storage. */
export function pendingRevokeMatches(m: PendingRevoke, devId: string, uid: number | null): boolean {
    if (m.devId !== devId) return false;
    if (m.uid !== null && uid !== null && m.uid !== uid) return false;
    return storedWebDeviceId() === m.devId;
}

/**
 * The revoke is confirmed: forget the web key IF it is still the one the
 * marker names (never a key written since), and the marker with it.
 */
export function forgetKeyForPendingRevoke(m: PendingRevoke): boolean {
    let forgot = false;
    try {
        if (storedWebDeviceId() === m.devId) {
            localStorage.removeItem(WEB_KEY_STORAGE);
            forgot = true;
        }
    } catch { /* private mode */ }
    clearPendingRevoke();
    return forgot;
}

export type RevokeOutcome = 'revoked' | 'not-found' | 'failed';

/**
 * DELETE the device row with an explicit token. Raw fetch, not apiClient: a
 * refusal must not raise the app-wide auth-expired signal in the middle of a
 * sign-out or a sign-in. `keepalive` so a tab closed straight after still
 * sends it.
 */
export async function sendDeviceRevoke(devId: string, token: string): Promise<RevokeOutcome> {
    try {
        const res = await fetch(`${API_BASE_URL}/devices/${encodeURIComponent(devId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
            keepalive: true,
        });
        if (res.ok) return 'revoked';
        return res.status === 404 ? 'not-found' : 'failed';
    } catch {
        return 'failed';
    }
}

/** The Web Locks name every tab of this origin (Púca and Púca Notes share
 *  one) takes around a settle, and around a settle-plus-enrol. */
export const DEVICE_REVOKE_LOCK = 'puca-device-revoke';

/**
 * Run `fn` holding the cross-tab device-revoke lock. Two tabs must not both
 * act on one marker: if Púca's settle failed and it then enrolled the old key
 * LIVE, a Notes tab's DELETE landing afterwards would revoke the session that
 * just proved it. Under the lock the second tab starts only once the first is
 * done, and re-reads the marker it left (cleared, by then).
 *
 * Not reentrant: never call it from inside `fn`. Where Web Locks are absent
 * (an insecure context, an old engine) or refuse, `fn` runs unlocked — the
 * per-tab guard below still holds, which is how this behaved before.
 *
 * The holder may keep it across a network call (attest.ts holds it over its
 * POST /devices), so a waiting tab can wait as long as that request does. Only
 * opportunistic work takes this lock, and nothing renders behind it.
 */
export async function withDeviceRevokeLock<T>(fn: () => Promise<T>): Promise<T> {
    let locks: LockManager | undefined;
    try { locks = typeof navigator !== 'undefined' ? navigator.locks : undefined; } catch { locks = undefined; }
    if (!locks || typeof locks.request !== 'function') return fn();
    let started = false;
    try {
        return await locks.request(DEVICE_REVOKE_LOCK, () => { started = true; return fn(); });
    } catch (e) {
        if (started) throw e;   // fn itself failed: never run it twice
        return fn();            // the lock manager refused (e.g. an opaque origin)
    }
}

let inFlight: Promise<'none' | RevokeOutcome> | null = null;

/**
 * Finish a revoke an earlier sign-out could not confirm, with the CURRENT
 * session. Resolves 'none' when there is nothing to do (no marker, another
 * account's marker, no token). On a 2xx the key goes with the marker; a 404
 * (not this account's row) drops the marker and keeps the key; anything else
 * keeps both for the next attempt. Never rejects; one attempt at a time in
 * this tab, and one at a time across tabs (withDeviceRevokeLock).
 *
 * MUST run before this browser enrols (attest.ts awaits it): the DELETE
 * revokes every session that proved the old device, and a session only
 * proves a device after enrolling.
 */
export function settlePendingDeviceRevoke(token: string | null, uid: number | null): Promise<'none' | RevokeOutcome> {
    if (inFlight) return inFlight;
    const m = readPendingRevoke();
    if (!m || !token) return Promise.resolve('none');
    // Another account's marker is not this call's to settle, so it does not
    // wait for the cross-tab lock either (an enrolment holds that across
    // POST /devices). The locked body re-reads the marker and checks again.
    if (m.uid !== null && uid !== null && m.uid !== uid) return Promise.resolve('none');
    inFlight = withDeviceRevokeLock(() => settlePendingDeviceRevokeLocked(token, uid))
        .catch((): 'failed' => 'failed')
        .finally(() => { inFlight = null; });
    return inFlight;
}

/**
 * settlePendingDeviceRevoke's body, for a caller ALREADY holding the lock
 * (attest.ts settles and enrols under one). Reads the marker only now, so a
 * tab that waited for the lock sees what the holder left.
 */
export async function settlePendingDeviceRevokeLocked(token: string | null, uid: number | null): Promise<'none' | RevokeOutcome> {
    const m = readPendingRevoke();
    if (!m || !token) return 'none';
    if (m.uid !== null && uid !== null && m.uid !== uid) return 'none';
    const outcome = await sendDeviceRevoke(m.devId, token);
    // Re-read: a tab without Web Locks may have settled (or replaced) it meanwhile.
    const now = readPendingRevoke();
    const same = now !== null && now.devId === m.devId;
    if (outcome === 'revoked' && same) forgetKeyForPendingRevoke(now);
    else if (outcome === 'not-found' && same) clearPendingRevoke();
    return outcome;
}
