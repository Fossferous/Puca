/**
 * Conversation search: what it must NOT return.
 *
 * Two exclusions matter more than the matching itself.
 *
 * 1. BLOCKED AUTHORS. Blocking gated the message list and reply previews but
 *    not search, so a blocked user's text came back verbatim and attributed —
 *    a third delivery path, open in a shipped build. That is the defect these
 *    tests exist for.
 * 2. UNDECRYPTABLE CONTENT. Messages that could not be decrypted render as
 *    placeholder strings ("[Encrypted — key unavailable]"). Searching them
 *    as if they were text meant "encrypted" or "key" matched every message the
 *    user cannot read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const BLOCKED = 66;
const NORMAL = 7;

let channelPages: Array<Array<Record<string, unknown>>> = [];
let dmRows: Array<Record<string, unknown>> = [];

/** Cursors the code actually asked for, so a broken `before` is detectable. */
let requestedCursors: Array<string | undefined> = [];
vi.mock('../api/servers', () => ({
    // Serve successive pages, then empty — mimics walking back through history.
    getMessages: async (_id: number, _limit: number, before?: string) => {
        requestedCursors.push(before);
        return channelPages.shift() ?? [];
    },
    decryptChannelMessages: async (_id: number, raw: Array<Record<string, unknown>>) => raw,
}));
vi.mock('../api/dms', () => ({
    getDMMessages: async () => dmRows,
    decryptDMMessages: async (raw: Array<Record<string, unknown>>) => raw,
}));
vi.mock('../utils/serverTime', () => ({
    parseServerTimestamp: () => 1_700_000_000_000,
}));

import { searchChannel, searchDM } from '../api/searchMessages';
import { ENC_KEY_UNAVAILABLE, ENC_CANNOT_DECRYPT } from '../api/decryptMarkers';

const msg = (id: string, user_id: number, content: string) => ({
    id, user_id, username: 'u' + user_id, content, created_at: '2026-07-28T00:00:00Z',
});
const dm = (id: string, sender_id: number, content: string) => ({
    id, sender_id, sender_username: 'u' + sender_id, content, created_at: '2026-07-28T00:00:00Z',
});

const isBlocked = (id: number) => id === BLOCKED;

beforeEach(() => { channelPages = []; dmRows = []; requestedCursors = []; });

describe('searchChannel', () => {
    it('never returns a blocked author, even on an exact match', async () => {
        channelPages = [[
            msg('1', NORMAL, 'hello from a normal user'),
            msg('2', BLOCKED, 'hello from someone you blocked'),
        ]];
        const out = await searchChannel(1, 'hello', isBlocked);
        expect(out.hits.map(h => h.id)).toEqual(['1']);
        expect(out.hits.some(h => h.senderId === BLOCKED)).toBe(false);
        // Still counted as searched — the footer must not under-report.
        expect(out.searched).toBe(2);
    });

    it('excludes undecryptable placeholders instead of matching them', async () => {
        channelPages = [[
            msg('1', NORMAL, ENC_KEY_UNAVAILABLE),
            msg('2', NORMAL, ENC_CANNOT_DECRYPT),
            msg('3', NORMAL, 'a real message mentioning a key'),
        ]];
        // "key" appears in the placeholder AND in real text.
        const out = await searchChannel(1, 'key', isBlocked);
        expect(out.hits.map(h => h.id)).toEqual(['3']);
        expect(out.undecryptable).toBe(2);
    });

    it('walks back through pages until history runs out', async () => {
        channelPages = [
            Array.from({ length: 100 }, (_, i) => msg(`a${i}`, NORMAL, i === 3 ? 'needle here' : 'filler')),
            [msg('b0', NORMAL, 'needle again')],   // short page => end of history
        ];
        const out = await searchChannel(1, 'needle', isBlocked);
        expect(out.hits.map(h => h.id)).toEqual(['a3', 'b0']);
        expect(out.searched).toBe(101);
        expect(out.truncated).toBe(false);
        // The cursor itself must be right, not merely "some second call
        // happened": page 1 asks for nothing, page 2 must ask for the OLDEST
        // row of page 1. Without this the test passes on a cursor that repeats
        // the same page or skips history.
        expect(requestedCursors).toEqual([undefined, '2026-07-28T00:00:00Z']);
    });

    it('stops rather than looping when the cursor does not advance', async () => {
        // A server that keeps returning the same oldest row would otherwise
        // spin until MAX_SCANNED, hammering the backend.
        const page = Array.from({ length: 100 }, (_, i) => msg(`x${i}`, NORMAL, 'filler'));
        channelPages = [page, page, page];
        const out = await searchChannel(1, 'filler', isBlocked);
        expect(out.searched).toBeLessThanOrEqual(200);
    });

    it('stops when the caller aborts, and says it was truncated', async () => {
        channelPages = [
            Array.from({ length: 100 }, (_, i) => msg(`a${i}`, NORMAL, 'filler')),
            Array.from({ length: 100 }, (_, i) => msg(`b${i}`, NORMAL, 'needle')),
        ];
        const signal = { aborted: true };
        const out = await searchChannel(1, 'needle', isBlocked, signal);
        expect(out.hits).toEqual([]);
        expect(out.truncated).toBe(true);
    });

    it('is case-insensitive', async () => {
        channelPages = [[msg('1', NORMAL, 'The Quick Brown Fox')]];
        expect((await searchChannel(1, 'quick brown', isBlocked)).hits).toHaveLength(1);
    });
});

describe('searchDM', () => {
    it('never returns a blocked author', async () => {
        dmRows = [dm('1', NORMAL, 'shared secret'), dm('2', BLOCKED, 'shared secret')];
        const out = await searchDM('c1', NORMAL, 'secret', isBlocked);
        expect(out.hits.map(h => h.id)).toEqual(['1']);
    });

    it('reports truncation when it hits the server cap', async () => {
        dmRows = Array.from({ length: 200 }, (_, i) => dm(`d${i}`, NORMAL, 'filler'));
        const out = await searchDM('c1', NORMAL, 'filler', isBlocked);
        // The DM endpoint has no `before` cursor, so a full page means there
        // is history the search genuinely cannot reach — the UI must say so.
        expect(out.truncated).toBe(true);
        expect(out.searched).toBe(200);
    });
});
