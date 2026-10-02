/**
 * Púca Notes' native floor: the oldest Notes APK an OTA bundle can run on.
 *
 * A web bundle that calls a native plugin, Capacitor package or Android
 * permission an older APK lacks must not be applied there — the app would
 * call something that is not in it, and main.tsx blesses the bundle at once,
 * so it would never roll back. The OTA manifest's `native.min` says which
 * APKs may apply a bundle (src/notes/model/notesUpdate.ts).
 *
 * WHY THE TREE HOLDS IT, NOT A SHIP FLAG. The floor used to be a
 * `--native-min` flag on `dual-ship.sh mobile-notes`. It applied only to the
 * release that passed it: the NEXT release, shipped with the documented
 * recipe and no flag, published no native block, and every old APK applied
 * web code that called a plugin it lacked. A floor is a property of the code,
 * so it lives beside the code — notes-app/native-min.json — and every
 * release carries it:
 *
 *   native-min.json → version.json "nativeMin" (vite.shared.ts emitVersionJson)
 *     → <bundle>.native-min (deploy/mobile/encrypt-bundle.mjs --notes)
 *     → the manifest's native.min (deploy/ops/dual-ship.sh mobile-notes, which
 *       also refuses to publish a floor LOWER than a host already serves)
 *
 * WHAT MAKES SOMEONE BUMP IT. native-min.json also records the APK's native
 * SURFACE — the Capacitor packages notes-app/package.json lists, the
 * @CapacitorPlugin classes under notes-app/android/app/src/main/java, and the
 * <uses-permission> entries in its AndroidManifest.xml. checkNativeMin fails
 * (src/tests/notesNativeMin.test.ts against the real tree in every vitest
 * run, build-notes-app.mjs in every Notes build, and check-lite-identity.mjs
 * in the lite builds) whenever the
 * surface changes and the record does not, so the change that adds a plugin
 * cannot land without someone deciding what `min` must now be.
 *
 * `latest`: THE NEWEST NOTES APK WHOSE NATIVE LAYER CHANGED. The manifest's
 * native.version is a nudge: an installed APK older than it shows "A new
 * Púca Notes app (X) is available". It used to be the release number
 * (`--native-version "$VER"` on every ship), and every release rebuilds the
 * APK, so every installed app was "out of date" the day after it updated
 * — although 12 of the 13 APKs from 0.9.818 to 0.9.830 differed from the one
 * before only in versionName and the built-in web bundle the OTA already
 * delivers. Only 0.9.827 (KeyboardPlan) changed the native layer.
 *
 * So `latest` rides the same road as `min` (version.json "nativeLatest" →
 * <bundle>.native-latest → the manifest's native.version), and it is SEALED
 * to a fingerprint of the native layer: `latestFingerprint` is a hash of
 * `latest` together with every file the APK's native half is built from
 * (nativeLayerHash below). Change any of them, or edit `latest` by hand, and
 * checkNativeMin fails until someone runs
 *
 *   node scripts/notes-native-min.mjs --record-latest <the release that first ships this APK>
 *
 * which refuses a version whose APK already exists: one below `latest` or
 * below the tree's version, or equal to either once its v<version> tag says
 * it shipped (recordLatest). Re-recording the same UNSHIPPED version is how a
 * second native change in one release cycle is sealed. The layer is hashed
 * BROADLY — everything under notes-app/android that git does not ignore
 * (tracked or not yet), except the JVM and instrumented tests, plus
 * notes-app's package files and capacitor.config.ts
 * — so the failure mode is a nudge nobody needed, never a native change
 * shipped silently. (`min` still guards correctness either way: `latest` is
 * only ever a nudge.) Line endings are stripped before hashing (the tree is
 * checked out CRLF on Windows and LF on Linux CI), and so are the release
 * number's own appearances (versionName/versionCode, the package's version).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Relative to frontend/. Forward slashes: it is printed, and it joins fine on Windows too. */
export const NATIVE_MIN_FILE = 'notes-app/native-min.json';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** a > b, both MAJOR.MINOR.PATCH. */
export function versionGt(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
    return false;
}

export function isVersion(v) {
    return typeof v === 'string' && VERSION_RE.test(v);
}

/**
 * The APK's native surface, from file TEXT (so tests can feed it anything).
 * @param {object} a
 * @param {object} a.notesPkg      notes-app/package.json, parsed
 * @param {{name: string, text: string}[]} a.javaSources  every .java file under app/src/main/java
 * @param {string} a.manifestXml   notes-app/android/app/src/main/AndroidManifest.xml
 */
export function nativeSurface({ notesPkg, javaSources, manifestXml }) {
    const packages = Object.keys(notesPkg?.dependencies ?? {}).sort();
    const plugins = javaSources
        // Comments stripped first: a gate a comment can satisfy is not one.
        .filter(f => /@CapacitorPlugin\b/.test(f.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
        .map(f => f.name.replace(/\.java$/, ''))
        .sort();
    const permissions = [...String(manifestXml ?? '').replace(/<!--[\s\S]*?-->/g, '')
        .matchAll(/<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/g)]
        .map(m => m[1])
        .filter((p, i, all) => all.indexOf(p) === i)
        .sort();
    return { packages, plugins, permissions };
}

function javaFiles(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...javaFiles(p));
        else if (name.endsWith('.java')) out.push({ name, text: readFileSync(p, 'utf8') });
    }
    return out;
}

/**
 * Is this path (relative to frontend/, forward slashes) part of the APK's
 * native layer? Everything under notes-app/android except the tests
 * (not in the APK), plus the files Gradle and `cap sync` read from notes-app.
 */
export function isNativeLayerPath(path) {
    const p = String(path).replace(/\\/g, '/');
    if (p.startsWith('notes-app/android/')) return !/\/src\/(test|androidTest)\//.test(p);
    return p === 'notes-app/package.json' || p === 'notes-app/package-lock.json' || p === 'notes-app/capacitor.config.ts';
}

/** One file's bytes as hashed: no CRs, and no release number. */
function normalisedLayerBytes(path, bytes) {
    const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
    // Line endings: autocrlf checks text out CRLF on Windows and LF on Linux.
    // A binary (a PNG, the wrapper jar) is never converted, so dropping its
    // 0x0D bytes is the same on both and changes nothing that matters here.
    const noCr = Buffer.from(raw.filter(b => b !== 0x0d));
    const name = path.split('/').pop();
    if (name === 'package.json' || name === 'package-lock.json') {
        // The package's OWN version (and the lockfile's copy of it) is not
        // native; every dependency's version is.
        try {
            const json = JSON.parse(noCr.toString('utf8'));
            delete json.version;
            if (json?.packages?.['']) delete json.packages[''].version;
            return Buffer.from(JSON.stringify(json), 'utf8');
        } catch { return noCr; }
    }
    if (name.endsWith('.gradle')) {
        return Buffer.from(noCr.toString('utf8').replace(/^[ \t]*(versionName|versionCode)\b.*$/gm, ''), 'utf8');
    }
    return noCr;
}

/**
 * A fingerprint of the native layer: sha256 over every file's path and its
 * normalised bytes, in path order.
 * @param {{path: string, bytes: string | Uint8Array}[]} files
 */
export function nativeLayerHash(files) {
    const h = createHash('sha256');
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const body = normalisedLayerBytes(f.path, f.bytes);
        h.update(`${f.path}\0${body.length}\0`);
        h.update(body);
    }
    return h.digest('hex');
}

/** What native-min.json records for `latest`: the version sealed to the layer. */
export function latestFingerprint(latest, layerHash) {
    return createHash('sha256').update(`puca-notes-native-latest\n${latest}\n${layerHash}`).digest('hex');
}

/**
 * The native layer's files as they are on disk now. The LIST comes from git:
 * tracked files AND untracked ones that are not ignored, because the APK
 * build compiles a new .java file whether or not it has been committed yet;
 * what .gitignore excludes (a cap sync's generated files, build output) never
 * counts. The CONTENT is the working tree's, so an edit counts before it is
 * staged. A deleted-but-still-tracked file is skipped: it is not in the APK.
 */
export function nativeLayerFiles(frontendDir) {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'notes-app'], { cwd: frontendDir, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`git ls-files failed in ${frontendDir} (${(r.stderr || r.error?.message || '').trim()}): the Púca Notes native layer cannot be listed, so nothing proves native-min.json "latest" is current`);
    }
    return [...new Set(r.stdout.split('\0'))]
        .filter(p => p && isNativeLayerPath(p))
        .filter(p => existsSync(join(frontendDir, p)))
        .map(p => ({ path: p, bytes: readFileSync(join(frontendDir, p)) }));
}

/** The real tree's record, surface and native layer. */
export function readNativeMin(frontendDir) {
    const record = JSON.parse(readFileSync(join(frontendDir, NATIVE_MIN_FILE), 'utf8'));
    const app = join(frontendDir, 'notes-app', 'android', 'app', 'src', 'main');
    const manifestPath = join(app, 'AndroidManifest.xml');
    const surface = nativeSurface({
        notesPkg: JSON.parse(readFileSync(join(frontendDir, 'notes-app', 'package.json'), 'utf8')),
        javaSources: javaFiles(join(app, 'java')),
        manifestXml: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '',
    });
    const layerFiles = nativeLayerFiles(frontendDir);
    return { record, surface, layerFiles, layerHash: nativeLayerHash(layerFiles) };
}

/** Has release `version` shipped? It has when the repository holds its v<version> tag. */
export function releaseTagged(frontendDir, version) {
    if (!isVersion(version)) return false;
    const r = spawnSync('git', ['tag', '--list', `v${version}`], { cwd: frontendDir, encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`git tag failed in ${frontendDir} (${(r.stderr || r.error?.message || '').trim()}): cannot tell whether ${version} has shipped`);
    }
    return r.stdout.trim() === `v${version}`;
}

/**
 * Raise `latest` and seal it to the current layer. Returns the new record,
 * or an error saying why not. The version named must be one whose APK does
 * not exist yet, because the nudge's target must HAVE the change and every
 * APK below it must lack it:
 *
 *  - never below the current `latest`, and never below this tree's version
 *    (that APK has shipped without the change);
 *  - EQUAL to either only while that release is unshipped (`isShipped` says
 *    no). Re-sealing an unshipped `latest` is how a second native change in
 *    the same release cycle (or a merge of two branches that both recorded
 *    it) is sealed; any higher value would be refused by every ship gate as
 *    "newer than this release". Re-sealing a SHIPPED one is the silent native
 *    change this exists to stop: its installs would never be told.
 *
 * `isShipped(version)` is releaseTagged in the CLI. Without one, equality is
 * refused: not knowing is treated as shipped.
 */
export function recordLatest(record, version, layerHash, appVersion, isShipped) {
    if (!isVersion(version)) return { error: `${JSON.stringify(version)} is not a MAJOR.MINOR.PATCH version` };
    const shipped = v => (typeof isShipped === 'function' ? Boolean(isShipped(v)) : true);
    if (isVersion(record?.latest) && versionGt(record.latest, version)) {
        return { error: `${version} is older than the current "latest" (${record.latest}): "latest" never goes down` };
    }
    if (isVersion(record?.latest) && version === record.latest && shipped(version)) {
        return { error: `${version} is the current "latest" and has already shipped (tag v${version}): an APK whose native layer changed is a NEW APK, and installs of ${version} are only told about it if the number rises. Name the release that will first ship it` };
    }
    if (isVersion(appVersion) && versionGt(appVersion, version)) {
        return { error: `${version} is older than this tree's version (${appVersion}): that APK already shipped without this change. Name the release that will first ship it` };
    }
    if (version === appVersion && shipped(version)) {
        return { error: `${version} is this tree's version and has already shipped (tag v${version}) without this change: name the release that will first ship it` };
    }
    return { record: { ...record, latest: version, latestFingerprint: latestFingerprint(version, layerHash) } };
}

/**
 * @param {object} record   notes-app/native-min.json, parsed
 * @param {{packages: string[], plugins: string[], permissions: string[]}} surface
 * @param {string} layerHash  nativeLayerHash of the tree's native layer
 */
export function checkNativeMin(record, surface, layerHash) {
    const ok = [];
    const failures = [];
    if (!isVersion(record?.min)) {
        failures.push(`${NATIVE_MIN_FILE} "min" is ${JSON.stringify(record?.min)}, not a MAJOR.MINOR.PATCH version — every Notes OTA would ship with no native floor`);
        return { ok, failures };
    }
    const drift = [];
    for (const key of ['packages', 'plugins', 'permissions']) {
        const recorded = Array.isArray(record?.surface?.[key]) ? [...record.surface[key]].sort() : [];
        const actual = surface[key];
        const added = actual.filter(x => !recorded.includes(x));
        const removed = recorded.filter(x => !actual.includes(x));
        if (added.length) drift.push(`${key} added: ${added.join(', ')}`);
        if (removed.length) drift.push(`${key} removed: ${removed.join(', ')}`);
    }
    if (drift.length) {
        failures.push(
            `the Púca Notes APK's native surface changed (${drift.join('; ')}) but ${NATIVE_MIN_FILE} still records the old one. `
            + 'If a bundle will call what was added, raise "min" to the release that first ships it (older APKs then offer '
            + '"install the new app" instead of applying code they cannot run); then re-record "surface" to match.',
        );
    } else {
        ok.push(`Notes native floor: min ${record.min}, surface recorded (${surface.packages.length} packages, ${surface.plugins.length} plugins, ${surface.permissions.length} permissions)`);
    }
    const before = failures.length;
    if (typeof layerHash !== 'string' || !layerHash) {
        failures.push(`no native-layer fingerprint was given, so nothing proves ${NATIVE_MIN_FILE} "latest" is current (a caller of checkNativeMin must pass readNativeMin's layerHash)`);
    } else if (!isVersion(record?.latest)) {
        failures.push(`${NATIVE_MIN_FILE} "latest" is ${JSON.stringify(record?.latest)}, not a MAJOR.MINOR.PATCH version — the Notes OTA manifest would carry no native.version`);
    } else if (versionGt(record.min, record.latest)) {
        failures.push(`${NATIVE_MIN_FILE} "latest" ${record.latest} is older than "min" ${record.min}: the floor is itself a native change, so the newest native change cannot predate it`);
    } else if (record.latestFingerprint !== latestFingerprint(record.latest, layerHash)) {
        failures.push(
            `the Púca Notes APK's native layer changed (or "latest" was edited by hand) since ${NATIVE_MIN_FILE} "latest" (${record.latest}) was recorded. `
            + 'Installed Notes apps are only told about a new APK when "latest" rises. Run: '
            + 'node scripts/notes-native-min.mjs --record-latest <the release that will first ship this APK> '
            + '(from frontend/; until that release ships, re-recording the same version is fine). Changed only a comment or a build setting? Record it anyway: '
            + 'an unneeded "new app" nudge is the cheap failure, a silent native change the expensive one.',
        );
    }
    if (failures.length === before) ok.push(`Notes native latest: ${record.latest}, sealed to the current native layer`);
    return { ok, failures };
}

// --- CLI: node scripts/notes-native-min.mjs [--check | --record-latest <version>]
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
    const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const args = process.argv.slice(2);
    const { record, surface, layerHash } = readNativeMin(frontendDir);
    if (args[0] === '--record-latest') {
        const appVersion = JSON.parse(readFileSync(join(frontendDir, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
        const r = recordLatest(record, args[1], layerHash, appVersion, v => releaseTagged(frontendDir, v));
        if (r.error) { console.error(`REFUSING: ${r.error}`); process.exit(1); }
        writeFileSync(join(frontendDir, NATIVE_MIN_FILE), JSON.stringify(r.record, null, 2) + '\n');
        console.log(`${NATIVE_MIN_FILE}: latest ${record.latest} -> ${r.record.latest}, sealed to the current native layer. Say in "why" what changed.`);
    } else if (args.length === 0 || args[0] === '--check') {
        const r = checkNativeMin(record, surface, layerHash);
        r.ok.forEach(l => console.log(`ok  ${l}`));
        r.failures.forEach(l => console.error(`FAIL  ${l}`));
        process.exit(r.failures.length ? 1 : 0);
    } else {
        console.error('usage: node scripts/notes-native-min.mjs [--check | --record-latest <version>]');
        process.exit(2);
    }
}
