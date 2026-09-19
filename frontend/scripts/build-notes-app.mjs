#!/usr/bin/env node
/**
 * Build the Púca Notes Android app (notes-app/), end to end:
 *
 *   1. the Notes page in NATIVE mode → dist-notes-app/ (base '/', not '/notes/')
 *   2. the Android CSP meta into that index.html (scripts/cap-index-csp.mjs
 *      --index; the WebView origin gets no headers from anywhere)
 *   3. `cap sync android` inside notes-app/ (copies the bundle, writes the
 *      native config)
 *   4. gradle assembleDebug (default) or assembleRelease (--release)
 *
 * Env vars are set here rather than in package.json because a `VAR=x cmd`
 * prefix does not work when npm runs scripts through cmd.exe on Windows
 * (same reason build-lite.mjs exists). JAVA_HOME falls back to Android
 * Studio's bundled JDK when unset, which is what the main app's builds use.
 *
 *   node scripts/build-notes-app.mjs            # debug APK (sideload / test)
 *   node scripts/build-notes-app.mjs --release  # signed with Púca's keystore (~/.android/puca-keystore.properties)
 *   node scripts/build-notes-app.mjs --ota      # the OTA bundle instead of an APK (steps 1-2, then a zip)
 *
 * Output: notes-app/android/app/build/outputs/apk/<debug|release>/app-*.apk,
 * or with --ota: notes-ota/puca-notes-web-<version>.zip — the CONTENTS of
 * dist-notes-app/ (index.html at the zip root, CSP meta in it, version.json
 * saying "app": "notes"), checked before it is written, plus the two commands
 * that sign and ship it (deploy/mobile/README.md, "Púca Notes").
 *
 * Every mode first checks the Notes app's updater config
 * (scripts/notes-ota-identity.mjs): its own key, no cloud, no telemetry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNotesOta } from './notes-ota-identity.mjs';
import { checkNativeMin, readNativeMin, versionGt } from './notes-native-min.mjs';
import { zipDirectory } from './zip-dir.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');
const notesApp = join(frontend, 'notes-app');
const android = join(notesApp, 'android');
const release = process.argv.includes('--release');
const ota = process.argv.includes('--ota');
if (release && ota) {
    console.error('[notes-app] --release builds an APK and --ota builds an OTA bundle: pick one.');
    process.exit(2);
}

const env = { ...process.env, NOTES_TARGET: 'native' };
// NOTES_ALLOW_HTTP_API=1 is TEST-ONLY: it moves the WebView to an http origin
// and enables app-wide cleartext traffic so an emulator can reach a throwaway
// backend. It was read from the environment by capacitor.config.ts and by
// Gradle with nothing between it and `--release`, so a shell that still had it
// exported would have produced a signed, shippable APK with cleartext enabled.
// Refused here and again in build.gradle (a release built from Android Studio
// never passes through this script).
if (release && env.NOTES_ALLOW_HTTP_API === '1') {
    console.error('[notes-app] NOTES_ALLOW_HTTP_API=1 is TEST-ONLY (http WebView origin + cleartext traffic).');
    console.error('[notes-app] Refusing to build a RELEASE APK with it set. Unset it, or build a debug APK.');
    process.exit(2);
}
if (!env.JAVA_HOME) {
    const jbr = 'C:\\Program Files\\Android\\Android Studio\\jbr';
    if (existsSync(jbr)) env.JAVA_HOME = jbr;
}
if (!env.ANDROID_HOME && process.env.LOCALAPPDATA) {
    const sdk = join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
    if (existsSync(sdk)) env.ANDROID_HOME = sdk;
}

function run(cmd, args, cwd = frontend) {
    console.log(`[notes-app] ${cmd} ${args.join(' ')}   (in ${cwd})`);
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env, cwd });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!ota && !existsSync(android)) {
    console.error('[notes-app] notes-app/android is missing — run `npx cap add android` inside frontend/notes-app first');
    process.exit(1);
}

// The Notes app's updater config, before anything is built: an APK whose key
// equals Púca's would accept Púca's bundles, and a bundle for such an APK would
// be accepted by Púca.
{
    const lock = JSON.parse(readFileSync(join(frontend, 'package-lock.json'), 'utf8'));
    const r = checkNotesOta({
        notesCfg: readFileSync(join(notesApp, 'capacitor.config.ts'), 'utf8'),
        pucaCfg: readFileSync(join(frontend, 'capacitor.config.ts'), 'utf8'),
        notesPkg: JSON.parse(readFileSync(join(notesApp, 'package.json'), 'utf8')),
        frontendUpdaterVersion: lock?.packages?.['node_modules/@capgo/capacitor-updater']?.version ?? null,
    });
    // ...and its native floor still describes the APK (notes-native-min.mjs).
    const floor = readNativeMin(frontend);
    r.failures.push(...checkNativeMin(floor.record, floor.surface).failures);
    if (r.failures.length) {
        for (const f of r.failures) console.error(`[notes-app] ${f}`);
        process.exit(1);
    }
}

run('node', ['scripts/check-api-url.mjs']);
run('npx', ['vite', 'build', '--config', 'vite.notes.config.ts']);
run('node', ['scripts/cap-index-csp.mjs', '--index', 'dist-notes-app/index.html']);

if (ota) {
    // The bundle is dist-notes-app/ as it stands now: built, CSP injected.
    // Prove it is what encrypt-bundle.mjs --notes will demand, before zipping.
    const out = join(frontend, 'dist-notes-app');
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const metas = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
    const tauriVersion = JSON.parse(readFileSync(join(frontend, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
    let vj = null;
    try { vj = JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')); } catch { /* reported below */ }
    const problems = [];
    if (metas.length !== 1) problems.push(`dist-notes-app/index.html carries ${metas.length} CSP metas, not 1`);
    if (vj?.app !== 'notes') problems.push(`dist-notes-app/version.json says app ${JSON.stringify(vj?.app)}, not "notes"`);
    if (vj?.version !== tauriVersion) problems.push(`dist-notes-app/version.json says ${vj?.version}, tauri.conf.json says ${tauriVersion}`);
    if (existsSync(join(out, 'notes'))) problems.push('dist-notes-app/ contains a notes/ directory');
    // The native floor rides every bundle (scripts/notes-native-min.mjs): the
    // build must have written the tree's, and it cannot be newer than the
    // release itself — every Notes install would then refuse this update.
    const treeMin = readNativeMin(frontend).record.min;
    if (vj?.nativeMin !== treeMin) problems.push(`dist-notes-app/version.json says nativeMin ${JSON.stringify(vj?.nativeMin)}, notes-app/native-min.json says ${treeMin}`);
    else if (versionGt(treeMin, tauriVersion)) problems.push(`notes-app/native-min.json says ${treeMin}, newer than this release (${tauriVersion}) — every Notes app would refuse the bundle. Bump the release, or fix the floor`);
    if (problems.length) {
        for (const p of problems) console.error(`[notes-app] --ota: ${p}`);
        process.exit(1);
    }
    const dir = join(frontend, 'notes-ota');
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, `puca-notes-web-${tauriVersion}.zip`);
    writeFileSync(zip, zipDirectory(out));
    const rel = (p) => relative(join(frontend, '..'), p).split('\\').join('/');
    console.log(`[notes-app] OTA bundle (unsigned): ${zip}`);
    console.log('[notes-app] Sign it with the NOTES key (never Púca\'s), from the repo root:');
    console.log(`  node deploy/mobile/encrypt-bundle.mjs --notes ${rel(zip)} <keys dir>/notes-updater-rsa.key ${rel(zip).replace(/\.zip$/, '.enc.zip')} ${rel(join(out, 'version.json'))}`);
    console.log('[notes-app] then ship it (after the backend that serves ?variant=notes):');
    console.log(`  deploy/ops/dual-ship.sh mobile-notes ${rel(zip).replace(/\.zip$/, '.enc.zip')} ${tauriVersion} <ivSessionKey> <checksum> [--native-version <v>]`);
    console.log(`[notes-app] native.min ${treeMin} rides along from notes-app/native-min.json (the .native-min sidecar).`);
    process.exit(0);
}
run('npx', ['cap', 'sync', 'android'], notesApp);
// Absolute path: with `shell: true` cmd.exe does not reliably find a bare
// `gradlew.bat` in the spawn's cwd (it did not, on the first run).
const gradlew = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}"`, [release ? 'assembleRelease' : 'assembleDebug'], android);
console.log(`[notes-app] APK: ${join(android, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug')}`);
