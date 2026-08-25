import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaManager } from '../api/rtc/media';

/**
 * A user with no microphone must still be able to JOIN voice (listen-only) —
 * they used to be refused outright. A permission REFUSAL must keep throwing,
 * because that is the only path that shows the microphone-permission help.
 */

function domError(name: string): DOMException {
    // Node has DOMException; fall back to a plain named error if not.
    try { return new DOMException('test', name); }
    catch { const e = new Error('test'); e.name = name; return e as unknown as DOMException; }
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
    getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    // jsdom lacks MediaStream; a minimal stand-in is enough for these paths.
    if (typeof globalThis.MediaStream === 'undefined') {
        vi.stubGlobal('MediaStream', class {
            _tracks: unknown[] = [];
            getTracks() { return this._tracks; }
            getAudioTracks() { return []; }
            getVideoTracks() { return []; }
            addTrack() { /* no-op */ }
            removeTrack() { /* no-op */ }
        });
    }
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('listen-only voice join', () => {
    it.each([
        ['NotFoundError'],        // no capture device at all
        ['DevicesNotFoundError'],
        ['NotReadableError'],     // device held by another app
        ['TrackStartError'],
        ['AbortError'],           // Firefox: device busy
    ])('joins listen-only when the mic fails with %s', async (name) => {
        getUserMedia.mockRejectedValue(domError(name));
        const media = new MediaManager();

        const stream = await media.getLocalStream(true, false);

        expect(stream).toBeTruthy();
        expect(stream.getAudioTracks()).toHaveLength(0);
        expect(media.isListenOnly()).toBe(true);
    });

    it.each([
        ['NotAllowedError'],
        ['PermissionDeniedError'],
        ['SecurityError'],
    ])('still THROWS on %s so the permission help can be shown', async (name) => {
        getUserMedia.mockRejectedValue(domError(name));
        const media = new MediaManager();

        await expect(media.getLocalStream(true, false)).rejects.toThrow();
        expect(media.isListenOnly()).toBe(false);
    });

    it('is not listen-only when the mic opens normally', async () => {
        const track = { kind: 'audio', enabled: true, stop() { /* no-op */ } };
        getUserMedia.mockResolvedValue({
            getTracks: () => [track],
            getAudioTracks: () => [track],
            getVideoTracks: () => [],
            addTrack() { /* no-op */ },
            removeTrack() { /* no-op */ },
        });
        const media = new MediaManager();

        await media.getLocalStream(true, false);

        expect(media.isListenOnly()).toBe(false);
    });

    it('clears listen-only on teardown so a rejoin retries the mic', async () => {
        getUserMedia.mockRejectedValue(domError('NotFoundError'));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        expect(media.isListenOnly()).toBe(true);

        media.stopLocalStream();

        expect(media.isListenOnly()).toBe(false);
    });
});
