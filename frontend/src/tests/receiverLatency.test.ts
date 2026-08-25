/**
 * The receiver-latency registry: minimise while a screen share is DRIVEN,
 * restore when it is merely watched — and survive the receiver being replaced
 * mid-control, which is how a share restart would otherwise silently bring
 * the watching-tuned buffer back under the driver's pointer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

function fakeReceiver() {
    return {
        playoutDelayHint: undefined as number | undefined,
        jitterBufferTarget: undefined as number | null | undefined,
    } as unknown as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number | null };
}

async function fresh() {
    vi.resetModules();
    return import('../api/rtc/receiverLatency');
}

beforeEach(() => { vi.resetModules(); });

describe('screen-share receiver latency registry', () => {
    it('minimises on control start and restores on control end', async () => {
        const m = await fresh();
        const r = fakeReceiver();
        m.registerScreenReceiver(7, r);

        m.setScreenLatencyMinimised(7, true);
        expect(r.playoutDelayHint).toBe(0);
        expect(r.jitterBufferTarget).toBe(0);

        m.setScreenLatencyMinimised(7, false);
        expect(r.playoutDelayHint, 'no opinion once control ends').toBeUndefined();
        expect(r.jitterBufferTarget, 'null = browser default, per spec').toBeNull();
    });

    it('applies the minimised state to a receiver that arrives LATE', async () => {
        // Control can be granted while the subscription is still coming up —
        // the flag must not be lost in the gap.
        const m = await fresh();
        m.setScreenLatencyMinimised(7, true);
        const r = fakeReceiver();
        m.registerScreenReceiver(7, r);
        expect(r.playoutDelayHint).toBe(0);
        expect(r.jitterBufferTarget).toBe(0);
    });

    it('re-applies to a REPLACEMENT receiver mid-control', async () => {
        const m = await fresh();
        const first = fakeReceiver();
        m.registerScreenReceiver(7, first);
        m.setScreenLatencyMinimised(7, true);

        const second = fakeReceiver();
        m.registerScreenReceiver(7, second);
        expect(second.playoutDelayHint, 'a restarted share stays low-latency while driven').toBe(0);
        expect(second.jitterBufferTarget).toBe(0);
    });

    it('does not touch receivers of OTHER users, and tolerates missing ones', async () => {
        const m = await fresh();
        const other = fakeReceiver();
        m.registerScreenReceiver(8, other);
        m.setScreenLatencyMinimised(7, true);   // user 7 has no receiver yet
        expect(other.playoutDelayHint, 'user 8 keeps the watching buffer').toBeUndefined();
        m.setScreenLatencyMinimised(9, false);  // never registered: must not throw
        expect(m.screenLatencyStateForTest().minimised).toEqual([7]);
    });

    it('a receiver registered while NOT minimised is left alone', async () => {
        const m = await fresh();
        const r = fakeReceiver();
        m.registerScreenReceiver(7, r);
        expect(r.playoutDelayHint, 'plain watching keeps the browser defaults').toBeUndefined();
        expect(r.jitterBufferTarget).toBeUndefined();
    });

    it('clearAllScreenLatency restores every minimised receiver and forgets the flags', async () => {
        // The reset paths call this UNCONDITIONALLY: several control-teardown
        // branches can null their side without knowing whether they ever
        // minimised, and one orphaned flag used to strand a receiver at
        // zero-buffer — re-applied to every replacement — for the tab's life.
        const m = await fresh();
        const a = fakeReceiver();
        const b = fakeReceiver();
        m.registerScreenReceiver(7, a);
        m.registerScreenReceiver(8, b);
        m.setScreenLatencyMinimised(7, true);
        m.setScreenLatencyMinimised(8, true);
        m.setScreenLatencyMinimised(9, true);   // minimised with NO receiver yet

        m.clearAllScreenLatency();

        expect(a.jitterBufferTarget).toBeNull();
        expect(b.jitterBufferTarget).toBeNull();
        expect(m.screenLatencyStateForTest().minimised, 'including the receiver-less flag').toEqual([]);

        // And the flag really is gone: a late receiver for user 9 must NOT
        // inherit a minimised state that was swept.
        const c = fakeReceiver();
        m.registerScreenReceiver(9, c);
        expect(c.playoutDelayHint).toBeUndefined();
    });
});
