/**
 * When DeepFilter falls behind: whether the call keeps it.
 *
 * The audio does not wait for this. The worklet (dfWorklet.js) covers any
 * moment the inference Worker is late with a time-aligned RNNoise rendering
 * of the same instant, and switches back per sample once the Worker catches
 * up. What this decides is the one thing the audio thread cannot: whether
 * DeepFilter is still worth running for the rest of THIS call. Keeping it
 * costs the Worker's CPU (15-35% of a core in the field), and every episode
 * is a stretch of RNNoise-quality audio.
 *
 * An episode is ~500 ms of backlog, reported by the worklet when it starts
 * and when the Worker has stayed caught up for a second.
 *
 * - One that lasts SUSTAINED_MS is not a spike. Either the machine cannot run
 *   DeepFilter at all right now, or the Worker has hung, and waiting longer
 *   only grows a queue of hops it would have to grind through. Settle.
 * - REPEAT_EPISODES starting within REPEAT_WINDOW_MS are spikes that keep
 *   coming. DeepFilter's own load may be part of why, and the listener hears
 *   a suppressor that keeps changing character. Settle.
 * - Anything less is the intermittent spike the tiers are meant to ride out.
 *   Keep DeepFilter.
 *
 * Settling is per graph: any new graph (the next call, a mic restart, the
 * member's "Try DeepFilter again") starts on DeepFilter. Until 0.9.815 the
 * FIRST episode settled, by rebuilding the mic on RNNoise for the rest of the
 * app session.
 *
 * Pure (the clock is passed in) so the thresholds are pinned by tests rather
 * than by a live CPU spike.
 */

export const SUSTAINED_MS = 15_000;
export const REPEAT_EPISODES = 4;
export const REPEAT_WINDOW_MS = 180_000;

export type SettleReason = 'sustained' | 'repeated';

export class DfOverloadPolicy {
    private starts: number[] = [];
    private openSince: number | null = null;
    private settledFor: SettleReason | null = null;

    get settled(): SettleReason | null {
        return this.settledFor;
    }

    /** An episode has started and not yet ended (and nothing has settled). */
    get episodeOpen(): boolean {
        return this.openSince !== null;
    }

    /** An episode began. Returns the reason to settle, if this one is it. */
    onOverload(nowMs: number): SettleReason | null {
        if (this.settledFor) return null;
        this.openSince = nowMs;
        this.starts = this.starts.filter((t) => nowMs - t < REPEAT_WINDOW_MS);
        this.starts.push(nowMs);
        return this.starts.length >= REPEAT_EPISODES ? this.settle('repeated') : null;
    }

    /** The episode ended: the Worker stayed caught up. */
    onRecovered(): void {
        this.openSince = null;
    }

    /** Poll while an episode is open (the caller times it at SUSTAINED_MS). */
    check(nowMs: number): SettleReason | null {
        if (this.settledFor || this.openSince === null) return null;
        return nowMs - this.openSince >= SUSTAINED_MS ? this.settle('sustained') : null;
    }

    private settle(reason: SettleReason): SettleReason {
        this.settledFor = reason;
        this.openSince = null;
        return reason;
    }
}
