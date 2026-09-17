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
 *
 * Output: notes-app/android/app/build/outputs/apk/<debug|release>/app-*.apk
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');
const notesApp = join(frontend, 'notes-app');
const android = join(notesApp, 'android');
const release = process.argv.includes('--release');

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

if (!existsSync(android)) {
    console.error('[notes-app] notes-app/android is missing — run `npx cap add android` inside frontend/notes-app first');
    process.exit(1);
}

run('node', ['scripts/check-api-url.mjs']);
run('npx', ['vite', 'build', '--config', 'vite.notes.config.ts']);
run('node', ['scripts/cap-index-csp.mjs', '--index', 'dist-notes-app/index.html']);
run('npx', ['cap', 'sync', 'android'], notesApp);
// Absolute path: with `shell: true` cmd.exe does not reliably find a bare
// `gradlew.bat` in the spawn's cwd (it did not, on the first run).
const gradlew = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}"`, [release ? 'assembleRelease' : 'assembleDebug'], android);
console.log(`[notes-app] APK: ${join(android, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug')}`);
