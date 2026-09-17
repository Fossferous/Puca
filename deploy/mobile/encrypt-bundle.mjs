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

const [, , zipPath, keyPath, outPath, versionJsonPath] = process.argv;
if (!zipPath || !keyPath || !outPath || !versionJsonPath) {
    // The version.json is REQUIRED: without the sidecar it produces, dual-ship.sh
    // cannot tie the manifest's version to the bytes, and an optional argument
    // is one nobody passes on the day it matters.
    console.error('usage: encrypt-bundle.mjs <plaintext.zip> <privateKey.pem> <out.enc.zip> <staging>/version.json');
    process.exit(2);
}

const plaintext = readFileSync(zipPath);
const privateKey = readFileSync(keyPath, 'utf8');

// The bundle's OWN version, from the version.json vite emits into every web
// build (frontend/vite.config.ts). Written beside the output as
// `<out.enc.zip>.version` so dual-ship.sh can refuse a manifest whose hand-typed
// version does not match the bytes it points at. The client records the
// manifest's label as "what I am running", so one mismatch used to lock every
// phone that took it out of OTA until an APK reinstall (0.9.810 audit, C-04).
// Read BEFORE any output is written, so a bad sidecar leaves nothing behind.
const parsedVersion = JSON.parse(readFileSync(versionJsonPath, 'utf8'));
const builtVersion = typeof parsedVersion?.version === 'string' ? parsedVersion.version.trim() : '';
if (!/^\d+\.\d+\.\d+/.test(builtVersion)) {
    console.error(`${versionJsonPath} carries no usable version: ${JSON.stringify(parsedVersion?.version)}`);
    process.exit(2);
}

// The bundle must carry no second HTML document: dist/notes/ is a browser-only
// page with no CSP meta of its own, and the OTA serves every file in the zip
// from the WebView's single https://localhost origin, where a meta policy does
// not reach a sibling document. The native shells strip it
// (frontend/scripts/strip-notes-from-native.mjs); the OTA staging recipe does it
// by hand (deploy/mobile/README.md), and a hand step is not a gate. Checked on
// the BYTES BEING SIGNED, before any output is written.
function zipEntryNames(buf) {
    // Walk the central directory from the End Of Central Directory record —
    // scanning for PK\x01\x02 anywhere would also hit compressed payload bytes.
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) !== 0x06054b50) continue;
        // The four signature bytes alone are not an EOCD: an archive COMMENT may
        // contain them, and a backward scan meets the comment first. A fake
        // record of zeros there read as "0 entries", the filter below found no
        // notes/ among none, and the dirty bundle was signed. The real record
        // is the one whose comment length accounts for every byte after it.
        if (buf.readUInt16LE(i + 20) !== buf.length - i - 22) continue;
        const count = buf.readUInt16LE(i + 10);
        let at = buf.readUInt32LE(i + 16);
        // Fail CLOSED on what this reader cannot see into, rather than report
        // a partial list as the whole truth.
        if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archive: the entry list is not readable here');
        if (count === 0) throw new Error('the archive lists no entries');
        const names = [];
        for (let n = 0; n < count; n++) {
            if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('malformed zip central directory');
            const nameLen = buf.readUInt16LE(at + 28);
            names.push(buf.toString('utf8', at + 46, at + 46 + nameLen));
            at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
        }
        return names;
    }
    throw new Error('not a zip file (no end-of-central-directory record)');
}
let bundleNames;
try {
    bundleNames = zipEntryNames(plaintext);
} catch (e) {
    console.error(`${zipPath}: cannot read the bundle's entry list (${e.message}). Refusing to sign what cannot be checked.`);
    process.exit(2);
}
const strayNotes = bundleNames.filter((n) => /^(\.\/)?notes\//.test(n));
if (strayNotes.length) {
    console.error(`${zipPath} contains ${strayNotes.length} notes/ entr${strayNotes.length === 1 ? 'y' : 'ies'} (e.g. ${strayNotes[0]}).`);
    console.error('Púca Notes has no CSP meta of its own and must not ride an OTA bundle into the WebView origin:');
    console.error('re-stage with `rm -rf ota-src/notes` (deploy/mobile/README.md), the same removal');
    console.error('frontend/scripts/strip-notes-from-native.mjs performs for the APK.');
    process.exit(2);
}

// AES-128-CBC (Capgo convention): random key + IV.
const aesKey = randomBytes(16);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-128-cbc', aesKey, iv); // PKCS7 == Java PKCS5Padding
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
writeFileSync(outPath, encrypted);
writeFileSync(`${outPath}.version`, `${builtVersion}\n`);

// RSA private-encrypt the AES key (client public-decrypts it).
const encAesKey = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, aesKey);
const ivSessionKey = `${iv.toString('base64')}:${encAesKey.toString('base64')}`;

// Sign the SHA-256 of the PLAINTEXT zip (client hashes the decrypted file).
// Emit the signature as HEX — the plugin's modern, unambiguous checksum format
// (>= v7.30.0); its base64 branch is deprecated backwards-compat.
const sha = createHash('sha256').update(plaintext).digest(); // 32 raw bytes
const checksum = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, sha).toString('hex');

process.stdout.write(JSON.stringify({ ivSessionKey, checksum }));
