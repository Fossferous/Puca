/**
 * The desktop stage's probe clock (api/devices/useLatencyProbe.ts): when it
 * asks, when an unanswered probe counts against the other end, and when it
 * backs off.
 *
 * The first version counted every unanswered probe and, at three, stopped for
 * the rest of the session saying the other computer's Púca was older — so
 * minimising the stage to the chat for six seconds, a hidden window, or a
 * capture that paused behind a security screen switched the measurement off
 * for good, with a wrong reason. A probe only counts against the other end
 * when pictures were arriving and its answer still did not come.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProbeResult } from '../api/devices/latencyProbe';

const h = vi.hoisted(() => ({
    sent: 0,
    inFlightSince: null as number | null,
    listeners: new Set<(r: ProbeResult) => void>(),
}));

// The session layer's side, with its one-probe-in-flight rule (a probe expires
// after PROBE_TIMEOUT_MS), so the hook sees what the real one would.
vi.mock('../api/devices/session', () => ({
    latencyProbeUsable: () => true,
    sendLatencyProbe: () => {
        const now = performance.now();
        if (h.inFlightSince !== null && now - h.inFlightSince < 2_000) return false;
        h.inFlightSince = now;
        h.sent++;
        return true;
    },
    noteFramePresented: () => { /* the matcher is latencyProbe.test.ts's */ },
    subscribeLatency: (_id: string, cb: (r: ProbeResult) => void) => {
        h.listeners.add(cb);
        return () => { h.listeners.delete(cb); };
    },
}));

const { useLatencyProbe } = await import('../api/devices/useLatencyProbe');

type FrameCb = (now: number, meta: { rtpTimestamp?: number; expectedDisplayTime?: number }) => void;

/** A <video> whose `requestVideoFrameCallback` is answered every 16 ms while
 *  pictures arrive, and left pending (as a browser does) while none do. */
function presentingVideo() {
    const el = document.createElement('video');
    const pending = new Map<number, FrameCb>();
    let next = 1;
    let rtp = 0;
    const state = { arriving: true };
    Object.assign(el, {
        requestVideoFrameCallback: (cb: FrameCb) => { pending.set(next, cb); return next++; },
        cancelVideoFrameCallback: (n: number) => { pending.delete(n); },
    });
    setInterval(() => {
        if (!state.arriving) return;
        const due = [...pending.values()];
        pending.clear();
        rtp += 3_000;
        for (const cb of due) cb(performance.now(), { rtpTimestamp: rtp, expectedDisplayTime: performance.now() });
    }, 16);
    return { el, state };
}

let readings: Array<ReturnType<typeof useLatencyProbe>['reading']> = [];
function Probe({ video, on }: { video: () => HTMLVideoElement | null; on: boolean }) {
    const { reading } = useLatencyProbe('ds-1', on, video);
    readings.push(reading);
    return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function render(video: () => HTMLVideoElement | null, on = true) {
    host ??= document.createElement('div');
    root ??= createRoot(host);
    await act(async () => { root!.render(<Probe video={video} on={on} />); });
}
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const latest = () => readings.at(-1) ?? null;
function answer(totalMs: number) {
    h.inFlightSince = null;
    for (const cb of [...h.listeners]) cb({ id: 1, totalMs, hostMs: 4, classic: false });
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    h.sent = 0;
    h.inFlightSince = null;
    h.listeners.clear();
    readings = [];
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host = null;
    vi.useRealTimers();
});

describe('the probe clock', () => {
    it('asks about once a second, and an answered probe makes a reading', async () => {
        const { el } = presentingVideo();
        await render(() => el);
        expect(h.sent, 'the first one at once').toBe(1);
        await advance(300);
        answer(42);
        await advance(1_000);
        expect(h.sent).toBe(2);
        expect(latest()?.totalMs).toBe(42);
        expect(latest()?.unavailable).toBe(false);
    });

    it('pictures arriving and no answer: backs off after three, then asks again half a minute later', async () => {
        const { el } = presentingVideo();
        await render(() => el);
        await advance(6_500);
        expect(h.sent, 'one in flight at a time, each expiring after 2 s').toBe(3);
        expect(latest()?.unavailable, 'an older agent never answers: said so').toBe(true);
        const before = h.sent;
        await advance(20_000);
        expect(h.sent, 'quiet while backed off — not a refused frame a second in that log').toBe(before);
        await advance(12_000);
        expect(h.sent, 'and asks again').toBe(before + 1);
        answer(37);
        await advance(100);
        expect(latest()?.unavailable, 'an answer ends it').toBe(false);
        expect(latest()?.totalMs).toBe(37);
    });

    it('NO picture arriving: an unanswered probe is no evidence, and nothing is said about the other end', async () => {
        const { el, state } = presentingVideo();
        state.arriving = false;
        await render(() => el);
        await advance(20_000);
        expect(latest()?.unavailable ?? false, 'never "older"').toBe(false);
        expect(h.sent, 'and it keeps trying, one at a time').toBeGreaterThanOrEqual(9);
        // Pictures again: an answer comes through.
        state.arriving = true;
        await advance(2_100);
        answer(51);
        await advance(100);
        expect(latest()?.totalMs).toBe(51);
    });

    it('no stage picture at all (minimised to the chat): sends nothing', async () => {
        await render(() => null);
        await advance(5_000);
        expect(h.sent).toBe(0);
    });

    it('switched off (control paused): sends nothing, and reads nothing', async () => {
        const { el } = presentingVideo();
        await render(() => el, false);
        await advance(5_000);
        expect(h.sent).toBe(0);
        expect(latest()).toBeNull();
        // POSITIVE CONTROL: on again, it asks at once.
        await render(() => el, true);
        expect(h.sent).toBe(1);
    });
});
