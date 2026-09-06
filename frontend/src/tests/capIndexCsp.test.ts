/**
 * scripts/cap-index-csp.mjs — the Content-Security-Policy the Android
 * WebView gets by a <meta> in the SYNCED index.html.
 *
 * What these tests pin, and why each could go red:
 *  - the tag is inserted ONCE, directly after the literal `<head>`, ahead of
 *    the app's own module script — Capacitor's bridge is injected right after
 *    `<head>` and is exempt only because it precedes the meta; the app script
 *    is bound only because it follows it;
 *  - the transform is idempotent (running the build step twice cannot stack
 *    two policies, and cannot change bytes on a second pass);
 *  - the web dist is refused as a target, so the server header stays the one
 *    policy for the browser app;
 *  - the policy names the API origin the build was made against, and refuses
 *    to guess when there is none — a stale or wrong origin would silently
 *    block every login on the handset.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPolicy, injectCsp, metaTag, applyToFile } from '../../scripts/cap-index-csp.mjs';

const POLICY = buildPolicy({ apiUrl: 'https://chat.example.org' });

const DIST_INDEX = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <title>Púca</title>',
    '    <script type="module" crossorigin src="/assets/index-abc123.js"></script>',
    '    <link rel="stylesheet" crossorigin href="/assets/index-def456.css">',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '  </body>',
    '</html>',
    '',
].join('\n');

function count(html: string, needle: RegExp): number {
    return (html.match(needle) ?? []).length;
}
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"/g;

describe('buildPolicy', () => {
    it('names the API origin in https and wss form, the SFU by scheme, and blob: for copyImage (the lightbox object URL)', () => {
        const connect = POLICY.split('; ').find((d) => d.startsWith('connect-src '))!;
        expect(connect).toBe("connect-src 'self' https://chat.example.org wss://chat.example.org wss: blob:");
    });
    it('does not open http/ws for an https deployment', () => {
        expect(POLICY).not.toMatch(/\bhttp:\s|\bws:\s|\bws:$/);
        expect(POLICY).not.toContain('http://');
    });
    it('adds the http/ws forms only for an http (LAN) API', () => {
        const p = buildPolicy({ apiUrl: 'http://192.168.1.22:3000' });
        const connect = p.split('; ').find((d) => d.startsWith('connect-src '))!;
        expect(connect).toBe("connect-src 'self' http://192.168.1.22:3000 ws://192.168.1.22:3000 wss: ws: blob:");
    });
    it('includes the update fallback origin once, deduplicated against the API', () => {
        const same = buildPolicy({ apiUrl: 'https://chat.example.org', fallbackApiUrl: 'https://chat.example.org/' });
        expect(same).toBe(POLICY);
        const other = buildPolicy({ apiUrl: 'https://chat.example.org', fallbackApiUrl: 'https://alt.example.org' });
        expect(other).toContain("connect-src 'self' https://chat.example.org wss://chat.example.org https://alt.example.org wss://alt.example.org wss: blob:");
    });
    it('keeps the directives the web header has, minus the meta-ignored frame-ancestors', () => {
        expect(POLICY).toContain("default-src 'self'");
        expect(POLICY).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(POLICY).toContain("worker-src 'self' blob:");
        expect(POLICY).toContain("object-src 'none'");
        expect(POLICY).toContain("base-uri 'self'");
        expect(POLICY).not.toContain('frame-ancestors');
        // Neither inline nor eval'd script: an XSS must not be able to run.
        expect(POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(POLICY).not.toMatch(/'unsafe-eval'/);
        // It is an attribute value.
        expect(POLICY).not.toContain('"');
    });
    it('refuses to guess: no URL, a bare hostname, or a non-http scheme all throw', () => {
        expect(() => buildPolicy({})).toThrow(/apiUrl/);
        expect(() => buildPolicy({ apiUrl: '' })).toThrow(/apiUrl/);
        expect(() => buildPolicy({ apiUrl: 'chat.example.org' })).toThrow(/absolute URL/);
        expect(() => buildPolicy({ apiUrl: 'ftp://chat.example.org' })).toThrow(/http\(s\)/);
    });
});

describe('injectCsp', () => {
    it('inserts the tag exactly once, first thing after <head>, before the module script', () => {
        const out = injectCsp(DIST_INDEX, POLICY);
        expect(count(out, CSP_META)).toBe(1);
        const tag = metaTag(POLICY);
        expect(out.indexOf(tag)).toBeLessThan(out.indexOf('<script'));
        expect(out).toContain('<head>\n    ' + tag + '\n    <meta charset="UTF-8" />');
        // Everything else is byte-for-byte the input.
        expect(out.replace('\n    ' + tag, '')).toBe(DIST_INDEX);
    });
    it('is idempotent: a second pass returns identical bytes, never a second tag', () => {
        const once = injectCsp(DIST_INDEX, POLICY);
        const twice = injectCsp(once, POLICY);
        expect(twice).toBe(once);
        expect(count(twice, CSP_META)).toBe(1);
    });
    it('replaces a single existing policy in place rather than stacking', () => {
        const old = injectCsp(DIST_INDEX, buildPolicy({ apiUrl: 'https://old.example.org' }));
        const out = injectCsp(old, POLICY);
        expect(count(out, CSP_META)).toBe(1);
        expect(out).not.toContain('old.example.org');
        expect(out).toContain(metaTag(POLICY));
    });
    it('refuses two existing policies', () => {
        const tag = metaTag(POLICY);
        const doubled = DIST_INDEX.replace('<head>', '<head>\n' + tag + '\n' + tag);
        expect(() => injectCsp(doubled, POLICY)).toThrow(/2 Content-Security-Policy metas/);
    });
    it("refuses an index.html without a literal <head> (Capacitor's bridge would then follow the meta)", () => {
        const attr = DIST_INDEX.replace('<head>', '<head lang="en">');
        expect(() => injectCsp(attr, POLICY)).toThrow(/no literal <head>/);
        // Positive control for the rig: the same document with the literal is accepted.
        expect(() => injectCsp(DIST_INDEX, POLICY)).not.toThrow();
    });
    it('keeps CRLF line endings when the file has them', () => {
        const crlf = DIST_INDEX.replace(/\n/g, '\r\n');
        const out = injectCsp(crlf, POLICY);
        expect(out).toContain('<head>\r\n    ' + metaTag(POLICY) + '\r\n');
        expect(out).not.toMatch(/[^\r]\n/);
    });
});

describe('applyToFile', () => {
    function rig() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-csp-'));
        const dist = path.join(root, 'dist');
        const android = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
        fs.mkdirSync(dist, { recursive: true });
        fs.mkdirSync(android, { recursive: true });
        fs.writeFileSync(path.join(dist, 'index.html'), DIST_INDEX);
        fs.writeFileSync(path.join(android, 'index.html'), DIST_INDEX);
        return { root, dist, distIndex: path.join(dist, 'index.html'), androidIndex: path.join(android, 'index.html') };
    }

    it('writes the synced copy and leaves the web dist byte-identical', () => {
        const r = rig();
        try {
            const res = applyToFile(r.androidIndex, POLICY, { webDist: r.dist });
            expect(res.changed).toBe(true);
            const synced = fs.readFileSync(r.androidIndex, 'utf8');
            expect(count(synced, CSP_META)).toBe(1);
            expect(synced).toBe(injectCsp(DIST_INDEX, POLICY));
            expect(fs.readFileSync(r.distIndex, 'utf8')).toBe(DIST_INDEX);
            // Second run: nothing to do, nothing rewritten.
            expect(applyToFile(r.androidIndex, POLICY, { webDist: r.dist }).changed).toBe(false);
            expect(fs.readFileSync(r.androidIndex, 'utf8')).toBe(synced);
        } finally {
            fs.rmSync(r.root, { recursive: true, force: true });
        }
    });
    it('refuses a target inside the web dist, and touches nothing', () => {
        const r = rig();
        try {
            expect(() => applyToFile(r.distIndex, POLICY, { webDist: r.dist })).toThrow(/refusing to touch the web dist/);
            expect(fs.readFileSync(r.distIndex, 'utf8')).toBe(DIST_INDEX);
        } finally {
            fs.rmSync(r.root, { recursive: true, force: true });
        }
    });
    it('dry-run reports the change without writing', () => {
        const r = rig();
        try {
            expect(applyToFile(r.androidIndex, POLICY, { webDist: r.dist, dryRun: true }).changed).toBe(true);
            expect(fs.readFileSync(r.androidIndex, 'utf8')).toBe(DIST_INDEX);
        } finally {
            fs.rmSync(r.root, { recursive: true, force: true });
        }
    });
});
