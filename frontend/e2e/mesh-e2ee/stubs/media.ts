// Stand-in for rtc/media's MediaManager. The "microphone" is a pure tone at a
// frequency the runner picks (so the far end can tell the real signal from
// noise a decoder makes of ciphertext) and the "camera" a drawn canvas; none
// of the noise-suppression graph. Only what the manager calls does anything.
// Silent by construction: the tone goes to a MediaStream destination, never
// to the context's speakers.
export type MicReacquireOptions = Record<string, unknown>;

/** A tone, as a track (no speakers involved). */
async function toneTrack(frequency: number): Promise<MediaStreamTrack> {
    const ctx = new AudioContext();
    await ctx.resume().catch(() => { /* an autoplay policy: the runner allows it */ });
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency });
    const gain = new GainNode(ctx, { gain: 0.5 });
    const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    osc.connect(gain).connect(dest);
    osc.start();
    return dest.stream.getAudioTracks()[0];
}

/** A moving picture at `fps` frames a second. */
function canvasTrack(fps: number): MediaStreamTrack {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 240;
    const g = canvas.getContext('2d')!;
    let n = 0;
    setInterval(() => {
        n++;
        g.fillStyle = `hsl(${(n * 7) % 360} 80% 50%)`;
        g.fillRect(0, 0, 320, 240);
        g.fillStyle = '#fff';
        g.fillRect((n * 5) % 300, 100, 20, 40);
    }, Math.max(33, Math.round(1000 / fps)));
    return (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps).getVideoTracks()[0];
}

export class MediaManager {
    private local: MediaStream | null = null;
    private screen: MediaStream | null = null;
    private nextMic: MediaStreamTrack | null = null;

    /** The local stream the manager publishes: a tone, and a moving picture
     *  unless the camera starts off. */
    async startTone(frequency: number, camera = true): Promise<MediaStream> {
        this.local = new MediaStream([await toneTrack(frequency)]);
        if (camera) this.addCamera();
        return this.local;
    }

    /** A drawn "camera", added to the local stream; the track is returned. */
    addCamera(): MediaStreamTrack {
        const video = canvasTrack(30);
        this.local!.addTrack(video);
        return video;
    }

    /** The next reacquireAudioTrack hands out a tone at this frequency (a
     *  microphone swapped, as a noise-mode change does). */
    async prepareMicSwap(frequency: number): Promise<void> {
        this.nextMic = await toneTrack(frequency);
    }

    /** A "screen share": a moving picture at `fps`, in its own stream. */
    startShare(fps: number): MediaStream {
        this.screen = new MediaStream([canvasTrack(fps)]);
        return this.screen;
    }

    getLocalStreamSync(): MediaStream | null { return this.local; }
    getScreenShareStreamSync(): MediaStream | null { return this.screen; }
    isScreenSharing(): boolean { return !!this.screen; }
    isVideoEnabled(): boolean { return !!this.local?.getVideoTracks().length; }
    isListenOnly(): boolean { return !this.local?.getAudioTracks().length; }
    /** As the real one does: off stops the camera and takes it out of the
     *  stream (its senders keep the ended track); on, with none, adds one. */
    async toggleVideo(enable: boolean): Promise<MediaStreamTrack | null> {
        if (!this.local) return null;
        const cams = this.local.getVideoTracks();
        if (enable && cams.length === 0) return this.addCamera();
        if (!enable) cams.forEach((t) => { t.stop(); this.local!.removeTrack(t); });
        return null;
    }
    async switchCamera(): Promise<MediaStreamTrack | null> { return null; }
    stopLocalStream(): void { this.local?.getTracks().forEach((t) => t.stop()); this.local = null; }
    stopScreenShare(): boolean {
        const was = !!this.screen;
        this.screen?.getTracks().forEach((t) => t.stop());
        this.screen = null;
        return was;
    }
    closeVadContext(): void {}
    releaseMic(): MediaStreamTrack[] { return []; }
    setSpeakDenied(): void {}
    isSpeakDenied(): boolean { return false; }
    setMicOffByChoice(): void {}
    isMicOffByChoice(): boolean { return false; }
    async getLocalStream(): Promise<MediaStream> { return this.local ?? new MediaStream(); }
    async reacquireAudioTrack(): Promise<{ oldTrack: MediaStreamTrack | null; newTrack: MediaStreamTrack } | null> {
        const newTrack = this.nextMic;
        this.nextMic = null;
        if (!newTrack || !this.local) return null;
        const oldTrack = this.local.getAudioTracks()[0] ?? null;
        if (oldTrack) { this.local.removeTrack(oldTrack); oldTrack.stop(); }
        this.local.addTrack(newTrack);
        return { oldTrack, newTrack };
    }
    onMicTrackSwapped(): () => void { return () => {}; }
    rawMicState(): null { return null; }
    createSilenceSentinel(): () => void { return () => {}; }
    createVoiceActivityDetector(): () => void { return () => {}; }
    async getScreenShareStream(): Promise<MediaStream> { throw new Error('no screen share in the harness'); }
    applyShareQuality(): Promise<boolean> { return Promise.resolve(false); }
    setShareQuality(): Promise<null> { return Promise.resolve(null); }
    shareCaptureSize(): null { return null; }
}
