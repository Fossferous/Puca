// Stand-in for rtc/media's MediaManager. The "microphone" is a pure tone at a
// frequency the runner picks (so the far end can tell the real signal from
// noise a decoder makes of ciphertext) and the "camera" a drawn canvas; none
// of the noise-suppression graph. Only what the manager calls does anything.
// Silent by construction: the tone goes to a MediaStream destination, never
// to the context's speakers.
export type MicReacquireOptions = Record<string, unknown>;

export class MediaManager {
    private local: MediaStream | null = null;

    /** The local stream the manager publishes: a tone, and a moving picture
     *  unless the camera starts off. */
    async startTone(frequency: number, camera = true): Promise<MediaStream> {
        const ctx = new AudioContext();
        await ctx.resume().catch(() => { /* an autoplay policy: the runner allows it */ });
        const osc = new OscillatorNode(ctx, { type: 'sine', frequency });
        const gain = new GainNode(ctx, { gain: 0.5 });
        const dest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
        osc.connect(gain).connect(dest);
        osc.start();
        this.local = new MediaStream(dest.stream.getAudioTracks());
        if (camera) this.addCamera();
        return this.local;
    }

    /** A drawn "camera", added to the local stream; the track is returned. */
    addCamera(): MediaStreamTrack {
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
        }, 33);
        const video = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30).getVideoTracks()[0];
        this.local!.addTrack(video);
        return video;
    }

    getLocalStreamSync(): MediaStream | null { return this.local; }
    getScreenShareStreamSync(): MediaStream | null { return null; }
    isScreenSharing(): boolean { return false; }
    isVideoEnabled(): boolean { return !!this.local?.getVideoTracks().length; }
    isListenOnly(): boolean { return !this.local?.getAudioTracks().length; }
    async toggleVideo(): Promise<MediaStreamTrack | null> { return this.local?.getVideoTracks()[0] ?? null; }
    async switchCamera(): Promise<MediaStreamTrack | null> { return null; }
    stopLocalStream(): void { this.local?.getTracks().forEach((t) => t.stop()); this.local = null; }
    stopScreenShare(): boolean { return false; }
    closeVadContext(): void {}
    releaseMic(): MediaStreamTrack[] { return []; }
    setSpeakDenied(): void {}
    isSpeakDenied(): boolean { return false; }
    setMicOffByChoice(): void {}
    isMicOffByChoice(): boolean { return false; }
    async getLocalStream(): Promise<MediaStream> { return this.local ?? new MediaStream(); }
    async reacquireAudioTrack(): Promise<null> { return null; }
    onMicTrackSwapped(): () => void { return () => {}; }
    rawMicState(): null { return null; }
    createSilenceSentinel(): () => void { return () => {}; }
    createVoiceActivityDetector(): () => void { return () => {}; }
    async getScreenShareStream(): Promise<MediaStream> { throw new Error('no screen share in the harness'); }
    applyShareQuality(): Promise<boolean> { return Promise.resolve(false); }
    setShareQuality(): Promise<null> { return Promise.resolve(null); }
    shareCaptureSize(): null { return null; }
}
