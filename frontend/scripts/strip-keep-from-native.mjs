#!/usr/bin/env node
/**
 * Remove Púca Keep (dist/keep/) from a native shell's synced web assets.
 *
 * `cap sync` copies the WHOLE of dist/ into the shell (capacitor.config.ts
 * `webDir: 'dist'`), so the Keep page built by vite.keep.config.ts would ride
 * into the APK and every OTA bundle as a second HTML document with no
 * Content-Security-Policy: scripts/cap-index-csp.mjs patches exactly one
 * index.html, and the WebView's https://localhost origin gets no headers from
 * anywhere. Keep is a browser surface — the shells run at their own origins,
 * where its session and E2EE seed are not shared — so on a phone it has no
 * reachable entry point and nothing to do. Deleting it is simpler and safer
 * than policing it.
 *
 * Runs after `cap sync` in the cap:build:* scripts and in build-lite.mjs's
 * --sync branch, BEFORE cap-index-csp.mjs. The OTA staging recipe in
 * deploy/mobile/README.md removes ota-src/keep by hand for the same reason.
 *
 *   node scripts/strip-keep-from-native.mjs --platform android|ios
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');

const PUBLIC_DIRS = {
    android: join(frontend, 'android', 'app', 'src', 'main', 'assets', 'public'),
    ios: join(frontend, 'ios', 'App', 'App', 'public'),
};

const idx = process.argv.indexOf('--platform');
const platform = idx === -1 ? '' : (process.argv[idx + 1] ?? '');
const publicDir = PUBLIC_DIRS[platform];
if (!publicDir) {
    console.error('usage: strip-keep-from-native.mjs --platform android|ios');
    process.exit(2);
}

const keepDir = join(publicDir, 'keep');
if (!existsSync(keepDir)) {
    console.log(`[strip-keep] ${platform}: no keep/ in the synced assets — nothing to remove`);
} else {
    rmSync(keepDir, { recursive: true, force: true });
    console.log(`[strip-keep] ${platform}: removed ${keepDir}`);
}
// Positive check, not just "rm did not throw": the whole point is that no
// unpolicied document is left in the shell.
if (existsSync(join(keepDir, 'index.html'))) {
    console.error(`[strip-keep] ${platform}: keep/index.html is STILL present after removal`);
    process.exit(1);
}
