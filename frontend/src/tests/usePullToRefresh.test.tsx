/**
 * Pull-to-refresh on the Devices list.
 *
 * The gesture logic is what can go wrong quietly: a pull that fires while
 * the user is merely scrolling, a scroll that fires a refresh, a second
 * refresh stacked on a running one, a stuck spinner. jsdom has no real
 * touch, so the handlers are driven with hand-built events — which is also
 * exactly the surface a component spreads them onto.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePullToRefresh, type PullToRefreshState } from '../hooks/usePullToRefresh';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What the hook last returned — written from an effect, never during
 *  render, so the harness itself obeys the rules of hooks it is testing under. */
const probe: {
    state: PullToRefreshState;
    handlers: ReturnType<typeof usePullToRefresh>['handlers'] | null;
} = { state: { distance: 0, armed: false, refreshing: false }, handlers: null };
const onRefresh = vi.fn<() => Promise<void>>();

function Harness() {
    const p = usePullToRefresh({ onRefresh, threshold: 64, maxPull: 110, refreshingHeight: 44, minSpinMs: 100 });
    useEffect(() => {
        probe.state = p.state;
        probe.handlers = p.handlers;
    });
    return <div id="scroller" {...p.handlers} />;
}
const seenState = () => probe.state;
const handlers = () => probe.handlers!;

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness />); });
}

/** A container element with a controllable scrollTop. */
function container(scrollTop = 0): HTMLElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
    return el;
}

function touch(el: HTMLElement, y: number, target: EventTarget = el) {
    return {
        touches: [{ clientY: y }],
        currentTarget: el,
        target,
    } as unknown as React.TouchEvent<HTMLElement>;
}

async function start(el: HTMLElement, y: number, target?: EventTarget) {
    await act(async () => { handlers().onTouchStart(touch(el, y, target)); });
}
async function move(el: HTMLElement, y: number) {
    await act(async () => { handlers().onTouchMove(touch(el, y)); });
}
async function end() {
    await act(async () => { handlers().onTouchEnd(); });
}

beforeEach(async () => {
    vi.useFakeTimers();
    onRefresh.mockReset();
    onRefresh.mockResolvedValue(undefined);
    await mount();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.useRealTimers();
});

describe('a pull from the top', () => {
    it('follows the finger, arms past the threshold, refreshes on release, and settles', async () => {
        const el = container(0);
        await start(el, 100);
        await move(el, 130);
        expect(seenState().distance).toBe(30);
        expect(seenState().armed).toBe(false);

        // Past the threshold (damped: 40 + (dy-40)*0.45 >= 64 needs dy >= ~94).
        await move(el, 200);
        expect(seenState().armed).toBe(true);
        expect(seenState().distance).toBeGreaterThanOrEqual(64);
        expect(seenState().distance).toBeLessThanOrEqual(110);

        await end();
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(seenState().refreshing).toBe(true);
        expect(seenState().distance).toBe(44);

        // Held up for the minimum spin, then idle.
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(seenState().refreshing).toBe(false);
        expect(seenState().distance).toBe(0);
    });

    it('never grows past maxPull', async () => {
        const el = container(0);
        await start(el, 0);
        await move(el, 2000);
        expect(seenState().distance).toBe(110);
    });

    it('released short of the threshold, it snaps back and does NOT refresh', async () => {
        const el = container(0);
        await start(el, 100);
        await move(el, 150);
        expect(seenState().distance).toBeGreaterThan(0);
        await end();
        expect(onRefresh).not.toHaveBeenCalled();
        expect(seenState().distance).toBe(0);
    });
});

describe('what is NOT a pull', () => {
    it('a touch that starts with the list scrolled down is a scroll', async () => {
        const el = container(120);
        await start(el, 100);
        await move(el, 400);
        expect(seenState().distance).toBe(0);
        await end();
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('a pull that scrolls away mid-gesture is abandoned', async () => {
        const el = container(0);
        await start(el, 100);
        await move(el, 150);
        expect(seenState().distance).toBeGreaterThan(0);
        // The container moved (a flick that overshot): no longer at the top.
        (el as unknown as { scrollTop: number }).scrollTop = 30;
        await move(el, 300);
        expect(seenState().distance).toBe(0);
        await end();
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('a second finger mid-pull snaps the indicator back instead of wedging it open', async () => {
        const el = container(0);
        await start(el, 100);
        await move(el, 150);
        expect(seenState().distance).toBeGreaterThan(0);
        // A pinch begins: a second touch point arrives. The gesture ends and
        // the spacer must collapse, not stick at its last height.
        await act(async () => {
            handlers().onTouchStart({
                touches: [{ clientY: 150 }, { clientY: 400 }],
                currentTarget: el,
                target: el,
            } as unknown as React.TouchEvent<HTMLElement>);
        });
        expect(seenState().distance).toBe(0);
        await end();
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('a touch that begins on an input is typing, not a pull', async () => {
        const el = container(0);
        const input = document.createElement('input');
        el.appendChild(input);
        await start(el, 100, input);
        await move(el, 400);
        expect(seenState().distance).toBe(0);
        await end();
        expect(onRefresh).not.toHaveBeenCalled();
    });

    it('a second pull during a refresh does not start another', async () => {
        let release!: () => void;
        onRefresh.mockImplementation(() => new Promise<void>(r => { release = r; }));
        const el = container(0);
        await start(el, 0);
        await move(el, 200);
        await end();
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(seenState().refreshing).toBe(true);

        await start(el, 0);
        await move(el, 200);
        await end();
        expect(onRefresh).toHaveBeenCalledTimes(1);

        await act(async () => { release(); await vi.advanceTimersByTimeAsync(150); });
        expect(seenState().refreshing).toBe(false);
    });

    it('a refresh that throws still lets go of the spinner', async () => {
        onRefresh.mockRejectedValue(new Error('offline'));
        const el = container(0);
        await start(el, 0);
        await move(el, 200);
        await end();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(seenState().refreshing).toBe(false);
        expect(seenState().distance).toBe(0);
    });
});
