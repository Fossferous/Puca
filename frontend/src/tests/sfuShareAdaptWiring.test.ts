/**
 * SfuManager actually runs the share's resolution picker (shareAdapt.ts) on a
 * single-layer share, leaves a laddered one alone, and stops when the share
 * does. The decisions themselves are pinned in shareAdapt.test.ts; this pins
 * that they reach the sender.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('livekit-client/e2ee-worker?worker', () => ({ default: class { terminate() { /* fake */ } } }));
vi.mock('../api/channelKeys', () => ({ ensureChannelKey: vi.fn(async () => ({ key: new Uint8Array(32), epoch: 1 })) }));
vi.mock('../api/client', () => ({
    apiClient: { get: vi.fn(async () => ({ url: 'ws://127.0.0.1:7880', token: 't', identity: 'u5#abc', max_screen_shares: 0 })) },
}));
const ladder = { on: false };
vi.mock('../components/settingsStore', async (importOriginal) => {
    const real = await importOriginal<typeof import('../components/settingsStore')>();
    return { ...real, loadSettings: () => ({ ...real.loadSettings(), shareSimulcast: ladder.on }) };
});

/** A sender that keeps what it is told and reports a bandwidth target. */
class FakeSender {
    params: { encodings: Array<Record<string, unknown>>; degradationPreference?: string };
    sets: Array<{ scale: unknown; pref: unknown }> = [];
    statsCalls = 0;
    targetBps = 4_500_000;
    bytes = 0;
    frames = 0;
    refuse = false;
    constructor(layers: number) { this.params = { encodings: Array.from({ length: layers }, () => ({ active: true })) }; }
    getParameters() { return JSON.parse(JSON.stringify(this.params)); }
    async setParameters(p: FakeSender['params']) {
        if (this.refuse) throw new Error('InvalidModificationError');
        this.params = p;
        this.sets.push({ scale: p.encodings[0].scaleResolutionDownBy, pref: p.degradationPreference });
    }
    async getStats() {
        this.statsCalls++;
        this.bytes += (this.targetBps / 8) * 2;
        this.frames += 60;
        return new Map([['o', { type: 'outbound-rtp', kind: 'video', targetBitrate: this.targetBps, bytesSent: this.bytes, framesEncoded: this.frames, qualityLimitationReason: 'none' }]]);
    }
}
const senders: FakeSender[] = [];

vi.mock('livekit-client', async (importOriginal) => {
    const real = await importOriginal<typeof import('livekit-client')>();
    class FakeLocalParticipant {
        permissions = { canPublish: true, canPublishSources: [] as number[] };
        pubs: Array<Record<string, unknown>> = [];
        on() { return this; }
        getTrackPublications() { return this.pubs; }
        async publishTrack(track: MediaStreamTrack, opts: { source: string; simulcast?: boolean }) {
            const isVideo = track.kind === 'video';
            const sender = isVideo ? new FakeSender(opts.simulcast ? 3 : 1) : undefined;
            if (sender) senders.push(sender);
            const pub = { source: opts.source, kind: isVideo ? real.Track.Kind.Video : real.Track.Kind.Audio, track: { mediaStreamTrack: track, sender } };
            this.pubs.push(pub);
            return pub;
        }
        async unpublishTrack(track: MediaStreamTrack) {
            this.pubs = this.pubs.filter(p => (p.track as { mediaStreamTrack: MediaStreamTrack }).mediaStreamTrack !== track);
        }
    }
    class FakeRoom {
        state = real.ConnectionState.Disconnected;
        localParticipant = new FakeLocalParticipant();
        remoteParticipants = new Map();
        on() { return this; }
        removeAllListeners() { return this; }
        async setE2EEEnabled() { /* fake */ }
        async connect() { this.state = real.ConnectionState.Connected; }
        async disconnect() { this.state = real.ConnectionState.Disconnected; }
    }
    return { ...real, Room: FakeRoom, isE2EESupported: () => true };
});

import { SfuManager } from '../api/rtc/sfuManager';
import { SHARE_ADAPT_INTERVAL_MS } from '../api/rtc/shareAdapt';

const mic = () => ({ kind: 'audio', id: 'mic', enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;
function shareStream(height = 1080) {
    const video = { kind: 'video', id: 'screen', enabled: true, contentHint: 'motion', stop: vi.fn(), getSettings: () => ({ height, width: Math.round(height * 16 / 9), frameRate: 30 }) };
    return { video, stream: { getVideoTracks: () => [video], getAudioTracks: () => [] } as unknown as MediaStream };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('the share resolution picker, wired', () => {
    let m: SfuManager;
    beforeEach(async () => {
        vi.useFakeTimers();
        senders.length = 0;
        ladder.on = false;
        m = new SfuManager();
        await m.connect(12, mic());
    });
    afterEach(async () => { await m.disconnect(); vi.useRealTimers(); });

    it('puts a single-layer share on the start rung at once, holding resolution', async () => {
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        const s = senders[0];
        expect(s.sets[0], '1080 -> 540: half the lines').toEqual({ scale: 2, pref: 'maintain-resolution' });
    });

    it('climbs to the full picture when the target carries it', async () => {
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 3);
        const s = senders[0];
        expect(s.sets.at(-1)).toEqual({ scale: 1, pref: 'maintain-resolution' });
    });

    it('drops to the floor when the target collapses', async () => {
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        const s = senders[0];
        s.targetBps = 150_000;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 2);
        expect(s.sets.at(-1), '1080 -> 360').toEqual({ scale: 3, pref: 'maintain-resolution' });
    });

    it('leaves a laddered share entirely to libwebrtc', async () => {
        ladder.on = true;
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 5);
        expect(senders[0].sets).toEqual([]);
        expect(senders[0].statsCalls).toBe(0);
    });

    it('does not even poll a laddered share', async () => {
        ladder.on = true;
        const idle = vi.getTimerCount();
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        expect(vi.getTimerCount()).toBe(idle);
    });

    it('a refused rung change is retried, not believed', async () => {
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        const s = senders[0];
        expect(s.sets.at(-1)).toEqual({ scale: 2, pref: 'maintain-resolution' });
        s.targetBps = 150_000;
        s.refuse = true;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS);
        s.refuse = false;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 3);
        expect(s.sets.at(-1), 'the floor lands once the sender accepts it').toEqual({ scale: 3, pref: 'maintain-resolution' });
    });

    it('stops its timer when the share stops, and when the call ends', async () => {
        const idle = vi.getTimerCount();
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        expect(vi.getTimerCount(), 'one polling timer while sharing').toBe(idle + 1);
        await m.stopScreenShare();
        expect(vi.getTimerCount()).toBe(idle);
        await m.startScreenShare(shareStream(1080).stream);
        await flush();
        await m.disconnect();
        expect(vi.getTimerCount(), 'leaving the call mid-share leaves nothing polling').toBe(0);
    });

    it('retries a refused start rung instead of believing it', async () => {
        senders.length = 0;
        const { stream } = shareStream(1080);
        // Refuse from the first call on: the adapter must not be kept.
        const orig = FakeSender.prototype.setParameters;
        let refusals = 2;
        FakeSender.prototype.setParameters = async function (this: FakeSender, p) {
            if (refusals-- > 0) throw new Error('InvalidModificationError');
            return orig.call(this, p);
        };
        try {
            await m.startScreenShare(stream);
            await flush();
            await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 2);
            expect(senders[0].sets[0], 'the start rung lands once the sender accepts it').toEqual({ scale: 2, pref: 'maintain-resolution' });
        } finally {
            FakeSender.prototype.setParameters = orig;
        }
    });
});
