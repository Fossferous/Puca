import { describe, it, expect } from 'vitest';
import {
    deriveControlSessionKey,
    deriveDeviceControlKey,
    generateControlEphemeral,
    canonicalJson,
} from '../api/e2ee';
import { testIdentity } from './fixtures/identities';
import {
    buildGrantRecord,
    grantAuthorises,
    DEVICE_GRANT_TYPE,
} from '../api/devices/grants';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('device-control session key', () => {
    it('both ends derive the same key from the same handshake', () => {
        const a = generateControlEphemeral();
        const b = generateControlEphemeral();
        // The device static DH is computed natively and is symmetric, so both
        // ends feed in the same shared secret.
        const staticSs = new Uint8Array(32).fill(7);

        const ka = deriveDeviceControlKey(staticSs, a.priv, b.pubEncoded);
        const kb = deriveDeviceControlKey(staticSs, b.priv, a.pubEncoded);
        expect(ka).not.toBeNull();
        expect(hex(ka!)).toBe(hex(kb!));
    });

    /**
     * The load-bearing separation. Both handshakes have the same shape, so
     * reusing `sovereign-control-v2` would let a key negotiated for the
     * voice-room "let a friend drive my game" feature be valid in a
     * device-control session — where the authorization is completely different
     * (a shared voice room and a human clicking Allow, versus a host-signed
     * grant). Different label, different key, no crossover.
     */
    it('does NOT collide with the voice-room control key', async () => {
        const identity = await testIdentity('alice', 'a1'.repeat(16));
        const a = generateControlEphemeral();
        const b = generateControlEphemeral();

        // Feed the voice-room derivation a static DH over the SAME material, so
        // the only difference left between the two keys is the KDF label.
        const roomKey = deriveControlSessionKey(
            identity.privateKey, identity.publicKeyEncoded, a.priv, b.pubEncoded,
        );
        const staticSs = new Uint8Array(32).fill(3);
        const deviceKey = deriveDeviceControlKey(staticSs, a.priv, b.pubEncoded);

        expect(roomKey).not.toBeNull();
        expect(deviceKey).not.toBeNull();
        expect(hex(deviceKey!)).not.toBe(hex(roomKey!));
    });

    it('changes when the static half changes', () => {
        // If it did not, the device static DH would be decorative and the
        // handshake would authenticate nothing.
        const a = generateControlEphemeral();
        const b = generateControlEphemeral();
        const k1 = deriveDeviceControlKey(new Uint8Array(32).fill(1), a.priv, b.pubEncoded);
        const k2 = deriveDeviceControlKey(new Uint8Array(32).fill(2), a.priv, b.pubEncoded);
        expect(hex(k1!)).not.toBe(hex(k2!));
    });

    it('changes when either ephemeral changes (fresh key per session)', () => {
        const staticSs = new Uint8Array(32).fill(9);
        const a = generateControlEphemeral();
        const b = generateControlEphemeral();
        const c = generateControlEphemeral();
        const k1 = deriveDeviceControlKey(staticSs, a.priv, b.pubEncoded);
        const k2 = deriveDeviceControlKey(staticSs, a.priv, c.pubEncoded);
        expect(hex(k1!)).not.toBe(hex(k2!));
    });

    it('fails closed on a malformed peer ephemeral', () => {
        const a = generateControlEphemeral();
        expect(deriveDeviceControlKey(new Uint8Array(32), a.priv, 'not-a-key')).toBeNull();
        expect(deriveDeviceControlKey(new Uint8Array(32), a.priv, 'x25519:!!!')).toBeNull();
    });
});

describe('host-signed grants', () => {
    const HOST = 'hostDeviceId';
    const CTL = 'controllerDevId';
    const NOW = 1_753_000_000;

    const okSig = async () => true;
    const badSig = async () => false;

    function grant(over: Partial<{ host: string; ctl: string; exp: number | null }> = {}) {
        const { canonical } = buildGrantRecord({
            hostDevice: over.host ?? HOST,
            controllerDevice: over.ctl ?? CTL,
            expiresAt: over.exp === undefined ? null : over.exp,
            timestamp: NOW,
        });
        return { grant_record: canonical, grant_sig: 'sig' };
    }

    it('authorises the pairing it was signed for', async () => {
        expect(await grantAuthorises(grant(), HOST, CTL, okSig, NOW)).toBe(true);
    });

    it('refuses when the signature does not verify', async () => {
        expect(await grantAuthorises(grant(), HOST, CTL, badSig, NOW)).toBe(false);
    });

    /**
     * A genuine signature over a DIFFERENT grant must not be replayable onto
     * this pairing — otherwise one grant would authorise every controller.
     */
    it('refuses a grant replayed onto a different controller', async () => {
        const forAnotherController = grant({ ctl: 'someoneElse' });
        expect(await grantAuthorises(forAnotherController, HOST, CTL, okSig, NOW)).toBe(false);
    });

    it('refuses a grant replayed onto a different host', async () => {
        const forAnotherHost = grant({ host: 'anotherHost' });
        expect(await grantAuthorises(forAnotherHost, HOST, CTL, okSig, NOW)).toBe(false);
    });

    it('refuses an expired grant', async () => {
        const expired = grant({ exp: NOW - 1 });
        expect(await grantAuthorises(expired, HOST, CTL, okSig, NOW)).toBe(false);
        // ...and accepts it before expiry, so the check is a clock and not a
        // blanket refusal of every grant that has one.
        expect(await grantAuthorises(expired, HOST, CTL, okSig, NOW - 100)).toBe(true);
    });

    it('refuses a record with the wrong type tag', async () => {
        const wrongType = {
            grant_record: canonicalJson({
                typ: 'sovereign-device-auth-v1', v: 1,
                host: HOST, ctl: CTL, exp: null, ts: NOW,
            }),
            grant_sig: 'sig',
        };
        expect(await grantAuthorises(wrongType, HOST, CTL, okSig, NOW)).toBe(false);
    });

    it('refuses a non-canonical blob even with a genuine signature', async () => {
        const nonCanonical = {
            grant_record: JSON.stringify({
                ts: NOW, typ: DEVICE_GRANT_TYPE, v: 1, host: HOST, ctl: CTL, exp: null,
            }, null, 2),
            grant_sig: 'sig',
        };
        expect(await grantAuthorises(nonCanonical, HOST, CTL, okSig, NOW)).toBe(false);
    });

    it('refuses unparseable JSON without throwing', async () => {
        expect(await grantAuthorises(
            { grant_record: 'not json', grant_sig: 'sig' }, HOST, CTL, okSig, NOW,
        )).toBe(false);
    });
});
