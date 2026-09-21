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
    static last: StubAudioContext | null = null;
    state = 'running';
    currentTime = 0;
    constructor(_opts?: unknown) { StubAudioContext.last = this; }
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

    /** The scheduling lead (playhead - currentTime) IS the A/V error the clip
     *  worker subtracts, so what is reported must be exactly what start()
     *  was given: JITTER_S at a prime, growing by each packet's duration
     *  while the context's clock stands still (the loopback device running
     *  ahead of it), back to JITTER_S after an underrun, and never past
     *  MAX_BACKLOG_S (the drift reset). */
    test('reports each packet\'s scheduling lead with the wall time it renders at', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 9 });
        const leads: { renderAt: number; leadMs: number }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs) => leads.push({ renderAt, leadMs }));
        const ctx = StubAudioContext.last!;
        const pcm = new Float32Array(480 * 2); // one 10 ms stereo packet
        const packet = () => ({ data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))), sample_rate: 48000, channels: 2, bits_per_sample: 32, silent: false, generation: 9 });
        ctx.currentTime = 0;
        fire('clip-audio-data', packet()); // primes at now + 50 ms
        fire('clip-audio-data', packet()); // appended: 60 ms ahead of a clock that did not move
        ctx.currentTime = 1;               // the clock jumped past the playhead: an underrun
        fire('clip-audio-data', packet()); // re-primed at now + 50 ms
        expect(leads.map(l => Math.round(l.leadMs))).toEqual([50, 60, 50]);
        // Epoch time, so a worker with its own time origin can look it up.
        const now = performance.timeOrigin + performance.now();
        for (const l of leads) expect(Math.abs(l.renderAt - l.leadMs - now)).toBeLessThan(500);
        // The drift reset: 60 more packets on a still clock push the playhead
        // 600 ms ahead; past MAX_BACKLOG_S (500) it re-primes at 50.
        for (let i = 0; i < 60; i++) fire('clip-audio-data', packet());
        const drift = leads.slice(3).map(l => Math.round(l.leadMs));
        expect(Math.max(...drift)).toBeLessThanOrEqual(500);
        expect(Math.max(...drift)).toBeGreaterThanOrEqual(490); // it really climbed to the cap before resetting
        expect(drift[drift.length - 1]).toBeLessThanOrEqual(250); // and came back down (50 + a few 10 ms packets)
        await h.stop();
    });
});
