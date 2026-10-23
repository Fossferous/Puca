/**
 * The page half of e2e/mesh-e2ee-interop-real-browser.mjs: one participant
 * of a mesh call, running the REAL rtc/manager.ts with its real encryption —
 * the Chromium path (createEncodedStreams) or the standard one
 * (RTCRtpScriptTransform and the worker Vite emits for it), whichever this
 * engine has — and the real api/e2ee identity, pairwise and session keys.
 * The runner relays signalling between two such pages and asks, through
 * `window.harness`, what each one actually receives.
 *
 * What a page HEARS is measured, not inferred: the "microphone" is a tone at
 * a frequency the runner picks (stubs/media.ts), and `tone()` looks for that
 * frequency in the remote voice. A decoder fed ciphertext produces noise or
 * nothing, never the tone, so hearing it means the frames were opened under
 * the right key.
 */
import { WebRTCManager } from '../../src/api/rtc/manager';
import { importMediaKey, isMediaE2eeSupported, mediaTransformApi } from '../../src/api/rtc/mediaCrypto';
import { deriveIdentity, setActiveIdentity } from '../../src/api/e2ee';
import type { MediaManager } from './stubs/media';

interface PeerView {
    connection: RTCPeerConnection;
    mediaCrypto: { key: CryptoKey | null; enabled: boolean; requireE2ee: boolean };
}
type StatsRow = Record<string, unknown>;

let mgr: WebRTCManager | null = null;
const voices = new Map<number, MediaStream>();
const savedKeys = new Map<number, CryptoKey | null>();
let listenCtx: AudioContext | null = null;

function peer(id: number): PeerView {
    const p = (mgr as unknown as { peers: Map<number, PeerView> } | null)?.peers.get(id);
    if (!p) throw new Error(`no peer ${id}`);
    return p;
}

/** Keep a remote stream PLAYING, muted (Chromium hands a remote track to Web
 *  Audio only while a media element plays it; muted, it plays nothing). */
function sink(stream: MediaStream, kind: 'audio' | 'video'): void {
    const el = document.createElement(kind);
    el.muted = true;
    el.autoplay = true;
    el.srcObject = stream;
    document.body.appendChild(el);
    void el.play().catch(() => { /* autoplay is allowed by the runner */ });
}

const unhex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));

/** The codec the ANSWER put first in each video section (one per camera
 *  m-line): what both ends send on it. */
function answeredVideoCodecs(pc: RTCPeerConnection): string[] {
    const answer = [pc.currentRemoteDescription, pc.currentLocalDescription].find((d) => d?.type === 'answer');
    return (answer?.sdp.split(/\r?\nm=/).filter((s) => s.startsWith('video')) ?? []).map((video) => {
        const pt = video.split('\n')[0].trim().split(' ')[3];
        const rtpmap = pt ? new RegExp(`a=rtpmap:${pt} ([^/\\s]+)`).exec(video) : null;
        return rtpmap ? rtpmap[1] : `?${pt}`;
    });
}

/** Each description's video sections, header line and codec names, for a failure report. */
function videoSections(sdp: string | undefined): string[] {
    return (sdp?.split(/\r?\nm=/).filter((s) => s.startsWith('video')) ?? []).map((v) => {
        const head = v.split('\n')[0].trim();
        const names = head.split(' ').slice(3).map((pt) => new RegExp(`a=rtpmap:${pt} ([^/\\s]+)`).exec(v)?.[1] ?? pt);
        const mid = /a=mid:(\S+)/.exec(v)?.[1];
        const dir = /a=(sendrecv|sendonly|recvonly|inactive)/.exec(v)?.[1];
        return `mid=${mid} ${dir} ${names.slice(0, 6).join(',')}`;
    });
}

function transformName(t: unknown): string | null {
    if (t == null) return null;
    return typeof RTCRtpScriptTransform !== 'undefined' && t instanceof RTCRtpScriptTransform ? 'RTCRtpScriptTransform' : 'other';
}

const harness = {
    api: () => mediaTransformApi(),
    supported: () => isMediaE2eeSupported(),

    /** Derive this participant's identity the way sign-in does; returns the public key. */
    async signIn(password: string, saltHex: string): Promise<string> {
        const identity = await deriveIdentity(password, saltHex);
        setActiveIdentity(identity);
        return identity.publicKeyEncoded;
    },

    /** The keys the server would publish for the other participants (stubs/keyVerification.ts). */
    setPeerKeys(keys: Record<number, string>): void {
        (window as unknown as { __peerKeys: Record<number, string> }).__peerKeys = keys;
    },

    /** In the voice channel, mic (and camera, unless `camera: false`) on,
     *  ready for signalling (no call yet). */
    async join(self: number, peerId: number, opts: { required: boolean; tone: number; camera?: boolean }): Promise<void> {
        mgr = new WebRTCManager();
        mgr.setLocalUserId(self);
        mgr.setRequireMediaE2ee(opts.required);
        await (mgr.media as unknown as MediaManager).startTone(opts.tone, opts.camera !== false);
        mgr.setOnRemoteStream((uid, s) => { voices.set(uid, s); sink(s, 'audio'); });
        mgr.setOnCameraStream((_uid, s) => { sink(s, 'video'); });
        mgr.setPeerCamera(peerId, true); // the server's announcement (B7)
    },

    async call(peerId: number): Promise<void> {
        await mgr!.callUser(peerId);
    },

    /** Turn the camera on mid-call, the way the app's camera button does. */
    cameraOn(): void {
        mgr!.publishCameraTrack((mgr!.media as unknown as MediaManager).addCamera());
    },

    status: (id: number) => mgr?.mediaE2eeStatus(id) ?? null,
    connected: (id: number) => mgr?.isConnectedTo(id) ?? false,

    /** Which transform each sender and receiver carries. */
    wiring(id: number) {
        const pc = peer(id).connection;
        return {
            senders: pc.getSenders().filter((s) => s.track).map((s) => ({ kind: s.track!.kind, transform: transformName(s.transform) })),
            receivers: pc.getReceivers().map((r) => ({ kind: r.track.kind, transform: transformName(r.transform) })),
            insertableStreams: (pc.getConfiguration() as RTCConfiguration & { encodedInsertableStreams?: boolean }).encodedInsertableStreams ?? null,
        };
    },

    /**
     * Is the peer's tone in what this page hears? Sampled `samples` times,
     * 120 ms apart once the analyser's window has filled; a sample counts when
     * the tone's bin stands 60 dB above the band's median. Measured: a decoded
     * tone stands 110-120 dB above it, the noise an Opus decoder makes of
     * ciphertext at most ~40, and silence has no peak at all.
     */
    async tone(id: number, frequency: number, samples = 12): Promise<{ present: number; of: number; marginDb: number[] }> {
        const stream = voices.get(id);
        if (!stream) return { present: 0, of: samples, marginDb: [] };
        const ctx = (listenCtx ??= new AudioContext());
        await ctx.resume().catch(() => { /* allowed by the runner */ });
        const src = ctx.createMediaStreamSource(stream);
        const an = new AnalyserNode(ctx, { fftSize: 8192, smoothingTimeConstant: 0 });
        src.connect(an);
        const bins = new Float32Array(an.frequencyBinCount);
        const hz = ctx.sampleRate / an.fftSize;
        const at = Math.round(frequency / hz);
        const lo = Math.round(200 / hz), hi = Math.round(6000 / hz);
        let present = 0;
        const margins: number[] = [];
        await new Promise((r) => setTimeout(r, 2 * 1000 * an.fftSize / ctx.sampleRate)); // a full window, twice
        for (let i = 0; i < samples; i++) {
            await new Promise((r) => setTimeout(r, 120));
            an.getFloatFrequencyData(bins);
            let peak = -Infinity;
            for (let b = at - 3; b <= at + 3; b++) peak = Math.max(peak, bins[b]);
            const band = Array.from(bins.slice(lo, hi)).filter(Number.isFinite).sort((x, y) => x - y);
            const median = band.length ? band[Math.floor(band.length / 2)] : -Infinity;
            const margin = Number.isFinite(peak) && Number.isFinite(median) ? peak - median : -999;
            margins.push(Math.round(margin));
            if (margin >= 60 && peak >= -80) present++;
        }
        src.disconnect();
        return { present, of: samples, marginDb: margins };
    },

    /** Inbound RTP so far: decoded video frames, bytes, and the video codec in use. */
    async inbound(id: number) {
        const pc = peer(id).connection;
        const stats = await pc.getStats();
        const codecs = new Map<string, string>();
        stats.forEach((r: StatsRow) => { if (r.type === 'codec') codecs.set(r.id as string, r.mimeType as string); });
        const out = { audioBytes: 0, videoBytes: 0, framesDecoded: 0, videoCodec: null as string | null };
        stats.forEach((r: StatsRow) => {
            if (r.type !== 'inbound-rtp') return;
            const kind = (r.kind ?? r.mediaType) as string;
            if (kind === 'audio') out.audioBytes += (r.bytesReceived as number) ?? 0;
            if (kind === 'video') {
                out.videoBytes += (r.bytesReceived as number) ?? 0;
                out.framesDecoded += (r.framesDecoded as number) ?? 0;
                out.videoCodec = codecs.get(r.codecId as string) ?? out.videoCodec;
            }
        });
        return { ...out, answeredVideoCodecs: answeredVideoCodecs(pc) };
    },

    /** The negotiated video sections, both directions (for a failure report). */
    descriptions(id: number) {
        const pc = peer(id).connection;
        return {
            local: `${pc.currentLocalDescription?.type}: ${videoSections(pc.currentLocalDescription?.sdp).join(' | ')}`,
            remote: `${pc.currentRemoteDescription?.type}: ${videoSections(pc.currentRemoteDescription?.sdp).join(' | ')}`,
        };
    },

    saveKey(id: number): void { savedKeys.set(id, peer(id).mediaCrypto.key); },
    restoreKey(id: number): void { peer(id).mediaCrypto.key = savedKeys.get(id) ?? null; },
    /** Put a session key on this peer, as a fresh derivation would. */
    async setKeyHex(id: number, hex: string): Promise<void> {
        peer(id).mediaCrypto.key = await importMediaKey(unhex(hex));
    },
    setCrypto(id: number, s: { enabled?: boolean; requireE2ee?: boolean }): void {
        const c = peer(id).mediaCrypto;
        if (s.enabled !== undefined) c.enabled = s.enabled;
        if (s.requireE2ee !== undefined) c.requireE2ee = s.requireE2ee;
    },

    leave(): void { mgr?.closeAll(); },
};

(window as unknown as { harness: typeof harness }).harness = harness;
