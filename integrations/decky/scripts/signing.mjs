/**
 * Signing a Púca for Steam Deck release for the plugin's own updater: what
 * scripts/sign-update.mjs uses, and what the tests check the plugin against.
 *
 * The release key signs `puca-decky-update/1 \n <version> \n <the zip's
 * SHA-256, hex> \n` with RSASSA-PKCS1-v1_5 and SHA-256. The plugin checks
 * it with WebCrypto (src/update.ts), and verify_update.py checks it again
 * before anything is published.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** The exact text the release key signs (src/update.ts, updateMessage). */
export function updateMessage(version, sha256) {
    return `puca-decky-update/1\n${version}\n${sha256}\n`;
}

/** The public half as update-key.json holds it: only kty, n and e. */
export function publicJwk(privateKeyPem) {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('the release key must be an RSA key');
    if (key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('the release key must be 2048 bits or more');
    const { kty, n, e } = createPublicKey(key).export({ format: 'jwk' });
    return { kty, n, e };
}

/** The manifest for a zip: its offer, signed. */
export function signRelease(zipBytes, zipName, version, privateKeyPem) {
    const sha256 = createHash('sha256').update(zipBytes).digest('hex');
    const message = Buffer.from(updateMessage(version, sha256), 'ascii');
    const key = createPrivateKey(privateKeyPem);
    const signature = sign('sha256', message, key);
    if (!verify('sha256', message, createPublicKey(key), signature)) {
        throw new Error('the signature does not verify under its own key');
    }
    return { version, file: zipName, sha256, signature: signature.toString('base64') };
}
