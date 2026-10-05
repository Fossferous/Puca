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
 *  - messages and deaths from a foreign generation are ignored, including
 *    the stale death that lands after a successful retry.
 *
 * And the AUDIO WIRE itself (clip_audio_wire.rs -> audioWire.ts): the PCM
 * arrives on the Channel the start hands over, ~100 ms a message, planar, a
 * silent run as a header and its packet table. The lead is still measured
 * per WASAPI packet: every message lists its packets (frames, and how long
 * before the send each was read), and the page takes each one's lead as the
 * one-packet wire would have, under the same reporting rule; silence
 * advances the timeline exactly, builds nothing, and opens a segment exactly
 * as sound would. (The tests below use 40 ms messages: the size does not
 * matter to the page, only the table.) Render times are checked to the ms
 * against a frozen performance.now.
 *
 * jsdom has no AudioContext; a minimal stub stands in — this file tests the
 * WIRE, not the audio graph.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const invokeMock = vi.fn();
type Listener = (e: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
// The PCM arrives on a Channel (raw binary, audioWire.ts): the fake keeps the
// Channel it is handed so a test can deliver messages on it.
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

class StubAudioContext {
    static last: StubAudioContext | null = null;
    state = 'running';
    currentTime = 0;
    /** Every buffer built, with what was copied into each channel. */
    buffers: { channels: number; frames: number; rate: number; planes: number[][] }[] = [];
    /** Every source's start(when). */
    starts: number[] = [];
    constructor(_opts?: unknown) { StubAudioContext.last = this; StubAudioContext.stopped = 0; }
    createMediaStreamDestination() {
        return { channelCount: 2, stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
    }
    createBuffer(channels: number, frames: number, rate: number) {
        const b = { channels, frames, rate, planes: [] as number[][] };
        this.buffers.push(b);
        return { duration: frames / rate, copyToChannel: (src: Float32Array, ch: number) => { b.planes[ch] = [...src]; } };
    }
    static stopped = 0;
    createBufferSource() {
        const starts = this.starts;
        return { buffer: null, onended: null as null | (() => void), connect: () => {}, start: (when: number) => { starts.push(when); }, stop: () => { StubAudioContext.stopped++; } };
    }
    async resume() {}
    async close() {}
}

beforeEach(() => {
    invokeMock.mockReset();
    listeners.clear();
    (window as unknown as Record<string, unknown>).AudioContext = StubAudioContext;
});
afterEach(() => { vi.restoreAllMocks(); });

/** Freeze performance.now at `ms` (and move it with `set`), so a render time
 *  the page reports (epoch ms) can be checked to the millisecond. */
function freezeClock(ms: number) {
    let t = ms;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    return { epoch: () => performance.timeOrigin + t, set: (v: number) => { t = v; } };
}

async function subject() {
    return await import('../api/clips/nativeCapture');
}

/** A message as clip_audio_wire.rs audio_frame builds one: a header, the
 *  packet table (each packet's frames and how long before the send it was
 *  read), then the samples planar, or none for a silent run. */
type Pkt = { frames: number; ageUs: number };
function message(o: { generation: number; rate?: number; channels?: number; packets?: Pkt[]; silent?: boolean; sample?: (ch: number, i: number) => number }): ArrayBuffer {
    const { generation, rate = 48000, channels = 2, packets = [{ frames: 480, ageUs: 0 }], silent = false } = o;
    const frames = packets.reduce((n, p) => n + p.frames, 0);
    const at = 24 + 8 * packets.length;
    const b = new ArrayBuffer(at + (silent ? 0 : channels * frames * 4));
    const v = new DataView(b);
    v.setUint8(0, 1); v.setUint8(1, silent ? 1 : 0);
    v.setBigUint64(2, BigInt(generation), true);
    v.setUint32(10, rate, true); v.setUint16(14, channels, true);
    v.setUint32(16, frames, true); v.setUint32(20, packets.length, true);
    packets.forEach((p, k) => { v.setUint32(24 + 8 * k, p.frames, true); v.setUint32(28 + 8 * k, p.ageUs, true); });
    if (!silent && o.sample) for (let ch = 0; ch < channels; ch++) for (let i = 0; i < frames; i++) v.setFloat32(at + (ch * frames + i) * 4, o.sample(ch, i), true);
    return b;
}
/** Four `size`-frame packets read `stepUs` apart, sent `lastAgeUs` after the
 *  last was read: what AudioBatcher sends for evenly read packets. */
const even = (size: number, lastAgeUs = 0, stepUs = 10_000): Pkt[] => [0, 1, 2, 3].map(k => ({ frames: size, ageUs: lastAgeUs + (3 - k) * stepUs }));
/** One 10 ms stereo packet sent on its own: what the one-packet wire carried. */
const packet = (generation: number) => message({ generation });
/** A 40 ms batch of four 10 ms packets read 10 ms apart, sent `ageUs` after
 *  the last was read. */
const batch = (generation: number, ageUs = 0) => message({ generation, packets: even(480, ageUs) });

/** The Channel the start handed the shell. */
const channelOf = () => {
    const start = invokeMock.mock.calls.find(c => c[0] === 'start_clip_desktop_audio');
    return (start?.[1] as { onAudio: FakeChannel<ArrayBuffer> }).onAudio;
};
const deliver = (m: ArrayBuffer) => channelOf().onmessage(m);

describe('the clip-audio invoke wire', () => {
    test('start sends EXACTLY the args the Rust command reads, and parses the reply', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Arctis 7', generation: 3 });
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, 'Arctis 7');
        // `deviceName` (camelCase) is what Tauri maps onto Rust's
        // `device_name` — rename either side and the preference silently
        // becomes "default output". `onAudio` is `on_audio`, the channel the
        // PCM comes back on: misnamed, the command is refused outright.
        expect(invokeMock).toHaveBeenCalledWith('start_clip_desktop_audio', { deviceName: 'Arctis 7', onAudio: expect.any(FakeChannel) });
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
        const now = freezeClock(10_000).epoch;
        ctx.currentTime = 0;
        deliver(packet(9)); // primes at now + 50 ms: a segment from now
        deliver(packet(9)); // appended: 60 ms ahead of a clock that did not move: growth
        expect(leads.map(l => [Math.round(l.leadMs), l.newSegment])).toEqual([[50, true], [60, false]]);
        expect(Math.abs(leads[0].renderAt - now())).toBeLessThan(1);         // the first segment starts now
        expect(Math.abs(leads[1].renderAt - 60 - now())).toBeLessThan(1);    // growth: the packet's render time
        ctx.currentTime = 1;               // the clock jumped past the playhead (0.07 s): an underrun
        deliver(packet(9)); // re-primed at now + 50 ms
        expect(leads[2].newSegment).toBe(true);
        expect(Math.round(leads[2].leadMs)).toBe(50);
        // The new segment governs from where the old content ENDED (0.07 s,
        // 930 ms before this clock), which is where the underrun's silence began.
        expect(Math.abs(leads[2].renderAt - (now() - 930))).toBeLessThan(1);
        expect(StubAudioContext.stopped, 'an underrun re-prime stops nothing (nothing is pending)').toBe(0);
        // The drift reset: 60 more packets on a still clock push the playhead
        // 600 ms ahead; past MAX_BACKLOG_S (500) it re-primes at 50.
        for (let i = 0; i < 60; i++) deliver(packet(9));
        const drift = leads.slice(3);
        const grown = drift.filter(l => !l.newSegment).map(l => Math.round(l.leadMs));
        expect(Math.max(...grown)).toBeLessThanOrEqual(500);
        expect(Math.max(...grown)).toBeGreaterThanOrEqual(490); // it really climbed to the cap before resetting
        const reset = drift.find(l => l.newSegment)!;
        expect(Math.round(reset.leadMs)).toBe(50);
        expect(Math.abs(reset.renderAt - now()), 'a reset cuts the backlog off NOW').toBeLessThan(1);
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
            for (let i = 0; i < n && sent < 400; i++, sent++) deliver(packet(11));
            t = ctx.currentTime;
        }
        expect(t).toBeGreaterThan(3.9);
        expect(leads.length, `reports: ${leads.map(l => Math.round(l.leadMs)).join(', ')}`).toBeLessThanOrEqual(6);
        expect(leads[0].newSegment).toBe(true);
        expect(leads.filter(l => l.newSegment).length, 'no underrun, so one segment').toBe(1);
        for (let i = 1; i < leads.length; i++) expect(leads[i].leadMs - leads[i - 1].leadMs).toBeGreaterThanOrEqual(5);
        await h.stop();
    });

    /** The shell holds a batch's first three packets until the fourth is
     *  read, and the message says how long it held each. The lead must be
     *  what each packet would have reported had it been sent alone the
     *  moment it was read — the measure NATIVE_AUDIO_OFFSET_US is calibrated
     *  against — so a batch that primes reports JITTER_S plus the 30 ms it
     *  held its first packet, plus however long it waited after its last.
     *  Read as `playhead - now` alone (the per-packet formula) it would say
     *  50 and hide 30 ms of real latency from the clip worker and the mic
     *  delay. */
    test('a batch reports the lead its packets would have on the one-packet wire', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 4 });
        const leads: { renderAt: number; leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs, newSegment) => leads.push({ renderAt, leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        const now = freezeClock(20_000).epoch;
        ctx.currentTime = 0;
        deliver(batch(4));
        expect(leads.map(l => [Math.round(l.leadMs), l.newSegment])).toEqual([[80, true]]);
        expect(ctx.starts).toEqual([0.05]); // rendered from the prime: the batch's FIRST sample
        // The next batch on time (40 ms later) shows the same 80 ms: its
        // last packet renders as long after it was read. No report.
        ctx.currentTime = 0.04;
        deliver(batch(4));
        expect(leads).toHaveLength(1);
        // One arriving 10 ms EARLY shows 10 ms more lead in every packet:
        // growth, reported once, at the render time of the first packet that
        // showed it — as the one-packet wire would have. That render time is
        // the packet's own (60 ms ahead), not its lead (90).
        ctx.currentTime = 0.07;
        deliver(batch(4));
        expect(leads.map(l => Math.round(l.leadMs))).toEqual([80, 90]);
        expect(leads[1].newSegment).toBe(false);
        expect(Math.abs(leads[1].renderAt - (now() + (0.13 - 0.07) * 1000))).toBeLessThan(1);
        expect(ctx.starts.map(t => +t.toFixed(3))).toEqual([0.05, 0.09, 0.13]);
        await h.stop();

        // A message flushed by the timeout, 7 ms after its last packet was
        // read, would have arrived 7 ms sooner on the old wire: its lead is
        // that much bigger.
        leads.length = 0;
        invokeMock.mockReset();
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 5 });
        const h2 = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs, newSegment) => leads.push({ renderAt, leadMs, newSegment }));
        deliver(batch(5, 7000));
        expect(Math.round(leads[0].leadMs)).toBe(87);
        await h2.stop();
    });

    /** Equivalence with the one-packet wire inside a segment: the same audio
     *  as four 10 ms packets read 10 ms apart, or as one batch delivered
     *  when its fourth packet is read, schedules the same render timeline
     *  and reports the same lead. */
    test('a batch schedules and measures what its four packets did, one by one', async () => {
        const run = async (shape: 'packets' | 'batch') => {
            invokeMock.mockReset();
            invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 6 });
            const leads: number[] = [];
            const { startNativeSystemAudioTrack } = await subject();
            const h = await startNativeSystemAudioTrack(undefined, null, (_r, leadMs) => leads.push(Math.round(leadMs)));
            const ctx = StubAudioContext.last!;
            ctx.currentTime = 0; deliver(packet(6)); // the prime
            if (shape === 'packets') for (let k = 1; k <= 4; k++) { ctx.currentTime = k * 0.01; deliver(packet(6)); }
            else { ctx.currentTime = 0.04; deliver(batch(6)); }
            ctx.currentTime = 0.05; deliver(packet(6));
            const starts = ctx.starts.map(t => +t.toFixed(4));
            await h.stop();
            return { leads, first: starts[0], end: +(starts[starts.length - 1] + 0.01).toFixed(4) };
        };
        const a = await run('packets'), b = await run('batch');
        expect(b.leads).toEqual(a.leads);
        expect(a.leads).toEqual([50]);
        expect([b.first, b.end]).toEqual([a.first, a.end]);
    });

    /** Packets are not read evenly. On the one-packet wire the one read
     *  soonest after its capture showed the most lead, and the segment kept
     *  that. Here the second of four arrives 2 ms after the first instead of
     *  10 and shows 58 ms where the others show 50; the message's table
     *  carries every packet's age (clip_audio_wire.rs: reads at
     *  10/12/30/40 ms -> ages 30/28/10/0 ms),
     *  and the batch reports the same growth the packets did. Had the batch
     *  been measured on its LAST packet it would have said 50 and the growth
     *  — 8 ms of A/V error in the clip — would never have been reported. */
    test('a batch whose earlier packet showed more lead reports what that packet did', async () => {
        const run = async (shape: 'packets' | 'batch') => {
            invokeMock.mockReset();
            invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 12 });
            const leads: number[] = [];
            const { startNativeSystemAudioTrack } = await subject();
            const h = await startNativeSystemAudioTrack(undefined, null, (_r, leadMs) => leads.push(Math.round(leadMs)));
            const ctx = StubAudioContext.last!;
            ctx.currentTime = 0; deliver(packet(12)); // the prime
            if (shape === 'packets') for (const at of [0.010, 0.012, 0.030, 0.040]) { ctx.currentTime = at; deliver(packet(12)); }
            else { ctx.currentTime = 0.040; deliver(message({ generation: 12, packets: [{ frames: 480, ageUs: 30_000 }, { frames: 480, ageUs: 28_000 }, { frames: 480, ageUs: 10_000 }, { frames: 480, ageUs: 0 }] })); }
            await h.stop();
            return leads;
        };
        const a = await run('packets'), b = await run('batch');
        expect(a).toEqual([50, 58]);
        expect(b).toEqual(a);
    });

    /** A run of WASAPI-silent packets is a header: no AudioBuffer, no
     *  source, nothing copied — the playhead moves on by exactly the silence
     *  it counts, so the next sound lands where it would have had the zeros
     *  been sent and played. No re-prime, no new segment. */
    test('a silent run builds nothing and advances the timeline exactly', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 7 });
        const leads: { leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (_r, leadMs, newSegment) => leads.push({ leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        ctx.currentTime = 0;
        deliver(batch(7));                                                           // 0.05 .. 0.09
        ctx.currentTime = 0.04;
        deliver(message({ generation: 7, packets: even(480), silent: true }));       // 0.09 .. 0.13, nothing built
        ctx.currentTime = 0.08;
        deliver(message({ generation: 7, packets: [{ frames: 480, ageUs: 10_000 }, { frames: 480, ageUs: 0 }], silent: true })); // 0.13 .. 0.15
        ctx.currentTime = 0.09;
        deliver(batch(7));
        expect(ctx.buffers).toHaveLength(2);
        expect(ctx.starts.map(t => +t.toFixed(4))).toEqual([0.05, 0.15]);
        expect(leads.filter(l => l.newSegment), 'one segment: the silence kept the playhead ahead').toHaveLength(1);
        await h.stop();
    });

    /** The usual start: the buffer arms while nothing plays, so the first
     *  messages are silent runs (WASAPI flags them). The silence primes the
     *  segment exactly as sound would — it occupies the render timeline — and
     *  the sound after it is chained on, with no second segment: a segment
     *  start is what the worker reads every later lead against
     *  (replayBuffer.ts leadReporter), so a missing or extra one misplaces
     *  the clip's audio. */
    test('arming during silence: the silent run opens the segment and the sound is chained after it', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 13 });
        const leads: { renderAt: number; leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs, newSegment) => leads.push({ renderAt, leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        const clock = freezeClock(30_000);
        const at = (t: number) => { ctx.currentTime = t; clock.set(30_000 + t * 1000); };
        at(0);
        const primedAt = clock.epoch();
        deliver(message({ generation: 13, packets: even(480), silent: true }));       // primes: 0.05 .. 0.09, nothing built
        at(0.04);
        deliver(message({ generation: 13, packets: even(480), silent: true }));       // 0.09 .. 0.13
        at(0.08);
        deliver(batch(13));                                                           // 0.13 .. 0.17
        expect(ctx.buffers).toHaveLength(1);
        expect(ctx.starts.map(t => +t.toFixed(4))).toEqual([0.13]);
        // One report: the segment the silence opened, from the moment it
        // primed, with its first packet's lead (JITTER_S + 30 ms held).
        expect(leads.map(l => [Math.round(l.leadMs), l.newSegment])).toEqual([[80, true]]);
        expect(Math.abs(leads[0].renderAt - primedAt)).toBeLessThan(1);
        await h.stop();
    });

    /** An underrun whose first message is a silent run (the sound stopped,
     *  then Windows started flagging silence): the silence re-primes and
     *  opens the new segment where the old content ENDED (the underrun's
     *  silence began there), and the sound after it is chained on. */
    test('an underrun that resumes with silence re-primes on the silence', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 14 });
        const leads: { renderAt: number; leadMs: number; newSegment: boolean }[] = [];
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null, (renderAt, leadMs, newSegment) => leads.push({ renderAt, leadMs, newSegment }));
        const ctx = StubAudioContext.last!;
        const clock = freezeClock(40_000);
        const at = (t: number) => { ctx.currentTime = t; clock.set(40_000 + t * 1000); };
        at(0);
        deliver(batch(14));                                                           // 0.05 .. 0.09
        at(0.5);                                                                      // nothing for 410 ms: an underrun
        const underrunAt = clock.epoch();
        deliver(message({ generation: 14, packets: even(480), silent: true }));       // re-primes: 0.55 .. 0.59
        at(0.52);
        const soundAt = clock.epoch();
        deliver(batch(14));                                                           // 0.59 .. 0.63, 70 ms ahead
        expect(ctx.buffers).toHaveLength(2);
        expect(ctx.starts.map(t => +t.toFixed(4))).toEqual([0.05, 0.59]);
        expect(leads.map(l => [Math.round(l.leadMs), l.newSegment])).toEqual([[80, true], [80, true], [100, false]]);
        // The new segment governs from 0.09, 410 ms before the clock it was seen at...
        expect(Math.abs(leads[1].renderAt - (underrunAt - 410))).toBeLessThan(1);
        // ...and the sound that came early shows growth at its own render time.
        expect(Math.abs(leads[2].renderAt - (soundAt + 70))).toBeLessThan(1);
        await h.stop();
    });

    /** WASAPI autoconvert gives the shell 48 kHz stereo, but whatever a
     *  message says it is, it is played as: a 44.1 kHz 5.1 message builds a
     *  6-channel 44.1 kHz buffer with each plane copied whole, and moves the
     *  playhead by its own duration; 7.1 likewise. */
    test('any rate and channel count is built as it says, one copyToChannel per channel', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 8 });
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null);
        const ctx = StubAudioContext.last!;
        ctx.currentTime = 0;
        deliver(message({ generation: 8, rate: 44_100, channels: 6, packets: even(441), sample: (ch, i) => ch * 10_000 + i }));
        deliver(message({ generation: 8, rate: 48_000, channels: 8, packets: even(480), sample: (ch, i) => -(ch * 10_000 + i) }));
        expect(ctx.buffers.map(b => [b.channels, b.frames, b.rate])).toEqual([[6, 1764, 44_100], [8, 1920, 48_000]]);
        for (let ch = 0; ch < 6; ch++) {
            const p = ctx.buffers[0].planes[ch];
            expect([p.length, p[0], p[1763]]).toEqual([1764, ch * 10_000, ch * 10_000 + 1763]);
        }
        for (let ch = 0; ch < 8; ch++) expect(ctx.buffers[1].planes[ch][5]).toBe(-(ch * 10_000 + 5));
        // 1764 frames at 44.1 kHz is exactly 40 ms: the 7.1 message follows it.
        expect(ctx.starts.map(t => +t.toFixed(6))).toEqual([0.05, 0.09]);
        await h.stop();
    });

    test('a foreign generation, a malformed message and anything after stop are dropped', async () => {
        invokeMock.mockResolvedValue({ device_name: 'Speakers', generation: 10 });
        const { startNativeSystemAudioTrack } = await subject();
        const h = await startNativeSystemAudioTrack(undefined, null);
        const ctx = StubAudioContext.last!;
        const ch = channelOf();
        ch.onmessage(packet(9));                       // the predecessor's tail
        ch.onmessage(new ArrayBuffer(20));             // not a message
        ch.onmessage(packet(10).slice(0, 100));        // a truncated one
        expect(ctx.starts, 'nothing foreign or malformed was scheduled').toEqual([]);
        ch.onmessage(packet(10));                      // POSITIVE CONTROL: ours is
        expect(ctx.starts).toHaveLength(1);
        await h.stop();
        // The capture thread can outlive its stop by one wait; its last
        // messages must not feed a graph that is being torn down.
        ch.onmessage(packet(10));
        expect(ctx.starts).toHaveLength(1);
    });
});
