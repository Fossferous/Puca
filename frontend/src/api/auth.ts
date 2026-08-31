/**
 * SRP Authentication Module for Puca
 * 
 * Custom SRP-6a implementation compatible with the Rust srp crate (v0.6.0).
 * 
 * CRITICAL: Rust's BigUint::to_bytes_be() produces MINIMAL representation
 * (no leading zeros). All hash inputs must use minimal byte representation.
 */

import { apiClient } from './client';

// SRP-2048 group parameters from RFC 5054
const N_HEX = 'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73';
const G_HEX = '02';

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

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
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
 * Compute x = H(salt | identity_hash)
 */
async function computeX(salt: Uint8Array, identityHash: Uint8Array): Promise<bigint> {
    const xHash = await H(salt, identityHash);
    return BigInt('0x' + bytesToHex(xHash));
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
    deriveIdentity, setActiveIdentity, clearActiveIdentity,
    generateIdentitySeed, makeIdentity, buildWrapMaterial,
    unwrapSeedWithPassword, unwrapSeedWithRecovery, rewrapForNewPassword,
    passwordWrapNeedsUpgrade, upgradePasswordWrap,
    computeRecoveryProof,
    type PwKdf,
} from './e2ee';
import { setPendingRecoveryCode } from './recoveryPrompt';
import { clearChannelKeyCache } from './channelKeys';
import { resetIceConfigCache } from './iceConfig';
import { clearBlobCache } from './attachments';
// Feature teardown is REGISTERED, not imported. Importing the device modules
// here put auth.ts — which sits on nearly every import path — into an import
// cycle with api/devices/index.ts, dragging the whole remote-control stack
// into the main chunk of every build. See api/logoutHooks.ts.
import { runLogoutCleanups } from './logoutHooks';

// ============ Public API ============

export async function register(username: string, password: string, inviteCode?: string): Promise<void> {
    const salt = randomBytes(32); // 32 bytes = 64 hex chars (SRP salt)
    const identityHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, identityHash);
    const v = computeVerifier(x);
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
    // Surfaced by RecoveryCodeModal after the user logs in.
    setPendingRecoveryCode(recoveryCode);
}

/**
 * Generate new SRP verifier for password reset
 * Returns salt and verifier in hex format
 */
export async function generateVerifierForReset(username: string, password: string): Promise<{ salt: string; verifier: string }> {
    const salt = randomBytes(32); // 32 bytes = 64 hex chars
    const identityHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, identityHash);
    const v = computeVerifier(x);

    return {
        salt: bytesToHex(salt),
        verifier: bigIntToPaddedHex(v, N_BYTES),
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

    const step1Response: { salt_hex: string; b_pub_hex: string; attempt_id?: string } = await apiClient.post('/auth/login/step1', {
        username,
        a_pub_hex: bigIntToPaddedHex(A, N_BYTES),
    });
    const { salt_hex, b_pub_hex, attempt_id } = step1Response;

    const salt = hexToBytes(salt_hex);
    const B = hexToBigInt(b_pub_hex);
    if (B % N === 0n) throw new Error('Invalid server public key');

    const u = await computeU(A, B);
    if (u === 0n) throw new Error('Invalid scrambling parameter');

    const identityHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, identityHash);
    const S = await computeClientSession(a, B, x, u);
    const K = bigIntToMinimalBytes(S);
    const M1 = await computeM1(A, B, K);

    const step2Response: { hamk_hex: string; token: string } = await apiClient.post('/auth/login/step2', {
        username,
        m_hex: bytesToHex(M1),
        ...(attempt_id ? { attempt_id } : {}),
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
    await srpExchange(username, password);
}

export async function login(username: string, password: string): Promise<string> {
    // Step 1: Generate ephemeral and send A
    const { a, A } = generateClientEphemeral();

    const step1Response: { salt_hex: string; b_pub_hex: string; attempt_id?: string } = await apiClient.post('/auth/login/step1', {
        username,
        a_pub_hex: bigIntToPaddedHex(A, N_BYTES),
    });

    const { salt_hex, b_pub_hex, attempt_id } = step1Response;

    // Parse server response
    const salt = hexToBytes(salt_hex);
    const B = hexToBigInt(b_pub_hex);

    if (B % N === 0n) {
        throw new Error('Invalid server public key');
    }

    // Compute session
    const u = await computeU(A, B);
    if (u === 0n) {
        throw new Error('Invalid scrambling parameter');
    }

    const identityHash = await computeIdentityHash(username, password);
    const x = await computeX(salt, identityHash);
    const S = await computeClientSession(a, B, x, u);

    // The Rust srp crate uses S directly (not H(S)) for M1 computation
    // In process_reply: let m1 = compute_m1(&a_pub.to_bytes_be(), &b_pub.to_bytes_be(), &key.to_bytes_be());
    // where 'key' is the raw premaster secret S, not H(S)
    const K = bigIntToMinimalBytes(S);

    const M1 = await computeM1(A, B, K);

    const step2Response: { hamk_hex: string; token: string } = await apiClient.post('/auth/login/step2', {
        username,
        m_hex: bytesToHex(M1),
        ...(attempt_id ? { attempt_id } : {}),
    });

    const { hamk_hex, token } = step2Response;

    // Verify server's proof
    const expectedM2 = await computeM2(A, M1, K);
    if (hamk_hex.toLowerCase() !== bytesToHex(expectedM2).toLowerCase()) {
        throw new Error('Server verification failed - possible MITM attack');
    }

    localStorage.setItem('auth_token', token);

    // Restore the E2EE identity. v3: unwrap the random seed with the password.
    // v2 (legacy): derive the old password-based seed, then transparently
    // migrate to v3 — freeze that SAME seed under password + a new recovery
    // code, so no history is lost and future resets become recoverable.
    try {
        const wrap: {
            key_version: number;
            wrap_salt: string | null;
            seed_wrapped_pw: string | null;
            pw_kdf_iterations: number | null;
            pw_kdf: PwKdf | null;
        } = await apiClient.get('/keys/wrap');

        if (wrap.key_version >= 3 && wrap.wrap_salt && wrap.seed_wrapped_pw) {
            const seed = await unwrapSeedWithPassword(
                password, wrap.wrap_salt, wrap.seed_wrapped_pw,
                wrap.pw_kdf_iterations ?? undefined, wrap.pw_kdf ?? undefined,
            );
            if (!seed) throw new Error('seed unwrap failed (password/key mismatch)');
            setActiveIdentity(makeIdentity(seed));
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
            // Legacy v2 → derive the old password-derived identity...
            const identity = await deriveIdentity(password, salt_hex);
            setActiveIdentity(identity);
            await apiClient.patch('/keys/public', { public_key: identity.publicKeyEncoded });
            // ...then freeze it under v3 wrap material (same seed = same keys).
            const { material, recoveryCode } = await buildWrapMaterial(identity.privateKey, password);
            await apiClient.post('/keys/migrate-v3', {
                wrap_salt: material.wrapSalt,
                recovery_salt: material.recoverySalt,
                seed_wrapped_pw: material.seedWrappedPw,
                seed_wrapped_rc: material.seedWrappedRc,
                pw_kdf_iterations: material.pwKdfIterations,
                pw_kdf: material.pwKdf,
            });
            setPendingRecoveryCode(recoveryCode); // shown once by RecoveryCodeModal
        }
    } catch (e) {
        console.warn('E2EE identity setup failed; messaging may be unavailable until next login', e);
    }

    return token;
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

    const { salt, verifier } = await generateVerifierForReset(username, newPassword);
    const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(seed, newPassword);

    await apiClient.post('/auth/recovery/reset', {
        username,
        proof,
        new_salt_hex: salt,
        new_verifier_hex: verifier,
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
    const { salt, verifier } = await generateVerifierForReset(username, newPassword);
    const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(seed, newPassword);

    await apiClient.post('/keys/change-password', {
        new_salt_hex: salt,
        new_verifier_hex: verifier,
        new_wrap_salt: wrapSalt,
        new_seed_wrapped_pw: seedWrappedPw,
        new_pw_kdf_iterations: pwKdfIterations,
        new_pw_kdf: pwKdf,
    });
}

/**
 * Tombstone the account. The current password is proven CLIENT-SIDE by
 * unwrapping the E2EE seed with it — the identical proof changePassword uses —
 * so a stolen session token alone can't drive this flow. The server
 * additionally requires the username retyped and refuses while the user still
 * owns servers. On success every outstanding session is evicted.
 */
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
    await apiClient.delete('/account', { body: JSON.stringify({ confirm_username: username }) });
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
    localStorage.removeItem('auth_token');
    // An explicit sign-out has to remove this, or it is not a sign-out. Login's
    // mount effect replays the blob unconditionally, so clearing only the token
    // sent the user to /login and straight back into the account — with no way
    // out from inside the app, since the blob is only cleared by signing in
    // again with the box unticked, which requires being signed out.
    localStorage.removeItem(REMEMBER_ME_KEY);
    clearActiveIdentity(); // Clear E2EE identity on logout
    clearChannelKeyCache();
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

    // 1. Generate new random salt
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);

    // 2. Compute new verifier (using lowercase username)
    // x = H(s, H(I | ":" | P))
    const identityHash = await computeIdentityHash(username, newPassword);
    const x = await H(salt, identityHash);

    // v = g^x % N
    const xBig = BigInt('0x' + bytesToHex(x));
    const gBig = BigInt('0x' + G_HEX);
    const NBig = BigInt('0x' + N_HEX);
    const vBig = modPow(gBig, xBig, NBig);

    // 3. Send to backend
    // Need to pad verifier to match key size (2048 bits / 256 bytes) if needed
    let vHex = vBig.toString(16);
    if (vHex.length % 2 !== 0) vHex = '0' + vHex;

    await apiClient.post('/auth/reset-password-migration', {
        username,
        salt_hex: bytesToHex(salt),
        verifier_hex: vHex,
    });
}
