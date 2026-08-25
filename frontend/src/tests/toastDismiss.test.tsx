/**
 * The Toast must actually expire.
 *
 * It shipped not expiring. The effect listed `onDismiss` in its deps, and Chat
 * passes an inline arrow (`onDismiss={() => setToast(null)}`) whose identity
 * changes on every render — so each parent render tore down the pending timer
 * and armed a fresh one. Chat re-renders once a second no matter what, because
 * its typing-cleanup interval runs `setTypingUsers(prev => new Map(prev))`,
 * always a new Map, so React never bails out. A 5s timer reset every 1s never
 * fires: the "transient" notice stayed on screen indefinitely, sitting over the
 * composer.
 *
 * Nothing caught it. The only test that mounted Toast passed
 * `duration: 999999` and a stable `onDismiss`, disabling the one behaviour the
 * component has. So this file mounts it the way the app does: a parent that
 * re-renders on a timer, handing down a fresh closure each time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toast } from '../components/Toast';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

/** Mirrors Chat: re-renders every 1000ms and passes a NEW arrow each time. */
function ChurningParent({ onDismiss }: { onDismiss: () => void }) {
    const [, setTick] = useState(0);
    useEffect(() => {
        const i = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(i);
    }, []);
    return <Toast message="something failed" duration={5000} onDismiss={() => onDismiss()} />;
}

function mount(node: React.ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(node); });
}

describe('Toast auto-dismiss', () => {
    it('fires even though the parent re-renders faster than the duration', () => {
        const onDismiss = vi.fn();
        mount(<ChurningParent onDismiss={onDismiss} />);

        // Four parent re-renders happen inside the 5s window. Against the
        // original deps array each one re-armed the timer and this stayed 0.
        act(() => { vi.advanceTimersByTime(4999); });
        expect(onDismiss).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(2); });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('does not fire early', () => {
        const onDismiss = vi.fn();
        mount(<Toast message="x" duration={5000} onDismiss={onDismiss} />);
        act(() => { vi.advanceTimersByTime(4000); });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('clears its timer on unmount', () => {
        const onDismiss = vi.fn();
        mount(<Toast message="x" duration={5000} onDismiss={onDismiss} />);
        act(() => { root!.unmount(); });
        act(() => { vi.advanceTimersByTime(10000); });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('restarts the countdown when the message changes', () => {
        const onDismiss = vi.fn();
        mount(<Toast message="first" duration={5000} onDismiss={onDismiss} />);
        act(() => { vi.advanceTimersByTime(4000); });
        act(() => { root!.render(<Toast message="second" duration={5000} onDismiss={onDismiss} />); });
        // The second message gets its own full window, not the 1s left of the first.
        act(() => { vi.advanceTimersByTime(4000); });
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1001); });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('remounting under a new key restarts the countdown for an identical message', () => {
        // Chat keys the Toast on a sequence number for exactly this reason: the
        // message text comes from a small enum, so a repeat failure sets state
        // to the same string, React bails on Object.is, and without the key
        // nothing would re-render or re-arm.
        const onDismiss = vi.fn();
        mount(<Toast key={1} message="same" duration={5000} onDismiss={onDismiss} />);
        act(() => { vi.advanceTimersByTime(4000); });
        act(() => { root!.render(<Toast key={2} message="same" duration={5000} onDismiss={onDismiss} />); });
        act(() => { vi.advanceTimersByTime(4000); });
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1001); });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});
