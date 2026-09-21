/**
 * The in-page half of the clip A/V emulation harness: drives the REAL native
 * clip pipeline (replayBuffer.armNative -> nativeCapture -> the replay worker
 * -> seal -> upload) against the emulated Rust side in emulator.js, then
 * decrypts and demuxes the sealed clip with the app's own crypto and muxer
 * library and locates the flash frame and the audio burst in it.
 *
 * Silent by construction: the app's audio graphs end in
 * MediaStreamAudioDestinationNodes (never ctx.destination), the browser is
 * launched with --mute-audio, and nothing is ever played back.
 */
import { armNative, disarm, getReplayState, seal, subscribeReplay, uploadAndBuild } from '../../src/api/clips/replayBuffer';
import { decodeClipRef } from '../../src/api/clips/clipRef';
import { openPart, uuidToBytes } from '../../src/api/clips/clipCrypto';
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink } from 'mediabunny';

declare global {
    interface Window {
        __AV_AUS__: { key: boolean; bytes: Uint8Array }[];
        __AV_CODEC__: string;
        __AV_FLASH_FRAME__: number;
        __AV_TRUTH__: { bursts: { frame: number; flashAt: number; burstAt: number; offsetMs: number }[]; v0: number; agentStart: number } | undefined;
        __AV_EMU__: { log: string[]; diag: string[]; params: Record<string, unknown>; leads: { at: number; leadMs: number; state: string }[]; presented: () => { k: number; presentAt: number; tsUs: number }[] };
        __av: typeof api;
    }
}

const waitFor = (pred: () => boolean, ms: number, what: string) => new Promise<void>((res, rej) => {
    const t0 = performance.now();
    const tick = () => { if (pred()) return res(); if (performance.now() - t0 > ms) return rej(new Error('timeout waiting for ' + what + '; state=' + JSON.stringify(getReplayState()))); setTimeout(tick, 50); };
    tick();
});

/** Split an Annex-B stream into access units on AUD NALs (type 9). */
function splitAccessUnits(stream: Uint8Array): { key: boolean; bytes: Uint8Array }[] {
    const starts: number[] = [];
    for (let i = 0; i + 4 < stream.length; i++) {
        if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 0 && stream[i + 3] === 1 && (stream[i + 4] & 0x1f) === 9) starts.push(i);
    }
    if (!starts.length) throw new Error('no AUD NALs: encode with -x264-params aud=1');
    const out: { key: boolean; bytes: Uint8Array }[] = [];
    for (let s = 0; s < starts.length; s++) {
        const bytes = stream.subarray(starts[s], s + 1 < starts.length ? starts[s + 1] : stream.length);
        let key = false;
        for (let i = 0; i + 4 < bytes.length; i++) {
            if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 5) { key = true; break; }
        }
        out.push({ key, bytes });
    }
    return out;
}

/** 'avc1.PPCCLL' from the first SPS in the stream. */
function codecString(stream: Uint8Array): string {
    for (let i = 0; i + 7 < stream.length; i++) {
        if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 7) {
            return 'avc1.' + [stream[i + 4], stream[i + 5], stream[i + 6]].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
        }
    }
    throw new Error('no SPS in the stream');
}

const api = {
    async load(streamUrl: string, flashFrame: number) {
        const raw = new Uint8Array(await (await fetch(streamUrl)).arrayBuffer());
        window.__AV_AUS__ = splitAccessUnits(raw);
        window.__AV_CODEC__ = codecString(raw);
        window.__AV_FLASH_FRAME__ = flashFrame;
        return { accessUnits: window.__AV_AUS__.length, keyframes: window.__AV_AUS__.filter(a => a.key).length, codec: window.__AV_CODEC__ };
    },
    async arm() {
        const notices: string[] = [];
        subscribeReplay(s => { if (s.notice) notices.push(s.notice); if (s.error) notices.push('ERROR ' + s.error); });
        await armNative();
        await waitFor(() => getReplayState().phase === 'armed' && !!getReplayState().videoCodec, 15000, 'armed with a codec');
        return { state: getReplayState(), notices };
    },
    async waitBuffered(ms: number) {
        await waitFor(() => getReplayState().bufferedMs >= ms, ms + 20000, `bufferedMs >= ${ms}`);
        return getReplayState().bufferedMs;
    },
    async sealAndUpload(requestedMs: number, baseUrl: string) {
        const info = await seal(requestedMs);
        const { href } = await uploadAndBuild('emulated-token', baseUrl, '00000000-0000-4000-8000-00000000c1a9');
        return { info, href, diag: window.__AV_EMU__.diag.slice() };
    },
    /** Decrypt the uploaded parts, demux, and locate the flash and the burst. */
    async measure(href: string, partsB64: Record<string, string>) {
        const m = decodeClipRef(href);
        if (!m) throw new Error('bad clip ref');
        const secrets = { key: m.key, noncePrefix: m.noncePrefix, clipId: uuidToBytes(m.clipId) };
        const plain: Uint8Array[] = [];
        for (let i = 0; i < m.parts.length; i++) {
            const b = partsB64[m.parts[i]];
            if (!b) throw new Error('missing uploaded part ' + m.parts[i]);
            const wire = Uint8Array.from(atob(b), c => c.charCodeAt(0));
            plain.push(await openPart(secrets, i, wire));
        }
        const all = new Uint8Array(plain.reduce((n, p) => n + p.length, 0));
        let o = 0; for (const p of plain) { all.set(p, o); o += p.length; }
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(all) });

        // Video: decode every frame, mean luma, the brightest frame is the flash.
        const vt = (await input.getPrimaryVideoTrack())!;
        const vcfg = (await vt.getDecoderConfig())!;
        const lumas: { t: number; y: number }[] = [];
        const errors: string[] = [];
        // Mean brightness from a 32x18 draw: synchronous, so every frame is
        // closed inside the callback and nothing piles up (400 open 720p
        // frames crashed the renderer in the first version).
        const canvas = new OffscreenCanvas(32, 18);
        const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
        const vdec = new VideoDecoder({
            output: (f) => {
                c2d.drawImage(f, 0, 0, 32, 18);
                f.close();
                const d = c2d.getImageData(0, 0, 32, 18).data;
                let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
                lumas.push({ t: f.timestamp / 1e6, y: s / (3 * 32 * 18) });
            },
            error: (e) => { errors.push('video: ' + e.message); },
        });
        vdec.configure(vcfg);
        for await (const p of new EncodedPacketSink(vt).packets()) {
            while (vdec.decodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
            vdec.decode(p.toEncodedVideoChunk());
        }
        await vdec.flush();
        vdec.close();
        lumas.sort((a, b) => a.t - b.t);
        const yMax = Math.max(...lumas.map(l => l.y)), yMin = Math.min(...lumas.map(l => l.y));
        const flash = lumas.filter(l => l.y > (yMax + yMin) / 2);

        // Audio: decode, find the first sample above threshold.
        const at = (await input.getPrimaryAudioTrack())!;
        const acfg = (await at.getDecoderConfig())!;
        const chunks: { t: number; pcm: Float32Array }[] = [];
        const adec = new AudioDecoder({
            output: (d) => { const pcm = new Float32Array(d.numberOfFrames); d.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' }); chunks.push({ t: d.timestamp / 1e6, pcm }); d.close(); },
            error: (e) => { errors.push('audio: ' + e.message); },
        });
        adec.configure(acfg);
        for await (const p of new EncodedPacketSink(at).packets()) {
            while (adec.decodeQueueSize > 16) await new Promise(r => setTimeout(r, 5));
            adec.decode(p.toEncodedAudioChunk());
        }
        await adec.flush();
        adec.close();
        chunks.sort((a, b) => a.t - b.t);
        // Burst onsets: a loud sample after at least 200 ms of quiet.
        const onsets: number[] = [];
        let peak = 0, lastLoud = -Infinity;
        for (const c of chunks) {
            for (let i = 0; i < c.pcm.length; i++) {
                const v = Math.abs(c.pcm[i]); if (v > peak) peak = v;
                if (v > 0.1) {
                    const t = c.t + i / acfg.sampleRate;
                    if (t - lastLoud > 0.2) onsets.push(t);
                    lastLoud = t;
                }
            }
        }
        // One bright frame per flash: consecutive bright timestamps collapse.
        const flashes: number[] = [];
        for (const f of flash) if (!flashes.length || f.t - flashes[flashes.length - 1] > 0.5) flashes.push(f.t);
        return {
            errors, durationMs: m.durationMs, videoFrames: lumas.length, yMin, yMax,
            flashes, brightFrames: flash.length, audioChunks: chunks.length, audioPeak: peak, onsets,
            // Per burst: audio onset minus its flash frame, ms (+ = audio late).
            errorsMs: flashes.map((t, i) => onsets[i] === undefined ? null : (onsets[i] - t) * 1000),
        };
    },
    async disarm() { await disarm('harness'); },
    truth() {
        const leads = window.__AV_EMU__.leads.map(l => l.leadMs);
        const sorted = [...leads].sort((a, b) => a - b);
        const q = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
        const t0 = window.__AV_TRUTH__?.v0 ?? 0;
        // The lead in effect around each burst (the packets scheduled within 200 ms after it).
        const around = (window.__AV_TRUTH__?.bursts ?? []).map(b => { const ls = window.__AV_EMU__.leads.filter(l => l.at >= b.burstAt && l.at < b.burstAt + 200).map(l => l.leadMs); return ls.length ? ls.reduce((x, y) => x + y, 0) / ls.length : null; });
        const suspendedStarts = window.__AV_EMU__.leads.filter(l => l.state !== 'running').length;
        return { truth: window.__AV_TRUTH__, presented: window.__AV_EMU__.presented().length, invoked: window.__AV_EMU__.log, diag: window.__AV_EMU__.diag, params: window.__AV_EMU__.params,
            lead: { n: leads.length, min: q(0), p50: q(0.5), max: q(0.999), first: leads[0] ?? null, aroundBursts: around, suspendedStarts, firstAtMs: (window.__AV_EMU__.leads[0]?.at ?? 0) - t0 } };
    },
};
window.__av = api;
