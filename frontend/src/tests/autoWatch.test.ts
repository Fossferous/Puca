/**
 * The auto-open rule (utils/autoWatch.ts; Settings → Voice & Video → Open
 * streams automatically): 'stream-only' (the default) opens a STREAM-ONLY
 * member's share, 'all' opens every share in the call, 'off' none; each once
 * per share; never your own; the viewer's choices (closing it, data saving)
 * hold. Every opening case has its negative control.
 */
import { describe, it, expect } from 'vitest';
import { autoWatchPlan, type AutoWatchInput } from '../utils/autoWatch';

const BOT = 7;
const HUMAN = 8;
const OTHER = 9;
const ME = 1;

function input(over: Partial<AutoWatchInput> = {}): AutoWatchInput {
    return {
        streamers: [BOT, HUMAN],
        me: ME,
        selected: [],
        handled: new Set(),
        isStreamOnly: (id) => id === BOT,
        mode: 'stream-only',
        saveData: false,
        viewerIsStreamOnly: false,
        ...over,
    };
}

describe("autoWatchPlan, 'stream-only' (the default)", () => {
    it("opens a stream-only member's share and nobody else's", () => {
        expect(autoWatchPlan(input())).toEqual({ open: [BOT], adopt: [], forget: [] });
        // Negative control: an ordinary member's share alone opens nothing.
        expect(autoWatchPlan(input({ streamers: [HUMAN] })).open).toEqual([]);
    });

    it('opens it once: a handled share is not reopened after the viewer closes it', () => {
        expect(autoWatchPlan(input({ handled: new Set([BOT]) })).open).toEqual([]);
    });

    it('forgets a share that ended, so the next one opens again', () => {
        const plan = autoWatchPlan(input({ streamers: [HUMAN], handled: new Set([BOT]) }));
        expect(plan.forget).toEqual([BOT]);
        expect(autoWatchPlan(input({ handled: new Set() })).open).toEqual([BOT]);
    });

    it('adopts a share the viewer already opened, without reopening it', () => {
        expect(autoWatchPlan(input({ selected: [BOT] }))).toEqual({ open: [], adopt: [BOT], forget: [] });
    });

    it('never auto-opens your own share', () => {
        expect(autoWatchPlan(input({ me: BOT })).open).toEqual([]);
    });

    it("holds off while saving data or for a stream-only viewer", () => {
        for (const over of [{ saveData: true }, { viewerIsStreamOnly: true }]) {
            expect(autoWatchPlan(input(over)).open, JSON.stringify(over)).toEqual([]);
        }
    });
});

describe("autoWatchPlan, 'all' and 'off'", () => {
    it("'all' opens every share in the call, in the stream list's order, not your own", () => {
        expect(autoWatchPlan(input({ mode: 'all', streamers: [HUMAN, ME, BOT, OTHER] })).open).toEqual([HUMAN, BOT, OTHER]);
    });

    it("'all' still opens each share once: closed stays closed, an ended one opens again next time", () => {
        expect(autoWatchPlan(input({ mode: 'all', handled: new Set([HUMAN, BOT]) })).open).toEqual([]);
        // A later share joins the ones already open without reopening them.
        expect(autoWatchPlan(input({ mode: 'all', streamers: [BOT, HUMAN, OTHER], handled: new Set([BOT, HUMAN]) })).open).toEqual([OTHER]);
        expect(autoWatchPlan(input({ mode: 'all', streamers: [BOT], handled: new Set([BOT, HUMAN]) })).forget).toEqual([HUMAN]);
    });

    it("'all' holds off while saving data too", () => {
        expect(autoWatchPlan(input({ mode: 'all', saveData: true })).open).toEqual([]);
    });

    it("'off' opens nothing, not even a stream-only account's, but still forgets ended shares", () => {
        expect(autoWatchPlan(input({ mode: 'off' })).open).toEqual([]);
        expect(autoWatchPlan(input({ mode: 'off', streamers: [], handled: new Set([BOT]) })).forget).toEqual([BOT]);
    });
});
