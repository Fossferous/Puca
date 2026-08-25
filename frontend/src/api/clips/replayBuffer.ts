/**
 * Replay-buffer controller (main thread). Owns the capture — getDisplayMedia
 * for a manual/prompt arm, or the native no-picker path (armNative:
 * nativeCapture.ts driving clip_capture.rs / clip_desktop_audio.rs) for the
 * auto arm — the audio mix graph (system audio + the CURRENT processed mic),
 * the worker that holds the encrypted ring, and a small state bus for the UI.
 *
 * Module singleton, hand-rolled subscribe/emit like api/remoteControl.ts —
 * wire/worker-driven state, not a React store.
 *
 * Desktop (Tauri/WebView2) only: `isClipCaptureSupported()` gates everything.
 * See docs/CLIPS.md for the privacy contract and the wipe table.
 */
import { isTauri } from '../platform';
import { hideCaptureBar, releaseCaptureBar } from '../captureBar';
import { webrtcManager } from '../webrtc';
import { loadSettings } from '../../components/settingsStore';
import { clipPreset, maxRingBytesForBudget, memoryBudgetBytes, MIB } from './clipPresets';
import { isNativeCaptureSupported, preferredLoopbackDeviceName, startNativeSystemAudioTrack, startNativeVideo, type NativeCaptureTarget } from './nativeCapture';
import type { ArmConfig, FromWorker, SealedInfo, ToWorker, WorkerStatus } from './clipTypes';

export type ArmPhase = 'idle' | 'arming' | 'armed' | 'sealing' | 'sealed' | 'uploading' | 'error';

export interface ReplayState {
    phase: ArmPhase;
    /** Milliseconds currently buffered (0 when idle). */
    bufferedMs: number;
    ringBytes: number;
    droppedFrames: number;
    fps: number;
    kbps: number;
    presetId: string;
    width: number;
    height: number;
    /** A system-audio track is feeding the mix (getDisplayMedia's audio
     *  track, or the native WASAPI loopback for an auto arm). */
    hasSystemAudio: boolean;
    /** Native sessions only: WHY there is no system audio, when there isn't.
     *  'start-failed' = the loopback never opened; 'died' = it opened and
     *  then a WASAPI error killed it mid-buffer (a device change, typically).
     *  Drives the "Retry system audio" control — a plain notice string can't,
     *  and before this existed the mid-buffer death left `hasSystemAudio`
     *  TRUE, silently recording mic-only clips that claimed game audio. */
    systemAudioLost: 'start-failed' | 'died' | null;
    /** Native sessions: the render device the loopback is actually listening
     *  to (WASAPI's friendly name), or null when unknown/not captured. */
    systemAudioDevice: string | null;
    /** A mic track was available to tap. */
    hasMic: boolean;
    videoCodec: string | null;
    audioCodec: string | null;
    /** Native (auto) arm only: which monitor was chosen and why — 'fullscreen'
     *  (a chromeless app was filling it) or 'primary'. null for a picker arm,
     *  where the user chose the surface themselves. */
    captureReason: 'fullscreen' | 'primary' | null;
    /** Non-fatal user-facing note (e.g. "no system audio"). */
    notice: string | null;
    /** Fatal error text when phase === 'error'. */
    error: string | null;
    sealed: SealedInfo | null;
    /** Date.now() when the last seal happened (for ended_ago_ms). */
    sealedAt: number | null;
    upload: { done: number; total: number; bytesDone: number } | null;
}

const initial = (): ReplayState => ({
    phase: 'idle', bufferedMs: 0, ringBytes: 0, droppedFrames: 0, fps: 0, kbps: 0, presetId: '1080p30',
    width: 0, height: 0, hasSystemAudio: false, systemAudioLost: null, systemAudioDevice: null,
    hasMic: false, videoCodec: null, audioCodec: null,
    captureReason: null, notice: null, error: null, sealed: null, sealedAt: null, upload: null,
});

let state: ReplayState = initial();
const listeners = new Set<(s: ReplayState) => void>();
const armedListeners = new Set<(armed: boolean) => void>();
function emit(patch: Partial<ReplayState>): void {
    state = { ...state, ...patch };
    for (const l of listeners) { try { l(state); } catch { /* listener bug must not break the buffer */ } }
}

export function subscribeReplay(cb: (s: ReplayState) => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}
export function getReplayState(): ReplayState { return state; }
/** Fires on every armed⇄disarmed transition — VoicePanel broadcasts the roster badge from this. */
export function onArmedChange(cb: (armed: boolean) => void): () => void {
    armedListeners.add(cb);
    return () => { armedListeners.delete(cb); };
}
function notifyArmed(armed: boolean): void {
    for (const l of armedListeners) { try { l(armed); } catch { /* ignore */ } }
    // The TRAY is the one always-present indicator: for a native (auto) arm
    // there is no picker and no sharing bar, and the in-panel pill is behind
    // the fullscreen game — exactly when auto-arm runs. Best effort; the
    // roster badge and pill do not depend on it. `state.captureReason` is set
    // before every armed:true notification (armNative emits first; a picker
    // arm leaves it null → generic wording).
    if (isTauri()) {
        const reason = state.captureReason;
        void import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('set_clip_armed_indicator', { armed, reason }))
            .catch(() => { /* older shell without the command */ });
    }
}

/** Spike-measured: audio arrived ~40 ms EARLY relative to video; delay it. */
export const AUDIO_OFFSET_US = 40_000;

export function isClipCaptureSupported(): boolean {
    if (!isTauri()) return false;
    const w = window as unknown as Record<string, unknown>;
    return typeof w.VideoEncoder === 'function' && typeof w.MediaStreamTrackProcessor === 'function'
        && !!navigator.mediaDevices?.getDisplayMedia && !!globalThis.crypto?.subtle;
}

// ---- live session -----------------------------------------------------------
interface Session {
    worker: Worker;
    /** For a native session this is an empty, never-started MediaStream - the
     *  disarm() teardown that stops its tracks is then a harmless no-op, so
     *  that path needs no native/browser branch. */
    stream: MediaStream;
    ctx: AudioContext | null;
    dest: MediaStreamAudioDestinationNode | null;
    sysGain: GainNode | null;
    micGain: GainNode | null;
    micSrc: MediaStreamAudioSourceNode | null;
    unMic: (() => void) | null;
    resumeTimer: ReturnType<typeof setInterval> | null;
    pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    onWiped: (() => void) | null;
    /** The <video> currently fed by the worker-side preview, if any. Post-approval only. */
    previewEl: HTMLVideoElement | null;
    /** Sequence of the LATEST preview request; results tagged with an older seq are ignored. */
    previewSeq: number;
    /** Native (no-picker) session teardown - stops the Rust-side capture
     *  threads. disarm() calls this before anything else if present. Reads
     *  `sysAudioStop` at CALL time, so a retried audio capture is the one
     *  that gets stopped. */
    nativeStop: (() => Promise<void>) | null;
    /** Native sessions: stop the CURRENT system-audio loopback (replaced
     *  wholesale by retrySystemAudio — the Rust capture state is a process
     *  singleton, so the old one must be fully stopped before a new one
     *  starts, or the new start is refused as "already capturing"). */
    sysAudioStop: (() => Promise<void>) | null;
    /** The system-audio leg of the mix graph (source + gain), so a retry can
     *  unhook the dead leg before splicing the fresh one into `dest`. */
    sysSrc: MediaStreamAudioSourceNode | null;
}
let session: Session | null = null;
let armGeneration = 0;

function displayConstraints(maxW: number, maxH: number, fps: number): DisplayMediaStreamOptions {
    const o: DisplayMediaStreamOptions & { systemAudio?: string; selfBrowserSurface?: string; surfaceSwitching?: string } = {
        video: { width: { max: maxW }, height: { max: maxH }, frameRate: { max: fps } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
    };
    // Chromium: offer the "Also share system audio" toggle; keep our own window
    // in the list; do not let the OS switch surfaces under us mid-buffer.
    o.systemAudio = 'include';
    o.selfBrowserSurface = 'include';
    o.surfaceSwitching = 'exclude';
    return o;
}

function buildMicSource(s: Session): void {
    if (!s.ctx || !s.dest) return;
    if (s.micSrc) { try { s.micSrc.disconnect(); } catch { /* ignore */ } s.micSrc = null; }
    const track = webrtcManager.getLocalStreamSync()?.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') { emit({ hasMic: false }); return; }
    // A source over the SAME track (not a clone): a muted mic (track.enabled=false)
    // yields silence here too, so the clip respects mute automatically.
    s.micSrc = s.ctx.createMediaStreamSource(new MediaStream([track]));
    if (!s.micGain) { s.micGain = s.ctx.createGain(); s.micGain.connect(s.dest); }
    s.micGain.gain.value = Math.max(0, Math.min(2, (loadSettings().clipMicGain ?? 100) / 100));
    s.micSrc.connect(s.micGain);
    emit({ hasMic: true });
}

/** Live-apply the mic level slider while armed. */
export function setClipMicGain(percent: number): void {
    if (session?.micGain) session.micGain.gain.value = Math.max(0, Math.min(2, percent / 100));
}

/**
 * Build the SAME sys-gain-dest, mic-gain-dest mix graph arm() has always
 * used, from whatever sysTrack is given - a getDisplayMedia audio track or
 * (for armNative) a native-loopback track from startNativeSystemAudioTrack.
 * Returns the mixed ReadableStream<AudioData> the worker consumes and the
 * mic track found, so both callers can report hasMic identically.
 */
function buildMixedAudio(s: Session, sysTrack: MediaStreamTrack | null): { audioReadable: ReadableStream<AudioData> | null; micTrack: MediaStreamTrack | null } {
    const micTrack = webrtcManager.getLocalStreamSync()?.getAudioTracks()[0] ?? null;
    if (!sysTrack && !micTrack) return { audioReadable: null, micTrack };
    const ctx = new AudioContext({ sampleRate: 48000 });
    s.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    s.dest = dest;
    if (sysTrack) {
        s.sysSrc = ctx.createMediaStreamSource(new MediaStream([sysTrack]));
        s.sysGain = ctx.createGain(); s.sysGain.gain.value = 1;
        s.sysSrc.connect(s.sysGain).connect(dest);
    }
    buildMicSource(s);
    s.unMic = webrtcManager.onMicTrackSwapped(() => buildMicSource(s));
    // A suspended context renders nothing and the clip's audio silently dies
    // (the classic desktop no-audio cause). Poll resume; no-op once running.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* gesture pending */ });
    s.resumeTimer = setInterval(() => { if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* still no activation */ }); }, 2000);
    const mixedTrack = dest.stream.getAudioTracks()[0];
    const aproc = new MediaStreamTrackProcessor({ track: mixedTrack as MediaStreamAudioTrack });
    return { audioReadable: aproc.readable, micTrack };
}

/**
 * Arm the buffer with NO picker: DXGI capture + hardware H.264 encode of
 * whichever monitor a fullscreen app is filling (else the primary monitor),
 * plus native WASAPI desktop-audio loopback for system audio - see
 * nativeCapture.ts's header for why video and audio take different routes
 * into the SAME worker/ring pipeline arm() already built. Desktop only;
 * isNativeCaptureSupported() gates the caller the same way
 * isClipCaptureSupported() gates arm().
 */
export async function armNative(): Promise<void> {
    if (!isNativeCaptureSupported()) throw new Error('native clip capture is not supported here');
    if (session) throw new Error('already armed');
    const gen = ++armGeneration;
    const settings = loadSettings();
    const preset = clipPreset(settings.clipQuality);
    emit({ ...initial(), phase: 'arming', presetId: preset.id, notice: null, error: null });

    const worker = new Worker(new URL('./replayWorker.ts', import.meta.url), { type: 'module' });
    const s: Session = {
        worker, stream: new MediaStream(), ctx: null, dest: null, sysGain: null, micGain: null, micSrc: null,
        unMic: null, resumeTimer: null, pending: new Map(), onWiped: null, previewEl: null, previewSeq: 0,
        nativeStop: null, sysAudioStop: null, sysSrc: null,
    };
    session = s;
    let target: NativeCaptureTarget;
    try {
        const onVideoError = (message: string) => { if (session === s) { void disarm('capture-error'); emit({ notice: `Screen capture ended: ${message}` }); } };
        // A mid-buffer WASAPI death (a device change, typically). The flags
        // must flip WITH the notice: before this, `hasSystemAudio` stayed
        // true and the session silently recorded mic-only clips that claimed
        // game audio. 'died' is what puts the Retry control on screen.
        const onAudioError = (message: string) => {
            if (session !== s) return;
            emit({
                hasSystemAudio: false, systemAudioLost: 'died', systemAudioDevice: null,
                notice: `System audio capture ended: ${message}`,
            });
        };

        // Chunks flow from the Rust capture the moment startNativeVideo
        // resolves, but the worker cannot ingest them until its 'arm' message
        // is posted — which happens only after WASAPI audio init below (the
        // capture geometry has to be known first, so the order cannot flip).
        // QUEUE them until then: a chunk posted before the worker's ring
        // exists is silently dropped, and the very first one carries the
        // codec string the whole session needs. (The Rust side also re-sends
        // the codec on every keyframe, so even a dropped queue self-heals —
        // this queue is what saves the ~seconds of lead-in footage.)
        let chunkQueue: Parameters<typeof postNativeVideoChunk>[1][] | null = [];
        const video = await startNativeVideo(
            // bitrate is the preset's number, tuned for the preset's assumed
            // resolution; the Rust side scales it to the actual monitor
            // (clip_capture.rs::scale_bitrate) and reports the result back
            // in target.bitrate — scaling must live where the target is
            // KNOWN, not before it exists.
            { fps: preset.fps, bitrate: preset.videoBitrate, assumedPixels: Math.max(1, preset.maxWidth * preset.maxHeight), gopMs: 2000 },
            (chunk) => {
                if (session !== s) return;
                if (chunkQueue) {
                    chunkQueue.push(chunk);
                    // 600 FRAMES — 20 s at 30 fps, 10 s at the 60 fps presets.
                    // Dropping the oldest is safe: the codec re-rides every keyframe.
                    if (chunkQueue.length > 600) chunkQueue.shift();
                    return;
                }
                postNativeVideoChunk(s, chunk);
            },
            onVideoError,
        );
        if (gen !== armGeneration) { await video.stop(); return; }
        target = video.target;

        // Fire the local "armed" indicator NOW, before the worker has even
        // seen a frame: DXGI + the hardware encoder (and, if it started,
        // WASAPI loopback) are ALREADY capturing at this point, and native
        // mode has no picker and no capture bar to make that visible any
        // other way — the roster "buffering" badge (notifyArmed) and this
        // session's own status pill are the only indicators left, so they
        // must not wait on the worker parsing a codec string out of the
        // first real keyframe (which can be several hundred ms to seconds
        // away, or — see the watchdog below — never, if the encoder's first
        // keyframe carries no SPS at all).
        emit({ phase: 'armed', width: target.width, height: target.height, captureReason: target.reason });
        notifyArmed(true);

        let audio: Awaited<ReturnType<typeof startNativeSystemAudioTrack>> | null = null;
        try {
            audio = await startNativeSystemAudioTrack(onAudioError, await preferredLoopbackDeviceName());
        } catch (e) {
            // System audio is a nice-to-have here (unlike video, without which
            // there is nothing to clip) - arm mic-only rather than fail the
            // whole session, same as getDisplayMedia's "no system audio" path.
            console.warn('[clips] native desktop audio unavailable, arming mic-only:', e);
        }
        if (gen !== armGeneration) { await video.stop(); await audio?.stop(); return; }

        s.sysAudioStop = audio ? audio.stop : null;
        // `s.sysAudioStop` read at CALL time, not captured: retrySystemAudio
        // replaces the audio leg, and teardown must stop the CURRENT one.
        s.nativeStop = async () => { await video.stop(); await s.sysAudioStop?.(); };
        const { audioReadable, micTrack } = buildMixedAudio(s, audio?.track ?? null);

        const cfg: ArmConfig = {
            preset: { ...preset, videoBitrate: target.bitrate }, width: target.width, height: target.height,
            ringMs: Math.max(10_000, (settings.clipBufferSeconds ?? 300) * 1000),
            maxRingBytes: Math.min((settings.clipMemoryCapMB ?? 1024) * MIB, maxRingBytesForBudget(memoryBudgetBytes((navigator as Navigator & { deviceMemory?: number }).deviceMemory))),
            audioOffsetUs: AUDIO_OFFSET_US, audioCodec: 'mp4a.40.2', verbose: false,
            nativeVideo: { fps: preset.fps },
        };
        worker.onmessage = (ev: MessageEvent<FromWorker>) => handleWorker(s, ev.data);
        worker.onerror = (e) => { emit({ phase: 'error', error: `worker: ${e.message}` }); void disarm('worker-error'); };
        const transfer: Transferable[] = audioReadable ? [audioReadable as unknown as Transferable] : [];
        const msg: ToWorker = { t: 'arm', cfg, video: null, audio: audioReadable };
        worker.postMessage(msg, transfer);
        // Flush the lead-in captured while audio was initialising, IN ORDER,
        // after the arm message (postMessage is FIFO per sender; the worker
        // additionally buffers chunks that interleave with arm()'s own awaits
        // — Ring.pendingNative).
        for (const c of chunkQueue) postNativeVideoChunk(s, c);
        chunkQueue = null;
        emit({
            hasSystemAudio: !!audio, hasMic: !!micTrack, width: target.width, height: target.height,
            systemAudioLost: audio ? null : 'start-failed',
            systemAudioDevice: audio?.deviceName ?? null,
            notice: audio ? null : 'No system audio - the desktop loopback capture could not start; the clip will have your microphone only.',
        });

        // Bounded watchdog: the worker only learns a real videoCodec (and so
        // becomes able to seal/preview at all) from the FIRST native chunk
        // that carries a usable SPS. clip_capture.rs now fails the capture
        // outright after 5 keyframes with none, but a belt-and-suspenders
        // timer here covers any other way that message could be lost or
        // delayed — otherwise the session sits "armed" (per the emit above)
        // forever while nothing can ever actually be clipped from it, with
        // no error for the user to act on.
        const watchdogGen = gen;
        setTimeout(() => {
            if (session !== s || watchdogGen !== armGeneration) return;
            if (state.videoCodec) return; // the worker's real 'armed' landed — fine
            void disarm('native-video-timeout');
            emit({ notice: 'The clip buffer could not start — the video encoder never produced a usable stream.' });
        }, 10_000);
    } catch (e) {
        await disarm('arm-failed');
        emit({ phase: 'idle', notice: `Could not arm: ${e instanceof Error ? e.message : String(e)}` });
    }
}

/**
 * Rebuild the system-audio leg of a LIVE native session, in place — no
 * footage is lost, unlike a full disarm/re-arm. For the two ways native
 * system audio goes missing ('start-failed' and 'died'; the state carries
 * which) after the user has, say, plugged the headset back in.
 *
 * Rejects with 're-arm required' when the live session has no audio graph at
 * all (armed with neither system audio nor mic): the worker's audio rail is
 * fixed at arm time, so there is nothing to splice into — the caller shows
 * "Restart buffer" with honest footage-lost copy instead.
 */
export async function retrySystemAudio(): Promise<void> {
    const s = session;
    if (!s || !s.nativeStop) throw new Error('no native clip session is armed');
    if (!s.ctx || !s.dest) throw new Error('re-arm required');

    // The Rust capture state is a process singleton: the OLD leg must be
    // fully stopped (its listeners, its context, its capture thread) before
    // a new start, or that start is refused as "already capturing". Stopping
    // an already-dead capture is a no-op.
    await s.sysAudioStop?.().catch(() => { /* already dead */ });
    s.sysAudioStop = null;
    if (s.sysSrc) { try { s.sysSrc.disconnect(); } catch { /* already gone */ } s.sysSrc = null; }
    if (s.sysGain) { try { s.sysGain.disconnect(); } catch { /* already gone */ } s.sysGain = null; }

    const onAudioError = (message: string) => {
        if (session !== s) return;
        emit({
            hasSystemAudio: false, systemAudioLost: 'died', systemAudioDevice: null,
            notice: `System audio capture ended: ${message}`,
        });
    };
    const audio = await startNativeSystemAudioTrack(onAudioError, await preferredLoopbackDeviceName());
    if (session !== s) { await audio.stop(); return; }

    s.sysAudioStop = audio.stop;
    s.sysSrc = s.ctx.createMediaStreamSource(new MediaStream([audio.track]));
    s.sysGain = s.ctx.createGain();
    s.sysGain.gain.value = 1;
    s.sysSrc.connect(s.sysGain).connect(s.dest);
    emit({ hasSystemAudio: true, systemAudioLost: null, systemAudioDevice: audio.deviceName, notice: null });
}

function postNativeVideoChunk(s: Session, c: { keyframe: boolean; tsUs: number; durUs: number; bytes: ArrayBuffer; codec?: string; codedWidth?: number; codedHeight?: number }): void {
    const msg: ToWorker = { t: 'nativeVideoChunk', ...c };
    try { s.worker.postMessage(msg, [c.bytes]); } catch { /* worker gone (mid-disarm race) - chunk dropped, harmless */ }
}

/**
 * Arm the buffer. MUST be called from a user gesture (getDisplayMedia).
 * `repick` re-runs the picker for an already-armed session (e.g. the user
 * forgot the system-audio toggle) — the old session is torn down first.
 */
export async function arm(opts: { repick?: boolean } = {}): Promise<void> {
    if (!isClipCaptureSupported()) throw new Error('clip capture is not supported here');
    if (session && !opts.repick) throw new Error('already armed');
    if (session) await disarm('repick');
    const gen = ++armGeneration;
    const settings = loadSettings();
    const preset = clipPreset(settings.clipQuality);
    emit({ ...initial(), phase: 'arming', presetId: preset.id, notice: null, error: null });

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints(preset.maxWidth, preset.maxHeight, preset.fps));
    } catch (e) {
        emit({ phase: 'idle', notice: (e as Error)?.name === 'NotAllowedError' ? null : `Could not start capture: ${(e as Error)?.message ?? e}` });
        return;
    }
    if (gen !== armGeneration) { stream.getTracks().forEach(t => t.stop()); return; }
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) { stream.getTracks().forEach(t => t.stop()); emit({ phase: 'idle', notice: 'No video track was granted.' }); return; }
    const sysTrack = stream.getAudioTracks()[0] ?? null;
    const vs = videoTrack.getSettings();
    const width = vs.width ?? preset.maxWidth, height = vs.height ?? preset.maxHeight;

    // Ring size: whichever of seconds / user memory cap / machine budget binds first.
    const budget = memoryBudgetBytes((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
    const maxRingBytes = Math.min((settings.clipMemoryCapMB ?? 1024) * MIB, maxRingBytesForBudget(budget));
    const ringMs = Math.max(10_000, (settings.clipBufferSeconds ?? 300) * 1000);

    const worker = new Worker(new URL('./replayWorker.ts', import.meta.url), { type: 'module' });
    const s: Session = { worker, stream, ctx: null, dest: null, sysGain: null, micGain: null, micSrc: null, unMic: null, resumeTimer: null, pending: new Map(), onWiped: null, previewEl: null, previewSeq: 0, nativeStop: null, sysAudioStop: null, sysSrc: null };
    session = s;
    try {
        const { audioReadable, micTrack } = buildMixedAudio(s, sysTrack);
        const vproc = new MediaStreamTrackProcessor({ track: videoTrack as MediaStreamVideoTrack });
        const cfg: ArmConfig = {
            preset, width, height, ringMs, maxRingBytes, audioOffsetUs: AUDIO_OFFSET_US,
            audioCodec: 'mp4a.40.2', verbose: false,
        };
        worker.onmessage = (ev: MessageEvent<FromWorker>) => handleWorker(s, ev.data);
        worker.onerror = (e) => { emit({ phase: 'error', error: `worker: ${e.message}` }); void disarm('worker-error'); };
        const transfer: Transferable[] = [vproc.readable as unknown as Transferable];
        if (audioReadable) transfer.push(audioReadable as unknown as Transferable);
        const msg: ToWorker = { t: 'arm', cfg, video: vproc.readable, audio: audioReadable };
        worker.postMessage(msg, transfer);
        hideCaptureBar('clip-ring');
        videoTrack.addEventListener('ended', () => {
            // The user hit Chromium's "Stop sharing" — a dead recorder must not claim to be armed.
            if (session === s) { void disarm('capture-ended'); emit({ notice: 'Screen capture ended — the clip buffer is off.' }); }
        });
        emit({ hasSystemAudio: !!sysTrack, hasMic: !!micTrack, width, height, notice: sysTrack ? null : 'No system audio — pick "Entire screen" and turn on "Also share system audio", or keep mic only.' });
    } catch (e) {
        await disarm('arm-failed');
        emit({ phase: 'idle', notice: `Could not arm: ${e instanceof Error ? e.message : String(e)}` });
    }
}

function handleWorker(s: Session, m: FromWorker): void {
    if (session !== s) return;
    switch (m.t) {
        case 'armed':
            emit({ phase: 'armed', videoCodec: m.videoCodec, audioCodec: m.audioCodec, width: m.width, height: m.height });
            notifyArmed(true);
            break;
        case 'status': {
            const st: WorkerStatus = m.s;
            emit({ bufferedMs: st.bufferedMs, ringBytes: st.ringBytes, droppedFrames: st.droppedFrames, fps: st.fps, kbps: st.kbps, width: st.width, height: st.height });
            break;
        }
        case 'sealed':
            // `trim` reuses this message (it IS a re-seal) — resolve whichever
            // of the two pending callers is waiting; `sealedAt` is preserved
            // across a trim (docs/CLIPS.md: it does not change what was
            // described to approvers, only what ends up in the final upload).
            emit({ phase: 'sealed', sealed: m.info, sealedAt: state.sealedAt ?? Date.now() });
            s.pending.get('seal')?.resolve(m.info); s.pending.delete('seal');
            s.pending.get('trim')?.resolve(m.info); s.pending.delete('trim');
            break;
        case 'sealFailed':
            emit({ phase: 'armed', sealed: null, notice: `Could not prepare the clip: ${m.message}` });
            s.pending.get('seal')?.reject(new Error(m.message)); s.pending.delete('seal');
            break;
        case 'previewHandle':
            if (m.seq === s.previewSeq && s.previewEl) s.previewEl.srcObject = m.handle as unknown as MediaProvider;
            break;
        case 'previewReady':
            if (m.seq !== s.previewSeq) break; // a superseded preview finishing late
            s.pending.get('preview')?.resolve(m.durationMs); s.pending.delete('preview');
            break;
        case 'previewFailed':
            if (m.seq !== s.previewSeq) break; // the worker fails a superseded preview on purpose
            s.pending.get('preview')?.reject(new Error(m.message)); s.pending.delete('preview');
            break;
        case 'trimFailed':
            // Unlike sealFailed: the EXISTING sealed clip is untouched and
            // still postable as-is — must not wipe `sealed` or drop the phase.
            s.pending.get('trim')?.reject(new Error(m.message)); s.pending.delete('trim');
            break;
        case 'uploadProgress':
            emit({ phase: 'uploading', upload: { done: m.done, total: m.total, bytesDone: m.bytesDone } });
            break;
        case 'uploaded':
            emit({ phase: 'sealed', upload: null });
            s.pending.get('upload')?.resolve({ href: m.href, partIds: m.partIds }); s.pending.delete('upload');
            break;
        case 'uploadFailed':
            emit({ phase: 'sealed' });
            s.pending.get('upload')?.reject(Object.assign(new Error(m.message), { status: m.status, failedIdx: m.failedIdx })); s.pending.delete('upload');
            break;
        case 'reconfigured':
            emit({ width: m.width, height: m.height, notice: m.lostMs > 0 ? `Capture size changed — the ${Math.round(m.lostMs / 1000)} s recorded before it cannot be clipped.` : null });
            break;
        case 'error':
            if (m.fatal) { emit({ phase: 'error', error: `${m.stage}: ${m.message}` }); void disarm('fatal'); }
            else {
                emit({ notice: `${m.stage}: ${m.message}` });
                // The worker names the message that threw; nothing else will
                // settle that caller (the composer's Discard is disabled while
                // it waits). Other in-flight work is left alone.
                s.pending.get(m.stage)?.reject(new Error(m.message)); s.pending.delete(m.stage);
            }
            break;
        case 'wiped':
            s.onWiped?.();
            break;
    }
}

function post(s: Session, m: ToWorker): void { s.worker.postMessage(m); }

/** Seal the last `requestedMs` (never more than `maxMs`, the server's cap — the
 *  keyframe snap-back would otherwise push a max-length request over it).
 *  Resolves with the real sealed info. */
export function seal(requestedMs: number, maxMs?: number): Promise<SealedInfo> {
    const s = session;
    if (!s || state.phase !== 'armed') return Promise.reject(new Error('not armed'));
    emit({ phase: 'sealing', sealed: null, upload: null });
    return new Promise<SealedInfo>((resolve, reject) => {
        s.pending.set('seal', { resolve: resolve as (v: unknown) => void, reject });
        post(s, { t: 'seal', clipId: crypto.randomUUID(), requestedMs, maxMs });
    });
}

/**
 * Attach the worker-side MSE preview to a <video>. ONLY call this once the
 * clip's proposal is `outgoing.status === 'approved'` — the worker itself
 * enforces nothing about approval (see replayWorker.ts's header); this call
 * site is the actual gate, and clipNoPreview.test.ts pins that it is reached
 * only from the composer's approved-phase branch. Returns a detach fn.
 */
export function attachPreview(el: HTMLVideoElement): { ready: Promise<number>; detach: () => void } {
    const s = session;
    if (!s || !state.sealed) return { ready: Promise.reject(new Error('nothing sealed')), detach: () => {} };
    s.previewEl = el;
    const seq = ++s.previewSeq;
    // A previous attach still waiting is superseded: settle it so nobody hangs.
    s.pending.get('preview')?.reject(new Error('preview superseded'));
    const ready = new Promise<number>((resolve, reject) => {
        s.pending.set('preview', { resolve: resolve as (v: unknown) => void, reject });
        post(s, { t: 'preview', seq });
    });
    return {
        ready,
        detach: () => {
            if (s.previewEl === el) s.previewEl = null;
            try { el.pause(); el.removeAttribute('src'); el.srcObject = null; el.load(); } catch { /* ignore */ }
        },
    };
}

/**
 * Narrow the sealed clip to [startMs, endMs] of its OWN timeline — can only
 * shrink what was already approved, never reveal footage outside it, so this
 * needs no new consent (docs/CLIPS.md). Resolves with the new (shorter) info;
 * on failure the EXISTING sealed clip is untouched and still postable as-is.
 */
export function trimSeal(startMs: number, endMs: number, server?: { token: string; baseUrl: string }): Promise<SealedInfo> {
    const s = session;
    if (!s || !state.sealed) return Promise.reject(new Error('nothing sealed'));
    return new Promise<SealedInfo>((resolve, reject) => {
        s.pending.set('trim', { resolve: resolve as (v: unknown) => void, reject });
        post(s, { t: 'trim', startMs, endMs, token: server?.token, baseUrl: server?.baseUrl });
    });
}

/** Upload the sealed parts under an APPROVED proposal id (the server's clip_id).
 *  Resolves with the manifest href + part ids; rejects with the worker's
 *  ClipUploadError-shaped message when parts failed (retry with onlyMissing). */
export function uploadAndBuild(token: string, baseUrl: string, proposalId: string, onlyMissing = false): Promise<{ href: string; partIds: string[] }> {
    const s = session;
    if (!s || !state.sealed) return Promise.reject(new Error('nothing sealed'));
    emit({ phase: 'uploading', upload: { done: 0, total: state.sealed.partCount, bytesDone: 0 } });
    return new Promise((resolve, reject) => {
        s.pending.set('upload', { resolve: resolve as (v: unknown) => void, reject });
        post(s, { t: 'upload', token, baseUrl, proposalId, onlyMissing });
    });
}

/** Drop the sealed clip (declined / expired / cancelled / discarded). The ring keeps running. */
export function discardSeal(server?: { token: string; baseUrl: string }): void {
    const s = session;
    if (!s) return;
    post(s, { t: 'discardSeal', token: server?.token, baseUrl: server?.baseUrl });
    if (s.previewEl) { try { s.previewEl.srcObject = null; } catch { /* ignore */ } s.previewEl = null; }
    emit({ phase: state.phase === 'error' ? 'error' : 'armed', sealed: null, sealedAt: null, upload: null });
}

/** Stop capture, wipe the ring, release everything. Safe to call repeatedly. */
export async function disarm(reason = 'user'): Promise<void> {
    const s = session;
    if (!s) return;
    session = null;
    armGeneration++;
    const wasArmed = state.phase !== 'idle' && state.phase !== 'arming';
    if (s.nativeStop) await s.nativeStop().catch(() => { /* best effort */ });
    if (s.resumeTimer) clearInterval(s.resumeTimer);
    s.unMic?.();
    s.stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
    if (s.previewEl) { try { s.previewEl.srcObject = null; } catch { /* ignore */ } }
    for (const p of s.pending.values()) p.reject(new Error(`disarmed (${reason})`));
    s.pending.clear();
    // Ask the worker to zero-fill and exit; terminate regardless after a grace period.
    await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; try { s.worker.terminate(); } catch { /* ignore */ } resolve(); };
        s.onWiped = finish;
        try { post(s, { t: 'wipe' }); } catch { finish(); }
        setTimeout(finish, 1500);
    });
    if (s.ctx) { try { await s.ctx.close(); } catch { /* ignore */ } }
    releaseCaptureBar('clip-ring');
    emit({ ...initial(), notice: state.notice, error: state.phase === 'error' ? state.error : null, phase: state.phase === 'error' && reason === 'fatal' ? 'error' : 'idle' });
    if (wasArmed) notifyArmed(false);
}

/** Buffered footage is thrown away on app exit; nothing survives the process. */
if (typeof window !== 'undefined') {
    const bail = () => {
        if (session) {
            try { session.worker.terminate(); } catch { /* ignore */ }
            session.stream.getTracks().forEach(t => t.stop());
            // Best effort, not awaited: a page/webview teardown cannot wait on
            // an async Tauri round-trip. Without this a native session's DXGI
            // capture + WASAPI loopback threads keep running in the Rust
            // process after the page that armed them is gone — invisibly,
            // since there was never a picker or a capture bar to begin with.
            session.nativeStop?.().catch(() => { /* best effort */ });
            session = null;
        }
    };
    window.addEventListener('pagehide', bail);
    window.addEventListener('beforeunload', bail);
}

/** Desktop suspend / session lock: the buffer must not survive hibernation (see docs/CLIPS.md). */
export async function wireSystemSuspendHook(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen('system-suspend-or-lock', () => { if (session) { void disarm('system-suspend'); emit({ notice: 'The clip buffer was cleared because the system suspended or locked.' }); } });
    } catch { /* older shell without the event — nothing to wire */ }
}

/** Test hook. */
export function __resetReplayForTests(): void {
    session = null; state = initial(); listeners.clear(); armedListeners.clear();
}
