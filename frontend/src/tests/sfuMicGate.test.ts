// @vitest-environment jsdom
/**
 * A shut microphone stays shut while it is published to the SFU.
 *
 * Púca gates the mic with MediaStreamTrack.enabled (mute, push-to-talk,
 * push-to-mute, AFK). livekit-client wraps a published MediaStreamTrack in a
 * fresh LocalAudioTrack whose constructor re-syncs `enabled` to its own mute
 * state, which is "unmuted", so every SFU publish of a shut mic opened it.
 * Measured live on 2026-10-08 (headless Edge, fake devices): a push-to-talk
 * member joining an SFU call went out enabled and stayed so, and the listener
 * received their audio; on mesh the same member sent nothing. The same
 * happened to a muted member's mic whenever it was re-published mid-call (a
 * noise-mode change, a lost device, following the OS default).
 *
 * The fake room's publish below runs the REAL livekit-client LocalAudioTrack
 * constructor on the track, so these tests go red on the library's actual
 * behaviour, not on an imitation of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('livekit-client/e2ee-worker?worker', () => ({ default: class { terminate() { /* fake */ } } }));
vi.mock('../api/channelKeys', () => ({ ensureChannelKey: vi.fn(async () => ({ key: new Uint8Array(32), epoch: 1 })) }));
vi.mock('../api/client', () => ({
    apiClient: { get: vi.fn(async () => ({ url: 'ws://127.0.0.1:7880', token: 't', identity: 'u5#abc', max_screen_shares: 0 })) },
}));

/** What the track's gate was at the end of each publish, before it resolved. */
const atPublishEnd: boolean[] = [];

vi.mock('livekit-client', async (importOriginal) => {
    const real = await importOriginal<typeof import('livekit-client')>();
    class FakeLocalParticipant {
        permissions = { canPublish: true, canPublishSources: [] as number[] };
        pubs: { source: string; track: { mediaStreamTrack: MediaStreamTrack } }[] = [];
        on() { return this; }
        getTrackPublications() { return this.pubs; }
        async publishTrack(track: MediaStreamTrack, opts: { source: string }) {
            // livekit-client LocalParticipant.publishOrRepublishTrack: a raw
            // MediaStreamTrack becomes a LocalAudioTrack, then the server
            // round trip and the negotiation.
            new real.LocalAudioTrack(track, undefined, true);
            await new Promise(r => setTimeout(r, 20));
            atPublishEnd.push(track.enabled);
            const pub = { source: opts.source, track: { mediaStreamTrack: track } };
            this.pubs.push(pub);
            return pub;
        }
        async unpublishTrack(track: MediaStreamTrack) {
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
        async connect() { this.state = real.ConnectionState.Connected; }
        async disconnect() { this.state = real.ConnectionState.Disconnected; }
    }
    return { ...real, Room: FakeRoom, isE2EESupported: () => true };
});

import { SfuManager, holdMicGateWhilePublishing } from '../api/rtc/sfuManager';
import { LocalAudioTrack } from 'livekit-client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A mic track whose `enabled` is a prototype accessor, as the platform's is;
 *  every write that reaches it is recorded. */
class FakeMicTrack extends EventTarget {
    kind = 'audio';
    id = 'mic-1';
    readyState = 'live';
    muted = false;
    label = 'Default - Microphone (FMA120)';
    writes: boolean[] = [];
    private on: boolean;
    constructor(on: boolean) { super(); this.on = on; }
    get enabled() { return this.on; }
    set enabled(v: boolean) { this.on = v; this.writes.push(v); }
    getConstraints() { return {}; }
    getSettings() { return { deviceId: 'default' }; }
    stop() { this.readyState = 'ended'; }
}
const asTrack = (t: FakeMicTrack) => t as unknown as MediaStreamTrack;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
    atPublishEnd.length = 0;
    // livekit-client's silence check opens an AudioContext when there is one.
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('why: livekit-client opens a shut mic it wraps', () => {
    it('POSITIVE CONTROL: a LocalAudioTrack made from a disabled track enables it', async () => {
        const t = new FakeMicTrack(false);
        new LocalAudioTrack(asTrack(t), undefined, true);
        await tick(5);
        expect(t.enabled).toBe(true);
    });

    it('...and with the gate held it stays shut', async () => {
        const t = new FakeMicTrack(false);
        const release = holdMicGateWhilePublishing(asTrack(t));
        new LocalAudioTrack(asTrack(t), undefined, true);
        await tick(5);
        release();
        expect(t.enabled).toBe(false);
        expect(t.writes).not.toContain(true);
    });
});

describe('holdMicGateWhilePublishing', () => {
    it('a shut gate can be written shut but not opened until released', () => {
        const t = new FakeMicTrack(false);
        const release = holdMicGateWhilePublishing(asTrack(t));
        asTrack(t).enabled = true;
        expect(t.enabled).toBe(false);
        asTrack(t).enabled = false;
        release();
        expect(Object.prototype.hasOwnProperty.call(t, 'enabled')).toBe(false);
        asTrack(t).enabled = true;
        expect(t.enabled).toBe(true);
        expect(t.writes).toEqual([false, true]);
    });

    it('an open gate stays open, can be shut (a mute during the publish), and is then not re-opened', () => {
        const t = new FakeMicTrack(true);
        const release = holdMicGateWhilePublishing(asTrack(t));
        asTrack(t).enabled = true;
        expect(t.enabled).toBe(true);
        asTrack(t).enabled = false;
        asTrack(t).enabled = true; // livekit-client's re-sync after the mute
        expect(t.enabled).toBe(false);
        release();
    });

    it('a track whose enabled is not a prototype accessor is left alone; a second hold is a no-op', () => {
        const plain = { enabled: false } as unknown as MediaStreamTrack;
        const r1 = holdMicGateWhilePublishing(plain);
        plain.enabled = true;
        expect(plain.enabled).toBe(true);
        r1();
        const t = new FakeMicTrack(false);
        const outer = holdMicGateWhilePublishing(asTrack(t));
        const inner = holdMicGateWhilePublishing(asTrack(t));
        inner();
        asTrack(t).enabled = true;
        expect(t.enabled).toBe(false); // the outer hold still stands
        outer();
    });
});

describe('SfuManager publishes a shut mic shut', () => {
    let m: SfuManager;
    beforeEach(() => { m = new SfuManager(); });
    afterEach(async () => { await m.disconnect(); });

    it('joining with push-to-talk (or muted): the mic is shut all through the publish and after it', async () => {
        const t = new FakeMicTrack(false);
        await expect(m.connect(12, asTrack(t))).resolves.toEqual({ micAllowed: true });
        expect(atPublishEnd).toEqual([false]);
        expect(t.enabled).toBe(false);
        expect(t.writes).not.toContain(true);
        asTrack(t).enabled = true; // the hold is gone: push-to-talk works
        expect(t.enabled).toBe(true);
    });

    it('control: joining with an open mic publishes it open', async () => {
        const t = new FakeMicTrack(true);
        await m.connect(12, asTrack(t));
        expect(atPublishEnd).toEqual([true]);
        expect(t.enabled).toBe(true);
    });

    it('a muted member\'s mic re-published mid-call (noise mode, lost device, OS default) stays shut', async () => {
        await m.connect(12, asTrack(new FakeMicTrack(true)));
        const fresh = new FakeMicTrack(false);
        await m.replaceMicTrack(asTrack(fresh));
        expect(atPublishEnd).toEqual([true, false]);
        expect(fresh.enabled).toBe(false);
        expect(fresh.writes).not.toContain(true);
        asTrack(fresh).enabled = true;
        expect(fresh.enabled).toBe(true);
    });

    it('VoicePanel re-asserts the gate once the join publish is done (a push-to-talk press during it was held back)', () => {
        const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'VoicePanel.tsx'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const at = src.indexOf('await sfuManager.connect(channelId, micTrack);');
        expect(at).toBeGreaterThan(0);
        const next = src.slice(at, at + 400);
        expect(next).toMatch(/if \(!micAllowed && micTrack\) await denySpeakLocallyRef\.current\(\);\s*else if \(micTrack\) applyMicGate\(\);/);
    });

    it('a mute during the republish is kept, though livekit-client re-syncs afterwards', async () => {
        await m.connect(12, asTrack(new FakeMicTrack(true)));
        const fresh = new FakeMicTrack(true);
        const p = m.replaceMicTrack(asTrack(fresh));
        asTrack(fresh).enabled = false; // the member mutes while it publishes
        await p;
        expect(atPublishEnd).toEqual([true, false]);
        expect(fresh.enabled).toBe(false);
    });
});
