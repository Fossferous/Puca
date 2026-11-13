#!/usr/bin/env node
/**
 * Prove from BUILT APKs that control of a phone from a call (the
 * :phone-control module, an AccessibilityService) is in the full APK and
 * absent from Lite: its manifest, its dex, and its web bundle.
 *
 * A DIFFERENTIAL, like scripts/check-no-rc.mjs and for the same reason: a
 * search that finds nothing proves nothing on its own (a typo, a renamed
 * class, an APK that was never rebuilt all look like success). So every
 * detector must FIRE on the full APK (the positive control) and stay SILENT
 * on Lite. A detector the full APK lacks fails the run as a broken detector.
 *
 * It reads the APKs with the SDK's own tools: aapt2 (build-tools) for the
 * compiled manifest, apkanalyzer (cmdline-tools) for the dex's classes and
 * the bundled web files.
 *
 *   node scripts/check-apk-control.mjs --full <full.apk> --lite <lite.apk>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function arg(name) {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
}
const FULL = arg('--full');
const LITE = arg('--lite');
if (!FULL || !LITE || !existsSync(FULL) || !existsSync(LITE)) {
    console.error('usage: node scripts/check-apk-control.mjs --full <full.apk> --lite <lite.apk>');
    process.exit(2);
}

const SDK = process.env.ANDROID_HOME || join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const WIN = process.platform === 'win32';
function newest(dir) {
    if (!existsSync(dir)) return null;
    const v = readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return v.length ? join(dir, v[v.length - 1]) : null;
}
const bt = newest(join(SDK, 'build-tools'));
const AAPT2 = bt ? join(bt, WIN ? 'aapt2.exe' : 'aapt2') : null;
const APKANALYZER = join(SDK, 'cmdline-tools', 'latest', 'bin', WIN ? 'apkanalyzer.bat' : 'apkanalyzer');
for (const [name, p] of [['aapt2', AAPT2], ['apkanalyzer', APKANALYZER]]) {
    if (!p || !existsSync(p)) { console.error(`${name} not found under ${SDK}`); process.exit(2); }
}
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: WIN && cmd.endsWith('.bat') });

// The bundled web files, in one go (apkanalyzer starts a JVM per file):
// Python's zipfile, which gates.mjs already relies on being installed.
const PY = process.env.PYTHON || (WIN ? 'python' : 'python3');
const WEB_READER = [
    'import sys, zipfile, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'names = [n for n in z.namelist() if n.startswith("assets/public/") and n.endswith((".js", ".html"))]',
    'sys.stdout.write(json.dumps({"n": len(names), "text": "".join(z.read(n).decode("utf-8", "replace") for n in names)}))',
].join('\n');

function read(apk) {
    const manifest = run(AAPT2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
    const classes = run(APKANALYZER, ['dex', 'packages', '--defined-only', apk]);
    const web = JSON.parse(run(PY, ['-I', '-c', WEB_READER, apk]));
    return { manifest, classes, web: web.text, webFiles: web.n };
}

/** Each detector: where to look, and what proves the feature is there. */
const DETECTORS = [
    { where: 'manifest', s: 'PhoneControlService', why: 'the AccessibilityService is declared' },
    { where: 'manifest', s: 'android.accessibilityservice.AccessibilityService', why: 'an accessibility-service intent filter' },
    { where: 'manifest', s: 'StopControlReceiver', why: 'the notification\'s Stop control receiver' },
    { where: 'classes', s: 'com.sovereign.app.control.PhoneControlService', why: 'the service class is in the dex' },
    { where: 'classes', s: 'com.sovereign.app.control.SovereignPhoneControlPlugin', why: 'the plugin class is in the dex' },
    { where: 'classes', s: 'com.sovereign.app.control.TouchPlanner', why: 'the gesture planner is in the dex' },
    { where: 'web', s: 'SovereignPhoneControl', why: 'the page asks for the plugin' },
    { where: 'web', s: 'is controlling this phone', why: 'the phone\'s control banner' },
];
/** Shared by both, asserted present in BOTH (the over-excision half). */
const BOTH = [
    { where: 'manifest', s: 'ScreenShareService', why: 'sharing the phone\'s screen (Lite shares too)' },
    { where: 'classes', s: 'com.sovereign.app.ScreenShareService', why: 'the share service class' },
    { where: 'classes', s: 'com.sovereign.app.ControlRegistrar', why: 'the registrar (a no-op in Lite)' },
];

const full = read(FULL);
const lite = read(LITE);
console.log(`[check-apk-control] full: ${full.webFiles} web file(s); lite: ${lite.webFiles} web file(s)`);
let bad = 0;
for (const d of DETECTORS) {
    const inFull = full[d.where].includes(d.s);
    const inLite = lite[d.where].includes(d.s);
    if (!inFull) { console.log(`BROKEN DETECTOR  ${d.where}: "${d.s}" is not in the FULL APK (${d.why})`); bad++; continue; }
    if (inLite) { console.log(`LEAK  ${d.where}: "${d.s}" is in the LITE APK (${d.why})`); bad++; continue; }
    console.log(`ok    ${d.where}: "${d.s}" in full, not in lite (${d.why})`);
}
for (const d of BOTH) {
    const ok = full[d.where].includes(d.s) && lite[d.where].includes(d.s);
    console.log(`${ok ? 'ok   ' : 'MISSING'} ${d.where}: "${d.s}" in both (${d.why})`);
    if (!ok) bad++;
}
console.log(bad ? `\n${bad} problem(s)` : '\nthe full APK has control of the phone, Lite has none of it');
process.exit(bad ? 1 : 0);
