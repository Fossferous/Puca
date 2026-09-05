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
 *    else. A device that has been given the code holds it until sign-out, and
 *    can read every v4 message the account ever received or sent. A device
 *    signed in with only the password cannot — it sees new messages (wrapped
 *    to its session key) and a "locked" placeholder for older ones.
 *
 * That is the property this buys: a database copy plus a cracked password no
 * longer reads DM history. It is not per-message ratcheting; a stolen device
 * exposes what was wrapped to that device's session key for that session's
 * lifetime. The security model says exactly this.
 *
 * WHO SAYS WHICH KEYS ARE THEIRS. The server keeps the list of an account's
 * keys, but it does not get to write it: every published key carries a
 * signature by the account's Ed25519 signing key (deriveAccountSigningKey —
 * deterministic from the identity seed, so every device of the account signs
 * with the same key), over a record naming the key's role and value
 * (dmKeyRecord). A sender verifies each entry against that signing key and
 * wraps to NOTHING that fails, so a server that appends a "session" of its
 * own gets nothing (review 2026-09-05, finding C0).
 *
 * WHO VOUCHES FOR THE SIGNING KEY. Not the server, and not first sight: the
 * account attests its signing key to each contact under the PAIRWISE
 * IDENTITY SECRET — an HMAC keyed by X25519(my identity, their identity),
 * which only the two identity private keys can produce or check
 * (e2ee.ts dmSignAttestMac). Each client publishes that attestation when it
 * opens a conversation (ensureSignAttestation); the sender recomputes it
 * from the peer's PINNED identity key — the one the safety number covers —
 * and trusts the served signing key only when they agree. A server that
 * substitutes a signing key therefore fails the check, and the conversation
 * simply stays on v3 (which those same pinned identity keys protect). The
 * re-review of the first fix found that a bare trust-on-first-use pin on
 * the signing key gave a hostile server one silent shot per conversation at
 * upgrade time; this is what closed it.
 *
 * ROLLOUT. A sender emits v4 only when BOTH accounts have a history key and
 * every recently-seen session of both accounts has published a session key
 * and declared it can read v4 (`reads_up_to`). A 0.9.2 client does neither, so
 * its presence keeps the conversation on v3 — nothing an existing user has
 * installed can be sent a message it cannot open. That gate is computed by
 * the server, so a server can HOLD a conversation on v3; it cannot add a
 * reader to v4 (above), and v3 is what the pinned identity keys protect.
 *
 * STORAGE is scoped to the signed-in account: on a shared machine the next
 * account to sign in must never inherit — let alone adopt as its own — the
 * previous account's history key (finding C2).
 */
import { apiClient } from './client';
import {
    generateX25519Keypair, keypairFromPrivate, type X25519Keypair, type Identity,
    MAX_READABLE_ENVELOPE_VERSION, wrapKeyUnderRecovery, unwrapKeyUnderRecovery,
    getActiveIdentity, deriveAccountSigningKey, signWithAccountKey, verifyWithAccountKey,
    canonicalJson, type AccountSigningKey, dmSignAttestRecord, dmSignAttestMac, dmSignAttestMatches,
} from './e2ee';
import { resolvePinnedIdentityKey } from './keyVerification';

const SESSION_KEYS_BASE = 'puca_dm_session_keys';
const HISTORY_KEY_BASE = 'puca_dm_history_key';
const PUBLISHED_BASE = 'puca_dm_session_published';
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

function tokenClaims(): { sid: string; sub: string } {
    try {
        const token = localStorage.getItem('auth_token');
        if (!token) return { sid: '', sub: '' };
        const payload = token.split('.')[1] ?? '';
        const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
        const c = JSON.parse(json) as { sid?: unknown; sub?: unknown };
        return {
            sid: typeof c.sid === 'string' ? c.sid : '',
            sub: typeof c.sub === 'number' || typeof c.sub === 'string' ? String(c.sub) : '',
        };
    } catch {
        return { sid: '', sub: '' };
    }
}

/** The `sid` claim of the current bearer token, or '' for a token without one
 *  (a session predating migration 055; its first renewal mints an id). */
export function currentSessionId(): string {
    return tokenClaims().sid;
}

/** Storage key for the signed-in account. Without a token there is no
 *  account to scope to; such a read finds nothing, which is the safe answer. */
function scoped(base: string): string {
    const sub = tokenClaims().sub;
    return `${base}:${sub || 'anon'}`;
}

function readStored(): StoredSessionKey[] {
    try {
        const raw = localStorage.getItem(scoped(SESSION_KEYS_BASE));
        const list = raw ? (JSON.parse(raw) as StoredSessionKey[]) : [];
        return Array.isArray(list) ? list.filter(k => k && typeof k.priv === 'string' && typeof k.pub === 'string') : [];
    } catch {
        return [];
    }
}

function writeStored(list: StoredSessionKey[]): void {
    try { localStorage.setItem(scoped(SESSION_KEYS_BASE), JSON.stringify(list.slice(0, SESSION_KEYS_KEPT))); } catch { /* private mode */ }
}

/** Every session key this device still holds for the signed-in account, newest first. */
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

/** The history key if this device has unlocked it for the signed-in account
 *  (registration, or the recovery code entered here), else null. */
export function getHistoryKey(): X25519Keypair | null {
    try {
        const raw = localStorage.getItem(scoped(HISTORY_KEY_BASE));
        return raw ? keypairFromPrivate(fromB64(raw)) : null;
    } catch {
        return null;
    }
}

export function storeHistoryKey(priv: Uint8Array): void {
    try { localStorage.setItem(scoped(HISTORY_KEY_BASE), toB64(priv)); } catch { /* private mode */ }
}

/** Registration mints the history key BEFORE the account has a token, so it
 *  cannot be scoped to an account id yet: park it under the username, and
 *  adoptPendingHistoryKey moves it into place the moment that username signs
 *  in. Nothing else ever reads the pending slot, and sign-out clears it. */
export function storePendingHistoryKey(username: string, priv: Uint8Array): void {
    try { localStorage.setItem(`${HISTORY_KEY_BASE}:pending:${username.toLowerCase()}`, toB64(priv)); } catch { /* private mode */ }
}

/** Called by login() once the token is stored: the key registration parked
 *  for THIS username becomes this account's. Any other pending entry is left
 *  alone, so one account can never adopt another's. */
export function adoptPendingHistoryKey(username: string): void {
    try {
        const k = `${HISTORY_KEY_BASE}:pending:${username.toLowerCase()}`;
        const raw = localStorage.getItem(k);
        if (!raw || !tokenClaims().sub) return;
        localStorage.setItem(scoped(HISTORY_KEY_BASE), raw);
        localStorage.removeItem(k);
    } catch { /* private mode */ }
}

/** Sign-out: nothing that opens a message may outlive the session on a shared
 *  machine. Clears every account's entries, not just the current one — the
 *  token may already be gone by the time this runs, and a key left behind for
 *  any account is a key the next user of the machine holds. */
export function clearDmKeys(): void {
    try {
        const doomed: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith(SESSION_KEYS_BASE) || k.startsWith(HISTORY_KEY_BASE) || k.startsWith(PUBLISHED_BASE))) doomed.push(k);
        }
        for (const k of doomed) localStorage.removeItem(k);
    } catch { /* private mode */ }
    keysCache.clear();
    attested.clear();
    attestedAllThisRun = false;
}

/** All keys that could open a v4 message on this device: session keys, then
 *  the history key if unlocked. */
export function openingKeys(): X25519Keypair[] {
    const h = getHistoryKey();
    return h ? [...loadSessionKeys(), h] : loadSessionKeys();
}

// --- Signatures over published keys ---------------------------------------

export type DmKeyKind = 'session' | 'history';

/** The bytes an account signs to vouch for a key. The role is in the record
 *  so a history-key signature cannot be presented as a session-key one; the
 *  account is bound by the signing key itself (a record signed by A verifies
 *  only under A's pinned signing key), so nothing else needs to be. */
export function dmKeyRecord(kind: DmKeyKind, key: string): string {
    return canonicalJson({ t: kind === 'session' ? 'puca-dm-session-key-v1' : 'puca-dm-history-key-v1', k: key });
}

export function signDmKey(kind: DmKeyKind, key: string, signer: AccountSigningKey): string {
    return signWithAccountKey(signer, dmKeyRecord(kind, key));
}

/** The account signing key's public half, as published with every key. */
export function accountSignPubFor(identity: Identity): string {
    return deriveAccountSigningKey(identity).publicKeyEncoded;
}

function accountSignerNow(): AccountSigningKey | null {
    const identity = getActiveIdentity();
    return identity ? deriveAccountSigningKey(identity) : null;
}

/**
 * Make sure this session has a DM key and the server knows it. Idempotent —
 * called on every socket open (wireSessionDmKeyPublish), so a client that was
 * already signed in when it updated publishes on its first run. Needs the
 * identity to be unlocked (the key is signed with it); before that it simply
 * waits for the next open.
 */
export async function ensureSessionDmKeyPublished(): Promise<void> {
    const sid = currentSessionId();
    if (!sid) return; // no session id yet: the next token renewal mints one, and the next open publishes
    const signer = accountSignerNow();
    if (!signer) return; // identity not restored yet: the next open publishes
    const stored = readStored();
    let current = stored.find(k => k.sid === sid);
    if (!current) {
        mintSessionKey(sid);
        current = readStored().find(k => k.sid === sid);
        if (!current) return;
    }
    const stamp = `${sid}:${current.pub}`;
    let published: string | null = null;
    try { published = localStorage.getItem(scoped(PUBLISHED_BASE)); } catch { /* private mode */ }
    if (published === stamp) return;
    await apiClient.patch('/keys/session-dm', {
        dm_pubkey: current.pub,
        dm_pubkey_sig: signDmKey('session', current.pub, signer),
        account_sign_pub: signer.publicKeyEncoded,
        reads_up_to: MAX_READABLE_ENVELOPE_VERSION,
    });
    try { localStorage.setItem(scoped(PUBLISHED_BASE), stamp); } catch { /* private mode */ }
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
        void ensureSessionDmKeyPublished()
            .catch(e => console.warn('[dm-keys] publish deferred to the next connect:', e))
            .then(() => attestAllConversations());
    });
}

// --- What the server says about an account's keys, VERIFIED ---------------

/** What GET /users/:id/dm-keys returns. Data, not truth: every entry must
 *  verify under the account's signing key before it is a wrap target. */
export interface RawDmKeyInfo {
    account_sign_pub?: string | null;
    /** The account's attestation of that signing key to the caller (e2ee.ts dmSignAttestRecord). */
    attestation?: string | null;
    history?: { key?: unknown; sig?: unknown } | null;
    sessions?: Array<{ key?: unknown; sig?: unknown }>;
    all_sessions_v4?: unknown;
}

/** An account's keys after verification — the only form the send path sees. */
export interface DmKeyInfo {
    /** The history key, if the account has one AND it verified. */
    history_pubkey: string | null;
    /** Session keys of every recently-seen, unrevoked session that verified. */
    sessions: string[];
    /** Every recently-seen session has a session key and reads v4 (the
     *  server's word, which can only hold a conversation on v3). */
    all_sessions_v4: boolean;
    /** Entries the server listed that did NOT verify. Non-zero is either a
     *  server that is lying or a signing key that changed; either way none of
     *  them is wrapped to, and the send path logs it. */
    rejected: number;
}

/**
 * Verify a served key list against the signing key the caller resolved
 * (pinned for a peer, or our own for ourselves). `signPub` null means the
 * key could not be trusted at all — nothing verifies. Pure, so the rule is
 * unit-tested with hostile inputs.
 */
export function verifyDmKeyInfo(raw: RawDmKeyInfo, signPub: string | null): DmKeyInfo {
    const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    const rawHistory = raw.history && typeof raw.history === 'object' ? raw.history : null;
    const total = rawSessions.length + (rawHistory ? 1 : 0);
    if (!signPub) {
        return { history_pubkey: null, sessions: [], all_sessions_v4: false, rejected: total };
    }
    const ok = (kind: DmKeyKind, e: { key?: unknown; sig?: unknown } | null): string | null => {
        if (!e || typeof e.key !== 'string' || typeof e.sig !== 'string') return null;
        if (!e.key.startsWith('x25519:')) return null;
        return verifyWithAccountKey(signPub, dmKeyRecord(kind, e.key), e.sig) ? e.key : null;
    };
    const sessions = [...new Set(rawSessions.map(e => ok('session', e)).filter((k): k is string => k !== null))];
    const history = ok('history', rawHistory);
    const rejected = total - sessions.length - (history ? 1 : 0);
    return {
        history_pubkey: history,
        sessions,
        all_sessions_v4: raw.all_sessions_v4 === true,
        rejected,
    };
}

const keysCache = new Map<number, { at: number; info: DmKeyInfo }>();

/** Resolve the signing key to verify `userId`'s entries under: our own,
 *  compared to what we derive (a mismatch is a server lying about us); or a
 *  peer's, ONLY if the peer's attestation of it to us verifies under the
 *  pairwise identity secret computed from the peer's pinned identity key.
 *  Null means nothing is trusted and the conversation stays on v3. */
async function signingKeyFor(userId: number, served: string | null, attestation: string | null): Promise<string | null> {
    if (!served) return null;
    const mine = accountSignerNow();
    const me = tokenClaims().sub;
    if (String(userId) === me) {
        return mine && served === mine.publicKeyEncoded ? served : null;
    }
    const identity = getActiveIdentity();
    if (!identity || !me) return null;
    const peerIdentity = await resolvePinnedIdentityKey(userId);
    if (!peerIdentity) return null;
    const record = dmSignAttestRecord(userId, Number(me), served);
    return dmSignAttestMatches(identity, peerIdentity, record, attestation) ? served : null;
}

export async function dmKeysFor(userId: number): Promise<DmKeyInfo> {
    const hit = keysCache.get(userId);
    if (hit && Date.now() - hit.at < KEYS_CACHE_MS) return hit.info;
    const raw: RawDmKeyInfo = await apiClient.get(`/users/${userId}/dm-keys`);
    const served = typeof raw.account_sign_pub === 'string' ? raw.account_sign_pub : null;
    const attestation = typeof raw.attestation === 'string' ? raw.attestation : null;
    const info = verifyDmKeyInfo(raw, await signingKeyFor(userId, served, attestation));
    if (info.rejected > 0) {
        // Loud, because it is either a server inserting readers or a signing
        // key that changed under a pin — neither is routine.
        console.warn(`[dm-keys] ${info.rejected} key(s) served for user ${userId} did not verify under the account signing key and will not be wrapped to`);
    }
    keysCache.set(userId, { at: Date.now(), info });
    return info;
}

export function invalidateDmKeys(): void { keysCache.clear(); }

const attested = new Set<string>();

/**
 * Vouch, to the other participant of a conversation, for this account's
 * signing key: HMAC over dmSignAttestRecord(me, peer, my signing key) under
 * the pairwise identity secret, stored on the conversation row by the server
 * and checked by the peer before it trusts any signature of ours. Called
 * whenever a conversation is opened; once per (conversation, signing key)
 * per run, retried on the next open if the request failed. Needs the
 * identity and the peer's pinned identity key; without either it waits.
 */
export async function ensureSignAttestation(conversationId: string, peerUserId: number): Promise<void> {
    const identity = getActiveIdentity();
    const me = tokenClaims().sub;
    if (!identity || !me) return;
    const signer = deriveAccountSigningKey(identity);
    const stamp = `${conversationId}:${signer.publicKeyEncoded}`;
    if (attested.has(stamp)) return;
    const peerIdentity = await resolvePinnedIdentityKey(peerUserId);
    if (!peerIdentity) return;
    const mac = dmSignAttestMac(identity, peerIdentity, dmSignAttestRecord(Number(me), peerUserId, signer.publicKeyEncoded));
    if (!mac) return;
    try {
        await apiClient.patch(`/dms/${conversationId}/sign-attest`, { mac });
        attested.add(stamp);
    } catch (e) {
        console.warn('[dm-keys] signing-key attestation deferred to the next open:', e);
    }
}

let attestedAllThisRun = false;
/**
 * Attest to EVERY existing conversation once per run, on the first socket
 * open. Without this a contact could only send us v4 after we had opened
 * their conversation on a current client; with it, one start of the updated
 * app is enough. Best effort and sequential; ensureSignAttestation makes
 * repeats free and Chat still attests on open, which covers conversations
 * that appear later.
 */
export async function attestAllConversations(): Promise<void> {
    if (attestedAllThisRun) return;
    if (!getActiveIdentity() || !tokenClaims().sub) return; // next open, once the identity is restored
    attestedAllThisRun = true;
    let list: Array<{ id?: unknown; other_user_id?: unknown }> = [];
    try {
        const raw: unknown = await apiClient.get('/dms');
        list = Array.isArray(raw) ? raw : [];
    } catch (e) {
        attestedAllThisRun = false;
        console.warn('[dm-keys] could not list conversations to attest; next open:', e);
        return;
    }
    for (const c of list) {
        if (typeof c.id === 'string' && typeof c.other_user_id === 'number') {
            // One bad contact must not abort the pass for everyone after it.
            try { await ensureSignAttestation(c.id, c.other_user_id); } catch (e) { console.warn('[dm-keys] attestation skipped for one conversation:', e); }
        }
    }
}

/**
 * May a v4 envelope be sent between these two accounts right now? Pure, so
 * the rule is unit-testable: both have a (verified) history key; both have at
 * least one (verified) recent session (an account nobody has opened in
 * RECENT_SESSION_DAYS gets v3, so that when its owner comes back with only a
 * password they can still read what arrived); and every recent session of
 * both can open v4 — one 0.9.2 client on either side keeps the conversation
 * on v3.
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

export interface HistoryKeyMaterial { historyPubkey: string; historyWrappedRc: string; historyPubkeySig: string; priv: Uint8Array }

/** A fresh history key for an account, wrapped under its recovery code and
 *  vouched for by the account's signing key. Used at registration and when
 *  the recovery code is regenerated. */
export async function newHistoryKeyMaterial(recoveryCode: string, recoverySaltB64: string, identity: Identity): Promise<HistoryKeyMaterial> {
    const kp = generateX25519Keypair();
    return finishHistoryMaterial(kp, recoveryCode, recoverySaltB64, identity);
}

/** Re-wrap an EXISTING history key under a new recovery code (regeneration). */
export async function rewrapHistoryKey(priv: Uint8Array, recoveryCode: string, recoverySaltB64: string, identity: Identity): Promise<HistoryKeyMaterial> {
    return finishHistoryMaterial(keypairFromPrivate(priv), recoveryCode, recoverySaltB64, identity);
}

async function finishHistoryMaterial(kp: X25519Keypair, recoveryCode: string, recoverySaltB64: string, identity: Identity): Promise<HistoryKeyMaterial> {
    const wrapped = await wrapKeyUnderRecovery(kp.privateKey, recoveryCode, recoverySaltB64);
    if (!wrapped) throw new Error('could not wrap the history key under the recovery code');
    const sig = signDmKey('history', kp.publicKeyEncoded, deriveAccountSigningKey(identity));
    return { historyPubkey: kp.publicKeyEncoded, historyWrappedRc: wrapped, historyPubkeySig: sig, priv: kp.privateKey };
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
