/**
 * Púca Notes' native floor lives in the tree (notes-app/native-min.json), not
 * in a ship flag — scripts/notes-native-min.mjs has why. These pin the three
 * links the floor travels through on the tree side:
 *
 *  - the record still describes the APK's native surface, so a change that
 *    adds a plugin, package or permission cannot land without someone
 *    deciding what native.min must now be (the real tree is the positive
 *    control; each kind of drift is a negative);
 *  - the Notes build writes the floor into version.json (and Púca's does not);
 *  - the floor is a valid version.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNativeMin, nativeSurface, readNativeMin, versionGt } from '../../scripts/notes-native-min.mjs';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- <uses-permission android:name="android.permission.CAMERA" /> -->
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`;
const PKG = { dependencies: { '@capacitor/android': '*', '@capacitor/core': '*', '@capgo/capacitor-updater': '8.51.15' } };
const RECORD = {
    min: '0.9.816',
    surface: {
        packages: ['@capacitor/android', '@capacitor/core', '@capgo/capacitor-updater'],
        plugins: [],
        permissions: ['android.permission.INTERNET'],
    },
};
const surfaceOf = (over: Partial<{ notesPkg: object; javaSources: { name: string; text: string }[]; manifestXml: string }> = {}) =>
    nativeSurface({ notesPkg: PKG, javaSources: [{ name: 'MainActivity.java', text: 'public class MainActivity extends BridgeActivity {}' }], manifestXml: MANIFEST, ...over });

describe('checkNativeMin', () => {
    it('passes on the real tree (positive control)', () => {
        const { record, surface } = readNativeMin(FRONTEND);
        expect(checkNativeMin(record, surface).failures).toEqual([]);
    });

    it('passes on a matching fixture (positive control for the negatives below)', () => {
        expect(checkNativeMin(RECORD, surfaceOf()).failures).toEqual([]);
    });

    it('FAILS when a Java @CapacitorPlugin is added and the record is not', () => {
        const s = surfaceOf({ javaSources: [
            { name: 'MainActivity.java', text: 'class MainActivity {}' },
            { name: 'NotesAlarmPlugin.java', text: '@CapacitorPlugin(\n    name = "NotesAlarm"\n)\npublic class NotesAlarmPlugin extends Plugin {}' },
        ] });
        const out = checkNativeMin(RECORD, s).failures.join('\n');
        expect(out).toMatch(/plugins added: NotesAlarmPlugin/);
        expect(out).toMatch(/raise "min"/);
    });

    it('a plugin annotation inside a comment is not a plugin', () => {
        const s = surfaceOf({ javaSources: [{ name: 'Old.java', text: '// @CapacitorPlugin(name = "x")\n/* @CapacitorPlugin */ class Old {}' }] });
        expect(s.plugins).toEqual([]);
    });

    it('FAILS when a Capacitor package is added', () => {
        const s = surfaceOf({ notesPkg: { dependencies: { ...PKG.dependencies, '@capacitor/filesystem': '8.1.3' } } });
        expect(checkNativeMin(RECORD, s).failures.join('\n')).toMatch(/packages added: @capacitor\/filesystem/);
    });

    it('FAILS when a permission is added — and a commented-out one does not count', () => {
        expect(surfaceOf().permissions).toEqual(['android.permission.INTERNET']);
        const s = surfaceOf({ manifestXml: MANIFEST.replace('</manifest>', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>') });
        expect(checkNativeMin(RECORD, s).failures.join('\n')).toMatch(/permissions added: android\.permission\.POST_NOTIFICATIONS/);
    });

    it('FAILS on a removal too (the record must describe the APK as it is)', () => {
        const s = surfaceOf({ notesPkg: { dependencies: { '@capacitor/android': '*', '@capacitor/core': '*' } } });
        expect(checkNativeMin(RECORD, s).failures.join('\n')).toMatch(/packages removed: @capgo\/capacitor-updater/);
    });

    it.each([undefined, '', '0.9', '0.9.816-beta', 816])('FAILS on a min of %j', (min) => {
        expect(checkNativeMin({ ...RECORD, min }, surfaceOf()).failures.join('\n')).toMatch(/not a MAJOR\.MINOR\.PATCH version/);
    });
});

describe('versionGt', () => {
    it.each([
        ['0.9.816', '0.9.815', true],
        ['0.9.815', '0.9.816', false],
        ['0.9.816', '0.9.816', false],
        ['0.9.9160', '0.9.816', true],
        ['0.10.0', '0.9.999', true],
        ['1.0.0', '0.99.99', true],
    ])('%s > %s = %s', (a, b, want) => {
        expect(versionGt(a, b)).toBe(want);
    });
});

describe('emitVersionJson: the floor rides in the Notes bundle\'s version.json', () => {
    // vite.shared.ts is build-time code (it reads files relative to its own
    // URL and imports vite), so it runs under node itself, not under jsdom.
    const emitted = (app: 'puca' | 'notes') => {
        const script = `const m = await import('./vite.shared.ts'); const f = [];`
            + ` m.emitVersionJson(${JSON.stringify(app)}).generateBundle.call({ emitFile: x => f.push(x) });`
            + ' process.stdout.write(JSON.stringify(f));';
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { cwd: FRONTEND, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const files = JSON.parse(r.stdout) as { fileName: string; source: string }[];
        expect(files.map(f => f.fileName)).toEqual(['version.json']);
        return JSON.parse(files[0].source);
    };

    it('the Notes build carries notes-app/native-min.json\'s min', () => {
        const tree = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'notes-app', 'native-min.json'), 'utf8')).min;
        expect(emitted('notes')).toMatchObject({ app: 'notes', nativeMin: tree });
    });

    it('Púca\'s build carries none (control: the field is the Notes channel\'s alone)', () => {
        expect(emitted('puca')).not.toHaveProperty('nativeMin');
    });
});
