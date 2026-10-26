// @vitest-environment jsdom
/**
 * SfuManager, as a VIEWER of a share: the step to a smaller copy reaches the
 * SFU (shareLayerGuard.ts decides; this pins that the decision is asked for,
 * kept through a focus change, undone, and never taken for a share with no
 * smaller copy), and the moments the 2026-10-25 reports lacked reach puca.log.
 *
 * The room is a hand-built stand-in on the manager's private field, as in
 * sfuE2eeListeners.test.ts: the code under test reads remoteParticipants,
 * trackPublications and each publication's receiver, nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { CryptorError, CryptorErrorReason, DisconnectReason, RoomEvent, Track, VideoQuality } from 'livekit-client';
import { SfuManager } from '../api/rtc/sfuManager';
import { CRYPTOR_REASONS, encryptionErrorLine, identityFree, rtcEventLogSettled } from '../api/rtc/rtcEventLog';
import { CLEAN_MS, SETTLE_MS, VIEW_SAMPLE_MS } from '../api/rtc/shareLayerGuard';
import { setScreenLatencyMinimised } from '../api/rtc/receiverLatency';

/** A receiver whose inbound-rtp counters grow by `perRead` on every read. */
class FakeReceiver {
    recv = 0;
    lost = 0;
    nack = 0;
    freezes = 0;
    lossPct = 0;
    size = { w: 1920, h: 1080 };
    async getStats() {
        const packets = 2400;
        const l = Math.round((packets * this.lossPct) / 100);
        this.recv += packets - l;
        this.lost += l;
        this.nack += l;
        return new Map([['in', {
            type: 'inbound-rtp', kind: 'video', packetsReceived: this.recv, packetsLost: this.lost, nackCount: this.nack,
            pliCount: 0, freezeCount: this.freezes, frameWidth: this.size.w, frameHeight: this.size.h,
        }]]);
    }
}

function sharePub(layers: number[], receiver: FakeReceiver) {
    const pub = {
        source: Track.Source.ScreenShare,
        kind: Track.Kind.Video,
        isSubscribed: true,
        trackSid: 'TR_share',
        simulcasted: layers.length > 1,
        trackInfo: { layers: layers.map(quality => ({ quality })) },
        asked: [] as VideoQuality[],
        get videoQuality() { return this.asked.at(-1); },
        setVideoQuality(q: VideoQuality) { this.asked.push(q); },
        setSubscribed() { /* syncSubscriptions */ },
        track: { receiver },
    };
    return pub;
}

/** A manager watching user 7's share, in a room holding just that. */
function watching(layers: number[]) {
    const receiver = new FakeReceiver();
    const pub = sharePub(layers, receiver);
    const m = new SfuManager();
    (m as unknown as { room: unknown }).room = {
        localParticipant: { permissions: {} },
        remoteParticipants: new Map([['u7#abc', { identity: 'u7#abc', trackPublications: new Map([['TR_share', pub]]) }]]),
        removeAllListeners() { return this; },
        async disconnect() { /* fake */ },
    };
    m.setWatchedVideo([7]);
    return { m, pub, receiver };
}

/** Advance one read at a time until `done()`; how long that took (ms). */
async function readsUntil(done: () => boolean, max: number): Promise<number> {
    for (let i = 1; i <= max; i++) {
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        if (done()) return i * VIEW_SAMPLE_MS;
    }
    return Infinity;
}

const lines = () => invoke.mock.calls
    .filter(c => (c as unknown[])[0] === 'log_stream_diag')
    .map(c => String(((c as unknown[])[1] as { line: string }).line));

beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('a viewer whose connection keeps losing a share', () => {
    it('asks the SFU for the middle copy, and for the full picture again after a clean stretch', async () => {
        const { m, pub, receiver } = watching([0, 1, 2]);
        expect(pub.asked.at(-1), 'one watched share: the full picture').toBe(VideoQuality.HIGH);
        receiver.lossPct = 3;
        const down = await readsUntil(() => pub.asked.at(-1) === VideoQuality.MEDIUM, 20);
        expect(down, 'after settling and two lossy windows').toBeLessThanOrEqual(SETTLE_MS + VIEW_SAMPLE_MS * 3);
        // A focus change re-asks every share: the step must survive it.
        m.setFocusedRemote(7);
        expect(pub.asked.at(-1), 'focused, and still stepped down').toBe(VideoQuality.MEDIUM);
        receiver.lossPct = 0;
        const up = await readsUntil(() => pub.asked.at(-1) === VideoQuality.HIGH, 60);
        expect(up, 'not before the step has settled and the stretch is clean').toBeGreaterThanOrEqual(SETTLE_MS + CLEAN_MS - VIEW_SAMPLE_MS);
        expect(up).toBeLessThanOrEqual(SETTLE_MS + CLEAN_MS + VIEW_SAMPLE_MS * 2);
        await rtcEventLogSettled();
        expect(lines().some(l => l.startsWith('[share-view] user 7: asking for a smaller copy (medium)'))).toBe(true);
        expect(lines().some(l => l.startsWith('[share-view] user 7: back to the full picture (high)'))).toBe(true);
        await m.disconnect();
    });

    it('gives the full picture back when the step\'s history is lost (a read with no receiver)', async () => {
        // The history goes with a share no longer seen; the smaller copy it
        // asked for must not outlive it with nothing left to undo it.
        const { m, pub, receiver } = watching([0, 1, 2]);
        receiver.lossPct = 3;
        await readsUntil(() => pub.asked.at(-1) === VideoQuality.MEDIUM, 20);
        receiver.lossPct = 0;
        const track = pub.track;
        (pub as { track: unknown }).track = undefined;
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        (pub as { track: unknown }).track = track;
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        expect(pub.asked.at(-1)).toBe(VideoQuality.HIGH);
        await m.disconnect();
    });

    it('leaves a share being remote-controlled alone: its jitter buffer is held at zero on purpose', async () => {
        const { m, pub, receiver } = watching([0, 1, 2]);
        setScreenLatencyMinimised(7, true);
        try {
            receiver.lossPct = 3;
            await vi.advanceTimersByTimeAsync(SETTLE_MS + VIEW_SAMPLE_MS * 10);
            expect(new Set(pub.asked), 'only ever the full picture while controlled').toEqual(new Set([VideoQuality.HIGH]));
        } finally {
            setScreenLatencyMinimised(7, false);
        }
        // POSITIVE CONTROL: control over, the same loss steps it down.
        const down = await readsUntil(() => pub.asked.at(-1) === VideoQuality.MEDIUM, 20);
        expect(down).toBeLessThan(Infinity);
        await m.disconnect();
    });

    it('never asks for less of a share sent at one size', async () => {
        const { m, pub, receiver } = watching([2]);
        receiver.lossPct = 10;
        await vi.advanceTimersByTimeAsync(SETTLE_MS + VIEW_SAMPLE_MS * 20);
        expect(new Set(pub.asked), 'only ever the full picture').toEqual(new Set([VideoQuality.HIGH]));
        await m.disconnect();
    });

    it('stops reading when nothing is watched, and when the call ends', async () => {
        const { m, receiver } = watching([0, 1, 2]);
        const reads = () => receiver.recv;
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS * 2);
        expect(reads(), 'POSITIVE CONTROL: it reads while watching').toBeGreaterThan(0);
        m.setWatchedVideo([]);
        const before = reads();
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS * 5);
        expect(reads()).toBe(before);
        m.setWatchedVideo([7]);
        await m.disconnect();
        expect(vi.getTimerCount(), 'leaving leaves nothing polling').toBe(0);
    });

    it('logs the size a watched share arrives at, and a change once it has settled', async () => {
        const { m, receiver } = watching([0, 1, 2]);
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        receiver.size = { w: 1280, h: 720 };
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        await rtcEventLogSettled();
        expect(lines().filter(l => l.includes('receiving 1280x720')), 'one read is not a size yet').toEqual([]);
        await vi.advanceTimersByTimeAsync(VIEW_SAMPLE_MS);
        await rtcEventLogSettled();
        expect(lines()).toContain('[share-view] user 7: receiving 1920x1080, asked high');
        expect(lines()).toContain('[share-view] user 7: receiving 1280x720 (was 1920x1080), asked high');
        await m.disconnect();
    });
});

describe('the sharer\'s own reading (shareEncodeSample)', () => {
    it('carries the frames of the rung most viewers get beside the limit, and a CPU limit on any rung', async () => {
        const m = new SfuManager();
        const rung = (rid: string, h: number, fps: number, limit = 'none') => [`o-${rid}`, {
            id: `o-${rid}`, type: 'outbound-rtp', kind: 'video', rid, mediaSourceId: 'src', framesPerSecond: fps, framesEncoded: 5000,
            bytesSent: 9e7, frameWidth: Math.round(h * 16 / 9), frameHeight: h, ssrc: h, qualityLimitationReason: limit,
            encoderImplementation: 'SimulcastEncoderAdapter (H.264 Encoder MFT)',
        }] as const;
        let rows = [rung('q', 360, 30), rung('h', 720, 28), rung('f', 1080, 26)];
        const sender = {
            getStats: async () => new Map<string, unknown>([...rows, ['src', { id: 'src', type: 'media-source', kind: 'video', framesPerSecond: 30 }]]),
            getParameters: () => ({ encodings: [{ rid: 'q', maxFramerate: 30 }, { rid: 'h', maxFramerate: 60 }, { rid: 'f', maxFramerate: 60 }] }),
        };
        const pub = { source: Track.Source.ScreenShare, kind: Track.Kind.Video, track: { sender, mediaStreamTrack: { getSettings: () => ({ frameRate: 60 }) } } };
        (m as unknown as { room: unknown }).room = { localParticipant: { getTrackPublications: () => [pub] } };
        expect(await m.shareEncodeSample()).toMatchObject({
            limit: 'none', setFps: 60, captureFps: 30, sent: { fps: 26, maxFps: 60, height: 1080, frames: 5000, bytes: 9e7 },
        });
        rows = [rung('q', 360, 30, 'cpu'), rung('h', 720, 28), rung('f', 1080, 26)];
        expect(await m.shareEncodeSample(), 'any rung CPU-limited counts').toMatchObject({ limit: 'cpu', sent: { height: 1080 } });
    });
});

/** What wireRoomEvents leaves in puca.log for the room's own events. */
describe('the room\'s moments, in puca.log', () => {
    class FakeRoom {
        handlers = new Map<string, Array<(...a: unknown[]) => void>>();
        localParticipant = { identity: 'u5#me', on() { return this; } };
        remoteParticipants = new Map();
        on(ev: string, fn: (...a: unknown[]) => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this; }
        emit(ev: string, ...a: unknown[]) { for (const fn of this.handlers.get(ev) ?? []) fn(...a); }
        removeAllListeners() { this.handlers.clear(); return this; }
        async disconnect() { /* fake */ }
    }
    const wired = () => {
        const m = new SfuManager();
        const room = new FakeRoom();
        (m as unknown as { room: unknown }).room = room;
        (m as unknown as { wireRoomEvents(r: unknown): void }).wireRoomEvents(room);
        return { m, room };
    };

    it('names LiveKit\'s decrypt-failure reasons as its enum really has them, by number and by name', () => {
        // rtcEventLog.ts maps them without importing LiveKit; an upgrade that
        // renumbered or renamed CryptorErrorReason must fail here, not
        // mislabel the log.
        expect(CRYPTOR_REASONS[CryptorErrorReason.InvalidKey]).toBe('invalid-key');
        expect(CRYPTOR_REASONS[CryptorErrorReason.MissingKey]).toBe('missing-key');
        expect(CRYPTOR_REASONS[CryptorErrorReason.InternalError]).toBe('internal');
        for (const name of Object.keys(CryptorErrorReason).filter(k => Number.isNaN(Number(k)))) {
            const line = encryptionErrorLine(new Error(`${name}: frame`), 1);
            expect(line, name).toBe(`[sfu-e2ee] user 1's media failed to decrypt: ${CRYPTOR_REASONS[CryptorErrorReason[name as keyof typeof CryptorErrorReason]]} (frame)`);
        }
        expect(identityFree('u12#Zz-9_q and u3#a')).toBe('u12 and u3');
        expect(encryptionErrorLine(new Error('boom'), null)).toBe('[sfu-e2ee] media failed to decrypt: unknown (boom)');
        expect(encryptionErrorLine(new Error('undefined: no reason'), null), 'a name LiveKit did not give').toBe('[sfu-e2ee] media failed to decrypt: unknown (undefined: no reason)');
    });

    it('an encryption error AS THE ROOM EMITS IT: a plain Error from the frame worker, its reason in the message', async () => {
        // livekit-client's worker cannot post a CryptorError to the page, so it
        // posts new Error(`${CryptorErrorReason[reason]}: ${message}`)
        // (e2ee.worker.ts setupCryptorErrorEvents) and the room emits that.
        const { room } = wired();
        const fromWorker = new Error('MissingKey: missing key at index 3 for participant u1#k3yX-9');
        expect((fromWorker as { reason?: unknown }).reason, 'fixture: no reason field, as in the app').toBeUndefined();
        room.emit(RoomEvent.EncryptionError, fromWorker, { identity: 'u1#k3yX-9' });
        // ...and one raised on the page, which does carry the number.
        room.emit(RoomEvent.EncryptionError,
            new CryptorError('Decryption failed: OperationError', CryptorErrorReason.InvalidKey, 'u1#k3yX-9'), { identity: 'u1#k3yX-9' });
        await rtcEventLogSettled();
        expect(lines()).toEqual([
            "[sfu-e2ee] user 1's media failed to decrypt: missing-key (missing key at index 3 for participant u1)",
            "[sfu-e2ee] user 1's media failed to decrypt: invalid-key (Decryption failed: OperationError)",
        ]);
        expect(lines().join(' '), 'the identity suffix never reaches the log').not.toContain('k3yX');
    });

    it('the server pausing and resuming a watched share, and not a camera', async () => {
        const { room } = wired();
        const participant = { identity: 'u7#abc' };
        room.emit(RoomEvent.TrackStreamStateChanged, { source: Track.Source.ScreenShare }, Track.StreamState.Paused, participant);
        room.emit(RoomEvent.TrackStreamStateChanged, { source: Track.Source.ScreenShare }, Track.StreamState.Active, participant);
        room.emit(RoomEvent.TrackStreamStateChanged, { source: Track.Source.Camera }, Track.StreamState.Paused, participant);
        await rtcEventLogSettled();
        expect(lines()).toEqual([
            '[share-view] user 7: the server paused the share for this viewer (usually: the connection cannot carry even its smallest copy)',
            '[share-view] user 7: the server resumed the share for this viewer',
        ]);
    });

    it('a reconnect and how long it took, and a disconnect with its reason', async () => {
        const { room } = wired();
        room.emit(RoomEvent.Reconnecting);
        vi.advanceTimersByTime(2300);
        room.emit(RoomEvent.Reconnected);
        room.emit(RoomEvent.SignalReconnecting);
        room.emit(RoomEvent.Disconnected, DisconnectReason.JOIN_FAILURE);
        await rtcEventLogSettled();
        expect(lines()).toEqual([
            '[sfu] connection lost, reconnecting',
            '[sfu] reconnected after 2300 ms',
            '[sfu] signalling connection lost, reconnecting (media still flowing)',
            '[sfu] disconnected (JOIN_FAILURE)',
        ]);
    });
});
