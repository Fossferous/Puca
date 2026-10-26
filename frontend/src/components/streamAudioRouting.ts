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
 * popout host, the Doc-PiP tiles) is hard-muted: picture only. The host's
 * own <audio>s are sinks; what sounds there is a Web Audio gain per stream,
 * like the stage's, with the element itself as the fallback
 * (streamAudioHostCore.ts).
 *
 * Why a claim and not viewMode: the stage is not mounted for every
 * viewMode === 'stream' (the All-checklists board takes the same slot), and
 * reading what is actually mounted cannot drift from the render branches.
 * Claims notify SYNCHRONOUSLY so the host mutes inside the stage's own
 * commit, before the stage graph can reach the speakers (it joins only after
 * an awaited output-device routing).
 */
import { streamGain } from './streamVolumeStore';

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
    /** May this stream sound here at all (not muted, no stage claim)? */
    audible: boolean;
    /** Element volume, 0..1: the fallback path, which cannot boost. */
    volume: number;
    /** The stream's Web Audio gain: its level on the loudness curve times
     *  the master Output Volume, NOT capped (a boost is real on the graph). */
    gain: number;
}

/**
 * The host's plan: one entry per watched stream except your own share (the
 * game you are playing is already your audio). Each stream's gain is its OWN
 * level (streamGain) times the master Output Volume; the element fallback
 * clamps that to what an element can do.
 */
export function streamAudioPlan(input: {
    selected: readonly number[];
    ownId: number | null;
    stageOwns: boolean;
    mutes: Record<number, boolean>;
    /** Slider positions (streamVolumeStore), by user id. */
    volumes: Record<number, number>;
    master: number;
    defaultVolume?: number;
}): StreamAudioEntry[] {
    const def = input.defaultVolume ?? 100;
    return input.selected
        .filter(id => id !== input.ownId)
        .map(userId => {
            const gain = Math.max(streamGain(input.volumes[userId] ?? def) * input.master, 0);
            return {
                userId,
                audible: !input.stageOwns && !input.mutes[userId],
                volume: Math.min(gain, 1),
                gain,
            };
        });
}
