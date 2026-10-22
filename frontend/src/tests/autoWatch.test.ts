/**
 * The auto-watch rule (utils/autoWatch.ts, docs/STREAM_ONLY.md): a share from
 * a STREAM-ONLY member of the call opens by itself, once per share; nobody
 * else's does; and the viewer's choices (the setting, data saving, closing
 * it) hold. Every opening case has its negative control.
 */
import { describe, it, expect } from 'vitest';
import { autoWatchPlan, type AutoWatchInput } from '../utils/autoWatch';

const BOT = 7;
const HUMAN = 8;
const ME = 1;

function input(over: Partial<AutoWatchInput> = {}): AutoWatchInput {
    return {
        streamers: [BOT, HUMAN],
        me: ME,
        selected: [],
        handled: new Set(),
        isStreamOnly: (id) => id === BOT,
        enabled: true,
        saveData: false,
        viewerIsStreamOnly: false,
        ...over,
    };
}

describe('autoWatchPlan', () => {
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

    it('never auto-watches your own share', () => {
        expect(autoWatchPlan(input({ me: BOT })).open).toEqual([]);
    });

    it('holds off when switched off, while saving data, or for a stream-only viewer', () => {
        for (const over of [{ enabled: false }, { saveData: true }, { viewerIsStreamOnly: true }]) {
            expect(autoWatchPlan(input(over)).open, JSON.stringify(over)).toEqual([]);
        }
        // ...but still forgets ended shares, so turning it back on works.
        expect(autoWatchPlan(input({ enabled: false, streamers: [], handled: new Set([BOT]) })).forget).toEqual([BOT]);
    });
});
