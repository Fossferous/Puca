/**
 * Prove a lite artifact contains NO remote-control code.
 *
 * WHY IT WORKS THIS WAY. A grep that finds nothing is not evidence — a typo in
 * the pattern, a renamed constant, or a build that never produced the file all
 * look identical to success. This repo has shipped tests that could not fail
 * more than once, so this gate refuses to report a pass on absence alone.
 *
 * It builds BOTH variants and asserts a DIFFERENTIAL:
 *   - every detector must FIRE on the full bundle   (the positive control), and
 *   - every detector must be SILENT on the lite one (the actual requirement).
 * A detector missing from the full build fails the run as a broken detector,
 * not as a pass. That is the part that keeps this honest: if remote control is
 * ever renamed, this goes red asking to be updated rather than quietly
 * approving everything for ever.
 *
 * Detectors are string LITERALS (Tauri command names, wire-protocol message
 * types, user-visible copy), never identifier names — minification rewrites
 * identifiers, so an identifier-based detector would silently stop matching.
 *
 *   node scripts/check-no-rc.mjs            # build both, then check
 *   node scripts/check-no-rc.mjs --no-build # check the dist trees already built
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, '..');
const dist = join(frontend, 'dist');
const fullDir = join(frontend, '.rc-check', 'full');
const liteDir = join(frontend, '.rc-check', 'lite');

/**
 * Strings that exist ONLY because remote control is in the build.
 *
 * Each is a literal that survives minification. Grouped by what they prove, so
 * a failure names the feature rather than just a string.
 */
const DETECTORS = [
    // Tauri commands the lite desktop shell does not even compile
    { s: 'wol_send', why: 'Wake-on-LAN magic packet' },
    { s: 'inject_input', why: 'remote input injection' },
    { s: 'device_key_dh', why: 'device-session key agreement' },
    { s: 'tunnel_arm_host', why: 'port forwarding through a device session' },
    { s: 'lock_screen_arm', why: 'sign-in-screen unattended access' },
    { s: 'unattended_arm', why: 'unattended hosting' },
    { s: 'agent_request', why: 'native host-agent IPC' },
    { s: 'shareable_folders', why: 'remote file browser roots' },
    { s: 'list_anticheat_processes', why: 'control-session anti-cheat gate' },
    { s: 'set_control_monitor', why: 'which monitor injected input maps onto' },
    // Wire protocol
    { s: 'DeviceConnectRequested', why: 'incoming device-control session' },
    { s: 'ControlInput', why: 'input frames over the device channel' },
    { s: 'DeviceWake', why: 'Wake-on-LAN request/result frames' },
    // User-visible copy
    { s: 'is controlling this device', why: 'host-side control banner' },
];

/**
 * Preserved features asserted PRESENT in the lite bundle.
 *
 * This is the over-excision half of the gate: it catches an excision that took
 * a preserved feature out along with remote control.
 *
 * EVERY ENTRY MUST BE APP-OWNED. The first version of this list used
 * 'ScreenShare', which appears 33 times in the LiveKit vendor chunk as its
 * Track.Source enum — LiveKit ships regardless of whether Puca's own
 * screen-share UI does, so the assertion passed on third-party bytes and could
 * not fail. Voice screen sharing could have been deleted entirely and this
 * still reported green. Each entry below is checked against the app chunks
 * only (see APP_CHUNK / isVendorChunk) and was verified absent from vendor.
 */
const MUST_REMAIN = [
    { s: 'device_key_sign', why: 'device attestation (push delivery needs it)' },
    { s: 'Audio to share', why: 'voice-channel screen-share UI (ScreenShareModal)' },
    { s: 'app-mixer-list', why: 'per-app audio picker inside the screen-share modal' },
    { s: 'set_stream_boost', why: 'CPU-priority boost for a live voice screen share' },
];

/**
 * Third-party chunks. MUST_REMAIN is asserted against APP code only, so a
 * preserved-feature detector can never be satisfied by a library that happens
 * to use the same word.
 */
function isVendorChunk(name) {
    return /vendor|worker|rnnoise|df_wasm|dfW/i.test(name);
}

function build(env, outDir) {
    rmSync(dist, { recursive: true, force: true });
    execFileSync('npx', ['vite', 'build'], {
        cwd: frontend,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...env },
    });
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(dist, outDir, { recursive: true });
}

/** Every byte of JS/CSS a browser would load from this build, plus the same
 *  restricted to APP chunks (vendor/worker excluded) for MUST_REMAIN. */
function bundleText(dir) {
    const assets = join(dir, 'assets');
    if (!existsSync(assets)) throw new Error(`no assets/ in ${dir} — did the build run?`);
    const files = readdirSync(assets).filter(f => f.endsWith('.js') || f.endsWith('.css'));
    if (files.length === 0) throw new Error(`no JS/CSS emitted in ${assets}`);
    let text = '';
    let appText = '';
    for (const f of files) {
        const body = readFileSync(join(assets, f), 'utf8');
        text += body;
        if (!isVendorChunk(f)) appText += body;
    }
    // index.html can inline a module preload/bootstrap
    const html = join(dir, 'index.html');
    if (existsSync(html)) {
        const body = readFileSync(html, 'utf8');
        text += body;
        appText += body;
    }
    return { text, appText, files };
}

const noBuild = process.argv.includes('--no-build');
if (!noBuild) {
    console.log('[check-no-rc] building FULL (positive control)…');
    build({ VITE_ENABLE_RC: 'true' }, fullDir);
    console.log('[check-no-rc] building LITE…');
    build({ VITE_ENABLE_RC: 'false' }, liteDir);
}

const full = bundleText(fullDir);
const lite = bundleText(liteDir);
console.log(`[check-no-rc] full: ${full.files.length} asset(s); lite: ${lite.files.length} asset(s)`);

const brokenDetectors = [];
const leaked = [];
for (const d of DETECTORS) {
    const inFull = full.text.includes(d.s);
    const inLite = lite.text.includes(d.s);
    if (!inFull) brokenDetectors.push(d);
    else if (inLite) leaked.push(d);
    const mark = !inFull ? 'BROKEN ' : inLite ? 'LEAKED ' : 'ok     ';
    console.log(`  ${mark} ${d.s.padEnd(28)} full=${inFull ? 'yes' : 'NO '} lite=${inLite ? 'YES' : 'no '}  (${d.why})`);
}

const missing = [];
for (const m of MUST_REMAIN) {
    // appText, NOT text: a vendor chunk must never be able to satisfy this.
    const present = lite.appText.includes(m.s);
    if (!present) missing.push(m);
    console.log(`  ${present ? 'ok     ' : 'MISSING'} ${m.s.padEnd(28)} must remain in lite      (${m.why})`);
}

// An RC chunk emitted at all is a failure even if no detector happened to sit
// inside it — the file still ships.
const rcChunks = lite.files.filter(f => /^(DevicesView|host[A-Z]|deviceStage|remoteControl)/.test(f));

/**
 * The lite ControlState stub must mirror the real one's fields EXACTLY.
 *
 * The Vite build swaps api/remoteControl for remoteControl.lite.ts, but
 * typecheck and vitest compile against the REAL module (there is no alias
 * there) — so a stub whose ControlState drifts is invisible to tsc. It would
 * surface only at runtime in a lite build, as `undefined` where a preserved
 * component read a field the stub forgot. Compare the two interfaces' top-level
 * field names here, where the mismatch is cheap to catch.
 */
function controlStateFields(file) {
    const src = readFileSync(join(frontend, 'src', 'api', file), 'utf8');
    const m = src.match(/export interface ControlState \{([\s\S]*?)\n\}/);
    if (!m) return null;
    return m[1]
        .split('\n')
        .map(l => l.match(/^\s*([A-Za-z_]\w*)\s*[?:]/))
        .filter(Boolean)
        .map(x => x[1])
        .sort();
}
const realFields = controlStateFields('remoteControl.ts');
const liteFields = controlStateFields('remoteControl.lite.ts');
const controlStateMismatch = !realFields || !liteFields
    || realFields.length !== liteFields.length
    || realFields.some((f, i) => f !== liteFields[i]);

let failed = false;
if (brokenDetectors.length) {
    failed = true;
    console.error(
        `\n[check-no-rc] ${brokenDetectors.length} detector(s) did NOT appear in the FULL build.\n`
        + 'That is a broken gate, not a pass: these strings can no longer prove anything.\n'
        + 'Remote control was probably renamed — update the detector list:\n'
        + brokenDetectors.map(d => `  - ${d.s}  (${d.why})`).join('\n'));
}
if (leaked.length) {
    failed = true;
    console.error(
        `\n[check-no-rc] ${leaked.length} remote-control string(s) are IN THE LITE BUNDLE:\n`
        + leaked.map(d => `  - ${d.s}  (${d.why})`).join('\n'));
}
if (missing.length) {
    failed = true;
    console.error(
        `\n[check-no-rc] ${missing.length} PRESERVED feature(s) are missing from the lite bundle — `
        + 'the excision took too much:\n'
        + missing.map(d => `  - ${d.s}  (${d.why})`).join('\n'));
}
if (rcChunks.length) {
    failed = true;
    console.error('\n[check-no-rc] remote-control chunks emitted into the lite bundle:\n'
        + rcChunks.map(f => '  - ' + f).join('\n'));
}
if (controlStateMismatch) {
    failed = true;
    console.error('\n[check-no-rc] remoteControl.lite.ts ControlState does not mirror the real one:\n'
        + `  real: ${realFields ? realFields.join(', ') : '(could not parse)'}\n`
        + `  lite: ${liteFields ? liteFields.join(', ') : '(could not parse)'}\n`
        + '  The Vite build swaps in the lite stub, but typecheck uses the real module, so a\n'
        + '  drifted field is invisible to tsc and becomes undefined at runtime in a lite build.');
}

if (failed) process.exit(1);
console.log('\n[check-no-rc] PASS — every detector fires on the full build and none on the lite build.');
