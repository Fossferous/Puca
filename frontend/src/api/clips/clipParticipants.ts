/**
 * Who this client saw in the voice room while the clip buffer was armed — the
 * DECLARED half of the approver union (docs/CLIPS.md, plan D1; server side:
 * `union_approvers` in src/clip_handlers.rs).
 *
 * The server unions whatever we declare into the required-approver set after
 * filtering it only to people who can see the channel — never to the clip's
 * window, because from where it sits "the server missed them" and "the client
 * made them up" look the same. So the WINDOW bound has to be applied HERE,
 * and it has to be, because the earlier implementation was a Set that only
 * ever grew from the moment of arming: with auto-arm that meant "everyone who
 * has been in this call since I joined", and a person who left twenty minutes
 * before the clip — whose footage the ring had long since evicted — was still
 * a required approver. Offline, they blocked the clip until its 30-minute
 * expiry (field report 2026-09-02). In a busy server the same growth trips
 * the server's 32-approver cap and the request fails outright.
 *
 * This mirrors the server's `PresenceLog`: one or more spans per user, opened
 * when they appear and closed when they disappear, and a clip declares
 * everyone whose span OVERLAPS its window. "Appear" is deliberately wider
 * than the WS roster: the callers feed `observe()` the roster UNIONED with
 * the SFU's live participants (`sfuManager.participantUserIds()`), because a
 * peer whose app socket blipped has their roster row deleted by the server's
 * StreamStopped while their LiveKit session — and their audio into our ring
 * — carries on (VoicePanel keeps their audio element for exactly that
 * reason). Their span therefore stays open for as long as they are actually
 * audible, and closes only when BOTH the roster and the SFU have dropped
 * them. Every remaining rounding decision errs toward declaring someone:
 *
 *  - `leftAt` is stamped when THIS client learns of the departure (the
 *    server's StreamStopped/UserLeft arriving, or the SFU participant going),
 *    so it is never earlier than the server's own `left_ms` for that leave;
 *  - `LEAVE_SLACK_MS` extends every closed span forward, so someone who left
 *    shortly before the window is still asked. It is a heuristic margin for
 *    whatever the two liveness signals above miss, not a measured property
 *    of LiveKit; the continuous SFU observation is the real guarantee;
 *  - `stillAudible` is a belt-and-braces re-check at proposal time: a user
 *    with a live SFU participant is treated as present through now if ANY
 *    span of theirs started at or before the window end — keyed on the
 *    user, not on their latest span, so a roster row that heals after the
 *    seal (a new, post-window span) cannot cancel the rescue of the one
 *    that covered the footage;
 *  - the window's END is not padded, matching the server: someone who joined
 *    after the clip ended is not in it, and asking them would name people who
 *    arrived after the footage stopped;
 *  - times are all THIS client's `Date.now()` (the seal moment included), so
 *    no clock skew enters the comparison.
 *
 * Bounded like the server's log: closed spans older than `RETENTION_MS` are
 * forgotten (nothing can reach that far back — the server refuses clips that
 * ended more than 10 min ago or run longer than 10 min), and a flapping user
 * keeps at most `MAX_SPANS_PER_USER`, dropping their OLDEST closed span.
 */

/** Same value as `PresenceLog::PAD_MS`: the server pads the window START by this. */
export const CLIP_PAD_MS = 2_000;
/** How long after a roster departure we still consider someone's voice possibly in the ring. */
export const LEAVE_SLACK_MS = 120_000;
/** > MAX_ENDED_AGO (10 min) + MAX_CLIP (10 min) + pad + slack. */
export const RETENTION_MS = 25 * 60_000;
export const MAX_SPANS_PER_USER = 64;

/**
 * The window a clip sealed at `sealedAt` covers, on this client's clock — the
 * same one the server computes from `duration_ms` + `ended_ago_ms` (start
 * padded by `PAD_MS`, end not padded). The composer passes exactly this to
 * `getDeclaredParticipants`, and the unit tests build their windows with it,
 * so the arithmetic under test IS the arithmetic in production.
 */
export function clipWindowFor(sealedAt: number, durationMs: number): { start: number; end: number } {
    return { start: sealedAt - durationMs - CLIP_PAD_MS, end: sealedAt };
}

export interface PresenceSpan {
    joinedAt: number;
    /** null while they are still in the roster. */
    leftAt: number | null;
}

export interface DeclaredForOptions {
    /** The proposer, never declared (the server removes them too). */
    self: number;
    /** SFU keep-alive probe (`sfuManager.hasParticipant`): true = their media session is still live. */
    stillAudible?: (userId: number) => boolean;
}

export class DeclaredParticipants {
    private spans = new Map<number, PresenceSpan[]>();

    /** A FRESH arm: forget everything, start from the room as it is right now. */
    reset(presentIds: Iterable<number>, now: number): void {
        this.spans = new Map();
        this.observe(presentIds, now);
    }

    /**
     * The roster as currently rendered. Opens a span for anyone new, closes
     * the open span of anyone missing. Idempotent for an unchanged roster, so
     * it is safe to call from every roster render and again at proposal time.
     */
    observe(presentIds: Iterable<number>, now: number): void {
        const present = new Set(presentIds);
        for (const id of present) {
            const list = this.spans.get(id);
            if (list && list.length && list[list.length - 1].leftAt === null) continue;
            const next = list ?? [];
            next.push({ joinedAt: now, leftAt: null });
            this.spans.set(id, next);
        }
        for (const [id, list] of this.spans) {
            if (present.has(id)) continue;
            const last = list[list.length - 1];
            if (last && last.leftAt === null) last.leftAt = Math.max(now, last.joinedAt);
        }
        this.prune(now);
    }

    /**
     * Everyone whose presence overlaps [windowStartMs, windowEndMs] — the
     * client's `declared_participants` for a clip sealed at `windowEndMs`
     * whose footage starts at `windowStartMs` (already padded by the caller).
     */
    declaredFor(windowStartMs: number, windowEndMs: number, opts: DeclaredForOptions): number[] {
        const out: number[] = [];
        for (const [id, list] of this.spans) {
            if (id === opts.self) continue;
            const startedByEnd = (s: PresenceSpan) => s.joinedAt <= windowEndMs;
            // Still audible on the SFU right now: they have not gone, whatever
            // the roster did in between — treat them as present from any span
            // that started by the window's end through now. User-level on
            // purpose: a row that healed after the seal adds a post-window
            // span, and keying the rescue on "the latest span" would let that
            // new span cancel it (review finding, 2026-09-02).
            if (opts.stillAudible?.(id) === true && list.some(startedByEnd)) {
                out.push(id);
                continue;
            }
            const hit = list.some(s =>
                startedByEnd(s) && (s.leftAt === null || s.leftAt + LEAVE_SLACK_MS >= windowStartMs));
            if (hit) out.push(id);
        }
        return out.sort((a, b) => a - b);
    }

    /** For `__pucaClipDiag()`: a copy, never the live structure. */
    snapshot(): Record<number, PresenceSpan[]> {
        const o: Record<number, PresenceSpan[]> = {};
        for (const [id, list] of this.spans) o[id] = list.map(s => ({ ...s }));
        return o;
    }

    private prune(now: number): void {
        const horizon = now - RETENTION_MS;
        for (const [id, list] of this.spans) {
            let kept = list.filter(s => s.leftAt === null || s.leftAt >= horizon);
            while (kept.length > MAX_SPANS_PER_USER) {
                const oldestClosed = kept.findIndex(s => s.leftAt !== null);
                if (oldestClosed < 0) break;
                kept = kept.filter((_, i) => i !== oldestClosed);
            }
            if (kept.length === 0) this.spans.delete(id);
            else this.spans.set(id, kept);
        }
    }
}
