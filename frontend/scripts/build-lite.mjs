/**
 * Build the "lite" frontend bundle, and optionally sync it into a native shell.
 *
 * VITE_ENABLE_RC=false is what removes remote control: Chat.tsx never renders
 * DevicesView (its chunk is never emitted), main.tsx never wires the host-side
 * listeners, and vite.config.ts's rc-exclusion-guard FAILS the build if any
 * remote-control module is still reachable.
 *
 * PUCA_LITE=1 is separate and just as load-bearing: it switches the native
 * app IDENTITY (capacitor.config.ts's appId/appName and android/app/
 * build.gradle's applicationId) so a lite APK is a different app to Android
 * and can be installed alongside the full one. Both are exported here rather
 * than in package.json, because a `VAR=x cmd` prefix in an npm script does not
 * work when npm runs it through cmd.exe on Windows.
 *
 *   node scripts/build-lite.mjs               # bundle only
 *   node scripts/build-lite.mjs --sync android # bundle, then `cap sync android`
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env, VITE_ENABLE_RC: 'false', PUCA_LITE: '1' };

function run(cmd, args) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, env });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

run('npx', ['tsc', '-b']);
run('npx', ['vite', 'build']);

// `cap sync` must run under the SAME env: it writes appId from
// capacitor.config.ts into the native project, and Gradle reads PUCA_LITE
// itself at build time. Running the sync without it would leave a project
// whose Capacitor appId and Gradle applicationId disagree.
const syncIdx = process.argv.indexOf('--sync');
if (syncIdx !== -1) {
    const platform = process.argv[syncIdx + 1];
    if (!platform) {
        console.error('[build-lite] --sync needs a platform (android | ios)');
        process.exit(1);
    }
    console.log(`[build-lite] syncing the LITE bundle into ${platform} as com.sovereign.app.lite`);
    run('npx', ['cap', 'sync', platform]);
}
