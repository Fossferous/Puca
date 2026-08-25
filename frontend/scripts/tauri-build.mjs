/**
 * `tauri build`, with the deployment-specific bits merged in from an
 * untracked overlay.
 *
 * WHY THIS EXISTS. The desktop updater endpoint is baked into the binary at
 * build time from `src-tauri/tauri.conf.json`. That file is tracked, and this
 * repository is public, so it cannot carry a real domain — but a build made
 * against the placeholder produces an app that checks a domain which does not
 * exist, and then never offers an update again. Nothing errors. Nobody finds
 * out until someone asks why they are still on an old version.
 *
 * So: keep the real endpoint in `src-tauri/tauri.release.json` (gitignored),
 * and this script merges it via `tauri build --config`, which deep-merges over
 * the tracked config. It also PRINTS the endpoint that is actually being baked
 * in, every time, because the failure mode above is silent and the only cheap
 * defence against a silent failure is to make the value visible at the moment
 * it is chosen.
 *
 * Building without the overlay is allowed and normal — a fresh clone has no
 * update server to point at. It just says so, loudly, rather than pretending.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');
const overlay = join(tauriDir, 'tauri.release.json');
const baseConf = join(tauriDir, 'tauri.conf.json');

/** Read the updater endpoints out of a config file, if it declares any. */
function endpointsOf(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'))?.plugins?.updater?.endpoints ?? null;
    } catch {
        return null;
    }
}

/** Read productName out of a config file, if it sets one. */
function productNameOf(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'))?.productName ?? null;
    } catch {
        return null;
    }
}

/**
 * Say out loud what this build will call itself, and what that decides.
 *
 * On Windows, `productName` is not a label — NSIS derives THREE pieces of
 * install identity from it: the install directory, the Add/Remove-Programs
 * registry key, and the autostart value under HKCU\...\Run. The installer finds
 * an existing installation by looking up that uninstall key, so a build whose
 * productName differs from the one already on a user's machine does not find it
 * and installs ALONGSIDE it: two directories, two Add/Remove entries, two
 * autostart entries, two copies of the app launching at login — both reading
 * the same data directory, because THAT is keyed on `identifier`, which is
 * frozen.
 *
 * None of that errors. The updater reports success and the user quietly ends up
 * with two apps. So the value gets printed at the moment it is chosen, for the
 * same reason the endpoint does.
 *
 * As of 2026-08-25 this is no longer purely a warning: src-tauri/installer-hooks.nsh
 * migrates a real prior install of an OLD productName in place, tested against
 * two genuine historical installs with app data confirmed byte-identical before
 * and after. That hook currently only knows the name "Sovereign" -- if you add
 * another old name to its MigrateRenamedInstall call, update this message too.
 */
function reportProductName(name, source) {
    console.log(`[tauri-build] productName -> ${name}  (${source})`);
    console.log(`[tauri-build]   Windows install dir   : %LOCALAPPDATA%\\${name}`);
    console.log(`[tauri-build]   Add/Remove key        : HKCU\\...\\Uninstall\\${name}`);
    console.log(`[tauri-build]   autostart Run value   : ${name}`);
    console.log('[tauri-build]   installer-hooks.nsh migrates a prior "Sovereign" install in');
    console.log('[tauri-build]   place. A user under any OTHER old name still gets a second,');
    console.log('[tauri-build]   parallel install -- add their name to that hook, or pin');
    console.log('[tauri-build]   productName in tauri.release.json as a manual fallback.');
}

/**
 * Drop every key that starts with `//`, recursively.
 *
 * The overlay is where the operator documents WHY a value is pinned, and
 * `"//"`-style comment keys are the only comments JSON allows — but tauri's
 * config schema rejects unknown properties, so the raw overlay fails the
 * build with "Additional properties are not allowed" (found the first time a
 * real release was built from the fork). The comments stay in the overlay;
 * tauri gets a sanitised copy.
 */
function stripCommentKeys(value) {
    if (Array.isArray(value)) return value.map(stripCommentKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([k]) => !k.startsWith('//'))
                .map(([k, v]) => [k, stripCommentKeys(v)]),
        );
    }
    return value;
}

const args = process.argv.slice(2);
const hasOverlay = existsSync(overlay);
let mergedDir = null;

if (hasOverlay) {
    const eps = endpointsOf(overlay);
    console.log('[tauri-build] merging src-tauri/tauri.release.json (untracked)');
    console.log(`[tauri-build] updater endpoint -> ${eps ? eps.join(', ') : '(overlay declares none)'}`);
    const pinned = productNameOf(overlay);
    reportProductName(
        pinned ?? productNameOf(baseConf) ?? '(unset)',
        pinned ? 'pinned by the overlay' : 'from the tracked config — overlay does not pin it',
    );
    mergedDir = mkdtempSync(join(tmpdir(), 'tauri-overlay-'));
    const sanitised = join(mergedDir, 'tauri.release.json');
    writeFileSync(sanitised, JSON.stringify(stripCommentKeys(JSON.parse(readFileSync(overlay, 'utf8'))), null, 2));
    args.unshift('--config', sanitised);
} else {
    const eps = endpointsOf(baseConf);
    console.log('[tauri-build] no src-tauri/tauri.release.json — building with the tracked defaults.');
    console.log(`[tauri-build] updater endpoint -> ${eps ? eps.join(', ') : '(none)'}`);
    console.log('[tauri-build] If this is a release for real users, that endpoint must be YOUR');
    console.log('[tauri-build] download host. Copy tauri.release.example.json and set it, or the');
    console.log('[tauri-build] installed app will silently never find an update.');
    reportProductName(productNameOf(baseConf) ?? '(unset)', 'from the tracked config');
}

// npx, not a bare `tauri`: the binary lives in node_modules/.bin, which is on
// PATH when npm runs this script but NOT when someone runs it directly. Using
// npx makes both work instead of failing confusingly in the second case.
const r = spawnSync('npx', ['tauri', 'build', ...args], { stdio: 'inherit', shell: true });
if (mergedDir) {
    try { rmSync(mergedDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(r.status ?? 1);
