/**
 * Clip replay ring — PURE data structure + window math. No browser APIs, so the
 * whole thing is unit-tested; the worker (replayWorker.ts) owns the encoders
 * and the crypto and calls into this for every decision that matters.
 *
 * The ring is a list of GOP UNITS. A unit is everything the encoders emitted
 * from one forced video keyframe up to (not including) the next: the keyframe,
 * its delta frames, and every audio chunk that fell into the same time span.
 * Units are the granularity of BOTH eviction and clip selection because a GOP
 * is the smallest thing that is independently decodable — you cannot start a
 * clip in the middle of one.
 *
 * `blob` is AES-GCM CIPHERTEXT of the concatenated chunk bytes (see
 * clipCrypto.ts). The chunk INDEX (timestamps, lengths, key flags) stays in
 * the clear: it is timing metadata, and eviction/selection must never have to
 * decrypt anything to run.
 */

/** One encoded chunk's position inside a unit's plaintext, plus its timing. */
export interface ChunkIndexEntry {
    /** Presentation timestamp, microseconds, already rebased to the ring's clock. */
    tsUs: number;
    /** Duration in microseconds (encoder-reported, or the nominal frame period). */
    durUs: number;
    /** Byte length inside the concatenated plaintext. */
    len: number;
    /** Video only: is this a keyframe. Always true for video[0]. */
    key: boolean;
}

export interface GopUnit {
    /** Monotonic per arm; never reused. */
    seq: number;
    /** Bumped on every encoder reconfigure (resolution change). Units with
     *  different configIds must never be muxed into one track. */
    configId: number;
    /** Keyframe timestamp (rebased). */
    startUs: number;
    /** Last chunk timestamp + duration (rebased). */
    endUs: number;
    /** Video chunks in decode order; [0].key === true. */
    video: ChunkIndexEntry[];
    /** Audio chunks in order, all with tsUs >= startUs (trimmed at close). */
    audio: ChunkIndexEntry[];
    /** AES-GCM nonce counter this unit was sealed under. */
    counter: number;
    /** Ciphertext of [video bytes in order][audio bytes in order]. */
    blob: Uint8Array;
    /** Plaintext length (blob.byteLength - 16). */
    plainLen: number;
}

export interface RingLimits {
    maxDurationUs: number;
    maxBytes: number;
}

/** Newest end minus oldest start; 0 for an empty ring. */
export function ringDurationUs(g: readonly GopUnit[]): number {
    if (g.length === 0) return 0;
    return g[g.length - 1].endUs - g[0].startUs;
}

export function ringBytes(g: readonly GopUnit[]): number {
    let n = 0;
    for (const u of g) n += u.blob.byteLength;
    return n;
}

/**
 * Which units to EVICT so the ring fits `lim` again. Oldest first. Never
 * empties the ring: at least the newest unit always survives, or "Clip" right
 * after an eviction would produce nothing. The caller zero-fills the evicted
 * blobs — this function only decides.
 */
export function evictionPlan(g: readonly GopUnit[], lim: RingLimits): GopUnit[] {
    const out: GopUnit[] = [];
    let from = 0;
    let bytes = ringBytes(g);
    // Duration is measured from the OLDEST SURVIVING unit, so re-evaluate after
    // each drop instead of computing once.
    while (g.length - from > 1) {
        const dur = g[g.length - 1].endUs - g[from].startUs;
        if (dur <= lim.maxDurationUs && bytes <= lim.maxBytes) break;
        out.push(g[from]);
        bytes -= g[from].blob.byteLength;
        from++;
    }
    return out;
}

export interface WindowSelection {
    /** Index of the first unit to include. */
    from: number;
    /** Index of the last unit to include (inclusive) — always the newest. */
    to: number;
    /** Real start of the clip = g[from].startUs. */
    startUs: number;
    /** Real end of the clip = g[to].endUs. */
    endUs: number;
    /** How much EARLIER than requested the clip starts (0..~one GOP). Reported,
     *  never hidden: the UI shows the real duration. */
    leadInUs: number;
    /** Microseconds of buffered footage that had to be dropped because it was
     *  encoded under an older configId (resolution change). 0 normally. */
    lostUs: number;
}

/**
 * Pick the units covering the last `requestedUs` of the ring.
 *
 * - `to` is always the newest unit — a GOP is decodable from its keyframe
 *   forward, so "Clip" captures right up to now, including the still-open one
 *   as long as the caller has closed it into a unit first.
 * - `from` is the LARGEST index whose startUs <= wantStart, i.e. the GOP that
 *   CONTAINS the requested start. `<=`, not `<`: a wantStart exactly on a
 *   keyframe selects that keyframe's GOP, and a wantStart 10 ms after a
 *   keyframe selects that same GOP (the one BEFORE the next keyframe). Getting
 *   this boundary wrong makes the clip start AFTER the moment the user pressed
 *   Clip for.
 * - If the ring is shorter than requested, from = 0 and the real (shorter)
 *   duration is what the selection reports.
 * - `maxUs` (the server's longest-clip policy): the keyframe snap-back adds a
 *   lead-in of up to one GOP, which would push a "max" request OVER the cap
 *   and the server would 400 it. When the snapped window exceeds `maxUs`,
 *   the start advances one unit instead (a slightly SHORTER clip, never a
 *   longer one — footage outside the approved window must not be sealed).
 * - Config clamp: units before the newest configId are dropped from the
 *   selection (never spliced into one AVC track); `lostUs` says how much.
 */
export function selectWindow(g: readonly GopUnit[], requestedUs: number, maxUs?: number): WindowSelection | null {
    if (g.length === 0) return null;
    const to = g.length - 1;
    const endUs = g[to].endUs;
    const wantStartUs = endUs - Math.max(0, requestedUs);
    let from = 0;
    for (let i = 0; i < g.length; i++) {
        if (g[i].startUs <= wantStartUs) from = i;
        else break;
    }
    if (maxUs !== undefined && maxUs > 0) {
        while (from < to && endUs - g[from].startUs > maxUs) from++;
    }
    let lostUs = 0;
    const cfg = g[to].configId;
    if (g[from].configId !== cfg) {
        let first = from;
        while (first <= to && g[first].configId !== cfg) first++;
        // `first` is the first unit of the newest config; everything before it
        // in [from, first) is footage we cannot use.
        lostUs = g[first].startUs - g[from].startUs;
        from = first;
    }
    const startUs = g[from].startUs;
    return {
        from,
        to,
        startUs,
        endUs,
        leadInUs: Math.max(0, wantStartUs - startUs),
        lostUs,
    };
}

/**
 * Audio entries of the FIRST selected unit that lie entirely before the clip
 * start are dropped; a chunk that merely overlaps the boundary is kept (its
 * first samples belong to the previous GOP, but cutting mid-packet is worse
 * than 20 ms of extra lead-in). Later units are taken whole.
 */
export function trimLeadingAudio(entries: readonly ChunkIndexEntry[], startUs: number): ChunkIndexEntry[] {
    return entries.filter(e => e.tsUs + e.durUs > startUs);
}

/**
 * Bytes a ring of `seconds` at `bitsPerSecond` occupies, plus the 16-byte GCM
 * tag per unit and the index overhead. Used by the memory readout.
 */
export function estimateRingBytes(bitsPerSecond: number, seconds: number, gopSeconds = 2): number {
    const units = Math.ceil(seconds / gopSeconds);
    return Math.round((bitsPerSecond / 8) * seconds) + units * 16;
}
