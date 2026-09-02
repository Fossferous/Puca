/**
 * A DM to YOURSELF must use the self key, not the pairwise DM exchange.
 *
 * You are an ordinary DM recipient now (which is what lets a large file move
 * between your own PC and phone — the peer-to-peer path only offers inside a
 * DM). Encrypting those to yourself via ECDH against your own public key would
 * technically round-trip, but it makes a message only you can ever read depend
 * on the SERVER returning your own public key correctly. The self key is HKDF
 * over your private key: no key exchange, nothing for the server to substitute.
 *
 * This is invisible from the outside — both shapes decrypt fine in the happy
 * path — so it needs pinning explicitly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ME = 42;
const SOMEONE_ELSE = 99;

vi.mock('../api/auth', () => ({
    getToken: () => 'header.payload.sig',
    decodeJwtPayload: () => ({ sub: ME, username: 'me' }),
    currentUserIdFromToken: () => ME,
}));

// Record which encryption path was taken.
const calls: string[] = [];
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ privateKey: new Uint8Array(32), publicKey: new Uint8Array(32) }),
    encryptDM: async () => { calls.push('dm'); return { v: 2, t: 'dm', ct: 'DM-CIPHERTEXT' }; },
    decryptDM: async () => 'dm-plaintext',
    encryptSelf: async () => { calls.push('self'); return { v: 2, t: 'self', ct: 'SELF-CIPHERTEXT' }; },
    decryptSelf: async () => 'self-plaintext',
    parseEnvelope: (s: string) => {
        try { return JSON.parse(s); } catch { return null; }
    },
    parseEnvelopeEx: (s: string) => {
        try { const e = JSON.parse(s); return e ? { kind: 'envelope', env: e } : { kind: 'plaintext' }; } catch { return { kind: 'plaintext' }; }
    },
    serializeEnvelope: (e: unknown) => JSON.stringify(e),
    SecureSendError: class extends Error {},
}));
vi.mock('../api/keyVerification', () => ({
    resolvePinnedIdentityKey: async () => new Uint8Array(32),
}));
// getCachedPublicKey resolves the partner key through apiClient; the 'dm'
// path needs it to return something so the comparison against the SELF path
// is like-for-like.
vi.mock('../api/client', () => ({
    apiClient: { get: async () => ({ public_key: 'x25519:AAAA' }) },
}));

import { encryptDMContent, decryptDMContent } from '../api/dms';

beforeEach(() => { calls.length = 0; });

describe('self-DM encryption', () => {
    it('uses the SELF key when the recipient is you', async () => {
        const out = await encryptDMContent('a note to myself', ME);
        expect(calls).toEqual(['self']);
        expect(out).toContain('SELF-CIPHERTEXT');
    });

    it('still uses the pairwise DM key for anyone else', async () => {
        const out = await encryptDMContent('hello', SOMEONE_ELSE);
        expect(calls).toEqual(['dm']);
        expect(out).toContain('DM-CIPHERTEXT');
    });

    it('decrypts a self envelope without needing any public key', async () => {
        const env = JSON.stringify({ v: 2, t: 'self', ct: 'SELF-CIPHERTEXT' });
        expect(await decryptDMContent(env, ME, ME)).toBe('self-plaintext');
    });

    it('still decrypts ordinary dm envelopes', async () => {
        const env = JSON.stringify({ v: 2, t: 'dm', ct: 'DM-CIPHERTEXT' });
        expect(await decryptDMContent(env, SOMEONE_ELSE, SOMEONE_ELSE)).toBe('dm-plaintext');
    });

    it('passes through content that is not an envelope at all', async () => {
        // Legacy plaintext rows must not be mangled into an error string.
        expect(await decryptDMContent('just text', ME, ME)).toBe('just text');
    });
});
