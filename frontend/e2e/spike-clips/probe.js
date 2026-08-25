// Clips spike probe — injected into the running WebView2 page by runner.mjs via
// CDP Runtime.evaluate. Plain script (no imports); mediabunny's single-file ESM
// bundle is handed in by the runner and imported from a blob: URL.
//
// Everything is exposed on window.__clipSpike so the runner can call steps one
// at a time and read results back. Steps that need a user gesture (S1, S8,
// fullscreen) are called through Runtime.evaluate({ userGesture: true }).
(function () {
    if (window.__clipSpike) return 'already-installed';
    const S = (window.__clipSpike = { results: {}, log: [], stream: null, mb: null, ver: 1 });
    const log = (m, ...a) => {
        const line = `${new Date().toISOString().slice(11, 23)} ${m} ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
        S.log.push(line);
        console.log('[clip-spike]', line);
    };
    S.log_ = log;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const b64 = (buf) => {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength);
        let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s);
    };
    const summary = (arr) => {
        if (!arr.length) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        return { n: arr.length, min: sorted[0], max: sorted[sorted.length - 1], mean, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)] };
    };

    S.loadMediabunny = async (src) => {
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        S.mb = await import(url);
        return Object.keys(S.mb).length;
    };

    // ---- S0: feature detection (main thread + module worker) ----------------
    S.s0 = async () => {
        const main = {
            MediaStreamTrackProcessor: 'MediaStreamTrackProcessor' in self,
            VideoEncoder: 'VideoEncoder' in self, VideoDecoder: 'VideoDecoder' in self,
            AudioEncoder: 'AudioEncoder' in self, AudioDecoder: 'AudioDecoder' in self,
            MediaSource: 'MediaSource' in self, MediaSourceHandle: 'MediaSourceHandle' in self,
            canConstructInWorker: !!(self.MediaSource && self.MediaSource.canConstructInDedicatedWorker),
            subtle: !!(self.crypto && self.crypto.subtle),
            deviceMemory: navigator.deviceMemory ?? null, hardwareConcurrency: navigator.hardwareConcurrency,
            userAgent: navigator.userAgent, isSecureContext: self.isSecureContext,
        };
        const wsrc = `self.onmessage = () => { self.postMessage({ VideoEncoder: 'VideoEncoder' in self, AudioEncoder: 'AudioEncoder' in self, VideoDecoder: 'VideoDecoder' in self, MediaSource: 'MediaSource' in self, MediaSourceHandle: 'MediaSourceHandle' in self, canConstruct: !!(self.MediaSource && self.MediaSource.canConstructInDedicatedWorker), subtle: !!(self.crypto && self.crypto.subtle), MSTP: 'MediaStreamTrackProcessor' in self, VideoFrame: 'VideoFrame' in self, AudioData: 'AudioData' in self }); };`;
        const w = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'text/javascript' })), { type: 'module' });
        const worker = await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(new Error(e.message)); w.postMessage(1); });
        w.terminate();
        S.results.s0 = { main, worker };
        return S.results.s0;
    };

    // Measure the level of an audio track for `ms` via MediaStreamTrackProcessor.
    async function measureLevel(track, ms) {
        const clone = track.clone();
        const proc = new MediaStreamTrackProcessor({ track: clone });
        const reader = proc.readable.getReader();
        const end = performance.now() + ms;
        let frames = 0, peak = 0, sumSq = 0, n = 0, first = null, sampleRate = null, channels = null, formats = new Set();
        while (performance.now() < end) {
            const { value, done } = await reader.read();
            if (done) break;
            try {
                frames++;
                if (first == null) { first = value.timestamp; sampleRate = value.sampleRate; channels = value.numberOfChannels; }
                formats.add(value.format);
                const buf = new Float32Array(value.numberOfFrames * value.numberOfChannels);
                // f32-planar or f32 (interleaved) both copy per plane
                if (value.format && value.format.endsWith('planar')) {
                    for (let ch = 0; ch < value.numberOfChannels; ch++) {
                        const plane = new Float32Array(value.numberOfFrames);
                        value.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
                        for (let i = 0; i < plane.length; i++) { const v = plane[i]; peak = Math.max(peak, Math.abs(v)); sumSq += v * v; n++; }
                    }
                } else {
                    value.copyTo(buf, { planeIndex: 0, format: 'f32' });
                    for (let i = 0; i < buf.length; i++) { const v = buf[i]; peak = Math.max(peak, Math.abs(v)); sumSq += v * v; n++; }
                }
            } finally { value.close(); }
        }
        await reader.cancel().catch(() => {});
        clone.stop();
        return { frames, peak, rms: n ? Math.sqrt(sumSq / n) : 0, sampleRate, channels, formats: [...formats] };
    }

    // ---- S1: getDisplayMedia with system audio (needs a user gesture) -------
    S.s1 = async (opts = {}) => {
        const constraints = {
            video: { width: { max: opts.width ?? 1920 }, height: { max: opts.height ?? 1080 }, frameRate: { max: opts.fps ?? 30 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
            systemAudio: 'include', selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
        };
        const t0 = performance.now();
        S.s1Pending = true;
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
            S.s1Pending = false;
            S.stream = stream;
            const v = stream.getVideoTracks()[0], a = stream.getAudioTracks()[0];
            const info = {
                ms: Math.round(performance.now() - t0),
                video: v ? { label: v.label, settings: v.getSettings() } : null,
                audio: a ? { label: a.label, settings: a.getSettings() } : null,
                audioTracks: stream.getAudioTracks().length,
            };
            if (a) info.audioLevel = await measureLevel(a, opts.levelMs ?? 3000);
            S.results.s1 = info;
            log('s1', info);
            return info;
        } catch (e) {
            S.s1Pending = false;
            S.results.s1 = { error: `${e.name}: ${e.message}`, ms: Math.round(performance.now() - t0) };
            log('s1 FAILED', S.results.s1);
            return S.results.s1;
        }
    };

    // ---- S2: VideoEncoder run -------------------------------------------------
    S.s2 = async ({ width, height, fps, seconds, hw = 'prefer-hardware', bitrate, label }) => {
        if (!S.stream) return { error: 'no stream' };
        const src = S.stream.getVideoTracks()[0];
        const track = src.clone();
        try {
            await track.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: fps } });
        } catch (e) { log('applyConstraints failed', e.message); }
        // Give the constraint a moment to take effect before reading settings.
        await sleep(300);
        const settings = track.getSettings();
        const W = settings.width || width, H = settings.height || height;
        const codecs = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D0028', 'avc1.42E028'];
        const support = {}; let chosen = null;
        for (const c of codecs) {
            try {
                const r = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, framerate: fps, bitrate, hardwareAcceleration: hw, latencyMode: 'realtime', avc: { format: 'avc' } });
                support[c] = r.supported;
                if (r.supported && !chosen) chosen = c;
            } catch (e) { support[c] = `err:${e.message}`; }
        }
        if (!chosen) { track.stop(); return { error: 'no avc config supported', support, W, H }; }
        let frames = 0, dropped = 0, keyframes = 0, bytes = 0, maxQueue = 0, encodeMs = 0, firstTs = null, lastTs = null;
        const keyTimes = [], errors = [], readGaps = [];
        let decoderConfig = null, actualCodec = null;
        const enc = new VideoEncoder({
            output: (chunk, meta) => {
                bytes += chunk.byteLength;
                if (chunk.type === 'key') { keyframes++; keyTimes.push(chunk.timestamp); }
                if (meta && meta.decoderConfig && !decoderConfig) {
                    actualCodec = meta.decoderConfig.codec;
                    decoderConfig = { codec: meta.decoderConfig.codec, codedWidth: meta.decoderConfig.codedWidth, codedHeight: meta.decoderConfig.codedHeight, description: meta.decoderConfig.description ? b64(meta.decoderConfig.description) : null };
                }
            },
            error: (e) => { errors.push(String(e && e.message || e)); },
        });
        enc.configure({ codec: chosen, width: W, height: H, framerate: fps, bitrate, bitrateMode: 'variable', hardwareAcceleration: hw, latencyMode: 'realtime', avc: { format: 'avc' } });
        const proc = new MediaStreamTrackProcessor({ track });
        const reader = proc.readable.getReader();
        const wall0 = performance.now();
        const end = wall0 + seconds * 1000;
        let lastKeyUs = -Infinity, lastRead = performance.now();
        while (performance.now() < end) {
            const { value: frame, done } = await reader.read();
            if (done) break;
            const now = performance.now(); readGaps.push(now - lastRead); lastRead = now;
            try {
                if (firstTs == null) firstTs = frame.timestamp;
                lastTs = frame.timestamp;
                if (enc.encodeQueueSize > 4) { dropped++; continue; }
                maxQueue = Math.max(maxQueue, enc.encodeQueueSize);
                const key = frame.timestamp - lastKeyUs >= 2_000_000;
                const t = performance.now();
                enc.encode(frame, { keyFrame: key });
                encodeMs += performance.now() - t;
                if (key) lastKeyUs = frame.timestamp;
                frames++;
            } finally { frame.close(); }
        }
        const wallS = (performance.now() - wall0) / 1000;
        try { await reader.cancel(); } catch { /* ignore */ }
        try { await enc.flush(); } catch (e) { errors.push('flush:' + e.message); }
        try { enc.close(); } catch { /* ignore */ }
        track.stop();
        const keyGaps = []; for (let i = 1; i < keyTimes.length; i++) keyGaps.push((keyTimes[i] - keyTimes[i - 1]) / 1000);
        const res = {
            label, chosen, actualCodec, support, W, H, fps, hw, bitrateTarget: bitrate, seconds: wallS,
            frames, dropped, keyframes, dropPct: frames ? (100 * dropped / (frames + dropped)) : 0,
            measuredFps: frames / wallS, kbps: (bytes * 8) / wallS / 1000, bytes,
            maxQueue, encodeCallMsTotal: encodeMs, encodeCallMsPerFrame: frames ? encodeMs / frames : 0,
            keyGapMs: summary(keyGaps), readGapMs: summary(readGaps), errors,
            decoderConfig,
        };
        if (!S.decoderConfig && decoderConfig) S.decoderConfig = decoderConfig;
        S.results['s2_' + label] = res;
        log('s2', label, { frames, dropped, kbps: res.kbps.toFixed(0), keyframes, maxQueue });
        return res;
    };

    // ---- S3: audio codec + container support ---------------------------------
    S.s3 = async () => {
        const out = {};
        for (const codec of ['mp4a.40.2', 'opus']) {
            try { const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }); out[codec] = r.supported; }
            catch (e) { out[codec] = `err:${e.message}`; }
        }
        const v = document.createElement('video');
        const vc = S.decoderConfig?.codec ?? 'avc1.640028';
        out.mse = {
            aac: MediaSource.isTypeSupported(`video/mp4; codecs="${vc}, mp4a.40.2"`),
            opus: MediaSource.isTypeSupported(`video/mp4; codecs="${vc}, opus"`),
        };
        out.canPlay = {
            aac: v.canPlayType(`video/mp4; codecs="${vc}, mp4a.40.2"`),
            opus: v.canPlayType(`video/mp4; codecs="${vc}, opus"`),
        };
        S.results.s3 = out; log('s3', out); return out;
    };

    // ---- helpers for the mux path -------------------------------------------
    // Sealed-record shape shared by S4/S6: an array of {kind:'v'|'a', chunk bytes, ts, dur, type, meta}
    async function captureSegment({ seconds, fps, width, height, bitrate, audioCodec, withBeeps, beepEveryS = 5, beepMs = 200, flashMs = 200 }) {
        const vsrc = S.stream.getVideoTracks()[0].clone();
        try { await vsrc.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: fps } }); } catch { /* ignore */ }
        await sleep(300);
        const vs = vsrc.getSettings();
        const W = vs.width || width, H = vs.height || height;
        // Audio graph exactly as the design: sys → gain → MediaStreamDestination
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume().catch(() => {});
        const dest = ctx.createMediaStreamDestination();
        const sysTrack = S.stream.getAudioTracks()[0];
        let sysNode = null;
        if (sysTrack) { sysNode = ctx.createMediaStreamSource(new MediaStream([sysTrack])); const g = ctx.createGain(); g.gain.value = 1; sysNode.connect(g).connect(dest); }
        const mixedTrack = dest.stream.getAudioTracks()[0];
        // Beeps go to the SPEAKERS (ctx.destination) so they travel the real path:
        // speaker → OS loopback → getDisplayMedia audio track. Quiet on purpose.
        const flash = document.createElement('div');
        Object.assign(flash.style, { position: 'fixed', inset: '0', background: '#fff', zIndex: 2147483647, display: 'none', pointerEvents: 'none' });
        document.body.appendChild(flash);
        const events = []; // wall-clock (performance.now) of each beep/flash start
        let beepTimer = null;
        const videoCodec = S.decoderConfig?.codec ?? 'avc1.640028';
        // --- encoders
        const vchunks = [], achunks = [];
        let vdec = null, adec = null, verr = [], aerr = [];
        const venc = new VideoEncoder({ output: (c, m) => { const buf = new Uint8Array(c.byteLength); c.copyTo(buf); vchunks.push({ buf, ts: c.timestamp, dur: c.duration, type: c.type }); if (m && m.decoderConfig && !vdec) vdec = m.decoderConfig; }, error: e => verr.push(String(e.message || e)) });
        venc.configure({ codec: videoCodec, width: W, height: H, framerate: fps, bitrate, bitrateMode: 'variable', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' } });
        const aenc = new AudioEncoder({ output: (c, m) => { const buf = new Uint8Array(c.byteLength); c.copyTo(buf); achunks.push({ buf, ts: c.timestamp, dur: c.duration, type: c.type }); if (m && m.decoderConfig && !adec) adec = m.decoderConfig; }, error: e => aerr.push(String(e.message || e)) });
        aenc.configure({ codec: audioCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
        const vproc = new MediaStreamTrackProcessor({ track: vsrc });
        const aproc = new MediaStreamTrackProcessor({ track: mixedTrack });
        const vr = vproc.readable.getReader(), ar = aproc.readable.getReader();
        let firstV = null, firstA = null, wallV = null, wallA = null, vcount = 0, acount = 0, vdropped = 0, lastKey = -Infinity;
        let audioFormat = null, audioRate = null, audioCh = null;
        const stop = { v: false, a: false };
        const vloop = (async () => {
            for (;;) {
                const { value: f, done } = await vr.read(); if (done || stop.v) { if (f) f.close(); break; }
                try {
                    if (firstV == null) { firstV = f.timestamp; wallV = performance.now(); }
                    if (venc.encodeQueueSize > 4) { vdropped++; continue; }
                    const key = f.timestamp - lastKey >= 2_000_000;
                    venc.encode(f, { keyFrame: key }); if (key) lastKey = f.timestamp; vcount++;
                } finally { f.close(); }
            }
        })();
        const aloop = (async () => {
            for (;;) {
                const { value: d, done } = await ar.read(); if (done || stop.a) { if (d) d.close(); break; }
                try {
                    if (firstA == null) { firstA = d.timestamp; wallA = performance.now(); audioFormat = d.format; audioRate = d.sampleRate; audioCh = d.numberOfChannels; }
                    aenc.encode(d); acount++;
                } finally { d.close(); }
            }
        })();
        if (withBeeps) {
            const doBeep = () => {
                const t = performance.now();
                events.push(t);
                flash.style.display = 'block'; setTimeout(() => { flash.style.display = 'none'; }, flashMs);
                const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 1000;
                const g = ctx.createGain(); g.gain.value = 0.15;
                osc.connect(g).connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + beepMs / 1000);
            };
            setTimeout(doBeep, 2000);
            beepTimer = setInterval(doBeep, beepEveryS * 1000);
        }
        const wall0 = performance.now();
        await sleep(seconds * 1000);
        if (beepTimer) clearInterval(beepTimer);
        stop.v = true; stop.a = true;
        try { await vr.cancel(); } catch { /* ignore */ }
        try { await ar.cancel(); } catch { /* ignore */ }
        await Promise.allSettled([vloop, aloop]);
        try { await venc.flush(); } catch (e) { verr.push('flush:' + e.message); }
        try { await aenc.flush(); } catch (e) { aerr.push('flush:' + e.message); }
        try { venc.close(); aenc.close(); } catch { /* ignore */ }
        vsrc.stop(); mixedTrack.stop(); if (sysNode) sysNode.disconnect(); await ctx.close().catch(() => {});
        flash.remove();
        const wallS = (performance.now() - wall0) / 1000;
        return { W, H, fps, wallS, vchunks, achunks, vdec, adec, verr, aerr, firstV, firstA, wallV, wallA, vcount, acount, vdropped, events, audioFormat, audioRate, audioCh, videoCodec, audioCodec, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency };
    }

    // Mux a captured segment with mediabunny → Uint8Array (fragmented MP4).
    async function mux(seg, { audioOffsetUs = 0, fragmented = true, appendOnly = true } = {}) {
        const mb = S.mb; if (!mb) throw new Error('mediabunny not loaded');
        const chunks = [];
        let target;
        if (appendOnly) {
            const ws = new WritableStream({ write(c) { chunks.push(c instanceof Uint8Array ? c : c.data); } });
            target = new mb.AppendOnlyStreamTarget(ws);
        } else {
            target = new mb.BufferTarget();
        }
        const output = new mb.Output({ format: new mb.Mp4OutputFormat(fragmented ? { fastStart: 'fragmented', minimumFragmentDuration: 1 } : { fastStart: 'in-memory' }), target });
        const vsrc = new mb.EncodedVideoPacketSource('avc');
        const asrc = new mb.EncodedAudioPacketSource(seg.audioCodec === 'opus' ? 'opus' : 'aac');
        output.addVideoTrack(vsrc);
        output.addAudioTrack(asrc);
        await output.start();
        // Video timeline rebased to first video frame; audio rebased to first audio data + offset.
        const vBase = seg.firstV, aBase = seg.firstA;
        const guessUs = Math.round((seg.wallA - seg.wallV) * 1000);
        const aShiftUs = guessUs + audioOffsetUs;
        // Timestamps must be non-negative for MP4; drop leading audio that would go negative.
        let vFirst = true, aFirst = true, vAdded = 0, aAdded = 0, aSkipped = 0;
        for (const c of seg.vchunks) {
            const ts = (c.ts - vBase) / 1e6; const dur = (c.dur ?? Math.round(1e6 / seg.fps)) / 1e6;
            const pkt = new mb.EncodedPacket(c.buf, c.type, ts, dur);
            await vsrc.add(pkt, vFirst ? { decoderConfig: seg.vdec } : undefined); vFirst = false; vAdded++;
        }
        for (const c of seg.achunks) {
            const ts = (c.ts - aBase + aShiftUs) / 1e6; const dur = (c.dur ?? 20000) / 1e6;
            if (ts < 0) { aSkipped++; continue; }
            const pkt = new mb.EncodedPacket(c.buf, c.type, ts, dur);
            await asrc.add(pkt, aFirst ? { decoderConfig: seg.adec } : undefined); aFirst = false; aAdded++;
        }
        await output.finalize();
        let bytes;
        if (appendOnly) { const total = chunks.reduce((a, c) => a + c.byteLength, 0); bytes = new Uint8Array(total); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.byteLength; } }
        else bytes = target.buffer;
        return { bytes, guessUs, aShiftUs, vAdded, aAdded, aSkipped, mime: output.format.mimeType ?? null };
    }

    // Walk top-level boxes of an ISO-BMFF byte array.
    function boxes(u8) {
        const out = []; let off = 0; const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        while (off + 8 <= u8.byteLength) {
            let size = dv.getUint32(off); const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
            let hdr = 8;
            if (size === 1) { size = Number(dv.getBigUint64(off + 8)); hdr = 16; }
            else if (size === 0) size = u8.byteLength - off;
            out.push({ type, off, size }); if (size < hdr) break; off += size;
        }
        return out;
    }

    // Decode-side A/V sync analysis: find white flashes and 1 kHz beeps in the mux.
    async function analyzeSync(bytes) {
        const mb = S.mb;
        const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
        const vt = await input.getPrimaryVideoTrack(); const at = await input.getPrimaryAudioTrack();
        const out = { videoCodec: vt ? await vt.getCodec() : null, audioCodec: at ? await at.getCodec() : null, videoDuration: vt ? await vt.computeDuration() : null, audioDuration: at ? await at.computeDuration() : null, flashes: [], beeps: [] };
        if (vt) {
            const sink = new mb.CanvasSink(vt, { width: 64, height: 36, fit: 'fill' });
            let prevBright = false;
            for await (const { canvas, timestamp } of sink.canvases()) {
                const cx = canvas.getContext('2d'); const d = cx.getImageData(0, 0, canvas.width, canvas.height).data;
                let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
                const mean = sum / (d.length / 4);
                const bright = mean > 235;
                if (bright && !prevBright) out.flashes.push(timestamp);
                prevBright = bright;
            }
        }
        if (at) {
            const sink = new mb.AudioBufferSink(at);
            let prevLoud = false; let base = 0, baseN = 0;
            for await (const { buffer, timestamp } of sink.buffers()) {
                const ch = buffer.getChannelData(0); const win = 480; // 10 ms
                for (let i = 0; i + win <= ch.length; i += win) {
                    let s = 0; for (let j = 0; j < win; j++) s += ch[i + j] * ch[i + j];
                    const rms = Math.sqrt(s / win);
                    if (baseN < 200) { base += rms; baseN++; }
                    const loud = rms > Math.max(0.03, (base / Math.max(1, baseN)) * 4);
                    if (loud && !prevLoud) out.beeps.push(timestamp + i / buffer.sampleRate);
                    prevLoud = loud;
                }
            }
        }
        // pair up flashes with the nearest beep
        const pairs = out.flashes.map(f => { let best = null; for (const b of out.beeps) { const d = b - f; if (best == null || Math.abs(d) < Math.abs(best)) best = d; } return best; }).filter(x => x != null);
        out.pairs = pairs; out.offsetS = summary(pairs);
        return out;
    }

    // ---- S4: 30 s capture → mux → playback + MSE + A/V sync -------------------
    S.s4 = async ({ seconds = 30, fps = 30, width = 1920, height = 1080, bitrate = 6_000_000, audioCodec, noBeeps = false } = {}) => {
        if (!S.stream) return { error: 'no stream' };
        // noBeeps: the caller injects its own markers (headless runs drive the
        // synthetic canvas/audio instead of a DOM overlay + speakers).
        const seg = await captureSegment({ seconds, fps, width, height, bitrate, audioCodec, withBeeps: !noBeeps });
        S.lastSegment = { vdec: seg.vdec, adec: seg.adec, W: seg.W, H: seg.H, fps, audioCodec, vchunks: seg.vchunks.length, achunks: seg.achunks.length };
        const res = { W: seg.W, H: seg.H, wallS: seg.wallS, vcount: seg.vcount, acount: seg.acount, vdropped: seg.vdropped, verr: seg.verr, aerr: seg.aerr, events: seg.events.length, audioFormat: seg.audioFormat, audioRate: seg.audioRate, audioCh: seg.audioCh, baseLatency: seg.baseLatency, outputLatency: seg.outputLatency, wallDeltaMs: seg.wallA - seg.wallV, firstVUs: seg.firstV, firstAUs: seg.firstA };
        let m;
        try { m = await mux(seg, {}); } catch (e) { res.muxError = `${e.name}: ${e.message}\n${e.stack}`; S.results.s4 = res; log('s4 mux failed', res.muxError); return res; }
        res.mux = { bytes: m.bytes.byteLength, guessUs: m.guessUs, vAdded: m.vAdded, aAdded: m.aAdded, aSkipped: m.aSkipped, mime: m.mime, boxes: boxes(m.bytes).slice(0, 12).map(b => b.type + ':' + b.size), boxCount: boxes(m.bytes).length, moofCount: boxes(m.bytes).filter(b => b.type === 'moof').length };
        S.lastMp4 = m.bytes;
        // (a) plain <video src=blob:>
        try {
            const url = URL.createObjectURL(new Blob([m.bytes], { type: 'video/mp4' }));
            const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:2147483646;';
            document.body.appendChild(v);
            const meta = await new Promise((resolve) => { const t = setTimeout(() => resolve({ timeout: true }), 8000); v.onloadedmetadata = () => { clearTimeout(t); resolve({ duration: v.duration, w: v.videoWidth, h: v.videoHeight }); }; v.onerror = () => { clearTimeout(t); resolve({ error: v.error && v.error.message }); }; v.src = url; });
            let played = null;
            if (!meta.error && !meta.timeout) { try { await v.play(); await sleep(1500); played = { currentTime: v.currentTime, paused: v.paused, readyState: v.readyState }; } catch (e) { played = { error: e.message }; } }
            v.pause(); v.remove(); URL.revokeObjectURL(url);
            res.plainVideo = { ...meta, played };
        } catch (e) { res.plainVideo = { error: e.message }; }
        // (b) MSE append of the whole file (init + fragments in order)
        try {
            const type = seg.achunks.length
                ? `video/mp4; codecs="${seg.vdec?.codec ?? 'avc1.640028'}, ${audioCodec === 'opus' ? 'opus' : 'mp4a.40.2'}"`
                : `video/mp4; codecs="${seg.vdec?.codec ?? 'avc1.640028'}"`;
            const supported = MediaSource.isTypeSupported(type);
            const ms = new MediaSource();
            const v = document.createElement('video'); v.muted = true; v.playsInline = true; document.body.appendChild(v);
            const openP = new Promise(r => ms.addEventListener('sourceopen', r, { once: true }));
            v.src = URL.createObjectURL(ms);
            await openP;
            const sb = ms.addSourceBuffer(type);
            const appended = await new Promise((resolve) => { sb.addEventListener('updateend', () => resolve(true), { once: true }); sb.addEventListener('error', () => resolve(false), { once: true }); sb.appendBuffer(m.bytes); });
            ms.duration = seg.wallS; ms.endOfStream();
            let mse = { type, supported, appended, buffered: sb.buffered.length ? [sb.buffered.start(0), sb.buffered.end(0)] : [] };
            try { await v.play(); await sleep(1500); mse.played = { currentTime: v.currentTime, paused: v.paused, readyState: v.readyState, error: v.error && v.error.message }; } catch (e) { mse.played = { error: e.message }; }
            v.pause(); v.remove();
            res.mse = mse;
        } catch (e) { res.mse = { error: e.message }; }
        // (c) decode-side A/V sync
        try { res.sync = await analyzeSync(m.bytes); } catch (e) { res.sync = { error: `${e.name}: ${e.message}` }; }
        S.results.s4 = res; log('s4', { bytes: res.mux?.bytes, flashes: res.sync?.flashes?.length, beeps: res.sync?.beeps?.length, offset: res.sync?.offsetS });
        return res;
    };

    // Export the last mux as base64 (for the runner to save as an .mp4 fixture) and a 2 s chunk fixture.
    S.exportMp4 = () => (S.lastMp4 ? b64(S.lastMp4) : null);

    // ---- S6: encrypted GOP ring for N seconds (memory plateau) ---------------
    // Runs in the page (not a worker) — the memory question is the same.
    S.s6Start = async ({ seconds = 600, fps = 30, width = 1920, height = 1080, bitrate = 6_000_000, ringSeconds = 300, audioCodec } = {}) => {
        if (!S.stream) return { error: 'no stream' };
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const st = (S.s6 = { running: true, seconds, ringSeconds, gops: [], ringBytes: 0, closed: 0, evicted: 0, cryptoMs: 0, vcount: 0, dropped: 0, err: null, start: performance.now(), lastStatus: null });
        const vsrc = S.stream.getVideoTracks()[0].clone();
        try { await vsrc.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: fps } }); } catch { /* ignore */ }
        await sleep(300);
        const vs = vsrc.getSettings(); const W = vs.width || width, H = vs.height || height;
        const codec = S.decoderConfig?.codec ?? 'avc1.640028';
        let open = { parts: [], bytes: 0, startUs: 0, endUs: 0 }; let counter = 0; let closing = Promise.resolve();
        const closeGop = () => {
            const g = open; if (!g.parts.length) return; open = { parts: [], bytes: 0, startUs: g.endUs, endUs: g.endUs };
            const plain = new Uint8Array(g.bytes); let o = 0; for (const p of g.parts) { plain.set(p, o); o += p.byteLength; }
            const ctr = counter++;
            const nonce = new Uint8Array(12); new DataView(nonce.buffer).setBigUint64(4, BigInt(ctr));
            const t = performance.now();
            closing = closing.then(async () => {
                const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array([1]) }, key, plain));
                plain.fill(0);
                st.cryptoMs += performance.now() - t;
                st.gops.push({ startUs: g.startUs, endUs: g.endUs, ct, plainLen: g.bytes }); st.ringBytes += ct.byteLength; st.closed++;
                while (st.gops.length > 1 && (st.gops[st.gops.length - 1].endUs - st.gops[0].startUs) > ringSeconds * 1e6) { const ev = st.gops.shift(); st.ringBytes -= ev.ct.byteLength; ev.ct.fill(0); st.evicted++; }
            }).catch(e => { st.err = 'crypto:' + e.message; });
        };
        const enc = new VideoEncoder({ output: (c) => { const buf = new Uint8Array(c.byteLength); c.copyTo(buf); if (c.type === 'key') { closeGop(); open.startUs = c.timestamp; } open.parts.push(buf); open.bytes += buf.byteLength; open.endUs = c.timestamp + (c.duration ?? Math.round(1e6 / fps)); }, error: e => { st.err = 'enc:' + (e.message || e); } });
        enc.configure({ codec, width: W, height: H, framerate: fps, bitrate, bitrateMode: 'variable', hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' } });
        const proc = new MediaStreamTrackProcessor({ track: vsrc }); const reader = proc.readable.getReader();
        (async () => {
            let lastKey = -Infinity; const end = performance.now() + seconds * 1000;
            try {
                while (performance.now() < end && st.running) {
                    const { value: f, done } = await reader.read(); if (done) break;
                    try { if (enc.encodeQueueSize > 4) { st.dropped++; continue; } const key = f.timestamp - lastKey >= 2_000_000; enc.encode(f, { keyFrame: key }); if (key) lastKey = f.timestamp; st.vcount++; } finally { f.close(); }
                }
                await reader.cancel().catch(() => {}); await enc.flush().catch(() => {}); enc.close(); closeGop(); await closing;
            } catch (e) { st.err = 'loop:' + e.message; }
            vsrc.stop(); st.running = false; st.endedAt = performance.now();
        })();
        return { started: true, W, H, codec };
    };
    S.s6Status = () => { const st = S.s6; if (!st) return null; const secs = st.gops.length ? (st.gops[st.gops.length - 1].endUs - st.gops[0].startUs) / 1e6 : 0; const s = { running: st.running, elapsedS: (performance.now() - st.start) / 1000, gops: st.gops.length, ringBytes: st.ringBytes, ringSeconds: secs, closed: st.closed, evicted: st.evicted, cryptoMs: st.cryptoMs, vcount: st.vcount, dropped: st.dropped, err: st.err, jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null }; st.lastStatus = s; return s; };
    S.s6Wipe = () => { const st = S.s6; if (!st) return null; st.running = false; for (const g of st.gops) g.ct.fill(0); const n = st.gops.length; st.gops.length = 0; st.ringBytes = 0; return { wiped: n }; };

    // ---- S7: AES-GCM throughput at GOP size ----------------------------------
    S.s7 = async ({ bytes = 2_300_000, iterations = 20 } = {}) => {
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const plain = new Uint8Array(bytes); crypto.getRandomValues(plain.subarray(0, 65536));
        const iv = new Uint8Array(12);
        let enc = 0, dec = 0;
        for (let i = 0; i < iterations; i++) {
            iv[11] = i;
            let t = performance.now(); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([1]) }, key, plain); enc += performance.now() - t;
            t = performance.now(); await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array([1]) }, key, ct); dec += performance.now() - t;
        }
        const r = { bytes, iterations, encMsPer: enc / iterations, decMsPer: dec / iterations, encMBps: (bytes / 1048576) / (enc / iterations / 1000), decMBps: (bytes / 1048576) / (dec / iterations / 1000) };
        S.results.s7 = r; log('s7', r); return r;
    };

    // ---- S8: a SECOND getDisplayMedia while the first is live (needs gesture) -
    S.s8 = async () => {
        if (!S.stream) return { error: 'no first stream' };
        try {
            const s2 = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } }, audio: false, selfBrowserSurface: 'include' });
            const t1 = S.stream.getVideoTracks()[0], t2 = s2.getVideoTracks()[0];
            const count = async (track, ms) => { const c = track.clone(); const p = new MediaStreamTrackProcessor({ track: c }); const r = p.readable.getReader(); const end = performance.now() + ms; let n = 0; while (performance.now() < end) { const { value, done } = await r.read(); if (done) break; value.close(); n++; } await r.cancel().catch(() => {}); c.stop(); return n; };
            const [n1, n2] = await Promise.all([count(t1, 10000), count(t2, 10000)]);
            s2.getTracks().forEach(t => t.stop());
            const r = { first: { readyState: t1.readyState, frames10s: n1 }, second: { label: t2.label, frames10s: n2 } };
            S.results.s8 = r; log('s8', r); return r;
        } catch (e) { S.results.s8 = { error: `${e.name}: ${e.message}` }; return S.results.s8; }
    };

    // ---- S10: Blob spill probe (viewer-side fallback) — creates blobs of a size and keeps them alive
    S.s10Hold = [];
    S.s10 = async ({ mb = 32 } = {}) => {
        const size = mb * 1048576; const part = new Uint8Array(1048576); crypto.getRandomValues(part.subarray(0, 4096));
        const parts = []; for (let i = 0; i < mb; i++) parts.push(part.slice());
        const blob = new Blob(parts, { type: 'video/mp4' });
        // Force it into blob storage by creating an object URL and fetching a byte.
        const url = URL.createObjectURL(blob);
        const r = await fetch(url, { headers: { Range: 'bytes=0-1' } }).catch(e => ({ error: e.message }));
        S.s10Hold.push({ blob, url });
        return { size, fetched: r.status ?? r.error, held: S.s10Hold.length };
    };
    S.s10Release = () => { for (const h of S.s10Hold) URL.revokeObjectURL(h.url); const n = S.s10Hold.length; S.s10Hold.length = 0; return n; };

    // Agitator: a full-window animated canvas so the display capture actually
    // produces frames at the constrained rate (a static desktop yields ~15 fps
    // because Chromium's screen capture is damage-driven). Motion + noise so
    // the encoder cannot cheat with skip blocks — a worst-case game scene.
    S.agitate = (on) => {
        if (on) {
            if (S._agit) return 'already';
            const c = document.createElement('canvas');
            c.width = Math.min(1920, innerWidth); c.height = Math.min(1080, innerHeight);
            Object.assign(c.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: 2147483000, pointerEvents: 'none' });
            document.body.appendChild(c);
            const cx = c.getContext('2d');
            const noise = cx.createImageData(256, 256);
            let t = 0, raf = 0;
            const draw = () => {
                t++;
                cx.fillStyle = `hsl(${(t * 3) % 360} 60% 20%)`; cx.fillRect(0, 0, c.width, c.height);
                for (let i = 0; i < 40; i++) {
                    cx.fillStyle = `hsl(${(i * 37 + t * 5) % 360} 80% 55%)`;
                    const x = (Math.sin(t / 30 + i) * 0.5 + 0.5) * c.width, y = (Math.cos(t / 23 + i * 1.3) * 0.5 + 0.5) * c.height;
                    cx.fillRect(x, y, 90, 90);
                }
                const d = noise.data; for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
                for (let k = 0; k < 6; k++) cx.putImageData(noise, ((t * 7 + k * 300) % c.width), (k * 170) % c.height);
                cx.fillStyle = '#fff'; cx.font = '48px monospace'; cx.fillText(String(t), 40, 80);
                raf = requestAnimationFrame(draw);
            };
            raf = requestAnimationFrame(draw);
            S._agit = { c, stop: () => cancelAnimationFrame(raf) };
            return 'on';
        }
        if (S._agit) { S._agit.stop(); S._agit.c.remove(); S._agit = null; }
        return 'off';
    };

    // Is THIS window on the captured screen? Flash white and watch the frames.
    S.locate = async () => {
        if (!S.stream) return { error: 'no stream' };
        const clone = S.stream.getVideoTracks()[0].clone();
        const proc = new MediaStreamTrackProcessor({ track: clone });
        const reader = proc.readable.getReader();
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18; const cx = canvas.getContext('2d', { willReadFrequently: true });
        const meanOf = (frame) => { cx.drawImage(frame, 0, 0, 32, 18); const d = cx.getImageData(0, 0, 32, 18).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return s / (d.length / 4); };
        const sample = async (ms) => { const end = performance.now() + ms; const vals = []; while (performance.now() < end) { const { value, done } = await reader.read(); if (done) break; try { vals.push(meanOf(value)); } finally { value.close(); } } return vals; };
        const before = await sample(700);
        const flash = document.createElement('div');
        Object.assign(flash.style, { position: 'fixed', inset: '0', background: '#fff', zIndex: 2147483647 });
        document.body.appendChild(flash);
        await sleep(150);
        const during = await sample(700);
        flash.remove();
        await reader.cancel().catch(() => {}); clone.stop();
        const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
        const r = { beforeMean: avg(before), duringMean: avg(during), framesBefore: before.length, framesDuring: during.length, screenX: window.screenX, screenY: window.screenY, outerW: outerWidth, outerH: outerHeight, screenW: screen.width, screenH: screen.height };
        r.onCapturedScreen = r.beforeMean != null && r.duringMean != null && (r.duringMean - r.beforeMean) > 25;
        S.results.locate = r; log('locate', r); return r;
    };

    S.fullscreen = async () => { try { await document.documentElement.requestFullscreen(); return 'ok'; } catch (e) { return `${e.name}: ${e.message}`; } };
    S.exitFullscreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); return 'ok'; } catch (e) { return e.message; } };
    S.stopAll = () => { if (S.stream) S.stream.getTracks().forEach(t => t.stop()); S.stream = null; return 'stopped'; };
    S.dump = () => JSON.stringify({ results: S.results, log: S.log.slice(-200), decoderConfig: S.decoderConfig });
    return 'installed';
})();
