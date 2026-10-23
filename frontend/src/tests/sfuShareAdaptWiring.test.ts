// @vitest-environment jsdom
/**
 * SfuManager actually runs the share's resolution picker (shareAdapt.ts) on a
 * single-layer share, leaves a laddered one alone, and stops when the share
 * does. The decisions themselves are pinned in shareAdapt.test.ts; this pins
 * that they reach the sender.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('livekit-client/e2ee-worker?worker', () => ({ default: class { terminate() { /* fake */ } } }));
vi.mock('../api/channelKeys', () => ({ ensureChannelKey: vi.fn(async () => ({ key: new Uint8Array(32), epoch: 1 })) }));
/** What the server's join grant says about a share's ceiling (undefined = an older server). */
const grant: { maxShareKbps: number | undefined } = { maxShareKbps: undefined };
vi.mock('../api/client', () => ({
    apiClient: { get: vi.fn(async () => ({ url: 'ws://127.0.0.1:7880', token: 't', identity: 'u5#abc', max_screen_shares: 0, max_share_kbps: grant.maxShareKbps })) },
}));
/** The ladder setting as stored: `on` is the old on/off flag (= Always), `mode`
 *  the new one when set. */
const ladder: { on: boolean; mode: 'auto' | 'always' | 'never' | undefined } = { on: false, mode: undefined };
vi.mock('../components/settingsStore', async (importOriginal) => {
    const real = await importOriginal<typeof import('../components/settingsStore')>();
    return {
        ...real,
        loadSettings: () => ({ ...real.loadSettings(), shareSimulcast: ladder.on, ...(ladder.mode ? { shareLadder: ladder.mode } : {}) }),
    };
});

/** A sender that keeps what it is told and reports a bandwidth target. */
class FakeSender {
    params: { encodings: Array<Record<string, unknown>>; degradationPreference?: string };
    sets: Array<{ scale: unknown; pref: unknown }> = [];
    /** encodings[0].maxBitrate after every accepted setParameters. */
    caps: unknown[] = [];
    statsCalls = 0;
    targetBps = 4_500_000;
    bytes = 0;
    frames = 0;
    refuse = false;
    /** What getStats names as the encoder (undefined = not reported yet). */
    encoder: string | undefined = undefined;
    constructor(layers: number) {
        // livekit-client's rids by position (videoRids): q, then h, then f.
        const rids = ['q', 'h', 'f'];
        this.params = { encodings: Array.from({ length: layers }, (_, i) => (layers > 1 ? { rid: rids[i], active: true } : { active: true })) };
    }
    getParameters() { return JSON.parse(JSON.stringify(this.params)); }
    async setParameters(p: FakeSender['params']) {
        if (this.refuse) throw new Error('InvalidModificationError');
        this.params = p;
        this.sets.push({ scale: p.encodings[0].scaleResolutionDownBy, pref: p.degradationPreference });
        this.caps.push(p.encodings[0].maxBitrate);
    }
    async getStats() {
        this.statsCalls++;
        this.bytes += (this.targetBps / 8) * 2;
        this.frames += 60;
        return new Map([['o', { type: 'outbound-rtp', kind: 'video', targetBitrate: this.targetBps, bytesSent: this.bytes, framesEncoded: this.frames, qualityLimitationReason: 'none', ...(this.encoder ? { encoderImplementation: this.encoder } : {}) }]]);
    }
}
const senders: FakeSender[] = [];
/** The options every video publishTrack was called with. */
const published: Array<Record<string, unknown>> = [];
/** Every publish and unpublish, in order: 'pub:video', 'unpub:audio', ... */
const ops: string[] = [];
/** Hold the next publishes / unpublishes until released (a slow network). */
const gates: { publish: Promise<void> | null; unpublish: Promise<void> | null } = { publish: null, unpublish: null };

vi.mock('livekit-client', async (importOriginal) => {
    const real = await importOriginal<typeof import('livekit-client')>();
    class FakeLocalParticipant {
        permissions = { canPublish: true, canPublishSources: [] as number[] };
        pubs: Array<Record<string, unknown>> = [];
        on() { return this; }
        getTrackPublications() { return this.pubs; }
        async publishTrack(track: MediaStreamTrack, opts: { source: string; simulcast?: boolean; screenShareSimulcastLayers?: unknown[] }) {
            const isVideo = track.kind === 'video';
            if (isVideo) published.push(opts as unknown as Record<string, unknown>);
            ops.push(`pub:${track.kind}`);
            if (gates.publish) await gates.publish;
            // One encoding per rung plus the full picture, as livekit-client
            // builds them (shareLadder.ts ladderRungs mirrors its rules).
            const sender = isVideo ? new FakeSender(opts.simulcast ? (opts.screenShareSimulcastLayers?.length ?? 0) + 1 : 1) : undefined;
            if (sender) senders.push(sender);
            const pub = { source: opts.source, kind: isVideo ? real.Track.Kind.Video : real.Track.Kind.Audio, track: { mediaStreamTrack: track, sender } };
            this.pubs.push(pub);
            return pub;
        }
        async unpublishTrack(track: MediaStreamTrack) {
            if (!this.pubs.some(p => (p.track as { mediaStreamTrack: MediaStreamTrack }).mediaStreamTrack === track)) return; // livekit-client: warns, no throw
            ops.push(`unpub:${track.kind}`);
            if (gates.unpublish) await gates.unpublish;
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

import { Track } from 'livekit-client';
import { SfuManager } from '../api/rtc/sfuManager';
import { SHARE_ADAPT_INTERVAL_MS } from '../api/rtc/shareAdapt';
import { LEGACY_SHARE_KBPS, SHARE_KBPS_TABLE, SHARE_TOP_KBPS } from '../api/rtc/shareBitrate';

const mic = () => ({ kind: 'audio', id: 'mic', enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;
function shareStream(height = 1080, fps = 30) {
    const cap = { height, fps };
    const video = { kind: 'video', id: 'screen', enabled: true, readyState: 'live', contentHint: 'motion', stop: vi.fn(), getSettings: () => ({ height: cap.height, width: Math.round(cap.height * 16 / 9), frameRate: cap.fps }) };
    return { video, cap, stream: { getVideoTracks: () => [video], getAudioTracks: () => [] } as unknown as MediaStream };
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

describe('the share bitrate follows its quality, under the server ceiling', () => {
    let m: SfuManager;
    const join = async (maxShareKbps: number | undefined) => {
        grant.maxShareKbps = maxShareKbps;
        m = new SfuManager();
        await m.connect(12, mic());
    };
    const publishedCap = () => (published.at(-1)?.screenShareEncoding as { maxBitrate: number } | undefined)?.maxBitrate;
    beforeEach(() => {
        vi.useFakeTimers();
        senders.length = 0;
        published.length = 0;
        ladder.on = false;
    });
    afterEach(async () => { await m.disconnect(); grant.maxShareKbps = undefined; vi.useRealTimers(); });

    it('publishes 1080p60 at its own figure on a server that allows it', async () => {
        await join(SHARE_TOP_KBPS);
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(publishedCap()).toBe(SHARE_KBPS_TABLE[1080][60] * 1000);
        expect(senders[0].caps.at(-1), 'and the adapter keeps the sender there').toBe(SHARE_KBPS_TABLE[1080][60] * 1000);
    });

    it('holds it to the ceiling the server named', async () => {
        await join(5521);
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(publishedCap()).toBe(5_521_000);
        expect(senders[0].caps.at(-1)).toBe(5_521_000);
    });

    it('keeps the old 4.5 Mbps on a server that names no ceiling', async () => {
        await join(undefined);
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(publishedCap()).toBe(LEGACY_SHARE_KBPS * 1000);
        expect(senders[0].caps.at(-1)).toBe(LEGACY_SHARE_KBPS * 1000);
    });

    it('moves the cap with a live quality change', async () => {
        await join(SHARE_TOP_KBPS);
        const { stream, cap } = shareStream(720, 30);
        await m.startScreenShare(stream);
        await flush();
        expect(senders[0].caps.at(-1)).toBe(SHARE_KBPS_TABLE[720][30] * 1000);
        cap.height = 1080;
        cap.fps = 60;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS);
        expect(senders[0].caps.at(-1), 'up').toBe(SHARE_KBPS_TABLE[1080][60] * 1000);
        // Frame rate alone, same size: no rung moves, the cap still must.
        cap.fps = 30;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS);
        expect(senders[0].caps.at(-1), 'down').toBe(SHARE_KBPS_TABLE[1080][30] * 1000);
    });

    it('puts the cap back when something else changed it on the sender', async () => {
        // A track swap makes livekit-client re-apply the encodings it
        // published with (refreshSenderEncodings).
        await join(SHARE_TOP_KBPS);
        const { stream, cap } = shareStream(720, 30);
        await m.startScreenShare(stream);
        await flush();
        cap.height = 1080;
        cap.fps = 60;
        const s = senders[0];
        // Settle on the full picture first, so no rung change is coming that
        // would re-apply the cap for its own reasons.
        s.targetBps = 20_000_000;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 8);
        expect(s.sets.at(-1)?.scale, 'fixture: settled on the full picture').toBe(1);
        const rungChanges = s.sets.filter((x, i, a) => i > 0 && x.scale !== a[i - 1].scale).length;
        s.params.encodings[0].maxBitrate = SHARE_KBPS_TABLE[720][30] * 1000;
        const before = s.caps.length;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS);
        expect(s.caps.length).toBeGreaterThan(before);
        expect(s.caps.at(-1)).toBe(SHARE_KBPS_TABLE[1080][60] * 1000);
        expect(s.sets.filter((x, i, a) => i > 0 && x.scale !== a[i - 1].scale).length, 'not by a rung change').toBe(rungChanges);
        // POSITIVE CONTROL: left alone, it is not set again every tick.
        const settled = s.caps.length;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 2);
        expect(s.caps.length, 'no setParameters when nothing changed').toBe(settled);
    });

    it('publishes a laddered share with its quality on the top rung', async () => {
        ladder.on = true;
        await join(SHARE_TOP_KBPS);
        await m.startScreenShare(shareStream(1440, 60).stream);
        await flush();
        expect(publishedCap()).toBe(SHARE_KBPS_TABLE[1440][60] * 1000);
    });
});

describe('sending a share at several sizes when it helps (shareLadder.ts)', () => {
    let m: SfuManager;
    // A High-profile H.264 entry in the SENDER capabilities: a hardware encoder.
    const hardware = (on: boolean) => vi.stubGlobal('RTCRtpSender', {
        getCapabilities: () => ({
            codecs: [
                { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
                ...(on ? [{ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032' }] : []),
            ],
            headerExtensions: [],
        }),
    });
    const join = async () => {
        grant.maxShareKbps = SHARE_TOP_KBPS;
        m = new SfuManager();
        await m.connect(12, mic());
    };
    const lastSimulcast = () => published.at(-1)?.simulcast;
    const lastLayers = () => (published.at(-1)?.screenShareSimulcastLayers as Array<{ height: number }> | undefined)?.map(l => l.height);
    /** What of the SHARE is published right now, as 'video' / 'audio' (the mic is not the share). */
    const live = () => ((m as unknown as { room: { localParticipant: { pubs: Array<{ kind: string; source: string }> } } | null }).room?.localParticipant.pubs ?? [])
        .filter(p => p.source === Track.Source.ScreenShare || p.source === Track.Source.ScreenShareAudio)
        .map(p => p.kind);
    const withAudio = (height: number, fps: number) => {
        const s = shareStream(height, fps);
        const audio = { kind: 'audio', id: 'share-audio', enabled: true, readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
        (s.stream as unknown as { getAudioTracks: () => MediaStreamTrack[] }).getAudioTracks = () => [audio];
        return s;
    };
    /** A gate the fake LiveKit waits on, and its release. */
    const hold = () => {
        let release!: () => void;
        const p = new Promise<void>((r) => { release = r; });
        return { p, release };
    };
    beforeEach(() => {
        vi.useFakeTimers();
        senders.length = 0;
        published.length = 0;
        ops.length = 0;
        ladder.on = false;
        ladder.mode = undefined;
        gates.publish = null;
        gates.unpublish = null;
    });
    afterEach(async () => {
        gates.publish = null;
        gates.unpublish = null;
        await m.disconnect();
        grant.maxShareKbps = undefined;
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('Automatic ladders a 1080p60 share on a hardware encoder, with the 720p middle rung', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(lastSimulcast()).toBe(true);
        expect(lastLayers()).toEqual([360, 720]);
    });

    it('Automatic keeps a 720p30 share (4 Mbps) at one size, and any share without a hardware encoder', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(shareStream(720, 30).stream);
        await flush();
        expect(lastSimulcast()).toBe(false);
        await m.stopScreenShare();
        hardware(false);
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(lastSimulcast(), 'no hardware encoder: one size').toBe(false);
    });

    it('drops an Automatic ladder whose encoder turns out to be software, audio and all', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(withAudio(1080, 60).stream);
        await flush();
        expect(lastSimulcast()).toBe(true);
        senders.at(-1)!.encoder = 'SimulcastEncoderAdapter (OpenH264, OpenH264, OpenH264)';
        ops.length = 0;
        await vi.advanceTimersByTimeAsync(3000 * 3);
        expect(lastSimulcast(), 'republished at one size').toBe(false);
        expect(ops).toEqual(['unpub:video', 'unpub:audio', 'pub:video', 'pub:audio']);
        // ...and it stays one size: the next live change does not ladder it again.
        published.length = 0;
        await m.retuneShare();
        expect(published.length, 'no re-publish back to a ladder').toBe(0);
    });

    it('leaves an Automatic ladder alone when the encoder is hardware, and stops watching', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        senders.at(-1)!.encoder = 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT))';
        const idle = vi.getTimerCount();
        await vi.advanceTimersByTimeAsync(3000 * 4);
        expect(published.length).toBe(1);
        expect(vi.getTimerCount(), 'the watch ended').toBe(idle - 1);
    });

    it('does not second-guess Always', async () => {
        ladder.on = true; // the old setting on = Always
        hardware(false);
        await join();
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        senders.at(-1)!.encoder = 'OpenH264';
        await vi.advanceTimersByTimeAsync(3000 * 4);
        expect(published.length).toBe(1);
        expect(lastSimulcast()).toBe(true);
    });

    it('re-sizes a ladder IN PLACE on a live quality change, the bottom rung kept at 360 lines', async () => {
        hardware(true);
        await join();
        const { stream, cap } = shareStream(1440, 60);
        await m.startScreenShare(stream);
        await flush();
        const s = senders.at(-1)!;
        cap.height = 1080;
        cap.fps = 60;
        expect(await m.retuneShare()).toBe(true);
        expect(published.length, 'no re-publish').toBe(1);
        const enc = s.params.encodings as Array<{ rid: string; scaleResolutionDownBy: number; maxBitrate: number; active: boolean }>;
        expect(enc.map(e => [e.rid, e.scaleResolutionDownBy, e.maxBitrate])).toEqual([
            ['q', 3, 600_000], ['h', 1.5, 2_500_000], ['f', 1, SHARE_KBPS_TABLE[1080][60] * 1000],
        ]);
        expect(enc.every(e => e.active), 'dynacast owns active').toBe(true);
        // 1080p60 -> 720p60 (6 Mbps): still three sizes, the middle one now 540p.
        cap.height = 720;
        await m.retuneShare();
        expect(published.length, 'still no re-publish').toBe(1);
        const now = s.params.encodings as Array<{ scaleResolutionDownBy: number; maxBitrate: number }>;
        expect(now.map(e => [720 / e.scaleResolutionDownBy, e.maxBitrate])).toEqual([
            [360, 600_000], [540, 1_200_000], [720, SHARE_KBPS_TABLE[720][60] * 1000],
        ]);
    });

    it('re-publishes, audio included, when a live change moves between one size and several', async () => {
        hardware(true);
        await join();
        const { stream, cap } = withAudio(720, 30);
        await m.startScreenShare(stream);
        await flush();
        expect(lastSimulcast()).toBe(false);
        ops.length = 0;
        cap.height = 1080;
        cap.fps = 60;
        await m.retuneShare();
        expect(lastSimulcast(), 'up to a ladder').toBe(true);
        expect(ops).toEqual(['unpub:video', 'unpub:audio', 'pub:video', 'pub:audio']);
        ops.length = 0;
        cap.height = 720;
        cap.fps = 30;
        await m.retuneShare();
        expect(lastSimulcast(), 'back to one size').toBe(false);
        expect(ops).toEqual(['unpub:video', 'unpub:audio', 'pub:video', 'pub:audio']);
    });

    it('re-publishes when the NUMBER of sizes changes, and re-sizes a two-encoding ladder by position', async () => {
        // A 540-line capture has room for one rung below it (360p): two
        // encodings, where the full picture is `h`. Writing the middle rung's
        // numbers to `h` by name would have shrunk the whole share.
        ladder.on = true; // Always: the capture alone decides the rungs
        hardware(false);
        await join();
        const { stream, cap } = shareStream(540, 60);
        await m.startScreenShare(stream);
        await flush();
        expect(lastLayers()).toEqual([360]);
        expect(senders.at(-1)!.params.encodings.length).toBe(2);
        // 540p60 -> 500p30: still two encodings, re-sized in place, and the
        // full picture's cap moves with the frame rate (6 -> 4 Mbps).
        cap.height = 500;
        cap.fps = 30;
        await m.retuneShare();
        expect(published.length, 'in place').toBe(1);
        const two = senders.at(-1)!.params.encodings as Array<{ rid: string; scaleResolutionDownBy: number; maxBitrate: number }>;
        expect(two.map(e => e.rid)).toEqual(['q', 'h']);
        expect(500 / two[0].scaleResolutionDownBy).toBeCloseTo(360);
        expect(two[1].scaleResolutionDownBy, 'the full picture stays full').toBe(1);
        expect(two[1].maxBitrate, 'at the new top bitrate, not a middle rung\'s').toBe(SHARE_KBPS_TABLE[720][30] * 1000);
        // 500 -> 1080 lines: a middle rung now fits, so three encodings: a re-publish.
        cap.height = 1080;
        await m.retuneShare();
        expect(published.length).toBe(2);
        expect(lastLayers()).toEqual([360, 720]);
    });

    it('a share of one size that stays one size is not re-published', async () => {
        hardware(false);
        await join();
        const { stream, cap } = shareStream(720, 30);
        await m.startScreenShare(stream);
        await flush();
        cap.height = 1080;
        await m.retuneShare();
        expect(published.length).toBe(1);
    });

    it('a stop that lands while a re-publish is publishing leaves nothing on the wire', async () => {
        hardware(true);
        await join();
        const idle = vi.getTimerCount();
        const { stream, cap } = withAudio(1080, 60);
        await m.startScreenShare(stream);
        await flush();
        expect(live()).toEqual(['video', 'audio']);
        ops.length = 0;
        // 1080p60 -> 720p30: one size now, so the share is published again...
        cap.height = 720;
        cap.fps = 30;
        const slow = hold();
        gates.publish = slow.p;
        const retune = m.retuneShare();
        await flush();
        expect(live(), 'mid-switch: the old share is down, the new one in flight').toEqual([]);
        // ...and the person stops sharing before that publish returns.
        const stop = m.stopScreenShare();
        await flush();
        slow.release();
        gates.publish = null;
        await retune;
        await stop;
        await vi.advanceTimersByTimeAsync(SHARE_ADAPT_INTERVAL_MS * 2);
        expect(live(), 'the late publish is taken down, and its sound never goes up').toEqual([]);
        expect(ops, 'its sound is not published again either').not.toContain('pub:audio');
        expect(vi.getTimerCount(), 'nothing left polling a share that ended').toBe(idle);
    });

    it('a stop that lands between a re-publish\'s unpublish and publish publishes nothing again', async () => {
        hardware(true);
        await join();
        const { stream, cap } = withAudio(1080, 60);
        await m.startScreenShare(stream);
        await flush();
        cap.height = 720;
        cap.fps = 30;
        const slow = hold();
        gates.unpublish = slow.p;
        const retune = m.retuneShare();
        await flush();
        const stop = m.stopScreenShare();
        slow.release();
        gates.unpublish = null;
        await retune;
        await stop;
        expect(live()).toEqual([]);
        expect(published.length, 'only the original publish').toBe(1);
    });

    it('stopping and sharing again at once publishes the new share, once', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(withAudio(1080, 60).stream);
        await flush();
        const stop = m.stopScreenShare();
        const again = m.startScreenShare(shareStream(1080, 60).stream);
        await stop;
        await again;
        await flush();
        expect(live(), 'the new share only').toEqual(['video']);
    });

    it('follows a changed setting on the running share at once', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(withAudio(1080, 60).stream);
        await flush();
        expect(lastSimulcast()).toBe(true);
        // A settings save that leaves this setting alone touches nothing.
        await m.followLadderSetting();
        expect(published.length).toBe(1);
        // Never: one size now, not from the next share.
        ladder.mode = 'never';
        ops.length = 0;
        await m.followLadderSetting();
        expect(lastSimulcast(), 'Never, at once').toBe(false);
        expect(ops).toEqual(['unpub:video', 'unpub:audio', 'pub:video', 'pub:audio']);
        // Automatic again: the ladder comes back.
        ladder.mode = 'auto';
        await m.followLadderSetting();
        expect(lastSimulcast(), 'Automatic again').toBe(true);
        expect(published.length).toBe(3);
    });

    it('a changed setting with no share running waits for the next share', async () => {
        hardware(true);
        await join();
        ladder.mode = 'never';
        await m.followLadderSetting();
        expect(published.length).toBe(0);
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        expect(lastSimulcast(), 'the next share follows it').toBe(false);
    });

    it('leaving the call ends the encoder watch', async () => {
        hardware(true);
        await join();
        await m.startScreenShare(shareStream(1080, 60).stream);
        await flush();
        await m.disconnect();
        expect(vi.getTimerCount()).toBe(0);
    });
});
