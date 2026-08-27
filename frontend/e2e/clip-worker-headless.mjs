// End-to-end proof of the REAL replay worker (dist/assets/replayWorker-*.js) in
// headless Edge: a synthetic canvas + oscillator source stands in for
// getDisplayMedia + the mic; the worker is driven through its actual message
// protocol (arm → status → seal → preview → trim → preview → discardSeal →
// wipe) and every answer is asserted. Runs invisibly — nothing touches the
// user's display.
//
// `preview`/`trim` are capabilities the APP only reaches after every call
// participant approved (the composer's `approved` phase — docs/CLIPS.md,
// clipNoPreview.test.ts). The worker itself has no notion of approval, so
// this test drives them directly to prove the plumbing: the MSE handle plays,
// and a trim re-seals to fewer parts that still play.
//
//   cd frontend && npm run build && node e2e/clip-worker-headless.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const workerFile = fs.readdirSync(path.join(dist, 'assets')).find(f => /^replayWorker-.*\.js$/.test(f));
if (!workerFile) { console.error('no replayWorker bundle in dist/assets — run npm run build first'); process.exit(1); }

let pass = 0, fail = 0;
const ck = (cond, label, extra = '') => { if (cond) { pass++; console.log('PASS', label, extra); } else { fail++; console.log('FAIL', label, extra); } };

const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>clip worker e2e</title><body></body>'); return; }
    const p = path.join(dist, u.pathname);
    if (!p.startsWith(dist) || !fs.existsSync(p)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
});
await new Promise(r => srv.listen(8793, '127.0.0.1', r));

const ctx = await chromium.launchPersistentContext(path.join(process.env.TEMP || '.', 'sovereign-clip-worker-e2e'), {
    channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await ctx.newPage();
page.on('console', m => { const t = m.text(); if (!/^\[vite\]/.test(t)) console.log('  C>', t.slice(0, 200)); });
page.on('pageerror', e => console.log('  X>', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:8793/');

const result = await page.evaluate(async ({ workerUrl, seconds }) => {
    const log = [];
    const w = new Worker(workerUrl, { type: 'module' });
    const inbox = [];
    const waiters = [];
    w.onmessage = (ev) => { inbox.push(ev.data); log.push(ev.data.t + (ev.data.t === 'status' ? ':' + ev.data.s.bufferedMs : '')); for (const wt of [...waiters]) { if (wt.pred(ev.data)) { waiters.splice(waiters.indexOf(wt), 1); wt.res(ev.data); } } };
    w.onerror = (e) => { log.push('WORKER ERROR ' + e.message); };
    const waitFor = (pred, ms = 20000) => new Promise((res, rej) => { const hit = inbox.find(pred); if (hit) return res(hit); const t = setTimeout(() => { waiters.splice(waiters.findIndex(x => x.res === res), 1); rej(new Error('timeout waiting; log=' + log.slice(-12).join(','))); }, ms); waiters.push({ pred, res: (v) => { clearTimeout(t); res(v); } }); });

    // Synthetic source: agitated 1280x720 canvas @30 + oscillator "system audio".
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; document.body.appendChild(c);
    const cx = c.getContext('2d'); let t = 0;
    setInterval(() => { t++; cx.fillStyle = `hsl(${(t * 3) % 360} 60% 20%)`; cx.fillRect(0, 0, c.width, c.height); for (let i = 0; i < 30; i++) { cx.fillStyle = `hsl(${(i * 37 + t * 5) % 360} 80% 55%)`; cx.fillRect((Math.sin(t / 30 + i) * 0.5 + 0.5) * c.width, (Math.cos(t / 23 + i * 1.3) * 0.5 + 0.5) * c.height, 80, 80); } cx.fillStyle = '#fff'; cx.font = '40px monospace'; cx.fillText(String(t), 30, 60); }, 33);
    const stream = c.captureStream(30);
    const ac = new AudioContext({ sampleRate: 48000 }); const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 220; const g = ac.createGain(); g.gain.value = 0.05; osc.connect(g).connect(dest); osc.start();
    const vtrack = stream.getVideoTracks()[0], atrack = dest.stream.getAudioTracks()[0];
    const vproc = new MediaStreamTrackProcessor({ track: vtrack }); const aproc = new MediaStreamTrackProcessor({ track: atrack });
    const cfg = { preset: { id: '720p30', label: '', maxWidth: 1280, maxHeight: 720, fps: 30, videoBitrate: 3_500_000, audioBitrate: 128_000 }, width: 1280, height: 720, ringMs: 20_000, maxRingBytes: 200 * 1024 * 1024, audioOffsetUs: 40_000, audioCodec: 'mp4a.40.2' };
    w.postMessage({ t: 'arm', cfg, video: vproc.readable, audio: aproc.readable }, [vproc.readable, aproc.readable]);
    const armed = await waitFor(m => m.t === 'armed' || (m.t === 'error' && m.fatal));
    const out = { armed, statuses: [] };
    if (armed.t !== 'armed') { out.log = log; return out; }
    // Buffer for `seconds`; collect statuses.
    await new Promise(r => setTimeout(r, seconds * 1000));
    out.statuses = inbox.filter(m => m.t === 'status').map(m => m.s);
    // Seal the last 6 s.
    w.postMessage({ t: 'seal', clipId: '9f2c1e0a-1234-4abc-8def-0123456789ab', requestedMs: 6000 });
    const sealed = await waitFor(m => m.t === 'sealed' || m.t === 'sealFailed', 30000);
    out.sealed = sealed;
    if (sealed.t === 'sealed') {
        // Post-approval preview through the worker-side MediaSource handle.
        let previewSeq = 0;
        const previewOnce = async (label) => {
            const video = document.createElement('video'); video.muted = true; video.playsInline = true; document.body.appendChild(video);
            const before = inbox.length;
            const seq = ++previewSeq;
            w.postMessage({ t: 'preview', seq });
            const handle = await waitFor(m => inbox.indexOf(m) >= before && m.seq === seq && (m.t === 'previewHandle' || m.t === 'previewFailed'), 15000);
            if (handle.t !== 'previewHandle') return { ready: handle, playback: null };
            video.srcObject = handle.handle;
            const ready = await waitFor(m => inbox.indexOf(m) >= before && m.seq === seq && (m.t === 'previewReady' || m.t === 'previewFailed'), 20000);
            let playback;
            try {
                await video.play(); await new Promise(r => setTimeout(r, 1500));
                playback = { currentTime: video.currentTime, duration: video.duration, readyState: video.readyState, w: video.videoWidth, h: video.videoHeight,
                    buffered0: video.buffered.length ? video.buffered.start(0) : null, bufferedEnd: video.buffered.length ? video.buffered.end(video.buffered.length - 1) : null };
            } catch (e) { playback = { error: e.message }; }
            video.remove();
            return { ready, playback, label };
        };
        out.preview = await previewOnce('full');
        // FRONT trim: cut the first third off and keep to the midpoint. The worker
        // re-muxes the kept range (snapping outward to ~2 s GOPs) so the result's
        // timeline starts at 0 — the property the playback check below proves:
        // a relisted-parts "trim" would buffer [2 s, 4 s) under a 0–2 s manifest
        // and the element would sit at currentTime 0 forever.
        const full = sealed.info;
        const beforeTrim = inbox.length;
        w.postMessage({ t: 'trim', startMs: Math.floor(full.durationMs / 3), endMs: Math.floor(full.durationMs / 2) });
        const trimmed = await waitFor(m => inbox.indexOf(m) >= beforeTrim && (m.t === 'sealed' || m.t === 'trimFailed'), 30000);
        out.trimmed = trimmed;
        if (trimmed.t === 'sealed') out.previewTrimmed = await previewOnce('trimmed');
        // UNDO: cutting too much used to be a one-way door (docs/CLIPS.md) —
        // the pre-trim ciphertext/key were zero-filled the instant the new
        // parts were sealed. Proves the real worker's message-level undo
        // bookkeeping (`undoPoint` in replayWorker.ts), which a unit test
        // against the extracted clipTrim.ts algorithm alone cannot: the kept
        // ciphertext must survive being routed through actual postMessage/
        // structured-clone boundaries and the worker's own state machine,
        // not just a function call, and the restored clip must actually PLAY.
        let undone;
        if (trimmed.t === 'sealed') {
            const beforeUndo = inbox.length;
            w.postMessage({ t: 'undoTrim' });
            undone = await waitFor(m => inbox.indexOf(m) >= beforeUndo && (m.t === 'sealed' || m.t === 'undoFailed'), 30000);
            out.undone = undone;
            if (undone.t === 'sealed') out.previewUndone = await previewOnce('undone');
        }
        // ONE LEVEL, not a history: a SECOND trim must retire the undo point
        // the first trim left behind, so undoing after two trims lands on the
        // state right before the second one — never all the way back to the
        // original. `undone` (above) already restored `sealed` to the full
        // clip, so this starts a fresh two-trim chain from there.
        // Both trims keep from 0 — the start always snaps to the FIRST
        // keyframe (0), which is exact regardless of real GOP timing; only
        // the end varies, so each step's cut is chosen as a fraction of the
        // PREVIOUS duration to reliably keep narrowing (an end-only trim on
        // an already-narrow re-mux, whose kept range holds few keyframes,
        // can otherwise snap right back to a no-op).
        if (undone?.t === 'sealed') {
            const beforeTrim2a = inbox.length;
            w.postMessage({ t: 'trim', startMs: 0, endMs: Math.floor(undone.info.durationMs * 0.55) });
            const trim2a = await waitFor(m => inbox.indexOf(m) >= beforeTrim2a && (m.t === 'sealed' || m.t === 'trimFailed'), 30000);
            out.trim2a = trim2a;
            if (trim2a.t === 'sealed') {
                const beforeTrim2b = inbox.length;
                w.postMessage({ t: 'trim', startMs: 0, endMs: Math.floor(trim2a.info.durationMs * 0.5) });
                const trim2b = await waitFor(m => inbox.indexOf(m) >= beforeTrim2b && (m.t === 'sealed' || m.t === 'trimFailed'), 30000);
                out.trim2b = trim2b;
                if (trim2b.t === 'sealed') {
                    const beforeUndo2 = inbox.length;
                    w.postMessage({ t: 'undoTrim' });
                    const undo2 = await waitFor(m => inbox.indexOf(m) >= beforeUndo2 && (m.t === 'sealed' || m.t === 'undoFailed'), 30000);
                    out.undo2 = undo2;
                }
            }
        }
        // Ring keeps running after a discard.
        w.postMessage({ t: 'discardSeal' });
        await new Promise(r => setTimeout(r, 1500));
        const st = inbox.filter(m => m.t === 'status').map(m => m.s);
        out.afterDiscard = st[st.length - 1];
    }
    w.postMessage({ t: 'wipe' });
    out.wiped = await waitFor(m => m.t === 'wiped', 5000).catch(e => ({ error: e.message }));
    out.log = log.slice(-30);
    return out;
}, { workerUrl: `/assets/${workerFile}`, seconds: 14 });

console.log(JSON.stringify({ armed: result.armed, sealed: result.sealed, preview: result.preview, trimmed: result.trimmed, previewTrimmed: result.previewTrimmed, undone: result.undone, previewUndone: result.previewUndone, trim2a: result.trim2a, trim2b: result.trim2b, undo2: result.undo2, afterDiscard: result.afterDiscard, wiped: result.wiped }, null, 1).slice(0, 4000));
ck(result.armed?.t === 'armed', 'worker arms', `codec=${result.armed?.videoCodec} audio=${result.armed?.audioCodec}`);
ck(result.armed?.audioCodec === 'mp4a.40.2' || result.armed?.audioCodec === 'opus', 'audio encoder configured');
const last = result.statuses?.[result.statuses.length - 1];
ck(!!last && last.bufferedMs >= 8000, 'ring buffers ≥ 8 s within 14 s', `bufferedMs=${last?.bufferedMs} gops=${last?.gops} fps=${last?.fps} kbps=${last?.kbps?.toFixed?.(0)}`);
ck(!!last && last.gops >= 3, 'multiple GOP units closed', `gops=${last?.gops}`);
ck(!!last && last.droppedFrames < 5, 'few dropped frames', `dropped=${last?.droppedFrames}`);
ck(result.sealed?.t === 'sealed', 'seal succeeds', result.sealed?.message ?? '');
ck(result.sealed?.info?.partCount >= 2, 'init part + ≥1 media part', `parts=${result.sealed?.info?.partCount} dur=${result.sealed?.info?.durationMs} leadIn=${result.sealed?.info?.leadInMs}`);
ck(result.sealed?.info?.durationMs >= 5000 && result.sealed?.info?.durationMs <= 9000, 'sealed duration ≈ requested (6 s + lead-in ≤ one GOP)', `dur=${result.sealed?.info?.durationMs}`);
ck(result.sealed?.info?.partDurMs?.[0] === 0 && result.sealed?.info?.partDurMs?.slice(1).every(d => d > 0), 'per-part durations: init=0, media parts >0', JSON.stringify(result.sealed?.info?.partDurMs));
ck(result.preview?.ready?.t === 'previewReady', 'post-approval preview: MSE handle ready (worker-side MediaSource)', result.preview?.ready?.message ?? '');
ck(result.preview?.playback && !result.preview.playback.error && result.preview.playback.readyState >= 2 && result.preview.playback.currentTime > 0.5, 'post-approval preview plays', JSON.stringify(result.preview?.playback));
ck(result.trimmed?.t === 'sealed', 'trim re-seals (worker reports a fresh sealed info)', result.trimmed?.message ?? '');
ck(result.trimmed?.t === 'sealed' && result.trimmed.info.partCount <= result.sealed.info.partCount && result.trimmed.info.durationMs <= result.sealed.info.durationMs, 'trim never lengthens: duration ≤ original, parts ≤ original', `before=${result.sealed?.info?.durationMs}ms/${result.sealed?.info?.partCount}p after=${result.trimmed?.info?.durationMs}ms/${result.trimmed?.info?.partCount}p`);
ck(result.trimmed?.t === 'sealed' && result.trimmed.info.durationMs < result.sealed.info.durationMs - 1000, 'trim actually SHORTENED the clip by more than a second (multi-GOP seal, GOP-granular trim)', `${result.sealed?.info?.durationMs} -> ${result.trimmed?.info?.durationMs}`);
ck(result.trimmed?.t === 'sealed' && result.trimmed.info.partDurMs?.[0] === 0 && result.trimmed.info.partDurMs.slice(1).every(d => d > 0), 'trimmed parts: init=0, media parts >0 (re-indexed contiguously)', JSON.stringify(result.trimmed?.info?.partDurMs));
ck(result.previewTrimmed?.ready?.t === 'previewReady' && result.previewTrimmed?.playback && !result.previewTrimmed.playback.error && result.previewTrimmed.playback.readyState >= 2, 'the TRIMMED clip previews (re-muxed parts decrypt under their new indices)', JSON.stringify(result.previewTrimmed?.playback));
ck(result.previewTrimmed?.playback && result.previewTrimmed.playback.currentTime > 0.5, 'the FRONT-trimmed clip actually PLAYS from 0 (currentTime advanced — a relisted-parts trim stalls at 0)', `currentTime=${result.previewTrimmed?.playback?.currentTime}`);
ck(result.previewTrimmed?.playback && result.previewTrimmed.playback.buffered0 !== null && result.previewTrimmed.playback.buffered0 < 0.1, 'the trimmed clip buffers from t≈0 (timeline re-based, not the original offset)', `buffered=[${result.previewTrimmed?.playback?.buffered0}, ${result.previewTrimmed?.playback?.bufferedEnd}]`);
ck(result.previewTrimmed?.playback && Math.abs((result.previewTrimmed.playback.bufferedEnd ?? 0) - result.trimmed.info.durationMs / 1000) < 0.6, 'buffered end ≈ the trimmed duration', `bufferedEnd=${result.previewTrimmed?.playback?.bufferedEnd} dur=${result.trimmed?.info?.durationMs}`);
ck(result.sealed?.info?.canUndo === false, 'fresh seal reports canUndo=false (nothing trimmed yet)', String(result.sealed?.info?.canUndo));
ck(result.trimmed?.info?.canUndo === true, 'after a real trim, canUndo=true — the pre-trim state is being kept, not zero-filled', String(result.trimmed?.info?.canUndo));
ck(result.undone?.t === 'sealed', 'undoTrim re-seals (worker restores the pre-trim state)', result.undone?.message ?? '');
ck(result.undone?.t === 'sealed' && result.undone.info.durationMs === result.sealed.info.durationMs, 'undo restores the EXACT original duration — cutting too much is no longer a one-way door', `original=${result.sealed?.info?.durationMs} restored=${result.undone?.info?.durationMs}`);
ck(result.undone?.t === 'sealed' && result.undone.info.partCount === result.sealed.info.partCount, 'undo restores the exact original part count', `original=${result.sealed?.info?.partCount} restored=${result.undone?.info?.partCount}`);
ck(result.undone?.info?.canUndo === false, 'after undoing, canUndo=false — one level only, not a history', String(result.undone?.info?.canUndo));
ck(result.previewUndone?.ready?.t === 'previewReady' && result.previewUndone?.playback && !result.previewUndone.playback.error && result.previewUndone.playback.readyState >= 2, 'the UNDONE (restored) clip previews — the kept ciphertext/key survive a real postMessage round trip and still decrypt', JSON.stringify(result.previewUndone?.playback));
ck(result.previewUndone?.playback && result.previewUndone.playback.currentTime > 0.5, 'the restored clip actually PLAYS', `currentTime=${result.previewUndone?.playback?.currentTime}`);
ck(result.previewUndone?.playback && Math.abs((result.previewUndone.playback.bufferedEnd ?? 0) - result.sealed.info.durationMs / 1000) < 0.6, 'restored clip buffers the FULL original duration, not the trimmed one', `bufferedEnd=${result.previewUndone?.playback?.bufferedEnd} dur=${result.sealed?.info?.durationMs}`);
// ONE LEVEL OF UNDO, not a history: trim, trim again, then undo ONCE — must
// land on the state right before the SECOND trim, never further back.
ck(result.trim2a?.t === 'sealed' && result.trim2b?.t === 'sealed', 'two trims in a row both succeed', `${result.trim2a?.message ?? ''} ${result.trim2b?.message ?? ''}`);
ck(result.trim2a?.t === 'sealed' && result.undone?.t === 'sealed' && result.trim2a.info.durationMs < result.undone.info.durationMs - 1500, 'the FIRST of the two trims actually narrowed (distinguishable from the original)', `original=${result.undone?.info?.durationMs} trim1=${result.trim2a?.info?.durationMs}`);
ck(result.trim2b?.t === 'sealed' && result.trim2a?.t === 'sealed' && result.trim2b.info.durationMs < result.trim2a.info.durationMs - 500, 'the second trim actually narrowed further (distinguishable from the first)', `trim1=${result.trim2a?.info?.durationMs} trim2=${result.trim2b?.info?.durationMs}`);
ck(result.undo2?.t === 'sealed', 'undo after two trims re-seals', result.undo2?.message ?? '');
ck(result.undo2?.t === 'sealed' && result.trim2a?.t === 'sealed' && result.undo2.info.durationMs === result.trim2a.info.durationMs, 'undoing ONCE after two trims restores the state right before the SECOND trim — proves the first undo point was retired, not accumulated', `expected(trim1)=${result.trim2a?.info?.durationMs} got=${result.undo2?.info?.durationMs}`);
ck(result.undo2?.t === 'sealed' && result.undone?.t === 'sealed' && result.undo2.info.durationMs !== result.undone.info.durationMs, 'and it does NOT go all the way back to the original full clip (that would mean undo accumulated a full history instead of one level)', `original=${result.undone?.info?.durationMs} got=${result.undo2?.info?.durationMs}`);
ck(result.undo2?.info?.canUndo === false, 'after the second undo, canUndo=false again', String(result.undo2?.info?.canUndo));
ck(!!result.afterDiscard && result.afterDiscard.bufferedMs > 0, 'ring keeps running after discardSeal', `bufferedMs=${result.afterDiscard?.bufferedMs}`);
ck(result.wiped?.t === 'wiped', 'wipe acknowledged');

// ---- Scenario 2: native (no-picker) video ingestion -------------------------
// Proves clip_capture.rs's contract end to end WITHOUT the Rust side: a real
// VideoEncoder emitting Annex-B (avc:{format:'annexb'}) stands in for the
// native H264Encoder's output (byte-for-byte the same format mediabunny
// consumes either way), fed to the worker as `nativeVideoChunk` messages the
// way replayBuffer.ts's postNativeVideoChunk() sends them (armNative also
// queues chunks until its arm post - not modelled here; the worker-side
// pendingNative parking IS exercised implicitly, since chunks race arm()'s
// awaits). Proves: the worker reports 'armed' only once a chunk carries a
// codec string - INCLUDING when the first keyframe was lost (dropped on
// purpose below; the codec re-rides every keyframe, so the session heals) -
// GOPs close on native keyframes, and the clip seals and previews normally.
const nativeResult = await page.evaluate(async ({ workerUrl, seconds }) => {
    const log = [];
    const w = new Worker(workerUrl, { type: 'module' });
    const inbox = [];
    const waiters = [];
    w.onmessage = (ev) => { inbox.push(ev.data); log.push(ev.data.t); for (const wt of [...waiters]) { if (wt.pred(ev.data)) { waiters.splice(waiters.indexOf(wt), 1); wt.res(ev.data); } } };
    w.onerror = (e) => { log.push('WORKER ERROR ' + e.message); };
    const waitFor = (pred, ms = 20000) => new Promise((res, rej) => { const hit = inbox.find(pred); if (hit) return res(hit); const t = setTimeout(() => { waiters.splice(waiters.findIndex(x => x.res === res), 1); rej(new Error('timeout waiting; log=' + log.slice(-12).join(','))); }, ms); waiters.push({ pred, res: (v) => { clearTimeout(t); res(v); } }); });

    const c = document.createElement('canvas'); c.width = 640; c.height = 360; document.body.appendChild(c);
    const cx = c.getContext('2d'); let t = 0;
    const paint = () => { t++; cx.fillStyle = `hsl(${(t * 7) % 360} 60% 20%)`; cx.fillRect(0, 0, c.width, c.height); cx.fillStyle = '#fff'; cx.font = '30px monospace'; cx.fillText(String(t), 10, 40); };
    const timer = setInterval(paint, 33);
    const stream = c.captureStream(30);
    const vtrack = stream.getVideoTracks()[0];

    const ac = new AudioContext({ sampleRate: 48000 }); const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator(); osc.type = 'square'; osc.frequency.value = 330; const g = ac.createGain(); g.gain.value = 0.05; osc.connect(g).connect(dest); osc.start();
    const aproc = new MediaStreamTrackProcessor({ track: dest.stream.getAudioTracks()[0] });

    const cfg = {
        preset: { id: '720p30', label: '', maxWidth: 640, maxHeight: 360, fps: 30, videoBitrate: 2_000_000, audioBitrate: 128_000 },
        width: 640, height: 360, ringMs: 20_000, maxRingBytes: 200 * 1024 * 1024, audioOffsetUs: 40_000, audioCodec: 'mp4a.40.2',
        nativeVideo: { fps: 30 },
    };
    w.postMessage({ t: 'arm', cfg, video: null, audio: aproc.readable }, [aproc.readable]);

    // Encode `seconds` of Annex-B chunks - a real H.264 encoder asked for
    // Annex-B output, standing in for clip_capture.rs's H264Encoder. Matches
    // its CURRENT contract: the codec string rides on EVERY keyframe (the
    // Rust side re-derives it from each keyframe's SPS so chunk loss is
    // self-healing) - and this scenario PROVES that self-healing by
    // deliberately dropping the first keyframe (never posting it): the
    // worker must still arm from keyframe 2's codec, open its first GOP
    // there, and seal/preview normally. Under the old one-shot-codec
    // behaviour this scenario hangs at 'arming' forever and goes red.
    let codecStr = null;
    let droppedFirstKey = false;
    let lastKeyUs = -2_000_000;
    const enc = new VideoEncoder({
        output: (chunk, meta) => {
            if (meta?.decoderConfig?.codec) codecStr = meta.decoderConfig.codec;
            if (chunk.type === 'key' && !droppedFirstKey) { droppedFirstKey = true; return; } // simulate the arm-races-audio-init chunk loss
            const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
            const codec = chunk.type === 'key' ? (codecStr ?? 'avc1.42001f') : undefined;
            w.postMessage({ t: 'nativeVideoChunk', keyframe: chunk.type === 'key', tsUs: chunk.timestamp, durUs: chunk.duration ?? 33333, bytes: buf.buffer, codec, codedWidth: 640, codedHeight: 360 }, [buf.buffer]);
        },
        error: (e) => log.push('ENCODER ERROR ' + e.message),
    });
    enc.configure({ codec: 'avc1.42001f', width: 640, height: 360, framerate: 30, bitrate: 2_000_000, avc: { format: 'annexb' } });
    const track = new MediaStreamTrackProcessor({ track: vtrack });
    const reader = track.readable.getReader();
    const start = performance.now();
    (async () => {
        for (;;) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            const tsUs = Math.round((performance.now() - start) * 1000);
            const key = tsUs - lastKeyUs >= 2_000_000;
            if (key) lastKeyUs = tsUs;
            try { enc.encode(frame, { keyFrame: key }); } finally { frame.close(); }
        }
    })();

    const armed = await waitFor(m => m.t === 'armed' || (m.t === 'error' && m.fatal));
    const out = { armed };
    if (armed.t !== 'armed') { clearInterval(timer); out.log = log; return out; }
    await new Promise(r => setTimeout(r, seconds * 1000));
    const statuses = inbox.filter(m => m.t === 'status').map(m => m.s);
    out.lastStatus = statuses[statuses.length - 1];

    w.postMessage({ t: 'seal', clipId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', requestedMs: 6000 });
    const sealed = await waitFor(m => m.t === 'sealed' || m.t === 'sealFailed', 20000);
    out.sealed = sealed;
    if (sealed.t === 'sealed') {
        const video = document.createElement('video'); video.muted = true; video.playsInline = true; document.body.appendChild(video);
        w.postMessage({ t: 'preview', seq: 1 });
        const handle = await waitFor(m => m.t === 'previewHandle' || m.t === 'previewFailed', 15000);
        if (handle.t === 'previewHandle') {
            video.srcObject = handle.handle;
            const ready = await waitFor(m => m.t === 'previewReady' || m.t === 'previewFailed', 20000);
            out.previewReady = ready.t;
            try { await video.play(); await new Promise(r => setTimeout(r, 1200)); out.playback = { currentTime: video.currentTime, readyState: video.readyState, w: video.videoWidth, h: video.videoHeight }; } catch (e) { out.playback = { error: e.message }; }
        } else {
            out.previewReady = handle.t;
        }
    }
    clearInterval(timer);
    w.postMessage({ t: 'wipe' });
    out.wiped = await waitFor(m => m.t === 'wiped', 5000).catch(e => ({ error: e.message }));
    out.log = log.slice(-20);
    return out;
}, { workerUrl: `/assets/${workerFile}`, seconds: 10 });

console.log(JSON.stringify({ armed: nativeResult.armed, lastStatus: nativeResult.lastStatus, sealed: nativeResult.sealed?.t, previewReady: nativeResult.previewReady, playback: nativeResult.playback, wiped: nativeResult.wiped, log: nativeResult.log }, null, 1).slice(0, 3000));
ck(nativeResult.armed?.t === 'armed', 'native: worker arms even though the FIRST keyframe was lost (codec re-rides every keyframe - the self-healing 9134874 exists for)', `videoCodec=${nativeResult.armed?.videoCodec}`);
ck(!!nativeResult.armed?.videoCodec && nativeResult.armed.videoCodec.startsWith('avc1.'), 'native: the reported codec is the SPS-derived string, not a guess', String(nativeResult.armed?.videoCodec));
ck(!!nativeResult.lastStatus && nativeResult.lastStatus.gops >= 2, 'native: multiple GOPs closed from nativeVideoChunk keyframes', `gops=${nativeResult.lastStatus?.gops}`);
ck(nativeResult.sealed?.t === 'sealed', 'native: seal succeeds on natively-ingested chunks', nativeResult.sealed?.message ?? '');
ck(nativeResult.sealed?.t === 'sealed' && nativeResult.sealed.info.partCount >= 2, 'native: init part + >=1 media part', `parts=${nativeResult.sealed?.info?.partCount}`);
ck(nativeResult.previewReady === 'previewReady', 'native: post-approval preview plays the natively-ingested clip', nativeResult.previewReady ?? '');
ck(!!nativeResult.playback && !nativeResult.playback.error && nativeResult.playback.readyState >= 2 && nativeResult.playback.currentTime > 0.3, 'native: preview actually advances (real playable video, not just a container)', JSON.stringify(nativeResult.playback));
ck(nativeResult.wiped?.t === 'wiped', 'native: wipe acknowledged');

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close();
srv.close();
process.exit(fail ? 1 : 0);
