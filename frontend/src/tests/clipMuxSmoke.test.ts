// jsdom (the shared setup file needs `window`); Node streams are polyfilled below if jsdom lacks them.
/**
 * Real-muxer smoke test: demux a 1 s fixture cut from a real WebCodecs capture
 * (headless Edge, avc1.640029 + AAC), re-mux it FRAGMENTED through mediabunny
 * exactly as replayWorker.seal does, split with Fmp4Splitter, and prove:
 *   - part 0 is the init segment (ftyp+moov, no moof),
 *   - every later part starts with a moof and carries a real fragment start time,
 *   - the concatenation re-parses as a valid MP4 with the same codecs/duration,
 *   - the decoderConfig (avcC description) survived — without it the file has
 *     no codec string and shows as a black screen in most players.
 * The synthetic fmp4Split test cannot prove any of this against a real muxer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink, Output, Mp4OutputFormat, AppendOnlyStreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
import { Fmp4Splitter, parseTimescales, type SplitPart } from '../api/clips/fmp4Split';
import * as webStreams from 'node:stream/web';

// jsdom does not ship WHATWG streams; Node does. mediabunny's targets need them.
for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
    if (!(k in globalThis)) (globalThis as unknown as Record<string, unknown>)[k] = (webStreams as unknown as Record<string, unknown>)[k];
}

const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'clip-avc-1s.mp4')));
const fourcc = (u8: Uint8Array, off = 4) => String.fromCharCode(...u8.subarray(off, off + 4));

async function remuxSplit(budget: number): Promise<{ parts: SplitPart[]; concat: Uint8Array; vcodec: string; acodec: string }> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(fixture) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const at = (await input.getPrimaryAudioTrack())!;
    const vdec = (await vt.getDecoderConfig())!;
    const adec = (await at.getDecoderConfig())!;
    const parts: SplitPart[] = [];
    const splitter = new Fmp4Splitter(budget, p => parts.push(p));
    const writable = new WritableStream<Uint8Array>({ write(c) { splitter.push(c); } });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.25 }), target: new AppendOnlyStreamTarget(writable) });
    const vs = new EncodedVideoPacketSource('avc'); output.addVideoTrack(vs);
    const as = new EncodedAudioPacketSource('aac'); output.addAudioTrack(as);
    await output.start();
    let first = true;
    for await (const p of new EncodedPacketSink(vt).packets()) { await vs.add(p, first ? { decoderConfig: vdec } : undefined); first = false; }
    first = true;
    for await (const p of new EncodedPacketSink(at).packets()) { await as.add(p, first ? { decoderConfig: adec } : undefined); first = false; }
    await output.finalize();
    splitter.end();
    const total = parts.reduce((a, p) => a + p.bytes.byteLength, 0);
    const concat = new Uint8Array(total); let o = 0;
    for (const p of parts) { concat.set(p.bytes, o); o += p.bytes.byteLength; }
    return { parts, concat, vcodec: vdec.codec, acodec: adec.codec };
}

describe('clip mux smoke (real mediabunny output)', () => {
    it('fixture is a real capture with an avcC description', async () => {
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(fixture) });
        const vt = (await input.getPrimaryVideoTrack())!;
        const dc = (await vt.getDecoderConfig())!;
        expect(dc.codec).toMatch(/^avc1\./);
        expect(dc.description).toBeTruthy();
        expect(await vt.computeDuration()).toBeGreaterThan(0.5);
    }, 30_000);

    it('splits fragmented output into init + moof-aligned parts that concatenate back to a valid file', async () => {
        const { parts, concat, vcodec, acodec } = await remuxSplit(300 * 1024);
        expect(parts.length).toBeGreaterThanOrEqual(3); // init + ≥2 fragment parts at a 300 KB budget
        expect(parts[0].isInit).toBe(true);
        expect(fourcc(parts[0].bytes)).toBe('ftyp');
        expect(parts[0].bytes.byteLength).toBeLessThan(8 * 1024); // an init segment is a few KB, never a 24 MiB part
        expect(parseTimescales(findBox(parts[0].bytes, 'moov')!).size).toBe(2);
        let prev = -1;
        for (const p of parts.slice(1)) {
            expect(p.isInit).toBe(false);
            expect(fourcc(p.bytes)).toBe('moof');
            expect(p.fragments).toBeGreaterThan(0);
            expect(p.startS).not.toBeNull();
            expect(p.startS!).toBeGreaterThanOrEqual(prev);
            prev = p.startS!;
        }
        // The concatenation is a valid MP4 with the same tracks.
        const back = new Input({ formats: ALL_FORMATS, source: new BufferSource(concat) });
        const vt = (await back.getPrimaryVideoTrack())!;
        const at = (await back.getPrimaryAudioTrack())!;
        expect((await vt.getDecoderConfig())!.codec).toBe(vcodec);
        expect((await at.getDecoderConfig())!.codec).toBe(acodec);
        expect(await vt.computeDuration()).toBeGreaterThan(0.5);
        expect(await at.computeDuration()).toBeGreaterThan(0.5);
    }, 60_000);

    it('a huge budget yields exactly init + one part (no needless cuts)', async () => {
        const { parts } = await remuxSplit(100 * 1024 * 1024);
        expect(parts.length).toBe(2);
        expect(parts[1].fragments).toBeGreaterThan(1);
    }, 60_000);
});

function findBox(u8: Uint8Array, type: string): Uint8Array | null {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0;
    while (off + 8 <= u8.byteLength) {
        const size = dv.getUint32(off);
        if (fourcc(u8, off + 4) === type) return u8.subarray(off, off + size);
        if (size < 8) break;
        off += size;
    }
    return null;
}
