/**
 * deploy/ops/make-web-clip-profile.mjs: the iPhone/iPad "Install with one tap"
 * profile. The page promises exactly what the file holds ("one icon, nothing
 * else: no certificates, no restrictions"), so these cases read the finished
 * property list back and check the promise itself, not just that XML came out:
 * the inner payload's keys are an exact list, there is exactly one payload, the
 * embedded icon is the 180 px icon byte for byte, and each refusal has a
 * positive control beside it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { webClipProfile, uuidFor, pngSize } from '../../../deploy/ops/make-web-clip-profile.mjs';

const ICON_PATH = path.resolve(__dirname, '../../public/apple-touch-icon.png');
const SCRIPT = path.resolve(__dirname, '../../../deploy/ops/make-web-clip-profile.mjs');
const icon = fs.readFileSync(ICON_PATH);
const URL_A = 'https://app.one.invalid/';

/** The keys of the dict(s) directly inside <array> of PayloadContent, and the rest of the profile. */
function parts(profile: string) {
    const m = profile.match(/<key>PayloadContent<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!m) throw new Error('no PayloadContent array');
    const inner = m[1];
    const outer = profile.replace(m[0], '');
    const keys = (s: string) => [...s.matchAll(/<key>([^<]+)<\/key>/g)].map((x) => x[1]);
    const dicts = inner.match(/<dict>/g)?.length ?? 0;
    return { inner, outer, innerKeys: keys(inner), outerKeys: keys(outer), dicts };
}

function valueOf(s: string, key: string): string {
    const m = s.match(new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`));
    if (!m) throw new Error(`no ${key}`);
    return m[2];
}

describe('web clip profile contents', () => {
    const profile = webClipProfile({ url: URL_A, iconPng: icon });
    const { inner, outer, innerKeys, outerKeys, dicts } = parts(profile);

    it('is exactly one Web Clip payload and nothing else', () => {
        expect(dicts).toBe(1);
        expect(valueOf(inner, 'PayloadType')).toBe('com.apple.webClip.managed');
        expect(valueOf(outer, 'PayloadType')).toBe('Configuration');
        // every payload type in the whole file: the profile itself and the one clip
        expect([...profile.matchAll(/<key>PayloadType<\/key>\s*<string>([^<]+)<\/string>/g)].map((x) => x[1]).sort())
            .toEqual(['Configuration', 'com.apple.webClip.managed']);
    });

    it('carries the address, label, icon, FullScreen and IsRemovable: an exact key list', () => {
        expect([...innerKeys].sort()).toEqual([
            'FullScreen', 'Icon', 'IsRemovable', 'Label', 'PayloadDescription', 'PayloadDisplayName',
            'PayloadIdentifier', 'PayloadType', 'PayloadUUID', 'PayloadVersion', 'URL',
        ]);
        expect([...outerKeys].sort()).toEqual([
            'PayloadDescription', 'PayloadDisplayName', 'PayloadIdentifier', 'PayloadRemovalDisallowed',
            'PayloadType', 'PayloadUUID', 'PayloadVersion',
        ]);
        expect(inner).toMatch(/<key>FullScreen<\/key>\s*<true\/>/);
        expect(inner).toMatch(/<key>IsRemovable<\/key>\s*<true\/>/);
        expect(valueOf(inner, 'Label')).toBe('Púca');
        expect(valueOf(inner, 'URL')).toBe(URL_A);
    });

    it('promises nothing it does not hold: no certificate, restriction, VPN or scope override', () => {
        // keys and payload types only: the human-readable description says these words on purpose
        const names = [...profile.matchAll(/<key>([^<]+)<\/key>/g)].map((x) => x[1].toLowerCase()).join(' ');
        for (const word of ['certificate', 'restrictions', 'vpn', 'password', 'scope', 'mdm', 'server', 'proxy']) {
            expect(names).not.toContain(word);
        }
        expect(profile).not.toContain('security.');
    });

    it('embeds the 180 px icon byte for byte', () => {
        const b64 = inner.match(/<key>Icon<\/key>\s*<data>([\s\S]*?)<\/data>/)![1].replace(/\s+/g, '');
        const decoded = Buffer.from(b64, 'base64');
        expect(decoded.equals(icon)).toBe(true);
        expect(pngSize(decoded)).toEqual({ width: 180, height: 180 });
    });

    it('is a well-formed property list header', () => {
        expect(profile.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
        expect(profile).toContain('<plist version="1.0">');
        expect(profile.trimEnd().endsWith('</plist>')).toBe(true);
    });
});

describe('identifiers are per deployment and stable', () => {
    const a = webClipProfile({ url: URL_A, iconPng: icon });
    const b = webClipProfile({ url: 'https://app.two.invalid/', iconPng: icon });

    it('the same host renders the same bytes (a re-install replaces the clip)', () => {
        expect(webClipProfile({ url: URL_A, iconPng: icon })).toBe(a);
    });

    it('two hosts never share an identifier or a UUID', () => {
        for (const key of ['PayloadIdentifier', 'PayloadUUID']) {
            expect(valueOf(parts(a).outer, key)).not.toBe(valueOf(parts(b).outer, key));
            expect(valueOf(parts(a).inner, key)).not.toBe(valueOf(parts(b).inner, key));
        }
        expect(valueOf(parts(a).outer, 'PayloadIdentifier')).toBe('app.puca.webclip.app-one-invalid');
    });

    it('the profile and its clip have different UUIDs, shaped like UUIDs', () => {
        const outerId = valueOf(parts(a).outer, 'PayloadUUID');
        const innerId = valueOf(parts(a).inner, 'PayloadUUID');
        expect(outerId).not.toBe(innerId);
        for (const id of [outerId, innerId, uuidFor('x')]) {
            expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
        }
    });

    it('a label or address with XML metacharacters is escaped, not injected', () => {
        const p = webClipProfile({ url: 'https://app.three.invalid/?a=1&b=<x>', iconPng: icon, label: 'P<ú>&ca' });
        expect(p).toContain('<string>https://app.three.invalid/?a=1&amp;b=%3Cx%3E</string>');
        expect(p).toContain('<string>P&lt;ú&gt;&amp;ca</string>');
        expect(parts(p).dicts).toBe(1);
    });
});

describe('the Rust route validator is pinned to this generator', () => {
    it('writes exactly the fixture src/update_routes.rs accepts (regenerate it if this changes)', () => {
        const fixture = fs.readFileSync(path.resolve(__dirname, '../../../deploy/ops/fixtures/web-clip-profile.example.mobileconfig'), 'utf8');
        expect(webClipProfile({ url: 'https://app.fixture.invalid/', iconPng: icon }))
            .toBe(fixture.replace(/\r\n/g, '\n'));
    });
});

describe('what it refuses', () => {
    const png = (w: number, h: number) => {
        const b = Buffer.from(icon);
        b.writeUInt32BE(w, 16);
        b.writeUInt32BE(h, 20);
        return b;
    };

    it('positive control: a good address and icon render', () => {
        expect(() => webClipProfile({ url: URL_A, iconPng: icon })).not.toThrow();
    });

    it('a non-https, empty, malformed or placeholder address', () => {
        expect(() => webClipProfile({ url: 'http://app.one.invalid/', iconPng: icon })).toThrow(/https/);
        expect(() => webClipProfile({ url: '', iconPng: icon })).toThrow(/not an address/);
        expect(() => webClipProfile({ url: 'not a url', iconPng: icon })).toThrow(/not an address/);
        expect(() => webClipProfile({ url: 'https://chat.example.com/', iconPng: icon })).toThrow(/placeholder/);
    });

    it('an icon that is not a 180x180 PNG', () => {
        expect(() => webClipProfile({ url: URL_A, iconPng: png(192, 192) })).toThrow(/180x180/);
        expect(() => webClipProfile({ url: URL_A, iconPng: png(180, 179) })).toThrow(/180x180/);
        expect(() => webClipProfile({ url: URL_A, iconPng: Buffer.from('GIF89a not a png at all, long enough to pass') })).toThrow(/not a PNG/);
        expect(() => webClipProfile({ url: URL_A, iconPng: Buffer.alloc(0) })).toThrow(/not a PNG/);
    });

    it('an empty label', () => {
        expect(() => webClipProfile({ url: URL_A, iconPng: icon, label: '  ' })).toThrow(/label/);
    });
});

describe('the command line', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

    it('prints the same profile the function makes', () => {
        const r = run(URL_A, ICON_PATH);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(webClipProfile({ url: URL_A, iconPng: icon }));
    });

    it('exits non-zero with a reason on a bad address, a missing icon, and no arguments', () => {
        const bad = run('http://x.invalid/', ICON_PATH);
        expect(bad.status).toBe(1);
        expect(bad.stdout).toBe('');
        expect(bad.stderr).toMatch(/https/);
        const missing = run(URL_A, path.join(__dirname, 'no-such-icon.png'));
        expect(missing.status).not.toBe(0);
        expect(missing.stdout).toBe('');
        expect(run().status).toBe(2);
    });
});
