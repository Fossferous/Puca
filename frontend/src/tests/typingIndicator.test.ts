/**
 * The typing list's pure updates (components/typingIndicator.ts): a ping, the
 * typer's own message ending it, and the room it is shown in. The real Chat is
 * driven by chatTypingIndicator.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { noteTyping, clearTyper, typersIn, TYPING_TTL_MS, type TypingRow } from '../components/typingIndicator';
import { pruneExpiredTyping } from '../components/stableState';

describe('typing rows', () => {
    it('a ping keeps its typer for TYPING_TTL_MS, in its room', () => {
        const m = noteTyping(new Map(), 2, 'bob', 'channel_7', 1_000);
        expect(m.get(2)).toEqual({ username: 'bob', room: 'channel_7', expiry: 1_000 + TYPING_TTL_MS });
        expect(typersIn(pruneExpiredTyping(m, 1_000 + TYPING_TTL_MS), 'channel_7')).toEqual(['bob']);
        expect(typersIn(pruneExpiredTyping(m, 1_001 + TYPING_TTL_MS), 'channel_7')).toEqual([]);
    });

    it('their message removes only them; someone not typing changes nothing (the SAME map)', () => {
        let m = noteTyping(new Map(), 2, 'bob', 'channel_7', 0);
        m = noteTyping(m, 3, 'cat', 'channel_7', 0);
        const same = clearTyper(m, 4);
        expect(same).toBe(m);
        const next = clearTyper(m, 2);
        expect(next).not.toBe(m);
        expect(typersIn(next, 'channel_7')).toEqual(['cat']);
        expect(m.size).toBe(2); // never mutates the previous state
    });

    it('names only the room asked about, and nobody with no room open', () => {
        let m = new Map<number, TypingRow>();
        m = noteTyping(m, 2, 'bob', 'channel_7', 0);
        m = noteTyping(m, 3, 'cat', 'channel_8', 0);
        expect(typersIn(m, 'channel_7')).toEqual(['bob']);
        expect(typersIn(m, 'channel_8')).toEqual(['cat']);
        expect(typersIn(m, null)).toEqual([]);
    });
});
