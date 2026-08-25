#!/usr/bin/env node
/**
 * Encrypt + sign a mobile OTA bundle for Capgo's public-key ("end-to-end")
 * update verification, produced entirely self-hosted (no Capgo cloud).
 *
 * Matches the plugin's native decrypt EXACTLY (see CryptoCipher.java):
 *   - AES/CBC/PKCS5Padding over the plaintext zip (random 16-byte key + IV)
 *   - the AES key is RSA/ECB/PKCS1Padding *private-encrypted* (client public-
 *     decrypts) → ivSessionKey = base64(iv) ":" base64(encAesKey)
 *   - checksum = base64( RSA-priv-encrypt( SHA-256(plaintext zip) bytes ) );
 *     the client public-decrypts it and compares to sha256(decrypted zip)
 *
 * A compromised download host can't forge either value without the private
 * key (kept off-server), so the bundle is authenticated. NOTE: it is NOT
 * confidential — the AES key is unwrapped with the PUBLIC key (shipped in every
 * APK), so anyone can decrypt the bundle. Never put secrets in a web bundle.
 * The signature covers the bundle bytes only, not the version (the client adds
 * monotonic anti-rollback) — see README "Residual risks". Usage:
 *   node encrypt-bundle.mjs <plaintext.zip> <privateKey.pem> <out.enc.zip>
 * Prints JSON: { ivSessionKey, checksum } for the manifest.
 */
import { createCipheriv, privateEncrypt, randomBytes, createHash, constants } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , zipPath, keyPath, outPath] = process.argv;
if (!zipPath || !keyPath || !outPath) {
    console.error('usage: encrypt-bundle.mjs <plaintext.zip> <privateKey.pem> <out.enc.zip>');
    process.exit(2);
}

const plaintext = readFileSync(zipPath);
const privateKey = readFileSync(keyPath, 'utf8');

// AES-128-CBC (Capgo convention): random key + IV.
const aesKey = randomBytes(16);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-128-cbc', aesKey, iv); // PKCS7 == Java PKCS5Padding
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
writeFileSync(outPath, encrypted);

// RSA private-encrypt the AES key (client public-decrypts it).
const encAesKey = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, aesKey);
const ivSessionKey = `${iv.toString('base64')}:${encAesKey.toString('base64')}`;

// Sign the SHA-256 of the PLAINTEXT zip (client hashes the decrypted file).
// Emit the signature as HEX — the plugin's modern, unambiguous checksum format
// (>= v7.30.0); its base64 branch is deprecated backwards-compat.
const sha = createHash('sha256').update(plaintext).digest(); // 32 raw bytes
const checksum = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, sha).toString('hex');

process.stdout.write(JSON.stringify({ ivSessionKey, checksum }));
