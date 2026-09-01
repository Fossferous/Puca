import { describe, it, expect } from 'vitest';
import { mergeMissing } from '../components/chatHistory.utils';

/**
 * The reconnect catch-up in Chat.tsx. The backend fan-out has no replay, so a
 * message sent while this device's socket was down never arrives; nothing
 * re-fetched it for the channel the user was looking at, because the history
 * effects are keyed on the selection id and do not re-run on a reconnect.
 *
 * These pin the merge RULE, because the dangerous failure here is not "missed a
 * message" — it is a catch-up that deletes messages the fetched page happens not
 * to contain.
 */

type Row = { id: string; timestamp: number };
const id = (m: Row) => m.id;
const ts = (m: Row) => m.timestamp;

describe('mergeMissing — reconnect catch-up', () => {
    it('adds a message that arrived while the socket was down', () => {
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }];
        const fetched: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'b', timestamp: 2 }];
        expect(mergeMissing(onScreen, fetched, id, ts).map(id)).toEqual(['a', 'b']);
    });

    it('keeps the unacked optimistic bubble the server has never seen', () => {
        // Sent while offline: it exists only locally, so a replace would erase
        // the user's own message in front of them.
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'local_9_7', timestamp: 9 }];
        const fetched: Row[] = [{ id: 'a', timestamp: 1 }];
        expect(mergeMissing(onScreen, fetched, id, ts).map(id)).toEqual(['a', 'local_9_7']);
    });

    it('keeps older scrollback that the 50-row page does not reach', () => {
        const onScreen: Row[] = [{ id: 'old', timestamp: 1 }, { id: 'recent', timestamp: 50 }];
        const fetched: Row[] = [{ id: 'recent', timestamp: 50 }];
        expect(mergeMissing(onScreen, fetched, id, ts).map(id)).toEqual(['old', 'recent']);
    });

    it('keeps a message that landed over the socket while the fetch was in flight', () => {
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'live', timestamp: 99 }];
        const fetched: Row[] = [{ id: 'a', timestamp: 1 }];
        expect(mergeMissing(onScreen, fetched, id, ts).map(id)).toEqual(['a', 'live']);
    });

    it('never resurrects a message deleted while disconnected', () => {
        // Deletion is expressed by absence from the fetched page; absence is
        // never acted on, so the row simply is not re-added.
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }];
        const fetched: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'b', timestamp: 2 }];
        const merged = mergeMissing(onScreen, fetched, id, ts);
        const afterDelete = mergeMissing(merged, [{ id: 'a', timestamp: 1 }], id, ts);
        // 'b' stays because we do not remove, but nothing is re-created either.
        expect(afterDelete.filter(m => m.id === 'b')).toHaveLength(1);
    });

    it('does not duplicate a message already on screen', () => {
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'b', timestamp: 2 }];
        const fetched: Row[] = [{ id: 'a', timestamp: 1 }, { id: 'b', timestamp: 2 }];
        expect(mergeMissing(onScreen, fetched, id, ts)).toHaveLength(2);
    });

    it('returns the SAME array reference when nothing is missing, so no re-render', () => {
        const onScreen: Row[] = [{ id: 'a', timestamp: 1 }];
        expect(mergeMissing(onScreen, [{ id: 'a', timestamp: 1 }], id, ts)).toBe(onScreen);
    });

    it('orders a backfilled message into place rather than appending it', () => {
        // The gap message is older than one already on screen.
        const onScreen: Row[] = [{ id: 'newest', timestamp: 30 }];
        const fetched: Row[] = [{ id: 'gap', timestamp: 20 }, { id: 'newest', timestamp: 30 }];
        expect(mergeMissing(onScreen, fetched, id, ts).map(id)).toEqual(['gap', 'newest']);
    });

    it('merges into an empty view', () => {
        expect(mergeMissing([], [{ id: 'a', timestamp: 1 }], id, ts).map(id)).toEqual(['a']);
    });
});
