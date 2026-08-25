/**
 * Joins we have been TOLD about but have not yet ANNOUNCED.
 *
 * `UserJoined` is the very first packet of a join — the joiner sends the WS
 * room-join before it has even asked for the microphone, let alone connected
 * to the SFU, installed the E2EE worker and been acked a decryptor. Chiming on
 * that packet told everyone "X is here" seconds before X could hear a word,
 * so people started talking into a void ("they think you will hear them when
 * they talk"). The roster entry still appears immediately — presence is
 * presence — but the chime and the spoken announcement wait here until the
 * peer is actually reachable, and the tile carries a `connecting` chip
 * meanwhile.
 *
 * "Reachable" is decided by the caller's probe, per tick:
 *   ready ⇔ encrypted                                     — we can decrypt their media; the
 *                                                            room key is symmetric per epoch, so
 *                                                            they can decrypt ours too
 *         ∨ present continuously for ≥ graceMs             — they are in the SFU room / the mesh
 *                                                            pc is connected but they publish
 *                                                            nothing (listen-only): the E2EE
 *                                                            verdict reads 'negotiating' forever
 *                                                            for a pub-less participant, so this
 *                                                            arm is mandatory, not decorative
 *         ∨ waiting ≥ timeoutMs                            — never lose a chime: every leave
 *                                                            chime must have had a join chime,
 *                                                            and a peer whose media never comes
 *                                                            up is still in the channel
 *
 * Pure and clock-injected so the timing rules can be pinned in a unit test.
 * The React side (VoicePanel) owns the interval and the roster chip.
 */

export interface JoinEvidence {
    /** Their media is decryptable by us right now. */
    encrypted: boolean;
    /** Their transport session exists (SFU participant / mesh pc connected). */
    present: boolean;
}

export interface ReadyJoin {
    id: number;
    name: string;
    reason: 'encrypted' | 'present' | 'timeout';
}

interface PendingEntry {
    id: number;
    name: string;
    /** When we were first told about this join. Never restarted by a replay. */
    since: number;
    /** Start of the CURRENT unbroken run of presence, or null while absent. */
    presentSince: number | null;
}

/** How long a present-but-silent peer must stay present before we chime. */
export const JOIN_PRESENT_GRACE_MS = 1500;
/** Hard ceiling on the wait — the chime fires regardless after this. */
export const JOIN_ANNOUNCE_TIMEOUT_MS = 10_000;
/** How often the caller re-probes while anything is pending. */
export const PENDING_JOIN_POLL_MS = 300;

export class PendingJoins {
    private pending = new Map<number, PendingEntry>();
    private readonly now: () => number;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    /**
     * Start holding an announcement for `id`. Returns true when this is a NEW
     * pending join, false when it was already pending — in which case the
     * original `since` is KEPT: a replayed StreamStarted for a still-pending
     * peer must not restart their timeout clock.
     */
    add(id: number, name: string): boolean {
        if (this.pending.has(id)) return false;
        this.pending.set(id, { id, name, since: this.now(), presentSince: null });
        return true;
    }

    /**
     * Evaluate every pending join against fresh evidence. Entries that became
     * ready are REMOVED and returned (announce each exactly once). Presence is
     * tracked as a run: losing it resets the grace, so a flapping peer must
     * re-earn it.
     */
    takeReady(
        probe: (id: number) => JoinEvidence,
        limits: { graceMs: number; timeoutMs: number },
    ): ReadyJoin[] {
        const now = this.now();
        const ready: ReadyJoin[] = [];
        for (const entry of this.pending.values()) {
            const ev = probe(entry.id);
            if (ev.present) {
                if (entry.presentSince === null) entry.presentSince = now;
            } else {
                entry.presentSince = null;
            }
            let reason: ReadyJoin['reason'] | null = null;
            if (ev.encrypted) {
                reason = 'encrypted';
            } else if (entry.presentSince !== null && now - entry.presentSince >= limits.graceMs) {
                reason = 'present';
            } else if (now - entry.since >= limits.timeoutMs) {
                reason = 'timeout';
            }
            if (reason) ready.push({ id: entry.id, name: entry.name, reason });
        }
        for (const r of ready) this.pending.delete(r.id);
        return ready;
    }

    /** Is this id currently being held? A replayed presence event for a held
     *  peer must not be re-classified (e.g. as a silent seed) by the caller. */
    has(id: number): boolean {
        return this.pending.has(id);
    }

    /** They left before we announced them: no late chime. Returns whether it was pending. */
    drop(id: number): boolean {
        return this.pending.delete(id);
    }

    /** Leaving voice / switching rooms. Returns the ids dropped so their chips can be cleared. */
    clear(): number[] {
        const ids = [...this.pending.keys()];
        this.pending.clear();
        return ids;
    }

    ids(): number[] {
        return [...this.pending.keys()];
    }

    get size(): number {
        return this.pending.size;
    }
}
