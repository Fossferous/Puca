/**
 * Types shared by the replay-buffer controller (main thread) and the worker.
 * Kept free of runtime code so both sides can import it without side effects.
 */
import type { ClipPreset } from './clipPresets';
import type { ClipAudioCodec } from './clipRef';

export type { ClipAudioCodec };

export interface ArmConfig {
    preset: ClipPreset;
    /** Capture geometry actually granted (track.getSettings()). */
    width: number;
    height: number;
    /** Ring length target, ms (server max clamped by memory). */
    ringMs: number;
    /** Hard memory ceiling for the ring, bytes. */
    maxRingBytes: number;
    /** Audio timeline shift applied to audio timestamps, µs (+ delays audio).
     *  Measured by the Phase 0 spike (audio arrived ~40 ms early). */
    audioOffsetUs: number;
    /** Preferred audio codec; the worker falls back to opus if unsupported. */
    audioCodec: ClipAudioCodec;
    /** Debug: log verbose per-second stats to the worker console. */
    verbose?: boolean;
    /** Set only for a native (no-picker) capture: video chunks arrive via
     *  `nativeVideoChunk` messages instead of the `video` stream (which is
     *  `null` in that case) — see replayWorker.ts's header and clip_capture.rs. */
    nativeVideo?: { fps: number };
}

/** main → worker. `video`/`audio` readables are TRANSFERRED. `video` is
 *  `null` only for a native capture (`cfg.nativeVideo` set) — see `nativeVideoChunk`. */
export type ToWorker =
    | { t: 'arm'; cfg: ArmConfig; video: ReadableStream<VideoFrame> | null; audio: ReadableStream<AudioData> | null }
    | { t: 'rebindAudio'; audio: ReadableStream<AudioData> | null }
    /** One already-encoded Annex-B access unit from clip_capture.rs, in
     *  capture order. `bytes` is TRANSFERRED. `codec`/`codedWidth`/`codedHeight`
     *  are present only on the chunk that carries a fresh SPS (in practice the
     *  first one) — see clip_capture.rs's `sps_codec_string`. Only valid after
     *  an `arm` whose `cfg.nativeVideo` was set. */
    | { t: 'nativeVideoChunk'; keyframe: boolean; tsUs: number; durUs: number; bytes: ArrayBuffer; codec?: string; codedWidth?: number; codedHeight?: number }
    /** `maxMs`: the server's longest-clip policy — the sealed clip must not exceed it (see clipRing.selectWindow). */
    | { t: 'seal'; clipId: string; requestedMs: number; maxMs?: number }
    /** ONLY ever sent by the composer after `outgoing.status === 'approved'`
     *  (docs/CLIPS.md) — the worker itself enforces nothing about approval, the
     *  same way it never did before consent existed. Streams the CURRENT sealed
     *  clip to a worker-side MediaSource; nothing is decoded on the main thread. */
    /** `seq` lets the main thread ignore results of a superseded preview. */
    | { t: 'preview'; seq: number }
    /** Narrow the sealed clip to [startMs, endMs] of its OWN timeline — can only
     *  SHRINK what was already approved, never add footage outside the approved
     *  window, so it needs no new consent. The worker RE-MUXES the kept range
     *  (clipTrim.ts) into a fresh fMP4 starting at 0, snapping outward to the
     *  nearest keyframes (~2 s), and seals the result under FRESH clip secrets
     *  (re-using the old key would repeat AES-GCM nonces across indices). Replies
     *  `sealed` with the new info, or `trimFailed` leaving the original intact. */
    | { t: 'trim'; startMs: number; endMs: number; token?: string; baseUrl?: string }   // token+baseUrl ⇒ also DELETE parts a failed upload already landed
    /** `proposalId` is the SERVER's clip id (the approved proposal); it is the
     *  multipart `clip_id` the consent gate checks. The seal-time id in the
     *  manifest is a separate crypto binding (AAD) and stays as sealed. */
    | { t: 'upload'; token: string; baseUrl: string; proposalId: string; onlyMissing: boolean }
    | { t: 'discardSeal'; token?: string; baseUrl?: string }   // token+baseUrl ⇒ also DELETE parts already uploaded
    | { t: 'wipe' };

export interface WorkerStatus {
    bufferedMs: number;
    ringBytes: number;
    gops: number;
    droppedFrames: number;
    /** Rolling one-second measurements. */
    fps: number;
    kbps: number;
    encodedFrames: number;
    hasAudio: boolean;
    videoCodec: string | null;
    audioCodec: ClipAudioCodec | null;
    width: number;
    height: number;
}

export interface SealedInfo {
    clipId: string;
    /** Real duration of the sealed clip (may exceed the request by the lead-in). */
    durationMs: number;
    leadInMs: number;
    /** Footage dropped because it predated a resolution change. */
    lostMs: number;
    width: number;
    height: number;
    partCount: number;
    totalCipherBytes: number;
    videoCodec: string;
    audioCodec: ClipAudioCodec | null;
    /** Per-part durations, ms (index 0 = init segment = 0). */
    partDurMs: number[];
}

/** worker → main */
export type FromWorker =
    | { t: 'armed'; videoCodec: string; audioCodec: ClipAudioCodec | null; width: number; height: number }
    | { t: 'status'; s: WorkerStatus }
    | { t: 'sealed'; info: SealedInfo }
    | { t: 'sealFailed'; message: string }
    | { t: 'previewHandle'; seq: number; handle: MediaSourceHandle }
    | { t: 'previewReady'; seq: number; durationMs: number }
    | { t: 'previewFailed'; seq: number; message: string }
    /** Trim failed: unlike `sealFailed`, the EXISTING sealed clip is untouched
     *  and still postable as-is — this must not wipe it or drop the phase back. */
    | { t: 'trimFailed'; message: string }
    | { t: 'uploadProgress'; done: number; total: number; bytesDone: number }
    | { t: 'uploaded'; href: string; partIds: string[] }
    | { t: 'uploadFailed'; message: string; status?: number; failedIdx: number[] }
    | { t: 'reconfigured'; width: number; height: number; lostMs: number }
    /** `stage` is a pipeline stage OR the `t` of the message that threw (the
     *  main thread settles that message's pending promise by this name). */
    | { t: 'error'; stage: 'video' | 'audio' | 'crypto' | 'mux' | ToWorker['t']; message: string; fatal: boolean }
    | { t: 'wiped' };
