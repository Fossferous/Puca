import { describe, it, expect } from 'vitest';
import { useStreamStore } from '../stores/streamStore';

// StreamStage lists `setFocusedStream` as an effect dependency on the promise
// that it never changes. That holds only while every action is created once in
// the store's initializer and every state change MERGES rather than replaces;
// if either stops being true, the effect would re-subscribe on every change.
describe('streamStore actions', () => {
    it('keep their identity across every kind of state change', () => {
        const actions = [
            'setFocusedStream',
            'setFocusMode',
            'setStreamQuality',
            'setPendingQuality',
            'clearPendingQuality',
            'clearAllStreams',
        ] as const;
        const before = useStreamStore.getState();
        const ids = actions.map((a) => before[a]);

        before.setFocusedStream(7);
        before.setFocusMode(false);
        before.setStreamQuality('x', { fps: 30, bitrate: 1 });
        before.setPendingQuality('x', { fps: 60, bitrate: 2 });
        before.clearPendingQuality('x');
        before.clearAllStreams();
        useStreamStore.setState({ qualities: {} });

        const after = useStreamStore.getState();
        // Positive control: the state really did change underneath them.
        expect(after).not.toBe(before);
        actions.forEach((a, i) => expect(after[a], a).toBe(ids[i]));
    });
});
