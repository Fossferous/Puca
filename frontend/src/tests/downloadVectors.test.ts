// jsdom (the shared setup file needs `window`); Node streams are polyfilled below if jsdom lacks them.
/**
 * The SHARED vectors behind the Android app's native download path
 * (android/app/src/main/java/com/sovereign/app/DownloadCrypto.java,
 * Fmp4SaveFix.java, ClipAssembler.java).
 *
 * One file, two suites: `android/app/src/test/resources/download-vectors.json`
 * is read by the JUnit test DownloadVectorsTest, which must open every part
 * and attachment with the Java code and assemble the clip; THIS test proves
 * the file is exactly what the real JS sealing produces today —
 *   - each clip part re-seals (clipCrypto.ts sealPart, the desktop seal's
 *     function) to the identical wire bytes from its own plaintext and the
 *     recorded secrets, and opens with openPart;
 *   - the attachment is what attachments.ts sealFileForUpload writes for the
 *     recorded key and nonce;
 *   - the clip is a real mediabunny fragmented MP4 cut by the real
 *     Fmp4Splitter, with duration 0, no mehd and an mfra — the shape the
 *     native save has to fix.
 * So neither side can drift from the format without one of the two suites
 * failing.
 *
 * Regenerate (only when the FORMAT changes, which it must not silently):
 *   PUCA_UPDATE_DOWNLOAD_VECTORS=1 npx vitest run src/tests/downloadVectors.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink, Output, Mp4OutputFormat, AppendOnlyStreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } from 'mediabunny';
import * as webStreams from 'node:stream/web';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { sealPart, openPart, uuidToBytes, type ClipSecrets } from '../api/clips/clipCrypto';
import { Fmp4Splitter, PART_RAMP_FRAGMENTS, type SplitPart } from '../api/clips/fmp4Split';
import { sealFileForUpload } from '../api/attachments';

for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
    if (!(k in globalThis)) (globalThis as unknown as Record<string, unknown>)[k] = (webStreams as unknown as Record<string, unknown>)[k];
}

const VECTORS = join(__dirname, '..', '..', 'android', 'app', 'src', 'test', 'resources', 'download-vectors.json');
const FIXTURE = join(__dirname, 'fixtures', 'clip-avc-1s.mp4');
const UPDATE = process.env.PUCA_UPDATE_DOWNLOAD_VECTORS === '1';

interface ClipVectors {
    key: string; noncePrefix: string; clipId: string; durationMs: number;
    parts: { wire: string; plainSha256: string; plainBytes: number }[];
    plainSha256: string; plainBytes: number;
}
interface PartVector { index: number; wire: string; plain: string }
interface AttachmentVector { key: string; wire: string; plain: string; mime: string }
interface Vectors {
    note: string;
    clip: ClipVectors;
    extraParts: { key: string; noncePrefix: string; clipId: string; parts: PartVector[] };
    attachments: AttachmentVector[];
}

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const sha = (u: Uint8Array) => createHash('sha256').update(u).digest('hex');
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 17 + (i >> 3)) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
}

/**
 * A small clip shaped exactly like the desktop's: mediabunny, fragmented,
 * minimumFragmentDuration 1 (replayWorker.ts), the real avcC/AAC decoder
 * configs from the 1 s fixture, a keyframe every second for 4 s, audio
 * running a little past the video (the trailing audio-only fragment real
 * clips end with), cut by Fmp4Splitter with the seal's ramp. The packets are
 * stand-in bytes — this is about the container, not the picture.
 */
async function muxClip(): Promise<SplitPart[]> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(new Uint8Array(readFileSync(FIXTURE))) });
    const vdec = (await (await input.getPrimaryVideoTrack())!.getDecoderConfig())!;
    const at = (await input.getPrimaryAudioTrack())!;
    const adec = (await at.getDecoderConfig())!;
    const audio: EncodedPacket[] = [];
    for await (const p of new EncodedPacketSink(at).packets()) audio.push(p);
    const parts: SplitPart[] = [];
    const splitter = new Fmp4Splitter(1500, p => parts.push(p), PART_RAMP_FRAGMENTS);
    const writable = new WritableStream<Uint8Array>({ write(c) { splitter.push(c); } });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }), target: new AppendOnlyStreamTarget(writable) });
    const vs = new EncodedVideoPacketSource('avc'); output.addVideoTrack(vs);
    const as = new EncodedAudioPacketSource('aac'); output.addAudioTrack(as);
    await output.start();
    const fps = 10, seconds = 4;
    const aDur = audio[0].duration;
    let ai = 0;
    for (let f = 0; f < fps * seconds; f++) {
        const t = f / fps;
        const key = f % fps === 0;
        await vs.add(new EncodedPacket(pattern(key ? 90 : 24, f), key ? 'key' : 'delta', t, 1 / fps), f === 0 ? { decoderConfig: vdec } : undefined);
        // audio up to the end of this video frame (and 0.15 s past the last one)
        const until = f === fps * seconds - 1 ? seconds + 0.15 : t + 1 / fps;
        while (ai * aDur < until) {
            await as.add(new EncodedPacket(pattern(16, ai), 'key', ai * aDur, aDur), ai === 0 ? { decoderConfig: adec } : undefined);
            ai++;
        }
    }
    await output.finalize();
    splitter.end();
    return parts;
}

function readVectors(): Vectors {
    return JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors;
}

function secretsOf(v: { key: string; noncePrefix: string; clipId: string }): ClipSecrets {
    return { key: unb64(v.key), noncePrefix: unb64(v.noncePrefix), clipId: uuidToBytes(v.clipId) };
}

/** sealFileForUpload draws the key, then the nonce, from getRandomValues. */
function rigRandom(key: Uint8Array, nonce: Uint8Array) {
    const queue = [key, nonce];
    return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
        const next = queue.shift();
        if (!next || !arr || arr.byteLength !== next.byteLength) throw new Error('unexpected getRandomValues call');
        new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).set(next);
        return arr;
    });
}

async function sealAttachment(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, mime: string): Promise<{ key: string; wire: Uint8Array }> {
    // jsdom's Blob and File have no arrayBuffer(); Node's do, and they are
    // what sealFileForUpload reads and builds here.
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('File', NodeFile);
    const spy = rigRandom(key, nonce);
    try {
        const sealed = await sealFileForUpload(new NodeFile([plain], 'v.bin', { type: mime }) as unknown as File);
        return { key: sealed.key, wire: new Uint8Array(await sealed.blob.arrayBuffer()) };
    } finally {
        spy.mockRestore();
        vi.unstubAllGlobals();
    }
}

async function generate(): Promise<Vectors> {
    const secrets: ClipSecrets = { key: pattern(32, 1), noncePrefix: pattern(8, 2), clipId: uuidToBytes('5f243cae-0b1d-4c2e-9a7f-30e62651d0f5') };
    const parts = await muxClip();
    const clipParts = [];
    for (const p of parts) {
        const wire = await sealPart(secrets, p.index, p.bytes);
        clipParts.push({ wire: b64(wire), plainSha256: sha(p.bytes), plainBytes: p.bytes.byteLength });
    }
    const whole = concat(parts.map(p => p.bytes));
    const extra = { key: pattern(32, 9), noncePrefix: pattern(8, 10), clipId: uuidToBytes('00ff10ee-2233-4455-8899-aabbccddeeff') };
    const extraParts: PartVector[] = [];
    for (const [index, plain] of [[0, pattern(1121, 3)], [513, pattern(700, 4)], [65535, pattern(40, 5)], [2, new Uint8Array(0)]] as const) {
        extraParts.push({ index, wire: b64(await sealPart(extra, index, plain)), plain: hex(plain) });
    }
    // A key whose base64url carries both '-' and '_' (bytes 0xfb 0xff).
    const k1 = Uint8Array.from({ length: 32 }, (_, i) => (i % 2 ? 0xff : 0xfb));
    const a1 = await sealAttachment(k1, pattern(12, 6), new TextEncoder().encode('an ordinary attachment: þúça, 1 2 3'), 'text/plain');
    const a2 = await sealAttachment(pattern(32, 7), pattern(12, 8), pattern(4096, 11), 'video/mp4');
    return {
        note: 'Generated by frontend/src/tests/downloadVectors.test.ts from the REAL JS sealing; checked there and by DownloadVectorsTest.java. Do not edit by hand.',
        clip: {
            key: b64(secrets.key), noncePrefix: b64(secrets.noncePrefix), clipId: '5f243cae-0b1d-4c2e-9a7f-30e62651d0f5',
            durationMs: 4000, parts: clipParts, plainSha256: sha(whole), plainBytes: whole.byteLength,
        },
        extraParts: { key: b64(extra.key), noncePrefix: b64(extra.noncePrefix), clipId: '00ff10ee-2233-4455-8899-aabbccddeeff', parts: extraParts },
        attachments: [
            { key: a1.key, wire: b64(a1.wire), plain: hex(new TextEncoder().encode('an ordinary attachment: þúça, 1 2 3')), mime: 'text/plain' },
            { key: a2.key, wire: b64(a2.wire), plain: hex(pattern(4096, 11)), mime: 'video/mp4' },
        ],
    };
}

function boxAt(u8: Uint8Array, off: number): { type: string; size: number } {
    const size = new DataView(u8.buffer, u8.byteOffset).getUint32(off);
    return { type: String.fromCharCode(...u8.subarray(off + 4, off + 8)), size };
}

describe('shared download vectors (JS seal -> Java native download)', () => {
    afterEach(() => vi.restoreAllMocks());

    it.runIf(UPDATE)('regenerates the vectors from the real JS sealing', async () => {
        const v = await generate();
        writeFileSync(VECTORS, JSON.stringify(v, null, 1) + '\n');
    }, 60_000);

    it('every clip part is exactly what sealPart produces, and opens with openPart', async () => {
        const v = readVectors();
        const s = secretsOf(v.clip);
        const plains: Uint8Array[] = [];
        expect(v.clip.parts.length).toBeGreaterThanOrEqual(4); // init + several media parts
        for (let i = 0; i < v.clip.parts.length; i++) {
            const wire = unb64(v.clip.parts[i].wire);
            const plain = await openPart(s, i, wire);
            expect(sha(plain)).toBe(v.clip.parts[i].plainSha256);
            expect(plain.byteLength).toBe(v.clip.parts[i].plainBytes);
            expect(b64(await sealPart(s, i, plain))).toBe(v.clip.parts[i].wire);
            plains.push(plain);
        }
        const whole = concat(plains);
        expect(sha(whole)).toBe(v.clip.plainSha256);
        expect(whole.byteLength).toBe(v.clip.plainBytes);
    });

    it('the clip is the shape a desktop seal writes: fragmented, no mehd, duration 0, an mfra at the end', async () => {
        const v = readVectors();
        const s = secretsOf(v.clip);
        const plains: Uint8Array[] = [];
        for (let i = 0; i < v.clip.parts.length; i++) plains.push(await openPart(s, i, unb64(v.clip.parts[i].wire)));
        const whole = concat(plains);
        // part 0 is the init only; every media part starts with a moof
        expect(boxAt(plains[0], 0).type).toBe('ftyp');
        for (const p of plains.slice(1)) expect(boxAt(p, 0).type).toBe('moof');
        const text = Buffer.from(plains[0]).toString('latin1');
        expect(text.includes('mvex')).toBe(true);
        expect(text.includes('mehd')).toBe(false);
        const mfro = boxAt(whole, whole.byteLength - 16);
        expect(mfro.type).toBe('mfro');
        expect(boxAt(whole, whole.byteLength - new DataView(whole.buffer).getUint32(whole.byteLength - 4)).type).toBe('mfra');
        // a real MP4 that mediabunny itself reads back, two tracks, ~4 s
        const back = new Input({ formats: ALL_FORMATS, source: new BufferSource(whole) });
        expect((await back.getTracks()).length).toBe(2);
        expect(await back.computeDuration()).toBeGreaterThan(3.9);
    }, 30_000);

    it('edge parts (index 0, 513, 65535, an empty part) are sealPart output', async () => {
        const v = readVectors();
        const s = secretsOf(v.extraParts);
        for (const p of v.extraParts.parts) {
            expect(b64(await sealPart(s, p.index, unhex(p.plain)))).toBe(p.wire);
            expect(hex(await openPart(s, p.index, unb64(p.wire)))).toBe(p.plain);
        }
    });

    it('attachments are what sealFileForUpload writes for the recorded key and nonce', async () => {
        const v = readVectors();
        expect(v.attachments.some(a => /-/.test(a.key) && /_/.test(a.key))).toBe(true); // the url-safe alphabet is exercised
        for (const a of v.attachments) {
            const wire = unb64(a.wire);
            const keyBytes = unb64(a.key.replace(/-/g, '+').replace(/_/g, '/'));
            expect(b64url(keyBytes)).toBe(a.key);
            const again = await sealAttachment(keyBytes, wire.subarray(0, 12), unhex(a.plain), a.mime);
            expect(again.key).toBe(a.key);
            expect(b64(again.wire)).toBe(a.wire);
        }
    });
});
