/**
 * Positive control for the DM-decrypt pin fix.
 *
 * decryptDMContent must resolve the partner's identity key through the same
 * TOFU-pin / verification path the SEND side uses (resolvePinnedIdentityKey),
 * not the raw server cache. If the served key differs from the pinned/verified
 * value — a server key-substitution — resolvePinnedIdentityKey returns null and
 * decryption MUST refuse (show the unverified-sender marker) rather than decrypt
 * with the substituted key and render forged content as an authentic message.
 *
 * Against the vulnerable build (which used getCachedPublicKey) the mocked
 * decryptDM below would run and this test's expectation would fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { ENC_UNVERIFIED_SENDER } from '../api/decryptMarkers';

const ME = 42;
const PARTNER = 7;

vi.mock('../api/auth', () => ({
    getToken: () => 'header.payload.sig',
    decodeJwtPayload: () => ({ sub: ME, username: 'me' }),
    currentUserIdFromToken: () => ME,
}));

// decryptDM would return real plaintext if it were ever reached — reaching it
// with an unverified key is exactly the bug.
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) }),
    decryptDM: async () => 'FORGED-PLAINTEXT-SHOULD-NEVER-SHOW',
    decryptSelf: async () => 'self-plaintext',
    parseEnvelope: (s: string) => { try { return JSON.parse(s); } catch { return null; } },
    parseEnvelopeEx: (s: string) => {
        try { const e = JSON.parse(s); return e ? { kind: 'envelope', env: e } : { kind: 'plaintext' }; } catch { return { kind: 'plaintext' }; }
    },
    serializeEnvelope: (e: unknown) => JSON.stringify(e),
    SecureSendError: class extends Error {},
}));

// The pin path fails closed: the served key changed from what we pinned/verified.
vi.mock('../api/keyVerification', () => ({
    resolvePinnedIdentityKey: async () => null,
}));

vi.mock('../api/client', () => ({
    // A malicious server still happily serves a (substituted) key here; the
    // point of the fix is that decrypt no longer trusts this path.
    apiClient: { get: async () => ({ public_key: 'x25519:SUBSTITUTED' }) },
}));

import { decryptDMContent } from '../api/dms';

describe('DM decrypt refuses an unverifiable sender key', () => {
    it('shows the unverified-sender marker instead of decrypting with a substituted key', async () => {
        const env = JSON.stringify({ v: 2, t: 'dm', ct: 'CIPHERTEXT' });
        const out = await decryptDMContent(env, PARTNER, PARTNER);
        expect(out).toBe(ENC_UNVERIFIED_SENDER);
        expect(out).not.toContain('FORGED-PLAINTEXT');
    });
});
