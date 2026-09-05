/**
 * SRP Authentication Module for Púca
 * 
 * Custom SRP-6a implementation compatible with the Rust srp crate (v0.6.0).
 * 
 * CRITICAL: Rust's BigUint::to_bytes_be() produces MINIMAL representation
 * (no leading zeros). All hash inputs must use minimal byte representation.
 */

import { apiClient } from './client';
import { argon2id } from '@noble/hashes/argon2.js';

// SRP-2048 group parameters from RFC 5054
const N_HEX = 'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73';
const G_HEX = '02';

// ============ SRP verifier derivation (srp_version) ============
//
// Which KDF turns (salt, username, password) into the SRP private value x.
// The server stores this per account (migration 059), tells the client which
// one to use in login step 1, and records which one a client used whenever a
// verifier is written. The server never derives x itself.
//
//   1  x = SHA-256(salt ‖ SHA-256(lower(username) ":" password)). Two hash
//      calls, no stretching: a database thief attacks the verifier at one
//      hash per guess. Every account created before 0.9.3 is here, and so is
//      any verifier a pre-0.9.3 client writes (it omits the field, and the
//      server defaults to 1 — defaulting to 2 would strand that account,
//      because the next current client would derive Argon2id against a
//      SHA-256 verifier and never match).
//   2  x = Argon2id(password, salt ‖ lower(username); m=19456 KiB, t=2,
//      p=1, 32 bytes) — the same cost as the password wrap in e2ee.ts, so
//      the verifier is no longer ~10^4x cheaper to attack than the seed it
//      sits beside. Registration, password change and every reset derive
//      this; a v1 account is upgraded transparently in its first successful
//      login exchange (see srpExchange), when the client provably knows the
//      password and the server has just verified it.
const SRP_VERSION_CURRENT = 2;
const SRP_ARGON2_M = 19_456; // KiB (19 MiB)
const SRP_ARGON2_T = 2;
const SRP_ARGON2_P = 1;

// ============ Utility Functions ============

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexToBigInt(hex: string): bigint {
    if (hex.length === 0) return 0n;
    return BigInt('0x' + hex);
}

/**
 * Convert BigInt to MINIMAL byte representation (like Rust's to_bytes_be())
 * This strips leading zeros!
 */
function bigIntToMinimalBytes(n: bigint): Uint8Array {
    if (n === 0n) return new Uint8Array([0]);

    let hex = n.toString(16);
    // Ensure even length
    if (hex.length % 2 !== 0) {
        hex = '0' + hex;
    }
    return hexToBytes(hex);
}

/**
 * Convert BigInt to padded hex for transmission (not for hashing!)
 */
function bigIntToPaddedHex(n: bigint, byteLength: number): string {
    let hex = n.toString(16);
    const targetLength = byteLength * 2;
    if (hex.length < targetLength) {
        hex = hex.padStart(targetLength, '0');
    }
    return hex;
}

/**
 * Modular exponentiation for PUBLIC exponents.
 *
 * Square-and-multiply. The operation sequence depends on the bits of `exp`, so
 * this must never be called with a secret. Use `modPowSecret` for those.
 */
function modPowPublic(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
        if (exp % 2n === 1n) {
            result = (result * base) % mod;
        }
        exp = exp >> 1n;
        base = (base * base) % mod;
    }
    return result;
}

/**
 * Modular exponentiation for SECRET exponents: the SRP private key `x` and the
 * client ephemeral `a`.
 *
 * WHAT THIS FIXES. The previous implementation was a plain square-and-multiply
 * whose inner branch tested a bit of the secret exponent, and whose loop count
 * revealed the exponent's bit length. An external review flagged it, correctly.
 *
 * WHAT IT DOES NOT CLAIM. This is NOT constant-time, and it cannot be:
 * JavaScript `BigInt` arithmetic is variable-time by construction, the engine is
 * free to optimise it, and nothing at this layer can change that. Anyone
 * claiming a constant-time bignum in portable JS is claiming something the
 * runtime does not offer. So this reduces the signal rather than removing it,
 * by three separate means:
 *
 *  1. MONTGOMERY LADDER. Every bit performs exactly one multiply and one
 *     square, in the same order, whatever the bit is. The branch selects which
 *     variable receives which product, not whether work happens.
 *  2. FIXED WIDTH. The loop always runs the modulus's bit length, so a small
 *     exponent takes the same number of iterations as a large one. The old
 *     `while (exp > 0n)` leaked the bit length directly.
 *  3. EXPONENT BLINDING, which is the part that actually matters. `N` is a safe
 *     prime, so by Fermat's little theorem g^(N-1) = 1 (mod N), and therefore
 *     g^(e + r(N-1)) = g^e (mod N) for any r. We add a random 64-bit multiple
 *     of (N-1) before exponentiating. The result is identical; the exponent the
 *     hardware actually processes is different on every call. Averaging many
 *     measurements now converges on noise instead of on `x`.
 *
 * Blinding costs one extra multiply and ~64 extra ladder steps. That is
 * nothing next to a network round trip, and it is the standard defence.
 */
function modPowSecret(base: bigint, exp: bigint, mod: bigint): bigint {
    // Blind: e' = e + r*(mod-1), which is congruent for a prime modulus.
    const r = bytesToBigInt(randomBytes(8));
    const blinded = exp + r * (mod - 1n);

    // Ladder over a fixed width: the blinded exponent can exceed the modulus,
    // so size the loop from it rather than from `mod`.
    let r0 = 1n;
    let r1 = base % mod;
    const bits = blinded.toString(2).length;
    for (let i = bits - 1; i >= 0; i--) {
        const bit = (blinded >> BigInt(i)) & 1n;
        if (bit === 1n) {
            r0 = (r0 * r1) % mod;
            r1 = (r1 * r1) % mod;
        } else {
            r1 = (r0 * r1) % mod;
            r0 = (r0 * r0) % mod;
        }
    }
    return r0;
}

/** Big-endian bytes to BigInt. Used for blinding factors. */
function bytesToBigInt(b: Uint8Array): bigint {
    let n = 0n;
    for (const byte of b) n = (n << 8n) | BigInt(byte);
    return n;
}

/**
 * Kept as the name the call sites use. Every current caller passes a SECRET
 * exponent — the SRP private key `x`, the client ephemeral `a`, or the session
 * exponent derived from both — so this routes to the blinded ladder. If a
 * caller ever needs a public exponent, call `modPowPublic` explicitly and say
 * in a comment why the exponent is not secret.
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    return modPowSecret(base, exp, mod);
}

// SHA-256 hash using Web Crypto API
async function H(...inputs: Uint8Array[]): Promise<Uint8Array> {
    const totalLength = inputs.reduce((sum, p) => sum + p.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of inputs) {
        combined.set(part, offset);
        offset += part.length;
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    return new Uint8Array(hashBuffer);
}

function randomBytes(byteLength: number): Uint8Array {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes;
}

const N = hexToBigInt(N_HEX);
const g = hexToBigInt(G_HEX);
const N_BYTES = 256; // 2048 bits = 256 bytes

// k = H(N | PAD(g)) - g is padded to N's length
let k_cached: bigint | null = null;
async function getK(): Promise<bigint> {
    if (k_cached === null) {
        // N bytes (minimal, but N is large so no leading zeros)
        const nBytes = bigIntToMinimalBytes(N);
        // g padded to N's length
        const gBytes = bigIntToMinimalBytes(g);
        const gPadded = new Uint8Array(nBytes.length);
        gPadded.set(gBytes, nBytes.length - gBytes.length);

        const kHash = await H(nBytes, gPadded);
        k_cached = BigInt('0x' + bytesToHex(kHash));
    }
    return k_cached;
}

/**
 * Compute identity hash = H(username | ":" | password)
 * Using raw bytes, not hex!
 * 
 * IMPORTANT: Username is normalized to lowercase for case-insensitive login.
 * After the case-insensitive migration, all verifiers are computed with lowercase.
 */
async function computeIdentityHash(username: string, password: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    // Normalize username to lowercase for case-insensitive login
    const usernameBytes = encoder.encode(username.toLowerCase());
    const colonBytes = encoder.encode(':');
    const passwordBytes = encoder.encode(password);
    return await H(usernameBytes, colonBytes, passwordBytes);
}

/**
 * Compute x = H(salt | identity_hash) — srp_version 1.
 */
async function computeX(salt: Uint8Array, identityHash: Uint8Array): Promise<bigint> {
    const xHash = await H(salt, identityHash);
    return BigInt('0x' + bytesToHex(xHash));
}

/**
 * Compute x = Argon2id(password, salt ‖ lower(username)) — srp_version 2.
 *
 * The username goes into the Argon2 SALT rather than the message so that two
 * accounts with the same password (and, by chance, the same salt bytes) still
 * get different x. Lowercased because login is case-insensitive — the server
 * matches LOWER(username) — so the derivation must not depend on how the
 * name was typed. 32 bytes out, so x < 2^256 exactly as for v1.
 */
function computeXv2(salt: Uint8Array, username: string, password: string): bigint {
    const encoder = new TextEncoder();
    const user = encoder.encode(username.toLowerCase());
    const argonSalt = new Uint8Array(salt.length + user.length);
    argonSalt.set(salt, 0);
    argonSalt.set(user, salt.length);
    const xBytes = argon2id(encoder.encode(password), argonSalt, {
        m: SRP_ARGON2_M, t: SRP_ARGON2_T, p: SRP_ARGON2_P, dkLen: 32,
    });
    return BigInt('0x' + bytesToHex(xBytes));
}

/** x under whichever derivation the server says this account uses. */
async function computeXFor(version: number, salt: Uint8Array, username: string, password: string): Promise<bigint> {
    if (version === 1) return computeX(salt, await computeIdentityHash(username, password));
    if (version === 2) return computeXv2(salt, username, password);
    // A later server may add a v3 this build cannot derive. Guessing v1 would
    // just be a wrong password with a misleading error.
    throw new Error('This server uses a sign-in format this app does not understand — please update the app');
}

/** A fresh salt + verifier under the CURRENT derivation, for every path that
 *  writes credentials: registration, password change, and all three resets. */
function freshVerifier(username: string, password: string): { salt: Uint8Array; v: bigint } {
    const salt = randomBytes(32); // 32 bytes = 64 hex chars (SRP salt)
    const x = computeXv2(salt, username, password);
    return { salt, v: computeVerifier(x) };
}

/**
 * Compute verifier v = g^x mod N
 */
function computeVerifier(x: bigint): bigint {
    return modPow(g, x, N);
}

/**
 * Generate client ephemeral values
 */
function generateClientEphemeral(): { a: bigint; A: bigint } {
    const aBytes = randomBytes(32); // 256 bits
    const a = BigInt('0x' + bytesToHex(aBytes));
    const A = modPow(g, a, N);
    return { a, A };
}

/**
 * Compute u = H(A_bytes | B_bytes)
 * CRITICAL: Rust srp crate uses BigUint::to_bytes_be() which produces MINIMAL bytes!
 * The server calls compute_u(&a_pub.to_bytes_be(), &b_pub.to_bytes_be()) with minimal bytes.
 */
async function computeU(A: bigint, B: bigint): Promise<bigint> {
    // Use MINIMAL bytes to match Rust srp crate's compute_u
    const aBytes = bigIntToMinimalBytes(A);
    const bBytes = bigIntToMinimalBytes(B);
    const uHash = await H(aBytes, bBytes);
    return BigInt('0x' + bytesToHex(uHash));
}

/**
 * Compute client session key
 * S = (B - k * g^x) ^ (a + u * x) mod N
 * K = S (as bytes, K is the session key that gets hashed in M1)
 * 
 * Note: In Rust srp crate, the "key" returned is S.to_bytes_be() NOT H(S)
 */
async function computeClientSession(
    a: bigint,
    B: bigint,
    x: bigint,
    u: bigint
): Promise<bigint> {
    const k = await getK();

    const gx = modPow(g, x, N);
    const kgx = (k * gx) % N;

    let base = B - kgx;
    if (base < 0n) {
        base = base + N;
    }
    base = base % N;

    const exp = (a + u * x);
    const S = modPow(base, exp, N);

    return S;
}

/**
 * Compute M1 = H(A | B | K) 
 * All using minimal byte representation!
 * K is the premaster secret S as bytes (matches Rust srp crate)
 */
async function computeM1(A: bigint, B: bigint, K: Uint8Array): Promise<Uint8Array> {
    const aBytes = bigIntToMinimalBytes(A);
    const bBytes = bigIntToMinimalBytes(B);
    return await H(aBytes, bBytes, K);
}

/**
 * Compute M2 = H(A | M1 | K)
 * K is the premaster secret S as bytes (matches Rust srp crate)
 */
async function computeM2(A: bigint, M1: Uint8Array, K: Uint8Array): Promise<Uint8Array> {
    const aBytes = bigIntToMinimalBytes(A);
    return await H(aBytes, M1, K);
}

import {
    setActiveIdentity, clearActiveIdentity,
    generateIdentitySeed, makeIdentity, buildWrapMaterial,
    unwrapSeedWithPassword, unwrapSeedWithRecovery, rewrapForNewPassword,
    passwordWrapNeedsUpgrade, upgradePasswordWrap,
    computeRecoveryProof,
    type PwKdf,
} from './e2ee';
import { setPendingRecoveryCode, markRecoveryCodeUnacknowledged } from './recoveryPrompt';
import { clearChannelKeyCache } from './channelKeys';
import { resetIceConfigCache } from './iceConfig';
import { clearBlobCache } from './attachments';
// Feature teardown is REGISTERED, not imported. Importing the device modules
// here put auth.ts — which sits on nearly every import path — into an import
// cycle with api/devices/index.ts, dragging the whole remote-control stack
// into the main chunk of every build. See api/logoutHooks.ts.
import { runLogoutCleanups } from './logoutHooks';
import { isTauri, isMobile } from './platform';
import { thisDeviceId, clearThisDeviceId } from './thisDevice';

// ============ Public API ============

export async function register(username: string, password: string, inviteCode?: string): Promise<void> {
    const { salt, v } = freshVerifier(username, password);
    const saltHex = bytesToHex(salt);

    // v3 key custody: a random identity seed (independent of the password),
    // wrapped under both the password and a one-time recovery code.
    const seed = generateIdentitySeed();
    const identity = makeIdentity(seed);
    const { material, recoveryCode } = await buildWrapMaterial(seed, password);

    await apiClient.post('/auth/register', {
        username,
        salt_hex: saltHex,
        verifier_hex: bigIntToPaddedHex(v, N_BYTES),
        srp_version: SRP_VERSION_CURRENT,
        public_key: identity.publicKeyEncoded,
        wrap_salt: material.wrapSalt,
        recovery_salt: material.recoverySalt,
        seed_wrapped_pw: material.seedWrappedPw,
        seed_wrapped_rc: material.seedWrappedRc,
        pw_kdf_iterations: material.pwKdfIterations,
        pw_kdf: material.pwKdf,
        // Only meaningful when the server has closed registration; ignored otherwise.
        invite_code: inviteCode?.trim() || undefined,
    });

    setActiveIdentity(identity);
    // Surfaced by RecoveryCodeModal after the user logs in. The marker
    // outlives a reload; the code itself deliberately does not.
    setPendingRecoveryCode(recoveryCode);
    markRecoveryCodeUnacknowledged();
}

/**
 * A new SRP salt + verifier for a password change or reset, in hex, plus the
 * srp_version the caller MUST send alongside: a server not told which
 * derivation produced a verifier assumes the legacy one, and the account
 * could then never be opened.
 */
export async function generateVerifierForReset(username: string, password: string): Promise<{ salt: string; verifier: string; srp_version: number }> {
    const { salt, v } = freshVerifier(username, password);
    return {
        salt: bytesToHex(salt),
        verifier: bigIntToPaddedHex(v, N_BYTES),
        srp_version: SRP_VERSION_CURRENT,
    };
}

/**
 * Run the SRP exchange and return the server's token, verifying the server's
 * own proof (M2) on the way — i.e. prove the password to the server AND prove
 * the server knows the verifier, with no side effects on local state.
 *
 * Split out of `login` so the two callers cannot drift: `login` (which then
 * restores the E2EE identity and stores the token) and `proveCurrentPassword`
 * (which throws the token away and only wants the server-side proof recorded).
 *
 * Throws on a wrong password, an invalid server key, or a failed M2 check.
 */
async function srpExchange(username: string, password: string): Promise<string> {
    const { a, A } = generateClientEphemeral();

    const step1Response: { salt_hex: string; b_pub_hex: string; attempt_id?: string; srp_version?: number } = await apiClient.post('/auth/login/step1', {
        username,
        a_pub_hex: bigIntToPaddedHex(A, N_BYTES),
    });
    // A server predating migration 059 sends no version; every account it
    // holds is SHA-256.
    const { salt_hex, b_pub_hex, attempt_id, srp_version = 1 } = step1Response;

    const salt = hexToBytes(salt_hex);
    const B = hexToBigInt(b_pub_hex);
    if (B % N === 0n) throw new Error('Invalid server public key');

    const u = await computeU(A, B);
    if (u === 0n) throw new Error('Invalid scrambling parameter');

    const x = await computeXFor(srp_version, salt, username, password);
    const S = await computeClientSession(a, B, x, u);
    // The Rust srp crate uses S directly (not H(S)) for M1: in process_reply
    // the "key" is the raw premaster secret S as minimal big-endian bytes.
    const K = bigIntToMinimalBytes(S);
    const M1 = await computeM1(A, B, K);

    // A legacy-derivation account is upgraded IN this exchange. The password
    // is in hand, and the server applies the new material only after M1 has
    // verified — so nothing but a successful login with the real password can
    // rewrite the verifier, and there is no separate endpoint for a stolen
    // bearer token to call. Derived before step 2 so the exchange stays one
    // round-trip; a v2 account sends nothing, and a server that predates the
    // field ignores it.
    let upgrade: { new_salt_hex: string; new_verifier_hex: string } | undefined;
    if (srp_version < SRP_VERSION_CURRENT) {
        const fresh = freshVerifier(username, password);
        upgrade = { new_salt_hex: bytesToHex(fresh.salt), new_verifier_hex: bigIntToPaddedHex(fresh.v, N_BYTES) };
    }

    const step2Response: { hamk_hex: string; token: string } = await apiClient.post('/auth/login/step2', {
        username,
        m_hex: bytesToHex(M1),
        ...(attempt_id ? { attempt_id } : {}),
        ...(upgrade ?? {}),
    });

    const expectedM2 = await computeM2(A, M1, K);
    if (step2Response.hamk_hex.toLowerCase() !== bytesToHex(expectedM2).toLowerCase()) {
        throw new Error('Server verification failed - possible MITM attack');
    }
    return step2Response.token;
}

/**
 * Prove the CURRENT password to the server, so it will accept a credential or
 * key-custody rewrite.
 *
 * A JWT only says "this session authenticated at some point"; the server now
 * requires a recent SRP proof before it will write a new verifier or replace
 * the wrapped seed, so a stolen token alone cannot take the account over. The
 * password is already in hand wherever this is called (the change-password form
 * collects it), so this needs no extra prompt — just one round-trip.
 *
 * The returned token is deliberately DISCARDED: the caller keeps its existing
 * session, and `change_password` invalidates every token immediately after.
 */
async function proveCurrentPassword(username: string, password: string): Promise<void> {
    await proofImpl(username, password);
}

/** The SRP round-trip proveCurrentPassword runs. Swappable ONLY by tests:
 *  a unit test cannot answer step2 with a valid server proof (that needs the
 *  server's half of SRP), and the flows that prove-then-write must still be
 *  exercised end to end — see tests/recoveryRegenerate.test.ts. */
let proofImpl: (username: string, password: string) => Promise<unknown> = srpExchange;
export function __setProofImplForTest(fn: ((u: string, p: string) => Promise<unknown>) | null): void {
    proofImpl = fn ?? srpExchange;
}

/** login() refuses a key_version < 3 account. Its own error type so the
 *  identity-setup catch below can let it through: swallowed, the user was
 *  signed in with no E2EE identity and no message. */
export class RetiredKeyFormatError extends Error {
    constructor() {
        super('This account uses a retired key format — reset it with your recovery code, or ask the operator');
        this.name = 'RetiredKeyFormatError';
    }
}

export async function login(username: string, password: string): Promise<string> {
    const token = await srpExchange(username, password);
    localStorage.setItem('auth_token', token);
    await restoreIdentityAfterLogin(username, password);
    return token;
}

/**
 * Restore the E2EE identity for a session whose token is already stored:
 * v3 unwraps the random seed with the password.
 *
 * Every failure except a retired key format is SWALLOWED — the session
 * stays — because dropping a sign-in over a flaky GET /keys/wrap would be
 * worse. But a swallowed failure used to be silent: the user was fully
 * "logged in" with no identity and found out when a send was refused. It is
 * now recorded (persisted, so a reload does not forget it) and the authed
 * layout shows IdentityBanner with a retry that re-runs this with the
 * password. Exported so that path can be tested without the SRP half.
 */
export async function restoreIdentityAfterLogin(username: string, password: string): Promise<void> {
    try {
        const wrap: {
            key_version: number;
            wrap_salt: string | null;
            seed_wrapped_pw: string | null;
            pw_kdf_iterations: number | null;
            pw_kdf: PwKdf | null;
        } = await apiClient.get('/keys/wrap');

        // Refuse a DOWNGRADE. Which key-derivation scheme this client uses was
        // decided entirely by a number the untrusted server sends, with nothing
        // remembering what this account had already reached — so a server that
        // reported key_version 2 pushed a v3 account back onto the legacy
        // password-derived identity and overwrote the cached seed.
        //
        // On its own that is not a confidentiality break (the SRP verifier in
        // the same row is a cheaper offline target than either KDF, and the
        // migrate path is refused server-side with a 409). But a client that
        // treats the server as untrusted should not accept a protocol
        // downgrade on the server's word, so pin the highest version seen.
        const pinnedKey = `e2ee_key_version_${username.toLowerCase()}`;
        const pinned = Number(localStorage.getItem(pinnedKey) ?? '0') || 0;
        if (wrap.key_version < pinned) {
            throw new Error(
                `server offered key_version ${wrap.key_version} for an account already at ${pinned} — refusing to downgrade`,
            );
        }
        if (wrap.key_version > pinned) {
            try { localStorage.setItem(pinnedKey, String(wrap.key_version)); } catch { /* private mode */ }
        }

        if (wrap.key_version >= 3 && wrap.wrap_salt && wrap.seed_wrapped_pw) {
            const seed = await unwrapSeedWithPassword(
                password, wrap.wrap_salt, wrap.seed_wrapped_pw,
                wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
            );
            if (!seed) throw new Error('seed unwrap failed (password/key mismatch)');
            setActiveIdentity(makeIdentity(seed));
            clearIdentityRestoreFailure();
            // Transparently upgrade the password wrap to the current KDF
            // (Argon2id) if it isn't already. Best-effort — login already
            // succeeded; a failed upgrade just retries next login.
            if (passwordWrapNeedsUpgrade(wrap.pw_kdf, wrap.pw_kdf_iterations)) {
                try {
                    const up = await upgradePasswordWrap(seed, password);
                    await apiClient.post('/keys/rewrap-pw', {
                        wrap_salt: up.wrapSalt,
                        seed_wrapped_pw: up.seedWrappedPw,
                        pw_kdf_iterations: up.pwKdfIterations,
                        pw_kdf: up.pwKdf,
                    });
                } catch (e) {
                    console.warn('[e2ee] password-wrap KDF upgrade deferred:', e);
                }
            }
        } else {
            // Legacy (key_version < 3) custody derived the identity from the
            // PASSWORD at 210k PBKDF2 — cheap to attack offline given the row.
            // Every account was migrated (0 legacy rows in the field on
            // 2026-09-02) and registration has minted random v3 seeds for a
            // long time, so the derivation is no longer a login path: an
            // account that still reports it is not silently re-derived here.
            throw new RetiredKeyFormatError();
        }
    } catch (e) {
        if (e instanceof RetiredKeyFormatError) {
            // Not a degraded sign-in: the token stored above would otherwise
            // sign the account in silently on the next load, identity-less.
            localStorage.removeItem('auth_token');
            throw e;
        }
        console.warn('E2EE identity setup failed; messaging may be unavailable until next login', e);
        markIdentityRestoreFailed(username);
    }
}

// --- "signed in, but the keys never came back" -----------------------------

const IDENTITY_MISSING_KEY = 'e2ee_identity_missing_v1';
const IDENTITY_EVENT = 'identity-restore-changed';

function markIdentityRestoreFailed(username: string): void {
    try { localStorage.setItem(IDENTITY_MISSING_KEY, username); } catch { /* private mode */ }
    try { window.dispatchEvent(new CustomEvent(IDENTITY_EVENT)); } catch { /* non-DOM */ }
}

function clearIdentityRestoreFailure(): void {
    let had = false;
    try {
        had = localStorage.getItem(IDENTITY_MISSING_KEY) !== null;
        localStorage.removeItem(IDENTITY_MISSING_KEY);
    } catch { /* private mode */ }
    if (had) {
        try { window.dispatchEvent(new CustomEvent(IDENTITY_EVENT)); } catch { /* non-DOM */ }
    }
}

/** True while this device is signed in without a restored E2EE identity. */
export function identityRestoreFailed(): boolean {
    try { return localStorage.getItem(IDENTITY_MISSING_KEY) !== null; } catch { return false; }
}

/** Subscribe to the flag changing; returns the unsubscribe. */
export function onIdentityRestoreChange(cb: () => void): () => void {
    window.addEventListener(IDENTITY_EVENT, cb);
    return () => window.removeEventListener(IDENTITY_EVENT, cb);
}

/**
 * Try the restore again with the password (the seed unwrap needs it). No
 * SRP here — a wrong password fails the unwrap locally and never reaches a
 * 401 that the session-expiry handler would act on. Throws with a message
 * the banner can show.
 */
export async function retryIdentityRestore(password: string): Promise<void> {
    let username: string | null = null;
    try { username = localStorage.getItem(IDENTITY_MISSING_KEY); } catch { /* private mode */ }
    if (!username) {
        const t = getToken();
        const claims = t ? decodeJwtPayload(t) : null;
        username = typeof claims?.username === 'string' ? claims.username : null;
    }
    if (!username) throw new Error('Sign in again to restore your keys.');
    const wrap: {
        key_version: number;
        wrap_salt: string | null;
        seed_wrapped_pw: string | null;
        pw_kdf_iterations: number | null;
        pw_kdf: PwKdf | null;
    } = await apiClient.get('/keys/wrap');
    if (wrap.key_version < 3 || !wrap.wrap_salt || !wrap.seed_wrapped_pw) {
        throw new RetiredKeyFormatError();
    }
    const seed = await unwrapSeedWithPassword(
        password, wrap.wrap_salt, wrap.seed_wrapped_pw,
        wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
    );
    if (!seed) throw new Error('That password did not unlock the keys. Check it and try again.');
    setActiveIdentity(makeIdentity(seed));
    clearIdentityRestoreFailure();
}

/**
 * Reset a forgotten password using the recovery code, WITHOUT losing history.
 * Recovers the identity seed via the recovery-wrapped blob, proves possession
 * to the server (DH challenge), then rewrites the SRP verifier + password-
 * wrapped seed. The identity keypair is unchanged, so encrypted history stays
 * readable. Throws on invalid code / failed proof.
 */
export async function recoverWithCode(
    username: string,
    recoveryCode: string,
    newPassword: string
): Promise<void> {
    const challenge: {
        server_ephemeral: string;
        challenge: string;
        recovery_salt: string;
        seed_wrapped_rc: string;
        key_version: number;
    } = await apiClient.post('/auth/recovery/challenge', { username });

    const seed = await unwrapSeedWithRecovery(recoveryCode, challenge.recovery_salt, challenge.seed_wrapped_rc);
    if (!seed) throw new Error('Invalid recovery code.');

    const proof = computeRecoveryProof(seed, challenge.server_ephemeral, challenge.challenge, username.toLowerCase());
    if (!proof) throw new Error('Could not build recovery proof.');

    const { salt, verifier, srp_version } = await generateVerifierForReset(username, newPassword);
    const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(seed, newPassword);

    await apiClient.post('/auth/recovery/reset', {
        username,
        proof,
        new_salt_hex: salt,
        new_verifier_hex: verifier,
        new_srp_version: srp_version,
        new_wrap_salt: wrapSalt,
        new_seed_wrapped_pw: seedWrappedPw,
        new_pw_kdf_iterations: pwKdfIterations,
        new_pw_kdf: pwKdf,
    });
}

/**
 * Change the password while logged in. Proves knowledge of the CURRENT password
 * by unwrapping the identity seed with it (fails closed if wrong), then rewrites
 * the SRP verifier + password-wrapped seed under the NEW password. The identity
 * seed — and therefore all encrypted-history access — is unchanged, and the
 * recovery blob is untouched, so the existing recovery code keeps working.
 * Throws 'Current password is incorrect.' on a wrong current password.
 */
export async function changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
): Promise<void> {
    const wrap: {
        key_version: number;
        wrap_salt: string | null;
        seed_wrapped_pw: string | null;
        pw_kdf_iterations: number | null;
        pw_kdf: PwKdf | null;
    } = await apiClient.get('/keys/wrap');
    if (wrap.key_version < 3 || !wrap.wrap_salt || !wrap.seed_wrapped_pw) {
        throw new Error('This account is not set up for in-app password change. Use the recovery-code reset.');
    }
    // Prove the current password by unwrapping the seed with it (fails closed).
    const seed = await unwrapSeedWithPassword(
        currentPassword, wrap.wrap_salt, wrap.seed_wrapped_pw,
        wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
    );
    if (!seed) throw new Error('Current password is incorrect.');

    // Prove the CURRENT password to the SERVER as well. Unwrapping the seed
    // above proves it to US, but the server cannot check that claim — without
    // this it would accept a new verifier from anyone holding a bearer token.
    // No extra prompt: the password is already in hand for this form.
    await proveCurrentPassword(username, currentPassword);

    // New SRP verifier + a fresh (argon2id) password wrap of the SAME seed.
    const { salt, verifier, srp_version } = await generateVerifierForReset(username, newPassword);
    const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(seed, newPassword);

    await apiClient.post('/keys/change-password', {
        new_salt_hex: salt,
        new_verifier_hex: verifier,
        new_srp_version: srp_version,
        new_wrap_salt: wrapSalt,
        new_seed_wrapped_pw: seedWrappedPw,
        new_pw_kdf_iterations: pwKdfIterations,
        new_pw_kdf: pwKdf,
    });
}

/**
 * Mint a NEW 12-word recovery code for this account, retiring the old one.
 *
 * Until 0.9.2 the code existed exactly once: shown after registration, held
 * in a JS variable, gone on the first reload. A user who lost it had no
 * second chance, and the e-mail reset is refused for every E2EE account —
 * so forgetting the password meant losing the history. This is the second
 * chance. The identity seed is unchanged (history stays readable); only the
 * recovery-wrapped blob is replaced, alongside a fresh password wrap of the
 * same seed under the same password, because /keys/rewrap replaces the
 * whole custody row at once.
 *
 * Order matters and is the same as changePassword's: prove the password to
 * OURSELVES first by unwrapping the seed with it (a wrong password fails
 * here, locally, and never reaches the SRP exchange — whose 401 would trip
 * the session-expiry handler), then prove it to the SERVER, which refuses a
 * key-custody write on a bare bearer token. Only then is anything written.
 *
 * Resolves with the new phrase; the caller shows it through RecoveryCodeModal.
 * The OLD phrase stops working the instant the server accepts the write —
 * the UI says so before the user confirms.
 */
export async function regenerateRecoveryCode(username: string, currentPassword: string): Promise<string> {
    const wrap: {
        key_version: number;
        wrap_salt: string | null;
        seed_wrapped_pw: string | null;
        pw_kdf_iterations: number | null;
        pw_kdf: PwKdf | null;
    } = await apiClient.get('/keys/wrap');
    if (wrap.key_version < 3 || !wrap.wrap_salt || !wrap.seed_wrapped_pw) {
        throw new Error('This account is not set up for recovery codes. Ask your server operator.');
    }
    const seed = await unwrapSeedWithPassword(
        currentPassword, wrap.wrap_salt, wrap.seed_wrapped_pw,
        wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
    );
    if (!seed) throw new Error('Current password is incorrect.');

    await proveCurrentPassword(username, currentPassword);

    const { material, recoveryCode } = await buildWrapMaterial(seed, currentPassword);
    await apiClient.post('/keys/rewrap', {
        wrap_salt: material.wrapSalt,
        recovery_salt: material.recoverySalt,
        seed_wrapped_pw: material.seedWrappedPw,
        seed_wrapped_rc: material.seedWrappedRc,
        pw_kdf_iterations: material.pwKdfIterations,
        pw_kdf: material.pwKdf,
    });
    return recoveryCode;
}

/**
 * Tombstone the account. The current password is proven CLIENT-SIDE by
 * unwrapping the E2EE seed with it — the identical proof changePassword uses —
 * and then to the SERVER through an SRP exchange, because the server refuses
 * the delete on a bare bearer token (a stolen token must not be able to
 * destroy the account). It additionally requires the username retyped and
 * refuses while the user still owns servers. On success every outstanding
 * session is evicted.
 */
/**
 * Sign out on EVERY device, by bumping the account's `token_version`.
 *
 * `logout()` is deliberately local: `token_version` is per-USER and there is no
 * per-session claim, so bumping it on an ordinary sign-out would kick every
 * other device — signing out on a phone would drop a desktop mid-call. The
 * backend route to revoke account-wide has existed since the M1 work but nothing
 * in the UI ever called it, which left a user who believed a token was stolen
 * with no remedy short of changing their password.
 *
 * The caller's own token is invalidated too, so treat this as terminal: clear
 * local state and reload.
 */
export async function logoutEverywhere(): Promise<void> {
    await apiClient.post('/auth/logout', {});
}

export async function deleteAccount(username: string, currentPassword: string): Promise<void> {
    const wrap: {
        key_version: number;
        wrap_salt: string | null;
        seed_wrapped_pw: string | null;
        pw_kdf_iterations: number | null;
        pw_kdf: PwKdf | null;
    } = await apiClient.get('/keys/wrap');
    if (wrap.key_version < 3 || !wrap.wrap_salt || !wrap.seed_wrapped_pw) {
        throw new Error('This account is not set up for in-app deletion. Ask your server operator.');
    }
    const seed = await unwrapSeedWithPassword(
        currentPassword, wrap.wrap_salt, wrap.seed_wrapped_pw,
        wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
    );
    if (!seed) throw new Error('Password is incorrect.');
    // ...and to the SERVER, which refuses the delete on a bare bearer token.
    // The exchange carries our token, so the proof binds to THIS session.
    await proveCurrentPassword(username, currentPassword);
    await apiClient.delete('/account', { body: JSON.stringify({ confirm_username: username }) });
}

/**
 * Fetch the account's own rows from the server (GET /account/export) — the
 * raw document, ciphertext included. `api/accountExport.ts` opens what the
 * identity can and saves the result; this only does the credential half.
 *
 * Same shape as deleteAccount: the password is checked LOCALLY first (the
 * seed unwrap), which gives a clean "incorrect" without spending a login
 * attempt, then proven to the server, which refuses the export on a bare
 * bearer token — the whole account in one response is exactly what a stolen
 * token must not be able to fetch.
 */
export async function requestAccountExport(username: string, currentPassword: string): Promise<unknown> {
    const wrap: {
        key_version: number;
        wrap_salt: string | null;
        seed_wrapped_pw: string | null;
        pw_kdf_iterations: number | null;
        pw_kdf: PwKdf | null;
    } = await apiClient.get('/keys/wrap');
    if (wrap.key_version < 3 || !wrap.wrap_salt || !wrap.seed_wrapped_pw) {
        throw new Error('This account is not set up for in-app export. Ask your server operator.');
    }
    const seed = await unwrapSeedWithPassword(
        currentPassword, wrap.wrap_salt, wrap.seed_wrapped_pw,
        wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
    );
    if (!seed) throw new Error('Password is incorrect.');
    await proveCurrentPassword(username, currentPassword);
    return apiClient.get('/account/export');
}

/** Set (or change) the account email: sends a verification link to the new
 *  address; the address only becomes verified when that link is opened. */
export async function requestEmailChange(email: string): Promise<string> {
    const r = await apiClient.post('/auth/send-verification', { email }) as { message?: string };
    return r.message ?? 'Verification email sent';
}

export function getToken(): string | null {
    return localStorage.getItem('auth_token');
}

/**
 * Adopt a token the server handed back on an authenticated response (sliding
 * session renewal). Tokens are fixed-expiry with no refresh endpoint, so
 * without this every session died exactly 24 h after signing in — stranding
 * the app on a connection error whose Retry could never succeed.
 *
 * COMPARE-AND-SWAP on the token the request actually carried. A bare
 * "is something stored?" check isn't enough: responses can land minutes late,
 * so between send and receive the user may have signed out (slot empty — must
 * not resurrect) or signed out AND back in, possibly as a DIFFERENT user on a
 * shared device (slot holds someone else's token — installing this one would
 * silently authenticate them as the previous account).
 */
export function storeRenewedToken(sentWith: string, renewed: string): void {
    if (localStorage.getItem('auth_token') !== sentWith) return;
    localStorage.setItem('auth_token', renewed);
    // The native delivery socket authenticates with a COPY of this token
    // (Java cannot read localStorage). Announce the renewal so
    // pushRegistration re-syncs it — otherwise the native side keeps the old
    // token until it expires and background delivery dies 24h after login.
    try {
        window.dispatchEvent(new CustomEvent('authTokenRenewed'));
    } catch { /* non-DOM env (tests) */ }
}

export function isAuthenticated(): boolean {
    return localStorage.getItem('auth_token') !== null;
}

/**
 * Decode a JWT's payload to an object, correctly.
 *
 * Two things `JSON.parse(atob(part))` gets wrong, and both bit us:
 *
 *  1. UTF-8. `atob` yields a BINARY string — one character per byte — so a
 *     name like "Brónach" arrives as its raw UTF-8 bytes reinterpreted as
 *     Latin-1 and renders "BrÃ³nach". The same name coming back from the REST
 *     API was fine, because fetch decodes UTF-8 properly, which is why it
 *     looked correct in messages and wrong on the profile.
 *  2. base64url. JWT parts use `-` and `_`, which plain `atob` rejects, so a
 *     payload that happened to encode either character failed outright.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

/** The signed-in user's id from the stored JWT's `sub`. No verification —
 *  the server verifies tokens; this only decides which side of a pairwise or
 *  context binding we are. null when signed out or the token is malformed. */
export function currentUserIdFromToken(): number | null {
    const t = getToken();
    if (!t) return null;
    const p = decodeJwtPayload(t);
    return typeof p?.sub === 'number' ? p.sub : null;
}

/** Whether a JWT's `exp` has passed (with a small clock-skew margin). Local
 *  decode only — no verification needed; the server is the authority, this
 *  just lets the client stop hammering a token it can SEE is dead. Returns
 *  false for tokens it can't parse (server rejection then signals expiry). */
export function isTokenExpired(token: string | null): boolean {
    if (!token) return false;
    try {
        const payload = decodeJwtPayload(token);
        if (!payload) return false;
        if (typeof payload.exp !== 'number') return false;
        return payload.exp * 1000 < Date.now() - 30_000;
    } catch {
        return false;
    }
}

/**
 * The session died out from under the user (expired token) — drop ONLY the
 * token so the login screen shows. Deliberately NOT logout(): that clears the
 * E2EE identity/seed, and a mere re-authentication should never risk the
 * user's keys — after signing back in, everything decrypts as before.
 */
/**
 * Where "Remember me" stores the credential blob it replays on next launch.
 * Lives here rather than in Login.tsx so `logout()` cannot drift from the
 * component that writes it — that drift is exactly what made sign-out a no-op.
 */
export const REMEMBER_ME_KEY = 'sovereign_remember';

export function softExpireSession(): void {
    localStorage.removeItem('auth_token');
    // Deliberately KEEPS the remember-me blob: a soft expiry is precisely the
    // case it exists for, and clearing it here would log the user out for good
    // every time their token aged out.
}

export function logout(): void {
    // Revoke this BROWSER's device row before the token goes, then forget the id.
    //
    // Scrubbing the web device key below without this left the server row alive:
    // the next sign-in attested a stale id with a freshly generated key, was
    // silently refused, and enrolled ANOTHER row — so a habitual sign-out/sign-in
    // user walked their account toward the 64-device cap while their Devices tab
    // filled with ghosts.
    //
    // WEB ONLY. On desktop and mobile the enrolled device is the MACHINE, with
    // its key held natively rather than in localStorage; revoking that on an
    // ordinary sign-out would tear down the user's own remote-desktop host and
    // require physical access to restore it. Those platforms keep their identity
    // across sign-out, which is the behaviour that was there before.
    // ONE gate for both halves. The revoke and the key scrub have to agree: if
    // the key is destroyed while the row survives, the next sign-in attests a
    // stale id with a fresh key, is silently refused, and enrols ANOTHER row —
    // so a habitual sign-out/sign-in user walks toward the 64-device cap with a
    // Devices tab full of ghosts. A first cut gated the revoke on web-only but
    // left the scrub unconditional, which produced exactly that on iOS/Android.
    let revokedThisDevice = false;
    if (!isTauri() && !isMobile()) {
        const devId = thisDeviceId();
        if (devId) {
            // Fire-and-forget: the token is still valid on this line, and a
            // failed revoke must not block the user from signing out.
            void apiClient.delete(`/devices/${encodeURIComponent(devId)}`).catch(() => { /* best effort */ });
            revokedThisDevice = true;
        }
        clearThisDeviceId();
    }
    // Revoke THIS session server-side (per-session: other devices stay signed
    // in). Fire-and-forget — the token is still valid on this line, and a
    // failed revoke must not block the sign-out.
    void apiClient.post('/auth/logout-session', {}).catch(() => { /* best effort */ });
    localStorage.removeItem('auth_token');
    // An explicit sign-out has to remove this, or it is not a sign-out. Login's
    // mount effect replays the blob unconditionally, so clearing only the token
    // sent the user to /login and straight back into the account — with no way
    // out from inside the app, since the blob is only cleared by signing in
    // again with the box unticked, which requires being signed out.
    localStorage.removeItem(REMEMBER_ME_KEY);
    clearActiveIdentity(); // Clear E2EE identity on logout
    clearIdentityRestoreFailure(); // a missing identity is not missing once signed out
    clearChannelKeyCache();
    // Secrets and personal data that outlived a sign-out. Everything below is
    // either a private key or a real-world location, and none of it belongs to
    // the NEXT person to use this browser profile.
    //   - the web device private key, which identifies this browser as an
    //     enrolled device of the account that just signed out;
    //   - saved task places, which are home/work COORDINATES.
    // Deliberately KEPT: `verified_key_*` and `control_pin_*`. Those are
    // trust-on-first-use anchors against a server substituting a peer's identity
    // key, and wiping them on every sign-out would hand a malicious server a
    // fresh substitution window at each login — the opposite of hygiene.
    const scrub = ['sovereignTaskPlaces', 'sovereignTaskPlaceAssign'];
    // The device key goes only where the row above was revoked with it. On
    // Tauri and Capacitor the enrolled device is the MACHINE and its identity
    // must survive an ordinary sign-out, or the user's own remote-desktop host
    // is torn down and needs physical access to restore.
    // Only when the row was actually revoked with it. Signing out before the
    // socket has attested leaves `thisDeviceId()` null and nothing to revoke —
    // dropping the key there would strand the existing row and enrol a fresh one
    // on the next sign-in, which is the very ghost this is meant to prevent.
    // Keeping it lets the next session re-attest as the SAME device.
    if (revokedThisDevice) scrub.push('sovereign_device_key_v1');
    for (const k of scrub) {
        try { localStorage.removeItem(k); } catch { /* private mode */ }
    }
    // Task places are stored per-user (`<key>: <uid>`), so remove those too.
    try {
        for (const k of Object.keys(localStorage)) {
            if (k.startsWith('sovereignTaskPlaces') || k.startsWith('sovereignTaskPlaceAssign')) {
                localStorage.removeItem(k);
            }
        }
    } catch { /* private mode */ }
    resetIceConfigCache(); // Don't reuse this user's TURN credentials post-logout
    clearBlobCache(); // Revoke decrypted-attachment object URLs (shared-session hygiene)
    // Feature-owned teardown, reached through a registry rather than by
    // importing the features themselves — see api/logoutHooks.ts for why.
    // Covers, in a build where those features are present:
    //  - remembered unattended seeds, which grant SYSTEM-level control of this
    //    user's machines and so of everything on this hygiene list are what
    //    must least survive a sign-out on a shared browser;
    //  - any in-flight "wake then connect" wait, which belongs to the account
    //    that just signed out. Left running, its 5s poll keeps calling
    //    /devices with a dead token — each one a 401 that trips the global
    //    auth-expired handling — for up to three minutes.
    runLogoutCleanups();
}

/**
 * Reset password for migrated users (force_password_reset=true)
 * Generates new SRP salt/verifier and sends to backend
 */
export async function resetPasswordMigration(username: string, newPassword: string): Promise<void> {

    // Fresh salt and verifier under the current derivation.
    const { salt, v: vBig } = freshVerifier(username, newPassword);

    // 3. Send to backend
    // Need to pad verifier to match key size (2048 bits / 256 bytes) if needed
    let vHex = vBig.toString(16);
    if (vHex.length % 2 !== 0) vHex = '0' + vHex;

    await apiClient.post('/auth/reset-password-migration', {
        username,
        salt_hex: bytesToHex(salt),
        verifier_hex: vHex,
        srp_version: SRP_VERSION_CURRENT,
    });
}

/**
 * Internals exposed ONLY for tests. Not part of the module's API: the SRP
 * maths is matched to a Rust implementation and a test that cannot reach these
 * cannot prove they still agree.
 */
export const __testing = {
    modPowSecret, modPowPublic, N, g, N_BYTES, getK, H,
    computeIdentityHash, computeX, computeXv2, computeXFor, computeVerifier,
    computeU, computeM1, computeM2,
    hexToBigInt, hexToBytes, bytesToHex, bigIntToMinimalBytes, bigIntToPaddedHex,
    SRP_VERSION_CURRENT,
};
