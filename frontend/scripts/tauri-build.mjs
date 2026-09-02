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
// Static CRT for app.exe. Same reason, same environment-override trap, as
// the identical helper in build-agent.mjs; see the comment there.
const CRT_STATIC = '-C target-feature=+crt-static';
const withCrtStatic = (flags) =>
    (flags && flags.includes('crt-static')) ? flags : [flags, CRT_STATIC].filter(Boolean).join(' ');
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');
// tauri.windows.conf.json (beside the base config) is a PLATFORM overlay that
// Tauri loads and merges BY ITSELF, unsanitised: it names puca-service as a
// sidecar only on Windows, because build-agent.mjs only builds and stages the
// Windows service on win32 and a Linux/macOS bundle must not demand a binary
// that never exists there. Two consequences: it must not carry "//" comment
// keys (the schema rejects unknown fields and the whole Windows build fails),
// and JSON merge REPLACES arrays, so it lists every Windows sidecar, agent
// included. The lite config passed via --config overrides it with [].
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

// Extra args are FORWARDED to `tauri build` (e.g. --no-default-features and
// --config src-tauri/tauri.lite.conf.json for the lite variant). They must go
// through this script rather than around it: bypassing it drops the untracked
// release overlay, which is what carries the real updater endpoint and pins
// productName — see the header. A lite build that skipped it would silently
// never find an update, and could install ALONGSIDE an existing install
// instead of upgrading it.
const args = process.argv.slice(2);
const hasOverlay = existsSync(overlay);
let mergedDir = null;
/** Derived lite endpoint, appended as the FINAL --config so it wins. */
let liteEndpointOverride = null;

/**
 * Is this a LITE build? Detected from the forwarded args rather than a separate
 * flag, so the two can never disagree about which variant is being produced.
 */
const isLite = args.some(a => a.includes('tauri.lite.conf.json'))
    || args.includes('--no-default-features');

/**
 * `--no-default-features` belongs to CARGO, not to `tauri build`.
 *
 * The CLI declares `[ARGS]... Command line arguments passed to the runner. Use
 * `--` to explicitly mark the start of the arguments`, and rejects the flag
 * outright when it appears before that separator:
 *   error: unexpected argument '--no-default-features' found
 * So it is lifted out here and re-appended after `--` at the very end, once
 * every `--config` has been placed — those must stay on the TAURI side of the
 * separator or they would be handed to cargo and silently ignored.
 */
const cargoPassthrough = [];
for (let i = args.length - 1; i >= 0; i--) {
    if (args[i] === '--no-default-features' || args[i] === '--' ) {
        if (args[i] === '--no-default-features') cargoPassthrough.unshift(args[i]);
        args.splice(i, 1);
    }
}

/**
 * Point a lite build at its OWN update manifest, on the SAME host the operator
 * configured for the full one.
 *
 * The alternative was hardcoding a lite endpoint in the tracked
 * tauri.lite.conf.json, which would have overridden the untracked overlay and
 * sent every real lite deployment at the placeholder domain — the precise
 * silent "never finds an update" failure this whole script exists to prevent.
 * Deriving keeps ONE source for the host and still separates the channels, so
 * a lite install can never be handed the full installer and upgrade itself
 * into the remote-control build.
 */
function liteEndpoints(eps) {
    if (!eps) return null;
    return eps.map((u) => {
        // Insert `-lite` before a trailing `.json` (query string preserved).
        // Tauri manifest endpoints are conventionally `<name>.json`, possibly
        // with `{{target}}`/`{{current_version}}` placeholders after it.
        const derived = u.replace(/([^/]+)\.json(\?.*)?$/, (m, name, q) => `${name}-lite.json${q ?? ''}`);
        // FAIL LOUDLY if the pattern did not match. A silent no-op would leave
        // the lite build pointed at the FULL manifest, so a lite install would
        // download the full installer and upgrade itself into the
        // remote-control build — exactly the leak the whole channel split
        // exists to prevent, and invisible because the build still succeeds.
        // Better to stop the release and make the operator choose the lite URL.
        if (derived === u) {
            throw new Error(
                `[tauri-build] cannot derive a lite updater endpoint from ${JSON.stringify(u)}: `
                + 'it does not end in "<name>.json". Point the lite build at its own manifest '
                + 'explicitly (set plugins.updater.endpoints in tauri.lite.conf.json for THIS build), '
                + 'or a lite install would be served the full installer.',
            );
        }
        return derived;
    });
}

if (hasOverlay) {
    const raw = stripCommentKeys(JSON.parse(readFileSync(overlay, 'utf8')));
    const eps = endpointsOf(overlay);
    console.log('[tauri-build] merging src-tauri/tauri.release.json (untracked)');
    if (isLite && eps) {
        // Deliberately NOT written into the overlay copy. The CLI merges
        // --config left to right and the LAST one wins; this script unshifts
        // the overlay to the FRONT, and package.json passes
        // tauri.lite.conf.json at the END — so an endpoint placed in the
        // overlay is overwritten by that file's placeholder, while this script
        // cheerfully prints the derived URL it did not actually bake in.
        // Emitted as its own trailing --config below instead.
        liteEndpointOverride = liteEndpoints(eps);
        console.log(`[tauri-build] LITE updater endpoint -> ${liteEndpointOverride.join(', ')}`);
        console.log('[tauri-build]   derived from the overlay\'s endpoint; publish a SEPARATE');
        console.log('[tauri-build]   manifest there, or lite installs will never update.');
    } else {
        console.log(`[tauri-build] updater endpoint -> ${eps ? eps.join(', ') : '(overlay declares none)'}`);
    }
    const pinned = productNameOf(overlay);
    if (isLite) {
        // The overlay pins the FULL product's install identity; the lite config
        // is merged after it and wins. Say so, because reportProductName below
        // would otherwise print the overlay's name and be wrong.
        console.log('[tauri-build] LITE build: productName comes from tauri.lite.conf.json');
        console.log('[tauri-build]   (merged last) — "Púca Lite", its own install slot.');
        console.log('[tauri-build]   identifier is NOT overridden: it stays com.sovereign.chat,');
        console.log('[tauri-build]   the SAME data directory as the full build. That is what');
        console.log('[tauri-build]   keeps a user signed in across a switch — and it is only');
        console.log('[tauri-build]   safe because the installers remove each other, so the two');
        console.log('[tauri-build]   never share a WebView2 profile at the same time.');
        if (pinned) {
            // A pinned productName in the overlay is merged BEFORE the lite
            // config, so it does not change this build's name — but it does
            // change what the FULL installer calls itself, which is the name
            // installer-hooks-lite.nsh looks up to find and remove it.
            console.log(`[tauri-build]   WARNING: the overlay pins productName "${pinned}" for the FULL`);
            console.log('[tauri-build]   build. installer-hooks-lite.nsh removes "Púca"; if the full');
            console.log('[tauri-build]   build ships under a different name, the lite installer will');
            console.log('[tauri-build]   NOT find it and BOTH will end up installed, sharing one');
            console.log('[tauri-build]   WebView2 folder. Update the hook to match.');
        }
    } else {
        reportProductName(
            pinned ?? productNameOf(baseConf) ?? '(unset)',
            pinned ? 'pinned by the overlay' : 'from the tracked config — overlay does not pin it',
        );
    }
    mergedDir = mkdtempSync(join(tmpdir(), 'tauri-overlay-'));
    const sanitised = join(mergedDir, 'tauri.release.json');
    writeFileSync(sanitised, JSON.stringify(raw, null, 2));
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

/**
 * Sanitise EVERY `--config <file.json>` argument, not just the release overlay.
 *
 * Tauri validates each config against its schema and rejects unknown
 * properties outright:
 *   Error `tauri.conf.json` error: Additional properties are not allowed
 *   ('//productName', '//identifier', '//app' were unexpected)
 * `//`-prefixed keys are the only way JSON can carry a comment, and
 * tauri.lite.conf.json uses them heavily to record WHY each override exists —
 * which matters more than usual there, because every one of those values is
 * load-bearing for the variant-switch model. So the comments stay in the file
 * and the CLI gets a stripped copy.
 *
 * This previously applied only to the untracked overlay, so the lite config's
 * own comments made `tauri:build:lite` fail outright — the lite installer had
 * never once been produced. Doing it for every --config also means a future
 * overlay can be documented the same way.
 */
for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--config') continue;
    const cfgPath = args[i + 1];
    if (!/\.json$/i.test(cfgPath) || !existsSync(cfgPath)) continue;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch {
        continue; // let the CLI report a malformed config in its own words
    }
    const stripped = stripCommentKeys(parsed);
    if (JSON.stringify(stripped) === JSON.stringify(parsed)) continue; // no comments
    mergedDir = mergedDir ?? mkdtempSync(join(tmpdir(), 'tauri-overlay-'));
    const clean = join(mergedDir, `sanitised-${i}-${cfgPath.replace(/.*[\\/]/, '')}`);
    writeFileSync(clean, JSON.stringify(stripped, null, 2));
    console.log(`[tauri-build] stripped // comment keys from ${cfgPath}`);
    args[i + 1] = clean;
}

// The derived lite endpoint goes LAST, after tauri.lite.conf.json, because the
// CLI's merge is last-wins. Anything earlier is silently overwritten by that
// file's placeholder.
if (liteEndpointOverride) {
    mergedDir = mergedDir ?? mkdtempSync(join(tmpdir(), 'tauri-overlay-'));
    const epFile = join(mergedDir, 'tauri.lite.endpoint.json');
    writeFileSync(epFile, JSON.stringify({
        plugins: { updater: { endpoints: liteEndpointOverride } },
    }, null, 2));
    args.push('--config', epFile);
}

// npx, not a bare `tauri`: the binary lives in node_modules/.bin, which is on
// PATH when npm runs this script but NOT when someone runs it directly. Using
// npx makes both work instead of failing confusingly in the second case.
// The cargo flags go LAST, after `--`, once all --config args are in place.
if (cargoPassthrough.length) args.push('--', ...cargoPassthrough);

console.log(`[tauri-build] tauri build ${args.join(' ')}`);
const r = spawnSync('npx', ['tauri', 'build', ...args], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, RUSTFLAGS: withCrtStatic(process.env.RUSTFLAGS) },
});
if (mergedDir) {
    try { rmSync(mergedDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(r.status ?? 1);
