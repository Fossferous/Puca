// Clips spike runner — drives probe.js inside the REAL WebView2 shell over raw
// CDP (no Playwright, so no focus emulation and no fake media UI).
//
// Start the dev shell first, with its own WebView2 profile and the debug port:
//   WEBVIEW2_USER_DATA_FOLDER=%TEMP%\sovereign-clip-spike
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --auto-select-desktop-capture-source=Entire screen"
//   npm run tauri:dev
// then:  node e2e/spike-clips/runner.mjs [--short]
//
// If auto-select does not take effect (see e2e/spike-s1/README.md), a human (or
// UIA script) must pick "Entire screen" + tick "Also share system audio" when the
// picker appears; the runner waits up to 3 minutes for that.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHORT = process.argv.includes('--short');
const PICK = (process.argv.find(a => a.startsWith('--pick=')) || '').slice(7); // e.g. --pick="Screen 3" → drive the picker via UIA
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `results-${stamp}.json`);
const results = { startedAt: new Date().toISOString(), short: SHORT, steps: {}, samples: {}, notes: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(line); results.notes.push(line); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- static host page (immune to vite HMR reloads of the dev app) ------------
import http from 'node:http';
const HOST_PORT = 8791;
const hostHtml = '<!doctype html><meta charset="utf-8"><title>clip spike</title><body style="margin:0;background:#123">clip spike host</body>';
const hostSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(hostHtml); });
await new Promise(r => hostSrv.listen(HOST_PORT, '127.0.0.1', r));

// ---- CDP ------------------------------------------------------------------
const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find(t => t.type === 'page' && (/localhost:5173/.test(t.url) || /127\.0\.0\.1:8791/.test(t.url)));
if (!page) { console.error('no page target on :9222 — is the dev shell running with the debug port?', targets.map(t => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        if (/clip-spike/.test(text)) console.log('  C>', text.slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') console.log('  X>', msg.params.exceptionDetails?.text, msg.params.exceptionDetails?.exception?.description?.slice(0, 300));
};
await new Promise(r => { ws.onopen = r; });
await call('Runtime.enable');
await call('Page.enable');
if (!/127\.0\.0\.1:8791/.test(page.url)) {
    await call('Page.navigate', { url: `http://127.0.0.1:${HOST_PORT}/` });
    await sleep(1500);
}
const evaluate = async (expression, { gesture = false, timeoutMs = 0 } = {}) => {
    const p = call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: gesture });
    const r = timeoutMs ? await Promise.race([p, sleep(timeoutMs).then(() => ({ timeout: true }))]) : await p;
    if (r.timeout) return { __timeout: true };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
};
log('attached to', page.url);

// ---- process sampling (WebView2 processes of THIS profile) ---------------
const profileDir = process.env.WEBVIEW2_USER_DATA_FOLDER || path.join(process.env.TEMP || '', 'sovereign-clip-spike');
function ps(cmd, timeoutMs = 25000) {
    return new Promise((resolve) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? { error: String(err.message).slice(0, 200), stdout: String(stdout || '') } : { stdout: String(stdout) }));
        child.on('error', (e) => resolve({ error: e.message, stdout: '' }));
    });
}
async function sampleProcs() {
    // -like treats only * ? [ ] as wildcards; backslashes are literal.
    const needle = profileDir.replace(/[[\]*?]/g, '`$&').replace(/'/g, "''");
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object ProcessId, WorkingSetSize, KernelModeTime, UserModeTime, @{n='Kind';e={ if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' } }} | ConvertTo-Json -Compress`;
    const r = await ps(cmd);
    if (r.error || !r.stdout.trim()) return { error: r.error || 'empty', t: Date.now() };
    let arr; try { arr = JSON.parse(r.stdout); } catch { return { error: 'parse', t: Date.now() }; }
    if (!Array.isArray(arr)) arr = [arr];
    const procs = arr.map(p => ({ pid: p.ProcessId, ws: p.WorkingSetSize, cpu100ns: (p.KernelModeTime || 0) + (p.UserModeTime || 0), kind: p.Kind }));
    return { t: Date.now(), procs, wsTotal: procs.reduce((a, p) => a + p.ws, 0), wsMax: procs.reduce((a, p) => Math.max(a, p.ws), 0), cpuTotalS: procs.reduce((a, p) => a + p.cpu100ns, 0) / 1e7 };
}
function dirSize(dir) {
    let total = 0, files = 0; const stack = [dir];
    while (stack.length) { const d = stack.pop(); let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else { try { total += fs.statSync(p).size; files++; } catch { /* locked */ } } } }
    return { total, files };
}
function largeFiles(dir, minBytes) {
    const out = []; const stack = [dir];
    while (stack.length) { const d = stack.pop(); let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else { try { const st = fs.statSync(p); if (st.size >= minBytes) out.push({ p: path.relative(dir, p), size: st.size, mtime: st.mtimeMs }); } catch { /* locked */ } } } }
    return out;
}
const cpuPct = (a, b) => (a && b && !a.error && !b.error) ? ((b.cpuTotalS - a.cpuTotalS) / ((b.t - a.t) / 1000)) * 100 : null;

// ---- inject ----------------------------------------------------------------
const probeSrc = fs.readFileSync(path.join(here, 'probe.js'), 'utf8');
const mbPath = path.join(here, '..', '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.mjs');
const mbSrc = fs.readFileSync(mbPath, 'utf8');
log('probe install:', await evaluate(probeSrc));
await evaluate('window.__clipSpike.stopAll()').catch(() => {});
log('mediabunny exports:', await evaluate(`window.__clipSpike.loadMediabunny(${JSON.stringify(mbSrc)})`));
results.env = { profileDir, mediabunny: JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'node_modules', 'mediabunny', 'package.json'), 'utf8')).version, webview2: process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS || null };
results.disk0 = dirSize(profileDir); results.largeFiles0 = largeFiles(profileDir, 1024 * 1024);
save();

// ---- S0 ---------------------------------------------------------------------
results.steps.s0 = await evaluate('window.__clipSpike.s0()'); log('S0', results.steps.s0); save();

// ---- S1 (gesture) -----------------------------------------------------------
log('S1: calling getDisplayMedia with a CDP user gesture — if a picker appears, choose "Entire screen" and tick system audio');
const s1p = evaluate('window.__clipSpike.s1({levelMs: 3000})', { gesture: true });
if (PICK) { setTimeout(() => { execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pick-screen.ps1'), '-Pick', PICK, '-WaitSeconds', '60'], { windowsHide: true }, (e, out) => log('pick-screen:', (out || '').trim().slice(0, 600), e ? e.message : '')); }, 1500); }
let s1 = null;
for (let i = 0; i < 36; i++) { // up to 3 minutes
    const r = await Promise.race([s1p, sleep(5000).then(() => ({ __pending: true }))]);
    if (!r.__pending) { s1 = r; break; }
    const pendingFlag = await evaluate('window.__clipSpike.s1Pending === true').catch(() => 'n/a');
    log(`S1 still pending (${(i + 1) * 5}s) — picker open? s1Pending=${pendingFlag}`);
}
results.steps.s1 = s1 ?? { error: 'timeout: getDisplayMedia never resolved (picker not answered / auto-select ineffective)' };
log('S1', results.steps.s1); save();
const foreground = () => new Promise(res => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'foreground.ps1')], { windowsHide: true, timeout: 20000 }, (e, out) => res((out || '').trim() + (e ? ' ' + e.message : ''))));
if (s1 && !s1.error) {
    // The app must be VISIBLE on the captured screen for the agitator/flash to
    // mean anything: bring it forward, go fullscreen, then locate; if the
    // capture is another monitor, re-pick until the flash shows up.
    log('foreground:', await foreground());
    log('fullscreen:', await evaluate('window.__clipSpike.fullscreen()', { gesture: true }));
    await sleep(1200);
    let loc = await evaluate('window.__clipSpike.locate()');
    log('locate:', loc);
    if (PICK && !loc.onCapturedScreen) {
        for (const alt of ['Screen 2', 'Screen 3', 'Screen 1'].filter(x => x !== PICK)) {
            await evaluate('window.__clipSpike.stopAll()');
            log('re-pick', alt);
            const p2 = evaluate('window.__clipSpike.s1({levelMs: 1500})', { gesture: true });
            setTimeout(() => { execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pick-screen.ps1'), '-Pick', alt, '-WaitSeconds', '40'], { windowsHide: true }, (e, out) => log('pick-screen:', (out || '').trim().slice(0, 300), e ? e.message : '')); }, 1500);
            const r2 = await Promise.race([p2, sleep(60000).then(() => ({ error: 'timeout' }))]);
            if (r2.error) { log('re-pick failed', r2); continue; }
            loc = await evaluate('window.__clipSpike.locate()');
            log('locate:', loc);
            if (loc.onCapturedScreen) { results.steps.s1 = r2; results.steps.s1.pickedTile = alt; break; }
        }
    }
    results.steps.locate = loc; save();
}
const haveStream = !!(s1 && !s1.error);
const haveAudio = !!(s1 && s1.audioTracks > 0);
if (!haveStream) { log('No display stream — S2/S4/S6/S8 cannot run. Writing partial results.'); results.finishedAt = new Date().toISOString(); save(); process.exit(2); }
if (!haveAudio) log('WARNING: no system-audio track — S1 FAIL for the audio half; continuing video-only measurements');

// ---- S2 (encoder runs, CPU sampled around each) ------------------------------
const s2runs = SHORT
    ? [{ label: '1080p30_hw', width: 1920, height: 1080, fps: 30, seconds: 40, hw: 'prefer-hardware', bitrate: 6_000_000 },
       { label: '1080p60_hw', width: 1920, height: 1080, fps: 60, seconds: 30, hw: 'prefer-hardware', bitrate: 9_000_000 },
       { label: '1080p30_sw', width: 1920, height: 1080, fps: 30, seconds: 30, hw: 'prefer-software', bitrate: 6_000_000 }]
    : [{ label: '1080p30_hw', width: 1920, height: 1080, fps: 30, seconds: 180, hw: 'prefer-hardware', bitrate: 6_000_000 },
       { label: '1080p60_hw', width: 1920, height: 1080, fps: 60, seconds: 120, hw: 'prefer-hardware', bitrate: 9_000_000 },
       { label: '1080p30_sw', width: 1920, height: 1080, fps: 30, seconds: 60, hw: 'prefer-software', bitrate: 6_000_000 }];
results.steps.s2 = {};
log('agitator:', await evaluate('window.__clipSpike.agitate(true)'));
await sleep(1000);
for (const run of s2runs) {
    log('S2 run', run.label, `${run.seconds}s`);
    const before = await sampleProcs();
    const r = await evaluate(`window.__clipSpike.s2(${JSON.stringify(run)})`);
    const after = await sampleProcs();
    r.cpuPct = cpuPct(before, after); r.wsMaxAfter = after.wsMax;
    results.steps.s2[run.label] = r; log('S2', run.label, { fps: r.measuredFps?.toFixed?.(1), kbps: r.kbps?.toFixed?.(0), drop: r.dropPct?.toFixed?.(2), key: r.keyGapMs, maxQ: r.maxQueue, cpu: r.cpuPct?.toFixed?.(1), codec: r.actualCodec, err: r.errors }); save();
}

log('agitator:', await evaluate('window.__clipSpike.agitate(false)'));

// ---- S3 ---------------------------------------------------------------------
results.steps.s3 = await evaluate('window.__clipSpike.s3()'); log('S3', results.steps.s3); save();
const audioCodec = results.steps.s3['mp4a.40.2'] === true ? 'mp4a.40.2' : 'opus';
log('audio codec for S4/S6:', audioCodec);

// ---- S4 (fullscreen so the flash lands on the captured screen) ---------------
log('S4: 30 s capture with beeps/flashes (quiet beeps will be audible)');
log('foreground:', await foreground());
if (!(await evaluate('!!document.fullscreenElement'))) log('fullscreen:', await evaluate('window.__clipSpike.fullscreen()', { gesture: true }));
await sleep(1000);
log('agitator:', await evaluate('window.__clipSpike.agitate(true)'));
{
    const before = await sampleProcs();
    results.steps.s4 = await evaluate(`window.__clipSpike.s4(${JSON.stringify({ seconds: SHORT ? 20 : 30, fps: 30, width: 1920, height: 1080, bitrate: 6_000_000, audioCodec })})`);
    const after = await sampleProcs();
    results.steps.s4.cpuPct = cpuPct(before, after);
}
log('agitator:', await evaluate('window.__clipSpike.agitate(false)'));
log('S4', { mux: results.steps.s4.mux, plain: results.steps.s4.plainVideo, mse: results.steps.s4.mse, sync: results.steps.s4.sync && { flashes: results.steps.s4.sync.flashes, beeps: results.steps.s4.sync.beeps, offset: results.steps.s4.sync.offsetS, vcodec: results.steps.s4.sync.videoCodec, acodec: results.steps.s4.sync.audioCodec }, err: results.steps.s4.muxError }); save();
// Save the mp4 + decoder config as fixtures
try {
    const b64 = await evaluate('window.__clipSpike.exportMp4()');
    if (b64) { fs.writeFileSync(path.join(outDir, `s4-${stamp}.mp4`), Buffer.from(b64, 'base64')); log('saved s4 mp4 fixture'); }
    const dc = await evaluate('JSON.stringify(window.__clipSpike.decoderConfig || null)');
    if (dc && dc !== 'null') fs.writeFileSync(path.join(outDir, `decoder-config-${stamp}.json`), dc);
} catch (e) { log('fixture export failed', e.message); }

// ---- S7 ---------------------------------------------------------------------
results.steps.s7 = await evaluate('window.__clipSpike.s7({bytes: 2300000, iterations: 20})'); log('S7', results.steps.s7); save();

// ---- S6 (ring memory plateau) ------------------------------------------------
const s6Seconds = SHORT ? 90 : 600, ringSeconds = SHORT ? 40 : 300;
log(`S6: ${s6Seconds}s ring run (ring ${ringSeconds}s) — sampling process memory every 30 s`);
results.samples.s6 = [];
const base = await sampleProcs(); results.samples.s6.push({ phase: 'before', ...base, status: null });
log('agitator:', await evaluate('window.__clipSpike.agitate(true)'));
log('S6 start:', await evaluate(`window.__clipSpike.s6Start(${JSON.stringify({ seconds: s6Seconds, fps: 30, width: 1920, height: 1080, bitrate: 6_000_000, ringSeconds, audioCodec })})`));
for (;;) {
    await sleep(SHORT ? 10000 : 30000);
    const status = await evaluate('window.__clipSpike.s6Status()');
    const smp = await sampleProcs();
    results.samples.s6.push({ phase: 'run', ...smp, status });
    log('S6', { el: status?.elapsedS?.toFixed?.(0), ringMB: (status?.ringBytes / 1048576).toFixed(1), ringS: status?.ringSeconds?.toFixed?.(0), gops: status?.gops, evicted: status?.evicted, wsMaxMB: (smp.wsMax / 1048576).toFixed(0), wsTotMB: (smp.wsTotal / 1048576).toFixed(0), err: status?.err });
    save();
    if (!status || !status.running) break;
}
log('agitator:', await evaluate('window.__clipSpike.agitate(false)'));
log('S6 wipe:', await evaluate('window.__clipSpike.s6Wipe()'));
log('exit fullscreen:', await evaluate('window.__clipSpike.exitFullscreen()', { gesture: true }));
await sleep(5000);
results.samples.s6.push({ phase: 'after-wipe', ...(await sampleProcs()) });
save();

// ---- S8 (second getDisplayMedia; gesture) ------------------------------------
log('S8: second getDisplayMedia while the first is live (auto-select or a human pick)');
{
    const p = evaluate('window.__clipSpike.s8()', { gesture: true });
    if (PICK) { setTimeout(() => { execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'pick-screen.ps1'), '-Pick', PICK, '-WaitSeconds', '60'], { windowsHide: true }, (e, out) => log('pick-screen(s8):', (out || '').trim().slice(0, 400), e ? e.message : '')); }, 1500); }
    let r = null;
    for (let i = 0; i < 24; i++) { const x = await Promise.race([p, sleep(5000).then(() => ({ __pending: true }))]); if (!x.__pending) { r = x; break; } log(`S8 pending ${(i + 1) * 5}s`); }
    results.steps.s8 = r ?? { error: 'timeout' }; log('S8', results.steps.s8); save();
}

// ---- S10 (blob spill on the viewer side) -------------------------------------
{
    const blobDir = path.join(profileDir, 'Default', 'blob_storage');
    const before = dirSize(blobDir);
    const r32 = await evaluate('window.__clipSpike.s10({mb: 32})'); await sleep(2000); const mid = dirSize(blobDir);
    const r128 = await evaluate('window.__clipSpike.s10({mb: 128})'); await sleep(2000); const after = dirSize(blobDir);
    const r512 = await evaluate('window.__clipSpike.s10({mb: 512})'); await sleep(3000); const after512 = dirSize(blobDir);
    await evaluate('window.__clipSpike.s10Release()');
    results.steps.s10 = { blobDir, before, after32: mid, after128: after, after512, r32, r128, r512, largeInProfile: largeFiles(profileDir, 1024 * 1024) };
    log('S10', { before: before.total, after32: mid.total, after128: after.total, after512: after512.total }); save();
}

// ---- S9 (disk-write substitute: profile size + large files) -------------------
results.disk1 = dirSize(profileDir); results.largeFiles1 = largeFiles(profileDir, 1024 * 1024);
log('S9 profile size before/after (bytes):', results.disk0.total, '→', results.disk1.total, 'large files:', results.largeFiles1.length);
results.probeLog = JSON.parse(await evaluate('window.__clipSpike.dump()')).log;
await evaluate('window.__clipSpike.stopAll()');
results.finishedAt = new Date().toISOString();
save();
log('DONE →', outFile);
process.exit(0);
