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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkNativeMin, isNativeLayerPath, latestFingerprint, nativeLayerFiles, nativeLayerHash, nativeSurface, readNativeMin, recordLatest,
    releaseTagged, versionGt,
    type NativeLayerFile, type NativeSurfaceSources,
} from '../../scripts/notes-native-min.mjs';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- <uses-permission android:name="android.permission.CAMERA" /> -->
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>`;
const PKG = { dependencies: { '@capacitor/android': '*', '@capacitor/core': '*', '@capgo/capacitor-updater': '8.51.15' } };
/** A native layer for the fixtures: what the APK is built from. */
const LAYER: NativeLayerFile[] = [
    { path: 'notes-app/android/app/src/main/java/com/sovereign/notes/KeyboardPlan.java', bytes: 'final class KeyboardPlan {\n    static int rows() { return 1; }\n}\n' },
    { path: 'notes-app/android/app/src/main/AndroidManifest.xml', bytes: MANIFEST },
    { path: 'notes-app/android/app/build.gradle', bytes: 'android {\n    defaultConfig {\n        versionCode 9830\n        versionName "0.9.830"\n        minSdkVersion 24\n    }\n}\n' },
    { path: 'notes-app/package.json', bytes: JSON.stringify({ name: 'puca-notes-app', version: '0.0.0', dependencies: { '@capacitor/android': '8.5.2' } }, null, 2) },
];
const LAYER_HASH = nativeLayerHash(LAYER);
const RECORD = {
    min: '0.9.816',
    latest: '0.9.816',
    latestFingerprint: latestFingerprint('0.9.816', LAYER_HASH),
    surface: {
        packages: ['@capacitor/android', '@capacitor/core', '@capgo/capacitor-updater'],
        plugins: [],
        permissions: ['android.permission.INTERNET'],
    },
};
const surfaceOf = (over: Partial<NativeSurfaceSources> = {}) =>
    nativeSurface({ notesPkg: PKG, javaSources: [{ name: 'MainActivity.java', text: 'public class MainActivity extends BridgeActivity {}' }], manifestXml: MANIFEST, ...over });

describe('checkNativeMin', () => {
    it('passes on the real tree (positive control)', () => {
        const { record, surface, layerHash } = readNativeMin(FRONTEND);
        expect(checkNativeMin(record, surface, layerHash).failures).toEqual([]);
    });

    it('passes on a matching fixture (positive control for the negatives below)', () => {
        expect(checkNativeMin(RECORD, surfaceOf(), LAYER_HASH).failures).toEqual([]);
    });

    it('FAILS when a Java @CapacitorPlugin is added and the record is not', () => {
        const s = surfaceOf({ javaSources: [
            { name: 'MainActivity.java', text: 'class MainActivity {}' },
            { name: 'NotesAlarmPlugin.java', text: '@CapacitorPlugin(\n    name = "NotesAlarm"\n)\npublic class NotesAlarmPlugin extends Plugin {}' },
        ] });
        const out = checkNativeMin(RECORD, s, LAYER_HASH).failures.join('\n');
        expect(out).toMatch(/plugins added: NotesAlarmPlugin/);
        expect(out).toMatch(/raise "min"/);
    });

    it('a plugin annotation inside a comment is not a plugin', () => {
        const s = surfaceOf({ javaSources: [{ name: 'Old.java', text: '// @CapacitorPlugin(name = "x")\n/* @CapacitorPlugin */ class Old {}' }] });
        expect(s.plugins).toEqual([]);
    });

    it('FAILS when a Capacitor package is added', () => {
        const s = surfaceOf({ notesPkg: { dependencies: { ...PKG.dependencies, '@capacitor/filesystem': '8.1.3' } } });
        expect(checkNativeMin(RECORD, s, LAYER_HASH).failures.join('\n')).toMatch(/packages added: @capacitor\/filesystem/);
    });

    it('FAILS when a permission is added — and a commented-out one does not count', () => {
        expect(surfaceOf().permissions).toEqual(['android.permission.INTERNET']);
        const s = surfaceOf({ manifestXml: MANIFEST.replace('</manifest>', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>') });
        expect(checkNativeMin(RECORD, s, LAYER_HASH).failures.join('\n')).toMatch(/permissions added: android\.permission\.POST_NOTIFICATIONS/);
    });

    it('FAILS on a removal too (the record must describe the APK as it is)', () => {
        const s = surfaceOf({ notesPkg: { dependencies: { '@capacitor/android': '*', '@capacitor/core': '*' } } });
        expect(checkNativeMin(RECORD, s, LAYER_HASH).failures.join('\n')).toMatch(/packages removed: @capgo\/capacitor-updater/);
    });

    it.each([undefined, '', '0.9', '0.9.816-beta', 816])('FAILS on a min of %j', (min) => {
        expect(checkNativeMin({ ...RECORD, min }, surfaceOf(), LAYER_HASH).failures.join('\n')).toMatch(/not a MAJOR\.MINOR\.PATCH version/);
    });
});

/**
 * `latest` is the newest Notes APK whose NATIVE layer changed: what the
 * manifest's native.version nudges for. It used to be the release number,
 * so every release told every installed app "a new Púca Notes app is
 * available" although 12 of 13 APKs differed only in versionName. It is
 * sealed to a fingerprint of the native layer, so a native change cannot
 * land without someone raising it, and raising it by hand without
 * re-recording fails too.
 */
describe('checkNativeMin: the native layer and "latest"', () => {
    const edit = (p: string, bytes: string): NativeLayerFile[] => LAYER.map(f => (f.path === p ? { path: p, bytes } : f));
    const JAVA = LAYER[0].path;
    const CHANGED_JAVA = 'final class KeyboardPlan {\n    static int rows() { return 2; }\n}\n';
    /** isShipped for recordLatest: only these releases have a v<version> tag. */
    const tagged = (...shipped: string[]) => (v: string) => shipped.includes(v);

    it('passes when the layer matches what "latest" was recorded against (positive control)', () => {
        expect(checkNativeMin(RECORD, surfaceOf(), LAYER_HASH).failures).toEqual([]);
    });

    it('FAILS when a .java file under app/src/main changes and "latest" is not raised', () => {
        // The v0.9.827 KeyboardPlan change: no plugin, package or permission
        // moved, so the SURFACE check above could not see it.
        const changed = nativeLayerHash(edit(JAVA, CHANGED_JAVA));
        expect(changed).not.toBe(LAYER_HASH);
        expect(checkNativeMin(RECORD, surfaceOf(), changed).ok.join('\n'), 'the surface alone is unchanged').toMatch(/surface recorded/);
        const out = checkNativeMin(RECORD, surfaceOf(), changed).failures.join('\n');
        expect(out).toMatch(/native layer changed/);
        expect(out).toMatch(/--record-latest/);
    });

    it('a raised "latest", recorded against the new layer, passes (positive control)', () => {
        const changed = nativeLayerHash(edit(JAVA, CHANGED_JAVA));
        const r = recordLatest(RECORD, '0.9.827', changed, '0.9.826', tagged('0.9.816', '0.9.826'));
        expect(r.error).toBeUndefined();
        expect(r.record?.latest).toBe('0.9.827');
        expect(r.record?.min, 'the floor is untouched').toBe(RECORD.min);
        expect(checkNativeMin(r.record, surfaceOf(), changed).failures).toEqual([]);
    });

    it('re-recording a SHIPPED "latest" is refused, and so is a lower one or one older than the tree', () => {
        expect(recordLatest(RECORD, '0.9.816', 'x', '0.9.816', tagged('0.9.816')).error).toMatch(/0\.9\.816 is the current "latest" and has already shipped \(tag v0\.9\.816\)/);
        expect(recordLatest(RECORD, '0.9.815', 'x', '0.9.814', tagged()).error).toMatch(/older than the current "latest" \(0\.9\.816\)/);
        expect(recordLatest(RECORD, '0.9.820', 'x', '0.9.830', tagged()).error).toMatch(/older than this tree's version \(0\.9\.830\)/);
        expect(recordLatest(RECORD, '0.9', 'x', '0.9.830', tagged()).error).toMatch(/MAJOR\.MINOR\.PATCH/);
    });

    // One release cycle can hold several native changes (0.9.827 touched
    // three native files), and two branches can each record the same next
    // release. Until that release ships, re-sealing it is the only correct
    // answer: the next free number would be refused by every ship gate as
    // "newer than this release".
    it('a second native change before the release ships re-seals the SAME version', () => {
        const h1 = nativeLayerHash(edit(JAVA, CHANGED_JAVA));
        const h2 = nativeLayerHash(edit(JAVA, `${CHANGED_JAVA}// and a second change\n`));
        const first = recordLatest(RECORD, '0.9.831', h1, '0.9.830', tagged('0.9.830'));
        expect(first.error).toBeUndefined();
        expect(checkNativeMin(first.record, surfaceOf(), h2).failures.join('\n'), 'the second change trips the seal').toMatch(/native layer changed/);
        const again = recordLatest(first.record!, '0.9.831', h2, '0.9.830', tagged('0.9.830'));
        expect(again.error).toBeUndefined();
        expect(again.record?.latest).toBe('0.9.831');
        expect(checkNativeMin(again.record, surfaceOf(), h2).failures).toEqual([]);
    });

    it('...but once that version has shipped (its tag exists) it must rise', () => {
        const record = { ...RECORD, latest: '0.9.831', latestFingerprint: latestFingerprint('0.9.831', LAYER_HASH) };
        expect(recordLatest(record, '0.9.831', 'x', '0.9.831', tagged('0.9.830', '0.9.831')).error).toMatch(/0\.9\.831 is the current "latest" and has already shipped/);
        expect(recordLatest(record, '0.9.832', 'x', '0.9.831', tagged('0.9.830', '0.9.831')).error, 'the next one is fine').toBeUndefined();
    });

    it('the tree\'s own version is accepted while it is being prepared (not tagged yet)...', () => {
        expect(recordLatest(RECORD, '0.9.831', LAYER_HASH, '0.9.831', tagged('0.9.830')).error).toBeUndefined();
    });

    it('...and refused once it has shipped: those APKs lack the change and would never be nudged', () => {
        expect(recordLatest(RECORD, '0.9.830', LAYER_HASH, '0.9.830', tagged('0.9.830')).error)
            .toMatch(/0\.9\.830 is this tree's version and has already shipped \(tag v0\.9\.830\)/);
    });

    it('with no way to tell what shipped, equality is refused (the safe default)', () => {
        expect(recordLatest(RECORD, '0.9.830', LAYER_HASH, '0.9.830').error).toMatch(/already shipped/);
        expect(recordLatest(RECORD, '0.9.816', LAYER_HASH, '0.9.815').error).toMatch(/already shipped/);
        expect(recordLatest(RECORD, '0.9.831', LAYER_HASH, '0.9.830').error, 'a strictly newer version needs no answer').toBeUndefined();
    });

    it('FAILS when "latest" is raised by hand without re-recording (the two are sealed together)', () => {
        expect(checkNativeMin({ ...RECORD, latest: '0.9.827' }, surfaceOf(), LAYER_HASH).failures.join('\n')).toMatch(/native layer changed/);
    });

    it.each([undefined, '', '0.9', 827])('FAILS on a latest of %j', (latest) => {
        expect(checkNativeMin({ ...RECORD, latest }, surfaceOf(), LAYER_HASH).failures.join('\n')).toMatch(/"latest" is .* not a MAJOR\.MINOR\.PATCH version/);
    });

    it('FAILS on a latest older than min: the newest native change cannot predate the floor', () => {
        const record = { ...RECORD, min: '0.9.817', latest: '0.9.816' };
        expect(checkNativeMin(record, surfaceOf(), LAYER_HASH).failures.join('\n')).toMatch(/"latest" 0\.9\.816 is older than "min" 0\.9\.817/);
    });

    it('FAILS when no layer fingerprint is handed over (a caller that forgot cannot pass by default)', () => {
        expect(checkNativeMin(RECORD, surfaceOf(), undefined as unknown as string).failures.join('\n')).toMatch(/no native-layer fingerprint/);
    });

    it('line endings do not count: a CRLF checkout fingerprints like an LF one', () => {
        expect(nativeLayerHash(LAYER.map(f => ({ ...f, bytes: String(f.bytes).replace(/\n/g, '\r\n') })))).toBe(LAYER_HASH);
        expect(nativeLayerHash(LAYER.map(f => ({ ...f, bytes: Buffer.from(String(f.bytes).replace(/\n/g, '\r\n')) })))).toBe(LAYER_HASH);
    });

    it('the release number does not count: versionName/versionCode and the package\'s own version are stripped', () => {
        const gradle = LAYER[2].path;
        const bumped = edit(gradle, String(LAYER[2].bytes).replace('9830', '9831').replace('"0.9.830"', '"0.9.831"'));
        expect(nativeLayerHash(bumped)).toBe(LAYER_HASH);
        const pkg = edit('notes-app/package.json', JSON.stringify({ name: 'puca-notes-app', version: '1.0.0', dependencies: { '@capacitor/android': '8.5.2' } }, null, 2));
        expect(nativeLayerHash(pkg)).toBe(LAYER_HASH);
    });

    it('...but everything else does: a dependency bump, a Gradle setting, a new resource, a rename (controls)', () => {
        const dep = edit('notes-app/package.json', JSON.stringify({ name: 'puca-notes-app', version: '0.0.0', dependencies: { '@capacitor/android': '8.5.3' } }, null, 2));
        expect(nativeLayerHash(dep)).not.toBe(LAYER_HASH);
        expect(nativeLayerHash(edit(LAYER[2].path, String(LAYER[2].bytes).replace('24', '26')))).not.toBe(LAYER_HASH);
        expect(nativeLayerHash([...LAYER, { path: 'notes-app/android/app/src/main/res/values/strings.xml', bytes: '<resources/>' }])).not.toBe(LAYER_HASH);
        expect(nativeLayerHash(LAYER.map(f => (f.path === JAVA ? { ...f, path: JAVA.replace('KeyboardPlan', 'KeyboardPlan2') } : f)))).not.toBe(LAYER_HASH);
        // The order files are found in is not a change.
        expect(nativeLayerHash([...LAYER].reverse())).toBe(LAYER_HASH);
    });

    it.each([
        ['notes-app/android/app/src/main/java/com/sovereign/notes/NotesNativePlugin.java', true],
        ['notes-app/android/app/src/main/AndroidManifest.xml', true],
        ['notes-app/android/app/src/main/res/xml/shortcuts.xml', true],
        ['notes-app/android/app/build.gradle', true],
        ['notes-app/android/variables.gradle', true],
        ['notes-app/android/gradle/wrapper/gradle-wrapper.properties', true],
        ['notes-app/package.json', true],
        ['notes-app/package-lock.json', true],
        ['notes-app/capacitor.config.ts', true],
        ['notes-app/android/app/src/test/java/com/sovereign/notes/KeyboardPlanTest.java', false],
        ['notes-app/android/app/src/androidTest/java/com/sovereign/notes/PluginArgsBridgeTest.java', false],
        ['notes-app/native-min.json', false],
    ])('%s is part of the native layer: %s', (p, want) => {
        expect(isNativeLayerPath(p)).toBe(want);
    });

    it('on the REAL tree, editing one .java file under app/src/main moves the fingerprint', () => {
        const { layerFiles, layerHash, record, surface } = readNativeMin(FRONTEND);
        const java = layerFiles.find(f => /app\/src\/main\/java\/.*KeyboardPlan\.java$/.test(f.path));
        expect(java, 'the real layer includes the Java sources').toBeTruthy();
        expect(layerFiles.some(f => /\/src\/(test|androidTest)\//.test(f.path)), 'and not the tests').toBe(false);
        const touched = nativeLayerHash(layerFiles.map(f => (f === java ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from('\n// x\n')]) } : f)));
        expect(touched).not.toBe(layerHash);
        expect(checkNativeMin(record, surface, touched).failures.join('\n')).toMatch(/native layer changed/);
    });

    // A floor, not a pin: `--record-latest` raises it as part of the normal
    // workflow, and a pin would turn this suite red the first time anyone
    // followed the instructions the check prints.
    it('the tree records at least 0.9.827: the last release before this whose Notes APK changed natively (KeyboardPlan)', () => {
        const { latest } = readNativeMin(FRONTEND).record;
        expect(latest).toMatch(/^\d+\.\d+\.\d+$/);
        expect(versionGt('0.9.827', String(latest)), `${String(latest)} >= 0.9.827`).toBe(false);
    });
});

/**
 * What counts as "the tree" and as "shipped" comes from git, so these run
 * against a throwaway repository: the real one's tags are not in a shallow CI
 * clone, and its untracked files are whatever a developer has lying about.
 */
describe('nativeLayerFiles and releaseTagged against a scratch git repository', () => {
    const git = (cwd: string, ...args: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout;
    };
    const scratch = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-native-min-'));
        git(dir, 'init', '-q');
        const put = (p: string, text: string) => {
            fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
            fs.writeFileSync(path.join(dir, p), text);
        };
        return { dir, put };
    };
    const MAIN = 'notes-app/android/app/src/main/java/com/sovereign/notes';

    it('an UNTRACKED source file is part of the layer (the APK build compiles it); a gitignored one is not', () => {
        const { dir, put } = scratch();
        try {
            put('notes-app/android/.gitignore', 'build/\n');
            put(`${MAIN}/KeyboardPlan.java`, 'final class KeyboardPlan {}\n');
            git(dir, 'add', '-A');
            const tracked = nativeLayerFiles(dir).map(f => f.path);
            expect(tracked, 'positive control: the tracked file is listed').toContain(`${MAIN}/KeyboardPlan.java`);
            const before = nativeLayerHash(nativeLayerFiles(dir));

            put(`${MAIN}/ReviewProbe.java`, 'final class ReviewProbe {}\n');
            put('notes-app/android/app/build/generated/R.java', 'class R {}\n');
            const paths = nativeLayerFiles(dir).map(f => f.path);
            expect(paths).toContain(`${MAIN}/ReviewProbe.java`);
            expect(paths.some(p => p.includes('/build/')), 'gitignored build output stays out').toBe(false);
            expect(nativeLayerHash(nativeLayerFiles(dir))).not.toBe(before);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('releaseTagged is true only for a release with a v<version> tag', () => {
        const { dir, put } = scratch();
        try {
            put('notes-app/package.json', '{}\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'x');
            git(dir, 'tag', 'v1.2.3');
            expect(releaseTagged(dir, '1.2.3')).toBe(true);
            expect(releaseTagged(dir, '1.2.4')).toBe(false);
            expect(releaseTagged(dir, '1.2')).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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
    // One node per app (each start strips vite.shared.ts's types: seconds).
    const cache = new Map<'puca' | 'notes', Record<string, unknown>>();
    const emitted = (app: 'puca' | 'notes'): Record<string, unknown> => {
        if (!cache.has(app)) cache.set(app, emit(app));
        return cache.get(app)!;
    };
    const emit = (app: 'puca' | 'notes') => {
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
    }, 30_000);

    it('...and its "latest" as nativeLatest, NOT the release number', () => {
        const tree = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'notes-app', 'native-min.json'), 'utf8')).latest;
        expect(tree).toMatch(/^\d+\.\d+\.\d+$/);
        const vj = emitted('notes');
        // From native-min.json, not the release. (The two are EQUAL on the
        // release that first ships a native change, so comparing them would
        // go red exactly when --record-latest is used as documented; while
        // they differ, which is most releases, this line already catches a
        // nativeLatest that is really APP_VERSION.)
        expect(vj.nativeLatest).toBe(tree);
    }, 30_000);

    it('Púca\'s build carries none (control: the field is the Notes channel\'s alone)', () => {
        expect(emitted('puca')).not.toHaveProperty('nativeMin');
        expect(emitted('puca')).not.toHaveProperty('nativeLatest');
    }, 30_000);
});
