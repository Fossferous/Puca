/**
 * Decide when a live controller session's PICTURE is dead while everything
 * else claims to be fine.
 *
 * The gap this closes (field report 2026-08-13): video rides WebRTC while
 * input rides the server WebSocket, and nothing cross-checked one against the
 * other. Every existing watchdog bounds a TRANSITION — the first frame
 * (mediaTimer), a pc statechange (pcDisconnectTimer), a socket drop
 * (transportGraceTimer), a foreground return (deviceStageStall) — so a media
 * path that dies mid-session while the pc stays 'connected' and the app stays
 * foregrounded had no clock running at all: a still image, indefinitely, with
 * taps landing on the real desktop.
 *
 * THE FALSE-POSITIVE PROBLEM, and why the gate is input: a still remote
 * desktop legitimately produces ZERO frames (the agent's pump returns
 * NoChange and sends nothing — the receiver track even mutes), so "no frames
 * for N seconds" alone is meaningless. What a still desktop cannot explain is
 * "no frames AND the user is actively driving it": input events change the
 * screen, and even the ones that do not (moving an owned cursor over dead
 * space) mean someone is present who deserves an answer. So the stall clock
 * only runs while input has been sent since the last decoded frame, recently.
 *
 * THE PROBE, and why it distinguishes rather than repairs: the agent answers
 * any keyframe request by re-encoding its last captured picture as an IDR —
 * even for a perfectly still screen (stream.rs, should_resend_still). So a
 * LIVE media path always answers a probe with a decodable frame within a
 * round trip, and framesDecoded advances. A probe that goes unanswered is
 * therefore evidence about the TRANSPORT, not the desktop — and three
 * unanswered probes, each given its full PROBE_SPACING_MS answer window
 * (~16s of driven stall in total), is the ladder's definition of dead, at
 * which point the caller escalates (media restart, then an honest teardown).
 *
 * Probes that ARE answered cost one IDR each, so an answered probe opens a
 * cooldown: a user dragging an owned cursor over a motionless desktop pays
 * one IDR per cooldown period, not one per stall window.
 *
 * Pure state machine — no timers, no DOM, no session object. The caller
 * samples it (session.ts polls at 1Hz with getStats' framesDecoded) and acts
 * on the verdict, which is what makes it testable with a fake clock.
 */

/** No decode progress for this long, while driven, before the first probe. */
export const STALL_AFTER_MS = 4_000;
/** Between probes — a hair over requestKeyframe's shared 3s budget, so a
 *  ladder probe is never silently eaten by its own rate limit. */
export const PROBE_SPACING_MS = 4_000;
/** Unanswered probes that mean "the path is dead", not "the screen is still". */
export const PROBES_BEFORE_ESCALATE = 3;
/** Input older than this stops the clock: the user left, and a stall nobody
 *  is looking at can wait for the next interaction to be diagnosed. */
export const INPUT_RECENT_MS = 10_000;
/** After a probe was ANSWERED — the path proved live, the screen just still —
 *  how long to sit quiet before probing again under continued input. */
export const PROBE_COOLDOWN_MS = 15_000;

export interface LivenessSample {
    /** The caller's clock, ms. Injected so tests own time. */
    now: number;
    /** inbound-rtp framesDecoded, or null when it cannot be read this tick
     *  (no stats, pc gone, tab hidden). Null must never count toward a stall:
     *  it measures the observer, not the stream. */
    framesDecoded: number | null;
    /** When the controller last SENT input for this session (0 = never). */
    lastInputAt: number;
    /** Everything else says this session should be showing live video:
     *  active, visible, transport whole, not already waiting on media. */
    eligible: boolean;
}

export type LivenessVerdict = 'ok' | 'probe' | 'escalate';

export class MediaLiveness {
    private lastFrames: number | null = null;
    private lastProgressAt = 0;
    private probes = 0;
    private lastProbeAt = 0;
    private cooldownUntil = 0;

    sample(x: LivenessSample): LivenessVerdict {
        // Ineligible or unmeasurable time must not count as "stalled" — the
        // same frozen-webview discipline every deadline in session.ts follows.
        if (!x.eligible || x.framesDecoded === null) {
            this.lastProgressAt = x.now;
            this.probes = 0;
            return 'ok';
        }
        if (this.lastFrames === null || x.framesDecoded !== this.lastFrames) {
            // Progress. `!==` rather than `>` because a media restart hands us
            // a fresh pc whose counter restarts from zero — a regression IS
            // progress on the new stream.
            const answeredProbe = this.probes > 0;
            this.lastFrames = x.framesDecoded;
            this.lastProgressAt = x.now;
            this.probes = 0;
            if (answeredProbe) this.cooldownUntil = x.now + PROBE_COOLDOWN_MS;
            return 'ok';
        }
        // No progress. Only a user who has driven the session SINCE the last
        // frame, recently, turns that into a stall.
        if (x.lastInputAt <= this.lastProgressAt || x.now - x.lastInputAt > INPUT_RECENT_MS) {
            this.probes = 0;
            return 'ok';
        }
        if (x.now < this.cooldownUntil) return 'ok';
        if (x.now - this.lastProgressAt < STALL_AFTER_MS) return 'ok';
        // The spacing gate runs BEFORE the escalate check, deliberately: the
        // LAST probe deserves the same full answer window the others got. With
        // the order reversed, escalation fired one poll tick after the final
        // probe — on a high-latency link the IDR that proved the path alive
        // arrived just after the verdict, and a working session was torn down.
        if (this.probes > 0 && x.now - this.lastProbeAt < PROBE_SPACING_MS) return 'ok';
        if (this.probes >= PROBES_BEFORE_ESCALATE) return 'escalate';
        return 'probe';
    }

    /** The caller ACTUALLY sent a probe (requestKeyframe returned true — one
     *  suppressed by the shared budget spends nothing here and is retried on
     *  the next tick). */
    probeSent(now: number): void {
        this.probes += 1;
        this.lastProbeAt = now;
    }

    /** Fresh start — after an escalation was handled, so the ladder measures
     *  the RESTARTED stream from zero rather than instantly re-escalating. */
    reset(now: number): void {
        this.lastFrames = null;
        this.lastProgressAt = now;
        this.probes = 0;
        this.lastProbeAt = 0;
        this.cooldownUntil = 0;
    }
}
