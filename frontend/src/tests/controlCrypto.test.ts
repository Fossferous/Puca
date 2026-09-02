import { describe, it, expect, beforeAll } from 'vitest';
import {
    generateControlEphemeral,
    deriveControlSessionKey,
    sealControl,
    openControl,
    encryptDM,
    computeSafetyNumber,
} from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const SALT_A = 'a1'.repeat(16);
const SALT_B = 'b2'.repeat(16);

// Static identities are fixtures, not the thing under test, and each costs a
// 210k-iteration PBKDF2 (~380ms). `handshake()` derived two per call, so the
// tests that ran it twice sat at ~1.5s idle and flaked past the 5s default
// under load. Warm them once; the tests keep the strict default timeout.
// Spread these tuples at the call sites so the warm list cannot drift.
const HOST = ['hostpw', SALT_A] as const;
const VIEWER = ['viewerpw', SALT_B] as const;
const ATTACKER = ['attackerpw', 'c3'.repeat(16)] as const;
const ALICE = ['alicepw', SALT_A] as const;
const BOB = ['bobpw', SALT_B] as const;
const MITM = ['mitmpw', 'c3'.repeat(16)] as const;

beforeAll(() => warmIdentities([HOST, VIEWER, ATTACKER, ALICE, BOB, MITM]), WARM_TIMEOUT_MS);

// Simulate the handshake: viewer and host each mint an ephemeral, exchange
// public keys, and derive the session key from their own priv + the peer's pubs.
// The static identities are held constant across calls (they are deterministic
// either way), so a session-key difference can only come from the fresh
// ephemerals — which is exactly the property the replay test asserts.
async function handshake() {
    const host = await testIdentity(...HOST);
    const viewer = await testIdentity(...VIEWER);
    const hostEph = generateControlEphemeral();
    const viewerEph = generateControlEphemeral();
    const viewerKey = deriveControlSessionKey(viewer.privateKey, host.publicKeyEncoded, viewerEph.priv, hostEph.pubEncoded)!;
    const hostKey = deriveControlSessionKey(host.privateKey, viewer.publicKeyEncoded, hostEph.priv, viewerEph.pubEncoded)!;
    return { host, viewer, hostEph, viewerEph, viewerKey, hostKey };
}

describe('remote-control per-session crypto (ephemeral handshake)', () => {
    it('host and viewer derive the same session key from crossed ephemeral+static DH', async () => {
        const { viewerKey, hostKey } = await handshake();
        expect(Buffer.from(viewerKey)).toEqual(Buffer.from(hostKey));
    });

    it('round-trips a sealed control payload with no plaintext leak', async () => {
        const { viewerKey, hostKey } = await handshake();
        const payload = JSON.stringify({ s: 1, e: { t: 'key', code: 'KeyA', down: true } });
        const sealed = await sealControl(viewerKey, payload);
        expect(sealed).not.toContain('KeyA');
        expect(await openControl(hostKey, sealed)).toBe(payload);
    });

    it('gives a DIFFERENT key each session (defeats cross-session replay)', async () => {
        const s1 = await handshake();
        const s2 = await handshake();
        expect(Buffer.from(s1.viewerKey)).not.toEqual(Buffer.from(s2.viewerKey));
        // A frame sealed in session 1 must NOT open under session 2's key.
        const sealed = await sealControl(s1.viewerKey, JSON.stringify({ s: 1, e: { t: 'down', button: 0 } }));
        expect(await openControl(s2.hostKey, sealed)).toBeNull();
    });

    it('is domain-separated from the DM key (a DM ciphertext cannot open as control)', async () => {
        const { host, viewer, hostKey } = await handshake();
        const dm = await encryptDM(viewer, host.publicKeyEncoded, 'secret dm', { senderId: 1, recipientId: 2 });
        expect(await openControl(hostKey, dm!.ct)).toBeNull();
    });

    it('fails to agree if the static identity is wrong (authenticates the peer)', async () => {
        const { host, hostEph, viewerEph, viewerKey } = await handshake();
        const attacker = await testIdentity(...ATTACKER);
        // Host computes with the ATTACKER's static key instead of the viewer's →
        // a different key → viewer's sealed frame won't open.
        const wrongHostKey = deriveControlSessionKey(host.privateKey, attacker.publicKeyEncoded, hostEph.priv, viewerEph.pubEncoded)!;
        const sealed = await sealControl(viewerKey, JSON.stringify({ s: 1, e: { t: 'down', button: 0 } }));
        expect(await openControl(wrongHostKey, sealed)).toBeNull();
    });

    it('returns null (does not throw) for a low-order/zero peer ephemeral', async () => {
        const { viewer, host, viewerEph } = await handshake();
        const zeroPoint = 'x25519:' + Buffer.alloc(32).toString('base64'); // all-zero u
        // Must fail closed as null so callers tear down, not throw an unhandled rejection.
        expect(deriveControlSessionKey(viewer.privateKey, host.publicKeyEncoded, viewerEph.priv, zeroPoint)).toBeNull();
    });

    it('rejects a tampered ciphertext (integrity)', async () => {
        const { viewerKey, hostKey } = await handshake();
        const sealed = await sealControl(viewerKey, JSON.stringify({ s: 1, e: { t: 'down', button: 0 } }));
        const bytes = Buffer.from(sealed, 'base64');
        bytes[bytes.length - 1] ^= 0x01;
        expect(await openControl(hostKey, bytes.toString('base64'))).toBeNull();
    });
});

describe('safety number (out-of-band verification)', () => {
    it('both parties compute the same number regardless of argument order', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const fromA = computeSafetyNumber(a.publicKeyEncoded, b.publicKeyEncoded);
        const fromB = computeSafetyNumber(b.publicKeyEncoded, a.publicKeyEncoded);
        expect(fromA).toBe(fromB);
        expect(fromA).toMatch(/^(\d{5} ){7}\d{5}$/); // 8 groups of 5 digits
    });

    it('differs when a key is substituted (MITM is detectable)', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const mitm = await testIdentity(...MITM);
        // Alice sees her key + Bob's; if the server swaps Bob for the MITM key,
        // Alice's number changes, so it won't match what Bob sees.
        const honest = computeSafetyNumber(a.publicKeyEncoded, b.publicKeyEncoded);
        const mitmed = computeSafetyNumber(a.publicKeyEncoded, mitm.publicKeyEncoded);
        expect(mitmed).not.toBe(honest);
    });

    it('returns null for an invalid key', async () => {
        const a = await testIdentity(...ALICE);
        expect(computeSafetyNumber(a.publicKeyEncoded, 'not-a-key')).toBeNull();
    });
});
