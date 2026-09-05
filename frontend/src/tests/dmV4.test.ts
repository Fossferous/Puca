// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
    makeIdentity, generateIdentitySeed, generateX25519Keypair, keypairFromPrivate,
    sealDmEnvelopeV4, openDmEnvelopeV4, serializeEnvelope, parseEnvelopeEx, isEncrypted,
    wrapKeyUnderRecovery, unwrapKeyUnderRecovery, generateRecoveryCode,
    markUnexpectedPlaintext, liveEncState, messageEncState,
    MAX_READABLE_ENVELOPE_VERSION, type Envelope, type DmContext,
} from '../api/e2ee';
import { v4Eligible, v4Targets, type DmKeyInfo } from '../api/dmKeys';
import { ENC_HISTORY_LOCKED, isUndecryptable } from '../api/decryptMarkers';

/**
 * DM envelope v4: a per-message key wrapped to session keys and history keys,
 * authenticated under the pairwise identity. What each test would catch is
 * named; the pure gating rule and the SEC-04 classifier are pinned too.
 */

const alice = makeIdentity(generateIdentitySeed());
const bob = makeIdentity(generateIdentitySeed());
const ctx: DmContext = { senderId: 1, recipientId: 2 };
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe('sealDmEnvelopeV4 / openDmEnvelopeV4', () => {
    it('round-trips to every wrapped key, and the wire is a v4 DM envelope', async () => {
        const bobSession = generateX25519Keypair();
        const bobHistory = generateX25519Keypair();
        const aliceSession = generateX25519Keypair();
        const env = (await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [bobSession.publicKeyEncoded, bobHistory.publicKeyEncoded, aliceSession.publicKeyEncoded], 'hello bob', ctx))!;
        expect(env.v).toBe(4);
        expect(env.w).toHaveLength(3);
        const wire = serializeEnvelope(env);
        expect(isEncrypted(wire)).toBe(true);
        expect(parseEnvelopeEx(wire).kind).toBe('envelope');
        // Bob, live, on the device that holds the session key:
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [bobSession])).toEqual({ kind: 'ok', plaintext: 'hello bob' });
        // Bob, on a new device that has unlocked history:
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [bobHistory])).toEqual({ kind: 'ok', plaintext: 'hello bob' });
        // Alice reading her own sent message on her device:
        expect(await openDmEnvelopeV4(alice, bob.publicKeyEncoded, env, ctx, [aliceSession])).toEqual({ kind: 'ok', plaintext: 'hello bob' });
    });

    it('THE PROPERTY: the identity keys alone open nothing', async () => {
        // A database copy plus a cracked password yields both identity seeds.
        // With v4 that is not enough: no wrap is addressed to a key derived
        // from either identity. (v3 would decrypt here — that is SEC-03.)
        const bobSession = generateX25519Keypair();
        const env = (await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [bobSession.publicKeyEncoded], 'secret', ctx))!;
        const identityAsKey = keypairFromPrivate(bob.privateKey);
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [identityAsKey])).toEqual({ kind: 'locked' });
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [])).toEqual({ kind: 'locked' });
        // and a key that was simply never a target is not one either
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [generateX25519Keypair()])).toEqual({ kind: 'locked' });
    });

    it('is authenticated: a forged envelope with valid wraps to the real session key is rejected', async () => {
        // A malicious server knows every (public) session key. Let it seal a
        // message "from Alice" under its own identity: the wraps open fine, the
        // MAC does not, and the recipient must never see the text.
        const bobSession = generateX25519Keypair();
        const mallory = makeIdentity(generateIdentitySeed());
        const forged = (await sealDmEnvelopeV4(mallory, bob.publicKeyEncoded, [bobSession.publicKeyEncoded], 'wire the money', ctx))!;
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, forged, ctx, [bobSession])).toEqual({ kind: 'bad' });
    });

    it('is tamper-evident: altering the body, a wrap, or the context breaks the MAC', async () => {
        const bobSession = generateX25519Keypair();
        const env = (await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [bobSession.publicKeyEncoded], 'as sent', ctx))!;
        const flip = (s: string) => s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
        const bodyTampered: Envelope = { ...env, ct: flip(env.ct) };
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, bodyTampered, ctx, [bobSession])).toEqual({ kind: 'bad' });
        const extraWrap: Envelope = { ...env, w: [...env.w!, { ...env.w![0], to: generateX25519Keypair().publicKeyEncoded }] };
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, extraWrap, ctx, [bobSession])).toEqual({ kind: 'bad' });
        const removedWrap: Envelope = { ...env, w: [] };
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, removedWrap, ctx, [bobSession])).toEqual({ kind: 'bad' });
        // The same envelope presented as the other direction (context is in the MAC and the AAD).
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, { senderId: 2, recipientId: 1 }, [bobSession])).toEqual({ kind: 'bad' });
        // POSITIVE CONTROL for this rig: untouched, it opens.
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [bobSession])).toEqual({ kind: 'ok', plaintext: 'as sent' });
    });

    it('a wrap addressed to us that does not open is tampering, not "locked"', async () => {
        const bobSession = generateX25519Keypair();
        const env = (await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [bobSession.publicKeyEncoded], 'x', ctx))!;
        // Same envelope, but Bob's device now holds a DIFFERENT private key for
        // the same published public key string (a corrupted key store). The MAC
        // still verifies; the wrap for "us" fails to open → bad, not locked.
        const wrongKey = { ...generateX25519Keypair(), publicKeyEncoded: bobSession.publicKeyEncoded };
        expect(await openDmEnvelopeV4(bob, alice.publicKeyEncoded, env, ctx, [wrongKey])).toEqual({ kind: 'bad' });
    });

    it('refuses to seal to a malformed target rather than sealing to fewer keys', async () => {
        const good = generateX25519Keypair();
        expect(await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [good.publicKeyEncoded, 'x25519:not-a-key'], 'x', ctx)).toBeNull();
        expect(await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [], 'x', ctx)).toBeNull();
    });

    it('de-duplicates targets and fails closed on a bad peer key', async () => {
        const k = generateX25519Keypair();
        const env = (await sealDmEnvelopeV4(alice, bob.publicKeyEncoded, [k.publicKeyEncoded, k.publicKeyEncoded], 'x', ctx))!;
        expect(env.w).toHaveLength(1);
        expect(await sealDmEnvelopeV4(alice, 'garbage', [k.publicKeyEncoded], 'x', ctx)).toBeNull();
    });
});

describe('the reader', () => {
    it('reads v4 for DMs only; a v4 channel or self envelope is unsupported, and v5 stays unsupported', () => {
        expect(MAX_READABLE_ENVELOPE_VERSION).toBe(4);
        expect(parseEnvelopeEx(JSON.stringify({ v: 4, t: 'dm', ct: 'AAAA', w: [], mac: 'AA' })).kind).toBe('envelope');
        expect(parseEnvelopeEx(JSON.stringify({ v: 4, t: 'ch', epoch: 1, ct: 'AAAA' }))).toEqual({ kind: 'unsupported-version', v: 4 });
        expect(parseEnvelopeEx(JSON.stringify({ v: 4, t: 'self', ct: 'AAAA' }))).toEqual({ kind: 'unsupported-version', v: 4 });
        expect(parseEnvelopeEx(JSON.stringify({ v: 5, t: 'dm', ct: 'AAAA' }))).toEqual({ kind: 'unsupported-version', v: 5 });
    });

    it('the locked marker is a decrypt-failure marker (never edited or re-sent as text)', () => {
        expect(isUndecryptable(ENC_HISTORY_LOCKED)).toBe(true);
        expect(messageEncState('{"v":4,"t":"dm","ct":"AAAA"}', ENC_HISTORY_LOCKED)).toBe('failed');
    });
});

describe('the history key under the recovery code', () => {
    it('round-trips under the right code and stays shut under a wrong one', async () => {
        const code = generateRecoveryCode();
        const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
        const hk = generateX25519Keypair();
        const wrapped = (await wrapKeyUnderRecovery(hk.privateKey, code, salt))!;
        expect(wrapped).toBeTruthy();
        const back = await unwrapKeyUnderRecovery(wrapped, code, salt);
        expect(back && keypairFromPrivate(back).publicKeyEncoded).toBe(hk.publicKeyEncoded);
        expect(await unwrapKeyUnderRecovery(wrapped, generateRecoveryCode(), salt)).toBeNull();
        expect(await wrapKeyUnderRecovery(hk.privateKey, 'not twelve words', salt)).toBeNull();
    }, 30_000);
});

describe('v4Eligible — the rollout gate (pure)', () => {
    const on: DmKeyInfo = { history_pubkey: 'x25519:AAAA', sessions: ['x25519:s1'], all_sessions_v4: true };
    it('needs a history key, at least one recent session, and every recent session on v4 — on BOTH sides', () => {
        expect(v4Eligible(on, on)).toBe(true);
        expect(v4Eligible({ ...on, history_pubkey: null }, on)).toBe(false);
        expect(v4Eligible(on, { ...on, history_pubkey: null })).toBe(false);
        // one 0.9.2 client on either side (no key, no reads_up_to) keeps v3
        expect(v4Eligible({ ...on, all_sessions_v4: false }, on)).toBe(false);
        expect(v4Eligible(on, { ...on, all_sessions_v4: false })).toBe(false);
        // an account nobody has opened recently gets v3, so its owner can read
        // what arrived with only a password
        expect(v4Eligible({ ...on, sessions: [], all_sessions_v4: false }, on)).toBe(false);
    });
    it('targets are both sides’ sessions plus both history keys, de-duplicated', () => {
        const mine: DmKeyInfo = { history_pubkey: 'x25519:HM', sessions: ['x25519:m1', 'x25519:m2'], all_sessions_v4: true };
        const theirs: DmKeyInfo = { history_pubkey: 'x25519:HT', sessions: ['x25519:t1', 'x25519:m1'], all_sessions_v4: true };
        expect(v4Targets(theirs, mine).sort()).toEqual(['x25519:HM', 'x25519:HT', 'x25519:m1', 'x25519:m2', 'x25519:t1']);
    });
});

describe('SEC-04: plaintext after encryption is "unexpected", not "legacy"', () => {
    type Row = { id: number; created_at: string; encState: ReturnType<typeof messageEncState> };
    it('history: plaintext older than every sealed row stays legacy; newer becomes unexpected', () => {
        const rows: Row[] = [
            { id: 1, created_at: '2026-01-01T00:00:00Z', encState: 'legacy' },   // pre-E2EE history
            { id: 2, created_at: '2026-02-01T00:00:00Z', encState: 'secure' },
            { id: 3, created_at: '2026-03-01T00:00:00Z', encState: 'legacy' },   // injected after
            { id: 4, created_at: '2026-04-01T00:00:00Z', encState: 'secure' },
            { id: 5, created_at: '2026-05-01T00:00:00Z', encState: 'failed' },
        ];
        const out = markUnexpectedPlaintext(rows).map(r => r.encState);
        expect(out).toEqual(['legacy', 'secure', 'unexpected', 'secure', 'failed']);
    });
    it('a conversation with no sealed rows is untouched (a plaintext-only legacy channel)', () => {
        const rows: Row[] = [{ id: 1, created_at: '2026-01-01T00:00:00Z', encState: 'legacy' }];
        expect(markUnexpectedPlaintext(rows)[0].encState).toBe('legacy');
    });
    it('accepts epoch-second timestamps as channels use', () => {
        const rows = [
            { id: 1, created_at: 1_700_000_000, encState: 'secure' as const },
            { id: 2, created_at: 1_700_000_100, encState: 'legacy' as const },
        ];
        expect(markUnexpectedPlaintext(rows)[1].encState).toBe('unexpected');
    });
    it('live: plaintext into an encrypting conversation is unexpected; a sealed one is secure', () => {
        expect(liveEncState('plain text', 'plain text', true)).toBe('unexpected');
        expect(liveEncState('plain text', 'plain text', false)).toBe('legacy');
        expect(liveEncState('{"v":3,"t":"dm","ct":"AAAA"}', 'hi', true)).toBe('secure');
    });
});
