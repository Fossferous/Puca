/**
 * THE NATIVE CLIP-VIDEO WIRE — the invoke contract between nativeCapture.ts
 * and clip_capture.rs, pinned the way the audio wire is
 * (nativeCaptureAudioWire.test.ts): two languages, no shared types.
 *
 * Also pinned, the OWNERSHIP rules the audio side already has:
 *  - stop carries the generation the start granted;
 *  - chunks from a foreign generation never reach the ring (the predecessor's
 *    tail after "Restart buffer" carries the OLD capture's clock, and one
 *    such chunk taken as a clock sample put every later clip's audio late by
 *    the old session's length);
 *  - a foreign capture's death does not reach onError; our own does.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
// The chunks arrive on a Channel (raw binary, chunkWire.ts): the fake keeps
// the Channel it is handed so a test can deliver frames on it.
class FakeChannel<T> { onmessage: (m: T) => void = () => { }; }
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
    Channel: FakeChannel,
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

const target = { output_index: 0, width: 2560, height: 1440, reason: 'primary', bitrate: 8_000_000, generation: 3 };
/** A delta frame on the wire (clip_capture.rs chunk_frame). */
const chunk = (generation: number, tsUs: number): ArrayBuffer => {
    const payload = [0, 0, 0, 1, 0x65];
    const b = new ArrayBuffer(35 + payload.length);
    const v = new DataView(b);
    v.setUint8(0, 1); v.setUint8(1, 0);
    v.setBigUint64(2, BigInt(generation), true); v.setBigUint64(10, BigInt(tsUs), true); v.setBigUint64(18, 33_333n, true);
    v.setUint32(26, 2560, true); v.setUint32(30, 1440, true); v.setUint8(34, 0);
    new Uint8Array(b, 35).set(payload);
    return b;
};
const channelOf = () => {
    const start = invokeMock.mock.calls.find(c => c[0] === 'start_clip_video_capture');
    return (start?.[1] as { onChunk: FakeChannel<ArrayBuffer> }).onChunk;
};

beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
});

describe('the clip-video invoke wire', () => {
    test('start sends EXACTLY the args the Rust command reads; stop names the generation start granted', async () => {
        invokeMock.mockResolvedValue(target);
        const { startNativeVideo } = await import('../api/clips/nativeCapture');
        const h = await startNativeVideo({ fps: 30, bitrate: 8_000_000, assumedPixels: 2560 * 1440, gopMs: 2000 }, () => { });
        expect(invokeMock).toHaveBeenCalledWith('start_clip_video_capture', { fps: 30, bitrate: 8_000_000, assumedPixels: 2560 * 1440, gopMs: 2000, onChunk: expect.any(FakeChannel) });
        await h.stop();
        expect(invokeMock).toHaveBeenCalledWith('stop_clip_video_capture', { generation: 3 });
    });

    test('a predecessor\'s tail chunk never reaches the ring; our own chunks do', async () => {
        invokeMock.mockResolvedValue(target);
        const got: number[] = [];
        const { startNativeVideo } = await import('../api/clips/nativeCapture');
        const h = await startNativeVideo({ fps: 30, bitrate: 8_000_000, assumedPixels: 2560 * 1440, gopMs: 2000 }, c => got.push(c.tsUs));
        // The old capture's last frames, ten minutes into ITS clock, landing
        // after our start resolved.
        channelOf().onmessage(chunk(2, 600_000_000));
        channelOf().onmessage(chunk(2, 600_033_333));
        expect(got, 'a foreign chunk would skew the ring\'s clock anchor').toEqual([]);
        // POSITIVE CONTROL: ours get through.
        channelOf().onmessage(chunk(3, 41_000));
        expect(got).toEqual([41_000]);
        await h.stop();
        // A late frame after stop is dropped.
        channelOf().onmessage(chunk(3, 74_333));
        expect(got).toEqual([41_000]);
    });

    test('a stale death from a foreign generation does not reach onError; our own does', async () => {
        invokeMock.mockResolvedValue(target);
        const errors: string[] = [];
        const { startNativeVideo } = await import('../api/clips/nativeCapture');
        const h = await startNativeVideo({ fps: 30, bitrate: 8_000_000, assumedPixels: 2560 * 1440, gopMs: 2000 }, () => { }, m => errors.push(m));
        fire('clip-video-capture-error', { message: 'DXGI_ERROR_ACCESS_LOST', generation: 2 });
        expect(errors, 'a foreign death must not disarm a healthy capture').toEqual([]);
        fire('clip-video-capture-error', { message: 'DXGI_ERROR_ACCESS_LOST', generation: 3 });
        expect(errors).toEqual(['DXGI_ERROR_ACCESS_LOST']);
        await h.stop();
    });

    test('a FAILED start invokes no stop', async () => {
        invokeMock.mockRejectedValue(new Error('Already capturing video'));
        const { startNativeVideo } = await import('../api/clips/nativeCapture');
        await expect(startNativeVideo({ fps: 30, bitrate: 8_000_000, assumedPixels: 1, gopMs: 2000 }, () => { })).rejects.toThrow('Already capturing');
        expect(invokeMock.mock.calls.filter(c => c[0] === 'stop_clip_video_capture')).toEqual([]);
    });
});
