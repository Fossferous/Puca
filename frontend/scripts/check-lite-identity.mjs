/**
 * Prove Lite and Full are MUTUALLY EXCLUSIVE variants that SHARE their data.
 *
 * The model, and every part of it is load-bearing:
 *   - SAME Tauri identifier / Android applicationId -> one data directory, so
 *     switching variants keeps you signed in, with your keys and history.
 *   - DIFFERENT Windows productName -> separate Add/Remove Programs entries,
 *     which is what lets each installer FIND the other and remove it.
 *   - Each installer removes the other -> they are never installed together.
 *     That is not tidiness: sharing a data directory means sharing the
 *     WebView2 user-data folder, and two processes against it leaves the
 *     second with NO WEBVIEW AT ALL, silently.
 *   - DIFFERENT updater endpoints -> a lite install can never be handed the
 *     full installer and upgrade itself into the remote-control build.
 *
 * Every failure here is silent in production — the installer succeeds and the
 * damage only appears on a user's machine — so this runs before every lite
 * build.
 *
 *   node scripts/check-lite-identity.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');

/** JSON with `//`-prefixed comment keys stripped (the overlay documents itself). */
function readJson(p) {
    const strip = (v) => {
        if (Array.isArray(v)) return v.map(strip);
        if (v && typeof v === 'object') {
            return Object.fromEntries(
                Object.entries(v).filter(([k]) => !k.startsWith('//')).map(([k, x]) => [k, strip(x)]),
            );
        }
        return v;
    };
    return strip(JSON.parse(readFileSync(p, 'utf8')));
}

const base = readJson(join(tauriDir, 'tauri.conf.json'));
const lite = readJson(join(tauriDir, 'tauri.lite.conf.json'));

const failures = [];
const ok = [];
const fail = (m) => failures.push(m);

// --- separate install slot --------------------------------------------------
if (!base.productName || !lite.productName) {
    fail('productName missing from one of the configs');
} else if (base.productName === lite.productName) {
    fail(`productName is IDENTICAL (${base.productName}) — the installers would claim the same `
        + 'install directory, Add/Remove entry and autostart value, and neither could find the other to remove it');
} else {
    ok.push(`productName (install slot): ${base.productName}  vs  ${lite.productName}`);
}

// --- shared data directory --------------------------------------------------
if (lite.identifier !== undefined && lite.identifier !== base.identifier) {
    fail(`lite overrides identifier (${lite.identifier}) — it MUST stay ${base.identifier}. `
        + 'A different identifier is a different data directory, so switching variants would be a fresh login');
} else {
    ok.push(`identifier (data dir): shared — ${base.identifier}`);
}

// --- each installer removes the other ---------------------------------------
const migrateFile = join(tauriDir, 'installer-migrate.nsh');
if (!existsSync(migrateFile)) {
    fail('installer-migrate.nsh is missing — both hook files include it for MigrateRenamedInstall');
} else if (!/!macro\s+MigrateRenamedInstall\b/.test(readFileSync(migrateFile, 'utf8'))) {
    fail('installer-migrate.nsh no longer defines MigrateRenamedInstall');
} else {
    ok.push('installer-migrate.nsh: defines MigrateRenamedInstall');
}

/**
 * A hook file must remove the OTHER variant, and must be readable by makensis.
 *
 * The BOM check is not pedantry. These names are non-ASCII and are NOT
 * comments — they are the Add/Remove key looked up at install time. Unicode
 * makensis reads a source file as UTF-8 only with a BOM; without one it uses
 * the system ANSI codepage, the literal is mangled, the lookup finds nothing,
 * and BOTH variants end up installed sharing one data directory. Silent.
 */
function checkHooks(label, file, mustRemove) {
    const p = join(tauriDir, file);
    if (!existsSync(p)) { fail(`${label}: ${file} does not exist`); return; }
    const bytes = readFileSync(p);
    if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
        fail(`${label}: ${file} has no UTF-8 BOM — makensis would mangle "${mustRemove}" and the removal would silently no-op`);
    } else {
        ok.push(`${label}: ${file} is UTF-8 with BOM`);
    }
    const body = bytes.toString('utf8');
    const re = new RegExp(`MigrateRenamedInstall\\s+"${mustRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
    if (!re.test(body)) {
        fail(`${label}: ${file} does not remove "${mustRemove}" — both variants could end up installed at once, `
            + 'sharing a WebView2 user-data folder');
    } else {
        ok.push(`${label}: removes "${mustRemove}"`);
    }
}

const baseHooks = base.bundle?.windows?.nsis?.installerHooks;
const liteHooks = lite.bundle?.windows?.nsis?.installerHooks;
if (!baseHooks || !liteHooks) {
    fail('both configs must set bundle.windows.nsis.installerHooks');
} else if (baseHooks === liteHooks) {
    fail(`both variants use the same hooks file (${baseHooks}) — each must remove the OTHER, which one file cannot do`);
} else {
    checkHooks('full hooks', baseHooks, lite.productName);
    checkHooks('lite hooks', liteHooks, base.productName);
}

/**
 * The !include must be resolvable BY MAKENSIS, not merely present on disk.
 *
 * Found the hard way: a bare `!include "installer-migrate.nsh"` fails the
 * whole installer build. Tauri includes the hook file by ABSOLUTE path from
 * src-tauri/, but NSIS resolves a nested include relative to the GENERATED
 * installer.nsi under target/release/nsis/x64/ — where the macro file does not
 * exist. The earlier version of this gate asserted only that the file existed
 * and defined the macro, both true, while neither installer could be built at
 * all. ${__FILEDIR__} is the including file's own directory, which is the fix.
 */
for (const [label, file] of [['full hooks', baseHooks], ['lite hooks', liteHooks]]) {
    if (!file || !existsSync(join(tauriDir, file))) continue;
    const body = readFileSync(join(tauriDir, file), 'utf8');
    const inc = body.match(/^\s*!include\s+"([^"]*installer-migrate\.nsh)"/m);
    if (!inc) {
        fail(`${label}: ${file} does not !include installer-migrate.nsh`);
    } else if (!inc[1].includes('${__FILEDIR__}')) {
        fail(`${label}: ${file} includes installer-migrate.nsh as ${JSON.stringify(inc[1])} — a path `
            + 'without ${__FILEDIR__} resolves against the GENERATED installer.nsi, not this file, '
            + 'so makensis cannot find it and the installer FAILS TO BUILD');
    } else {
        ok.push(`${label}: includes the macro via \${__FILEDIR__} (resolvable by makensis)`);
    }
}

// --- lite build hygiene -----------------------------------------------------
const liteBins = lite.bundle?.externalBin;
if (!Array.isArray(liteBins) || liteBins.length !== 0) {
    fail(`lite externalBin must be [] (got ${JSON.stringify(liteBins)}) — that is the remote-desktop agent and its elevated helper`);
} else {
    ok.push('lite externalBin: [] (no agent/service sidecars)');
}

if (lite.build?.beforeBuildCommand !== '') {
    fail('lite build.beforeBuildCommand must be "" — inheriting it re-runs the full pipeline AFTER '
        + 'the lite bundle is built, rebuilding the sidecars and overwriting dist');
} else {
    ok.push('lite beforeBuildCommand: "" (does not re-run the full build)');
}

// --- separate update channel ------------------------------------------------
const baseEps = base.plugins?.updater?.endpoints ?? [];
const liteEps = lite.plugins?.updater?.endpoints ?? [];
if (liteEps.length === 0) {
    fail('lite declares no updater endpoint — it would inherit the full one and update into the remote-control build');
} else if (baseEps.some(e => liteEps.includes(e))) {
    fail(`lite shares an updater endpoint with full (${liteEps.join(', ')})`);
} else {
    ok.push(`updater endpoint: ${baseEps.join(', ') || '(none)'}  ->  ${liteEps.join(', ')}`);
}

// --- Android: same package, DIFFERENT versionCode, different label ----------
const gradle = readFileSync(join(here, '..', 'android', 'app', 'build.gradle'), 'utf8');
if (/applicationId\s+"com\.sovereign\.app"\s*\+/.test(gradle)) {
    fail('android/app/build.gradle suffixes applicationId — that makes the APKs COEXIST. They must share it, '
        + 'so a lite install replaces the full one as an update and keeps its data');
} else if (!/applicationId\s+"com\.sovereign\.app"/.test(gradle)) {
    fail('android/app/build.gradle no longer declares applicationId "com.sovereign.app"');
} else {
    ok.push('android applicationId: shared (lite replaces full, data preserved)');
}

/**
 * THE CRITICAL ONE. @capgo/capacitor-updater wipes its stored OTA bundles only
 * when the app's versionCode CHANGES. With both variants on one code, a Lite
 * APK installed over a Full one kept Capgo's bundle store and BOOTED the full
 * remote-control JS bundle — inside an app labelled "Púca Lite", with
 * RC_ENABLED true. The OTA variant gate cannot catch it: that only inspects
 * bundles about to be downloaded, never the one already running.
 */
if (/versionCode\s+\d+\s*$/m.test(gradle)) {
    fail('android/app/build.gradle pins a LITERAL versionCode — both variants would ship the same one, '
        + "so Capgo's resetWhenUpdate never fires and a Lite APK boots the previously-applied FULL "
        + 'remote-control bundle');
} else if (!/versionCode\s+variantVersionCode/.test(gradle)
        || !/baseVersionCode\s*\*\s*10\s*\+\s*\(isLite/.test(gradle)) {
    fail('android/app/build.gradle no longer derives versionCode from the variant — see the note above; '
        + 'the variants MUST differ or the stale bundle survives the switch');
} else {
    ok.push('android versionCode: base*10 + variant (differs, so Capgo resets the bundle store)');
}

if (!/buildConfigField\s+"String",\s*"PUCA_VARIANT"/.test(gradle)) {
    fail('android/app/build.gradle no longer emits BuildConfig.PUCA_VARIANT — the native layer would have '
        + 'no way to know which variant it is, which is what left the widget advertising a Devices button');
} else {
    ok.push('android BuildConfig.PUCA_VARIANT: present (native layer knows its variant)');
}

if (!/resValue\s+"string",\s*"app_name"/.test(gradle)) {
    fail('android/app/build.gradle no longer sets app_name per variant — Capacitor appName never reaches '
        + 'the APK, so a lite install would be labelled the same as the full one');
} else {
    ok.push('android app_name: set per variant (label reaches the APK)');
}

const strings = readFileSync(join(here, '..', 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf8');
if (/<string name="app_name">/.test(strings)) {
    fail('res/values/strings.xml still defines app_name — a duplicate of the per-variant resValue, which '
        + 'fails the Android build');
} else {
    ok.push('strings.xml: app_name removed (no duplicate resource)');
}

const capCfg = readFileSync(join(here, '..', 'capacitor.config.ts'), 'utf8');
if (/appId:\s*LITE\s*\?/.test(capCfg)) {
    fail('capacitor.config.ts switches appId on PUCA_LITE — it must be shared, matching build.gradle');
} else if (!/appName:\s*LITE\s*\?/.test(capCfg)) {
    fail('capacitor.config.ts no longer varies appName — an installed lite app would not say which variant it is');
} else {
    ok.push('capacitor: appId shared, appName varies by variant');
}

// --- the lite window must not lose the full build's window options ----------
const fullWin = base.app?.windows?.[0] ?? {};
const liteWin = lite.app?.windows?.[0] ?? {};
const lostKeys = Object.keys(fullWin).filter(k => !k.startsWith('//') && !(k in liteWin));
if (lostKeys.length) {
    fail(`lite app.windows[0] is missing ${lostKeys.join(', ')} — Tauri merges configs RFC-7386, which `
        + 'REPLACES arrays wholesale, so every key the full config sets must be repeated. '
        + '(additionalBrowserArgs carries --autoplay-policy=no-user-gesture-required, without which voice '
        + 'audio does not autoplay.)');
} else {
    ok.push('lite app.windows[0]: repeats every key the full config sets');
}

// --- the leftover-remote-access notice must ship in the lite build ----------
const liteGlobals = readFileSync(join(here, '..', 'src', 'components', 'RcGlobals.lite.tsx'), 'utf8');
if (!/RcLeftoversBanner/.test(liteGlobals)) {
    fail('RcGlobals.lite.tsx no longer mounts RcLeftoversBanner — a lite install would never tell the user '
        + 'that a previous full install left a LocalSystem remote-access service running on this machine');
} else {
    ok.push('lite build mounts RcLeftoversBanner (leftover remote-access notice)');
}

for (const line of ok) console.log(`  ok       ${line}`);
for (const line of failures) console.error(`  FAIL     ${line}`);

if (failures.length) {
    console.error(`\n[check-lite-identity] ${failures.length} problem(s) — the variants would not switch cleanly.`);
    process.exit(1);
}
console.log('\n[check-lite-identity] PASS — mutually exclusive installs, shared data, separate update channels.');
