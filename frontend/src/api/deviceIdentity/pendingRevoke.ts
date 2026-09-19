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

let inFlight: Promise<'none' | RevokeOutcome> | null = null;

/**
 * Finish a revoke an earlier sign-out could not confirm, with the CURRENT
 * session. Resolves 'none' when there is nothing to do (no marker, another
 * account's marker, no token). On a 2xx the key goes with the marker; a 404
 * (not this account's row) drops the marker and keeps the key; anything else
 * keeps both for the next attempt. Never rejects; one attempt at a time.
 *
 * MUST run before this browser enrols (attest.ts awaits it): the DELETE
 * revokes every session that proved the old device, and a session only
 * proves a device after enrolling.
 */
export function settlePendingDeviceRevoke(token: string | null, uid: number | null): Promise<'none' | RevokeOutcome> {
    if (inFlight) return inFlight;
    const m = readPendingRevoke();
    if (!m || !token) return Promise.resolve('none');
    if (m.uid !== null && uid !== null && m.uid !== uid) return Promise.resolve('none');
    inFlight = (async () => {
        const outcome = await sendDeviceRevoke(m.devId, token);
        // Re-read: another tab may have settled (or replaced) it meanwhile.
        const now = readPendingRevoke();
        const same = now !== null && now.devId === m.devId;
        if (outcome === 'revoked' && same) forgetKeyForPendingRevoke(now);
        else if (outcome === 'not-found' && same) clearPendingRevoke();
        return outcome;
    })().finally(() => { inFlight = null; });
    return inFlight;
}
