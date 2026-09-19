/**
 * deploy/mobile/encrypt-bundle.mjs and verify-bundle.mjs — the publish-side
 * half of "one app's bundle never lands in the other".
 *
 *  - Without a flag the signer makes a PÚCA bundle and refuses one whose
 *    version.json (the argument, or the zip's own) says "notes".
 *  - `--notes` signs only the Notes NATIVE build: version.json app "notes" in
 *    the argument AND at the zip root, one index.html at the root with exactly
 *    one CSP meta, nothing loaded from /notes/ (the web build's base).
 *  - verify-bundle proves the signature belongs to the key a given
 *    capacitor.config.ts embeds; a bundle signed with the other app's key
 *    fails it (the negative control is the same bundle under the right key).
 *
 * Runs the real scripts with node, against throwaway keys and zips built here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENCRYPT = path.join(REPO, 'deploy', 'mobile', 'encrypt-bundle.mjs');
const VERIFY = path.join(REPO, 'deploy', 'mobile', 'verify-bundle.mjs');

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
const NATIVE_INDEX = `<!doctype html><html><head>${CSP}<script type="module" src="/assets/index-a1.js"></script></head><body><div id="root"></div></body></html>`;

/** A minimal zip writer: `deflate` entries use method 8, the rest are stored. */
function makeZip(entries: Record<string, string>, deflate = true): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
        const raw = Buffer.from(text, 'utf8');
        const data = deflate ? zlib.deflateRawSync(raw) : raw;
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = zlib.crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(entries).length, 8); eocd.writeUInt16LE(Object.keys(entries).length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

let tmp: string;
let pucaKey: string; let pucaCfg: string;
let notesKey: string; let notesCfg: string;

function keypair(name: string): { key: string; cfg: string } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = path.join(tmp, `${name}.key`);
    fs.writeFileSync(key, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const pem = String(publicKey.export({ type: 'pkcs1', format: 'pem' })).trim().split('\n');
    const literal = pem.map((l, i) => `'${l}${i < pem.length - 1 ? '\\n' : ''}'`).join(' +\n                ');
    const cfg = path.join(tmp, `${name}.capacitor.config.ts`);
    fs.writeFileSync(cfg, `const config = {\n    plugins: {\n        // a comment naming publicKey: 'not this'\n        CapacitorUpdater: {\n            publicKey:\n                ${literal},\n        },\n    },\n};\nexport default config;\n`);
    return { key, cfg };
}

function write(name: string, content: string | Buffer): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
}

function sign(zip: string, key: string, versionJson: string, notes: boolean) {
    const out = path.join(tmp, path.basename(zip, '.zip') + (notes ? '.notes' : '.puca') + '.enc.zip');
    // A previous case may have signed the same fixture: "nothing written" must
    // mean THIS run wrote nothing.
    for (const f of [out, `${out}.version`, `${out}.channel`]) fs.rmSync(f, { force: true });
    const r = spawnSync(process.execPath, [ENCRYPT, ...(notes ? ['--notes'] : []), zip, key, out, versionJson], { encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, out };
}

function verify(enc: string, sessionKey: string, checksum: string, cfg: string) {
    const r = spawnSync(process.execPath, [VERIFY, enc, sessionKey, checksum, cfg], { encoding: 'utf8' });
    return { status: r.status, text: r.stdout + r.stderr };
}

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puca-ota-sign-'));
    ({ key: pucaKey, cfg: pucaCfg } = keypair('puca'));
    ({ key: notesKey, cfg: notesCfg } = keypair('notes'));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const notesVersion = () => write('notes-version.json', '{"version":"1.2.3","app":"notes"}\n');
const pucaVersion = () => write('puca-version.json', '{"version":"1.2.3","app":"puca"}\n');
const legacyVersion = () => write('legacy-version.json', '{"version":"1.2.3"}\n');

describe('encrypt-bundle --notes: only the Notes native build', () => {
    const goodNotesZip = () => write('notes-good.zip', makeZip({
        'index.html': NATIVE_INDEX,
        'version.json': '{"version":"1.2.3","app":"notes"}\n',
        'assets/index-a1.js': 'console.log(1)',
        'manifest.webmanifest': '{}',
    }));

    it('signs the native Notes build and says so in <out>.channel (positive control)', () => {
        const r = sign(goodNotesZip(), notesKey, notesVersion(), true);
        expect(r.status, r.stderr).toBe(0);
        expect(fs.readFileSync(`${r.out}.channel`, 'utf8').trim()).toBe('notes');
        expect(fs.readFileSync(`${r.out}.version`, 'utf8').trim()).toBe('1.2.3');
        const { ivSessionKey, checksum } = JSON.parse(r.stdout);
        expect(ivSessionKey.length).toBe(369);
        expect(checksum.length).toBe(512);
    });

    it('stored (not deflated) entries are read too', () => {
        const zip = write('notes-stored.zip', makeZip({
            'index.html': NATIVE_INDEX,
            'version.json': '{"version":"1.2.3","app":"notes"}\n',
        }, false));
        expect(sign(zip, notesKey, notesVersion(), true).status).toBe(0);
    });

    it.each([
        ['a Púca version.json', () => pucaVersion(), /says app "puca", but --notes/],
        ['a legacy version.json (no app = Púca)', () => legacyVersion(), /says app "puca", but --notes/],
    ])('REFUSES %s', (_n, vj, msg) => {
        const r = sign(goodNotesZip(), notesKey, vj(), true);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(msg);
        expect(fs.existsSync(r.out), 'nothing written').toBe(false);
    });

    it.each([
        ['the WEB build (dist/notes: base /notes/, no CSP, no version.json)', {
            'index.html': '<!doctype html><html><head><script type="module" src="/notes/assets/index-n1.js"></script></head></html>',
            'assets/index-n1.js': '',
        }, /no readable version.json|0 Content-Security-Policy|loads from \/notes\//],
        ['a zip whose own version.json says puca', {
            'index.html': NATIVE_INDEX, 'version.json': '{"version":"1.2.3","app":"puca"}',
        }, /says app "puca", not "notes"/],
        ['a zip whose own version.json names another version', {
            'index.html': NATIVE_INDEX, 'version.json': '{"version":"1.2.4","app":"notes"}',
        }, /says 1\.2\.4/],
        ['no CSP meta', {
            'index.html': '<!doctype html><html><head></head></html>', 'version.json': '{"version":"1.2.3","app":"notes"}',
        }, /0 Content-Security-Policy metas/],
        ['two CSP metas', {
            'index.html': `<html><head>${CSP}${CSP}</head></html>`, 'version.json': '{"version":"1.2.3","app":"notes"}',
        }, /2 Content-Security-Policy metas/],
        ['the directory zipped instead of its contents', {
            'dist-notes-app/index.html': NATIVE_INDEX, 'dist-notes-app/version.json': '{"version":"1.2.3","app":"notes"}',
        }, /no index.html at the zip root/],
        ['a second HTML page', {
            'index.html': NATIVE_INDEX, 'version.json': '{"version":"1.2.3","app":"notes"}', 'notes/index.html': '<html></html>',
        }, /second HTML entry point \(notes\/index.html\)/],
    ])('REFUSES %s', (_n, entries, msg) => {
        const zip = write(`notes-bad-${Math.random().toString(36).slice(2)}.zip`, makeZip(entries as Record<string, string>));
        const r = sign(zip, notesKey, notesVersion(), true);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(msg);
        expect(fs.existsSync(r.out)).toBe(false);
        expect(fs.existsSync(`${r.out}.channel`)).toBe(false);
    });
});

describe('scripts/zip-dir.mjs: the zip build-notes-app --ota writes', () => {
    it('zips a directory\'s CONTENTS, nested files included, and the signer accepts it', async () => {
        const { zipDirectory } = await import('../../scripts/zip-dir.mjs');
        const dir = path.join(tmp, 'dist-notes-app-fixture');
        fs.mkdirSync(path.join(dir, 'assets', 'deep'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), NATIVE_INDEX);
        fs.writeFileSync(path.join(dir, 'version.json'), '{"version":"1.2.3","app":"notes"}\n');
        fs.writeFileSync(path.join(dir, 'assets', 'deep', 'x.js'), 'x'.repeat(5000));
        const zip = write('zipdir.zip', zipDirectory(dir));
        const r = sign(zip, notesKey, notesVersion(), true);
        expect(r.status, r.stderr).toBe(0);
        const { ivSessionKey, checksum } = JSON.parse(r.stdout);
        expect(verify(r.out, ivSessionKey, checksum, notesCfg).status).toBe(0);
        // The names are forward-slash and relative to the directory.
        const names = [...fs.readFileSync(zip).toString('latin1').matchAll(/assets\/deep\/x\.js/g)];
        expect(names.length).toBeGreaterThanOrEqual(2); // local header + central directory
    });
});

describe('encrypt-bundle without a flag: Púca, as before', () => {
    const pucaZip = () => write('puca-good.zip', makeZip({
        'index.html': '<html><head></head></html>',
        'version.json': '{"version":"1.2.3","app":"puca"}',
        'assets/index-abc.js': '',
    }));

    it.each([
        ['app "puca"', () => pucaVersion()],
        ['no app field (every bundle built before it existed)', () => legacyVersion()],
    ])('signs a Púca bundle whose version.json has %s, channel puca (positive control)', (_n, vj) => {
        const r = sign(pucaZip(), pucaKey, vj(), false);
        expect(r.status, r.stderr).toBe(0);
        expect(fs.readFileSync(`${r.out}.channel`, 'utf8').trim()).toBe('puca');
    });

    it('REFUSES a Notes version.json: sign it with --notes', () => {
        const r = sign(pucaZip(), pucaKey, notesVersion(), false);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/signed with --notes/);
    });

    it('REFUSES a zip that is the Notes build even when the argument says Púca', () => {
        const zip = write('puca-is-notes.zip', makeZip({ 'index.html': NATIVE_INDEX, 'version.json': '{"version":"1.2.3","app":"notes"}' }));
        const r = sign(zip, pucaKey, pucaVersion(), false);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/is a Púca Notes bundle/);
    });

    it('still REFUSES notes/ entries', () => {
        const zip = write('puca-dirty.zip', makeZip({ 'index.html': '', 'notes/index.html': '' }));
        const r = sign(zip, pucaKey, pucaVersion(), false);
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/contains 1 notes\/ entry/);
    });

    it('an unknown flag is a usage error, not a silent Púca signing', () => {
        const r = spawnSync(process.execPath, [ENCRYPT, '--note', pucaZip(), pucaKey, path.join(tmp, 'x.enc.zip'), pucaVersion()], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/unknown option/);
    });
});

describe('verify-bundle: the signature belongs to the TARGET app', () => {
    it('a Notes-signed bundle verifies under the Notes config and NOT under Púca\'s', () => {
        const zip = write('v-notes.zip', makeZip({ 'index.html': NATIVE_INDEX, 'version.json': '{"version":"1.2.3","app":"notes"}' }));
        const r = sign(zip, notesKey, notesVersion(), true);
        const { ivSessionKey, checksum } = JSON.parse(r.stdout);
        const ok = verify(r.out, ivSessionKey, checksum, notesCfg);
        expect(ok.status, ok.text).toBe(0);
        const wrong = verify(r.out, ivSessionKey, checksum, pucaCfg);
        expect(wrong.status).toBe(1);
        expect(wrong.text).toMatch(/DIFFERENT private key|does not verify/);
    });

    it('a Púca-signed bundle verifies under Púca\'s config and NOT under the Notes one', () => {
        const zip = write('v-puca.zip', makeZip({ 'index.html': '<html></html>', 'version.json': '{"version":"1.2.3"}' }));
        const r = sign(zip, pucaKey, legacyVersion(), false);
        const { ivSessionKey, checksum } = JSON.parse(r.stdout);
        expect(verify(r.out, ivSessionKey, checksum, pucaCfg).status).toBe(0);
        expect(verify(r.out, ivSessionKey, checksum, notesCfg).status).toBe(1);
    });

    it('a tampered bundle fails under the right key', () => {
        const zip = write('v-tamper.zip', makeZip({ 'index.html': '<html></html>' }));
        const r = sign(zip, pucaKey, legacyVersion(), false);
        const { ivSessionKey, checksum } = JSON.parse(r.stdout);
        const enc = fs.readFileSync(r.out);
        enc[0] ^= 0xff;
        fs.writeFileSync(r.out, enc);
        expect(verify(r.out, ivSessionKey, checksum, pucaCfg).status).toBe(1);
    });

    it('the real configs carry two different keys, and the Notes one is readable', async () => {
        const { publicKeyFromConfig } = await import('../../../deploy/mobile/verify-bundle.mjs');
        const notes = publicKeyFromConfig(fs.readFileSync(path.join(REPO, 'frontend', 'notes-app', 'capacitor.config.ts'), 'utf8'));
        const puca = publicKeyFromConfig(fs.readFileSync(path.join(REPO, 'frontend', 'capacitor.config.ts'), 'utf8'));
        expect(notes).toMatch(/^-----BEGIN RSA PUBLIC KEY-----\n/);
        expect(puca).toMatch(/^-----BEGIN RSA PUBLIC KEY-----\n/);
        expect(notes).not.toBe(puca);
    });
});
