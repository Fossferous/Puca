// WHAT DOES A SCREEN SHARE COST, WHAT DOES AN ARMED CLIP BUFFER COST, AND
// WHAT DO THEY COST TOGETHER? (docs/CLIPS.md, "Sharing while armed")
//
// THE QUESTION. Sharing the screen with Clips armed ran two pipelines on the
// desktop app: the share (getDisplayMedia, encoded by WebRTC: VP8 in software
// on a mesh call, H.264 on the GPU on an SFU call) and the clip buffer (the
// auto arm's DXGI capture + hardware H.264 in the agent, or the manual arm's
// second getDisplayMedia + WebCodecs H.264 in a worker). "It uses double the
// CPU" is a claim about where the cost goes, and this measures it, per
// process tree, instead of guessing.
//
// WHAT IT MEASURES. Each case runs in a FRESH headless Edge (the WebView2
// engine; same major version on the machine it was written on) and, for the
// native arm, the agent's own `--clip-capture` host, for WINDOW_S seconds
// after a warm-up. The CPU of each process tree is read from Windows itself
// (Win32_Process kernel + user time, as % of ONE core), dwm.exe separately
// (screen capture costs the compositor too), and the GPU engines each tree
// used (\GPU Engine counters). Nothing is saved: frames are encoded and
// dropped, the clip ring is the real replay worker's (sealed, in memory),
// and no window is opened anywhere.
//
// THE CASES.
//   idle            the browser with a blank page (the floor everything sits on)
//   capture         getDisplayMedia of the monitor at the share size, drained
//   mesh1 / mesh2   that capture sent to 1 / 2 viewers as VP8 (a mesh call
//                   gives every viewer their own encoder), each frame through
//                   an AES-GCM sender transform like frameCrypto.ts's
//   sfu             that capture as H.264 High simulcast f/h/q (the owner's
//                   1080p share: 1920x1080, 1280x720, 640x360), AES-GCM too
//   manual          the manual arm: its own getDisplayMedia at the clip preset,
//                   the real replayWorker (WebCodecs H.264, sealed GOPs)
//   native          the auto arm: the agent's --clip-capture host (DXGI + MFT
//                   H.264 at the monitor's size) feeding the real replayWorker
//                   through the same nativeVideoChunk message the app sends
//   agentonly       the agent alone, its frames counted and dropped here (the
//                   control for what the ring's page-side ingest costs)
//   mesh1+native, sfu+native, mesh1+manual, sfu+manual: both at once
//   sfu+follow, mesh1+follow: the manual arm's ring reading a CLONE of the
//                   share's capture instead of a getDisplayMedia of its own
//   capture+capture2, capture+captureclone: a SECOND capture of the same
//                   surface, drained, against a clone of the first. Chromium
//                   runs ONE capturer for every capture of one screen (its
//                   VideoCaptureManager shares the device), so the two cost the
//                   same: a hand-armed clip buffer and a share of the same
//                   screen were never two captures (docs/CLIPS.md, "Sharing
//                   while armed")
//
// Every receiving end DROPS its frames in a receiver transform, so no decode
// lands in the measured tree: only what the sharer's machine pays.
//
// Usage (from frontend/, after `npx vite build` for dist/assets/replayWorker-*.js):
//   node e2e/clip-share-cpu-measure.mjs
//   AGENT=<path to puca-agent.exe> CASES=idle,mesh1,native,mesh1+native node e2e/clip-share-cpu-measure.mjs
//   WINDOW_S=30 SHARE=1440p30 SOURCE=pan node e2e/clip-share-cpu-measure.mjs
//   ADAPTER_LUID=<high>,<low> ...   put the browser on another GPU (the app's
//                                   WebView2 may be pinned to an integrated one)
//
// SOURCE=screen (default) captures a real monitor through getDisplayMedia,
// whose content decides what VP8 costs: a still desktop is nearly free to
// encode. Headless Edge takes the FIRST screen Chromium lists whatever
// --auto-select-desktop-capture-source names, so on a multi-monitor desk that
// may not be the primary; the line printed per case says what size it got.
// SOURCE=pan draws e2e/encode-cost.mjs's fast-motion picture on a canvas and
// shares canvas.captureStream() of it: reproducible, closer to a game, and
// with no desktop capture in it at all (its drawing cost is the `idle` case's
// floor under SOURCE=pan). SOURCE=tab draws the same picture full page and
// captures the TAB with getDisplayMedia (--auto-accept-this-tab-capture): a
// real Chromium capture, one per call, of a surface that never stops moving,
// which is what makes a SECOND capture's cost visible (the real screen is
// often still, and Chromium does little for a still screen).
//
// READ THE RESULT ON THIS MACHINE ONLY, AND AS DIFFERENCES. A case's CPU minus
// the floor case's is what that pipeline costs here.
import { chromium } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const WINDOW_S = Number(process.env.WINDOW_S || 20);
const WARM_S = Number(process.env.WARM_S || 6);
const SOURCE = process.env.SOURCE || 'screen';
const AGENT = process.env.AGENT || '';
const SHARES = { '1080p30': { w: 1920, h: 1080, fps: 30, kbps: 6000 }, '1440p30': { w: 2560, h: 1440, fps: 30, kbps: 10000 }, '1080p60': { w: 1920, h: 1080, fps: 60, kbps: 10000 } };
const SHARE = SHARES[process.env.SHARE || '1080p30'];
// The clip preset (manual arm): Settings' default, 1080p30 at 6 Mbps.
const CLIP = { id: '1080p30', label: '1080p30', maxWidth: 1920, maxHeight: 1080, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 };
const ALL = ['idle', 'capture', 'capture+capture2', 'capture+captureclone', 'mesh1', 'mesh2', 'sfu', 'manual', 'native', 'mesh1+native', 'sfu+native', 'mesh1+manual', 'sfu+manual', 'mesh1+follow', 'sfu+follow'];
const CASES = process.env.CASES ? process.env.CASES.split(',') : ALL;

const workerFile = fs.existsSync(path.join(dist, 'assets')) && fs.readdirSync(path.join(dist, 'assets')).find((f) => /^replayWorker-.*\.js$/.test(f));
if (CASES.some((c) => /manual|native|follow|agentonly/.test(c)) && !workerFile) {
    console.error('no replayWorker bundle in dist/assets: run `npx vite build` first');
    process.exit(2);
}
if (CASES.some((c) => /native|agentonly/.test(c)) && !AGENT) {
    console.error('the native cases need AGENT=<path to puca-agent.exe>');
    process.exit(2);
}

// ---- the page server, and the agent's chunks streamed to the page ----------
let chunkSink = null; // the /chunks response while a native case runs
const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta charset="utf-8"><title>clip-share-cpu</title><body style="margin:0;background:#000"></body>');
        return;
    }
    if (u.pathname === '/chunks') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
        chunkSink = res;
        req.on('close', () => { if (chunkSink === res) chunkSink = null; });
        return;
    }
    const p = path.join(dist, u.pathname);
    if (!p.startsWith(dist) || !fs.existsSync(p)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${srv.address().port}/`;

// ---- Windows' own accounting -------------------------------------------------
const ps = (script) => new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => {
        if (err) reject(err); else resolve(out);
    });
});
/** Every process: pid, parent, name, CPU time (100 ns), creation time
 *  (ticks), and whether its command line carries `marker`. One snapshot. */
async function snapshot(marker) {
    const out = await ps(`$m='${marker}'; $t=[DateTime]::UtcNow.Ticks; $p=Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=$_.ProcessId;q=$_.ParentProcessId;n=$_.Name;t=[double]$_.KernelModeTime+[double]$_.UserModeTime;c=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks } else { 0 });m=[bool]($_.CommandLine -and $_.CommandLine.Contains($m))} }; [pscustomobject]@{at=$t;procs=$p} | ConvertTo-Json -Compress -Depth 3`);
    const j = JSON.parse(out);
    return { at: j.at / 1e4, procs: j.procs };
}
/** The pids of a process tree: the roots and everything created under them.
 *
 *  `marked`: take the processes whose command line carried the snapshot's
 *  marker as roots (the browser); `extraRoots`: these pids (the agent).
 *  The first version of this took the marked processes as roots for EVERY
 *  tree, so the agent's "tree" was the agent plus the whole browser: its
 *  column read 30-90% beside a share while its own threads never moved
 *  from ~15%. A child also has to be younger than its parent: Windows
 *  reuses pids, and an orphan keeps its dead parent's id. */
function treeOf(snap, marked, extraRoots = []) {
    const kids = new Map();
    const born = new Map(snap.procs.map((p) => [p.p, p.c ?? 0]));
    for (const p of snap.procs) { if (!kids.has(p.q)) kids.set(p.q, []); kids.get(p.q).push(p.p); }
    const roots = (marked ? snap.procs.filter((p) => p.m).map((p) => p.p) : []).concat(extraRoots);
    const out = new Set();
    const walk = (pid) => {
        if (out.has(pid)) return;
        out.add(pid);
        for (const k of kids.get(pid) ?? []) if ((born.get(k) ?? 0) >= (born.get(pid) ?? 0)) walk(k);
    };
    roots.forEach(walk);
    return out;
}
/** One process's threads: id -> CPU ms and start time (ticks). */
async function agentThreads(pid) {
    const out = await ps(`$p=Get-Process -Id ${pid}; $p.Threads | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalMilliseconds) $($_.StartTime.Ticks)" }`).catch(() => '');
    const m = new Map();
    for (const l of out.trim().split(/\r?\n/)) { const p = l.trim().split(/\s+/); if (p.length === 3) m.set(p[0], { ms: Number(p[1]), start: Number(p[2]) }); }
    return { m, at: Date.now() };
}
const cpuMs = (snap, pids) => snap.procs.filter((p) => pids.has(p.p)).reduce((s, p) => s + p.t / 1e4, 0);
const byName = (snap, name) => new Set(snap.procs.filter((p) => p.n.toLowerCase() === name).map((p) => p.p));

/** GPU engine utilisation per pid and engine type over the window: the mean
 *  of `samples` readings `every` seconds apart. */
async function gpuSample(samples, every) {
    const out = await ps(`Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval ${every} -MaxSamples ${samples} -ErrorAction SilentlyContinue | ForEach-Object { $_.CounterSamples | Where-Object { $_.CookedValue -gt 0 } | ForEach-Object { $_.InstanceName + '=' + $_.CookedValue } }`).catch(() => '');
    const acc = new Map(); // `${pid}|${luidLow}|${engtype}` -> sum
    for (const line of out.split(/\r?\n/)) {
        const m = /^pid_(\d+)_luid_0x[0-9a-f]+_0x([0-9a-f]+)_phys_\d+_eng_\d+_engtype_([^=]+)=([\d.]+)/i.exec(line.trim());
        if (!m) continue;
        const k = `${m[1]}|${m[2].toLowerCase()}|${m[3]}`;
        acc.set(k, (acc.get(k) ?? 0) + Number(m[4]) / samples);
    }
    return acc;
}
function gpuFor(acc, pids, names) {
    const sums = new Map();
    for (const [k, v] of acc) {
        const [pid, luid, eng] = k.split('|');
        if (!pids.has(Number(pid))) continue;
        const label = `${eng}@${names[luid] ?? luid}`;
        sums.set(label, (sums.get(label) ?? 0) + v);
    }
    return [...sums].filter(([, v]) => v >= 0.1).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(1)}%`).join(', ') || '-';
}
/** The counters name adapters only by LUID (low part, hex); a run prints
 *  those as they are. */
const gpuNames = {};

// ---- the browser side --------------------------------------------------------
async function launch(id) {
    const args = [
        '--mute-audio', // nothing here plays sound; this makes sure of it
        '--autoplay-policy=no-user-gesture-required',
        '--auto-select-desktop-capture-source=Entire screen',
        '--use-fake-ui-for-media-stream',
        '--auto-accept-this-tab-capture',
        '--ignore-gpu-blocklist', '--use-angle=d3d11',
        `--puca-measure=${id}`, // the marker the process walk finds the tree by
    ];
    if (process.env.ADAPTER_LUID) args.push(`--use-adapter-luid=${process.env.ADAPTER_LUID}`);
    const browser = await chromium.launch({ headless: true, channel: process.env.CHANNEL || 'msedge', args });
    const page = await browser.newPage({ viewport: { width: SHARE.w, height: SHARE.h } });
    page.on('pageerror', (e) => console.log('  X>', String(e).slice(0, 300)));
    page.on('console', (m) => { const t = m.text(); if (/^\[measure\]/.test(t)) console.log('  ', t); });
    await page.goto(origin);
    await page.evaluate(installRig, { SOURCE, SHARE, CLIP, workerUrl: workerFile ? `/assets/${workerFile}` : null });
    return { browser, page };
}

/** Runs IN THE PAGE: the pieces every case is built from, on `window.rig`. */
function installRig({ SOURCE, SHARE, CLIP, workerUrl }) {
    const rig = { closers: [], stats: {} };
    window.rig = rig;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // e2e/encode-cost.mjs's 'pan' picture, drawn into the page itself so a
    // tab capture of it is a reproducible fast-motion source.
    rig.startPan = () => {
        const { w, h, fps } = SHARE;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h; canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        const tex = document.createElement('canvas'); tex.width = w * 2; tex.height = h * 2;
        const t = tex.getContext('2d');
        let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        t.fillStyle = '#3a5f2a'; t.fillRect(0, 0, tex.width, tex.height);
        for (let i = 0; i < 60; i++) {
            const x = rnd() * tex.width, y = rnd() * tex.height, r = (0.05 + rnd() * 0.2) * tex.width;
            const g = t.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, `hsl(${rnd() * 360} ${30 + rnd() * 40}% ${30 + rnd() * 40}%)`); g.addColorStop(1, 'transparent');
            t.fillStyle = g; t.fillRect(x - r, y - r, 2 * r, 2 * r);
        }
        for (let i = 0; i < (tex.width * tex.height) / 2500; i++) {
            const s = 3 + rnd() * 36;
            t.fillStyle = `hsl(${80 + rnd() * 60} ${30 + rnd() * 50}% ${20 + rnd() * 45}%)`;
            t.fillRect(rnd() * tex.width, rnd() * tex.height, s, s * (0.3 + rnd()));
        }
        t.font = `${Math.round(h / 40)}px sans-serif`;
        for (let i = 0; i < 400; i++) { t.fillStyle = `hsl(${rnd() * 360} 80% ${50 + rnd() * 40}%)`; t.fillText('PUCA 0123456789 encode', rnd() * tex.width, rnd() * tex.height); }
        const movers = Array.from({ length: 24 }, (_, i) => ({ x: (i * 211) % w, y: (i * 97) % h, vx: (i % 2 ? 1 : -1) * w * (0.3 + (i % 5) / 6), vy: h * ((i % 3) - 1) * 0.2, r: h / 30 + (i % 4) * h / 60 }));
        let frame = 0;
        const timer = setInterval(() => {
            frame++;
            const sec = frame / fps;
            ctx.drawImage(tex, (sec * w * 0.5) % w, (Math.sin(sec * 1.3) * 0.5 + 0.5) * h * 0.9, w, h, 0, 0, w, h);
            for (const m of movers) {
                const x = ((m.x + m.vx * sec) % w + w) % w, y = ((m.y + m.vy * sec) % h + h) % h;
                ctx.fillStyle = '#f4f4f4'; ctx.beginPath(); ctx.arc(x, y, m.r, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#c0182a'; ctx.fillRect(x - m.r / 2, y - m.r / 4, m.r, m.r / 2);
            }
        }, 1000 / fps);
        rig.closers.push(() => clearInterval(timer));
    };

    /** A display capture the way the app asks for one (shareVideoConstraints).
     *  SOURCE=pan: a capture of the pan canvas instead (canvas.captureStream,
     *  one per call, as the app makes one getDisplayMedia per pipeline). */
    rig.capture = async ({ w, h, fps }) => {
        let track;
        if (SOURCE === 'tab') {
            // A real Chromium capture (tab capture: the compositor's frames
            // read back and converted, one capture per call) of a page that
            // draws the pan picture full screen: the second capture's cost on
            // a surface that is never still.
            const s = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: w }, height: { max: h }, frameRate: { max: fps } }, audio: false, preferCurrentTab: true });
            track = s.getVideoTracks()[0];
        } else if (SOURCE === 'pan') {
            track = document.querySelector('canvas').captureStream(fps).getVideoTracks()[0];
            if (w < SHARE.w || h < SHARE.h) await track.applyConstraints({ width: { max: w }, height: { max: h } }).catch(() => {});
        } else {
            const s = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: w }, height: { max: h }, frameRate: { max: fps } }, audio: false });
            track = s.getVideoTracks()[0];
        }
        try { track.contentHint = 'motion'; } catch { /* old engine */ }
        rig.closers.push(() => track.stop());
        return track;
    };

    rig.drain = (track) => {
        const r = new MediaStreamTrackProcessor({ track }).readable.getReader();
        let n = 0; rig.stats.drained = () => n;
        (async () => { for (;;) { const { value, done } = await r.read(); if (done) return; n++; value.close(); } })();
    };

    // An AES-GCM sender transform with frameCrypto.ts's shape: the codec's
    // clear header, the rest sealed, iv + magic appended. Cost, not format:
    // nothing here has to be opened again.
    const keyP = crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const sealTransform = (onFrame) => new TransformStream({
        async transform(frame, ctl) {
            const key = await keyP;
            const data = new Uint8Array(frame.data);
            onFrame?.(frame, data);
            const clear = frame.type === 'key' ? 10 : 3;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data.subarray(clear)));
            const out = new Uint8Array(clear + ct.length + 16);
            out.set(data.subarray(0, clear)); out.set(ct, clear); out.set(iv, clear + ct.length); out.set([0x53, 0x56, 0x52, 0x4e], clear + ct.length + 12);
            frame.data = out.buffer;
            ctl.enqueue(frame);
        },
    });
    const dropAll = new TransformStream({ transform() { /* the receiver decodes nothing */ } });

    const munge = (sdp, kbps) => {
        let out = sdp;
        for (const m of sdp.matchAll(/^a=rtpmap:(\d+) (VP8|H264)\/90000/gm)) {
            const pt = m[1];
            const fmtp = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
            out = fmtp.test(out) ? out.replace(fmtp, `a=fmtp:${pt} $1;x-google-start-bitrate=${kbps}`) : out.replace(new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'), `$1\r\na=fmtp:${pt} x-google-start-bitrate=${kbps}`);
        }
        return out;
    };
    const hwFirst = (codecs) => {
        const prof = (c) => /profile-level-id=([0-9a-f]{6})/i.exec(c.sdpFmtpLine ?? '')?.[1]?.toLowerCase() ?? '';
        const pm = (c) => /packetization-mode=(\d)/.exec(c.sdpFmtpLine ?? '')?.[1] ?? '0';
        const rank = (c) => (c.mimeType === 'video/H264' && pm(c) === '1' && prof(c).slice(2, 4) === '00' ? ({ 64: 0, '4d': 1, 42: 2 })[prof(c).slice(0, 2)] ?? null : null);
        const r = codecs.map((c, i) => ({ c, i, r: rank(c) }));
        return [...r.filter((x) => x.r !== null).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c), ...r.filter((x) => x.r === null).map((x) => x.c)];
    };

    /** One viewer of a mesh share: its own pc, so its own VP8 encoder. */
    rig.meshViewer = async (track, onFrame) => {
        const pc1 = new RTCPeerConnection({ encodedInsertableStreams: true });
        const pc2 = new RTCPeerConnection({ encodedInsertableStreams: true });
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        pc2.ontrack = (e) => { const s = e.receiver.createEncodedStreams(); s.readable.pipeThrough(new TransformStream({ transform() {} })).pipeTo(s.writable); };
        const tr = pc1.addTransceiver(track, { direction: 'sendonly' });
        const caps = RTCRtpSender.getCapabilities('video').codecs;
        tr.setCodecPreferences([...caps.filter((c) => c.mimeType === 'video/VP8'), ...caps.filter((c) => c.mimeType !== 'video/VP8')]);
        const s = tr.sender.createEncodedStreams();
        s.readable.pipeThrough(sealTransform(onFrame)).pipeTo(s.writable);
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription({ type: 'offer', sdp: munge(offer.sdp, 8000) });
        await pc2.setRemoteDescription(pc1.localDescription);
        const ans = await pc2.createAnswer();
        await pc2.setLocalDescription(ans);
        await pc1.setRemoteDescription({ type: 'answer', sdp: munge(ans.sdp, 8000) });
        // The app's mesh tuning (manager.ts tuneScreenShareSender).
        const p = tr.sender.getParameters();
        p.encodings[0].maxBitrate = 8_000_000; p.degradationPreference = 'maintain-framerate';
        await tr.sender.setParameters(p);
        rig.closers.push(() => { pc1.close(); pc2.close(); });
        (rig.senders ??= []).push(pc1);
        return { pc: pc1, sender: tr.sender };
    };

    /** The SFU share: H.264 High first, simulcast f/h/q, the owner's ladder. */
    rig.sfuShare = async (track, onFrame) => {
        const pc1 = new RTCPeerConnection({ encodedInsertableStreams: true });
        const pc2 = new RTCPeerConnection({ encodedInsertableStreams: true });
        pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
        pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
        pc2.ontrack = (e) => { const s = e.receiver.createEncodedStreams(); s.readable.pipeThrough(new TransformStream({ transform() {} })).pipeTo(s.writable); };
        const sh = track.getSettings().height || SHARE.h;
        const tr = pc1.addTransceiver(track, {
            direction: 'sendonly',
            sendEncodings: [
                { rid: 'q', scaleResolutionDownBy: sh / 360, maxBitrate: 500_000 },
                { rid: 'h', scaleResolutionDownBy: sh / 720, maxBitrate: 2_500_000 },
                { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: SHARE.kbps * 1000 },
            ],
        });
        tr.setCodecPreferences(hwFirst(RTCRtpSender.getCapabilities('video').codecs));
        const s = tr.sender.createEncodedStreams();
        s.readable.pipeThrough(sealTransform(onFrame)).pipeTo(s.writable);
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription({ type: 'offer', sdp: munge(offer.sdp, 9000) });
        await pc2.setRemoteDescription(pc1.localDescription);
        const ans = await pc2.createAnswer();
        await pc2.setLocalDescription(ans);
        let a = munge(ans.sdp, 9000);
        const rids = [...offer.sdp.matchAll(/^a=rid:(\w+) send/gm)].map((m) => m[1]);
        if (rids.length > 1 && !/a=simulcast:/.test(a)) a = a.replace(/(a=mid:\d+\r\n)/, `$1${rids.map((r) => `a=rid:${r} recv`).join('\r\n')}\r\na=simulcast:recv ${rids.join(';')}\r\n`);
        await pc1.setRemoteDescription({ type: 'answer', sdp: a });
        rig.closers.push(() => { pc1.close(); pc2.close(); });
        (rig.senders ??= []).push(pc1);
        return { pc: pc1, sender: tr.sender };
    };

    rig.encoders = async () => {
        const out = [];
        for (const pc of rig.senders ?? []) {
            (await pc.getStats()).forEach((r) => {
                if (r.type === 'outbound-rtp' && r.kind === 'video') out.push({ rid: r.rid, enc: r.encoderImplementation, size: `${r.frameWidth}x${r.frameHeight}`, frames: r.framesEncoded, limit: r.qualityLimitationReason, bytes: r.bytesSent });
            });
        }
        return out;
    };

    // ---- the real replay worker ----
    rig.worker = () => {
        const w = new Worker(workerUrl, { type: 'module' });
        const inbox = [];
        w.onmessage = (ev) => { inbox.push(ev.data); if (ev.data.t === 'status') rig.stats.ring = ev.data.s; };
        rig.closers.push(() => { try { w.postMessage({ t: 'wipe' }); } catch { /* gone */ } setTimeout(() => w.terminate(), 500); });
        return { w, inbox };
    };
    const ringCfg = (preset, width, height, extra) => ({ preset, width, height, ringMs: 120_000, maxRingBytes: 512 * 1024 * 1024, audioOffsetUs: 0, audioCodec: 'mp4a.40.2', verbose: false, ...extra });

    /** The manual arm: its own getDisplayMedia, MSTP into the worker. */
    rig.manualArm = async () => {
        const track = await rig.capture({ w: CLIP.maxWidth, h: CLIP.maxHeight, fps: CLIP.fps });
        const vs = track.getSettings();
        const { w } = rig.worker();
        const readable = new MediaStreamTrackProcessor({ track }).readable;
        w.postMessage({ t: 'arm', cfg: ringCfg(CLIP, vs.width, vs.height), video: readable, audio: null }, [readable]);
    };

    /** The manual arm's ring reading a clone of the share's capture instead
     *  of a getDisplayMedia of its own: the same worker and preset. */
    rig.followArm = async () => {
        const track = rig.shareTrack.clone();
        await track.applyConstraints({ width: { max: CLIP.maxWidth }, height: { max: CLIP.maxHeight }, frameRate: { max: CLIP.fps } }).catch(() => {});
        rig.closers.push(() => track.stop());
        const first = await new Promise((resolve) => {
            const r = new MediaStreamTrackProcessor({ track: track.clone() }).readable.getReader();
            r.read().then(({ value }) => { resolve(value ? [value.codedWidth, value.codedHeight] : [CLIP.maxWidth, CLIP.maxHeight]); value?.close(); r.cancel(); });
        });
        const { w } = rig.worker();
        const readable = new MediaStreamTrackProcessor({ track }).readable;
        w.postMessage({ t: 'arm', cfg: ringCfg(CLIP, first[0], first[1]), video: readable, audio: null }, [readable]);
    };

    /** The native arm's page half: records from the agent, as nativeVideoChunk. */
    rig.nativeArm = async ({ width, height, fps, bitrate }) => {
        const { w } = rig.worker();
        w.postMessage({ t: 'arm', cfg: ringCfg({ ...CLIP, videoBitrate: bitrate }, width, height, { nativeVideo: { fps } }), video: null, audio: null });
        const res = await fetch('/chunks');
        const rd = res.body.getReader();
        let buf = new Uint8Array(0);
        let sentCodec = false;
        let n = 0; rig.stats.nativeChunks = () => n;
        const codecOf = (au) => {
            for (let i = 0; i + 4 < au.length; i++) {
                if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
                    const h = (b) => b.toString(16).padStart(2, '0');
                    return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
                }
            }
            return null;
        };
        (async () => {
            for (;;) {
                const { value, done } = await rd.read();
                if (done) return;
                const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
                let off = 0;
                while (buf.length - off >= 21) {
                    const dv = new DataView(buf.buffer, buf.byteOffset + off);
                    const len = dv.getUint32(17, true);
                    if (buf.length - off < 21 + len) break;
                    const keyframe = (buf[off] & 1) === 1;
                    const tsUs = Number(dv.getBigUint64(1, true)), durUs = Number(dv.getBigUint64(9, true));
                    const bytes = buf.slice(off + 21, off + 21 + len).buffer;
                    const msg = { t: 'nativeVideoChunk', keyframe, tsUs, durUs, bytes };
                    if (keyframe && !sentCodec) { const c = codecOf(new Uint8Array(bytes)); if (c) { msg.codec = c; msg.codedWidth = width; msg.codedHeight = height; sentCodec = true; } }
                    w.postMessage(msg, [bytes]);
                    n++;
                    off += 21 + len;
                }
                buf = buf.slice(off);
            }
        })();
    };

    rig.close = () => { for (const c of rig.closers.splice(0)) { try { c(); } catch { /* gone */ } } };
    void sleep;
}

// ---- the agent's --clip-capture host -------------------------------------------
async function primaryMonitor() {
    const out = await ps(`Add-Type -Namespace W -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr MonitorFromPoint(System.Drawing.Point pt, uint flags);' -ReferencedAssemblies System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $h=[W.M]::MonitorFromPoint((New-Object System.Drawing.Point 0,0), 1); "$($h.ToInt64()) $($s.Bounds.Width) $($s.Bounds.Height)"`);
    const [h, w, ht] = out.trim().split(/\s+/).map(Number);
    return { hmonitor: h, width: w, height: ht };
}
/** The app's own effective_encode_settings for the default 1080p30 preset on
 *  this monitor would decide fps/bitrate; on a 2560x1440 monitor that is the
 *  30 fps / 8 Mbps the owner's log shows ("2560x1440 @ 30 fps, 8000 kbps").
 *  NATIVE_FPS / NATIVE_KBPS override it for other monitors. */
function startAgent(mon) {
    const fps = Number(process.env.NATIVE_FPS || 30), kbps = Number(process.env.NATIVE_KBPS || 8000);
    const child = spawn(AGENT, ['--clip-capture', '--hmonitor', String(mon.hmonitor), '--width', String(mon.width), '--height', String(mon.height), '--fps', String(fps), '--bitrate', String(kbps * 1000), '--gop-ms', '2000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let magicSeen = false, pending = Buffer.alloc(0), bytes = 0, frames = 0, keyframes = 0;
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => {
            pending = Buffer.concat([pending, d]);
            if (!magicSeen) {
                if (pending.length < 8) return;
                if (pending.subarray(0, 8).toString('latin1') !== 'PUCACLP1') { reject(new Error('no magic: ' + err)); return; }
                magicSeen = true; pending = pending.subarray(8); resolve();
            }
            // Count, and hand on whole records to the page if one is listening.
            let off = 0;
            while (pending.length - off >= 21) {
                const len = pending.readUInt32LE(off + 17);
                if (pending.length - off < 21 + len) break;
                frames++; bytes += len; if (pending[off] & 1) keyframes++;
                chunkSink?.write(pending.subarray(off, off + 21 + len));
                off += 21 + len;
            }
            pending = pending.subarray(off);
        });
        child.on('exit', (c) => { if (!magicSeen) reject(new Error(`agent exited ${c}: ${err.trim()}`)); });
    });
    return { child, ready, fps, kbps, stats: () => ({ frames, bytes, keyframes }), stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

// ---- one case ----------------------------------------------------------------------
async function runCase(name) {
    const id = `${name.replace(/\W/g, '_')}-${Date.now()}`;
    const parts = name.split('+');
    const { browser, page } = await launch(id);
    let agent = null;
    try {
        if (SOURCE === 'pan' || SOURCE === 'tab') await page.evaluate(() => window.rig.startPan());
        const needsShare = parts.some((p) => /^(capture|mesh\d|sfu|follow)$/.test(p));
        if (needsShare) await page.evaluate(async (S) => { window.rig.shareTrack = await window.rig.capture(S); }, SHARE);
        for (const p of parts) {
            if (p === 'capture') await page.evaluate(() => window.rig.drain(window.rig.shareTrack));
            else if (p === 'capture2') await page.evaluate(async (S) => { window.rig.drain(await window.rig.capture(S)); }, SHARE);
            else if (p === 'captureclone') await page.evaluate(() => { const c = window.rig.shareTrack.clone(); window.rig.closers.push(() => c.stop()); window.rig.drain(c); });
            else if (/^mesh(\d)$/.test(p)) {
                const k = Number(/^mesh(\d)$/.exec(p)[1]);
                await page.evaluate(async (k) => { for (let i = 0; i < k; i++) await window.rig.meshViewer(window.rig.shareTrack); }, k);
            } else if (p === 'sfu') await page.evaluate(() => window.rig.sfuShare(window.rig.shareTrack));
            else if (p === 'manual') await page.evaluate(() => window.rig.manualArm());
            else if (p === 'follow') await page.evaluate(() => window.rig.followArm());
            else if (p === 'native' || p === 'agentonly') {
                // agentonly: the host runs and its frames are counted and
                // dropped here, so no page work rides on them (the control
                // for what the ring's ingest costs).
                const mon = await primaryMonitor();
                agent = startAgent(mon);
                await agent.ready;
                if (p === 'native') await page.evaluate((a) => window.rig.nativeArm(a), { width: mon.width, height: mon.height, fps: agent.fps, bitrate: agent.kbps * 1000 });
            }
        }
        await new Promise((r) => setTimeout(r, WARM_S * 1000));
        const agentPid = agent?.child.pid;
        const a = await snapshot(id);
        const ta = agentPid ? await agentThreads(agentPid) : null;
        const gpuP = gpuSample(Math.max(2, Math.floor(WINDOW_S / 2) - 1), 2);
        const encA = await page.evaluate(() => window.rig.encoders());
        await new Promise((r) => setTimeout(r, WINDOW_S * 1000));
        const encB = await page.evaluate(() => window.rig.encoders());
        const tb = agentPid ? await agentThreads(agentPid) : null;
        const b = await snapshot(id);
        const gpu = await gpuP;
        const ring = await page.evaluate(() => window.rig.stats.ring ?? null);
        const wall = b.at - a.at;
        const tree = treeOf(b, true);
        const agentTree = agentPid ? treeOf(b, false, [agentPid]) : new Set();
        const dwm = byName(b, 'dwm.exe');
        const pct = (pids) => ((cpuMs(b, pids) - cpuMs(a, pids)) / wall) * 100;
        if (process.env.TREE_DEBUG) {
            for (const [label, pids] of [['agent', agentTree], ['browser', tree]]) {
                const rows = b.procs.filter((p) => pids.has(p.p)).map((p) => ({ p: p.p, q: p.q, n: p.n, d: (p.t - (a.procs.find((x) => x.p === p.p)?.t ?? 0)) / 1e4 / wall * 100 }));
                console.log(`   ${label} tree:`, rows.map((r) => `${r.n}#${r.p}<${r.q} ${r.d.toFixed(1)}%`).join(', '));
            }
        }
        const encoders = encB.map((e) => {
            const before = encA.find((x) => x.rid === e.rid && x.enc === e.enc);
            const fps = before ? (e.frames - before.frames) / (wall / 1000) : 0;
            const kbps = before ? ((e.bytes - before.bytes) * 8) / wall : 0;
            return `${e.rid ? e.rid + ':' : ''}${e.enc} ${e.size} ${fps.toFixed(0)}fps ${kbps.toFixed(0)}kbps${e.limit && e.limit !== 'none' ? ' limit=' + e.limit : ''}`;
        });
        return {
            name,
            browser: pct(tree), agent: agentPid ? pct(agentTree) : 0, dwm: pct(dwm),
            gpuBrowser: gpuFor(gpu, tree, gpuNames), gpuAgent: agentPid ? gpuFor(gpu, agentTree, gpuNames) : '',
            encoders, ring: ring ? `ring ${ring.fps}fps ${ring.kbps}kbps ${ring.width}x${ring.height}` : '',
            agentStats: agent?.stats(),
            // The agent's threads by start time: its capture loop is the first.
            agentThreads: ta && tb ? [...tb.m].map(([tid, t]) => ({ start: t.start, pct: ((t.ms - (ta.m.get(tid)?.ms ?? 0)) / (tb.at - ta.at)) * 100 }))
                .filter((x) => x.pct >= 0.5).sort((x, y) => x.start - y.start).map((x) => x.pct.toFixed(1)).join(' ') : '',
        };
    } finally {
        agent?.stop();
        await page.evaluate(() => window.rig?.close()).catch(() => {});
        await browser.close().catch(() => {});
    }
}

console.log(`clip-share-cpu: source=${SOURCE} share=${process.env.SHARE || '1080p30'} window=${WINDOW_S}s warm=${WARM_S}s cases=${CASES.join(',')}`);
console.log('CPU is % of ONE core over the window (Windows kernel+user time of each process tree).\n');
const rows = [];
for (const c of CASES) {
    try {
        const r = await runCase(c);
        rows.push(r);
        console.log(`${c.padEnd(14)} browser ${r.browser.toFixed(1).padStart(6)}%  agent ${r.agent.toFixed(1).padStart(5)}%  dwm ${r.dwm.toFixed(1).padStart(5)}%  total ${(r.browser + r.agent).toFixed(1).padStart(6)}%`);
        if (r.encoders.length) console.log(`               encoders: ${r.encoders.join(' | ')}`);
        if (r.ring) console.log(`               ${r.ring}`);
        if (r.agentStats) console.log(`               agent: ${r.agentStats.frames} frames, ${r.agentStats.keyframes} keyframes, ${(r.agentStats.bytes * 8 / 1e6 / (WINDOW_S + WARM_S)).toFixed(1)} Mbit/s; threads (by start, % of a core): ${r.agentThreads}`);
        console.log(`               gpu browser: ${r.gpuBrowser}${r.gpuAgent ? `   gpu agent: ${r.gpuAgent}` : ''}`);
    } catch (e) {
        console.log(`${c.padEnd(14)} FAILED: ${String(e?.message ?? e).slice(0, 400)}`);
    }
}
srv.close();
