/**
 * THE NATIVE CLIP-AUDIO WIRE — the invoke contract between nativeCapture.ts
 * and clip_desktop_audio.rs, pinned the way session_status's is
 * (secureDesktopStatus.test.ts): the two ends are separate languages with no
 * shared types, and a renamed key does not fail loudly — Rust reads `None`,
 * captures the default output, and a headset user records silence with no
 * error anywhere.
 *
 * Also pinned: the OWNERSHIP rules the review demanded —
 *  - stop carries the generation the start granted (a stop without ownership
 *    is how a losing starter once killed the winner's capture);
 *  - a FAILED start invokes no stop at all (the singleton belongs to someone
 *    else, or reclaims itself Rust-side on the timeout path);
 *  - events from a foreign generation are ignored, including the stale death
 *    that lands after a successful retry.
 *
 * jsdom has no AudioContext; a minimal stub stands in — this file tests the
 * WIRE, not the audio graph.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (name: string, cb: Listener) => {
        const list = listeners.get(name) ?? [];
        list.push(cb);
        listeners.set(name, list);
        return () => { listeners.set(name, (listeners.get(name) ?? []).filter(l => l !== cb)); };
    },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true }));

function fire(name: string, payload: unknown) {
    for (const l of listeners.get(name) ?? []) l({ payload });
}

class StubAudioContext {
    state = 'running';
    currentTime = 0;
    constructor(_opts?: unknown) {}
    createMediaStreamDestination() {
        return { channelCount: 2, stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
    }
    createBuffer(channels: number, frames: number, _rate: number) {
        return { duration: frames / 48000, getChannelData: () => new Float32Array(frames * channels) };
    }
    createBufferSource() { return { buffer: null, connect: () => {}, start: () => {} }; }
    async resume() {}
    async close() {}
}

beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
    (window as unknown as Record<string, unknown>).AudioContext = StubAudioContext;
});

async function subject() {
    return await import('../api/clips/nativeCapture');
}

describe('the clip-audio invoke wire', () => {
    test('start sends EXACTLY the args the Rust command reads, and parses the reply', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Arctis 7', generation: 3 });
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, 'Arctis 7');
        // `deviceName` (camelCase) is what Tauri maps onto Rust's
        // `device_name` — rename either side and the preference silently
        // becomes "default output".
        expect(invokeMock).toHaveBeenCalledWith('start_clip_desktop_audio', { deviceName: 'Arctis 7' });
        expect(h.deviceName).toBe('Arctis 7');
        await h.stop();
        // stop names the generation start granted; unconditional stops are
        // reserved for owners that lost their number.
        expect(invokeMock).toHaveBeenCalledWith('stop_clip_desktop_audio', { generation: 3 });
    });

    test('a FAILED start invokes no stop — the singleton is not ours to kill', async () => {
        invokeMock.mockRejectedValue(new Error('Already capturing desktop audio'));
        const { startNativeSystemAudioTrack } = await subject();
        await expect(startNativeSystemAudioTrack(undefined, null)).rejects.toThrow('Already capturing');
        const stops = invokeMock.mock.calls.filter(c => c[0] === 'stop_clip_desktop_audio');
        expect(stops, 'the losing starter must never stop the winner').toEqual([]);
    });

    test('a stale death from a foreign generation does not reach onError; our own does', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 5 });
        const errors: string[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(m => errors.push(m), null);

        // The predecessor's death arriving after our successful start — the
        // exact ordering the Rust side produces (claim cleared before emit).
        fire('clip-audio-capture-error', { message: 'device invalidated', generation: 4 });
        expect(errors, 'a foreign death must not flip a healthy capture').toEqual([]);

        // POSITIVE CONTROL: our own generation's death gets through.
        fire('clip-audio-capture-error', { message: 'device invalidated', generation: 5 });
        expect(errors).toEqual(['device invalidated']);
        await h.stop();
    });
});
