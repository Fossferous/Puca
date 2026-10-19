/**
 * Stopping your own share takes only YOUR stream off the stage
 * (voiceState.dropOwnStream). It used to run clearAllStreams() - the
 * leave-the-call wipe - which also closed the streams you were watching and
 * dropped everyone else's share from the list. Live proof:
 * e2e/stop-own-share-keeps-watching.mjs (red on 0.9.839).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearAllStreams, dropOwnStream, globalScreenSharers, globalSelectedStreams, globalStreamData } from '../components/voiceState';
import { useStreamStore } from '../stores/streamStore';

const ME = 1, FRIEND = 2;

beforeEach(() => {
    clearAllStreams();
    for (const id of [ME, FRIEND]) {
        globalSelectedStreams.add(id);
        globalStreamData.set(id, { username: `u${id}`, stream: null });
        globalScreenSharers.set(id, `u${id}`);
    }
});

describe('dropOwnStream', () => {
    it("removes only your own stream; the friend's stays selected and listed", () => {
        const left = dropOwnStream(ME);
        expect(left).toBe(1);
        expect([...globalSelectedStreams]).toEqual([FRIEND]);
        expect(globalStreamData.has(FRIEND)).toBe(true);
        expect(globalScreenSharers.has(FRIEND)).toBe(true);
        expect(globalStreamData.has(ME)).toBe(false);
        expect(globalScreenSharers.has(ME)).toBe(false);
    });
    it('unfocuses your own stream, but never a friend you focused', () => {
        useStreamStore.getState().setFocusedStream(ME);
        dropOwnStream(ME);
        expect(useStreamStore.getState().focusedStreamId).toBeNull();
        useStreamStore.getState().setFocusedStream(FRIEND);
        globalSelectedStreams.add(ME);
        dropOwnStream(ME);
        expect(useStreamStore.getState().focusedStreamId).toBe(FRIEND);
    });
    it('reports nothing left when you were watching only yourself', () => {
        globalSelectedStreams.delete(FRIEND);
        expect(dropOwnStream(ME)).toBe(0);
    });
});
