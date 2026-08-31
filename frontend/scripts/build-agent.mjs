/**
 * Build the native host agent and stage it for Tauri's `externalBin`.
 *
 * WHY THIS EXISTS. Without the agent beside the app executable, `agent_probe`
 * fails, getHostBackend() falls back to the webview host, and every incoming
 * session opens getDisplayMedia — the "Choose what to share" picker. That needs
 * a human at the keyboard, which means:
 *
 *   - unattended access cannot work AT ALL, however the passphrase is set;
 *   - a controller sits on "Waiting for the device's screen…" until someone
 *     walks over and clicks Share;
 *   - the picker is bounded by the webview, so on a window minimised to the tray
 *     — the normal state for an always-on host — it may not be answerable.
 *
 * 0.8.0 through 0.8.3 shipped with no `externalBin` at all, so this was true on
 * every install. The agent captures via DXGI with no prompt and enumerates
 * monitors, which is what the feature was designed around.
 *
 * Tauri expects `<name>-<target-triple><ext>` and installs it alongside the app
 * binary with the triple stripped, which is exactly where agent_ipc.rs looks.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const manifest = join(repo, 'crates', 'puca-agent', 'Cargo.toml');
// The system service ships beside the agent, but ONLY on Windows and ONLY as an
// inert file. Bundling it installs nothing: it is the elevated helper the app
// runs, once, if somebody turns lock-screen access on. Without it here the
// switch in Devices correctly reports the component as missing and stays off
// for ever, which is a worse failure than it sounds — the feature looks broken
// rather than absent.
const serviceManifest = join(repo, 'crates', 'puca-service', 'Cargo.toml');

const triple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n').find(l => l.startsWith('host:')).slice(5).trim();
const ext = process.platform === 'win32' ? '.exe' : '';

// THE ONE LIVE VERSION. Both sidecars embed Windows VERSIONINFO (see each
// crate's build.rs), and tauri-winres would otherwise default that to
// CARGO_PKG_VERSION — which is the FOSSIL 0.8.21 for the agent and 0.1.0 for the
// service. Neither is read by anything; the live number is here and only here.
// Reading it at the one point that already shells out to cargo keeps a single
// source of truth rather than adding two more places that claim to know the
// version, which is a mistake this repo has already made elsewhere.
//
// Not fatal if it cannot be read: a build.rs that receives nothing falls back to
// the crate version and prints a cargo:warning, so the failure is visible without
// blocking a developer who is only compiling the agent.
const version = (() => {
    try {
        const conf = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
        if (typeof conf.version === 'string' && conf.version.trim()) return conf.version.trim();
        console.warn('[build-agent] tauri.conf.json has no version field; sidecars will self-label with their fossil crate versions');
    } catch (e) {
        console.warn(`[build-agent] could not read tauri.conf.json (${e.message}); sidecars will self-label with their fossil crate versions`);
    }
    return undefined;
})();

// Inherit the real environment, then add ours — dropping the inherited env would
// take PATH, CARGO_HOME and the MSVC toolchain variables with it.
const cargoEnv = version ? { ...process.env, PUCA_VERSION: version } : process.env;
if (version) console.log(`[build-agent] stamping sidecars as ${version}`);

/**
 * The staged AGENT must contain the FROZEN device-control KDF label.
 *
 * Only the agent derives this key (crates/puca-agent/src/control_key.rs); the
 * service only installs and launches it, so it carries no such label.
 *
 * WHY A CONTENT CHECK AND NOT JUST A VERSION STAMP. The product was renamed
 * Sovereign -> Puca, but `sovereign-device-control-v1` is a WIRE FORMAT shared
 * with the installed app, not branding, so it stays. During that rename this
 * script staged the agent under a name `externalBin` does not resolve, so Tauri
 * silently bundled a STALE binary carrying the old `puca-` label while the app
 * sealed with the new one. Nothing failed: the version stamps matched, every
 * unit test passed, and the only symptom would have been every remote-control
 * keystroke silently dropped — which is exactly what control_key.rs's own
 * header warns about.
 *
 * The KATs pin the SOURCE. This pins the ARTEFACT THAT SHIPS, which is the
 * thing a user actually runs.
 */
function assertCarriesFrozenLabel(file, label) {
    const FROZEN = 'sovereign-device-control-v1';
    const buf = readFileSync(file);
    if (!buf.includes(Buffer.from(FROZEN, 'utf8'))) {
        throw new Error(
            `${label} does not contain the frozen wire label "${FROZEN}". ` +
            `This artefact cannot talk to the app: it is stale, or built from a tree ` +
            `where a format constant was renamed. Delete src-tauri/binaries/ and rebuild.`,
        );
    }
    console.log(`[build-agent] ${label} carries the frozen wire label`);
}

/**
 * Prove the version resource actually landed, rather than trusting that it did.
 *
 * The build.rs panics if the resource compiler fails, but that is not the whole
 * failure space: a deleted build.rs, a dropped build-dependency, or a toolchain
 * that quietly produces nothing would all yield a binary that builds, passes the
 * size floor, and ships ANONYMOUS — which is the exact state this was added to
 * end, and it looks identical to a good build from the outside.
 *
 * Reads the real PE resource through Windows itself rather than scanning bytes,
 * so it is measuring what a user (and a scanner) would actually see.
 */
function assertStamped(file, label) {
    if (process.platform !== 'win32' || !version) return;
    const { read, via } = readFileVersion(file);
    // wmic reports the NUMERIC FILEVERSION (four parts, "0.8.87.0"); PowerShell
    // reports the string resource ("0.8.87"). Both are set from the same value
    // by the crate's build.rs, so either spelling of this build's version is
    // the stamp landing — anything else is not.
    if (read !== version && read !== `${version}.0`) {
        throw new Error(
            `${label} reports FileVersion "${read}" (via ${via}) but this build is ${version}. ` +
            `An unstamped or stale-stamped sidecar must not ship: see the crate's build.rs.`,
        );
    }
    console.log(`[build-agent] ${label} version resource verified (${read}, via ${via})`);
}

/**
 * Read a PE's FileVersion through Windows itself, with a bounded wait.
 *
 * PowerShell first, because `Get-Item ... .VersionInfo` is the direct reading.
 * But it is BOUNDED and it has a fallback: on 2026-08-17 every powershell.exe
 * launched from the build environment hung after "Engine state ... Available"
 * (Defender's engine had logged 3002/5008 errors that hour, and PowerShell
 * consults AMSI before running a command), and an unbounded execFileSync here
 * turned "verify the stamp" into a build that never finished and never said
 * why. wmic reads the same version resource without touching PowerShell.
 */
function readFileVersion(file) {
    try {
        // The path travels in the ENVIRONMENT, not inside the command string.
        // PowerShell does not treat `\` as an escape, so a JSON-quoted Windows
        // path would arrive with its separators doubled — which Windows happens
        // to tolerate, meaning the bug would not announce itself, it would just
        // make this check quietly fragile. Sidestep the quoting question.
        const read = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            '(Get-Item -LiteralPath $env:PUCA_STAMP_TARGET).VersionInfo.FileVersion',
        ], {
            encoding: 'utf8',
            env: { ...process.env, PUCA_STAMP_TARGET: file },
            timeout: 30_000,
        }).trim();
        if (read) return { read, via: 'powershell' };
    } catch (e) {
        console.warn(`[build-agent] powershell could not read ${file}'s version (${e.code ?? e.message}); trying wmic`);
    }
    // WQL string literal: backslashes doubled. No shell in between, so no
    // second layer of quoting to get wrong.
    const q = file.replace(/\\/g, '\\\\');
    const out = execFileSync('wmic', ['datafile', 'where', `name="${q}"`, 'get', 'Version', '/value'], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    const m = out.match(/Version=([^\r\n]+)/);
    if (!m) throw new Error(`neither powershell nor wmic could read the version resource of ${file}`);
    return { read: m[1].trim(), via: 'wmic' };
}

console.log(`[build-agent] building puca-agent for ${triple}`);
execFileSync('cargo', ['build', '--release', '--manifest-path', manifest], {
    stdio: 'inherit',
    env: cargoEnv,
});

const built = join(repo, 'crates', 'puca-agent', 'target', 'release', `puca-agent${ext}`);
if (!existsSync(built)) throw new Error(`agent binary missing after build: ${built}`);

const outDir = join(here, '..', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const staged = join(outDir, `puca-agent-${triple}${ext}`);
copyFileSync(built, staged);

if (process.platform === 'win32') {
    console.log(`[build-agent] building puca-service for ${triple}`);
    execFileSync('cargo', ['build', '--release', '--manifest-path', serviceManifest], {
        stdio: 'inherit',
        env: cargoEnv,
    });
    const svc = join(repo, 'crates', 'puca-service', 'target', 'release', `puca-service${ext}`);
    if (!existsSync(svc)) throw new Error(`service binary missing after build: ${svc}`);
    // Staged under the TRIPLE-SUFFIXED name, which is what `externalBin` in
    // tauri.conf.json resolves; a missing one fails the whole bundle step. Tauri
    // renames it to the plain `puca-service.exe` on install, which is where
    // `service_cmd` looks for it beside the app.
    const stagedSvc = join(outDir, `puca-service-${triple}${ext}`);
    copyFileSync(svc, stagedSvc);
    const svcSize = statSync(svc).size;
    if (svcSize < 200_000) {
        throw new Error(`service binary is implausibly small (${svcSize} bytes) — broken build`);
    }
    // Check the STAGED copy, not the build-tree original: the staged file is what
    // Tauri puts in the installer, and verifying the artifact that actually ships
    // is the whole point of a guard like this.
    assertStamped(stagedSvc, 'puca-service');
    console.log(`[build-agent] staged puca-service (${svcSize} bytes)`);
}

// A zero-byte or absurdly small binary means a broken build that would ship as
// "the agent is installed" and then fail every probe. The floor is
// platform-aware: the WINDOWS agent embeds DXGI capture and the MFT encoder
// and is well over the 500KB floor, while everywhere else those modules are
// compiled out and ~450KB is the honest size — non-Windows builds never ship
// (only the Windows installer carries the sidecar); they exist as the
// cross-compile guard that catches a cfg(windows) type leaking into
// always-compiled code, which broke CI for two days before anyone could read
// the failure.
const bytes = statSync(staged).size;
const floor = process.platform === 'win32' ? 500_000 : 100_000;
if (bytes < floor) throw new Error(`staged agent looks wrong: ${bytes} bytes (floor ${floor} for ${process.platform})`);
assertStamped(staged, 'puca-agent');
// Windows only, like the size floor above and for the same reason: the label
// lives in the sealed-control path, which only the Windows build links —
// main() off Windows is the cross-compile guard stub that exits 2, so the
// constant is dead code there and LLVM strips the string from the binary.
// Only the artefact that ships (the Windows sidecar) can — or needs to —
// carry it.
if (process.platform === 'win32') {
    assertCarriesFrozenLabel(staged, 'puca-agent');
}
console.log(`[build-agent] staged ${staged} (${bytes} bytes)`);
