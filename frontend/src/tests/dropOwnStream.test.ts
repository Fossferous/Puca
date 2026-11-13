// @vitest-environment jsdom
/**
 * Stopping your own share takes only YOUR stream off the stage
 * (voiceState.dropOwnStream). It used to run clearAllStreams() - the
 * leave-the-call wipe - which also closed the streams you were watching and
 * dropped everyone else's share from the list. Live proof:
 * e2e/stop-own-share-keeps-watching.mjs (red on 0.9.839).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearAllStreams, dropOwnStream, getCurrentStreamingUserId, globalScreenSharers, globalSelectedStreams, globalStreamData, setCurrentStreamingUser } from '../components/voiceState';
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
    // Every way a share stops ends here (the voice panel's Stop, the stage's,
    // the picture ending by itself, a share the SFU lost), so this is where
    // remote control of it is told to end (remoteControl.endControlOfMyShare),
    // and where "I am the one streaming" stops being true. The voice panel's
    // own Stop never cleared it, and control's "still sharing" check passed.
    it('says your share ended, and you are no longer the one streaming', () => {
        const heard: string[] = [];
        const listen = () => heard.push('ownShareEnded');
        window.addEventListener('ownShareEnded', listen);
        try {
            setCurrentStreamingUser(ME);
            dropOwnStream(ME);
            expect(heard).toEqual(['ownShareEnded']);
            expect(getCurrentStreamingUserId()).toBeNull();
        } finally {
            window.removeEventListener('ownShareEnded', listen);
        }
    });
});
