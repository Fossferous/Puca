#!/usr/bin/env node
/**
 * Build the Púca Keep Android app (keep-app/), end to end:
 *
 *   1. the Keep page in NATIVE mode → dist-keep-app/ (base '/', not '/keep/')
 *   2. the Android CSP meta into that index.html (scripts/cap-index-csp.mjs
 *      --index; the WebView origin gets no headers from anywhere)
 *   3. `cap sync android` inside keep-app/ (copies the bundle, writes the
 *      native config)
 *   4. gradle assembleDebug (default) or assembleRelease (--release)
 *
 * Env vars are set here rather than in package.json because a `VAR=x cmd`
 * prefix does not work when npm runs scripts through cmd.exe on Windows
 * (same reason build-lite.mjs exists). JAVA_HOME falls back to Android
 * Studio's bundled JDK when unset, which is what the main app's builds use.
 *
 *   node scripts/build-keep-app.mjs            # debug APK (sideload / test)
 *   node scripts/build-keep-app.mjs --release  # needs a keystore in keep-app/android
 *
 * Output: keep-app/android/app/build/outputs/apk/<debug|release>/app-*.apk
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');
const keepApp = join(frontend, 'keep-app');
const android = join(keepApp, 'android');
const release = process.argv.includes('--release');

const env = { ...process.env, KEEP_TARGET: 'native' };
if (!env.JAVA_HOME) {
    const jbr = 'C:\\Program Files\\Android\\Android Studio\\jbr';
    if (existsSync(jbr)) env.JAVA_HOME = jbr;
}
if (!env.ANDROID_HOME && process.env.LOCALAPPDATA) {
    const sdk = join(process.env.LOCALAPPDATA, 'Android', 'Sdk');
    if (existsSync(sdk)) env.ANDROID_HOME = sdk;
}

function run(cmd, args, cwd = frontend) {
    console.log(`[keep-app] ${cmd} ${args.join(' ')}   (in ${cwd})`);
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env, cwd });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(android)) {
    console.error('[keep-app] keep-app/android is missing — run `npx cap add android` inside frontend/keep-app first');
    process.exit(1);
}

run('node', ['scripts/check-api-url.mjs']);
run('npx', ['vite', 'build', '--config', 'vite.keep.config.ts']);
run('node', ['scripts/cap-index-csp.mjs', '--index', 'dist-keep-app/index.html']);
run('npx', ['cap', 'sync', 'android'], keepApp);
// Absolute path: with `shell: true` cmd.exe does not reliably find a bare
// `gradlew.bat` in the spawn's cwd (it did not, on the first run).
const gradlew = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}"`, [release ? 'assembleRelease' : 'assembleDebug'], android);
console.log(`[keep-app] APK: ${join(android, 'app', 'build', 'outputs', 'apk', release ? 'release' : 'debug')}`);
