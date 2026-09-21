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
 * monitor is chosen automatically — the PRIMARY display (the
 * follow-the-fullscreen-app rule was removed; see clip_capture.rs)
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
    reason: 'primary';
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
    /** Which capture this start began (clip_capture.rs). Chunks and the
     *  death of any OTHER capture are dropped, and stop names it. */
    generation?: number;
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

    // Set once the start resolves. Chunks carrying a DIFFERENT generation are
    // another capture's: the predecessor's tail after "Restart buffer"
    // (the sidecar dies within a 50 ms poll of its stop, but its last frames
    // are already in the pipe and the event queue), stamped with the OLD
    // capture's clock. One of those, taken as a clock sample by the replay
    // worker, put every later clip's audio late by the old session's
    // length. Same rule and the same shape as the audio side below.
    let myGeneration: number | null = null;
    const foreign = (g: number | undefined): boolean =>
        typeof g === 'number' && myGeneration !== null && g !== myGeneration;

    const unlistenChunk = await listen<{
        data: string; keyframe: boolean; ts_us: number; dur_us: number; codec: string | null; width: number; height: number; generation?: number;
    }>('clip-video-chunk', (event) => {
        const p = event.payload;
        if (foreign(p.generation)) return;
        const bytes = base64ToBytes(p.data);
        onChunk({
            keyframe: p.keyframe, tsUs: p.ts_us, durUs: p.dur_us,
            bytes: bytes.buffer as ArrayBuffer, codec: p.codec ?? undefined, codedWidth: p.width, codedHeight: p.height,
        });
    });
    const unlistenError = onError
        ? await listen<{ message?: string; generation?: number } | string>('clip-video-capture-error', (e) => {
            // A stale death: the OLD capture's error landing after a
            // successful restart must not disarm the new one.
            const p = e.payload;
            if (typeof p === 'string') { onError(p); return; }
            if (foreign(p?.generation)) return;
            onError(typeof p?.message === 'string' ? p.message : String(p));
        })
        : null;

    let target: RustTarget;
    try {
        target = await invoke<RustTarget>('start_clip_video_capture', { fps: opts.fps, bitrate: opts.bitrate, assumedPixels: opts.assumedPixels, gopMs: opts.gopMs });
        myGeneration = typeof target?.generation === 'number' ? target.generation : null;
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
        // Stop ONLY the capture this handle owns; a missing number (never
        // on this shell, which bundles both ends) degrades to the
        // unconditional stop, as the audio side does.
        try { await invoke('stop_clip_video_capture', { generation: myGeneration }); } catch { /* already stopped */ }
    };
    return {
        target: { outputIndex: target.output_index, width: target.width, height: target.height, reason: 'primary', bitrate: target.bitrate },
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
    /** Which capture produced this (clip_desktop_audio.rs). Events from a
     *  generation this handle does not own are dropped — an old capture
     *  thread can outlive its stop signal by up to one 100ms wait, and its
     *  tail must not feed (or error) the replacement. */
    generation?: number;
}

const JITTER_S = 0.05;
const MAX_BACKLOG_S = 0.5;
const RESUME_POLL_MS = 500;

export interface NativeAudioHandle {
    track: MediaStreamTrack;
    /** WASAPI's friendly name for the render device the loopback is ACTUALLY
     *  listening to — what the Rust side opened, not what was asked for. */
    deviceName: string | null;
    stop: () => Promise<void>;
}

/**
 * The friendly name of the output device the user picked in Settings, or null
 * for "default" (or when the id no longer resolves — an unplugged device must
 * fall back to the default loopback, mirroring `applyOutputDevice`).
 *
 * Why a NAME crosses the process boundary and not the id: `outputDeviceId` is
 * a browser `enumerateDevices` id, salted per origin — WASAPI has never heard
 * of it. The label is the one spelling both sides share, and the Rust side
 * matches it leniently (`pick_render_device`) because the two stacks
 * sometimes decorate the same device differently.
 */
export async function preferredLoopbackDeviceName(): Promise<string | null> {
    try {
        const { loadSettings } = await import('../../components/settingsStore');
        const id = loadSettings().outputDeviceId;
        if (!id || id === 'default') return null;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const label = devices.find(d => d.kind === 'audiooutput' && d.deviceId === id)?.label;
        return label || null;
    } catch {
        return null;
    }
}

/** Start native desktop (system) audio loopback and return it as a live
 *  MediaStreamTrack, ready to plug into `replayBuffer.ts`'s existing
 *  `sysTrack` mixing slot exactly where getDisplayMedia's audio track goes
 *  today. `onError` fires for a capture that dies mid-stream (WASAPI error
 *  after a successful start); a failed START rejects the returned promise. */
export async function startNativeSystemAudioTrack(
    onError?: (message: string) => void,
    deviceName?: string | null,
    // Called per packet with the EPOCH time (performance.timeOrigin +
    // performance.now, ms) its first sample will RENDER at and the scheduling
    // lead that puts it there. Epoch, not performance.now: the worker that
    // consumes this has its own time origin (its creation), so a plain
    // performance.now would be off by however long the app had been open.
    // The clip worker subtracts that lead: see the comment at src.start.
    onLead?: (renderAtMs: number, leadMs: number) => void,
): Promise<NativeAudioHandle> {
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
    // Sources scheduled ahead of the clock. A drift reset DROPS the backlog
    // they hold: they are stopped rather than left to play over the
    // re-primed packets (a summed overlap of up to MAX_BACKLOG_S), so the
    // mix carries a gap of about JITTER_S there and the clip worker's lead
    // correction stays exact on both sides of it.
    const pending = new Set<AudioBufferSourceNode>();

    // Set once the start resolves. Events carrying a DIFFERENT generation are
    // another capture's (a predecessor's tail, or a successor after this one
    // lost an ownership race) and are dropped. Events arriving before the
    // start resolves are accepted — the worst pre-resolve mistake is <100ms
    // of the old device's PCM into a graph nobody is recording from yet.
    let myGeneration: number | null = null;
    const foreign = (g: number | undefined): boolean =>
        typeof g === 'number' && myGeneration !== null && g !== myGeneration;

    const unlistenData = await listen<ClipAudioDataEvent>('clip-audio-data', (event) => {
        try {
            if (foreign(event.payload.generation)) return;
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
            else if (playhead > now + MAX_BACKLOG_S) { // drift reset: the backlog is dropped
                for (const p of pending) { try { p.stop(); } catch { /* already ended */ } }
                pending.clear();
                playhead = now + JITTER_S;
            }
            pending.add(src);
            src.onended = () => { pending.delete(src); };
            src.start(playhead);
            // THE SCHEDULING LEAD is A/V error. This packet was captured up to
            // now, and renders `playhead - now` later: JITTER_S at a prime,
            // then whatever the gap between the capture device's clock and
            // this context's clock has accumulated, up to MAX_BACKLOG_S. The
            // clip pipeline downstream sees only render times, so without
            // this figure a clip's system audio lands late by the lead — 100
            // to 200 ms, and drifting within one session, measured 2026-09-21
            // by e2e/clip-av-emulation.mjs. Reported with the wall time the
            // packet renders at, which is what the worker can look up an
            // audio sample by (replayWorker.ts leadUsAt).
            const leadMs = (playhead - now) * 1000;
            onLead?.(performance.timeOrigin + performance.now() + leadMs, leadMs);
            playhead += buf.duration;
        } catch (err) {
            console.warn('[nativeCapture] Dropped malformed desktop-audio chunk:', err);
        }
    });
    const unlistenError = onError
        ? await listen<{ message?: string; generation?: number }>(
            'clip-audio-capture-error',
            (e) => {
                // A stale death — the OLD thread's error landing after a
                // successful retry — must not flip a healthy capture to
                // 'died'. That ordering is real: the capture thread clears
                // its claim BEFORE emitting the error.
                if (foreign(e.payload?.generation)) return;
                onError(typeof e.payload?.message === 'string' ? e.payload.message : String(e.payload));
            })
        : null;

    const teardown = async () => {
        clearInterval(resumeTimer);
        window.removeEventListener('pointerdown', nudge);
        window.removeEventListener('keydown', nudge);
        unlistenData();
        unlistenError?.();
        // Stop ONLY the capture this handle owns. A start that never
        // succeeded owns nothing, and the old unconditional stop here is
        // exactly how a start that lost the singleton race killed the
        // winner's capture through the clean exit path — no error event, a
        // session claiming system audio while recording none. The one failed
        // start that DID claim (the init timeout) reclaims itself Rust-side.
        // A missing generation on a SUCCESSFUL start degrades to the
        // unconditional stop (Rust treats absence that way) — owning a
        // capture without its number must still be able to end it.
        if (started) {
            try {
                await invoke('stop_clip_desktop_audio', { generation: myGeneration });
            } catch { /* already stopped */ }
        }
        ctx.close().catch(() => { /* already closed */ });
    };

    let capturedName: string | null = null;
    let started = false;
    try {
        // The desktop shell bundles this frontend (one artifact), so the
        // reply shape versions with us; the guards are against a malformed
        // reply, not skew.
        const reply = await invoke<{ device_name?: unknown; generation?: unknown }>(
            'start_clip_desktop_audio',
            { deviceName: deviceName ?? null },
        );
        started = true;
        capturedName = typeof reply?.device_name === 'string' && reply.device_name
            ? reply.device_name : null;
        myGeneration = typeof reply?.generation === 'number' ? reply.generation : null;
    } catch (e) {
        await teardown();
        throw e instanceof Error ? e : new Error(String(e));
    }

    let stopped = false;
    return {
        track: dest.stream.getAudioTracks()[0],
        deviceName: capturedName,
        stop: async () => { if (stopped) return; stopped = true; await teardown(); },
    };
}
