/**
 * The microphone bridge's SENDING end, in Steam's own page (SharedJSContext),
 * where Steam allows getUserMedia. The receiving end is in the Púca page
 * (shim/pageShim.ts). Each request from the page is one capture and one local
 * RTCPeerConnection with no ICE servers: the audio goes from one Steam
 * process to another on the Deck and nowhere else, and Púca encrypts it for
 * the call on the page side, as it would its own microphone.
 *
 * A capture lives exactly as long as Púca wants it: until the page releases
 * it (Púca stopped the track), the connection fails or closes, the page goes
 * away, or the plugin unloads. `count` says how many are open, so the Quick
 * Access panel can show when the microphone is in use.
 */
import type { MicConstraints } from './protocol';

export interface MicAnswer {
    answer: { type: 'answer'; sdp: string } | null;
    error: { name: string; message: string } | null;
}

interface Capture {
    pc: RTCPeerConnection;
    stream: MediaStream | null;
    timer: ReturnType<typeof setTimeout> | null;
}

/** How long a bridge may take to connect before it is given up. */
const CONNECT_TIMEOUT_MS = 15000;
/** How long a disconnected bridge may take to come back. */
const DISCONNECT_GRACE_MS = 5000;
const MAX_CAPTURES = 4;

export class MicBridge {
    private captures = new Map<string, Capture>();

    constructor(
        private sendAnswer: (id: string, reply: MicAnswer) => Promise<void>,
        private onCountChange: (count: number) => void,
        private log: (line: string) => void = () => {},
        /** Opens the microphone; a test hands in a synthetic source instead. */
        private capture: (constraints: MediaStreamConstraints) => Promise<MediaStream>
            = c => navigator.mediaDevices.getUserMedia(c),
    ) {}

    get count(): number {
        return [...this.captures.values()].filter(c => c.stream).length;
    }

    async request(id: string, constraints: MicConstraints, offer: { type: 'offer'; sdp: string }): Promise<void> {
        if (this.captures.has(id)) return;
        if (this.captures.size >= MAX_CAPTURES) {
            await this.sendAnswer(id, { answer: null, error: { name: 'NotReadableError', message: 'too many microphone captures' } });
            return;
        }
        const pc = new RTCPeerConnection({ iceServers: [] });
        const capture: Capture = { pc, stream: null, timer: null };
        this.captures.set(id, capture);
        let stream: MediaStream;
        try {
            stream = await this.capture({
                audio: {
                    channelCount: 1,
                    echoCancellation: constraints.echoCancellation ?? true,
                    noiseSuppression: constraints.noiseSuppression ?? true,
                    autoGainControl: constraints.autoGainControl ?? true,
                },
                video: false,
            });
        } catch (err) {
            this.drop(id);
            const e = err as { name?: unknown; message?: unknown };
            this.log(`microphone refused: ${String(e?.name)}`);
            await this.sendAnswer(id, {
                answer: null,
                error: { name: typeof e?.name === 'string' ? e.name : 'NotReadableError', message: String(e?.message ?? '') },
            });
            return;
        }
        if (!this.captures.has(id)) {
            // Released while the microphone was opening.
            stream.getTracks().forEach(t => t.stop());
            return;
        }
        capture.stream = stream;
        this.onCountChange(this.count);
        try {
            const track = stream.getAudioTracks()[0];
            const sender = pc.addTrack(track, stream);
            pc.addEventListener('connectionstatechange', () => this.watch(id, pc));
            await pc.setRemoteDescription(offer);
            await pc.setLocalDescription(await pc.createAnswer());
            await iceGathered(pc, 3000);
            capture.timer = setTimeout(() => {
                if (pc.connectionState !== 'connected') {
                    this.log('microphone bridge never connected');
                    this.release(id);
                }
            }, CONNECT_TIMEOUT_MS);
            await this.sendAnswer(id, { answer: { type: 'answer', sdp: pc.localDescription?.sdp ?? '' }, error: null });
            void setBitrate(sender, 128000);
        } catch (err) {
            this.log(`microphone bridge failed: ${String((err as Error)?.message ?? err)}`);
            this.release(id);
            await this.sendAnswer(id, { answer: null, error: { name: 'NotReadableError', message: 'the microphone bridge failed' } })
                .catch(() => {});
        }
    }

    private watch(id: string, pc: RTCPeerConnection): void {
        const c = this.captures.get(id);
        if (!c || c.pc !== pc) return;
        const state = pc.connectionState;
        if (state === 'connected') {
            if (c.timer) { clearTimeout(c.timer); c.timer = null; }
        } else if (state === 'failed' || state === 'closed') {
            this.release(id);
        } else if (state === 'disconnected') {
            if (c.timer) clearTimeout(c.timer);
            c.timer = setTimeout(() => {
                if (pc.connectionState !== 'connected') this.release(id);
            }, DISCONNECT_GRACE_MS);
        }
    }

    /** Close one capture: the microphone goes off when the last one closes. */
    release(id: string): void {
        if (this.drop(id)) this.onCountChange(this.count);
    }

    /** Close every capture (the page went away, or the plugin unloads). */
    releaseAll(): void {
        let any = false;
        for (const id of [...this.captures.keys()]) any = this.drop(id) || any;
        if (any) this.onCountChange(this.count);
    }

    private drop(id: string): boolean {
        const c = this.captures.get(id);
        if (!c) return false;
        this.captures.delete(id);
        if (c.timer) clearTimeout(c.timer);
        c.stream?.getTracks().forEach(t => t.stop());
        try { c.pc.close(); } catch { /* already closed */ }
        return true;
    }
}

function iceGathered(pc: RTCPeerConnection, ms: number): Promise<void> {
    return new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const t = setTimeout(resolve, ms);
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
    });
}

async function setBitrate(sender: RTCRtpSender, bps: number): Promise<void> {
    try {
        const p = sender.getParameters();
        if (!p.encodings?.length) return;
        p.encodings[0].maxBitrate = bps;
        await sender.setParameters(p);
    } catch {
        // The receiver's SDP already asks for this rate; this is belt and braces.
    }
}
