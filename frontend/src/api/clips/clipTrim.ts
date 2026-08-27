/**
 * Post-approval trim: RE-MUX a time range of a sealed clip into a fresh,
 * self-consistent fragmented MP4 whose timeline starts at 0.
 *
 * Why re-mux and not "keep a subset of the parts": every fragment's `tfdt` is
 * an ABSOLUTE presentation time, and both players (the worker preview and
 * clipPlayback.ts) assume position 0 == time 0 with `timestampOffset` left at
 * 0. A front trim that merely relisted parts 3..4 of a 10 s clip would hand
 * the player 4 s–8 s fragments under a manifest claiming 0–4 s: the element
 * never reaches HAVE_CURRENT_DATA and stalls, seeks are off by the offset,
 * and a downloaded file's `moov` would describe the original. Re-muxing from
 * the decoded PACKETS (no re-encode — the same AVC/AAC access units) fixes
 * all of that and, as a bonus, trims at GOP (~2 s) granularity instead of
 * PART (~24 MiB ≈ 30 s) granularity.
 *
 * Snap is OUTWARD to keyframes: the kept range starts at the last keyframe
 * at-or-before `fromS` and ends at the end of the GOP containing `toS`, so the
 * user never loses footage they asked to keep — and since the input is the
 * already-approved clip, widening within it never exceeds what was approved.
 *
 * Pure with respect to the worker: takes plaintext bytes, hands each output
 * part to `onPart` AS IT IS PRODUCED (so the caller can seal it and zero the
 * plaintext without the whole output ever being resident at once). The
 * worker decrypts before and seals after (and zero-fills both). Tested end
 * to end against the real mediabunny demuxer in
 * src/tests/clipTrimRemux.test.ts.
 */
import * as mb from 'mediabunny';
import { Fmp4Splitter, type SplitPart } from './fmp4Split';
import { newClipSecrets, openPart, sealPart, PART_HEADER_BYTES, PART_TAG_BYTES, type ClipSecrets } from './clipCrypto';

export interface RemuxResult {
    /** Number of parts handed to `onPart` (init + media parts). */
    partCount: number;
    /** Presentation time (s) in the ORIGINAL clip where the kept range starts (after snapping). */
    startS: number;
    /** Duration (s) of the re-muxed clip (timeline starts at 0). */
    durationS: number;
    videoCodec: string;
    audioCodec: string | null;
    hasAudio: boolean;
}

/** Minimum kept length — below this there is nothing worth posting. */
export const MIN_TRIM_KEEP_S = 1;
/** The capture's forced keyframe interval (replayWorker.ts GOP_US). A sealed
 *  clip always starts on a keyframe, so it has ceil(duration / 2 s) of them;
 *  trimming needs at least two (one to cut at) with ≥ MIN_TRIM_KEEP_S left. */
export const TRIM_GOP_MS = 2000;
export const TRIM_MIN_CLIP_MS = TRIM_GOP_MS + MIN_TRIM_KEEP_S * 1000;
/** Trim holds the old ciphertext + the whole decrypted clip + the new
 *  ciphertext at its peak (≈ 3× the clip; replayWorker.ts trimSealed). Above
 *  this the composer refuses rather than risk an OOM that would take the
 *  ring AND the approved clip with it. */
export const TRIM_MAX_CIPHER_BYTES = 768 * 1024 * 1024;

export async function remuxRange(
    bytes: Uint8Array,
    fromS: number,
    toS: number,
    partBudget: number,
    onPart: (p: SplitPart) => void | Promise<void>,
): Promise<RemuxResult> {
    if (!(toS > fromS)) throw new Error('trim range is empty');
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('no video track in the sealed clip');
    const at = await input.getPrimaryAudioTrack();
    const vdec = await vt.getDecoderConfig();
    if (!vdec) throw new Error('no video decoder configuration in the sealed clip');
    const adec = at ? await at.getDecoderConfig() : null;

    // Pass 1 over video: find the snapped keyframe-aligned window.
    // startS = last keyframe at or before fromS (or the first keyframe if fromS precedes it);
    // endS  = first keyframe STRICTLY after toS (the GOP containing toS is kept whole), or the clip end.
    let startS: number | null = null;
    let endS: number | null = null;
    let lastEndS = 0;
    let firstKeyS: number | null = null;
    for await (const p of new mb.EncodedPacketSink(vt).packets()) {
        lastEndS = Math.max(lastEndS, p.timestamp + (p.duration || 0));
        if (p.type !== 'key') continue;
        if (firstKeyS === null) firstKeyS = p.timestamp;
        if (p.timestamp <= fromS + 1e-6) startS = p.timestamp;
        if (endS === null && p.timestamp > toS + 1e-6 && p.timestamp > fromS) endS = p.timestamp;
    }
    if (firstKeyS === null) throw new Error('the sealed clip has no keyframe');
    if (startS === null) startS = firstKeyS;
    if (endS === null) endS = lastEndS;
    if (!(endS - startS >= MIN_TRIM_KEEP_S - 1e-6)) throw new Error(`trim keeps less than ${MIN_TRIM_KEEP_S} s`);

    // Audio packets inside [startS, endS). A packet STRADDLING startS is
    // dropped, not clamped: the muxer derives each sample's duration from the
    // gap to the next, so a clamped-to-0 head packet would be written ~1 ms
    // long (an audible click) and would carry ~20 ms from before the cut.
    // The head therefore starts at most one AAC frame (21 ms) late. A clip
    // WITH audio whose kept range has no audio packets is refused: the
    // manifest cannot say "no audio" (clipRef.ts), so a video-only re-mux
    // would post as unplayable; and an audio track declared with no samples
    // keeps MSE's buffered range (the intersection across tracks) empty.
    const audioPackets: mb.EncodedPacket[] = [];
    if (at && adec) {
        for await (const p of new mb.EncodedPacketSink(at).packets()) {
            if (p.timestamp < startS - 1e-6 || p.timestamp >= endS - 1e-6) continue;
            audioPackets.push(p);
        }
        if (audioPackets.length === 0) throw new Error('the kept range has no audio frames — widen it');
    }

    // Pass 2: re-mux [startS, endS) with timestamps rebased to 0.
    let partCount = 0;
    let pending: Promise<void> = Promise.resolve();
    const splitter = new Fmp4Splitter(partBudget, p => { partCount++; pending = pending.then(() => onPart(p)); });
    const writable = new WritableStream<Uint8Array | { data: Uint8Array }>({
        write(c) { splitter.push(c instanceof Uint8Array ? c : c.data); },
    });
    const output = new mb.Output({
        format: new mb.Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
        target: new mb.AppendOnlyStreamTarget(writable as WritableStream<Uint8Array>),
    });
    const vsrc = new mb.EncodedVideoPacketSource('avc');
    output.addVideoTrack(vsrc);
    const audioCodec = adec?.codec ?? null;
    const hasAudio = audioPackets.length > 0;
    const asrc = hasAudio && adec ? new mb.EncodedAudioPacketSource(audioCodec && audioCodec.startsWith('opus') ? 'opus' : 'aac') : null;
    if (asrc) output.addAudioTrack(asrc);
    await output.start();

    let durationS = 0;
    let firstV = true;
    for await (const p of new mb.EncodedPacketSink(vt).packets()) {
        if (p.timestamp < startS - 1e-6 || p.timestamp >= endS - 1e-6) continue;
        const ts = Math.max(0, p.timestamp - startS);
        await vsrc.add(new mb.EncodedPacket(p.data, p.type, ts, p.duration), firstV ? { decoderConfig: vdec } : undefined);
        firstV = false;
        durationS = Math.max(durationS, ts + (p.duration || 0));
    }
    if (firstV) throw new Error('trim kept no video packets');
    if (asrc && adec) {
        let firstA = true;
        for (const p of audioPackets) {
            // the 1e-6 admission tolerance above can leave a hair below 0, which the muxer rejects
            await asrc.add(new mb.EncodedPacket(p.data, 'key', Math.max(0, p.timestamp - startS), p.duration), firstA ? { decoderConfig: adec } : undefined);
            firstA = false;
        }
    }
    await output.finalize();
    splitter.end();
    await pending;
    if (partCount < 2) throw new Error('trim produced no fragments');
    return { partCount, startS, durationS, videoCodec: vdec.codec, audioCodec: hasAudio ? audioCodec : null, hasAudio };
}

export interface SealedPartLike { index: number; wire: Uint8Array; isInit: boolean; startS: number | null; durMs: number }
export interface TrimSealedResult {
    secrets: ClipSecrets;
    parts: SealedPartLike[];
    durationMs: number;
    totalCipherBytes: number;
    hasAudio: boolean;
}

/**
 * The worker's trim, minus the worker: decrypt `parts` under `secrets`, re-mux
 * [startMs, endMs] of the clip's own timeline, seal the result under FRESH
 * secrets and hand back the new part set. Returns null when the range covers
 * the whole clip (nothing to do).
 *
 * Fresh secrets are not optional: clipCrypto.ts derives a part's nonce from
 * (noncePrefix, index) and the re-mux re-uses indices 0..m, so sealing under
 * the old secrets would encrypt different plaintext under an already-used
 * AES-GCM nonce — the one thing GCM must never do. The manifest carries
 * whichever key the posted parts were sealed with, so nothing else changes.
 *
 * All-or-nothing: the caller's `parts`/`secrets` are untouched if anything
 * throws. Memory: the whole decrypted clip is resident once (decrypted
 * straight into one buffer), next to the old ciphertext (rollback) and the
 * new ciphertext as it accumulates; each re-mux output part is sealed and
 * zero-filled AS IT IS PRODUCED. Tested in clipTrimRemux.test.ts.
 *
 * `retireOriginal` decides what happens to `parts`/`secrets` on SUCCESS (the
 * error path above never touches them either way): `true` zero-fills them —
 * the original behaviour, for a caller with no further use for the pre-trim
 * bytes. `false` leaves them completely untouched, still valid and openable
 * under their original indices — replayWorker.ts passes `false` and keeps
 * the result as a one-level undo point, since decrypting never mutates its
 * input (clipCrypto.ts's `openPart` always returns a fresh buffer), so
 * "don't zero it" is the entire mechanism; no copy is made or needed.
 */
export async function trimSealedParts(
    secrets: ClipSecrets,
    clipId: string,
    parts: SealedPartLike[],
    durationMs: number,
    startMs: number,
    endMs: number,
    maxParts: number,
    partBudget: number,
    retireOriginal: boolean,
): Promise<TrimSealedResult | null> {
    const lo = Math.max(0, Math.min(startMs, endMs));
    const hi = Math.min(durationMs, Math.max(startMs, endMs));
    if (!(hi > lo)) throw new Error('trim range is empty');
    if (lo <= 0 && hi >= durationMs) return null; // nothing to trim
    const fresh = newClipSecrets(clipId);
    const plainLen = parts.reduce((n, p) => n + Math.max(0, p.wire.byteLength - PART_HEADER_BYTES - PART_TAG_BYTES), 0);
    const whole = new Uint8Array(plainLen);
    const kept: SealedPartLike[] = [];
    let totalCipher = 0;
    try {
        let off = 0;
        for (const p of parts) {
            const plain = await openPart(secrets, p.index, p.wire);
            try { whole.set(plain, off); off += plain.byteLength; } finally { plain.fill(0); }
        }
        if (off !== plainLen) throw new Error('decrypted length disagrees with the wire lengths');
        const result = await remuxRange(whole, lo / 1000, hi / 1000, partBudget, async (p) => {
            try {
                if (kept.length >= maxParts) throw new Error(`trimmed clip needs more than ${maxParts} parts`);
                if (kept.length === 0 && !p.isInit) throw new Error('re-mux did not start with an init segment');
                if (p.index !== kept.length) throw new Error('re-mux part indices are not contiguous');
                const wire = await sealPart(fresh, p.index, p.bytes);
                totalCipher += wire.byteLength;
                kept.push({ index: p.index, wire, isInit: p.isInit, startS: p.startS, durMs: 0 });
            } finally {
                p.bytes.fill(0);
            }
        });
        // Durations per part from fragment starts; the last part runs to the end.
        for (let i = 0; i < kept.length; i++) {
            const next = kept[i + 1];
            kept[i].durMs = kept[i].isInit ? 0 : Math.max(0, Math.round(((next?.startS ?? result.durationS) - (kept[i].startS ?? 0)) * 1000));
        }
        // Only now, with every new part sealed, retire the superseded ciphertext
        // and key — unless the caller asked to keep them (undo point).
        if (retireOriginal) {
            for (const p of parts) p.wire.fill(0);
            secrets.key.fill(0); secrets.noncePrefix.fill(0);
        }
        return { secrets: fresh, parts: kept, durationMs: Math.round(result.durationS * 1000), totalCipherBytes: totalCipher, hasAudio: result.hasAudio };
    } catch (e) {
        // Roll back: the new ciphertext is worthless without its key.
        for (const k of kept) k.wire.fill(0);
        fresh.key.fill(0); fresh.noncePrefix.fill(0);
        throw e;
    } finally {
        whole.fill(0);
    }
}

/** Collect every part of a re-mux in memory (tests and callers that want the
 *  whole output; the worker seals parts as they arrive instead). */
export async function remuxRangeToParts(bytes: Uint8Array, fromS: number, toS: number, partBudget: number): Promise<RemuxResult & { parts: SplitPart[] }> {
    const parts: SplitPart[] = [];
    const r = await remuxRange(bytes, fromS, toS, partBudget, p => { parts.push(p); });
    return { ...r, parts };
}

/** Concatenate plaintext parts in index order (init first) into one buffer. */
export function concatParts(plain: Uint8Array[]): Uint8Array {
    const total = plain.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of plain) { out.set(p, o); o += p.byteLength; }
    return out;
}
