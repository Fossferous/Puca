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
 * (check-lite-identity.mjs in `npm run build`, build-notes-app.mjs, and
 * src/tests/notesNativeMin.test.ts against the real tree) whenever the
 * surface changes and the record does not, so the change that adds a plugin
 * cannot land without someone deciding what `min` must now be.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const NATIVE_MIN_FILE = join('notes-app', 'native-min.json');
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

/** The real tree's record and surface. */
export function readNativeMin(frontendDir) {
    const record = JSON.parse(readFileSync(join(frontendDir, NATIVE_MIN_FILE), 'utf8'));
    const app = join(frontendDir, 'notes-app', 'android', 'app', 'src', 'main');
    const manifestPath = join(app, 'AndroidManifest.xml');
    const surface = nativeSurface({
        notesPkg: JSON.parse(readFileSync(join(frontendDir, 'notes-app', 'package.json'), 'utf8')),
        javaSources: javaFiles(join(app, 'java')),
        manifestXml: existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '',
    });
    return { record, surface };
}

/**
 * @param {object} record   notes-app/native-min.json, parsed
 * @param {{packages: string[], plugins: string[], permissions: string[]}} surface
 */
export function checkNativeMin(record, surface) {
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
    return { ok, failures };
}
