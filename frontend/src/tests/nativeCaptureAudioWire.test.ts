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
    constructor(_opts?: unknown) { StubAudioContext.last = this; StubAudioContext.stopped = 0; }
    createMediaStreamDestination() {
        return { channelCount: 2, stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
    }
    createBuffer(channels: number, frames: number, _rate: number) {
        return { duration: frames / 48000, getChannelData: () => new Float32Array(frames * channels) };
    }
    static stopped = 0;
    createBufferSource() { return { buffer: null, onended: null as null | (() => void), connect: () => {}, start: () => {}, stop: () => { StubAudioContext.stopped++; } }; }
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

/** One 10 ms stereo f32 packet of silence, as clip_desktop_audio.rs emits it. */
function packet(generation: number) {
    const pcm = new Float32Array(480 * 2);
    return { data: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))), sample_rate: 48000, channels: 2, bits_per_sample: 32, silent: false, generation };
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
     *  worker subtracts, and it belongs to a SEGMENT, not a packet: between
     *  two primes every packet is scheduled where the last one ended, so
     *  each one's render-minus-capture time is the same. Reported: a segment
     *  start (JITTER_S at a prime, with the render time it governs from),
     *  then only growth of 5 ms or more; a fresh segment after an underrun
     *  and after the drift reset (never past MAX_BACKLOG_S). */
    test('reports the scheduling lead per segment, with the render time it governs from', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 9 });
        const leads: { renderAt: number; leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs, newSegment) => leads.push({ renderAt, leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        const now = () => performance.timeOrigin + performance.now();
        ctx.currentTime = 0;
        fire('clip-audio-data', packet(9)); // primes at now + 50 ms: a segment from now
        fire('clip-audio-data', packet(9)); // appended: 60 ms ahead of a clock that did not move: growth
        expect(leads.map(l => [Math.round(l.leadMs), l.newSegment])).toEqual([[50, true], [60, false]]);
        expect(Math.abs(leads[0].renderAt - now())).toBeLessThan(500);         // the first segment starts now
        expect(Math.abs(leads[1].renderAt - 60 - now())).toBeLessThan(500);    // growth: the packet's render time
        ctx.currentTime = 1;               // the clock jumped past the playhead (0.07 s): an underrun
        fire('clip-audio-data', packet(9)); // re-primed at now + 50 ms
        expect(leads[2].newSegment).toBe(true);
        expect(Math.round(leads[2].leadMs)).toBe(50);
        // The new segment governs from where the old content ENDED (0.07 s,
        // 930 ms before this clock), which is where the underrun's silence began.
        expect(Math.abs(leads[2].renderAt - (now() - 930))).toBeLessThan(500);
        expect(leads[2].renderAt).toBeLessThan(now() - 400);
        expect(StubAudioContext.stopped, 'an underrun re-prime stops nothing (nothing is pending)').toBe(0);
        // The drift reset: 60 more packets on a still clock push the playhead
        // 600 ms ahead; past MAX_BACKLOG_S (500) it re-primes at 50.
        for (let i = 0; i < 60; i++) fire('clip-audio-data', packet(9));
        const drift = leads.slice(3);
        const grown = drift.filter(l => !l.newSegment).map(l => Math.round(l.leadMs));
        expect(Math.max(...grown)).toBeLessThanOrEqual(500);
        expect(Math.max(...grown)).toBeGreaterThanOrEqual(490); // it really climbed to the cap before resetting
        const reset = drift.find(l => l.newSegment)!;
        expect(Math.round(reset.leadMs)).toBe(50);
        expect(Math.abs(reset.renderAt - now()), 'a reset cuts the backlog off NOW').toBeLessThan(500);
        // The reset DROPPED the backlog: every source still scheduled ahead was
        // stopped, not left to play over the re-primed packets.
        expect(StubAudioContext.stopped).toBeGreaterThanOrEqual(40);
        await h.stop();
    });

    /** THE FIELD CASE (2026-09-24, a "decimated" clip): packets arriving
     *  unevenly — bunched behind a busy main thread, and read against a
     *  currentTime that moves in steps — make `playhead - now` swing by tens
     *  of ms from packet to packet while nothing about the segment changed.
     *  Reported per packet, every swing became a different shift for each
     *  audio frame of the clip and a ramp of the mic delay. Only growth of
     *  5 ms or more may be reported, and never a fall within a segment. */
    test('uneven delivery does not become a report per packet', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 11 });
        const leads: { leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (_r, leadMs, newSegment) => leads.push({ leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        // 400 packets (4 s): delivered in bunches of 1-4 behind stalls, the
        // clock read in 10 ms steps, never falling behind the playhead.
        let t = 0, sent = 0, k = 0;
        const bunch = [1, 3, 2, 4, 1, 2];
        while (sent < 400) {
            const n = bunch[k++ % bunch.length];
            ctx.currentTime = Math.floor((sent * 0.01 + 0.004 * (k % 5)) / 0.01) * 0.01;
            for (let i = 0; i < n && sent < 400; i++, sent++) fire('clip-audio-data', packet(11));
            t = ctx.currentTime;
        }
        expect(t).toBeGreaterThan(3.9);
        expect(leads.length, `reports: ${leads.map(l => Math.round(l.leadMs)).join(', ')}`).toBeLessThanOrEqual(6);
        expect(leads[0].newSegment).toBe(true);
        expect(leads.filter(l => l.newSegment).length, 'no underrun, so one segment').toBe(1);
        for (let i = 1; i < leads.length; i++) expect(leads[i].leadMs - leads[i - 1].leadMs).toBeGreaterThanOrEqual(5);
        await h.stop();
    });
});
