// Headless half of the Clips spike — runs the encoder / mux / crypto / memory /
// MSE / A-V-sync measurements in HEADLESS Edge (same Chromium 151 as WebView2,
// same platform codecs) with a SYNTHETIC source: an animated canvas track and
// an oscillator "system audio" track. Nothing touches the user's display,
// focus, pickers or speakers. The WebView2-only questions (feature support,
// picker offers system audio, dual capture, blob spill, no plaintext files)
// were answered by the short real-shell runs; see results/ and README.md.
//
//   node e2e/spike-clips/headless.mjs [--short]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHORT = process.argv.includes('--short');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(here, 'results'); fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `headless-${stamp}.json`);
const results = { startedAt: new Date().toISOString(), short: SHORT, mode: 'headless-edge', steps: {}, samples: {}, notes: [] };
const save = () => fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(line); results.notes.push(line); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const userDataDir = path.join(process.env.TEMP || '.', 'sovereign-clip-spike-headless');
fs.rmSync(userDataDir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-features=WebCodecs'],
});
const page = await ctx.newPage();
page.on('console', m => { const t = m.text(); if (/clip-spike/.test(t)) console.log('  C>', t.slice(0, 300)); });
page.on('pageerror', e => console.log('  X>', String(e).slice(0, 300)));
// Serve the host page over http://127.0.0.1 — a potentially-trustworthy origin,
// so WebCodecs/crypto.subtle exist (about:blank via setContent does not qualify).
import http from 'node:http';
const hostSrv = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>clip spike (headless)</title><body style="margin:0;background:#123">headless host</body>'); });
await new Promise(r => hostSrv.listen(8792, '127.0.0.1', r));
await page.goto('http://127.0.0.1:8792/');
log('secure context:', await page.evaluate(() => ({ secure: window.isSecureContext, ve: 'VideoEncoder' in window, ae: 'AudioEncoder' in window, mstp: 'MediaStreamTrackProcessor' in window })));
await page.evaluate(fs.readFileSync(path.join(here, 'probe.js'), 'utf8'));
const mbSrc = fs.readFileSync(path.join(here, '..', '..', 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.mjs'), 'utf8');
log('mediabunny exports:', await page.evaluate((src) => window.__clipSpike.loadMediabunny(src), mbSrc));

// ---- process sampling (headless Edge processes of THIS profile) --------------
function ps(cmd, timeoutMs = 25000) {
    return new Promise((resolve) => {
        const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? { error: String(err.message).slice(0, 200), stdout: String(stdout || '') } : { stdout: String(stdout) }));
        child.on('error', (e) => resolve({ error: e.message, stdout: '' }));
    });
}
async function sampleProcs() {
    const needle = userDataDir.replace(/[[\]*?]/g, '`$&').replace(/'/g, "''");
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object ProcessId, WorkingSetSize, KernelModeTime, UserModeTime, @{n='Kind';e={ if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' } }} | ConvertTo-Json -Compress`;
    const r = await ps(cmd);
    if (r.error || !r.stdout.trim()) return { error: r.error || 'empty', t: Date.now() };
    let arr; try { arr = JSON.parse(r.stdout); } catch { return { error: 'parse', t: Date.now() }; }
    if (!Array.isArray(arr)) arr = [arr];
    const procs = arr.map(p => ({ pid: p.ProcessId, ws: p.WorkingSetSize, cpu100ns: (p.KernelModeTime || 0) + (p.UserModeTime || 0), kind: p.Kind }));
    return { t: Date.now(), procs, wsTotal: procs.reduce((a, p) => a + p.ws, 0), wsMax: procs.reduce((a, p) => Math.max(a, p.ws), 0), renderer: procs.filter(p => p.kind === 'renderer').reduce((a, p) => Math.max(a, p.ws), 0), cpuTotalS: procs.reduce((a, p) => a + p.cpu100ns, 0) / 1e7 };
}
const cpuPct = (a, b) => (a && b && !a.error && !b.error) ? ((b.cpuTotalS - a.cpuTotalS) / ((b.t - a.t) / 1000)) * 100 : null;
function dirSize(dir) { let total = 0, files = 0; const stack = [dir]; while (stack.length) { const d = stack.pop(); let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else { try { total += fs.statSync(p).size; files++; } catch { /* locked */ } } } } return { total, files }; }

// ---- synthetic source: agitated canvas @ 30 fps + oscillator "system audio" ---
const src = await page.evaluate(({ w, h, fps }) => {
    const S = window.__clipSpike;
    const c = document.createElement('canvas'); c.width = w; c.height = h; document.body.appendChild(c);
    const cx = c.getContext('2d');
    const noise = cx.createImageData(256, 256);
    let t = 0;
    S._synthFlash = false;
    const draw = () => {
        t++;
        if (S._synthFlash) { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); }
        else {
            cx.fillStyle = `hsl(${(t * 3) % 360} 60% 20%)`; cx.fillRect(0, 0, w, h);
            for (let i = 0; i < 40; i++) { cx.fillStyle = `hsl(${(i * 37 + t * 5) % 360} 80% 55%)`; cx.fillRect((Math.sin(t / 30 + i) * 0.5 + 0.5) * w, (Math.cos(t / 23 + i * 1.3) * 0.5 + 0.5) * h, 90, 90); }
            const d = noise.data; for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
            for (let k = 0; k < 6; k++) cx.putImageData(noise, ((t * 7 + k * 300) % w), (k * 170) % h);
            cx.fillStyle = '#fff'; cx.font = '48px monospace'; cx.fillText(String(t), 40, 80);
        }
    };
    S._synthTimer = setInterval(draw, 1000 / fps);
    const stream = c.captureStream(fps);
    // "system audio": low-level noise-ish tone so the encoder has something to chew on
    const ac = new AudioContext({ sampleRate: 48000 });
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220;
    const g = ac.createGain(); g.gain.value = 0.02; osc.connect(g).connect(dest); osc.start();
    S._synthAudioCtx = ac; S._synthDest = dest;
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    S.stream = stream;
    return { video: stream.getVideoTracks()[0].getSettings(), audioTracks: stream.getAudioTracks().length, ctxState: ac.state };
}, { w: 1920, h: 1080, fps: 30 });
log('synthetic source:', src);
results.steps.source = src; save();

// The probe's beep goes to ctx.destination of ITS OWN AudioContext (speakers) — in
// headless there are no speakers; for the sync test route the beep INTO the synthetic
// system-audio destination and the flash INTO the canvas. Patch by overriding two hooks.
await page.evaluate(() => {
    const S = window.__clipSpike;
    S._headlessBeep = (ms) => { const ac = S._synthAudioCtx; const osc = ac.createOscillator(); osc.frequency.value = 1000; const g = ac.createGain(); g.gain.value = 0.5; osc.connect(g).connect(S._synthDest); osc.start(); osc.stop(ac.currentTime + ms / 1000); };
    S._headlessFlash = (ms) => { S._synthFlash = true; setTimeout(() => { S._synthFlash = false; }, ms); };
});

// ---- S2: encoder runs -------------------------------------------------------
const s2runs = SHORT
    ? [{ label: '1080p30_hw', width: 1920, height: 1080, fps: 30, seconds: 40, hw: 'prefer-hardware', bitrate: 6_000_000 },
       { label: '1080p30_sw', width: 1920, height: 1080, fps: 30, seconds: 30, hw: 'prefer-software', bitrate: 6_000_000 }]
    : [{ label: '1080p30_hw', width: 1920, height: 1080, fps: 30, seconds: 120, hw: 'prefer-hardware', bitrate: 6_000_000 },
       { label: '1080p60_hw', width: 1920, height: 1080, fps: 60, seconds: 60, hw: 'prefer-hardware', bitrate: 9_000_000 },
       { label: '1080p30_sw', width: 1920, height: 1080, fps: 30, seconds: 60, hw: 'prefer-software', bitrate: 6_000_000 }];
results.steps.s2 = {};
for (const run of s2runs) {
    log('S2 run', run.label, `${run.seconds}s`);
    const before = await sampleProcs();
    const r = await page.evaluate((run) => window.__clipSpike.s2(run), run);
    const after = await sampleProcs();
    r.cpuPct = cpuPct(before, after);
    results.steps.s2[run.label] = r;
    log('S2', run.label, { fps: r.measuredFps?.toFixed?.(1), kbps: r.kbps?.toFixed?.(0), drop: r.dropPct?.toFixed?.(2), keyGap: r.keyGapMs && { mean: r.keyGapMs.mean?.toFixed(0), max: r.keyGapMs.max }, maxQ: r.maxQueue, cpu: r.cpuPct?.toFixed?.(1), codec: r.actualCodec, encMsPerFrame: r.encodeCallMsPerFrame?.toFixed?.(3), err: r.errors });
    save();
}

// ---- S3 ---------------------------------------------------------------------
results.steps.s3 = await page.evaluate(() => window.__clipSpike.s3()); log('S3', results.steps.s3); save();
const audioCodec = results.steps.s3['mp4a.40.2'] === true ? 'mp4a.40.2' : 'opus';

// ---- S4: 30 s capture with in-stream beeps/flashes → mux → <video> + MSE + sync ------
// Reuse the probe's captureSegment by monkey-patching its beep/flash to the synthetic path.
await page.evaluate(() => {
    const S = window.__clipSpike;
    // s4 in probe.js schedules a DOM flash + a speaker beep; in headless we drive the
    // synthetic canvas/audio instead via a periodic timer that runs alongside.
    S._syncTimer = null;
    S.startSyncMarkers = (everyMs, ms) => { S._syncEvents = []; const fire = () => { S._syncEvents.push(performance.now()); S._headlessFlash(ms); S._headlessBeep(ms); }; setTimeout(fire, 2000); S._syncTimer = setInterval(fire, everyMs); };
    S.stopSyncMarkers = () => { if (S._syncTimer) clearInterval(S._syncTimer); S._syncTimer = null; };
});
{
    log('S4: 30 s synthetic capture with markers');
    await page.evaluate(() => window.__clipSpike.startSyncMarkers(5000, 200));
    const before = await sampleProcs();
    // withBeeps:false so the probe does not add its own DOM/speaker markers.
    results.steps.s4 = await page.evaluate(async ({ seconds, audioCodec }) => {
        const S = window.__clipSpike;
        // Call the internal path by re-using s4 but suppressing its markers: s4 always
        // passes withBeeps:true, so run the pieces manually via a small shim.
        return await S.s4({ seconds, fps: 30, width: 1920, height: 1080, bitrate: 6_000_000, audioCodec, noBeeps: true });
    }, { seconds: SHORT ? 20 : 30, audioCodec });
    const after = await sampleProcs();
    await page.evaluate(() => window.__clipSpike.stopSyncMarkers());
    results.steps.s4.cpuPct = cpuPct(before, after);
    log('S4', { wallS: results.steps.s4.wallS, v: results.steps.s4.vcount, a: results.steps.s4.acount, mux: results.steps.s4.mux, plain: results.steps.s4.plainVideo, mse: results.steps.s4.mse, sync: results.steps.s4.sync && { flashes: results.steps.s4.sync.flashes?.length, beeps: results.steps.s4.sync.beeps?.length, pairs: results.steps.s4.sync.pairs, offset: results.steps.s4.sync.offsetS, vc: results.steps.s4.sync.videoCodec, ac: results.steps.s4.sync.audioCodec, vdur: results.steps.s4.sync.videoDuration, adur: results.steps.s4.sync.audioDuration }, err: results.steps.s4.muxError, cpu: results.steps.s4.cpuPct });
    save();
    try {
        const b64 = await page.evaluate(() => window.__clipSpike.exportMp4());
        if (b64) { fs.writeFileSync(path.join(outDir, `headless-s4-${stamp}.mp4`), Buffer.from(b64, 'base64')); log('saved mp4 fixture'); }
        const dc = await page.evaluate(() => JSON.stringify(window.__clipSpike.decoderConfig || null));
        if (dc && dc !== 'null') fs.writeFileSync(path.join(outDir, `headless-decoder-config-${stamp}.json`), dc);
        const seg = await page.evaluate(() => JSON.stringify(window.__clipSpike.lastSegment || null));
        if (seg) fs.writeFileSync(path.join(outDir, `headless-lastSegment-${stamp}.json`), seg);
    } catch (e) { log('fixture export failed', e.message); }
}

// ---- S7 ---------------------------------------------------------------------
results.steps.s7 = await page.evaluate(() => window.__clipSpike.s7({ bytes: 2300000, iterations: 20 })); log('S7', results.steps.s7); save();

// ---- S6: ring memory plateau -------------------------------------------------
const s6Seconds = SHORT ? 90 : 600, ringSeconds = SHORT ? 40 : 300;
log(`S6: ${s6Seconds}s ring run (ring ${ringSeconds}s)`);
results.samples.s6 = [];
results.samples.s6.push({ phase: 'before', ...(await sampleProcs()) });
log('S6 start:', await page.evaluate((o) => window.__clipSpike.s6Start(o), { seconds: s6Seconds, fps: 30, width: 1920, height: 1080, bitrate: 6_000_000, ringSeconds, audioCodec }));
for (;;) {
    await sleep(SHORT ? 10000 : 30000);
    const status = await page.evaluate(() => window.__clipSpike.s6Status());
    const smp = await sampleProcs();
    results.samples.s6.push({ phase: 'run', ...smp, status });
    log('S6', { el: status?.elapsedS?.toFixed?.(0), ringMB: (status?.ringBytes / 1048576).toFixed(1), ringS: status?.ringSeconds?.toFixed?.(0), gops: status?.gops, evicted: status?.evicted, rendererMB: (smp.renderer / 1048576).toFixed(0), wsTotMB: (smp.wsTotal / 1048576).toFixed(0), jsHeapMB: status?.jsHeap ? (status.jsHeap / 1048576).toFixed(0) : null, err: status?.err });
    save();
    if (!status || !status.running) break;
}
log('S6 wipe:', await page.evaluate(() => window.__clipSpike.s6Wipe()));
await sleep(5000);
results.samples.s6.push({ phase: 'after-wipe', ...(await sampleProcs()) });
save();

results.disk = dirSize(userDataDir);
log('profile size (bytes):', results.disk.total);
results.probeLog = JSON.parse(await page.evaluate(() => window.__clipSpike.dump())).log;
results.finishedAt = new Date().toISOString();
save();
await ctx.close();
log('DONE →', outFile);
process.exit(0);
