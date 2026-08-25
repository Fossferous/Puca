/**
 * No-picker native capture for Clips auto-arm (desktop only).
 *
 * `getDisplayMedia` cannot be made picker-free from JS — Chromium always
 * draws the source-selection dialog (`replayBuffer.ts`'s header explains why
 * this is a hard platform limit, not a missing flag). This module instead
 * drives the SAME native machinery the remote-desktop agent uses for
 * unattended, no-picker capture (`frontend/src-tauri/src/clip_capture.rs`,
 * `clip_desktop_audio.rs`): DXGI Desktop Duplication + the MFT hardware H.264
 * encoder for video, classic WASAPI loopback for system audio. The target
 * monitor is chosen automatically — whichever monitor a fullscreen
 * app/game is filling, else the primary monitor (`clip_capture.rs::choose_target`).
 *
 * Two different shapes, deliberately:
 *  - VIDEO arrives ALREADY ENCODED (Annex-B H.264) — `startNativeVideo`'s
 *    `onChunk` callback feeds `replayWorker.ts`'s `nativeVideoChunk` message
 *    directly. There is no VideoFrame here to route through a MediaStream;
 *    the worker's `Ring.ingestNativeVideoChunk` constructs a real
 *    `EncodedVideoChunk` from the bytes and hands it to the SAME
 *    GOP-closing code the WebCodecs path uses.
 *  - AUDIO arrives as raw PCM and is turned into a real `MediaStreamTrack`
 *    (via a `MediaStreamAudioDestinationNode`, the exact trick
 *    `api/appAudio.ts` already uses for per-app "game audio" in a screen
 *    share) — so `replayBuffer.ts`'s existing `sysGain`→`dest` mixing graph
 *    needs no changes at all; a native system-audio track plugs into the
 *    same `sysTrack` slot getDisplayMedia's audio track fills today.
 *
 * A SEPARATE Rust module and a separate event name from `audio_capture.rs`'s
 * per-app capture on purpose: that module's capture state is a process-wide
 * singleton a live screen share may already be using for its own "include
 * this app's audio" feature, and starting a second capture through it would
 * silently stop the share's audio to start the clip's. Sharing a screen WITH
 * game audio while the clip buffer is separately armed is an ordinary case.
 */
import { isTauri } from '../platform';

export interface NativeCaptureTarget {
    outputIndex: number;
    width: number;
    height: number;
    reason: 'fullscreen' | 'primary';
    /** The bitrate the Rust encoder was ACTUALLY configured with (the preset
     *  bitrate scaled to the captured monitor's real pixel count, clamped
     *  1.5-20 Mbps — clip_capture.rs::scale_bitrate). 0 from pickCaptureTarget,
     *  which starts no encoder. */
    bitrate: number;
}

interface RustTarget {
    output_index: number;
    width: number;
    height: number;
    reason: string;
    bitrate: number;
}

export function isNativeCaptureSupported(): boolean {
    return isTauri();
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export interface NativeVideoChunk {
    keyframe: boolean;
    tsUs: number;
    durUs: number;
    bytes: ArrayBuffer;
    codec?: string;
    codedWidth?: number;
    codedHeight?: number;
}

export interface NativeVideoHandle {
    target: NativeCaptureTarget;
    stop: () => Promise<void>;
}

/** Start native video capture+encode. `onChunk` fires once per access unit,
 *  in capture order, until `stop()` is called or `onError` fires. Resolves
 *  only once DXGI + the hardware encoder are actually running (or rejects
 *  with the real reason) — mirrors `start_app_audio_capture`'s blocking-init
 *  contract, so a broken capture never reports itself armed. */
export async function startNativeVideo(
    opts: { fps: number; bitrate: number; assumedPixels: number; gopMs: number },
    onChunk: (c: NativeVideoChunk) => void,
    onError?: (message: string) => void,
): Promise<NativeVideoHandle> {
    if (!isTauri()) throw new Error('native capture is desktop only');
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const unlistenChunk = await listen<{
        data: string; keyframe: boolean; ts_us: number; dur_us: number; codec: string | null; width: number; height: number;
    }>('clip-video-chunk', (event) => {
        const p = event.payload;
        const bytes = base64ToBytes(p.data);
        onChunk({
            keyframe: p.keyframe, tsUs: p.ts_us, durUs: p.dur_us,
            bytes: bytes.buffer as ArrayBuffer, codec: p.codec ?? undefined, codedWidth: p.width, codedHeight: p.height,
        });
    });
    const unlistenError = onError ? await listen<string>('clip-video-capture-error', (e) => onError(e.payload)) : null;

    let target: RustTarget;
    try {
        target = await invoke<RustTarget>('start_clip_video_capture', { fps: opts.fps, bitrate: opts.bitrate, assumedPixels: opts.assumedPixels, gopMs: opts.gopMs });
    } catch (e) {
        unlistenChunk();
        unlistenError?.();
        throw e instanceof Error ? e : new Error(String(e));
    }

    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        unlistenChunk();
        unlistenError?.();
        try { await invoke('stop_clip_video_capture'); } catch { /* already stopped */ }
    };
    return {
        target: { outputIndex: target.output_index, width: target.width, height: target.height, reason: target.reason === 'fullscreen' ? 'fullscreen' : 'primary', bitrate: target.bitrate },
        stop,
    };
}

// ---- system audio: same wire shape as api/appAudio.ts, standalone state ----

interface ClipAudioDataEvent {
    data: string; // base64 f32 LE PCM, interleaved
    sample_rate: number;
    channels: number;
    bits_per_sample: number;
    silent: boolean;
}

const JITTER_S = 0.05;
const MAX_BACKLOG_S = 0.5;
const RESUME_POLL_MS = 500;

export interface NativeAudioHandle {
    track: MediaStreamTrack;
    stop: () => Promise<void>;
}

/** Start native desktop (system) audio loopback and return it as a live
 *  MediaStreamTrack, ready to plug into `replayBuffer.ts`'s existing
 *  `sysTrack` mixing slot exactly where getDisplayMedia's audio track goes
 *  today. `onError` fires for a capture that dies mid-stream (WASAPI error
 *  after a successful start); a failed START rejects the returned promise. */
export async function startNativeSystemAudioTrack(onError?: (message: string) => void): Promise<NativeAudioHandle> {
    if (!isTauri()) throw new Error('native capture is desktop only');
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    const ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* gesture pending */ } }
    // Same reasoning as api/appAudio.ts: a picker-consumed gesture (there is
    // none here — that's the whole point) or an autoplay policy can leave the
    // context suspended while packets keep arriving and scheduling silently
    // into nothing. Keep polling resume(); cheap no-op once running.
    const nudge = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => { /* still no activation */ }); };
    window.addEventListener('pointerdown', nudge);
    window.addEventListener('keydown', nudge);
    const resumeTimer = setInterval(() => { if (ctx.state !== 'running') ctx.resume().catch(() => { /* not yet */ }); }, RESUME_POLL_MS);

    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    let playhead = 0;

    const unlistenData = await listen<ClipAudioDataEvent>('clip-audio-data', (event) => {
        try {
            const { data, sample_rate, channels } = event.payload;
            const bytes = base64ToBytes(data);
            const interleaved = new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
            const frames = Math.floor(interleaved.length / channels);
            if (frames === 0) return;
            const buf = ctx.createBuffer(channels, frames, sample_rate);
            for (let ch = 0; ch < channels; ch++) {
                const chan = buf.getChannelData(ch);
                for (let i = 0; i < frames; i++) chan[i] = interleaved[i * channels + ch];
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(dest);
            const now = ctx.currentTime;
            if (playhead < now + 0.01) playhead = now + JITTER_S; // prime / recover from underrun
            else if (playhead > now + MAX_BACKLOG_S) playhead = now + JITTER_S; // drift reset
            src.start(playhead);
            playhead += buf.duration;
        } catch (err) {
            console.warn('[nativeCapture] Dropped malformed desktop-audio chunk:', err);
        }
    });
    const unlistenError = onError
        ? await listen<string>('clip-audio-capture-error', (e) => onError(e.payload))
        : null;

    const teardown = async () => {
        clearInterval(resumeTimer);
        window.removeEventListener('pointerdown', nudge);
        window.removeEventListener('keydown', nudge);
        unlistenData();
        unlistenError?.();
        try { await invoke('stop_clip_desktop_audio'); } catch { /* already stopped */ }
        ctx.close().catch(() => { /* already closed */ });
    };

    try {
        await invoke('start_clip_desktop_audio');
    } catch (e) {
        await teardown();
        throw e instanceof Error ? e : new Error(String(e));
    }

    let stopped = false;
    return {
        track: dest.stream.getAudioTracks()[0],
        stop: async () => { if (stopped) return; stopped = true; await teardown(); },
    };
}
