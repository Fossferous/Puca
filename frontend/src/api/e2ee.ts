/**
 * End-to-End Encryption Core (v2)
 * ================================
 *
 * Design goals (see also docs/E2EE.md):
 *
 *  - **Password-derived identity keys.** A user's X25519 identity keypair is
 *    derived deterministically from their password + a per-user salt via
 *    PBKDF2-SHA256. The same password on any device yields the same keys, so a
 *    user can read their history anywhere and the server never stores anything
 *    that can decrypt messages. The password itself never leaves the device
 *    (SRP already guarantees that for auth).
 *
 *  - **DMs** use pairwise ECDH: `shared = X25519(myPriv, theirPub)`, which both
 *    participants compute identically. HKDF-SHA256 turns it into an AES-256-GCM
 *    key. This is symmetric and needs no server-side key exchange.
 *
 *  - **Channels (groups)** use a per-channel symmetric "channel key" (CK). Each
 *    message is AES-256-GCM encrypted under the CK for a given *epoch*. The CK
 *    is distributed to each member by wrapping it: the distributor derives a
 *    key-encryption key via X25519(distributorPriv, memberPub) and AES-GCM
 *    encrypts the CK. On membership change a new epoch CK is generated and
 *    re-wrapped, so removed members cannot read future messages.
 *
 * The server only ever sees ciphertext and wrapped-key blobs — never the CK,
 * the identity private keys, or plaintext.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { isUndecryptable } from './decryptMarkers';

// --- Constants ---

/** Public keys are stored/transmitted with this prefix to distinguish the
 *  scheme version from the legacy P-256 keys. */
const PUBKEY_PREFIX = 'x25519:';
/** PBKDF2 iteration count for identity derivation. */
const KDF_ITERATIONS = 210_000;
const HKDF_DM_INFO = utf8('sovereign-dm-v2');
const HKDF_WRAP_INFO = utf8('sovereign-wrap-v2');
const E2EE_SALT_DOMAIN = utf8('sovereign-e2ee-v2');
/** HKDF info for the self-storage key (personal task lists, private notes). */
const HKDF_SELF_INFO = utf8('sovereign-self-v1');
/** HKDF info for a device's LAN details (MAC / subnet / broadcast).
 *
 *  Separate from the self key so a compromise of one does not read the other,
 *  and because these serve different purposes: the self key protects content
 *  the user wrote, this protects a map of their home network. The server has no
 *  business holding MAC addresses and internal IPs, and encrypting them costs
 *  nothing because every device that needs them already holds the seed. */
const HKDF_DEVICE_LAN_INFO = utf8('sovereign-device-lan-v1');

// --- v3 recoverable key custody ---
/** Legacy PBKDF2 iteration count for wrap KEKs made before the 2026 bump, and
 *  the assumed count for any stored blob that predates `pw_kdf_iterations`. */
const WRAP_KDF_ITERATIONS_LEGACY = 210_000;
/** Current PBKDF2 iterations for the PASSWORD wrap KEK — OWASP 2026 floor for
 *  PBKDF2-SHA256. Raised from the legacy 210k; blobs upgrade transparently on
 *  login (unwrap at their stored count, re-wrap at this one). The recovery-code
 *  KEK deliberately stays at the legacy count — its input is a 128-bit phrase,
 *  so more iterations add nothing there. */
const WRAP_KDF_ITERATIONS = 600_000;

/** Which KDF a password wrap uses. Absent/`'pbkdf2'` = legacy PBKDF2-SHA256 at
 *  the stored iteration count; `'argon2id'` = memory-hard Argon2id at the fixed
 *  ARGON2_* params below (its `pwKdfIterations` field is an ignored placeholder).
 *  Argon2id is memory-hard, so it collapses the GPU/ASIC guess rate that makes
 *  PBKDF2 cheap to attack offline — the current target for new + upgraded wraps. */
export type PwKdf = 'pbkdf2' | 'argon2id';
const PW_KDF_ARGON2: PwKdf = 'argon2id';
const PW_KDF_PBKDF2: PwKdf = 'pbkdf2';
/** Argon2id parameters for the password wrap KEK. m=19 MiB, t=2, p=1 — the
 *  OWASP 2026 minimum for Argon2id; ~0.4 s in-process, fine for a one-time
 *  login/register op. Fixed on the CLIENT (never server-supplied), so a poisoned
 *  server value can't drive them — safer than the PBKDF2 count, which is. If
 *  these ever change, bump to a param-carrying scheme; for now the tag alone
 *  identifies the wrap. */
const ARGON2_M = 19_456; // KiB (19 MiB)
const ARGON2_T = 2;
const ARGON2_P = 1;
/** In-range placeholder stored in `pwKdfIterations` for argon2 wraps (that field
 *  is meaningless for argon2, but keeping it in the PBKDF2-valid range avoids a
 *  server-side validation special-case). */
const ARGON2_ITERS_PLACEHOLDER = WRAP_KDF_ITERATIONS;

/** HKDF info for the ACCOUNT signing key — the root of device enrolment.
 *
 *  X25519 cannot sign, so device records need a signing key. Deriving it from
 *  the same seed means it needs no new custody, no new recovery path, and no
 *  server round-trip: every device of the account reconstructs the same key
 *  (and, crucially, the same PUBLIC key) from material it already holds.
 *
 *  That last part is what makes enrolment unforgeable. A verifier derives the
 *  expected signing public key from its OWN seed and never fetches it from the
 *  server, so a device record the server invented fails verification.
 *
 *  Domain-separated from the X25519 use of the same seed — never hand identical
 *  bytes to two algorithms. */
const HKDF_ACCOUNT_SIGN_INFO = utf8('sovereign-account-sign-v1');
/** Prefix for Ed25519 public keys, mirroring PUBKEY_PREFIX for X25519. */
const SIGN_PUBKEY_PREFIX = 'ed25519:';

/** HKDF info for the reset proof-of-possession key (see recovery flow). */
const HKDF_RECOVERY_PROOF_INFO = utf8('sovereign-recovery-proof-v1');
/** Recovery mnemonic entropy in bits → 12 BIP39 words. */
const RECOVERY_ENTROPY_BITS = 128;

// --- Types ---

export interface Identity {
    /** 32-byte X25519 private scalar (secret). */
    privateKey: Uint8Array;
    /** 32-byte X25519 public key. */
    publicKey: Uint8Array;
    /** Public key as a prefixed base64 string, for the server. */
    publicKeyEncoded: string;
}

/** A channel key wrapped for a single recipient. */
export interface WrappedChannelKey {
    recipientId: number;
    /** base64( nonce || ciphertext ) of the wrapped CK. */
    wrappedKey: string;
    /** The distributor's public key (prefixed base64), needed to unwrap. */
    senderPublicKey: string;
}

/** Envelope stored in a message's `content` field. */
export interface Envelope {
    /** 2 = the original format (no associated data). 3 = context-bound:
     *  the AES-GCM tag also covers an AAD string naming the channel, epoch
     *  and sender (or DM sender and recipient), recomputed by the reader
     *  from the row's own metadata. Same JSON shape; only `v` changes. */
    v: 2 | 3;
    /** "dm" for pairwise, "ch" for channel/group, "self" for encrypt-to-self. */
    t: 'dm' | 'ch' | 'self';
    /** Channel key epoch (channel messages only). */
    epoch?: number;
    /** base64( nonce || ciphertext ). */
    ct: string;
}

/**
 * Thrown by the encrypt-before-send paths when a message CANNOT be encrypted
 * securely — missing identity, an unavailable/withheld recipient key, a pinned
 * key that changed / failed verification, or no channel key yet. Callers MUST
 * surface `.message` to the user and abort the send: the E2EE contract is
 * fail-closed, so we never silently fall back to plaintext (a malicious server
 * that withholds or substitutes a key must break the send, not downgrade it).
 */
export class SecureSendError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecureSendError';
    }
}

// --- Small utilities ---

function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
    return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

/** Encode a raw X25519 public key as a prefixed base64 string. */
export function encodePublicKey(publicKey: Uint8Array): string {
    return PUBKEY_PREFIX + toBase64(publicKey);
}

/** Decode a prefixed public key. Returns null if it is not a v2 key. */
export function decodePublicKey(encoded: string | null | undefined): Uint8Array | null {
    if (!encoded || !encoded.startsWith(PUBKEY_PREFIX)) return null;
    try {
        return fromBase64(encoded.slice(PUBKEY_PREFIX.length));
    } catch {
        return null;
    }
}

// --- Identity derivation ---

/**
 * Deterministically derive a user's X25519 identity keypair from their password
 * and SRP salt. The SRP salt is domain-separated so this KDF output can never
 * collide with the SRP verifier computation that uses the same salt.
 */
export async function deriveIdentity(password: string, srpSaltHex: string): Promise<Identity> {
    const srpSalt = hexToBytes(srpSaltHex);
    // Domain-separated salt: sha256("sovereign-e2ee-v2" || srpSalt)
    const e2eeSalt = sha256(concat(E2EE_SALT_DOMAIN, srpSalt));
    const seed = pbkdf2(sha256, utf8(password), e2eeSalt, { c: KDF_ITERATIONS, dkLen: 32 });
    const publicKey = x25519.getPublicKey(seed);
    return {
        privateKey: seed,
        publicKey,
        publicKeyEncoded: encodePublicKey(publicKey),
    };
}

// --- AES-256-GCM (via Web Crypto) ---

/**
 * Import cache, keyed on the raw-key OBJECT. Long-lived keys (a control
 * session seals every input event with the same Uint8Array — dozens of times
 * a second) import once instead of paying two WebCrypto promise hops per
 * event per side. Keys derived fresh per call (DM messages) miss the cache
 * and behave exactly as before; WeakMap keeps a dead session's key
 * collectable. The PROMISE is cached, not the key, so concurrent first uses
 * share one import instead of racing.
 */
const aesKeyCache = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    let p = aesKeyCache.get(raw);
    if (!p) {
        p = crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
        aesKeyCache.set(raw, p);
    }
    return p;
}

/** Encrypt with a raw 32-byte key. Output: base64( nonce(12) || ciphertext ).
 *  `aad`, when given, is bound into the GCM tag and must be presented again
 *  to decrypt; absent, this is byte-for-byte the v2 primitive. */
async function aesEncrypt(rawKey: Uint8Array, plaintext: string, aad?: Uint8Array): Promise<string> {
    const key = await importAesKey(rawKey);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const params: AesGcmParams = { name: 'AES-GCM', iv: nonce as BufferSource };
    if (aad) params.additionalData = aad as BufferSource;
    const ct = await crypto.subtle.encrypt(params, key, utf8(plaintext) as BufferSource);
    return toBase64(concat(nonce, new Uint8Array(ct)));
}

async function aesDecrypt(rawKey: Uint8Array, blobB64: string, aad?: Uint8Array): Promise<string> {
    const key = await importAesKey(rawKey);
    const blob = fromBase64(blobB64);
    const nonce = blob.slice(0, 12);
    const ct = blob.slice(12);
    const params: AesGcmParams = { name: 'AES-GCM', iv: nonce as BufferSource };
    if (aad) params.additionalData = aad as BufferSource;
    const pt = await crypto.subtle.decrypt(params, key, ct as BufferSource);
    return new TextDecoder().decode(pt);
}

// --- v3 context binding (associated data) ---
//
// v2 envelopes authenticate the bytes but not WHERE they belong: a channel
// message is sealed under a key every member holds, so `messages.user_id` is a
// pure server assertion (rewrite it and the message decrypts under someone
// else's name); the pairwise DM key is the same in both directions, so
// flipping `dm_messages.sender_id` re-attributes a DM with no cryptographic
// consequence; a channel checklist item and a channel message share a key and
// an envelope type, so one can be moved into the other; and the epoch in the
// envelope is a plaintext label the reader trusts to pick a key.
//
// v3 puts that context into the AES-GCM associated data. The reader RECOMPUTES
// it from the row's own metadata (channel id, sender id, epoch; DM sender and
// recipient), so any of those edits makes the tag fail — with a distinct
// marker, and with no retry under other context, which would turn the tag
// into an oracle. The JSON shape is unchanged; only `v` moves.
//
// What v3 does NOT buy: replay and reorder. A message id does not exist at
// encrypt time (the server mints it) and timestamps are server-assigned, so
// neither can be bound; that needs a sender-chosen sequence in the plaintext,
// which is separate work. Self envelopes, key wraps, seed wraps and control
// frames stay v2 on purpose: self content has an unresolved notes/list
// duality, a wrap flip locks un-updated clients out of a whole channel, the
// seed wrap's real weakness is KDF downgrade (an algorithm ratchet, not AAD),
// and control frames have a native twin in puca-agent that would need a
// lockstep two-language deploy.
//
// Byte layout: UTF-8 of an ASCII string, fixed field order, '/'-separated,
// every field either a token from a closed set or a non-negative integer
// rendered by String(n) — checked, so the grammar needs no escaping.

/** Emit v3 (context-bound) envelopes for channel messages and DMs.
 *
 *  ON since 0.8.136. 0.8.135 shipped the reader alone (this was false) so
 *  that every client could READ v3 before any client WROTE it. A client that
 *  predates 0.8.135 has no notion of v3: its parser returns null, so it
 *  renders a v3 body as the raw envelope JSON with the "Not encrypted"
 *  badge until it updates. It cannot overwrite it: since 0.8.136 the server
 *  refuses an edit that would replace a body with an OLDER envelope version
 *  (src/envelope_version.rs), so the ciphertext stays intact and opens once
 *  the client updates. The reader accepts both, forever. */
export const EMIT_ENVELOPE_V3 = true;

/** The highest envelope version this build can OPEN. Sent as `reads_up_to`
 *  on every edit that replaces a sealed body, so the server can tell a
 *  reader-first client (reads v(N+1), still writes vN — a legitimate edit)
 *  from a stale one that would re-seal raw JSON over the ciphertext (refused).
 *  Bump this with parseEnvelopeEx's accepted versions, never ahead of them. */
export const MAX_READABLE_ENVELOPE_VERSION = 3;

const AAD_PREFIX = 'puca/v3/';

function aadInt(n: number, what: string): string {
    if (!Number.isSafeInteger(n) || n < 0) {
        // SecureSendError so the composer shows "can't send securely" rather than an
        // unhandled rejection; on the read side every caller catches into a marker.
        throw new SecureSendError(`E2EE context: ${what} must be a non-negative integer, got ${String(n)}`);
    }
    return String(n);
}

/** Which channel-keyed thing this is. A checklist item must not open as a
 *  message, nor an attachment sidecar as a description. */
export type ChannelAadKind = 'chan-msg' | 'chan-task' | 'chan-taskatt';

export interface ChannelContext {
    kind: ChannelAadKind;
    channelId: number;
    /** The message's author, or the task's CREATOR (`created_by`) — never the
     *  editor: a manager may edit another member's item, and the reader only
     *  has `created_by` to recompute with. */
    senderId: number;
}

export interface DmContext {
    senderId: number;
    recipientId: number;
}

const CHANNEL_AAD_KINDS: ReadonlySet<string> = new Set(['chan-msg', 'chan-task', 'chan-taskatt']);

export function channelAad(ctx: ChannelContext, epoch: number): Uint8Array {
    // The type says the kind is one of three tokens; the runtime check makes
    // the grammar's no-escaping argument hold even for an `as never` caller.
    if (!CHANNEL_AAD_KINDS.has(ctx.kind)) throw new SecureSendError(`E2EE context: unknown kind ${String(ctx.kind)}`);
    return utf8(`${AAD_PREFIX}${ctx.kind}/${aadInt(ctx.channelId, 'channelId')}/${aadInt(epoch, 'epoch')}/${aadInt(ctx.senderId, 'senderId')}`);
}

/** Directional: `dm/<sender>/<recipient>`. The pairwise key is symmetric, so
 *  the direction is exactly what the key itself does not authenticate. */
export function dmAad(ctx: DmContext): Uint8Array {
    return utf8(`${AAD_PREFIX}dm/${aadInt(ctx.senderId, 'senderId')}/${aadInt(ctx.recipientId, 'recipientId')}`);
}

// --- Key agreement ---

/** Derive a 32-byte symmetric key from an X25519 shared secret via HKDF. */
function deriveSymmetricKey(sharedSecret: Uint8Array, info: Uint8Array): Uint8Array {
    return hkdf(sha256, sharedSecret, undefined, info, 32);
}

// --- DM (pairwise) crypto ---

/**
 * Encrypt a DM for a recipient. Both parties derive the same key from
 * X25519(myPriv, theirPub), so the recipient decrypts with the mirror call.
 */
export async function encryptDM(
    identity: Identity,
    recipientPublicKeyEncoded: string,
    plaintext: string,
    ctx: DmContext,
): Promise<Envelope | null> {
    return sealDmEnvelope(identity, recipientPublicKeyEncoded, plaintext, ctx, EMIT_ENVELOPE_V3 ? 3 : 2);
}

/** The DM seal with an explicit version. The default producer follows
 *  EMIT_ENVELOPE_V3; tests reach the frozen v2 format (and v3 explicitly)
 *  through this. `ctx` is required for both versions. */
export async function sealDmEnvelope(
    identity: Identity,
    recipientPublicKeyEncoded: string,
    plaintext: string,
    ctx: DmContext,
    version: 2 | 3,
): Promise<Envelope | null> {
    const recipientPub = decodePublicKey(recipientPublicKeyEncoded);
    if (!recipientPub) return null;
    const shared = x25519.getSharedSecret(identity.privateKey, recipientPub);
    const key = deriveSymmetricKey(shared, HKDF_DM_INFO);
    if (version === 3) return { v: 3, t: 'dm', ct: await aesEncrypt(key, plaintext, dmAad(ctx)) };
    return { v: 2, t: 'dm', ct: await aesEncrypt(key, plaintext) };
}

export async function decryptDM(
    identity: Identity,
    senderPublicKeyEncoded: string,
    envelope: Envelope,
    ctx: DmContext,
): Promise<string | null> {
    const senderPub = decodePublicKey(senderPublicKeyEncoded);
    if (!senderPub) return null;
    try {
        const shared = x25519.getSharedSecret(identity.privateKey, senderPub);
        const key = deriveSymmetricKey(shared, HKDF_DM_INFO);
        return await aesDecrypt(key, envelope.ct, envelope.v === 3 ? dmAad(ctx) : undefined);
    } catch {
        return null;
    }
}

// --- P2P file-offer authentication ---
//
// A "peer-to-peer" file transfer negotiates over the SERVER-relayed control
// plane: the offer (sha256, size, name) and the WebRTC SDP both pass through
// the server. A malicious operator can therefore substitute the offered hash
// and MITM the DTLS, and the receiver's own hash check passes — because it is
// checking against the hash the MITM supplied. The fix binds the offer to the
// two peers' PINNED identity keys with a MAC the server cannot forge.
//
// We MAC with a key derived from the DM shared secret X25519(myPriv, peerPub)
// — the same secret that already protects the pair's DMs, known only to the two
// of them — rather than an Ed25519 signature: no per-user signing key is
// published to verify against, whereas both sides already TOFU-pin each other's
// X25519 key (resolvePinnedIdentityKey), so this reuses the trust anchor that
// exists. A distinct HKDF info keeps this key separate from the DM message key.

const HKDF_FILE_OFFER_AUTH_INFO = utf8('sovereign-file-offer-auth-v1');

/**
 * Derive the symmetric key that authenticates a file offer between us and a
 * peer, from the DM shared secret. Returns null if the peer key is unusable
 * (e.g. a pin failure already handed us null). Both peers derive the SAME key:
 * the sender from `X25519(myPriv, receiverPub)`, the receiver from
 * `X25519(myPriv, senderPub)`.
 */
export function deriveFileOfferAuthKey(
    identity: Identity,
    peerPublicKeyEncoded: string,
): Uint8Array | null {
    const peerPub = decodePublicKey(peerPublicKeyEncoded);
    if (!peerPub) return null;
    const shared = x25519.getSharedSecret(identity.privateKey, peerPub);
    return hkdf(sha256, shared, undefined, HKDF_FILE_OFFER_AUTH_INFO, 32);
}

/** MAC (base64) over a canonical offer record with a file-offer auth key. */
export function authenticateFileOffer(authKey: Uint8Array, record: string): string {
    return toBase64(hmac(sha256, authKey, utf8(record)));
}

/**
 * Verify a file-offer MAC in constant time. Returns false for every malformed
 * input rather than throwing — a caller uses this to decide whether to TRUST a
 * server-relayed offer, so it must fail closed, not open.
 */
export function verifyFileOffer(authKey: Uint8Array, record: string, tagB64: string): boolean {
    try {
        const expected = hmac(sha256, authKey, utf8(record));
        const got = fromBase64(tagB64);
        if (got.length !== expected.length) return false;
        let diff = 0;
        for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ got[i];
        return diff === 0;
    } catch {
        return false;
    }
}

// --- Self (single-user) crypto ---
//
// For data only its owner ever reads (personal task lists, private notes).
// The symmetric key is derived straight from the identity secret via HKDF
// with a dedicated info string, so it needs no key exchange, follows the
// identity through v3 password changes, and can never collide with the DM
// or wrap keys.

/** Encrypt data for the owner's own eyes. */
export async function encryptSelf(identity: Identity, plaintext: string): Promise<Envelope> {
    const key = hkdf(sha256, identity.privateKey, undefined, HKDF_SELF_INFO, 32);
    return { v: 2, t: 'self', ct: await aesEncrypt(key, plaintext) };
}

export async function decryptSelf(identity: Identity, envelope: Envelope): Promise<string | null> {
    try {
        const key = hkdf(sha256, identity.privateKey, undefined, HKDF_SELF_INFO, 32);
        return await aesDecrypt(key, envelope.ct);
    } catch {
        return null;
    }
}

// --- Channel (group) crypto ---

/** Generate a fresh random 32-byte channel key. */
export function generateChannelKey(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Wrap a channel key for a set of members. The distributor derives a
 * key-encryption key per member via X25519 and AES-GCM encrypts the CK.
 */
export async function wrapChannelKeyForMembers(
    identity: Identity,
    channelKey: Uint8Array,
    members: { userId: number; publicKey: string }[]
): Promise<WrappedChannelKey[]> {
    const out: WrappedChannelKey[] = [];
    for (const m of members) {
        const memberPub = decodePublicKey(m.publicKey);
        if (!memberPub) continue; // member has no v2 key yet; skip
        const shared = x25519.getSharedSecret(identity.privateKey, memberPub);
        const kek = deriveSymmetricKey(shared, HKDF_WRAP_INFO);
        const wrapped = await aesEncrypt(kek, toBase64(channelKey));
        out.push({
            recipientId: m.userId,
            wrappedKey: wrapped,
            senderPublicKey: identity.publicKeyEncoded,
        });
    }
    return out;
}

/** Unwrap a channel key that was wrapped for us. */
export async function unwrapChannelKey(
    identity: Identity,
    wrapped: WrappedChannelKey
): Promise<Uint8Array | null> {
    const senderPub = decodePublicKey(wrapped.senderPublicKey);
    if (!senderPub) return null;
    try {
        const shared = x25519.getSharedSecret(identity.privateKey, senderPub);
        const kek = deriveSymmetricKey(shared, HKDF_WRAP_INFO);
        const ckB64 = await aesDecrypt(kek, wrapped.wrappedKey);
        return fromBase64(ckB64);
    } catch {
        return null;
    }
}

export async function encryptChannelMessage(
    channelKey: Uint8Array,
    epoch: number,
    plaintext: string,
    ctx: ChannelContext,
): Promise<Envelope> {
    return sealChannelEnvelope(channelKey, epoch, plaintext, ctx, EMIT_ENVELOPE_V3 ? 3 : 2);
}

/** The channel seal with an explicit version (see sealDmEnvelope). */
export async function sealChannelEnvelope(
    channelKey: Uint8Array,
    epoch: number,
    plaintext: string,
    ctx: ChannelContext,
    version: 2 | 3,
): Promise<Envelope> {
    if (version === 3) return { v: 3, t: 'ch', epoch, ct: await aesEncrypt(channelKey, plaintext, channelAad(ctx, epoch)) };
    return { v: 2, t: 'ch', epoch, ct: await aesEncrypt(channelKey, plaintext) };
}

export async function decryptChannelMessage(
    channelKey: Uint8Array,
    envelope: Envelope,
    ctx: ChannelContext,
): Promise<string | null> {
    try {
        // v3 binds the epoch the ENVELOPE carries — the value the reader
        // used to pick this key — so a relabelled epoch fails the tag
        // instead of silently redirecting key selection.
        return await aesDecrypt(channelKey, envelope.ct, envelope.v === 3 ? channelAad(ctx, envelope.epoch ?? 0) : undefined);
    } catch {
        return null;
    }
}

// --- Remote-control channel crypto (per-session, authenticated) ---
//
// Remote-control input (mouse + KEYSTROKES) is relayed through the server. To
// keep the server from reading keystrokes or forging/replaying injected input,
// each control event is AEAD-sealed under a PER-SESSION key derived from TWO
// Diffie-Hellman exchanges (an X3DH-lite / Noise-KK-style construction):
//
//   ephSs    = X25519(myEphemeralPriv, peerEphemeralPub)   // fresh each session
//   staticSs = X25519(myIdentityPriv,  peerIdentityPub)    // authenticates peer
//   key      = HKDF-SHA256(ikm = ephSs || staticSs, info = "sovereign-control-v2")
//
// The ephemeral half makes every session's key unique — so a server cannot
// replay frames recorded from one session into another, and cross-role
// reflection (A controls B while B controls A) fails because the two sessions
// have different ephemeral keys. The static half authenticates the peer: the
// server holds no identity private key, so even if it swaps the ephemeral keys
// it cannot derive the session key (it only breaks the session — fail closed).
// Both DH outputs are symmetric, so host and viewer derive the identical key.
// Peer identity-key AUTHENTICITY still rests on the server-served public key
// (as DMs do) — the caller TOFU-pins it to catch later substitution.
//
// A monotonic sequence number sealed INSIDE each payload gives intra-session
// replay/reorder protection.

const CONTROL_KDF_LABEL = 'sovereign-control-v2';

export interface ControlEphemeral {
    /** 32-byte ephemeral X25519 private scalar (kept locally for the session). */
    priv: Uint8Array;
    /** Ephemeral public key, "x25519:"-prefixed base64, sent to the peer. */
    pubEncoded: string;
}

/** Generate a fresh ephemeral X25519 keypair for one control session. */
export function generateControlEphemeral(): ControlEphemeral {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const pub = x25519.getPublicKey(priv);
    return { priv, pubEncoded: encodePublicKey(pub) };
}

/**
 * Derive the per-session control key from the ephemeral + static DH exchanges.
 * Returns null if either peer key is not a valid v2 key.
 */
export function deriveControlSessionKey(
    myIdentityPriv: Uint8Array,
    peerIdentityPubEncoded: string,
    myEphemeralPriv: Uint8Array,
    peerEphemeralPubEncoded: string,
): Uint8Array | null {
    const peerStatic = decodePublicKey(peerIdentityPubEncoded);
    const peerEph = decodePublicKey(peerEphemeralPubEncoded);
    if (!peerStatic || !peerEph) return null;
    try {
        // A low-order / all-zero peer point yields a zero shared secret, which
        // noble rejects by THROWING — catch it so callers get null and fail
        // closed (a malicious relay can substitute the relayed ephemeral).
        const ephSs = x25519.getSharedSecret(myEphemeralPriv, peerEph);
        const staticSs = x25519.getSharedSecret(myIdentityPriv, peerStatic);
        // Bind BOTH ephemeral public keys (sorted, so both sides agree) into the
        // KDF: the key commits to this exact handshake transcript — defence in
        // depth beyond ephemeral freshness (unknown-key-share / reuse).
        const myEphPub = encodePublicKey(x25519.getPublicKey(myEphemeralPriv));
        const [a, b] = [myEphPub, peerEphemeralPubEncoded].sort();
        const info = utf8(`${CONTROL_KDF_LABEL}|${a}|${b}`);
        return hkdf(sha256, concat(ephSs, staticSs), undefined, info, 32);
    } catch {
        return null;
    }
}

/** Label for DEVICE-to-device control sessions.
 *
 *  Deliberately NOT `sovereign-control-v2`. Both handshakes have the same
 *  shape, so reusing the label would let a session key negotiated for the
 *  voice-room "let a friend drive my game" feature be valid in a
 *  device-control session and vice versa — a cross-protocol reflection where
 *  the two have very different authorization (one needs a shared voice room and
 *  a human clicking Allow; the other needs a host-signed grant). Different
 *  label, different key, no crossover. */
const DEVICE_CONTROL_KDF_LABEL = 'sovereign-device-control-v1';

/**
 * Per-session key for controlling one of YOUR OWN devices.
 *
 * Same construction as `deriveControlSessionKey` — ephemeral DH for forward
 * secrecy, static DH to authenticate the peer, both ephemerals bound into the
 * transcript — with two differences that matter:
 *
 *  1. A different KDF label (see above), so the two protocols cannot cross.
 *  2. The static half uses the DEVICE keys, not the account identity key. This
 *     is the whole point: between two devices of one account the identity keys
 *     are IDENTICAL, so a static DH over them degenerates into self-DH and
 *     authenticates nothing. Device keys are per-machine, so the static half
 *     actually proves which machine is at the other end.
 *
 * The device static DH is computed natively (the device private key never
 * enters JS), so this takes the already-computed shared secret.
 */
export function deriveDeviceControlKey(
    deviceStaticSharedSecret: Uint8Array,
    myEphemeralPriv: Uint8Array,
    peerEphemeralPubEncoded: string,
): Uint8Array | null {
    const peerEph = decodePublicKey(peerEphemeralPubEncoded);
    if (!peerEph) return null;
    try {
        const ephSs = x25519.getSharedSecret(myEphemeralPriv, peerEph);
        const myEphPub = encodePublicKey(x25519.getPublicKey(myEphemeralPriv));
        const [a, b] = [myEphPub, peerEphemeralPubEncoded].sort();
        const info = utf8(`${DEVICE_CONTROL_KDF_LABEL}|${a}|${b}`);
        return hkdf(sha256, concat(ephSs, deviceStaticSharedSecret), undefined, info, 32);
    } catch {
        return null;
    }
}

// --- Media (WebRTC voice + screen share) key ---
//
// Mesh WebRTC is pairwise, so each peer connection encrypts frames under a key
// derived from the two users' identity keys — X25519 + HKDF, domain-separated
// from DM/control/etc. Both peers derive the same 32-byte key. (Per-frame
// AES-GCM lives in api/rtc/mediaCrypto; this is just the key.)
const HKDF_MEDIA_INFO = utf8('sovereign-media-v1');

/** Derive the pairwise media key from my identity + the peer's identity pubkey. */
export function deriveMediaKey(identity: Identity, peerPublicKeyEncoded: string): Uint8Array | null {
    const peerPub = decodePublicKey(peerPublicKeyEncoded);
    if (!peerPub) return null;
    const shared = x25519.getSharedSecret(identity.privateKey, peerPub);
    return deriveSymmetricKey(shared, HKDF_MEDIA_INFO);
}

/**
 * A capability tag advertised (in the SDP) that BINDS the sender's per-call
 * ephemeral public key: HMAC over (label || ephPub) under the STATIC pairwise
 * media key. The peer verifies by recomputing over the ephemeral it received —
 * so if the server tampers with the ephemeral, the tag won't match and E2EE
 * simply doesn't enable (transport-only; never broken media). The server can't
 * forge the tag (no static key) or cross-inject it (the key is pairwise), and
 * producing it proves the sender holds the identity-derived key.
 */
export function mediaReadyTag(rawStaticMediaKey: Uint8Array, ephemeralPubEncoded: string): string {
    return toBase64(hmac(sha256, rawStaticMediaKey, concat(utf8('sovereign-media-ready-v1|'), utf8(ephemeralPubEncoded))));
}

/**
 * Per-call media session key with forward secrecy: HKDF over an ephemeral DH
 * (fresh per connection) plus the static identity DH. The static half keeps
 * confidentiality even if the server tampers with the ephemeral (it holds no
 * identity private key); the ephemeral half means a later identity-key
 * compromise can't decrypt past recorded calls. Both peers derive the same key.
 */
export function deriveMediaSessionKey(
    myIdentityPriv: Uint8Array,
    peerIdentityPubEncoded: string,
    myEphemeralPriv: Uint8Array,
    peerEphemeralPubEncoded: string,
): Uint8Array | null {
    const peerStatic = decodePublicKey(peerIdentityPubEncoded);
    const peerEph = decodePublicKey(peerEphemeralPubEncoded);
    if (!peerStatic || !peerEph) return null;
    try {
        const ephSs = x25519.getSharedSecret(myEphemeralPriv, peerEph);
        const staticSs = x25519.getSharedSecret(myIdentityPriv, peerStatic);
        return hkdf(sha256, concat(ephSs, staticSs), undefined, utf8('sovereign-media-session-v1'), 32);
    } catch {
        return null;
    }
}

/**
 * SFU media group key: derived from the CHANNEL group key (the same key that
 * protects channel messages), domain-separated per channel + epoch. Every
 * channel-key epoch rotation therefore rotates the SFU media key, and — like
 * messages — a member who left the server loses the next epoch. The SFU only
 * ever forwards ciphertext; this key never leaves clients.
 *
 * NOTE: rotation must be delivered to LiveKit via setKey with a NEW key index
 * (fresh random material via the channel-key system) — LiveKit's ratchetKey()
 * is a deterministic forward derivation a departed member could replay, so it
 * is never used for revocation.
 */
export function deriveSfuMediaKey(rawChannelKey: Uint8Array, channelId: number, epoch: number): Uint8Array {
    return hkdf(sha256, rawChannelKey, undefined, utf8(`sovereign-sfu-media-v1|${channelId}|${epoch}`), 32);
}

// --- Safety number (out-of-band identity-key verification) ---
//
// A short number derived from BOTH parties' identity public keys. Both sides
// compute the identical value (keys sorted first), so if a malicious server
// substitutes either key (a MITM), the two sides see DIFFERENT numbers —
// comparing them over a trusted channel (read aloud on a call) detects it. This
// is the out-of-band anchor that closes the first-contact trust gap TOFU pinning
// alone can't. Used for DMs and the remote-control channel (same identity keys).
export function computeSafetyNumber(pubAEncoded: string, pubBEncoded: string): string | null {
    const a = decodePublicKey(pubAEncoded);
    const b = decodePublicKey(pubBEncoded);
    if (!a || !b) return null;
    // Canonical order so both peers hash the same bytes regardless of who's who.
    const [lo, hi] = toBase64(a) <= toBase64(b) ? [a, b] : [b, a];
    const digest = sha256(concat(utf8('sovereign-safety-v1'), lo, hi));
    // 8 groups of 5 decimal digits (~133 bits) — easy to read aloud and compare.
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) {
        const n =
            ((digest[i * 4] << 24) |
                (digest[i * 4 + 1] << 16) |
                (digest[i * 4 + 2] << 8) |
                digest[i * 4 + 3]) >>>
            0;
        groups.push(String(n % 100000).padStart(5, '0'));
    }
    return groups.join(' ');
}

/** AES-256-GCM seal a control payload under a session key → base64(nonce||ct). */
export async function sealControl(sessionKey: Uint8Array, plaintext: string): Promise<string> {
    return aesEncrypt(sessionKey, plaintext);
}

/** Open a sealed control payload; null on any failure (bad key / forged tag). */
export async function openControl(sessionKey: Uint8Array, blobB64: string): Promise<string | null> {
    try {
        return await aesDecrypt(sessionKey, blobB64);
    } catch {
        return null;
    }
}

// RAW (unbase64'd) twins of the pair above, for the P2P input data channels
// (rtc/controlDc.ts): the DC is binary, and base64 would cost a third of
// every mouse move for nothing. SAME construction — AES-256-GCM,
// nonce(12)||ct — so a frame sealed either way opens either way; the
// equivalence is pinned by test.

/** AES-256-GCM seal → raw nonce||ct bytes. */
export async function sealControlBytes(sessionKey: Uint8Array, plaintext: string): Promise<Uint8Array> {
    const key = await importAesKey(sessionKey);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, utf8(plaintext) as BufferSource);
    return concat(nonce, new Uint8Array(ct));
}

/** Open raw nonce||ct bytes; null on any failure (bad key / forged tag). */
export async function openControlBytes(sessionKey: Uint8Array, blob: Uint8Array): Promise<string | null> {
    try {
        if (blob.length <= 12) return null;
        const key = await importAesKey(sessionKey);
        const pt = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: blob.slice(0, 12) },
            key,
            blob.slice(12) as BufferSource,
        );
        return new TextDecoder().decode(pt);
    } catch {
        return null;
    }
}

// --- v3 recoverable key custody ---
//
// The identity seed is decoupled from the password: it's a random 32 bytes,
// generated once and stored on the server as TWO independently-encrypted copies
// — one under a password-derived KEK, one under a recovery-code-derived KEK.
// Login unwraps with the password; password reset unwraps with the recovery
// code and re-wraps under the new password. The seed (and therefore the
// identity keypair and all history access) is preserved across a reset.
//
// The server holds only ciphertext + public salts + the public key; it can
// decrypt neither copy. See docs/E2EE_RECOVERY.md.

/** All the server-stored v3 wrap material (salts + wrapped-seed blobs). */
export interface WrapMaterial {
    /** base64(16-byte salt) for the password KEK. */
    wrapSalt: string;
    /** base64(16-byte salt) for the recovery-code KEK. */
    recoverySalt: string;
    /** base64(nonce||ct) of the seed under the password KEK. */
    seedWrappedPw: string;
    /** base64(nonce||ct) of the seed under the recovery-code KEK. */
    seedWrappedRc: string;
    /** PBKDF2 iterations for the password KEK — used only when pwKdf='pbkdf2';
     *  an ignored placeholder when pwKdf='argon2id'. */
    pwKdfIterations: number;
    /** Which KDF the password wrap uses (see PwKdf). Argon2id for new/upgraded
     *  wraps; absent on legacy server rows ⇒ treated as pbkdf2. */
    pwKdf: PwKdf;
}

/** A fresh random 32-byte identity seed (X25519 private scalar). */
export function generateIdentitySeed(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(32));
}

/** Build an Identity from a raw 32-byte seed. */
export function makeIdentity(seed: Uint8Array): Identity {
    return identityFromSeed(seed);
}

/** Generate a fresh 12-word BIP39 recovery phrase. */
export function generateRecoveryCode(): string {
    return generateMnemonic(wordlist, RECOVERY_ENTROPY_BITS);
}

/**
 * Normalize + checksum-validate a recovery phrase and return its canonical
 * 16-byte entropy, or null if the phrase is invalid (wrong words / bad
 * checksum — free typo detection). Using the canonical entropy (not the raw
 * string) as KDF input removes all whitespace/casing ambiguity.
 */
export function recoveryCodeEntropy(code: string): Uint8Array | null {
    const norm = code.trim().toLowerCase().normalize('NFKD').replace(/\s+/g, ' ');
    try {
        if (!validateMnemonic(norm, wordlist)) return null;
        return mnemonicToEntropy(norm, wordlist);
    } catch {
        return null;
    }
}

/** PBKDF2-SHA256 → 32-byte key via the platform's NATIVE implementation
 *  (crypto.subtle). Byte-identical to a pure-JS PBKDF2 for the same params, but
 *  fast enough to run the raised iteration counts without stalling login on
 *  mobile. */
async function pbkdf2Kek(secret: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const material = await crypto.subtle.importKey('raw', secret as BufferSource, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
        material, 256,
    );
    return new Uint8Array(bits);
}

/** Argon2id KEK (memory-hard) from the password. Pure-JS (noble); ~0.4 s. */
function argon2Kek(password: string, wrapSalt: Uint8Array): Uint8Array {
    return argon2id(utf8(password), wrapSalt, { t: ARGON2_T, m: ARGON2_M, p: ARGON2_P, dkLen: 32 });
}

/** KEK derived from the login password. `algo` selects the KDF: argon2id (the
 *  current default) ignores `iterations`; pbkdf2 (legacy) uses it so old blobs
 *  unwrap at their original strength. */
async function passwordKEK(
    password: string,
    wrapSalt: Uint8Array,
    iterations: number,
    algo: PwKdf = PW_KDF_PBKDF2,
): Promise<Uint8Array> {
    return algo === PW_KDF_ARGON2
        ? argon2Kek(password, wrapSalt)
        : pbkdf2Kek(utf8(password), wrapSalt, iterations);
}

/** KEK derived from the recovery phrase's canonical entropy. Fixed at the
 *  legacy iteration count — a 128-bit phrase gains nothing from more. */
function recoveryKEK(entropy: Uint8Array, recoverySalt: Uint8Array): Promise<Uint8Array> {
    return pbkdf2Kek(entropy, recoverySalt, WRAP_KDF_ITERATIONS_LEGACY);
}

/** AES-GCM wrap of a raw seed under a KEK → base64(nonce||ct). */
async function wrapSeed(seed: Uint8Array, kek: Uint8Array): Promise<string> {
    return aesEncrypt(kek, toBase64(seed));
}

/** Reverse of wrapSeed. Returns null on any failure (wrong KEK ⇒ GCM tag fails). */
async function unwrapSeed(blob: string, kek: Uint8Array): Promise<Uint8Array | null> {
    try {
        return fromBase64(await aesDecrypt(kek, blob));
    } catch {
        return null;
    }
}

/**
 * Produce all wrap material for a seed + the one-time recovery code to display.
 * Fresh random salts each call.
 */
export async function buildWrapMaterial(
    seed: Uint8Array,
    password: string
): Promise<{ material: WrapMaterial; recoveryCode: string }> {
    const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
    const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
    const recoveryCode = generateRecoveryCode();
    const entropy = recoveryCodeEntropy(recoveryCode);
    if (!entropy) throw new Error('recovery code generation failed'); // unreachable (we just generated it)
    const seedWrappedPw = await wrapSeed(seed, await passwordKEK(password, wrapSalt, ARGON2_ITERS_PLACEHOLDER, PW_KDF_ARGON2));
    const seedWrappedRc = await wrapSeed(seed, await recoveryKEK(entropy, recoverySalt));
    return {
        material: {
            wrapSalt: toBase64(wrapSalt),
            recoverySalt: toBase64(recoverySalt),
            seedWrappedPw,
            seedWrappedRc,
            pwKdfIterations: ARGON2_ITERS_PLACEHOLDER,
            pwKdf: PW_KDF_ARGON2,
        },
        recoveryCode,
    };
}

/** Upper bound on the iteration count we'll actually run, so a tampered/poisoned
 *  server value can't turn login into a multi-minute PBKDF2 grind (DoS). Well
 *  above the current target, so legitimate future bumps aren't clipped. */
const WRAP_KDF_ITERATIONS_MAX = 10_000_000;

/** Login: recover the seed from the password-wrapped blob. `iterations` is the
 *  count the blob was wrapped at (from the server; omit for legacy blobs). The
 *  value is clamped to a sane range before it drives PBKDF2 — a hostile server
 *  can't make us spin billions of rounds, and a too-low count still just fails
 *  the GCM tag (returns null) rather than derive a weak key that decrypts. */
export async function unwrapSeedWithPassword(
    password: string,
    wrapSaltB64: string,
    seedWrappedPw: string,
    iterations: number = WRAP_KDF_ITERATIONS_LEGACY,
    algo: PwKdf = PW_KDF_PBKDF2,
): Promise<Uint8Array | null> {
    if (algo === PW_KDF_ARGON2) {
        // Argon2id params are fixed client constants; iterations is ignored.
        return unwrapSeed(seedWrappedPw, await passwordKEK(password, fromBase64(wrapSaltB64), 0, PW_KDF_ARGON2));
    }
    const safe = Math.min(Math.max(Math.trunc(iterations) || WRAP_KDF_ITERATIONS_LEGACY, WRAP_KDF_ITERATIONS_LEGACY), WRAP_KDF_ITERATIONS_MAX);
    return unwrapSeed(seedWrappedPw, await passwordKEK(password, fromBase64(wrapSaltB64), safe, PW_KDF_PBKDF2));
}

/** True when a password wrap should be re-wrapped at the current target KDF.
 *  Anything not already Argon2id qualifies (legacy PBKDF2 rows, at any iteration
 *  count, upgrade to argon2id). `iterations` is accepted for signature symmetry
 *  and possible future param-based decisions. */
export function passwordWrapNeedsUpgrade(algo: PwKdf | null | undefined, iterations?: number | null): boolean {
    void iterations;
    return (algo ?? PW_KDF_PBKDF2) !== PW_KDF_ARGON2;
}

/** Re-wrap the seed under the SAME password at the current (stronger) KDF, for
 *  the transparent login-time upgrade. Leaves the recovery blob untouched. */
export async function upgradePasswordWrap(
    seed: Uint8Array,
    password: string,
): Promise<{ wrapSalt: string; seedWrappedPw: string; pwKdfIterations: number; pwKdf: PwKdf }> {
    return rewrapForNewPassword(seed, password);
}

/** Recovery: recover the seed from the recovery-code-wrapped blob. */
export async function unwrapSeedWithRecovery(
    code: string,
    recoverySaltB64: string,
    seedWrappedRc: string
): Promise<Uint8Array | null> {
    const entropy = recoveryCodeEntropy(code);
    if (!entropy) return null;
    return unwrapSeed(seedWrappedRc, await recoveryKEK(entropy, fromBase64(recoverySaltB64)));
}

/** Re-wrap an existing seed under a new password (used by the reset flow).
 *  Same seed ⇒ same identity ⇒ history preserved. */
export async function rewrapForNewPassword(
    seed: Uint8Array,
    newPassword: string
): Promise<{ wrapSalt: string; seedWrappedPw: string; pwKdfIterations: number; pwKdf: PwKdf }> {
    const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
    const seedWrappedPw = await wrapSeed(seed, await passwordKEK(newPassword, wrapSalt, ARGON2_ITERS_PLACEHOLDER, PW_KDF_ARGON2));
    return { wrapSalt: toBase64(wrapSalt), seedWrappedPw, pwKdfIterations: ARGON2_ITERS_PLACEHOLDER, pwKdf: PW_KDF_ARGON2 };
}

/** TEST/MIGRATION ONLY — wrap a seed with the LEGACY PBKDF2 KEK, so the
 *  backward-compat unwrap + transparent-upgrade paths can be exercised against a
 *  blob shaped exactly like the ones real pre-argon2 accounts already hold. Not
 *  used in production code. */
export async function __wrapSeedPbkdf2ForTest(
    seed: Uint8Array,
    password: string,
    iterations: number,
): Promise<{ wrapSalt: string; seedWrappedPw: string; pwKdfIterations: number }> {
    const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
    const seedWrappedPw = await wrapSeed(seed, await passwordKEK(password, wrapSalt, iterations, PW_KDF_PBKDF2));
    return { wrapSalt: toBase64(wrapSalt), seedWrappedPw, pwKdfIterations: iterations };
}

/**
 * Reset proof-of-possession. Proves we hold `seed` (the account's private key)
 * to the server's recovery-reset endpoint, so only a legitimate recovery — not
 * a DB thief — can reset the password.
 *
 * The server sends an ephemeral X25519 public key `E` and a random challenge.
 * We return HMAC(HKDF(X25519(seed, E)), challenge || usernameLower). The server
 * checks with X25519(e, P), which equals X25519(seed, E) by DH symmetry. Only a
 * holder of `seed` can produce it. Returns base64(proof), or null if `E` is bad.
 */
export function computeRecoveryProof(
    seed: Uint8Array,
    serverEphemeralPublicKeyEncoded: string,
    challengeB64: string,
    usernameLower: string
): string | null {
    const E = decodePublicKey(serverEphemeralPublicKeyEncoded);
    if (!E) return null;
    const dh = x25519.getSharedSecret(seed, E);
    const proofKey = hkdf(sha256, dh, undefined, HKDF_RECOVERY_PROOF_INFO, 32);
    const msg = concat(fromBase64(challengeB64), utf8(usernameLower));
    return toBase64(hmac(sha256, proofKey, msg));
}

// --- Envelope helpers ---

/** Serialize an envelope to the string stored in `content`. */
export function serializeEnvelope(env: Envelope): string {
    return JSON.stringify(env);
}

export type ParsedEnvelope =
    | { kind: 'envelope'; env: Envelope }
    /** Shaped like an envelope, but a version this build does not
     *  implement. MUST be treated as encrypted-and-unreadable, never as
     *  plaintext: the old parser returned null here, and the raw JSON then
     *  rendered as content with a "not encrypted" badge. */
    | { kind: 'unsupported-version'; v: number }
    | { kind: 'plaintext' };

export function parseEnvelopeEx(content: string): ParsedEnvelope {
    if (!content || content[0] !== '{') return { kind: 'plaintext' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return { kind: 'plaintext' }; // not JSON
    }
    const p = parsed as { v?: unknown; t?: unknown; ct?: unknown } | null;
    const shaped = !!p && typeof p.v === 'number' && (p.t === 'dm' || p.t === 'ch' || p.t === 'self') && typeof p.ct === 'string';
    if (!shaped) return { kind: 'plaintext' };
    if (p.v === 2 || p.v === 3) return { kind: 'envelope', env: parsed as Envelope };
    return { kind: 'unsupported-version', v: p.v as number };
}

/** Parse a stored content string into an envelope this build can open, or
 *  null. Prefer parseEnvelopeEx wherever "unsupported version" must be
 *  told apart from "plaintext" — every message renderer must. */
export function parseEnvelope(content: string): Envelope | null {
    const p = parseEnvelopeEx(content);
    return p.kind === 'envelope' ? p.env : null;
}

/** Envelope-shaped — INCLUDING versions this build cannot open — so a newer
 *  format is never classified as legacy plaintext by messageEncState. */
export function isEncrypted(content: string): boolean {
    return parseEnvelopeEx(content).kind !== 'plaintext';
}

/**
 * How a rendered message relates to E2EE, derived from the ORIGINAL wire
 * content and the DECRYPTED output:
 *
 *  - `secure`  — the wire was a valid encryption envelope and decrypted (or is
 *                otherwise not a failure marker). The E2EE promise held.
 *  - `legacy`  — the wire was NOT an envelope, so the content was stored/sent as
 *                plaintext and passed through verbatim. A malicious or
 *                misconfigured server can inject such a message and, without an
 *                indicator, it renders identically to a decrypted one — the
 *                whole point of this classification (audit H-1).
 *  - `failed`  — decryption was attempted and produced a failure marker
 *                (locked identity, unavailable key, unverified sender key).
 *
 * Pure and side-effect free so every decrypt path can tag its output uniformly.
 */
export type MessageEncState = 'secure' | 'legacy' | 'failed';
export function messageEncState(wire: string, decrypted: string): MessageEncState {
    if (isUndecryptable(decrypted)) return 'failed';
    return isEncrypted(wire) ? 'secure' : 'legacy';
}

// --- Identity persistence & session ---
//
// Because identity keys are password-derived, we only need to persist the
// 32-byte seed so page reloads (which keep the auth token) can reconstruct the
// keypair without the password. The seed is password-equivalent for decryption,
// so it lives in localStorage under the same trust assumptions as the auth
// token — device compromise is out of this app's threat model.

const SEED_STORAGE_KEY = 'e2ee_seed_v2';

let currentIdentity: Identity | null = null;

function identityFromSeed(seed: Uint8Array): Identity {
    const publicKey = x25519.getPublicKey(seed);
    return { privateKey: seed, publicKey, publicKeyEncoded: encodePublicKey(publicKey) };
}

/** Set the active identity and persist its seed for this device. */
export function setActiveIdentity(identity: Identity): void {
    currentIdentity = identity;
    try {
        localStorage.setItem(SEED_STORAGE_KEY, toBase64(identity.privateKey));
    } catch {
        // storage may be unavailable (private mode); keep in-memory only
    }
}

/**
 * Return the active identity, reconstructing it from the persisted seed if this
 * is a fresh page load. Returns null if the user has no stored identity (e.g.
 * logged in before E2EE existed, or on a device that never derived keys).
 */
export function getActiveIdentity(): Identity | null {
    if (currentIdentity) return currentIdentity;
    try {
        const stored = localStorage.getItem(SEED_STORAGE_KEY);
        if (!stored) return null;
        currentIdentity = identityFromSeed(fromBase64(stored));
        return currentIdentity;
    } catch {
        return null;
    }
}

// --- Account signing key (root of device enrolment) -------------------------

/** An Ed25519 keypair derived from the account seed. */
export interface AccountSigningKey {
    /** 32-byte Ed25519 seed (secret). */
    privateKey: Uint8Array;
    /** 32-byte Ed25519 public key. */
    publicKey: Uint8Array;
    /** `ed25519:<base64>`, the form stored and compared. */
    publicKeyEncoded: string;
}

/**
 * Derive the account signing key. Deterministic: every device of the account
 * produces the same keypair from the same seed, which is exactly what lets one
 * device verify a record another device signed WITHOUT trusting the server.
 */
export function deriveAccountSigningKey(identity: Identity): AccountSigningKey {
    const seed = hkdf(sha256, identity.privateKey, undefined, HKDF_ACCOUNT_SIGN_INFO, 32);
    const publicKey = ed25519.getPublicKey(seed);
    return { privateKey: seed, publicKey, publicKeyEncoded: SIGN_PUBKEY_PREFIX + toBase64(publicKey) };
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace.
 *
 * Signatures are over BYTES, so producer and verifier must serialise
 * identically. `JSON.stringify` preserves insertion order, so two clients
 * building the same record in a different field order would produce different
 * bytes and each would reject the other's signature.
 *
 * Rejects what cannot round-trip rather than silently mangling it: `undefined`
 * and functions vanish under JSON.stringify, and NaN/Infinity become `null` —
 * each of which would make the verified bytes differ from the intended value.
 */
export function canonicalJson(value: unknown): string {
    const encode = (v: unknown): string => {
        if (v === null) return 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number');
            return JSON.stringify(v);
        }
        if (typeof v === 'string') return JSON.stringify(v);
        if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
        if (typeof v === 'object') {
            const obj = v as Record<string, unknown>;
            const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
            return '{' + keys.map(k => JSON.stringify(k) + ':' + encode(obj[k])).join(',') + '}';
        }
        throw new Error(`canonicalJson: unsupported type ${typeof v}`);
    };
    return encode(value);
}

/** Sign a canonical record with the account signing key. Returns base64. */
export function signWithAccountKey(key: AccountSigningKey, record: string): string {
    return toBase64(ed25519.sign(utf8(record), key.privateKey));
}

/**
 * Verify a record against an `ed25519:`-prefixed public key.
 *
 * Returns false for every malformed input rather than throwing: callers use
 * this to decide whether to TRUST attacker-influenced data, and a throw at a
 * call site that forgot a try/catch would fail open.
 */
export function verifyWithAccountKey(publicKeyEncoded: string, record: string, sig: string): boolean {
    try {
        if (!publicKeyEncoded.startsWith(SIGN_PUBKEY_PREFIX)) return false;
        const pub = fromBase64(publicKeyEncoded.slice(SIGN_PUBKEY_PREFIX.length));
        if (pub.length !== 32) return false;
        const sigBytes = fromBase64(sig);
        if (sigBytes.length !== 64) return false;
        return ed25519.verify(sigBytes, utf8(record), pub);
    } catch {
        return false;
    }
}

/** Encrypt a device's LAN details for storage on the server. */
export async function sealDeviceLan(identity: Identity, plaintext: string): Promise<string> {
    const key = hkdf(sha256, identity.privateKey, undefined, HKDF_DEVICE_LAN_INFO, 32);
    return aesEncrypt(key, plaintext);
}

/** Decrypt LAN details; null on any failure, so callers fail closed rather than
 *  acting on half-parsed network data. */
export async function openDeviceLan(identity: Identity, blob: string): Promise<string | null> {
    try {
        const key = hkdf(sha256, identity.privateKey, undefined, HKDF_DEVICE_LAN_INFO, 32);
        return await aesDecrypt(key, blob);
    } catch {
        return null;
    }
}

/** Clear identity material (on logout). */
export function clearActiveIdentity(): void {
    currentIdentity = null;
    try {
        localStorage.removeItem(SEED_STORAGE_KEY);
    } catch {
        // ignore
    }
}
