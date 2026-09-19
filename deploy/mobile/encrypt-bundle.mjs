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
 *   node encrypt-bundle.mjs [--notes] <plaintext.zip> <privateKey.pem> <out.enc.zip> <staging>/version.json
 * Prints JSON: { ivSessionKey, checksum } for the manifest.
 *
 * TWO APPS, TWO CHANNELS. Without a flag this signs a PÚCA bundle (the main
 * build, dist/). `--notes` signs a bundle for the Púca Notes Android app — the
 * native Notes build, dist-notes-app/ (frontend/scripts/build-notes-app.mjs
 * --ota) — and must be used with the NOTES key (notes-updater-rsa.key in your
 * keys directory), never Púca's. The flag is a claim the bytes must back up:
 * version.json says which app a build is ("app": "puca" | "notes"; absent =
 * puca), and a bundle for the other app is refused either way. The chosen
 * channel is written to `<out>.channel`, which dual-ship.sh reads: `mobile` /
 * `mobile-lite` refuse a notes bundle and `mobile-notes` refuses anything else.
 * A Notes bundle's native floor (version.json "nativeMin") goes to
 * `<out>.native-min`, which `mobile-notes` publishes as native.min.
 */
import { createCipheriv, privateEncrypt, randomBytes, createHash, constants } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const NOTES = args.includes('--notes');
const unknownFlags = args.filter(a => a.startsWith('--') && a !== '--notes');
const [zipPath, keyPath, outPath, versionJsonPath] = args.filter(a => !a.startsWith('--'));
if (!zipPath || !keyPath || !outPath || !versionJsonPath || unknownFlags.length) {
    // The version.json is REQUIRED: without the sidecar it produces, dual-ship.sh
    // cannot tie the manifest's version to the bytes, and an optional argument
    // is one nobody passes on the day it matters.
    if (unknownFlags.length) console.error(`unknown option(s): ${unknownFlags.join(' ')}`);
    console.error('usage: encrypt-bundle.mjs [--notes] <plaintext.zip> <privateKey.pem> <out.enc.zip> <staging>/version.json');
    process.exit(2);
}

const plaintext = readFileSync(zipPath);
const privateKey = readFileSync(keyPath, 'utf8');
const refuse = (lines) => { for (const l of lines) console.error(l); process.exit(2); };

// The bundle's OWN version, from the version.json vite emits into every web
// build (frontend/vite.shared.ts emitVersionJson). Written beside the output as
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
// Which app the build says it is. Absent = Púca: every version.json written
// before the field existed came from the main build.
const builtApp = parsedVersion?.app === undefined ? 'puca' : parsedVersion.app;
if (NOTES && builtApp !== 'notes') {
    refuse([
        `${versionJsonPath} says app ${JSON.stringify(builtApp)}, but --notes signs a Púca Notes bundle.`,
        'Only the Notes NATIVE build writes "app": "notes" (cd frontend && node scripts/build-notes-app.mjs --ota,',
        'then zip the contents of dist-notes-app/). dist/notes/ is the web page — base /notes/, no CSP — and would',
        'white-screen the app.',
    ]);
}
if (!NOTES && builtApp !== 'puca') {
    refuse([
        `${versionJsonPath} says app ${JSON.stringify(builtApp)}: this is not a Púca bundle.`,
        builtApp === 'notes'
            ? 'A Púca Notes bundle is signed with --notes and the NOTES key, and shipped with dual-ship.sh mobile-notes.'
            : 'Rebuild from frontend/ (npm run build) and stage from dist/.',
    ]);
}

/** a > b over the first three numeric parts. */
const versionGt = (a, b) => {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
    return false;
};

// A Notes bundle's NATIVE FLOOR: the oldest Notes APK it can run on, from the
// tracked frontend/notes-app/native-min.json via the build's version.json
// (frontend/scripts/notes-native-min.mjs has why the tree holds it). Written
// to `<out>.native-min`, which dual-ship.sh mobile-notes publishes as the
// manifest's native.min on EVERY release — so a floor cannot silently drop
// off the release after the one that raised it. Refused when absent (a build
// from before the field, or a hand-made version.json) and when newer than
// the bundle's own version: every Notes install would then refuse it.
let nativeMin = '';
if (NOTES) {
    nativeMin = typeof parsedVersion?.nativeMin === 'string' ? parsedVersion.nativeMin.trim() : '';
    if (!/^\d+\.\d+\.\d+$/.test(nativeMin)) {
        refuse([
            `${versionJsonPath} carries no usable nativeMin (${JSON.stringify(parsedVersion?.nativeMin)}).`,
            'The Notes native build writes it from frontend/notes-app/native-min.json: rebuild with',
            'cd frontend && node scripts/build-notes-app.mjs --ota',
        ]);
    }
    if (versionGt(nativeMin, builtVersion)) {
        refuse([
            `${versionJsonPath} says nativeMin ${nativeMin}, newer than the bundle itself (${builtVersion}):`,
            'every Púca Notes install would refuse this update. Fix frontend/notes-app/native-min.json or bump the release.',
        ]);
    }
}

// The central directory, walked from the End Of Central Directory record —
// scanning for PK\x01\x02 anywhere would also hit compressed payload bytes.
function zipEntries(buf) {
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
        const entries = [];
        for (let n = 0; n < count; n++) {
            if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('malformed zip central directory');
            const nameLen = buf.readUInt16LE(at + 28);
            entries.push({
                name: buf.toString('utf8', at + 46, at + 46 + nameLen),
                method: buf.readUInt16LE(at + 10),
                compressedSize: buf.readUInt32LE(at + 20),
                localOffset: buf.readUInt32LE(at + 42),
            });
            at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
        }
        return entries;
    }
    throw new Error('not a zip file (no end-of-central-directory record)');
}

/** One entry's bytes (stored or deflated), read through its local header. */
function readEntry(buf, e) {
    if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) throw new Error(`${e.name}: bad local header`);
    const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28);
    const data = buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRawSync(data);
    throw new Error(`${e.name}: unsupported compression method ${e.method}`);
}

let entries;
try {
    entries = zipEntries(plaintext);
} catch (e) {
    console.error(`${zipPath}: cannot read the bundle's entry list (${e.message}). Refusing to sign what cannot be checked.`);
    process.exit(2);
}
const bundleNames = entries.map(e => e.name);
const bare = (n) => n.replace(/^\.\//, '');
const entryNamed = (name) => entries.find(e => bare(e.name) === name);

/** The zip's own root version.json, parsed; null when absent or not JSON. */
function zipVersionJson() {
    const e = entryNamed('version.json');
    if (!e) return null;
    try { return JSON.parse(readEntry(plaintext, e).toString('utf8')); } catch { return null; }
}

if (!NOTES) {
    // The bundle must carry no second HTML document: dist/notes/ is a browser-only
    // page with no CSP meta of its own, and the OTA serves every file in the zip
    // from the WebView's single https://localhost origin, where a meta policy does
    // not reach a sibling document. The native shells strip it
    // (frontend/scripts/strip-notes-from-native.mjs); the OTA staging recipe does it
    // by hand (deploy/mobile/README.md), and a hand step is not a gate. Checked on
    // the BYTES BEING SIGNED, before any output is written.
    const strayNotes = bundleNames.filter((n) => /^(\.\/)?notes\//.test(n));
    if (strayNotes.length) {
        console.error(`${zipPath} contains ${strayNotes.length} notes/ entr${strayNotes.length === 1 ? 'y' : 'ies'} (e.g. ${strayNotes[0]}).`);
        console.error('Púca Notes has no CSP meta of its own and must not ride an OTA bundle into the WebView origin:');
        console.error('re-stage with `rm -rf ota-src/notes` (deploy/mobile/README.md), the same removal');
        console.error('frontend/scripts/strip-notes-from-native.mjs performs for the APK.');
        process.exit(2);
    }
    // The BYTES may disagree with the version.json argument: a zip of the Notes
    // native build signed for Púca would replace Púca with Notes on every phone.
    if (zipVersionJson()?.app === 'notes') {
        refuse([`${zipPath} carries a version.json saying app "notes": this zip is a Púca Notes bundle. Sign it with --notes.`]);
    }
} else {
    // A Púca Notes bundle: the Notes NATIVE build, and nothing else.
    const problems = [];
    const index = entryNamed('index.html');
    if (!index) problems.push('there is no index.html at the zip root (zip the CONTENTS of dist-notes-app/, not the directory)');
    const nested = bundleNames.filter(n => /\/index\.html$/i.test(bare(n)));
    if (nested.length) problems.push(`it carries a second HTML entry point (${nested[0]}) — a nested page gets no CSP here`);
    const inZip = zipVersionJson();
    if (!inZip) problems.push('there is no readable version.json at the zip root — only the Notes native build emits one with app "notes"');
    else if (inZip.app !== 'notes') problems.push(`the zip's own version.json says app ${JSON.stringify(inZip.app ?? 'puca')}, not "notes"`);
    else if (String(inZip.version ?? '').trim() !== builtVersion) problems.push(`the zip's own version.json says ${inZip.version}, but ${versionJsonPath} says ${builtVersion}`);
    else if (String(inZip.nativeMin ?? '').trim() !== nativeMin) problems.push(`the zip's own version.json says nativeMin ${JSON.stringify(inZip.nativeMin)}, but ${versionJsonPath} says ${nativeMin}`);
    if (index) {
        let html = '';
        try { html = readEntry(plaintext, index).toString('utf8'); } catch (e) { problems.push(`index.html cannot be read (${e.message})`); }
        const metas = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
        if (html && metas.length !== 1) {
            problems.push(`index.html carries ${metas.length} Content-Security-Policy metas, not exactly 1 — the WebView origin gets no headers, `
                + 'so the meta is the whole policy (scripts/build-notes-app.mjs injects it)');
        }
        // The entry SCRIPT is what matters: the page's source also links its web
        // manifest at /notes/ (harmless — the WebView never installs it).
        if (html && /<script[^>]*\ssrc=["']\/notes\//i.test(html)) {
            problems.push('index.html loads its script from /notes/ — that is the WEB build (base /notes/), which 404s every asset inside the app');
        }
    }
    if (problems.length) {
        refuse([`${zipPath} is not a Púca Notes app bundle:`, ...problems.map(p => `  - ${p}`),
            'Build it with: cd frontend && node scripts/build-notes-app.mjs --ota']);
    }
}

// AES-128-CBC (Capgo convention): random key + IV.
const aesKey = randomBytes(16);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-128-cbc', aesKey, iv); // PKCS7 == Java PKCS5Padding
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
writeFileSync(outPath, encrypted);
writeFileSync(`${outPath}.version`, `${builtVersion}\n`);
writeFileSync(`${outPath}.channel`, `${NOTES ? 'notes' : 'puca'}\n`);
if (NOTES) writeFileSync(`${outPath}.native-min`, `${nativeMin}\n`);

// RSA private-encrypt the AES key (client public-decrypts it).
const encAesKey = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, aesKey);
const ivSessionKey = `${iv.toString('base64')}:${encAesKey.toString('base64')}`;

// Sign the SHA-256 of the PLAINTEXT zip (client hashes the decrypted file).
// Emit the signature as HEX — the plugin's modern, unambiguous checksum format
// (>= v7.30.0); its base64 branch is deprecated backwards-compat.
const sha = createHash('sha256').update(plaintext).digest(); // 32 raw bytes
const checksum = privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, sha).toString('hex');

process.stdout.write(JSON.stringify({ ivSessionKey, checksum }));
