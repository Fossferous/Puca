/**
 * The packaging invariants in scripts/notes-ota-identity.mjs, fed broken
 * configs — plus the real files as the positive control, so a checker that
 * failed everything would fail here too — and scripts/stage-desktop-dist.mjs
 * against a scratch dist/.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDesktopDist, checkNotesOta, updaterPublicKey } from '../../scripts/notes-ota-identity.mjs';
import { stageDesktopDist } from '../../scripts/stage-desktop-dist.mjs';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

const real = () => ({
    notesCfg: read('notes-app/capacitor.config.ts'),
    pucaCfg: read('capacitor.config.ts'),
    notesPkg: readJson('notes-app/package.json'),
    frontendUpdaterVersion: readJson('package-lock.json').packages['node_modules/@capgo/capacitor-updater'].version as string,
});

describe('checkNotesOta', () => {
    it('passes on the real configs (positive control)', () => {
        expect(checkNotesOta(real()).failures).toEqual([]);
    });

    it('reads both keys, and they differ', () => {
        const r = real();
        const notes = updaterPublicKey(r.notesCfg)!;
        const puca = updaterPublicKey(r.pucaCfg)!;
        expect(notes).toMatch(/^-----BEGIN RSA PUBLIC KEY-----\n/);
        expect(puca).toMatch(/^-----BEGIN RSA PUBLIC KEY-----\n/);
        expect(notes).not.toBe(puca);
    });

    it('FAILS when the Notes app embeds Púca\'s key (a Púca bundle would verify inside Notes)', () => {
        const r = real();
        const pucaKeyLiteral = /publicKey:\s*((?:'[^']*'\s*\+?\s*)+)/.exec(r.pucaCfg)![1];
        const notesCfg = r.notesCfg.replace(/publicKey:\s*((?:'[^']*'\s*\+?\s*)+)/, `publicKey: ${pucaKeyLiteral}`);
        const out = checkNotesOta({ ...r, notesCfg });
        expect(out.failures.join('\n')).toMatch(/EQUALS Púca's/);
    });

    it.each([
        ['autoUpdate on', (s: string) => s.replace('autoUpdate: false', 'autoUpdate: true'), /autoUpdate must be false/],
        ['telemetry on', (s: string) => s.replace("statsUrl: ''", "statsUrl: 'https://stats.example.com'"), /statsUrl/],
        ['allowModifyUrl', (s: string) => s.replace('autoUpdate: false,', 'autoUpdate: false, allowModifyUrl: true,'), /allowModifyUrl must stay false/],
        ['allowNavigation', (s: string) => s.replace("androidScheme:", "allowNavigation: ['download.example.com'], androidScheme:"), /allowNavigation/],
        ['no updater block', (s: string) => s.replace(/CapacitorUpdater\s*:/, 'NotTheUpdater:'), /no CapacitorUpdater block/],
    ])('FAILS: %s', (_name, mutate, msg) => {
        const r = real();
        const out = checkNotesOta({ ...r, notesCfg: mutate(r.notesCfg) });
        expect(out.failures.join('\n')).toMatch(msg);
    });

    it('a comment cannot satisfy it, nor trip it', () => {
        const r = real();
        // The real file's own comment names allowNavigation — and passes.
        expect(r.notesCfg).toMatch(/\/\/.*allowNavigation/);
        expect(checkNotesOta(r).failures).toEqual([]);
    });

    it.each([
        ['unpinned', '*'],
        ['a range', '^8.51.15'],
        ['another version', '8.51.14'],
    ])('FAILS when the native half is %s', (_name, pin) => {
        const r = real();
        const out = checkNotesOta({ ...r, notesPkg: { dependencies: { ...r.notesPkg.dependencies, '@capgo/capacitor-updater': pin } } });
        expect(out.failures.join('\n')).toMatch(/Pin it EXACTLY/);
    });

    it('FAILS when the Notes app carries no updater at all', () => {
        const r = real();
        const deps = { ...r.notesPkg.dependencies };
        delete deps['@capgo/capacitor-updater'];
        expect(checkNotesOta({ ...r, notesPkg: { dependencies: deps } }).failures.join('\n')).toMatch(/carry no updater/);
    });
});

describe('checkDesktopDist', () => {
    const strip = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('//')).map(([k, x]) => [k, strip(x)]));
        return v;
    };
    const base = strip(readJson('src-tauri/tauri.conf.json')) as { build: Record<string, string> };
    const lite = strip(readJson('src-tauri/tauri.lite.conf.json')) as { build: Record<string, string> };
    const win = strip(readJson('src-tauri/tauri.windows.conf.json')) as Record<string, unknown>;

    it('passes on the real configs (positive control)', () => {
        expect(checkDesktopDist(base, lite, win).failures).toEqual([]);
    });

    it('FAILS when the installer embeds dist/ again', () => {
        const b = { ...base, build: { ...base.build, frontendDist: '../dist' } };
        expect(checkDesktopDist(b, lite, win).failures.join('\n')).toMatch(/embed Púca Notes/);
    });

    it('FAILS when the full build stops staging', () => {
        const b = { ...base, build: { ...base.build, beforeBuildCommand: 'npm run build' } };
        expect(checkDesktopDist(b, lite, win).failures.join('\n')).toMatch(/STALE/);
    });

    it('FAILS when Lite points somewhere else', () => {
        const l = { ...lite, build: { ...lite.build, frontendDist: '../dist' } };
        expect(checkDesktopDist(base, l, win).failures.join('\n')).toMatch(/tauri.lite.conf.json overrides/);
    });
});

describe('stageDesktopDist', () => {
    let tmp: string;
    afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

    function scratchDist(): string {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puca-stage-'));
        const dist = path.join(tmp, 'dist');
        fs.mkdirSync(path.join(dist, 'assets', 'notes'), { recursive: true });
        fs.mkdirSync(path.join(dist, 'notes', 'assets'), { recursive: true });
        fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
        fs.writeFileSync(path.join(dist, 'version.json'), '{"version":"0.9.815"}');
        fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), '');
        fs.writeFileSync(path.join(dist, 'assets', 'notes', 'kept.svg'), '');
        fs.writeFileSync(path.join(dist, 'notes', 'index.html'), '<!doctype html>');
        fs.writeFileSync(path.join(dist, 'notes', 'assets', 'index-def.js'), '');
        return dist;
    }

    it('copies everything except the top-level notes/, and leaves dist/ untouched', () => {
        const dist = scratchDist();
        const out = path.join(tmp, 'dist-desktop');
        expect(stageDesktopDist(dist, out)).toEqual([]);
        expect(fs.existsSync(path.join(out, 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'version.json'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'assets', 'index-abc.js'))).toBe(true);
        expect(fs.existsSync(path.join(out, 'assets', 'notes', 'kept.svg')), 'a nested "notes" folder is not Púca Notes').toBe(true);
        expect(fs.existsSync(path.join(out, 'notes'))).toBe(false);
        expect(fs.existsSync(path.join(dist, 'notes', 'index.html')), 'the webapp tarball keeps Notes').toBe(true);
    });

    it('wipes a stale copy first (a Lite build must not inherit a Full one)', () => {
        const dist = scratchDist();
        const out = path.join(tmp, 'dist-desktop');
        fs.mkdirSync(path.join(out, 'stale'), { recursive: true });
        fs.writeFileSync(path.join(out, 'stale', 'devices.js'), '');
        expect(stageDesktopDist(dist, out)).toEqual([]);
        expect(fs.existsSync(path.join(out, 'stale'))).toBe(false);
    });

    it('refuses when there is no build to stage', () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puca-stage-'));
        const out = path.join(tmp, 'dist-desktop');
        expect(stageDesktopDist(path.join(tmp, 'dist'), out).join('\n')).toMatch(/run the frontend build first/);
        expect(fs.existsSync(out)).toBe(false);
    });
});
