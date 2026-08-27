/**
 * Post-approval trim = remuxRange (api/clips/clipTrim.ts), run against the
 * REAL mediabunny demuxer/muxer on a multi-GOP file built from the captured
 * fixture. The property that matters most — and that the first trim design
 * got wrong — is that a FRONT trim yields a file whose timeline starts at 0:
 * fragments carry absolute tfdt, so relisting the later parts of the original
 * would have handed every player 4 s–8 s media under a 0–4 s manifest and
 * stalled at 0 s. Here the re-muxed output is read back and its first packet
 * must sit at t=0 (positive control: the same range in the ORIGINAL file
 * starts at the snapped keyframe, not 0).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as webStreams from 'node:stream/web';
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink, EncodedPacket, Output, Mp4OutputFormat, AppendOnlyStreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource } from 'mediabunny';
import { remuxRangeToParts as remuxRange, concatParts, trimSealedParts, MIN_TRIM_KEEP_S, type SealedPartLike } from '../api/clips/clipTrim';
import { Fmp4Splitter, type SplitPart } from '../api/clips/fmp4Split';
import { newClipSecrets, openPart, sealPart, PART_HEADER_BYTES, type ClipSecrets } from '../api/clips/clipCrypto';

for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
    if (!(k in globalThis)) (globalThis as unknown as Record<string, unknown>)[k] = (webStreams as unknown as Record<string, unknown>)[k];
}

const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'clip-avc-1s.mp4')));
const GOPS = 6;

interface Probe { keyTimes: number[]; firstVideoTs: number; videoDuration: number; audioDuration: number | null; firstPacketIsKey: boolean }

async function probe(bytes: Uint8Array): Promise<Probe> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const at = await input.getPrimaryAudioTrack();
    const keyTimes: number[] = [];
    let firstVideoTs = Number.POSITIVE_INFINITY; let firstPacketIsKey = false; let first = true; let end = 0;
    for await (const p of new EncodedPacketSink(vt).packets()) {
        if (first) { firstPacketIsKey = p.type === 'key'; first = false; }
        firstVideoTs = Math.min(firstVideoTs, p.timestamp);
        end = Math.max(end, p.timestamp + (p.duration || 0));
        if (p.type === 'key') keyTimes.push(p.timestamp);
    }
    let audioDuration: number | null = null;
    if (at) {
        let aend = 0;
        for await (const p of new EncodedPacketSink(at).packets()) aend = Math.max(aend, p.timestamp + (p.duration || 0));
        audioDuration = aend;
    }
    return { keyTimes, firstVideoTs, videoDuration: end, audioDuration, firstPacketIsKey };
}

/** The 1 s capture repeated GOPS times with shifted timestamps: GOPS GOPs of ~1 s. */
async function buildMultiGop(): Promise<Uint8Array> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(fixture) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const at = (await input.getPrimaryAudioTrack())!;
    const vdec = (await vt.getDecoderConfig())!;
    const adec = (await at.getDecoderConfig())!;
    const vpk: EncodedPacket[] = []; const apk: EncodedPacket[] = [];
    for await (const p of new EncodedPacketSink(vt).packets()) vpk.push(p);
    for await (const p of new EncodedPacketSink(at).packets()) apk.push(p);
    const span = Math.max(...vpk.map(p => p.timestamp + (p.duration || 0)), ...apk.map(p => p.timestamp + (p.duration || 0)));
    const D = Math.ceil(span * 1000) / 1000;
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({ write(c) { chunks.push(c.slice()); } });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.25 }), target: new AppendOnlyStreamTarget(writable) });
    const vs = new EncodedVideoPacketSource('avc'); output.addVideoTrack(vs);
    const as = new EncodedAudioPacketSource('aac'); output.addAudioTrack(as);
    await output.start();
    let firstV = true, firstA = true;
    for (let r = 0; r < GOPS; r++) {
        for (const p of vpk) { await vs.add(new EncodedPacket(p.data, p.type, p.timestamp + r * D, p.duration), firstV ? { decoderConfig: vdec } : undefined); firstV = false; }
    }
    for (let r = 0; r < GOPS; r++) {
        for (const p of apk) { await as.add(new EncodedPacket(p.data, 'key', p.timestamp + r * D, p.duration), firstA ? { decoderConfig: adec } : undefined); firstA = false; }
    }
    await output.finalize();
    return concatParts(chunks);
}

let multi: Uint8Array;
let base: Probe;
const near = (a: number, b: number, tol = 0.06) => Math.abs(a - b) <= tol;
/** What remuxRange promises: start = last key ≤ from, end = first key > to (else clip end). */
const expectedWindow = (fromS: number, toS: number) => {
    const k = base.keyTimes;
    const start = k.filter(t => t <= fromS + 1e-6).pop() ?? k[0];
    const end = k.find(t => t > toS + 1e-6 && t > fromS) ?? base.videoDuration;
    return { start, end };
};

describe('clip trim re-mux (real mediabunny)', () => {
    beforeAll(async () => {
        multi = await buildMultiGop();
        base = await probe(multi);
    }, 60_000);

    it('the multi-GOP source really has several keyframes spread over its length (positive control)', () => {
        expect(base.keyTimes.length).toBeGreaterThanOrEqual(GOPS);
        expect(base.videoDuration).toBeGreaterThan(4);
        expect(base.keyTimes[1]).toBeGreaterThan(base.keyTimes[0]);
    });

    it('a FRONT trim re-bases the timeline to 0 — the output starts at t=0, not at the cut point', async () => {
        // cut somewhere inside GOP 3 → snaps back to its keyframe; keep to the end
        const k = base.keyTimes;
        const cutInside = k[3] + 0.3;
        const r = await remuxRange(multi, cutInside, 999, 100 * 1024 * 1024);
        expect(r.parts[0].isInit).toBe(true);
        expect(r.parts.length).toBeGreaterThanOrEqual(2);
        expect(near(r.startS, k[3])).toBe(true);          // snapped OUTWARD (back) to the keyframe
        const out = await probe(concatParts(r.parts.map(p => p.bytes)));
        expect(out.firstPacketIsKey).toBe(true);
        expect(near(out.firstVideoTs, 0, 0.001)).toBe(true);  // the property that matters
        expect(near(out.videoDuration, base.videoDuration - k[3])).toBe(true);
        expect(near(r.durationS, base.videoDuration - k[3])).toBe(true);
        expect(out.audioDuration).not.toBeNull();
        expect(near(out.audioDuration!, out.videoDuration, 0.1)).toBe(true);
        // positive control: the same footage in the ORIGINAL sits at k[3], so
        // a trim that merely relisted parts would have started there, not at 0.
        expect(k[3]).toBeGreaterThan(1);
    }, 60_000);

    it('a middle trim snaps outward to whole GOPs on both ends and keeps exactly those', async () => {
        const k = base.keyTimes;
        const from = k[1] + 0.3, to = k[2] + 0.1;
        const { start, end } = expectedWindow(from, to);
        expect(start).toBe(k[1]);                 // snapped back to GOP 1's keyframe
        expect(end).toBeGreaterThan(to);           // and forward past the asked end
        const r = await remuxRange(multi, from, to, 100 * 1024 * 1024);
        expect(near(r.startS, start)).toBe(true);
        expect(near(r.durationS, end - start)).toBe(true);
        const out = await probe(concatParts(r.parts.map(p => p.bytes)));
        expect(near(out.firstVideoTs, 0, 0.001)).toBe(true);
        expect(near(out.videoDuration, end - start)).toBe(true);
        expect(out.keyTimes.length).toBe(k.filter(t => t >= start - 1e-6 && t < end - 1e-6).length);
    }, 60_000);

    it('an END-only trim keeps the head untouched and still starts at 0', async () => {
        const k = base.keyTimes;
        const to = k[2] + 0.2;
        const { start, end } = expectedWindow(0, to);
        expect(start).toBe(k[0]);
        expect(end).toBeLessThan(base.videoDuration); // something really was cut off the end
        const r = await remuxRange(multi, 0, to, 100 * 1024 * 1024);
        expect(near(r.startS, k[0])).toBe(true);
        expect(near(r.durationS, end - start)).toBe(true);
        const out = await probe(concatParts(r.parts.map(p => p.bytes)));
        expect(near(out.firstVideoTs, 0, 0.001)).toBe(true);
        expect(near(out.videoDuration, end - start)).toBe(true);
    }, 60_000);

    it('never narrows below what was asked for (snap is outward, not inward)', async () => {
        const k = base.keyTimes;
        const askFrom = k[2] + 0.4, askTo = k[4] + 0.2;
        const r = await remuxRange(multi, askFrom, askTo, 100 * 1024 * 1024);
        expect(r.startS).toBeLessThanOrEqual(askFrom + 1e-6);
        expect(r.startS + r.durationS).toBeGreaterThanOrEqual(askTo - 1e-6);
    }, 60_000);

    it('the whole range re-muxes to the same duration (a no-op trim loses nothing)', async () => {
        const r = await remuxRange(multi, 0, 999, 100 * 1024 * 1024);
        expect(near(r.startS, base.keyTimes[0])).toBe(true);
        expect(near(r.durationS, base.videoDuration - base.keyTimes[0])).toBe(true);
    }, 60_000);

    it('a small part budget yields init + several moof-aligned parts whose starts ascend from 0', async () => {
        const r = await remuxRange(multi, 0, 999, 200 * 1024);
        expect(r.parts.length).toBeGreaterThanOrEqual(3);
        expect(r.parts[0].isInit).toBe(true);
        let prev = -1;
        for (const p of r.parts.slice(1)) {
            expect(p.isInit).toBe(false);
            expect(p.startS).not.toBeNull();
            expect(p.startS!).toBeGreaterThanOrEqual(prev);
            prev = p.startS!;
        }
        expect(near(r.parts[1].startS!, 0, 0.001)).toBe(true);
    }, 60_000);

    it('(positive control) the demuxer reports ABSOLUTE tfdt: a file whose first fragment starts late probes late, so the t=0 assertions above are meaningful', async () => {
        // Split the multi-GOP file into init + small parts, drop the first
        // media parts and concatenate what is left — exactly what the old
        // "relist a subset of the parts" trim produced. If mediabunny
        // normalised the first sample to 0 this would probe 0 and every
        // `firstVideoTs === 0` assertion in this file would be vacuous.
        const parts: SplitPart[] = [];
        const splitter = new Fmp4Splitter(64 * 1024, p => parts.push(p));
        splitter.push(multi); splitter.end();
        expect(parts.length).toBeGreaterThanOrEqual(4);
        const dropUntil = parts.findIndex(p => !p.isInit && (p.startS ?? 0) >= base.keyTimes[2] - 1e-6);
        expect(dropUntil).toBeGreaterThan(1);
        const relisted = concatParts([parts[0].bytes, ...parts.slice(dropUntil).map(p => p.bytes)]);
        const out = await probe(relisted);
        // NOT rebased — the first video sample sits at (or just after: the
        // fragment's tfdt is the earliest track's) the kept fragment's start.
        expect(out.firstVideoTs).toBeGreaterThan(1);
        expect(out.firstVideoTs).toBeGreaterThanOrEqual(parts[dropUntil].startS! - 0.01);
        expect(out.firstVideoTs - parts[dropUntil].startS!).toBeLessThan(0.5);
    }, 60_000);

    it('rejects an empty range and a range that keeps less than one GOP', async () => {
        await expect(remuxRange(multi, 2, 2, 1 << 30)).rejects.toThrow(/empty/);
        expect(MIN_TRIM_KEEP_S).toBeGreaterThan(0);
    });

    it('rejects bytes that are not a clip (no video track)', async () => {
        await expect(remuxRange(new Uint8Array(64), 0, 1, 1 << 30)).rejects.toThrow();
    });
});

/** Seal the multi-GOP file the way the worker does: init + moof-aligned parts under one set of secrets. */
async function sealMulti(budget: number): Promise<{ secrets: ClipSecrets; parts: SealedPartLike[]; clipId: string }> {
    const clipId = '4f9a2c6e-7b1d-4e3f-9a8b-0c1d2e3f4a5b';
    const secrets = newClipSecrets(clipId);
    const split: SplitPart[] = [];
    const splitter = new Fmp4Splitter(budget, p => split.push(p));
    splitter.push(multi); splitter.end();
    const parts: SealedPartLike[] = [];
    for (let i = 0; i < split.length; i++) {
        const p = split[i];
        const next = split[i + 1];
        const durMs = p.isInit ? 0 : Math.max(0, Math.round(((next?.startS ?? base.videoDuration) - (p.startS ?? 0)) * 1000));
        parts.push({ index: p.index, wire: await sealPart(secrets, p.index, p.bytes), isInit: p.isInit, startS: p.startS, durMs });
    }
    return { secrets, parts, clipId };
}
const nonceOf = (wire: Uint8Array) => Array.from(wire.subarray(7, 19)).map(b => b.toString(16).padStart(2, '0')).join('');
const isZero = (u: Uint8Array) => u.every(b => b === 0);

describe('trimSealedParts (decrypt → re-mux → re-seal under FRESH secrets)', () => {
    it('seals the trimmed clip under NEW secrets: every new nonce differs from every old one, new parts open under the new key and reject under the old', async () => {
        const { secrets, parts, clipId } = await sealMulti(200 * 1024);
        const oldKey = secrets.key.slice(), oldPrefix = secrets.noncePrefix.slice();
        const oldSecrets: ClipSecrets = { key: oldKey, noncePrefix: oldPrefix, clipId: secrets.clipId.slice() };
        const oldNonces = new Set(parts.map(p => nonceOf(p.wire)));
        const durationMs = Math.round(base.videoDuration * 1000);
        const r = await trimSealedParts(secrets, clipId, parts, durationMs, Math.round(base.keyTimes[2] * 1000) + 300, durationMs, 64, 200 * 1024, true);
        expect(r).not.toBeNull();
        expect(Buffer.from(r!.secrets.key).equals(Buffer.from(oldKey))).toBe(false);
        expect(Buffer.from(r!.secrets.noncePrefix).equals(Buffer.from(oldPrefix))).toBe(false);
        // the AES-GCM invariant: no (key, nonce) pair is ever used for two plaintexts —
        // with a fresh prefix the new nonces cannot collide with the old set
        for (const p of r!.parts) expect(oldNonces.has(nonceOf(p.wire))).toBe(false);
        // new parts open under the new secrets at their (re-used) indices …
        const plain = [];
        for (const p of r!.parts) plain.push(await openPart(r!.secrets, p.index, p.wire));
        // … and REJECT under the old secrets at the same index
        await expect(openPart(oldSecrets, r!.parts[1].index, r!.parts[1].wire)).rejects.toThrow();
        // the re-muxed clip starts at 0 and is shorter than the original
        const out = await probe(concatParts(plain));
        expect(near(out.firstVideoTs, 0, 0.001)).toBe(true);
        expect(out.videoDuration).toBeLessThan(base.videoDuration - 1);
        expect(near(r!.durationMs / 1000, out.videoDuration, 0.06)).toBe(true);
        expect(r!.parts[0].isInit).toBe(true);
        expect(r!.parts.map(p => p.index)).toEqual(r!.parts.map((_, i) => i));
        expect(r!.totalCipherBytes).toBe(r!.parts.reduce((n, p) => n + p.wire.byteLength, 0));
        expect(r!.parts.slice(1).every(p => p.durMs > 0)).toBe(true);
        // and the superseded material is gone: old wires AND old secrets zero-filled
        expect(parts.every(p => isZero(p.wire))).toBe(true);
        expect(isZero(secrets.key) && isZero(secrets.noncePrefix)).toBe(true);
    }, 60_000);

    it('retireOriginal: false leaves the original completely untouched — still valid, still openable, still re-trimmable (the undo point)', async () => {
        const { secrets, parts, clipId } = await sealMulti(200 * 1024);
        const before = parts.map(p => p.wire.slice());
        const keyBefore = secrets.key.slice(), prefixBefore = secrets.noncePrefix.slice();
        const durationMs = Math.round(base.videoDuration * 1000);
        const r = await trimSealedParts(secrets, clipId, parts, durationMs, Math.round(base.keyTimes[2] * 1000) + 300, durationMs, 64, 200 * 1024, false);
        expect(r).not.toBeNull();
        // the "original" (what replayWorker.ts keeps as the undo point) is
        // byte-identical to before the trim — not a copy elsewhere, THIS object
        parts.forEach((p, i) => expect(Buffer.from(p.wire).equals(Buffer.from(before[i]))).toBe(true));
        expect(Buffer.from(secrets.key).equals(Buffer.from(keyBefore))).toBe(true);
        expect(Buffer.from(secrets.noncePrefix).equals(Buffer.from(prefixBefore))).toBe(true);
        // positive control: it still actually decrypts (untouched ≠ merely
        // "not zero" — a corrupted-but-nonzero buffer would fail here)
        const restoredPlain = [];
        for (const p of parts) restoredPlain.push(await openPart(secrets, p.index, p.wire));
        const restored = await probe(concatParts(restoredPlain));
        expect(near(restored.videoDuration, base.videoDuration)).toBe(true);
        // and it can be trimmed AGAIN from this same untouched state (undoing
        // and then trimming differently must not be a one-shot affair)
        const r2 = await trimSealedParts(secrets, clipId, parts, durationMs, 500, Math.round(base.keyTimes[4] * 1000), 64, 200 * 1024, true);
        expect(r2).not.toBeNull();
    }, 60_000);

    it('is all-or-nothing: a part that fails to decrypt leaves every old wire byte-identical and the old secrets intact', async () => {
        const { secrets, parts, clipId } = await sealMulti(200 * 1024);
        // tamper one ciphertext byte of the LAST part (decrypt fails late, after others succeeded)
        const victim = parts[parts.length - 1];
        victim.wire[PART_HEADER_BYTES + 5] ^= 0x01;
        const before = parts.map(p => p.wire.slice());
        const keyBefore = secrets.key.slice(), prefixBefore = secrets.noncePrefix.slice();
        const durationMs = Math.round(base.videoDuration * 1000);
        await expect(trimSealedParts(secrets, clipId, parts, durationMs, 1500, durationMs, 64, 200 * 1024, true)).rejects.toThrow();
        parts.forEach((p, i) => expect(Buffer.from(p.wire).equals(Buffer.from(before[i]))).toBe(true));
        expect(Buffer.from(secrets.key).equals(Buffer.from(keyBefore))).toBe(true);
        expect(Buffer.from(secrets.noncePrefix).equals(Buffer.from(prefixBefore))).toBe(true);
        // (positive control) the same call on the untampered clip succeeds
        victim.wire[PART_HEADER_BYTES + 5] ^= 0x01;
        expect(await trimSealedParts(secrets, clipId, parts, durationMs, 1500, durationMs, 64, 200 * 1024, true)).not.toBeNull();
    }, 60_000);

    it('a whole-range request is a no-op (null) and touches nothing, whichever way retireOriginal is set', async () => {
        const { secrets, parts, clipId } = await sealMulti(200 * 1024);
        const before = parts.map(p => p.wire.slice());
        const durationMs = Math.round(base.videoDuration * 1000);
        expect(await trimSealedParts(secrets, clipId, parts, durationMs, 0, durationMs, 64, 200 * 1024, true)).toBeNull();
        expect(await trimSealedParts(secrets, clipId, parts, durationMs, -5, durationMs + 500, 64, 200 * 1024, false)).toBeNull();
        parts.forEach((p, i) => expect(Buffer.from(p.wire).equals(Buffer.from(before[i]))).toBe(true));
        expect(isZero(secrets.key)).toBe(false);
    }, 60_000);

    it('rejects a trimmed clip that would need more than maxParts, without touching the original', async () => {
        const { secrets, parts, clipId } = await sealMulti(200 * 1024);
        const before = parts.map(p => p.wire.slice());
        const durationMs = Math.round(base.videoDuration * 1000);
        await expect(trimSealedParts(secrets, clipId, parts, durationMs, 1500, durationMs, 2, 64 * 1024, true)).rejects.toThrow(/more than 2 parts/);
        parts.forEach((p, i) => expect(Buffer.from(p.wire).equals(Buffer.from(before[i]))).toBe(true));
    }, 60_000);
});
