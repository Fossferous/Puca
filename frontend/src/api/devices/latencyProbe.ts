/**
 * How long from your hand to the picture: the remote-control loop, measured on
 * ONE clock — this one.
 *
 * The viewer sends `{t:'probe', p}` on the direct input channel and notes the
 * time. The agent injects nothing; it sends its next frame (even on a still
 * screen) and answers on the caret channel with that frame's RTP timestamp
 * (crates/puca-agent/src/latency.rs). `requestVideoFrameCallback` reports the
 * `rtpTimestamp` of every frame this end presents, with when it expects it on
 * screen; the probe resolves when the answered frame is presented. The
 * difference covers everything a mouse move goes through to come back as
 * pixels — this end, the network, the agent's loop and capture and encode, the
 * network again, the jitter buffer, decoding and display — and needs no clock
 * agreement between the two computers.
 *
 * Pure: the session layer feeds it the three events and the stage reads the
 * results, so the matching (out-of-order answers, a frame the renderer never
 * showed, RTP wrap-around) is tested without a browser.
 */

export interface ProbeResult {
    id: number;
    /** Probe sent to its frame expected on screen, ms. */
    totalMs: number;
    /** The agent's share: the probe's arrival to its frame's send, ms. */
    hostMs: number | null;
    /** Measured with the OLD timing (`q:1`: the agent's capture not pulled in). */
    classic: boolean;
}

interface Pending {
    sentAt: number;
    classic: boolean;
    ts: number | null;
    hostMs: number | null;
}

/** RTP timestamps are 32-bit and wrap: is `a` at or after `b`? */
export function rtpAtOrAfter(a: number, b: number): boolean {
    return ((a - b) >>> 0) < 0x8000_0000;
}

/** A probe older than this has failed (no channel answer, no frame). */
export const PROBE_TIMEOUT_MS = 2_000;

/** How many presented frames are remembered for an answer that arrives late. */
const PRESENTED_KEPT = 240;

export class ProbeMatcher {
    private readonly pending = new Map<number, Pending>();
    private readonly presentedFrames: Array<{ ts: number; at: number }> = [];
    private readonly listeners = new Set<(r: ProbeResult) => void>();
    private nextId = 1;

    /** A probe is going out now (`at`, performance.now()). Returns its id. */
    sent(at: number, classic: boolean): number {
        this.expire(at);
        const id = this.nextId++;
        this.pending.set(id, { sentAt: at, classic, ts: null, hostMs: null });
        return id;
    }

    /** Forget a probe that could not go out after all. */
    cancel(id: number): void {
        this.pending.delete(id);
    }

    /** Probes sent and not yet resolved or expired at `now`. Expiring here,
     *  not only on the next send or frame, is what lets a probe that will
     *  never be answered (a picture that stopped) stop blocking the next. */
    inFlight(now: number): number {
        this.expire(now);
        return this.pending.size;
    }

    /** The agent's answer: probe `id` rode the frame with RTP timestamp `ts`. */
    answered(id: number, ts: number, hostMs: number | null): void {
        const p = this.pending.get(id);
        if (!p || p.ts !== null) return;
        p.ts = ts >>> 0;
        p.hostMs = hostMs;
        // Already on screen (the frame beat its answer over the network)?
        const shown = this.presentedFrames.find(f => rtpAtOrAfter(f.ts, p.ts!));
        if (shown) this.resolve(id, p, shown.at);
    }

    /** A frame with RTP timestamp `ts` is expected on screen at `at`. */
    presented(ts: number, at: number): void {
        const frame = { ts: ts >>> 0, at };
        this.presentedFrames.push(frame);
        if (this.presentedFrames.length > PRESENTED_KEPT) this.presentedFrames.shift();
        // The answered frame itself, or — if the renderer skipped it — the
        // first later one, which shows everything it would have.
        for (const [id, p] of [...this.pending]) {
            if (p.ts !== null && rtpAtOrAfter(frame.ts, p.ts)) this.resolve(id, p, at);
        }
        this.expire(at);
    }

    subscribe(cb: (r: ProbeResult) => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    private resolve(id: number, p: Pending, shownAt: number): void {
        this.pending.delete(id);
        const result: ProbeResult = {
            id,
            totalMs: Math.max(0, Math.round((shownAt - p.sentAt) * 10) / 10),
            hostMs: p.hostMs,
            classic: p.classic,
        };
        for (const cb of [...this.listeners]) {
            try { cb(result); } catch { /* a listener's problem, not the matcher's */ }
        }
    }

    private expire(now: number): void {
        for (const [id, p] of this.pending) {
            if (now - p.sentAt > PROBE_TIMEOUT_MS) this.pending.delete(id);
        }
    }
}

/** The median of the last `n` numbers, or null. */
export function recentMedian(values: number[], n = 7): number | null {
    const recent = values.slice(-n);
    if (!recent.length) return null;
    const sorted = [...recent].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}
