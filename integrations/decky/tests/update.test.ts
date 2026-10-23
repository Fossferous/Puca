import { constants, createHash, generateKeyPairSync, privateEncrypt, publicDecrypt, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isNewer, parseVersion, readKey, readOffer, updateMessage, verifyOffer } from '../src/update';
// The release script's own signer: the plugin is tested against what signs releases.
import { publicJwk, signRelease, updateMessage as signedText } from '../scripts/signing.mjs';

const keyPair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
        pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    };
};
const release = keyPair();
const stranger = keyPair();
const zip = Buffer.from('the bytes of puca-decky-0.2.0.zip');
const manifest = signRelease(zip, 'puca-decky-0.2.0.zip', '0.2.0', release.pem);
const offer = readOffer(manifest)!;
const key = readKey(publicJwk(release.pem))!;

describe('an update installs only when the release key signed it', () => {
    it('the release script and the plugin sign and check the same text', () => {
        expect(signedText('0.2.0', 'ab')).toBe(updateMessage('0.2.0', 'ab'));
        expect(updateMessage('0.2.0', 'ab')).toBe('puca-decky-update/1\n0.2.0\nab\n');
        expect(offer).toEqual(manifest);
        expect(key).toEqual({ kty: 'RSA', n: expect.any(String), e: 'AQAB' });
    });

    it('accepts a release signed with the release key', async () => {
        expect(await verifyOffer(offer, key)).toBe(true);
    });

    it('refuses one whose version or file was changed after signing', async () => {
        expect(await verifyOffer({ ...offer, version: '0.2.1', file: 'puca-decky-0.2.1.zip' }, key)).toBe(false);
        expect(await verifyOffer({ ...offer, sha256: createHash('sha256').update('other').digest('hex') }, key)).toBe(false);
    });

    it('refuses one signed with any other key', async () => {
        const forged = signRelease(zip, 'puca-decky-0.2.0.zip', '0.2.0', stranger.pem);
        expect(await verifyOffer(readOffer(forged)!, key)).toBe(false);
        // POSITIVE CONTROL: the stranger's key does accept its own.
        expect(await verifyOffer(readOffer(forged)!, readKey(publicJwk(stranger.pem))!)).toBe(true);
    });

    it('refuses a signature over the same facts without the leading line', async () => {
        const bare = sign('sha256', Buffer.from(`${offer.version}\n${offer.sha256}\n`), release.pem).toString('base64');
        expect(await verifyOffer({ ...offer, signature: bare }, key)).toBe(false);
    });

    it("a mobile update's checksum made with the same key is no signature here, and this is no checksum there", async () => {
        // The mobile OTA's checksum (deploy/mobile/encrypt-bundle.mjs): the
        // zip's bare SHA-256, private-encrypted with PKCS#1 padding.
        const digest = createHash('sha256').update(zip).digest();
        const otaChecksum = privateEncrypt({ key: release.pem, padding: constants.RSA_PKCS1_PADDING }, digest);
        expect(await verifyOffer({ ...offer, signature: otaChecksum.toString('base64') }, key)).toBe(false);
        // And the app opening this signature as a checksum finds a DigestInfo
        // over another text, never the zip's SHA-256.
        const opened = publicDecrypt({ key: release.publicPem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(offer.signature, 'base64'));
        expect(opened.equals(digest)).toBe(false);
        // POSITIVE CONTROL: that is how the app opens a real checksum.
        expect(publicDecrypt({ key: release.publicPem, padding: constants.RSA_PKCS1_PADDING }, otaChecksum).equals(digest)).toBe(true);
    });

    it('never throws on garbage', async () => {
        expect(await verifyOffer({ ...offer, signature: 'AAAA' }, key)).toBe(false);
        expect(await verifyOffer({ ...offer, signature: '!!!' }, key)).toBe(false);
        expect(await verifyOffer(offer, { ...key, n: 'AAAA' })).toBe(false);
    });
});

describe('what the download site says is read strictly', () => {
    it('an offer must name its own zip, a SHA-256 and a base64 signature', () => {
        expect(readOffer({ ...manifest, extra: 1 })).toEqual(manifest);
        for (const bad of [
            null, 'x', [], {},
            { ...manifest, version: '0.2.0-beta' },
            { ...manifest, file: 'puca-decky-0.3.0.zip' },
            { ...manifest, file: '../puca-decky-0.2.0.zip' },
            { ...manifest, sha256: manifest.sha256.toUpperCase() },
            { ...manifest, sha256: manifest.sha256.slice(1) },
            { ...manifest, signature: 'not base64!' },
            { ...manifest, signature: 'A'.repeat(1025) },
        ]) expect(readOffer(bad), JSON.stringify(bad)).toBeNull();
    });

    it('a key must be RSA, 2048 bits or more', () => {
        const jwk = publicJwk(release.pem);
        expect(readKey({ ...jwk, d: 'a private part is never kept' })).toEqual({ kty: 'RSA', n: jwk.n, e: jwk.e });
        expect(readKey({ ...jwk, kty: 'EC' })).toBeNull();
        expect(readKey({ ...jwk, n: jwk.n.slice(0, 200) })).toBeNull();
        expect(readKey({ ...jwk, n: `${jwk.n}+` })).toBeNull();
        expect(readKey(null)).toBeNull();
    });

    it('versions compare as numbers', () => {
        expect(parseVersion('0.2.0')).toEqual([0, 2, 0]);
        expect(isNewer('0.2.0', '0.1.9')).toBe(true);
        expect(isNewer('0.10.0', '0.9.9')).toBe(true);
        expect(isNewer('1.0', '0.99.99')).toBe(true);
        expect(isNewer('0.2', '0.2.0')).toBe(false);
        expect(isNewer('0.2.0', '0.2')).toBe(false);
        expect(isNewer('0.2.1', '0.2')).toBe(true);
        expect(isNewer('0.2.0', '0.2.0')).toBe(false);
        expect(isNewer('0.1.9', '0.2.0')).toBe(false);
        for (const bad of ['dev', '', 'v1.0.0', '1.0.0-rc1', '1.2.3.4.5']) {
            expect(isNewer(bad, '0.1.0'), bad).toBe(false);
            expect(isNewer('9.9.9', bad), bad).toBe(false);
        }
    });
});
