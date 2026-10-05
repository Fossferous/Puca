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
 *
 * The same file carries `saveFix`: the container fix a saved clip gets
 * (Fmp4SaveFix.java + ClipAssembler.java on the phone, api/clips/fmp4SaveFix.ts
 * on desktop and the web). Each case is a list of parts — built from the real
 * clip's parts, edited, or crafted to hurt the fix — a manifest duration, and
 * the file that comes out: its length, SHA-256 and outcome, the whole file for
 * the first case. BOTH suites must produce exactly that file from those parts,
 * so the phone and the PC save the same clip as the same bytes. The expected
 * outputs were first written from the JAVA side's results (its test prints
 * them when they are missing) and the TS port then had to match them;
 *   PUCA_UPDATE_SAVEFIX_VECTORS=1 npx vitest run src/tests/downloadVectors.test.ts
 * rewrites only `saveFix`, outputs from the TS port (=inputs: parts only, for
 * the Java side to fill) — and then DownloadVectorsTest must still pass.
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
import { ClipAssembler, MAX_MOOFS } from '../api/clips/fmp4SaveFix';

for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
    if (!(k in globalThis)) (globalThis as unknown as Record<string, unknown>)[k] = (webStreams as unknown as Record<string, unknown>)[k];
}

const VECTORS = join(__dirname, '..', '..', 'android', 'app', 'src', 'test', 'resources', 'download-vectors.json');
const FIXTURE = join(__dirname, 'fixtures', 'clip-avc-1s.mp4');
const UPDATE = process.env.PUCA_UPDATE_DOWNLOAD_VECTORS === '1';
const UPDATE_SAVEFIX = process.env.PUCA_UPDATE_SAVEFIX_VECTORS;

/** A piece of a part: literal bytes, a real clip part (optionally edited at
 *  offsets within it), or a unit repeated. DownloadVectorsTest.build reads
 *  the same shapes. */
type Seg = { hex: string } | { clip: number; edits?: [number, string][] } | { repeat: string | Seg[]; times: number };
interface SaveFixCase {
    name: string; durationMs: number; parts: Seg[][];
    outBytes?: number; outSha256?: string; outcome?: string; out?: string;
}

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
    saveFix?: { note: string; cases: SaveFixCase[] };
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
        // saveFix is built from the clip: run PUCA_UPDATE_SAVEFIX_VECTORS=1 after this
        v.saveFix = readVectors().saveFix;
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

// ---- the container fix a saved clip gets: shared cases ---------------------------

async function clipPlainsOf(v: Vectors): Promise<Uint8Array[]> {
    const s = secretsOf(v.clip);
    const out: Uint8Array[] = [];
    for (let i = 0; i < v.clip.parts.length; i++) out.push(await openPart(s, i, unb64(v.clip.parts[i].wire)));
    return out;
}

/** A part from its segments (DownloadVectorsTest.build is the Java twin). */
function buildPart(segs: Seg[], clip: Uint8Array[]): Uint8Array {
    const pieces: Uint8Array[] = [];
    for (const s of segs) {
        if ('hex' in s) {
            pieces.push(unhex(s.hex));
        } else if ('clip' in s) {
            const b = clip[s.clip].slice();
            for (const [at, hx] of s.edits ?? []) b.set(unhex(hx), at);
            pieces.push(b);
        } else {
            const unit = typeof s.repeat === 'string' ? unhex(s.repeat) : buildPart(s.repeat, clip);
            const r = new Uint8Array(unit.byteLength * s.times);
            for (let i = 0; i < s.times; i++) r.set(unit, i * unit.byteLength);
            pieces.push(r);
        }
    }
    return concat(pieces);
}

/** What the desktop and web Download write for these decrypted parts. */
function saveFixed(parts: Uint8Array[], durationMs: number): { bytes: Uint8Array; outcome: string } {
    const a = new ClipAssembler(durationMs, true);
    parts.forEach((p, i) => a.part(i, p));
    const r = a.finish();
    const bytes = concat(r.chunks);
    expect(bytes.byteLength).toBe(r.bytes);
    return { bytes, outcome: r.outcome };
}

// Box builders and a walker of their own (not the module's), as the Java
// hostile test has.
const be32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const latin = (t: string) => Uint8Array.from(t, (c) => c.charCodeAt(0));
function mkBox(type: string, ...kids: Uint8Array[]): Uint8Array {
    const body = concat(kids);
    return concat([be32(8 + body.byteLength), latin(type), body]);
}
/** A full box: version 0, the flags, then 32-bit fields. */
function mkFull(type: string, flags: number, ...fields: number[]): Uint8Array {
    const b = new Uint8Array(12 + 4 * fields.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, b.byteLength); b.set(latin(type), 4); dv.setUint32(8, flags & 0xffffff);
    fields.forEach((f, i) => dv.setUint32(12 + 4 * i, f >>> 0));
    return b;
}
/** traf for `track`: tfhd (default-base-is-moof | flags), tfdt v0 = 0, then the truns. */
function mkTraf(track: number, tfhdFlags: number, tfhdFields: number[], ...truns: Uint8Array[]): Uint8Array {
    return mkBox('traf', mkFull('tfhd', 0x020000 | tfhdFlags, track, ...tfhdFields), mkFull('tfdt', 0, 0), ...truns);
}
const EMPTY_MOOF = mkBox('moof');
const EMPTY_MDAT = mkBox('mdat');
/** An mfra holding one tfra (version 0, 1-byte numbers) of `n` entries, all pointing at `moofAt`. */
function mfraSegs(track: number, moofAt: number, n: number, withMfro = false): Seg[] {
    const entry = new Uint8Array(11); // time (4), moof_offset (4), traf/trun/sample numbers (1 each)
    new DataView(entry.buffer).setUint32(4, moofAt);
    const tfra = mkFull('tfra', 0, track, 0, n);
    new DataView(tfra.buffer).setUint32(0, 24 + 11 * n);
    const total = 8 + 24 + 11 * n + (withMfro ? 16 : 0);
    const segs: Seg[] = [{ hex: hex(concat([be32(total), latin('mfra'), tfra])) }, { repeat: hex(entry), times: n }];
    if (withMfro) segs.push({ hex: hex(mkFull('mfro', 0, total)) });
    return segs;
}
interface WBox { start: number; size: number; type: string }
function boxesIn(u8: Uint8Array, from: number, to: number): WBox[] {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: WBox[] = [];
    for (let o = from; o < to;) {
        const size = dv.getUint32(o);
        if (size < 8 || o + size > to) throw new Error(`walker: bad box at ${o}`);
        out.push({ start: o, size, type: String.fromCharCode(...u8.subarray(o + 4, o + 8)) });
        o += size;
    }
    return out;
}
const kidsOf = (u8: Uint8Array, b: WBox) => boxesIn(u8, b.start + 8, b.start + b.size);
const kidOf = (u8: Uint8Array, b: WBox, type: string) => {
    const k = kidsOf(u8, b).find((x) => x.type === type);
    if (!k) throw new Error(`walker: no ${type} in ${b.type}`);
    return k;
};
const u32At = (u8: Uint8Array, o: number) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(o);

/**
 * The cases: the real clip cut and labelled every way the phone can meet it,
 * and every shape Fmp4SaveFixHostileTest builds to hurt the fix, plus the
 * places the two languages' numbers differ (64-bit sizes, a track id past
 * 2^31, a duration x timescale past 2^64).
 */
function saveFixCases(clip: Uint8Array[]): SaveFixCase[] {
    const c0 = clip[0];
    const each = (i: number) => [{ clip: i }] as Seg[];
    const all = clip.map((_, i) => each(i));
    const withInit = (edits: [number, string][]) => [[{ clip: 0, edits }] as Seg[], ...all.slice(1)];
    const top = boxesIn(c0, 0, c0.length);
    const moov = top.find((b) => b.type === 'moov')!;
    expect(moov.start + moov.size, 'the init ends with its moov').toBe(c0.length);
    const mvhd = kidOf(c0, moov, 'mvhd');
    const mvex = kidOf(c0, moov, 'mvex');
    const traks = kidsOf(c0, moov).filter((b) => b.type === 'trak').map((t) => {
        const tkhd = kidOf(c0, t, 'tkhd'); const mdia = kidOf(c0, t, 'mdia');
        const mdhd = kidOf(c0, mdia, 'mdhd'); const hdlr = kidOf(c0, mdia, 'hdlr');
        expect(c0[tkhd.start + 8], 'tkhd version 0').toBe(0);
        expect(c0[mdhd.start + 8], 'mdhd version 0').toBe(0);
        return { tkhd, mdhd, id: u32At(c0, tkhd.start + 20), video: String.fromCharCode(...c0.subarray(hdlr.start + 16, hdlr.start + 20)) === 'vide' };
    });
    expect(c0[mvhd.start + 8], 'mvhd version 0').toBe(0);
    const video = traks.find((t) => t.video)!;
    const ref = video.id;
    const trex = kidsOf(c0, mvex).find((b) => b.type === 'trex' && u32At(c0, b.start + 12) === ref)!;
    // Part 1 starts with the first moof, so in the sealed file it sits right after the init.
    const moofAt = c0.byteLength;
    const lastIdx = clip.length - 1;
    const last = clip[lastIdx];
    const mfraAt = last.byteLength - u32At(last, last.byteLength - 4);
    expect(String.fromCharCode(...last.subarray(mfraAt + 4, mfraAt + 8))).toBe('mfra');
    const firstMoofOffsetAt = mfraAt + 8 + 24 + 8; // first tfra (v1), first entry's moof_offset
    const wrong = new DataView(last.buffer, last.byteOffset).getBigUint64(firstMoofOffsetAt) + 1n;
    const wrongHex = wrong.toString(16).padStart(16, '0');
    const junk = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const media = hex(concat([EMPTY_MOOF, EMPTY_MDAT]));
    const one = (moof: Uint8Array): Seg[][] => [[{ clip: 0 }], [{ hex: hex(concat([moof, EMPTY_MDAT])) }]];

    // a moof of 1000 trafs whose tfhd each carries a base_data_offset
    const baseTraf = mkTraf(ref, 0x1, [0, 0]);
    const baseMoofHead = concat([be32(8 + 1000 * baseTraf.byteLength), latin('moof')]);
    // reading stops at a box too short to be one, after an mfra that was rewritten
    const broken = concat([be32(4), latin('junk')]);
    // a tfdt near 2^63, then one sample
    const tfdtV1 = mkFull('tfdt', 0, 0x7fffffff, 0xffffff00);
    tfdtV1[8] = 1;
    // a moof too large to read: 9 MiB of a free box
    const bigMoofBody = 4096 * 2304;
    // the init stuffed with 5000 8-byte boxes inside its moov
    const stuffedMoov: [number, string][] = [[moov.start, hex(be32(moov.size + 5000 * 8))]];
    const free8 = hex(mkBox('free'));

    return [
        { name: 'the real clip', durationMs: 4000, parts: all },
        { name: 'the real clip, a manifest saying 0 ms', durationMs: 0, parts: all },
        { name: 'the real clip, the longest manifest (2^32 - 1 ms: 65,535 references reserved)', durationMs: 0xffffffff, parts: all },
        { name: 'the real clip, its init and first media part in one part', durationMs: 4000, parts: [[{ clip: 0 }, { clip: 1 }], ...all.slice(2)] },
        { name: 'the real clip as one part', durationMs: 4000, parts: [clip.map((_, i) => ({ clip: i }))] },
        { name: 'an mfra entry that points at no moof: the mfra is retired, the rest stands', durationMs: 4000, parts: [...all.slice(0, lastIdx), [{ clip: lastIdx, edits: [[firstMoofOffsetAt, wrongHex]] }]] },
        { name: 'an mehd already there: saved as sealed', durationMs: 4000, parts: withInit([[kidsOf(c0, mvex)[0].start + 4, hex(latin('mehd'))]]) },
        { name: 'no mvex: saved as sealed', durationMs: 4000, parts: withInit([[mvex.start + 4, hex(latin('free'))]]) },
        { name: 'a QuickTime brand: the phone saves it as a .mov, untouched', durationMs: 4000, parts: withInit([[8, hex(latin('qt  '))]]) },
        { name: 'an M4A brand: still an MP4, fixed', durationMs: 4000, parts: withInit([[8, hex(latin('M4A '))]]) },
        { name: 'not an MP4 at all', durationMs: 4000, parts: [[{ hex: hex(junk) }], each(1)] },
        { name: 'part 0 ending in half a box: init not recognised', durationMs: 4000, parts: [[{ clip: 0 }, { hex: hex(concat([be32(32), latin('free')])) }], ...all.slice(1)] },
        { name: 'an init stuffed with 5,000 tiny boxes: saved as sealed', durationMs: 4000, parts: [[{ clip: 0, edits: stuffedMoov }, { repeat: free8, times: 5000 }], [{ hex: media }]] },
        { name: 'a run declaring 2^32 - 1 samples, 64 times over', durationMs: 4000, parts: one(mkBox('moof', mkTraf(ref, 0, [], ...Array.from({ length: 64 }, () => mkFull('trun', 0, 0xffffffff))))) },
        { name: 'runs with no per-sample fields: count x the default', durationMs: 4000, parts: one(mkBox('moof', mkTraf(ref, 0x8, [1500], mkFull('trun', 0, 40), mkFull('trun', 0, 2)))) },
        { name: 'a run of 2^20 + 1 samples: not understood', durationMs: 4000, parts: one(mkBox('moof', mkTraf(ref, 0x8, [1500], mkFull('trun', 0, 0x100001)))) },
        { name: 'a tfdt near 2^63 plus one sample: no wrapped duration', durationMs: 4000, parts: one(mkBox('moof', mkBox('traf', mkFull('tfhd', 0x020000, ref), tfdtV1, mkFull('trun', 0x100, 1, 0x1000)))) },
        { name: 'a tfhd base_data_offset: an absolute offset that moves', durationMs: 4000, parts: one(mkBox('moof', mkTraf(ref, 0x1, [0, 1234], mkFull('trun', 0x100, 1, 3000)))) },
        { name: 'a flood of empty moofs, past MAX_MOOFS', durationMs: 4000, parts: [[{ clip: 0 }], [{ repeat: hex(EMPTY_MOOF), times: MAX_MOOFS + 20_000 }]] },
        { name: 'a flood of base-offset fragments, past MAX_PATCHES', durationMs: 4000, parts: [[{ clip: 0 }], [{ repeat: [{ hex: hex(baseMoofHead) }, { repeat: hex(baseTraf), times: 1000 }], times: 80 }]] },
        { name: 'a flood of index entries: two mfras fit the budget, three are retired whole', durationMs: 4000, parts: [[{ clip: 0 }], [{ hex: media }], [{ repeat: mfraSegs(ref, moofAt, 30_000), times: 5 }]] },
        { name: 'an mfra too large to read: retired unread', durationMs: 4000, parts: [[{ clip: 0 }], [{ hex: media }], mfraSegs(ref, moofAt, 800_000)] },
        { name: 'a moof too large to read: no index', durationMs: 4000, parts: [[{ clip: 0 }], [{ hex: hex(concat([be32(16 + bigMoofBody), latin('moof'), be32(8 + bigMoofBody), latin('free')])) }, { repeat: '00'.repeat(4096), times: 2304 }, { hex: hex(EMPTY_MDAT) }]] },
        { name: 'reading stops; the last mfra is found through its mfro and retired', durationMs: 4000, parts: [[{ clip: 0 }], [{ hex: media }], mfraSegs(ref, moofAt, 1), [{ hex: hex(broken) }], mfraSegs(ref, moofAt, 1, true)] },
        { name: 'a 64-bit box size past the end of the clip', durationMs: 4000, parts: [...all.slice(0, lastIdx), [{ clip: lastIdx }, { hex: '00000001' + hex(latin('free')) + '4000000000000000' }]] },
        { name: 'a 64-bit box size with its top bit set', durationMs: 4000, parts: [...all.slice(0, lastIdx), [{ clip: lastIdx }, { hex: '00000001' + hex(latin('free')) + '8000000000000010' }]] },
        { name: 'a track id past 2^31 (an int in Java, negative)', durationMs: 4000, parts: [[{ clip: 0, edits: [[video.tkhd.start + 20, '80000001'], [trex.start + 12, '80000001']] }], [{ hex: hex(concat([mkBox('moof', mkTraf(0x80000001, 0, [], mkFull('trun', 0x100, 1, 1500))), EMPTY_MDAT])) }]] },
        { name: 'timescales of 2^32 - 1 and the longest manifest: a duration x timescale past 2^64', durationMs: 0xffffffff, parts: [[{ clip: 0, edits: [[mvhd.start + 20, 'ffffffff'], ...traks.map((t) => [t.mdhd.start + 20, 'ffffffff'] as [number, string])] }], [{ hex: hex(concat([mkBox('moof', mkBox('traf', mkFull('tfhd', 0x020000, ref))), EMPTY_MDAT])) }]] },
    ];
}

/** Test-side inverse of the fix (independent code, DownloadVectorsTest.unfix's twin). */
function unfix(f: Uint8Array): Uint8Array {
    const g = f.slice();
    const dv = new DataView(g.buffer);
    const top = boxesIn(g, 0, g.length);
    const moov = top[1];
    for (const x of kidsOf(g, moov)) {
        if (x.type === 'mvhd') dv.setUint32(x.start + 24, 0);
        if (x.type === 'trak') {
            dv.setUint32(kidOf(g, x, 'tkhd').start + 28, 0);
            dv.setUint32(kidOf(g, kidOf(g, x, 'mdia'), 'mdhd').start + 24, 0);
        }
    }
    const mvex = kidOf(g, moov, 'mvex');
    const mehd = kidsOf(g, mvex)[0];
    expect(mehd.type).toBe('mehd');
    dv.setUint32(moov.start, moov.size - mehd.size);
    dv.setUint32(mvex.start, mvex.size - mehd.size);
    const regionStart = top[2].start, regionEnd = top[4].start;
    const shift = BigInt(mehd.size + (regionEnd - regionStart));
    for (const tfra of kidsOf(g, top[top.length - 1]).filter((b) => b.type === 'tfra')) {
        const n = dv.getUint32(tfra.start + 20);
        for (let i = 0; i < n; i++) {
            const at = tfra.start + 24 + 28 * i + 8;
            dv.setBigUint64(at, dv.getBigUint64(at) - shift);
        }
    }
    return concat([g.subarray(0, mehd.start), g.subarray(mehd.start + mehd.size, regionStart), g.subarray(regionEnd)]);
}

describe('shared container-fix vectors (Fmp4SaveFix.java and fmp4SaveFix.ts write the same file)', () => {
    it.runIf(UPDATE_SAVEFIX)('rewrites saveFix (parts only with =inputs; else with this port\'s outputs)', async () => {
        const v = readVectors();
        const clip = await clipPlainsOf(v);
        const cases = saveFixCases(clip);
        if (UPDATE_SAVEFIX !== 'inputs') {
            for (const c of cases) {
                const r = saveFixed(c.parts.map((segs) => buildPart(segs, clip)), c.durationMs);
                Object.assign(c, { outBytes: r.bytes.byteLength, outSha256: sha(r.bytes), outcome: r.outcome });
                if (c === cases[0]) c.out = b64(r.bytes);
            }
        }
        v.saveFix = {
            note: 'The container fix a saved clip gets: each case is parts (segments: hex, a real clip part with edits, or a unit repeated) and a manifest duration; the file out is what BOTH Fmp4SaveFix.java (DownloadVectorsTest) and api/clips/fmp4SaveFix.ts (downloadVectors.test.ts) must write. Do not edit by hand.',
            cases,
        };
        writeFileSync(VECTORS, JSON.stringify(v, null, 1) + '\n');
    }, 120_000);

    it('every case: the desktop and web save writes exactly the file the phone writes', async () => {
        const v = readVectors();
        const clip = await clipPlainsOf(v);
        const cases = v.saveFix?.cases ?? [];
        expect(cases.length).toBeGreaterThanOrEqual(28);
        const bad: string[] = [];
        for (const c of cases) {
            const r = saveFixed(c.parts.map((segs) => buildPart(segs, clip)), c.durationMs);
            const got = { outBytes: r.bytes.byteLength, outSha256: sha(r.bytes), outcome: r.outcome };
            if (got.outBytes !== c.outBytes || got.outSha256 !== c.outSha256 || got.outcome !== c.outcome) {
                bad.push(`${c.name}: expected ${c.outBytes} ${c.outSha256} "${c.outcome}", got ${got.outBytes} ${got.outSha256} "${got.outcome}"`);
            }
            if (c.out !== undefined) expect(b64(r.bytes), c.name).toBe(c.out);
        }
        expect(bad).toEqual([]);
    }, 60_000);

    it('the cases reach every outcome, and every one still saves a file', () => {
        const cases = readVectors().saveFix?.cases ?? [];
        const outcomes = new Set(cases.map((c) => c.outcome));
        for (const o of ['duration and seek index added', 'duration added (no seek index: fragments not understood)',
            'duration added (no seek index: too many fragments)', 'saved as sealed (init not recognised)', 'saved as sealed']) {
            expect(outcomes, o).toContain(o);
        }
        for (const c of cases) expect(c.outBytes, c.name).toBeGreaterThan(0);
    });

    it('the real clip, however it is cut into parts, is the same file', () => {
        const cases = readVectors().saveFix?.cases ?? [];
        const named = (name: string) => {
            const c = cases.find((x) => x.name === name);
            if (!c) throw new Error(`no case "${name}"`);
            return c;
        };
        const whole = named('the real clip');
        expect(whole.outcome).toBe('duration and seek index added');
        expect(named('the real clip, its init and first media part in one part').outSha256).toBe(whole.outSha256);
        expect(named('the real clip as one part').outSha256).toBe(whole.outSha256);
        // the manifest only sizes the reserved region: the file differs, the media does not
        expect(named('the real clip, a manifest saying 0 ms').outSha256).not.toBe(whole.outSha256);
    });

    it('undoing exactly the documented changes gives back the sealed clip, byte for byte', async () => {
        const v = readVectors();
        const clip = await clipPlainsOf(v);
        for (const durationMs of [4000, 0, 0xffffffff, 117]) {
            const { bytes, outcome } = saveFixed(clip.map((p) => p.slice()), durationMs);
            expect(outcome).toBe('duration and seek index added');
            expect(sha(bytes), 'the fix changed something').not.toBe(v.clip.plainSha256);
            expect(sha(unfix(bytes)), `undone, manifest ${durationMs} ms`).toBe(v.clip.plainSha256);
        }
    });

    it('without the fix the download is the plain concatenation (the control for the undo)', async () => {
        const v = readVectors();
        const clip = await clipPlainsOf(v);
        const a = new ClipAssembler(4000, false);
        clip.forEach((p, i) => a.part(i, p));
        const r = a.finish();
        expect(r.outcome).toBe('saved as sealed');
        expect(sha(concat(r.chunks))).toBe(v.clip.plainSha256);
    });
});
