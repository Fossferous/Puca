/**
 * Is the Deck's microphone sending digital silence?
 *
 * A muted input, or one turned all the way down in Steam's Settings → Audio,
 * delivers exact zeros. That is how the owner's Deck was found in testing
 * (2026-10-23): every round carried silence until the system microphone was
 * turned up, while the call itself worked perfectly. A working microphone
 * never delivers exact zeros, not even in a quiet room: its noise floor is
 * always there.
 *
 * Fed the capture's cumulative audio energy and duration
 * (RTCAudioSourceStats.totalAudioEnergy / totalSamplesDuration, from the
 * bridge's own connection) every couple of seconds. It judges by what arrived
 * since the last reading, not the totals, so a microphone muted in the middle
 * of a call is noticed too:
 *
 * - "silent" after SILENT_AFTER_S of captured audio with no energy at all;
 * - "not silent" as soon as any energy arrives.
 */
export const SILENT_AFTER_S = 3;

export class SilenceVerdict {
    private silent = false;
    private energy = 0;
    private duration = 0;
    private zeroFor = 0;

    get isSilent(): boolean {
        return this.silent;
    }

    /** One reading of the totals. The new verdict when it changed, else null. */
    update(totalEnergy: number, totalDurationS: number): boolean | null {
        if (!Number.isFinite(totalEnergy) || !Number.isFinite(totalDurationS)) return null;
        const energy = totalEnergy - this.energy;
        const duration = totalDurationS - this.duration;
        this.energy = totalEnergy;
        this.duration = totalDurationS;
        if (duration <= 0) return null; // nothing captured since the last reading
        this.zeroFor = energy > 0 ? 0 : this.zeroFor + duration;
        const silent = this.zeroFor >= SILENT_AFTER_S;
        if (silent === this.silent) return null;
        this.silent = silent;
        return silent;
    }
}

/** "Your Deck's microphone is muted" pops up at most this often. */
export const NOTICE_EVERY_MS = 5 * 60 * 1000;

/** What the notice needs to know about the call (EmbedCall's fields). */
export interface CallMic {
    connected: boolean;
    muted: boolean;
    deafened: boolean;
    noMicrophone: boolean;
}

/**
 * When to pop "Your Deck's microphone is muted" up over the game: when
 * someone is trying to be heard and cannot be. That is, in the call and not
 * muted, deafened or without a microphone in Púca. Someone who muted
 * themselves meant it. Once each time that starts, and at most every
 * NOTICE_EVERY_MS. The panel says it regardless, for as long as it lasts.
 */
export class SilentNotice {
    private due = false;
    private lastAt: number | null = null;

    /** Fed on every change. True when the notice should pop up now. */
    update(micSilent: boolean, call: CallMic | null, now: number): boolean {
        const due = micSilent && call !== null && call.connected && !call.muted && !call.deafened && !call.noMicrophone;
        const starts = due && !this.due;
        this.due = due;
        if (!starts) return false;
        if (this.lastAt !== null && now - this.lastAt < NOTICE_EVERY_MS) return false;
        this.lastAt = now;
        return true;
    }
}
