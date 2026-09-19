#!/usr/bin/env node
/**
 * Prove a signed OTA bundle verifies under the public key the TARGET app
 * embeds — the same check the phone's updater plugin makes, run on the
 * operator's machine BEFORE anything is uploaded.
 *
 *   node verify-bundle.mjs <bundle.enc.zip> <sessionKey> <checksum> <capacitor.config.ts>
 *
 * Exit 0: the session key unwraps under that config's CapacitorUpdater
 * publicKey, the bundle decrypts, and the signed checksum matches the
 * decrypted bytes. Exit 1: it does not, and the phone would refuse it too.
 * Exit 2: usage, or the config carries no key.
 *
 * WHY. There are two signing keys now — Púca's and Púca Notes' — and a bundle
 * signed with the wrong one is indistinguishable from a good one until every
 * phone refuses it ("This update could not be verified"). The lengths
 * dual-ship.sh checks (369/512) are the same for both keys. This is the only
 * pre-publish check that knows which app a signature belongs to.
 *
 * Mirrors encrypt-bundle.mjs / the plugin's CryptoCipher.java exactly:
 *   sessionKey = base64(iv) ":" base64(RSA-PKCS1-private-encrypt(aesKey))
 *   checksum   = hex(RSA-PKCS1-private-encrypt(sha256(plaintext zip)))
 *   bundle     = AES-128-CBC(aesKey, iv, plaintext zip)
 */
import { createDecipheriv, createHash, createPublicKey, publicDecrypt, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The CapacitorUpdater publicKey in a capacitor.config.ts: its quoted pieces
 *  joined, `\n` unescaped. Full-line comments are ignored. */
export function publicKeyFromConfig(text) {
    const src = text.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
    const at = src.search(/CapacitorUpdater\s*:\s*\{/);
    if (at === -1) return null;
    const m = /publicKey\s*:\s*((?:'[^']*'\s*\+?\s*)+)/.exec(src.slice(at));
    if (!m) return null;
    return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).join('').replace(/\\n/g, '\n').trim();
}

/** Throws with the reason when the bundle does not verify under `pem`. */
export function verifyBundle(enc, sessionKey, checksum, pem) {
    const key = createPublicKey({ key: pem, format: 'pem', type: 'pkcs1' });
    const [ivB64, wrappedB64] = String(sessionKey).split(':');
    if (!ivB64 || !wrappedB64) throw new Error('sessionKey is not "<iv>:<wrapped key>"');
    let aesKey;
    try {
        aesKey = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(wrappedB64, 'base64'));
    } catch {
        throw new Error('the session key does not unwrap under this public key — signed with a DIFFERENT private key');
    }
    let plain;
    try {
        const d = createDecipheriv('aes-128-cbc', aesKey, Buffer.from(ivB64, 'base64'));
        plain = Buffer.concat([d.update(enc), d.final()]);
    } catch {
        throw new Error('the bundle does not decrypt with the unwrapped key');
    }
    let signed;
    try {
        signed = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(String(checksum), 'hex'));
    } catch {
        throw new Error('the checksum signature does not verify under this public key');
    }
    const actual = createHash('sha256').update(plain).digest();
    if (!signed.equals(actual)) throw new Error('the signed checksum does not match the decrypted bundle');
    return plain.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , bundlePath, sessionKey, checksum, configPath] = process.argv;
    if (!bundlePath || !sessionKey || !checksum || !configPath) {
        console.error('usage: verify-bundle.mjs <bundle.enc.zip> <sessionKey> <checksum> <capacitor.config.ts>');
        process.exit(2);
    }
    const pem = publicKeyFromConfig(readFileSync(configPath, 'utf8'));
    if (!pem) {
        console.error(`${configPath}: no CapacitorUpdater.publicKey found`);
        process.exit(2);
    }
    try {
        const n = verifyBundle(readFileSync(bundlePath), sessionKey, checksum, pem);
        console.log(`OK  ${bundlePath} verifies under the key in ${configPath} (${n} bytes decrypted)`);
    } catch (e) {
        console.error(`DOES NOT VERIFY  ${bundlePath} under the key in ${configPath}: ${e.message}`);
        process.exit(1);
    }
}
