import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatGoLive, goLiveBegin, goLiveMark, goLiveEnd } from '../api/goLiveTiming';

describe('formatGoLive', () => {
    it('gives each step its own duration and the time after the picker', () => {
        const line = formatGoLive('live', 1000, [
            ['picker', 4100],
            ['window-focus', 3900],
            ['window-owner', 4114],
            ['audio', 4123],
            ['ack', 4203],
            ['published', 4513],
        ], 4520);
        expect(line).toBe(
            'go-live live: picker 3100ms (window-focus +2900) | window-owner +14 | audio +9 | ack +80 | published +310'
            + ' | total after picker 420ms | after window-focus 620ms');
    });

    it('a cancelled picker is one step, and a missing focus is simply absent', () => {
        expect(formatGoLive('cancelled', 0, [], 12)).toBe('go-live cancelled: (no steps)');
        expect(formatGoLive('live', 0, [['picker', 50], ['audio', 60]], 70))
            .toBe('go-live live: picker 50ms | audio +10 | total after picker 20ms');
    });
});

describe('goLiveBegin / Mark / End', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('records the marks of one run, the window regaining focus included, and closes it', () => {
        let t = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => t);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        goLiveBegin();
        t = 2000; window.dispatchEvent(new Event('focus'));
        t = 2500; window.dispatchEvent(new Event('focus')); // only the first counts
        t = 5000; goLiveMark('picker');
        t = 5010; goLiveMark('audio');
        t = 5100; goLiveEnd('live');
        expect(info).toHaveBeenCalledWith('[stream-diag] go-live live: picker 5000ms (window-focus +2000) | audio +10 | total after picker 100ms | after window-focus 3100ms');
        // Closed: nothing more is written until the next begin.
        info.mockClear();
        goLiveMark('late');
        goLiveEnd('live');
        expect(info).not.toHaveBeenCalled();
    });

    it('a new begin drops an unfinished run and its focus listener', () => {
        let t = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => t);
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const removed = vi.spyOn(window, 'removeEventListener');
        goLiveBegin();
        goLiveMark('picker');
        t = 100; goLiveBegin();
        // The abandoned run's focus listener is gone, not left to pile up.
        expect(removed.mock.calls.filter(([type]) => String(type) === 'focus')).toHaveLength(1);
        t = 150; window.dispatchEvent(new Event('focus'));
        t = 300; goLiveMark('picker');
        goLiveEnd('live');
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0][0]).toBe('[stream-diag] go-live live: picker 200ms (window-focus +50) | total after picker 0ms | after window-focus 150ms');
    });
});
