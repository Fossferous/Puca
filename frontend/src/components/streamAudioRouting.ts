/**
 * Who plays a watched stream's audio — ONE path per stream, always.
 *
 *  - While StreamStage is mounted, its Web Audio graph owns stream audio
 *    (per-stream volume with >100% boost, attenuation ducking, the master).
 *    It CLAIMS ownership here for as long as it is mounted.
 *  - Everywhere else — chat view with the float, the voice view, Notes, a
 *    DM, the dashboards, the phone's docked strip — StreamAudioHost plays
 *    every watched stream through one hidden <audio> per stream.
 *
 * Every <video> that shows a stream outside the stage (the float, the OS
 * popout host, the Doc-PiP tiles) is hard-muted: picture only.
 *
 * Why a claim and not viewMode: the stage is not mounted for every
 * viewMode === 'stream' (the All-checklists board takes the same slot), and
 * reading what is actually mounted cannot drift from the render branches.
 * Claims notify SYNCHRONOUSLY so the host mutes inside the stage's own
 * commit, before the stage graph can reach the speakers (it joins only after
 * an awaited output-device routing).
 */

let stageClaims = 0;
const listeners = new Set<() => void>();

function emit(): void {
    for (const cb of [...listeners]) cb();
}

/** StreamStage, while mounted. Returns the release; calling it twice is a
 *  no-op (StrictMode re-runs effects). */
export function claimStageAudio(): () => void {
    stageClaims += 1;
    emit();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        stageClaims -= 1;
        emit();
    };
}

/** Is a stage mounted (so it, not the host, plays stream audio)? */
export function stageOwnsStreamAudio(): boolean {
    return stageClaims > 0;
}

export function subscribeStageAudio(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export interface StreamAudioEntry {
    userId: number;
    /** May this stream's host element be unmuted (before output routing)? */
    audible: boolean;
    /** Element volume, 0..1. */
    volume: number;
}

/**
 * The host's plan: one entry per watched stream except your own share (the
 * game you are playing is already your audio). Volume is the stream's own
 * level times the master Output Volume, clamped to what an element can do —
 * the >100% boost lives in the stage's graph, as it did for the float.
 */
export function streamAudioPlan(input: {
    selected: readonly number[];
    ownId: number | null;
    stageOwns: boolean;
    mutes: Record<number, boolean>;
    volumes: Record<number, number>;
    master: number;
    defaultVolume?: number;
}): StreamAudioEntry[] {
    const def = input.defaultVolume ?? 100;
    return input.selected
        .filter(id => id !== input.ownId)
        .map(userId => {
            const level = ((input.volumes[userId] ?? def) / 100) * input.master;
            return {
                userId,
                audible: !input.stageOwns && !input.mutes[userId],
                volume: Math.min(Math.max(level, 0), 1),
            };
        });
}
