/**
 * The keys behind DM envelope v4 (see migration 060 and e2ee.ts sealDmEnvelopeV4).
 *
 * WHAT v4 CHANGES. v2/v3 sealed every DM under a key derived from the two
 * long-term identity keys, and the identity seed is what the password unwraps
 * — so anyone who cracked a password against its Argon2id wrap could read every
 * DM that account ever exchanged, in either direction. v4 seals each message
 * under a fresh random key and wraps THAT key only to keys the password cannot
 * reach:
 *
 *  - SESSION KEYS. Each signed-in client mints an X25519 keypair for its
 *    session, keeps the private half in this device's storage, and publishes
 *    the public half against its server session. A new sign-in mints a new
 *    one; revoking the session retires it. A message wrapped to a session key
 *    is readable live on that device and nowhere else.
 *  - THE HISTORY KEY. One per account. Its public half is published; its
 *    private half is wrapped under the 12-word recovery code and under nothing
 *    else. A device that has been given the code once holds it, and can read
 *    every v4 message the account ever received or sent. A device signed in
 *    with only the password cannot — it sees new messages (wrapped to its
 *    session key) and a "locked" placeholder for older ones.
 *
 * That is the property this buys: a database copy plus a cracked password no
 * longer reads DM history. It is not per-message ratcheting; a stolen device
 * exposes what was wrapped to that device's session key for that session's
 * lifetime. The security model says exactly this.
 *
 * ROLLOUT. A sender emits v4 only when BOTH accounts have a history key and
 * every recently-seen session of both accounts has published a session key
 * and declared it can read v4 (`reads_up_to`). A 0.9.2 client does neither, so
 * its presence keeps the conversation on v3 — nothing an existing user has
 * installed can be sent a message it cannot open.
 */
import { apiClient } from './client';
import {
    generateX25519Keypair, keypairFromPrivate, type X25519Keypair,
    MAX_READABLE_ENVELOPE_VERSION, wrapKeyUnderRecovery, unwrapKeyUnderRecovery,
} from './e2ee';

const SESSION_KEYS_KEY = 'puca_dm_session_keys';
const HISTORY_KEY_KEY = 'puca_dm_history_key';
const PUBLISHED_KEY = 'puca_dm_session_published';
/** Session keys kept on this device: the current one plus a few predecessors,
 *  so a re-sign-in on the same device still opens what was wrapped to the
 *  previous session while the history key is not unlocked here. */
const SESSION_KEYS_KEPT = 6;
const KEYS_CACHE_MS = 30_000;
/** Sessions the server counts as "recent" when deciding whether every client
 *  of an account can read v4. Mirrors the server's window; documented in the
 *  FAQ: a client not opened for longer than this may find v4 messages it must
 *  update to read. */
export const RECENT_SESSION_DAYS = 14;

interface StoredSessionKey { sid: string; priv: string; pub: string; at: number }

function toB64(b: Uint8Array): string { return btoa(String.fromCharCode(...b)); }
function fromB64(s: string): Uint8Array { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

/** The `sid` claim of the current bearer token, or '' for a token without one
 *  (a session predating migration 055; its first renewal mints an id). */
export function currentSessionId(): string {
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) return '';
        const payload = token.split('.')[1] ?? '';
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
        const sid = (JSON.parse(json) as { sid?: unknown }).sid;
        return typeof sid === 'string' ? sid : '';
    } catch {
        return '';
    }
}

function readStored(): StoredSessionKey[] {
    try {
        const raw = localStorage.getItem(SESSION_KEYS_KEY);
        const list = raw ? (JSON.parse(raw) as StoredSessionKey[]) : [];
        return Array.isArray(list) ? list.filter(k => k && typeof k.priv === 'string' && typeof k.pub === 'string') : [];
    } catch {
        return [];
    }
}

function writeStored(list: StoredSessionKey[]): void {
    try { localStorage.setItem(SESSION_KEYS_KEY, JSON.stringify(list.slice(0, SESSION_KEYS_KEPT))); } catch { /* private mode */ }
}

/** Every session key this device still holds, newest first. */
export function loadSessionKeys(): X25519Keypair[] {
    const out: X25519Keypair[] = [];
    for (const k of readStored()) {
        try { out.push(keypairFromPrivate(fromB64(k.priv))); } catch { /* skip a corrupt entry */ }
    }
    return out;
}

function mintSessionKey(sid: string): X25519Keypair {
    const kp = generateX25519Keypair();
    writeStored([{ sid, priv: toB64(kp.privateKey), pub: kp.publicKeyEncoded, at: Date.now() }, ...readStored()]);
    return kp;
}

/** The history key if this device has unlocked it (registration, or the
 *  recovery code entered here), else null. */
export function getHistoryKey(): X25519Keypair | null {
    try {
        const raw = localStorage.getItem(HISTORY_KEY_KEY);
        return raw ? keypairFromPrivate(fromB64(raw)) : null;
    } catch {
        return null;
    }
}

export function storeHistoryKey(priv: Uint8Array): void {
    try { localStorage.setItem(HISTORY_KEY_KEY, toB64(priv)); } catch { /* private mode */ }
}

/** Sign-out: nothing that opens a message may outlive the session on a shared machine. */
export function clearDmKeys(): void {
    for (const k of [SESSION_KEYS_KEY, HISTORY_KEY_KEY, PUBLISHED_KEY]) {
        try { localStorage.removeItem(k); } catch { /* private mode */ }
    }
    keysCache.clear();
}

/** All keys that could open a v4 message on this device: session keys, then
 *  the history key if unlocked. */
export function openingKeys(): X25519Keypair[] {
    const h = getHistoryKey();
    return h ? [...loadSessionKeys(), h] : loadSessionKeys();
}

/**
 * Make sure this session has a DM key and the server knows it. Idempotent —
 * called after every sign-in and on every app start, so a client that was
 * already signed in when it updated publishes on its first run.
 */
export async function ensureSessionDmKeyPublished(): Promise<void> {
    const sid = currentSessionId();
    if (!sid) return; // no session id yet: the next token renewal mints one, and the next start publishes
    const stored = readStored();
    let current = stored.find(k => k.sid === sid);
    if (!current) {
        mintSessionKey(sid);
        current = readStored().find(k => k.sid === sid);
        if (!current) return;
    }
    const stamp = `${sid}:${current.pub}`;
    let published: string | null = null;
    try { published = localStorage.getItem(PUBLISHED_KEY); } catch { /* private mode */ }
    if (published === stamp) return;
    await apiClient.patch('/keys/session-dm', { dm_pubkey: current.pub, reads_up_to: MAX_READABLE_ENVELOPE_VERSION });
    try { localStorage.setItem(PUBLISHED_KEY, stamp); } catch { /* private mode */ }
    keysCache.clear(); // our own key set changed
}

let publishWired = false;
/**
 * Publish this session's DM key on EVERY socket open, whoever opened it.
 *
 * The sign-in form connects the socket itself (Login.tsx), so a publish that
 * was sequenced inside App's own connect attempt never ran for a fresh
 * sign-in: the key only appeared after the next app start, and until then the
 * partner's gate - correctly - held the conversation on v3. The mixed-fleet
 * upgrade rehearsal caught it (2026-09-05): a brand-new device read v4
 * history after entering its recovery code, yet every message sent to it
 * afterwards was still v3. Listening for the open event covers sign-in,
 * app start and every reconnect with one owner; the stamp makes repeats
 * free, and a failed attempt simply retries on the next (re)connect.
 */
export function wireSessionDmKeyPublish(): void {
    if (publishWired || typeof window === 'undefined') return;
    publishWired = true;
    window.addEventListener('wsConnected', () => {
        void ensureSessionDmKeyPublished().catch(e => console.warn('[dm-keys] publish deferred to the next connect:', e));
    });
}

export interface DmKeyInfo {
    history_pubkey: string | null;
    /** Session keys of every recently-seen, unrevoked session. */
    sessions: string[];
    /** Every recently-seen session has a session key and reads v4. */
    all_sessions_v4: boolean;
}

const keysCache = new Map<number, { at: number; info: DmKeyInfo }>();

export async function dmKeysFor(userId: number): Promise<DmKeyInfo> {
    const hit = keysCache.get(userId);
    if (hit && Date.now() - hit.at < KEYS_CACHE_MS) return hit.info;
    const info: DmKeyInfo = await apiClient.get(`/users/${userId}/dm-keys`);
    const clean: DmKeyInfo = {
        history_pubkey: typeof info.history_pubkey === 'string' ? info.history_pubkey : null,
        sessions: Array.isArray(info.sessions) ? info.sessions.filter(s => typeof s === 'string') : [],
        all_sessions_v4: info.all_sessions_v4 === true,
    };
    keysCache.set(userId, { at: Date.now(), info: clean });
    return clean;
}

export function invalidateDmKeys(): void { keysCache.clear(); }

/**
 * May a v4 envelope be sent between these two accounts right now? Pure, so
 * the rule is unit-testable: both have a history key; both have at least one
 * recent session (an account nobody has opened in RECENT_SESSION_DAYS gets v3,
 * so that when its owner comes back with only a password they can still read
 * what arrived); and every recent session of both can open v4 — one 0.9.2
 * client on either side keeps the conversation on v3.
 */
export function v4Eligible(recipient: DmKeyInfo, mine: DmKeyInfo): boolean {
    const ok = (i: DmKeyInfo) => !!i.history_pubkey && i.sessions.length > 0 && i.all_sessions_v4;
    return ok(recipient) && ok(mine);
}

/** Every key a v4 message between these accounts must be wrapped to. */
export function v4Targets(recipient: DmKeyInfo, mine: DmKeyInfo): string[] {
    const all = [...recipient.sessions, ...mine.sessions];
    if (recipient.history_pubkey) all.push(recipient.history_pubkey);
    if (mine.history_pubkey) all.push(mine.history_pubkey);
    return [...new Set(all)];
}

export interface HistoryKeyMaterial { historyPubkey: string; historyWrappedRc: string; priv: Uint8Array }

/** A fresh history key for an account, wrapped under its recovery code. Used
 *  at registration and when the recovery code is regenerated. */
export async function newHistoryKeyMaterial(recoveryCode: string, recoverySaltB64: string): Promise<HistoryKeyMaterial> {
    const kp = generateX25519Keypair();
    const wrapped = await wrapKeyUnderRecovery(kp.privateKey, recoveryCode, recoverySaltB64);
    if (!wrapped) throw new Error('could not wrap the history key under the recovery code');
    return { historyPubkey: kp.publicKeyEncoded, historyWrappedRc: wrapped, priv: kp.privateKey };
}

/** Re-wrap an EXISTING history key under a new recovery code (regeneration). */
export async function rewrapHistoryKey(priv: Uint8Array, recoveryCode: string, recoverySaltB64: string): Promise<HistoryKeyMaterial> {
    const kp = keypairFromPrivate(priv);
    const wrapped = await wrapKeyUnderRecovery(kp.privateKey, recoveryCode, recoverySaltB64);
    if (!wrapped) throw new Error('could not wrap the history key under the recovery code');
    return { historyPubkey: kp.publicKeyEncoded, historyWrappedRc: wrapped, priv: kp.privateKey };
}

export type UnlockResult = 'ok' | 'wrong-code' | 'no-history-key';

/** Unlock older DMs on this device: fetch the account's wrapped history key
 *  and open it with the recovery code. Nothing leaves the device. */
export async function unlockHistoryWithRecoveryCode(code: string): Promise<UnlockResult> {
    const wrap: { recovery_salt?: string | null; history_pubkey?: string | null; history_wrapped_rc?: string | null } =
        await apiClient.get('/keys/wrap');
    if (!wrap.history_wrapped_rc || !wrap.recovery_salt) return 'no-history-key';
    const priv = await unwrapKeyUnderRecovery(wrap.history_wrapped_rc, code, wrap.recovery_salt);
    if (!priv) return 'wrong-code';
    // The published public half must be the one this private key belongs to.
    if (wrap.history_pubkey && keypairFromPrivate(priv).publicKeyEncoded !== wrap.history_pubkey) return 'wrong-code';
    storeHistoryKey(priv);
    return 'ok';
}
