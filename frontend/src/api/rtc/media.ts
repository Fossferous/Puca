import { processAudioStream, getMicConstraints, getNoiseSuppressionMode, setNoiseSuppressionMode, cleanupNoiseFilter, selectedInputDeviceId, type NoiseSuppressionMode } from '../noiseFilter';
import { inputGain } from '../../components/settingsStore';

/** Errors that mean "the requested mic device can't be opened" — the cases
 *  where retrying on the OS default is the right degradation. Matched by NAME,
 *  not `instanceof DOMException`: OverconstrainedError only inherits from it in
 *  newer engines, and Firefox reports an exclusively-held device as AbortError.
 *  Getting this list wrong would turn a working 0.6.7 join into a hard failure. */
function isDeviceError(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'OverconstrainedError' || name === 'NotFoundError'
        || name === 'NotReadableError' || name === 'AbortError';
}

/** Errors meaning "there is no usable microphone right now" — no device at all,
 *  or one that can't be opened (held exclusively by another app, driver hiccup).
 *  Joining listen-only beats not joining.
 *
 *  DELIBERATELY EXCLUDES NotAllowedError / PermissionDeniedError / SecurityError:
 *  a permission refusal is something the user can FIX, and it must keep throwing
 *  so VoicePanel still shows the microphone-permission help. Keep the two lists
 *  disjoint — folding permission errors in here would silently join every
 *  blocked user muted and kill that modal. */
function isNoMicError(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'NotFoundError' || name === 'DevicesNotFoundError'
        || name === 'NotReadableError' || name === 'TrackStartError'
        || name === 'AbortError'
        || name === 'OverconstrainedError';
}

/**
 * RMS amplitude (0..1) of time-domain PCM samples — the loudness measure the
 * voice-activity detector thresholds against.
 *
 * Exported so the separation between noise and speech is testable without a
 * browser: the old frequency-bin average scored room noise ABOVE speech, which
 * is the defect this replaced (see createVoiceActivityDetector).
 */
export function rmsAmplitude(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}

export class MediaManager {
    private localStream: MediaStream | null = null;
    private screenShareStream: MediaStream | null = null;
    /** True when the local stream came up WITHOUT a mic track because no capture
     *  device could be opened. We still receive everyone (listen-only). */
    private noMic = false;
    // A single shared AudioContext for all voice-activity detectors — browsers
    // cap the number of AudioContexts (~6), so one per remote user would break
    // in a busy channel.
    private vadContext: AudioContext | null = null;
    // Rebuild hooks for live VAD analysers: MediaStream addtrack/removetrack
    // events never fire for SCRIPTED track swaps (spec: UA-initiated only), so
    // reacquireAudioTrack invokes these directly after swapping the mic track.
    private vadRebuilds = new Set<() => void>();

    /**
     * Get the current local stream
     */
    getLocalStreamSync(): MediaStream | null {
        return this.localStream;
    }

    /** True when we joined without a microphone (listen-only). */
    isListenOnly(): boolean {
        return this.noMic;
    }

    /**
     * Get the current screen share stream
     */
    getScreenShareStreamSync(): MediaStream | null {
        return this.screenShareStream;
    }

    /**
     * The ML noise graph failed to build — put the user back on native NS.
     *
     * This used to be a bare catch whose only content was a comment saying
     * "fall back to native-only". That comment was wrong in a way that
     * mattered: there is no native to fall back TO.
     * getMicConstraints sets `noiseSuppression: mode === 'standard' &&
     * …`, so the stream we are holding was captured with native NS explicitly
     * DISABLED, on the assumption the worklet would do the suppressing. Keeping
     * it leaves the user with no noise suppression whatsoever — strictly worse
     * than never having selected RNNoise — and at the re-acquire call site it
     * was not even logged, so "RNNoise isn't working" produced no evidence at
     * all.
     *
     * Re-captures the audio track with Standard constraints and swaps it in
     * place, preserving any video track. The mode is downgraded for THIS
     * SESSION only: a build failure here must not silently rewrite the saved
     * preference, so the next launch retries RNNoise and falls back again if it
     * really is broken on this machine.
     */
    private async downgradeToNativeNS(stream: MediaStream, cause: unknown): Promise<void> {
        console.warn('[WebRTC] Noise-suppression graph failed to build — falling back to Standard:', cause);
        setNoiseSuppressionMode('standard', false);
        try {
            const fresh = await navigator.mediaDevices.getUserMedia({
                audio: getMicConstraints('standard'),
                video: false,
            });
            const replacement = fresh.getAudioTracks()[0];
            if (!replacement) { fresh.getTracks().forEach(t => t.stop()); return; }
            stream.getAudioTracks().forEach(t => { stream.removeTrack(t); t.stop(); });
            stream.addTrack(replacement);
        } catch (err) {
            // Re-capture failed too (device gone/busy). The original track is
            // still live and unsuppressed — audible noise beats silence.
            console.warn('[WebRTC] Could not re-acquire the mic for Standard NS:', err);
        }
        window.dispatchEvent(new CustomEvent('sovereign:noise-fallback', {
            detail: { message: String(cause).slice(0, 200) },
        }));
    }

    /**
     * Get local media stream (microphone/camera)
     */
    async getLocalStream(audio = true, video = false): Promise<MediaStream> {
        if (this.localStream) {
            return this.localStream;
        }

        try {
            const mode = getNoiseSuppressionMode();
            const constraintsFor = (ignoreSelectedDevice: boolean): MediaStreamConstraints => ({
                // Native WebRTC noise suppression / echo cancellation / AGC is the
                // primary (best-quality, lowest-latency) suppressor — enabled here
                // for every mode except 'off'.
                audio: audio ? getMicConstraints(mode, { ignoreSelectedDevice }) : false,
                video: video ? {
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 },
                    frameRate: { ideal: 30, max: 30 },
                    // Use front camera on mobile devices by default
                    facingMode: 'user',
                } : false,
            });
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia(constraintsFor(false));
            } catch (err) {
                // The selected input device is gone/busy — degrade LOUDLY to the
                // OS default rather than failing the whole call. (Video uses only
                // 'ideal' constraints, so a device error here is the mic's.)
                if (!audio || !selectedInputDeviceId() || !isDeviceError(err)) throw err;
                console.warn('[WebRTC] Selected microphone unavailable — falling back to the system default:', err);
                this.localStream = await navigator.mediaDevices.getUserMedia(constraintsFor(true));
            }

            this.noMic = false;

            // Web Audio pass: the ML suppressor and/or the Settings mic-gain
            // stage. processAudioStream itself decides whether a graph is
            // needed (none at gain 1.0 in the native modes).
            if (audio) {
                try {
                    this.localStream = await processAudioStream(this.localStream);
                } catch (noiseErr) {
                    await this.downgradeToNativeNS(this.localStream, noiseErr);
                }
            }

            return this.localStream;
        } catch (error) {
            // LISTEN-ONLY DEGRADE: there's no usable capture device (none
            // present, or it can't be opened). Joining with no audio track is
            // strictly better than refusing to join — we still hear everyone.
            // Permission REFUSALS are excluded and rethrow, so the microphone
            // help modal still appears for users who can actually fix it.
            if (audio && isNoMicError(error)) {
                console.warn('[WebRTC] No usable microphone — joining listen-only:', error);
                this.noMic = true;
                if (video) {
                    // Don't lose the camera just because the mic failed.
                    try {
                        this.localStream = await navigator.mediaDevices.getUserMedia({
                            audio: false,
                            video: {
                                width: { ideal: 1280, max: 1920 },
                                height: { ideal: 720, max: 1080 },
                                frameRate: { ideal: 30, max: 30 },
                                facingMode: 'user',
                            },
                        });
                        return this.localStream;
                    } catch (vErr) {
                        console.warn('[WebRTC] Video-only fallback failed too:', vErr);
                    }
                }
                this.localStream = new MediaStream(); // empty, but a valid handle
                return this.localStream;
            }
            console.error('Failed to get local media:', error);
            throw error;
        }
    }

    /**
     * Stop local media stream
     */
    stopLocalStream() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        // Clear listen-only so a rejoin retries the mic (they may have plugged
        // a headset in since).
        this.noMic = false;
        // Also tear down the 'high'-mode Web Audio graph + its raw mic track.
        cleanupNoiseFilter();
    }

    /** Open the mic with the selected device, degrading loudly to the OS
     *  default when that device can't be opened. */
    private async getMicStream(mode: NoiseSuppressionMode): Promise<MediaStream> {
        try {
            return await navigator.mediaDevices.getUserMedia({ audio: getMicConstraints(mode) });
        } catch (err) {
            if (!selectedInputDeviceId() || !isDeviceError(err)) throw err;
            console.warn('[WebRTC] Selected microphone unavailable — falling back to the system default:', err);
            return await navigator.mediaDevices.getUserMedia({ audio: getMicConstraints(mode, { ignoreSelectedDevice: true }) });
        }
    }

    /**
     * Re-acquire just the microphone audio track using the current noise mode's
     * constraints and swap it into the existing local stream. Returns BOTH the
     * old and new tracks so callers can find the mic's RTCRtpSender by track
     * IDENTITY (never by kind — a screen share adds a second audio sender whose
     * game audio must not be clobbered) and `replaceTrack` it (seamless, no
     * renegotiation). Lets a noise-mode change apply live mid-call.
     */
    async reacquireAudioTrack(): Promise<{ oldTrack: MediaStreamTrack | null; newTrack: MediaStreamTrack } | null> {
        if (!this.localStream) return null;
        const oldAudio = this.localStream.getAudioTracks()[0] ?? null;
        const wasEnabled = oldAudio?.enabled ?? true;

        const mode = getNoiseSuppressionMode();
        const streamAtStart = this.localStream;
        let mic: MediaStream;
        try {
            mic = await this.getMicStream(mode);
        } catch (err) {
            // A noise-mode change must not blow up a listen-only client (or one
            // whose mic vanished mid-call) — stay listen-only instead.
            if (!isNoMicError(err)) throw err;
            console.warn('[WebRTC] Mic re-acquire failed — staying listen-only:', err);
            this.noMic = true;
            return null;
        }
        // processAudioStream both builds whatever graph the current mode +
        // Settings gain need AND tears down the previous one when switching to
        // a pass-through (its no-graph branch calls cleanupNoiseFilter).
        try {
            mic = await processAudioStream(mic);
        } catch (noiseErr) {
            await this.downgradeToNativeNS(mic, noiseErr);
        }
        // The user left voice (or left + rejoined) while the graph was building:
        // installing into a dead/replaced stream would leave a hot mic behind.
        if (this.localStream !== streamAtStart) {
            mic.getTracks().forEach(t => t.stop());
            if (this.localStream === null) cleanupNoiseFilter();
            return null;
        }
        const newAudio = mic.getAudioTracks()[0];
        if (!newAudio) return null;
        newAudio.enabled = wasEnabled;
        this.noMic = false; // we have a real mic again

        if (oldAudio) { oldAudio.stop(); this.localStream.removeTrack(oldAudio); }
        this.localStream.addTrack(newAudio);
        // addtrack/removetrack don't fire for scripted swaps — rebuild the
        // speaking-indicator sources explicitly or they read the dead track.
        this.vadRebuilds.forEach(fn => { try { fn(); } catch { /* detector gone */ } });
        return { oldTrack: oldAudio, newTrack: newAudio };
    }

    /**
     * Register a callback fired AFTER the published mic track is swapped
     * (noise-mode change → reacquireAudioTrack). Same registry the VAD and
     * silence-sentinel rebuilds use; exposed because ANY consumer holding a
     * MediaStreamAudioSourceNode over the local stream goes silent on a swap
     * (the clip replay buffer's mic tap is one). Returns an unregister.
     */
    onMicTrackSwapped(fn: () => void): () => void {
        this.vadRebuilds.add(fn);
        return () => { this.vadRebuilds.delete(fn); };
    }

    /** Close the shared voice-activity-detector AudioContext (on leaving voice). */
    closeVadContext() {
        if (this.vadContext && this.vadContext.state !== 'closed') {
            this.vadContext.close();
        }
        this.vadContext = null;
    }

    /**
     * Toggle video on/off for local stream
     * Returns the new video track if enabled, or null if disabled/failed
     */
    async toggleVideo(enable: boolean): Promise<MediaStreamTrack | null> {
        if (!this.localStream) return null;

        const videoTracks = this.localStream.getVideoTracks();

        if (enable && videoTracks.length === 0) {
            // Need to add video track
            try {
                const videoStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } }
                });
                const videoTrack = videoStream.getVideoTracks()[0];
                // The stream can vanish DURING the getUserMedia await (leave /
                // channel switch runs stopLocalStream). Stop the just-acquired
                // track instead of orphaning it — an orphan keeps the camera
                // LED lit with no reference anywhere until app restart.
                if (!this.localStream) {
                    videoTrack.stop();
                    return null;
                }
                this.localStream.addTrack(videoTrack);
                return videoTrack;
            } catch (err) {
                console.error('Failed to enable video:', err);
                return null;
            }
        } else if (!enable && videoTracks.length > 0) {
            // Remove video track
            videoTracks.forEach(track => {
                track.stop();
                this.localStream?.removeTrack(track);
            });
            return null;
        }

        return null;
    }

    /**
     * Switch between front and back camera (mobile)
     * Returns the new video track if successful
     */
    async switchCamera(currentFacingMode: 'user' | 'environment'): Promise<MediaStreamTrack | null> {
        if (!this.localStream) return null;

        const videoTracks = this.localStream.getVideoTracks();
        if (videoTracks.length === 0) return null;

        // Stop current video track
        videoTracks.forEach(track => {
            track.stop();
            this.localStream?.removeTrack(track);
        });

        // Get new video with opposite facing mode
        const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

        try {
            const newVideoStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 },
                    frameRate: { ideal: 30, max: 30 },
                    facingMode: newFacingMode,
                }
            });

            const newVideoTrack = newVideoStream.getVideoTracks()[0];
            this.localStream.addTrack(newVideoTrack);

            console.log('[WebRTC] Camera switched to:', newFacingMode);
            return newVideoTrack;
        } catch (error) {
            console.error('[WebRTC] Failed to switch camera:', error);
            return null;
        }
    }

    /**
     * Get screen share stream with detailed configuration
     */
    async getScreenShareStream(config?: { width?: number, height?: number, fps?: number, audio?: boolean }): Promise<MediaStream> {
        // Force cleanup any existing screen share first
        if (this.screenShareStream) {
            console.log('[WebRTC] Cleaning up existing screen share before starting new one');
            this.stopScreenShare();
        }

        const width = config?.width ?? 1920;
        const height = config?.height ?? 1080;
        const fps = config?.fps ?? 30;
        const captureAudio = config?.audio ?? true;

        try {
            const displayMediaOptions: DisplayMediaStreamOptions = {
                video: {
                    width: { ideal: width },
                    height: { ideal: height },
                    frameRate: { ideal: fps, max: fps },
                } as MediaTrackConstraints,
            };

            if (captureAudio) {
                displayMediaOptions.audio = {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    // false = the streamer keeps hearing their own game normally;
                    // true would silence the captured audio locally (game goes mute
                    // for the streamer). Local preview elements must stay muted to
                    // avoid doubling. Not in DOM lib typings yet, hence the cast.
                    suppressLocalAudioPlayback: false,
                } as MediaTrackConstraints;
                // Chromium: offer the "Also share system audio" checkbox in the picker.
                (displayMediaOptions as DisplayMediaStreamOptions & { systemAudio?: 'include' | 'exclude' }).systemAudio = 'include';
            }

            this.screenShareStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

            if (captureAudio && this.screenShareStream.getAudioTracks().length === 0) {
                // The user picked a surface without audio (e.g. a window) or
                // unticked "share system audio" — video-only share proceeds.
                console.warn('[WebRTC] System audio requested but the chosen surface granted none — sharing video only');
            }

            // Hint the encoder to prioritise motion/framerate over sharpness —
            // the right trade-off for gameplay, where smoothness matters most.
            const videoTrack = this.screenShareStream.getVideoTracks()[0];
            if (videoTrack) {
                try { videoTrack.contentHint = 'motion'; } catch { /* not supported */ }
            }

            return this.screenShareStream;
        } catch (error) {
            console.error('Failed to get screen share:', error);
            throw error;
        }
    }

    /**
     * Stop screen share stream
     * Returns true if a stream was stopped
     */
    stopScreenShare(): boolean {
        if (this.screenShareStream) {
            this.screenShareStream.getTracks().forEach(track => track.stop());
            this.screenShareStream = null;
            return true;
        }
        return false;
    }

    /**
     * Check if currently screen sharing
     */
    isScreenSharing(): boolean {
        return this.screenShareStream !== null;
    }

    /**
     * Check if video is enabled
     */
    isVideoEnabled(): boolean {
        if (!this.localStream) return false;
        return this.localStream.getVideoTracks().length > 0;
    }

    /**
     * Create voice activity analyzer.
     *
     * `threshold` is compared against the signal's RMS AMPLITUDE (0..1), which
     * is what "how loud is this" actually means.
     *
     * It used to average `getByteFrequencyData` across every bin and divide by
     * 128. That is a dB-MAPPED scale on which silence is not near zero, and —
     * worse — broadband noise spreads energy over all 128 bins while speech
     * concentrates it in a few harmonics. Measured (e2e probe, 48 kHz):
     *
     *     signal                     old metric     RMS
     *     digital silence               0.0000    0.00000
     *     quiet room, -60 dBFS          0.0698    0.00058
     *     audible hiss, -40 dBFS        0.5966    0.00577
     *     speech, -20 dBFS              0.0492    0.07071
     *     loud speech, -12 dBFS         0.0568    0.17678
     *
     * So room noise scored HIGHER than speech, and hiss ten times higher. The
     * indicator was effectively a noise meter that under-reported voice, which
     * is why it lit up for audio that noise suppression had already removed.
     *
     * RMS separates them by better than 10x, and the existing thresholds
     * (0.01 / 0.02) happen to land cleanly between hiss and speech, so callers
     * did not need retuning.
     */
    createVoiceActivityDetector(
        stream: MediaStream,
        onSpeaking: (isSpeaking: boolean) => void,
        threshold = 0.01
    ): () => void {
        try {
            // Reuse one shared AudioContext across all detectors.
            if (!this.vadContext || this.vadContext.state === 'closed') {
                this.vadContext = new AudioContext();
            }
            const ctx = this.vadContext;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            // smoothingTimeConstant only affects the FREQUENCY data, which this
            // no longer reads — time-domain samples are never smoothed. Release
            // hysteresis below is what stops the indicator flickering now.
            let source: MediaStreamAudioSourceNode | null = ctx.createMediaStreamSource(stream);
            source.connect(analyser);

            // A MediaStreamAudioSourceNode is bound to the track it saw at
            // creation. Swapping the mic track inside the same stream (noise-
            // suppression mode change does exactly that) leaves the old source
            // reading a dead track — silence — and the indicator dies. Rebuild
            // the source whenever the stream's tracks change.
            const rebuildSource = () => {
                try { source?.disconnect(); } catch { /* already gone */ }
                source = null;
                if (stream.getAudioTracks().length === 0) return;
                try {
                    source = ctx.createMediaStreamSource(stream);
                    source.connect(analyser);
                } catch (e) {
                    console.warn('[VAD] Failed to rebuild source after track change:', e);
                }
            };
            stream.addEventListener('addtrack', rebuildSource);
            stream.addEventListener('removetrack', rebuildSource);
            // Those events only fire for UA-initiated changes; scripted swaps
            // (noise-mode change) invoke the rebuild via this registry instead.
            this.vadRebuilds.add(rebuildSource);

            // Time-domain samples, not frequency bins (see the doc comment).
            // Float rather than byte: getByteTimeDomainData quantises to 8 bits,
            // so its smallest representable amplitude is 1/128 ≈ 0.0078 — barely
            // 2.5 steps below the 0.02 speech threshold, which would make the
            // decision jitter on quantisation noise alone.
            const dataArray = new Float32Array(analyser.fftSize);

            // Hysteresis so the indicator doesn't flicker on every syllable gap:
            // turn ON instantly above `threshold`, turn OFF after ~200 ms without
            // going back above it. (No "hold zone": an earlier version held the
            // ON state forever while the level idled between two thresholds,
            // which is why indicators sometimes stuck lit.) Poll at 50 ms for a
            // snappy reaction both ways; combined with the low analyser smoothing
            // above, the indicator now snaps off almost as soon as speech stops.
            const TICK_MS = 50;
            const RELEASE_TICKS = 4; // 4 x 50 ms = 200 ms release
            let wasSpeaking = false;
            let quietTicks = 0;
            const checkInterval = setInterval(() => {
                // Frozen-context watchdog: a suspended AudioContext stops
                // rendering, so the analyser returns the SAME data forever —
                // indicators freeze in whatever state they were in (stuck lit
                // locally / never lighting for remotes). Kick it back to
                // running instead of reading stale bins.
                if (ctx.state === 'suspended') {
                    void ctx.resume().catch(() => { /* needs a user gesture; retry next tick */ });
                    return;
                }

                analyser.getFloatTimeDomainData(dataArray);
                const normalized = rmsAmplitude(dataArray);

                if (normalized > threshold) {
                    quietTicks = 0;
                    if (!wasSpeaking) {
                        wasSpeaking = true;
                        onSpeaking(true);
                    }
                } else {
                    quietTicks++;
                    if (wasSpeaking && quietTicks >= RELEASE_TICKS) {
                        wasSpeaking = false;
                        onSpeaking(false);
                    }
                }
            }, TICK_MS);

            return () => {
                clearInterval(checkInterval);
                stream.removeEventListener('addtrack', rebuildSource);
                stream.removeEventListener('removetrack', rebuildSource);
                this.vadRebuilds.delete(rebuildSource);
                try { source?.disconnect(); } catch { /* already gone */ }
                analyser.disconnect();
                // Note: the shared context is intentionally left open for reuse.
            };
        } catch (err) {
            console.error('Failed to create voice activity detector:', err);
            return () => { };
        }
    }

    /**
     * Watch the LOCAL published stream for the "talking into the void"
     * signature: an unmuted mic that has produced NOTHING but exact digital
     * zeros since it went live. Pure zeros mean the OS, the device, or a
     * processing graph is feeding the encoder silence — everyone in the call
     * hears nothing while every local indicator looks healthy.
     *
     * Only DEAD-FROM-BIRTH tracks are flagged. Gated inputs (NVIDIA Broadcast,
     * Krisp, VoiceMeeter/OBS gates, hardware-gated headsets) emit exact zeros
     * whenever the user is simply quiet, so "zeros right now" is not evidence
     * of a fault — but a track that has never once carried a sample, across
     * ~24 s of being live and unmuted, is. Once a track proves itself the
     * sentinel stays quiet for its lifetime; a mic swap re-arms it.
     */
    createSilenceSentinel(stream: MediaStream, onSilent: (silent: boolean) => void): () => void {
        try {
            if (!this.vadContext || this.vadContext.state === 'closed') {
                this.vadContext = new AudioContext();
            }
            const ctx = this.vadContext;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            let source: MediaStreamAudioSourceNode | null = ctx.createMediaStreamSource(stream);
            source.connect(analyser);

            const TICK_MS = 2000;
            const SILENT_TICKS = 12; // 12 × 2 s = 24 s of unbroken digital zero
            let zeroTicks = 0;
            let flagged = false;
            /** Has THIS track ever carried a nonzero sample? Only tracks that
             *  never have are faulty; gated mics idle at exact zero. */
            let everHadSignal = false;

            // Same track-swap handling as the VAD above: scripted mic swaps
            // (noise-mode change) leave the old source reading a dead track.
            // A swap also installs a DIFFERENT track, so re-arm the latch.
            const rebuildSource = () => {
                try { source?.disconnect(); } catch { /* already gone */ }
                source = null;
                // Fresh track ⇒ fresh verdict. Clearing `flagged` (without an
                // onSilent(false), which would wipe a notice another writer
                // owns) lets a swap that DIDN'T fix things — e.g. falling back
                // to Standard when the device itself is dead — report again.
                everHadSignal = false;
                zeroTicks = 0;
                flagged = false;
                if (stream.getAudioTracks().length === 0) return;
                try {
                    source = ctx.createMediaStreamSource(stream);
                    source.connect(analyser);
                } catch { /* stream tearing down */ }
            };
            stream.addEventListener('addtrack', rebuildSource);
            stream.addEventListener('removetrack', rebuildSource);
            this.vadRebuilds.add(rebuildSource);

            const buf = new Float32Array(analyser.fftSize);
            const timer = setInterval(() => {
                if (ctx.state !== 'running') return;
                const track = stream.getAudioTracks()[0];
                // Muted (track.enabled=false) is silence ON PURPOSE — not a
                // fault. Input Volume at 0 likewise: the gain stage sits BEFORE
                // this (published) stream, so a zeroed slider produces exact
                // digital zeros with a perfectly healthy mic behind them — the
                // graph-liveness watchdog was moved pre-gain for this precise
                // reason (noiseFilter.ts), and without the same carve-out here
                // a user soft-muting via the slider got told RNNoise was broken
                // and had their suppressor downgraded for the session.
                if (!track || !track.enabled || track.readyState !== 'live' || inputGain() === 0) {
                    zeroTicks = 0;
                    return;
                }
                analyser.getFloatTimeDomainData(buf);
                let peak = 0;
                for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; }
                if (peak > 1e-7) {
                    // The track has carried real samples: it is wired up, and any
                    // later silence is the user being quiet (or a gate closing).
                    everHadSignal = true;
                    zeroTicks = 0;
                    if (flagged) { flagged = false; onSilent(false); }
                    return;
                }
                zeroTicks++;
                if (!flagged && !everHadSignal && zeroTicks >= SILENT_TICKS) {
                    flagged = true;
                    console.error('[WebRTC] Local mic has produced only digital silence since it went live — nobody can hear this user');
                    onSilent(true);
                }
            }, TICK_MS);

            return () => {
                clearInterval(timer);
                stream.removeEventListener('addtrack', rebuildSource);
                stream.removeEventListener('removetrack', rebuildSource);
                this.vadRebuilds.delete(rebuildSource);
                try { source?.disconnect(); } catch { /* already gone */ }
                analyser.disconnect();
            };
        } catch (err) {
            console.warn('Failed to create silence sentinel:', err);
            return () => { };
        }
    }
}
