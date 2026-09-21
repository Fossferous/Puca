// The two audio-clock assumptions the native A/V anchor rests on
// (replayWorker.ts vOriginMs), measured in a real Chromium, SILENTLY:
//
//  1. An AudioEncoder's OUTPUT timestamps label the same sound as its INPUT
//     timestamps. The anchor is measured on AudioData (input) timestamps but
//     applied to the encoder's output chunks; an encoder delay the
//     timestamps do not account for would shift every clip's audio by it.
//     Measured by encoding a burst, decoding it again, and comparing where
//     the burst starts on each side's own timestamps.
//  2. AudioData timestamps keep step with the worker's performance.now():
//     min(read - ts) over the first seconds vs the last, so one running-min
//     anchor holds for a whole session.
//
// Both run in a dedicated Worker, as the ring does, on a MediaStreamTrack-
// Processor over a MediaStreamAudioDestinationNode, as replayBuffer builds it.
// SILENT: launched with --mute-audio, and the graph is NEVER connected to
// ac.destination. Nothing is played, shown or captured.
//
//   cd frontend && node e2e/clip-audio-clock-headless.mjs [seconds]
import path from 'node:path';
import http from 'node:http';
import { chromium } from '@playwright/test';

const seconds = Number(process.argv[2] ?? 20);
// WebCodecs needs a secure context; loopback http is one, about:blank is not.
const srv = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><title>audio clock</title>'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const ctx = await chromium.launchPersistentContext(path.join(process.env.TEMP || '.', 'puca-clip-audio-clock'), {
    channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
let failed = false;
try {
    const page = await ctx.newPage();
    page.on('pageerror', e => console.log('  X>', String(e).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const r = await page.evaluate(async ({ seconds }) => {
        const worker = `
            const readStats = []; const inputs = []; const outs = [];
            let decoderConfig = null;
            onmessage = async (ev) => {
                const reader = ev.data.readable.getReader();
                const codec = ev.data.codec;
                const enc = new AudioEncoder({
                    output: (c, meta) => {
                        if (meta && meta.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
                        const b = new Uint8Array(c.byteLength); c.copyTo(b); outs.push({ ts: c.timestamp, dur: c.duration, data: b });
                    },
                    error: (e) => postMessage({ error: String(e) }),
                });
                enc.configure({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
                const t0 = performance.now();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const readAt = performance.now();
                    readStats.push({ at: readAt - t0, off: readAt - value.timestamp / 1000 });
                    // Keep channel 0 of every input, on its own timestamps.
                    const pcm = new Float32Array(value.numberOfFrames);
                    value.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
                    inputs.push({ ts: value.timestamp, pcm });
                    enc.encode(value);
                    value.close();
                    if (readAt - t0 > ${'${'}seconds${'}'} * 1000) break;
                }
                await enc.flush();
                postMessage({ readStats, inputs, outs, codec, decoderConfig });
            };
        `.replace('${seconds}', String(seconds));
        const w = new Worker(URL.createObjectURL(new Blob([worker], { type: 'text/javascript' })));

        const ac = new AudioContext({ sampleRate: 48000 });
        await ac.resume();
        const dest = ac.createMediaStreamDestination(); // NEVER ac.destination
        const osc = ac.createOscillator(); osc.frequency.value = 1000;
        const gain = ac.createGain(); gain.gain.value = 0;
        osc.connect(gain).connect(dest); osc.start();
        // A 30 ms burst every 700 ms: onsets that cannot be confused.
        const first = ac.currentTime + 0.5;
        for (let t = first; t < first + seconds; t += 0.7) { gain.gain.setValueAtTime(0.8, t); gain.gain.setValueAtTime(0, t + 0.03); }
        const proc = new MediaStreamTrackProcessor({ track: dest.stream.getAudioTracks()[0] });
        const codec = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported ? 'mp4a.40.2' : 'opus';
        const res = await new Promise((resolve) => { w.onmessage = (ev) => resolve(ev.data); w.postMessage({ readable: proc.readable, codec }, [proc.readable]); });
        osc.stop(); await ac.close();
        if (res.error) return { error: res.error };

        // Burst onsets on the INPUT side, in its timestamp domain (us).
        const onsets = (chunks, rate) => {
            const out = []; let lastOn = -1e12, prevLoud = false;
            for (const c of chunks) for (let i = 0; i < c.pcm.length; i++) {
                const loud = Math.abs(c.pcm[i]) > 0.3;
                const t = c.ts + (i * 1e6) / rate;
                if (loud && !prevLoud && t - lastOn > 300_000) { out.push(t); lastOn = t; }
                prevLoud = loud;
            }
            return out;
        };
        const inOn = onsets(res.inputs, 48000);

        // Decode the encoded chunks with a real AudioDecoder, in the page.
        const decoded = [];
        const dec = new AudioDecoder({
            output: (d) => { const pcm = new Float32Array(d.numberOfFrames); d.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' }); decoded.push({ ts: d.timestamp, pcm }); d.close(); },
            error: (e) => decoded.push({ error: String(e) }),
        });
        // The encoder's own decoder config (the AAC AudioSpecificConfig), as the
        // ring keeps it for the muxer.
        dec.configure(res.decoderConfig ?? { codec: res.codec, sampleRate: 48000, numberOfChannels: 2 });
        for (const o of res.outs) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: o.ts, duration: o.dur ?? undefined, data: o.data }));
        await dec.flush();
        const outOn = onsets(decoded.filter(d => !d.error), 48000);

        // Pair each input onset with the nearest decoded one.
        const diffs = inOn.map(a => { let best = null; for (const b of outOn) if (best === null || Math.abs(b - a) < Math.abs(best - a)) best = b; return best === null ? null : (best - a) / 1000; }).filter(x => x !== null);
        const rs = res.readStats;
        const minOver = (from, to) => Math.min(...rs.filter(s => s.at >= from && s.at < to).map(s => s.off));
        const span = rs[rs.length - 1].at;
        return {
            codec: res.codec, inputs: res.inputs.length, outputs: res.outs.length, decodeErrors: decoded.filter(d => d.error).map(d => d.error).slice(0, 2),
            onsetsIn: inOn.length, onsetsOut: outOn.length, encoderShiftMs: diffs,
            firstOutMinusFirstInMs: (res.outs[0].ts - res.inputs[0].ts) / 1000,
            clock: { spanMs: span, minFirst5sMs: minOver(0, 5000), minLast5sMs: minOver(span - 5000, span + 1), medianMinusMinMs: (() => { const o = rs.map(s => s.off).sort((a, b) => a - b); return o[Math.floor(o.length / 2)] - o[0]; })() },
        };
    }, { seconds });

    if (r.error) { console.log('FAIL worker:', r.error); failed = true; }
    else {
        const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
        console.log(`codec ${r.codec}: ${r.inputs} AudioData in, ${r.outputs} chunks out; decode errors: ${JSON.stringify(r.decodeErrors)}`);
        console.log(`burst onsets: ${r.onsetsIn} in, ${r.onsetsOut} decoded`);
        console.log(`encoder content shift (decoded onset - input onset, each on its own timestamps): median ${med(r.encoderShiftMs).toFixed(2)} ms, range ${Math.min(...r.encoderShiftMs).toFixed(2)}..${Math.max(...r.encoderShiftMs).toFixed(2)} ms`);
        console.log(`first output ts - first input ts: ${r.firstOutMinusFirstInMs.toFixed(2)} ms`);
        const c = r.clock;
        console.log(`clock over ${(c.spanMs / 1000).toFixed(1)} s: min(read - ts) first 5 s ${c.minFirst5sMs.toFixed(2)} ms, last 5 s ${c.minLast5sMs.toFixed(2)} ms (drift ${(c.minLast5sMs - c.minFirst5sMs).toFixed(2)} ms); median above min ${c.medianMinusMinMs.toFixed(2)} ms`);
        // Positive control: the burst detector found the bursts on both sides.
        const expected = Math.floor(seconds / 0.7);
        if (r.onsetsIn < expected - 2 || r.onsetsOut < expected - 2) { console.log('FAIL the burst detector did not find the bursts'); failed = true; }
    }
} finally {
    await ctx.close();
    srv.close();
}
process.exit(failed ? 1 : 0);
