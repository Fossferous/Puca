/**
 * Help a viewer whose connection cannot carry a watched share: ask the SFU for
 * the share's next smaller copy, and go back to the full picture once the
 * connection has been clean for a while.
 *
 * WHY THIS EXISTS. On 2026-10-25 a viewer of a 1080p60 share (about 9.4 Mb/s)
 * lost packets from every sender, had outages and one freeze of 7.3 s, and
 * stayed on the full picture throughout. LiveKit's own allocator moves a
 * subscriber down a share's ladder when its bandwidth ESTIMATE falls below a
 * rung, but loss that does not pull the estimate down (congestion control backs
 * off only well past a few per cent) leaves the viewer at full size, where
 * every lost packet of a big frame costs a retransmission, a keyframe request
 * or a freeze. A smaller copy sends fewer packets a frame, so fewer frames are
 * hit, and the share has the copies already: Automatic sends most shares at
 * several sizes (shareLadder.ts).
 *
 * WHAT COUNTS, over each window between two reads of the receiver
 * (VIEW_SAMPLE_MS):
 *   - LOSS: more than LOSSY_PCT of a window's packets lost, in LOSSY_NEEDED of
 *     the last LOSSY_OF windows. A window needs MIN_PACKETS to be judged at
 *     all: one packet of twenty is 5% and means nothing.
 *   - FREEZES: FREEZES_NEEDED freezes inside FREEZE_SPAN_MS, each in a window
 *     that also lost CLEAN_PCT of its packets or more, or asked for a keyframe
 *     again (PLI). A freeze without that is not this viewer's connection: the
 *     sharer's frames never left (the other viewer that evening froze for
 *     1.4-2.3 s with nothing lost, behind a share whose own machine was short
 *     of frames: shareHealth.ts), or the picture stopped changing, which the
 *     browser counts as a freeze too (one to three a window for slides or
 *     code, measured). A smaller copy freezes there just the same, so stepping
 *     down would cost the picture for nothing. A lone retransmission (NACK) is
 *     not trouble either: busy Wi-Fi repairs a packet now and then.
 *   - A share being remote-controlled is left alone (sfuManager): its jitter
 *     buffer is held at zero on purpose, which freezes more.
 *
 * NEVER THRASH. Nothing is judged for SETTLE_MS after the share is first seen
 * or after a step: the new copy starts on a keyframe, and the switch can itself
 * pause the picture for a moment. The full picture comes back only after
 * CLEAN_MS of clean windows (under CLEAN_PCT lost, no freeze with packet
 * trouble). Having to leave it again within RELAPSE_MS doubles that wait, up to
 * CLEAN_MAX_MS; FORGIVE_MS at full size without leaving resets it.
 *
 * Pure: no timers, no transport, no LiveKit (its VideoQuality numbers are
 * mirrored below and pinned by a test). sfuManager feeds a read every
 * VIEW_SAMPLE_MS for each watched share and asks for the copy this says.
 */

/** How often a watched share's receiver is read. */
export const VIEW_SAMPLE_MS = 3000;
/** A window losing more than this per cent of its packets is lossy... */
export const LOSSY_PCT = 1;
/** ...one losing less than this is clean (in between: neither). */
export const CLEAN_PCT = 0.5;
/** Fewer packets than this in a window: its loss is not judged. */
export const MIN_PACKETS = 100;
/** Step down on this many lossy windows among the last LOSSY_OF. */
export const LOSSY_NEEDED = 2;
export const LOSSY_OF = 3;
/** ...or on this many freezes with packet trouble inside FREEZE_SPAN_MS. */
export const FREEZES_NEEDED = 2;
export const FREEZE_SPAN_MS = 60_000;
/** Nothing is judged this long after the share is first seen, or a step. */
export const SETTLE_MS = 9_000;
/** Clean for this long before the full picture is tried again... */
export const CLEAN_MS = 60_000;
/** ...doubled for each relapse, up to this. */
export const CLEAN_MAX_MS = 8 * 60_000;
/** Leaving the full picture again this soon after coming back is a relapse. */
export const RELAPSE_MS = 2 * 60_000;
/** At the full picture this long without leaving: the wait is CLEAN_MS again. */
export const FORGIVE_MS = 10 * 60_000;

/** livekit-client's VideoQuality (LOW 0, MEDIUM 1, HIGH 2), which is also the
 *  protocol's numbering for a layer's quality. */
export const QUALITY = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

/** Cumulative counters from one read of a watched share's inbound-rtp. */
export interface ReceiveSample {
    atMs: number;
    packetsReceived?: number | null;
    packetsLost?: number | null;
    freezeCount?: number | null;
    nackCount?: number | null;
    pliCount?: number | null;
}

export type LayerState = 'full' | 'reduced';

/** A step the guard just took, and why, for the log. */
export interface LayerChange {
    to: LayerState;
    why: string;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export class ShareLayerGuard {
    private stateV: LayerState = 'full';
    private prev: ReceiveSample | null = null;
    private firstAt: number | null = null;
    private settleUntil = -Infinity;
    /** When the current state began. */
    private since = 0;
    private lossy: boolean[] = [];
    /** One entry per freeze with packet trouble, at the end of its window. */
    private freezes: number[] = [];
    private cleanSince: number | null = null;
    private cleanNeeded = CLEAN_MS;
    private lastUpAt = -Infinity;

    get state(): LayerState { return this.stateV; }
    /** How long the connection must be clean before the full picture is tried again. */
    get cleanWaitMs(): number { return this.cleanNeeded; }

    /** A new receiver (the share was published again, a re-subscribe): its
     *  counters start over, so the next read is only a baseline, and the new
     *  stream settles before it is judged. The state and the wait are kept:
     *  they are about this viewer's connection. */
    resetCounters(): void {
        this.prev = null;
        this.settleNext = true;
    }

    /** The next read starts a settle (a new receiver). */
    private settleNext = false;

    /** Nothing to judge for now: the share has no smaller copy (any more), or
     *  it is being remote-controlled. Back to the full picture, evidence
     *  dropped, the wait kept, and the reads that follow settle first: once
     *  control ends its receiver gets its jitter buffer back, and a ladder
     *  that comes back is a new publication. */
    reset(): void {
        this.prev = null;
        this.stateV = 'full';
        this.lossy = [];
        this.freezes = [];
        this.cleanSince = null;
        this.settleNext = true;
    }

    /** Feed one read. Returns the change it decided on, or null. */
    observe(s: ReceiveSample): LayerChange | null {
        const prev = this.prev;
        this.prev = s;
        if (this.firstAt === null) {
            this.firstAt = s.atMs;
            this.since = s.atMs;
            this.settleUntil = s.atMs + SETTLE_MS;
        }
        if (this.settleNext) {
            this.settleNext = false;
            this.settleUntil = Math.max(this.settleUntil, s.atMs + SETTLE_MS);
        }
        if (!prev) return null;
        const d = (k: keyof Omit<ReceiveSample, 'atMs'>): number | null => {
            const a = prev[k];
            const b = s[k];
            return finite(a) && finite(b) ? b - a : null;
        };
        const recv = d('packetsReceived');
        const frz = d('freezeCount');
        const nack = d('nackCount');
        const pli = d('pliCount');
        // A counter that went BACK is another receiver: this read is the new
        // baseline, and its stream settles first. (packetsLost alone may
        // fall: duplicates are counted against it, so a fall there is just
        // no loss.)
        if ([recv, frz, nack, pli].some(x => x !== null && x < 0)) {
            this.settleUntil = Math.max(this.settleUntil, s.atMs + SETTLE_MS);
            return null;
        }
        if (s.atMs < this.settleUntil) return null;
        const lost = Math.max(0, d('packetsLost') ?? 0);
        const packets = (recv ?? 0) + lost;
        const lossPct = packets >= MIN_PACKETS ? (100 * lost) / packets : null;
        // A freeze is the NETWORK's only beside real loss (CLEAN_PCT or more
        // of a window's packets) or a keyframe asked for again (PLI): the
        // picture broke. Never beside a lone retransmission (NACK): busy
        // Wi-Fi repairs a packet now and then, and a share of slides or code
        // "freezes" one to three times a window just by pausing (measured on
        // a real capture, nothing lost) — those two together once stepped a
        // healthy viewer down for good.
        const trouble = (lossPct !== null && lossPct >= CLEAN_PCT) || (pli ?? 0) > 0;
        const netFreezes = trouble ? Math.max(0, frz ?? 0) : 0;

        this.lossy.push(lossPct !== null && lossPct > LOSSY_PCT);
        if (this.lossy.length > LOSSY_OF) this.lossy.shift();
        for (let i = 0; i < netFreezes; i++) this.freezes.push(s.atMs);
        this.freezes = this.freezes.filter(t => s.atMs - t < FREEZE_SPAN_MS);

        if (this.stateV === 'full') {
            if (s.atMs - this.since >= FORGIVE_MS) this.cleanNeeded = CLEAN_MS;
            const lossyCount = this.lossy.filter(Boolean).length;
            let why: string | null = null;
            if (lossyCount >= LOSSY_NEEDED) {
                why = `${lossyCount} of the last ${this.lossy.length} windows lost over ${LOSSY_PCT}% of their packets, ${(lossPct ?? 0).toFixed(1)}% in the last`;
            } else if (this.freezes.length >= FREEZES_NEEDED) {
                why = `${this.freezes.length} freezes with packet loss or keyframe requests in ${Math.round(FREEZE_SPAN_MS / 1000)} s`;
            }
            if (!why) return null;
            if (s.atMs - this.lastUpAt < RELAPSE_MS) this.cleanNeeded = Math.min(this.cleanNeeded * 2, CLEAN_MAX_MS);
            this.enter('reduced', s.atMs);
            return { to: 'reduced', why };
        }

        const clean = (lossPct === null || lossPct < CLEAN_PCT) && netFreezes === 0;
        if (!clean) {
            this.cleanSince = null;
            return null;
        }
        // The stretch starts where this clean window did, never inside the
        // settling after the step.
        if (this.cleanSince === null) this.cleanSince = Math.max(prev.atMs, this.since + SETTLE_MS);
        const cleanFor = s.atMs - this.cleanSince;
        if (cleanFor < this.cleanNeeded) return null;
        this.lastUpAt = s.atMs;
        this.enter('full', s.atMs);
        return { to: 'full', why: `clean for ${Math.round(cleanFor / 1000)} s` };
    }

    private enter(state: LayerState, at: number): void {
        this.stateV = state;
        this.since = at;
        this.settleUntil = at + SETTLE_MS;
        this.lossy = [];
        this.freezes = [];
        this.cleanSince = null;
    }
}

/** What sfuManager reads off a LiveKit publication to know its copies. */
export interface LayeredPublication {
    simulcasted?: boolean;
    trackInfo?: {
        layers?: ReadonlyArray<{ quality?: number }>;
        codecs?: ReadonlyArray<{ layers?: ReadonlyArray<{ quality?: number }> }>;
    };
}

/**
 * The copies a share is sent at, by quality, lowest first: one ([HIGH]) for a
 * share sent at one size. The publisher lists them (videoLayersFromEncodings
 * in livekit-client: rid q is LOW, h MEDIUM, f HIGH, so a two-encoding ladder
 * is LOW and MEDIUM). Read from the track info, its per-codec lists as well
 * as the older flat one; a simulcast publication that lists none is taken to
 * have all three, where asking for one it lacks is answered with the nearest
 * below it.
 */
export function shareLayers(pub: LayeredPublication): number[] {
    const lists = [pub.trackInfo?.layers ?? [], ...(pub.trackInfo?.codecs ?? []).map(c => c.layers ?? [])];
    for (const list of lists) {
        const qs = [...new Set(list.map(l => l.quality).filter((q): q is number => finite(q) && q >= QUALITY.LOW && q <= QUALITY.HIGH))]
            .sort((a, b) => a - b);
        if (qs.length > 1) return qs;
    }
    return pub.simulcasted ? [QUALITY.LOW, QUALITY.MEDIUM, QUALITY.HIGH] : [QUALITY.HIGH];
}

/** The copy one below what a subscriber asking for `want` is sent (the best
 *  at or under it), or null when there is nothing smaller. */
export function lowerLayer(want: number, layers: readonly number[]): number | null {
    const atOrBelow = layers.filter(q => q <= want);
    if (atOrBelow.length === 0) return null;
    const served = Math.max(...atOrBelow);
    const below = layers.filter(q => q < served);
    return below.length ? Math.max(...below) : null;
}

/** 'high' / 'medium' / 'low' for a VideoQuality number, for the log. */
export function qualityName(q: number | null | undefined): string {
    return q === QUALITY.HIGH ? 'high' : q === QUALITY.MEDIUM ? 'medium' : q === QUALITY.LOW ? 'low' : '?';
}
