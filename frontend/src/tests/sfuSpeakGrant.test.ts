/**
 * An SFU join by a member WITHOUT the Speak permission.
 *
 * The backend mints their LiveKit grant with no microphone source
 * (src/sfu.rs publish_sources). Before this was fixed, SfuManager.connect()
 * published the mic anyway, livekit-client threw PublishTrackError 403, and
 * connect() tore the whole room down: the member could not even LISTEN.
 * Reproduced live on 2026-09-28 (frontend/e2e/speak-perms-live.mjs,
 * TRANSPORT=sfu): "failed to publish track, insufficient permissions".
 *
 * The fake Room below applies livekit-client's own publish rule
 * (LocalParticipant.hasPermissionsToPublish), so the unfixed connect() goes
 * RED here exactly the way it failed in the real call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrackSource } from '@livekit/protocol';

vi.mock('livekit-client/e2ee-worker?worker', () => ({ default: class { terminate() { /* fake */ } } }));
vi.mock('../api/channelKeys', () => ({ ensureChannelKey: vi.fn(async () => ({ key: new Uint8Array(32), epoch: 1 })) }));
vi.mock('../api/client', () => ({
    apiClient: { get: vi.fn(async () => ({ url: 'ws://127.0.0.1:7880', token: 't', identity: 'u5#abc', max_screen_shares: 0 })) },
}));

// The grant the fake room will hand out on connect (set per test).
let grant: { canPublish: boolean; canPublishSources: number[] } = { canPublish: true, canPublishSources: [] };
const published: string[] = [];
const unpublished: MediaStreamTrack[] = [];

vi.mock('livekit-client', async (importOriginal) => {
    const real = await importOriginal<typeof import('livekit-client')>();
    const protoToSource: Record<number, string> = {
        [TrackSource.CAMERA]: real.Track.Source.Camera,
        [TrackSource.MICROPHONE]: real.Track.Source.Microphone,
        [TrackSource.SCREEN_SHARE]: real.Track.Source.ScreenShare,
        [TrackSource.SCREEN_SHARE_AUDIO]: real.Track.Source.ScreenShareAudio,
    };
    class FakeLocalParticipant {
        permissions: typeof grant | undefined = undefined;
        pubs: { source: string; track: { mediaStreamTrack: MediaStreamTrack } }[] = [];
        on() { return this; }
        getTrackPublications() { return this.pubs; }
        async publishTrack(track: MediaStreamTrack, opts: { source: string }) {
            // livekit-client LocalParticipant.publish / hasPermissionsToPublish
            const p = this.permissions;
            const ok = !!p && p.canPublish && (p.canPublishSources.length === 0
                || p.canPublishSources.map(s => protoToSource[s]).includes(opts.source));
            if (!ok) {
                const e = new Error('failed to publish track, insufficient permissions');
                e.name = 'PublishTrackError';
                throw e;
            }
            published.push(opts.source);
            const pub = { source: opts.source, track: { mediaStreamTrack: track } };
            this.pubs.push(pub);
            return pub;
        }
        async unpublishTrack(track: MediaStreamTrack) {
            unpublished.push(track);
            this.pubs = this.pubs.filter(p => p.track.mediaStreamTrack !== track);
        }
    }
    class FakeRoom {
        state = real.ConnectionState.Disconnected;
        localParticipant = new FakeLocalParticipant();
        remoteParticipants = new Map();
        on() { return this; }
        removeAllListeners() { return this; }
        async setE2EEEnabled() { /* fake */ }
        async connect() {
            this.localParticipant.permissions = { ...grant, canPublishSources: [...grant.canPublishSources] };
            this.state = real.ConnectionState.Connected;
        }
        async disconnect() { this.state = real.ConnectionState.Disconnected; }
    }
    return { ...real, Room: FakeRoom, isE2EESupported: () => true };
});

import { SfuManager, micPublishAllowed, MIC_PROTO_SOURCE } from '../api/rtc/sfuManager';
import { Track } from 'livekit-client';

const fakeMic = () => ({ kind: 'audio', id: 'mic-1', enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;
const NO_SPEAK = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

describe('micPublishAllowed mirrors livekit-client\'s publish rule for the microphone', () => {
    it('pins the proto value it compares against', () => {
        expect(MIC_PROTO_SOURCE).toBe(TrackSource.MICROPHONE);
    });
    it('allows only a grant that can publish AND lists the mic (or lists nothing)', () => {
        expect(micPublishAllowed({ canPublish: true, canPublishSources: [TrackSource.MICROPHONE] })).toBe(true);
        expect(micPublishAllowed({ canPublish: true, canPublishSources: [] })).toBe(true);
        // The common deny: Speak off, Video/Stream on — canPublish stays true.
        expect(micPublishAllowed({ canPublish: true, canPublishSources: NO_SPEAK })).toBe(false);
        expect(micPublishAllowed({ canPublish: false, canPublishSources: [TrackSource.MICROPHONE] })).toBe(false);
        expect(micPublishAllowed(undefined)).toBe(false);
    });
});

describe('SfuManager.connect for a member without Speak', () => {
    let m: SfuManager;
    beforeEach(() => {
        published.length = 0;
        unpublished.length = 0;
        m = new SfuManager();
    });
    afterEach(async () => { await m.disconnect(); });

    it('POSITIVE CONTROL: with Speak the mic is published and connect reports it', async () => {
        grant = { canPublish: true, canPublishSources: [TrackSource.MICROPHONE, ...NO_SPEAK] };
        await expect(m.connect(12, fakeMic())).resolves.toEqual({ micAllowed: true });
        expect(published).toEqual([Track.Source.Microphone]);
        expect(m.connected).toBe(true);
    });

    it('joins listen-only when the grant keeps Video/Stream but has no microphone', async () => {
        grant = { canPublish: true, canPublishSources: NO_SPEAK };
        await expect(m.connect(12, fakeMic())).resolves.toEqual({ micAllowed: false });
        expect(published, 'no mic publish attempt at all').toEqual([]);
        expect(m.connected, 'still in the call, so they can listen').toBe(true);
    });

    it('joins listen-only on a subscribe-only grant', async () => {
        grant = { canPublish: false, canPublishSources: [] };
        await expect(m.connect(12, fakeMic())).resolves.toEqual({ micAllowed: false });
        expect(m.connected).toBe(true);
    });

    it('a coalesced second connect gets the same verdict from the live grant', async () => {
        grant = { canPublish: true, canPublishSources: NO_SPEAK };
        const [a, b] = await Promise.all([m.connect(12, fakeMic()), m.connect(12, fakeMic())]);
        expect(a).toEqual({ micAllowed: false });
        expect(b).toEqual({ micAllowed: false });
    });

    it('replaceMicTrack never unpublishes-then-fails without Speak', async () => {
        grant = { canPublish: true, canPublishSources: NO_SPEAK };
        await m.connect(12, null);
        await m.replaceMicTrack(fakeMic());
        expect(published).toEqual([]);
        expect(unpublished).toEqual([]);
    });

    it('unpublishMic takes a published mic off the SFU', async () => {
        grant = { canPublish: true, canPublishSources: [TrackSource.MICROPHONE] };
        const mic = fakeMic();
        await m.connect(12, mic);
        await m.unpublishMic();
        expect(unpublished).toEqual([mic]);
    });
});
