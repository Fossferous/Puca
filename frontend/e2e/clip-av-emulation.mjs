// END-TO-END A/V sync of the NATIVE clip pipeline, under EMULATION, silently.
//
// The real JS half of an auto-armed clip — replayBuffer.armNative, nativeCapture
// (the loopback AudioContext and its scheduling lead), the mixing graph, the
// replay worker's ring, anchor, seal and upload — runs in a real Chromium
// against an emulated Rust side (e2e/av-emulation/emulator.js) that delivers a
// real H.264 stream and 10 ms WASAPI-shaped PCM packets on ONE clock with the
// shell's timing. The stream flashes white on one frame and the PCM carries a
// 1 kHz burst starting at the instant that frame is presented. The sealed clip
// is decrypted with the app's own crypto, demuxed and decoded, and the burst's
// onset is compared with the flash frame: that difference is the pipeline's
// A/V error. A second run with the burst deliberately 300 ms late is the
// oracle's positive control.
//
// Not emulated (state it, do not forget it): the real WASAPI period/buffer and
// the real DXGI acquire+readback lag are MODELLED (emulator.js parameters),
// not measured; those stay for a flash-and-click on the real app.
//
// SILENT: msedge headless with --mute-audio; the app's graphs end in
// MediaStreamAudioDestinationNodes; nothing is played, shown or captured.
//
//   cd frontend && node e2e/clip-av-emulation.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = path.join(here, '..');
const art = path.join(fe, 'e2e-artifacts');
const dist = path.join(art, 'av-emulation-dist');
const FPS = 30, SECONDS = 14;
// Two flashes, both mid-GOP (keys every 60 frames): the first carries the
// burst at its true instant, the second a burst 300 ms LATE, the oracle's
// positive control inside the same clip (so run-to-run variance cancels).
const FLASHES = [150, 240], CONTROL_MS = 300;
let fail = 0;
const ck = (c, label, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  — ' + extra : '')); if (!c) fail++; };

// 1. A real H.264 Annex-B stream: black, one white frame, keyframes every 2 s,
//    no B-frames, SPS/PPS on every keyframe, AUD-delimited access units — the
//    shape the agent's encoder produces.
fs.mkdirSync(dist, { recursive: true });
const h264 = path.join(art, 'av-flash.h264');
execFileSync('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=1280x720:r=${FPS}:d=${SECONDS}`,
    '-vf', `drawbox=enable='${FLASHES.map(f => `eq(n,${f})`).join('+')}':c=white:t=fill`, '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '4.0', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0',
    '-x264-params', 'aud=1:annexb=1:repeat-headers=1:threads=1', '-f', 'h264', h264], { stdio: 'inherit' });
ck(fs.statSync(h264).size > 10_000, 'ffmpeg produced the flash stream', `${fs.statSync(h264).size} bytes`);

// 2. The harness bundle (real app modules + worker).
execFileSync('npx', ['vite', 'build', '--config', 'vite.avharness.config.ts'], { cwd: fe, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
fs.copyFileSync(h264, path.join(dist, 'flash.h264'));
// A classic <script> is not part of the module graph, so Vite leaves the tag
// and emits nothing for it: the emulator ships beside the bundle by hand.
fs.copyFileSync(path.join(here, 'av-emulation', 'emulator.js'), path.join(dist, 'emulator.js'));
ck(fs.existsSync(path.join(dist, 'index.html')), 'the harness bundle built');

// 3. Serve it, with an upload endpoint that keeps the sealed parts.
const parts = new Map(); // id -> Buffer
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.h264': 'application/octet-stream', '.css': 'text/css', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && url === '/api/upload') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] || '')?.[1];
            const file = boundary ? multipartFile(body, boundary) : null;
            if (!file) { res.writeHead(400); return res.end('no file'); }
            const id = crypto.randomUUID();
            parts.set(id, file);
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id }));
        });
        return;
    }
    const rel = path.normalize(decodeURIComponent(url)).replace(/^[/\\]+/, '');
    if (rel.includes('..')) { res.writeHead(403); return res.end(); }
    const f = path.join(dist, rel || 'index.html');
    fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(data);
    });
});
function multipartFile(body, boundary) {
    const b = Buffer.from('--' + boundary);
    let pos = 0;
    while (true) {
        const s = body.indexOf(b, pos); if (s < 0) return null;
        const hs = s + b.length + 2; const he = body.indexOf('\r\n\r\n', hs); if (he < 0) return null;
        const head = body.subarray(hs, he).toString();
        const next = body.indexOf(b, he + 4);
        if (/name="file"/.test(head)) return body.subarray(he + 4, next - 2);
        pos = next;
    }
}
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}`;

// 4. Drive it.
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
async function run(runIndex) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 200)); });
    // AV_RUST_MODEL=zero: no modelled Rust-side latency at all, so the number
    // is the JS pipeline's own constant (what NATIVE_AUDIO_OFFSET_US can
    // correct); the default keeps the shell's measured-shape latencies.
    const rust = process.env.AV_RUST_MODEL === 'zero' ? { readbackLagMs: 0, videoIpcMs: [0, 0], audioDeliveryMs: [0, 0] } : {};
    await page.addInitScript((p) => { window.__AV_PARAMS__ = p; }, { bursts: [{ frame: FLASHES[0], offsetMs: 0 }, { frame: FLASHES[1], offsetMs: CONTROL_MS }], ...rust });
    await page.goto(origin + '/');
    await page.waitForFunction(() => !!window.__av, null, { timeout: 15000 });
    const loaded = await page.evaluate((f) => window.__av.load('/flash.h264', f), FLASHES[0]);
    const armed = await page.evaluate(() => window.__av.arm());
    const buffered = await page.evaluate(() => window.__av.waitBuffered(12500));
    const sealed = await page.evaluate((o) => window.__av.sealAndUpload(11000, o + '/api'), origin);
    const partsB64 = Object.fromEntries([...parts.entries()].map(([id, buf]) => [id, buf.toString('base64')]));
    const m = await page.evaluate(([href, p]) => window.__av.measure(href, p), [sealed.href, partsB64]);
    const truth = await page.evaluate(() => window.__av.truth());
    await page.evaluate(() => window.__av.disarm()).catch(() => { });
    await ctx.close();
    parts.clear();
    return { runIndex, loaded, armed, buffered, sealed, m, truth, errors };
}

try {
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await run(i));
    const r0 = results[0];
    ck(r0.loaded.keyframes >= 6 && r0.loaded.accessUnits === FPS * SECONDS, "the stream has the agent's shape", `${r0.loaded.accessUnits} AUs, ${r0.loaded.keyframes} keys, ${r0.loaded.codec}`);
    ck(r0.armed.state.phase === 'armed' && r0.armed.state.hasSystemAudio === true, 'the real pipeline armed with system audio', JSON.stringify({ phase: r0.armed.state.phase, sys: r0.armed.state.hasSystemAudio, notices: r0.armed.notices }));
    for (const r of results) {
        const m = r.m;
        ck(m.videoFrames > 250 && m.audioChunks > 100 && m.errors.length === 0, `run ${r.runIndex}: the sealed clip decoded`, `${m.videoFrames} frames, ${m.audioChunks} audio chunks, ${r.sealed.info.durationMs} ms${m.errors.length ? ', errors ' + m.errors.join('; ') : ''}`);
        ck(m.flashes.length === 2 && m.brightFrames <= 4 && m.yMax - m.yMin > 100, `run ${r.runIndex}: exactly two flash frames are bright`, `y ${m.yMin.toFixed(0)}..${m.yMax.toFixed(0)}, flashes at ${m.flashes.map(t => t.toFixed(4)).join(', ')} s`);
        ck(m.onsets.length === 2 && m.audioPeak > 0.3, `run ${r.runIndex}: both bursts are in the clip`, `onsets ${m.onsets.map(t => t.toFixed(4)).join(', ')} s, peak ${m.audioPeak.toFixed(2)}`);
        const [e0, e1] = m.errorsMs;
        console.log(`  run ${r.runIndex}: A/V error ${e0?.toFixed(1)} ms (+ = audio late); control burst ${e1?.toFixed(1)} ms, i.e. shift seen as ${(e1 - e0).toFixed(1)} ms for ${CONTROL_MS}`);
        console.log(`  run ${r.runIndex}: clip-av diagnostic: ${r.sealed.diag.filter(l => l.includes('clip-av')).join(' | ') || '(not emitted)'}`);
        const L = r.truth.lead;
        console.log(`  run ${r.runIndex}: loopback scheduling lead: first ${L.first?.toFixed(1)} ms (${L.firstAtMs.toFixed(0)} ms after the first present), min ${L.min?.toFixed(1)}, p50 ${L.p50?.toFixed(1)}, max ${L.max?.toFixed(1)} ms over ${L.n} packets; around the bursts ${L.aroundBursts.map(x => x?.toFixed(1)).join(' / ')} ms; ${L.suspendedStarts} scheduled while suspended`);
        const noise = r.errors.filter(e => !/favicon|404/.test(e));
        if (noise.length) console.log('  run ' + r.runIndex + ': page errors/warnings: ' + noise.slice(0, 4).join(' || '));
        ck(e0 !== null && e1 !== null && Math.abs((e1 - e0) - CONTROL_MS) < 12, `run ${r.runIndex}: the oracle sees the ${CONTROL_MS} ms control as ${CONTROL_MS} ms`, `${(e1 - e0).toFixed(1)} ms`);
        ck(noise.every(e => !/svrn\.lol|chat\./.test(e)), `run ${r.runIndex}: nothing reached a real server`);
    }
    const errs = results.map(r => r.m.errorsMs[0]);
    console.log(`\nA/V ERROR of the JS pipeline under this emulation: ${errs.map(e => e.toFixed(1)).join(' / ')} ms (audio late)`);
    console.log(`  modelled Rust side${process.env.AV_RUST_MODEL === 'zero' ? ' (ZEROED)' : ''}: agent head start ${r0.truth.params.agentHeadStartMs} ms, readback lag ${r0.truth.params.readbackLagMs} ms, video IPC ${r0.truth.params.videoIpcMs} ms, audio delivery ${r0.truth.params.audioDeliveryMs} ms after each 10 ms packet`);
    ck(errs.every(e => Math.abs(e) < 250), 'A/V error under 250 ms (the number is the finding, not a pass/fail)', errs.map(e => e.toFixed(1)).join(' / '));
} finally {
    await browser.close();
    srv.close();
}
console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
