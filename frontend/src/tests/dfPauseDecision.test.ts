/**
 * decideDfPause - can anybody hear this mic? Table-driven over every input,
 * every condition alone, every pair of conditions, and every way an input can
 * be unknown. The expectations are written out by hand, row by row, so the
 * table is the specification and not a second copy of the code.
 *
 * The rule under test: pause only when nobody can hear AND every input that
 * says so is known; anything unknown means "someone can hear".
 */
import { describe, it, expect } from 'vitest';
import { decideDfPause, type DfPauseInputs, type DfPauseReason } from '../api/dfPauseDecision';

const SELF = 1;
const me = { id: SELF, isDeafened: false };
const hearing = (id: number) => ({ id, isDeafened: false });
const deaf = (id: number) => ({ id, isDeafened: true });

/** A call with one other person (2) who hears, connected by media. */
const base: DfPauseInputs = {
    micOpen: true,
    selfId: SELF,
    roster: [me, hearing(2)],
    socketUp: true,
    transportPeers: [2],
};
const w = (patch: Partial<DfPauseInputs>): DfPauseInputs => ({ ...base, ...patch });

type Row = [name: string, inputs: DfPauseInputs, reasons: DfPauseReason[]];

const ROWS: Row[] = [
    // --- nobody-can-hear conditions, one at a time -------------------------
    ['open mic, someone hears: RUN', base, []],
    ['mic closed (muted / PTT up / PTM held / deafened / AFK)', w({ micOpen: false }), ['mic-closed']],
    ['alone: roster has only us, no media peer', w({ roster: [me], transportPeers: [] }), ['alone']],
    ['the only other member is deafened', w({ roster: [me, deaf(2)] }), ['all-deafened']],
    ['every other member is deafened', w({ roster: [me, deaf(2), deaf(3)], transportPeers: [2, 3] }), ['all-deafened']],

    // --- conditions that are NOT met ---------------------------------------
    ['one of two others is not deafened', w({ roster: [me, deaf(2), hearing(3)], transportPeers: [2, 3] }), []],
    ['a listen-only / spectator member hears (roster row, deafened false)', w({ roster: [me, hearing(2)], transportPeers: [] }), []],
    ['a member with no media connection yet still counts (joining)', w({ roster: [me, hearing(2)], transportPeers: [] }), []],

    // --- the roster and the transport disagree: either one is enough -------
    ['SFU session outlives a roster row (their WS blipped): not alone', w({ roster: [me], transportPeers: [2] }), []],
    ['a media peer with no roster row has no known deafen state', w({ roster: [me, deaf(2)], transportPeers: [2, 3] }), []],
    ['our own OTHER device in the call can hear: not alone', w({ roster: [me], transportPeers: [SELF] }), []],
    ['our own other device beside a deafened member: not all-deafened', w({ roster: [me, deaf(2)], transportPeers: [2, SELF] }), []],

    // --- unknown inputs: never pause on the roster's word ------------------
    ['mic gate unknown, someone hears', w({ micOpen: null }), []],
    ['mic gate unknown, alone: alone still holds', w({ micOpen: null, roster: [me], transportPeers: [] }), ['alone']],
    ['roster not loaded', w({ roster: null, transportPeers: [] }), []],
    ['roster loaded but without our own row (not this call yet)', w({ roster: [], transportPeers: [] }), []],
    ['socket down: the roster may be stale', w({ socketUp: false, roster: [me], transportPeers: [] }), []],
    ['transport unknown (SFU connecting / reconnecting)', w({ roster: [me], transportPeers: null }), []],
    ['socket down, everyone deafened', w({ socketUp: false, roster: [me, deaf(2)] }), []],
    ['transport unknown, everyone deafened', w({ roster: [me, deaf(2)], transportPeers: null }), []],
    ['mic closed survives an unknown roster', w({ micOpen: false, roster: null, socketUp: false, transportPeers: null }), ['mic-closed']],

    // --- two conditions at once ---------------------------------------------
    ['mic closed AND alone', w({ micOpen: false, roster: [me], transportPeers: [] }), ['mic-closed', 'alone']],
    ['mic closed AND everyone deafened', w({ micOpen: false, roster: [me, deaf(2)] }), ['mic-closed', 'all-deafened']],
];

describe('decideDfPause: the table', () => {
    for (const [name, inputs, reasons] of ROWS) {
        it(name, () => {
            expect(decideDfPause(inputs)).toEqual({ paused: reasons.length > 0, reasons });
        });
    }
});

describe('decideDfPause: every condition flips both ways', () => {
    // Each condition, from "someone hears" to the condition and back: on->off
    // and off->on. The function is pure, so a flip is just two evaluations -
    // but every row here names the real-world event that causes it, which is
    // what dfPause.test.ts then drives through the controller.
    const flips: Array<[cond: DfPauseReason, on: DfPauseInputs, off: DfPauseInputs, offEvent: string]> = [
        ['mic-closed', w({ micOpen: false }), base, 'unmute / PTT pressed / PTM released / undeafen+unmute'],
        ['alone', w({ roster: [me], transportPeers: [] }), w({ roster: [me, hearing(2)], transportPeers: [] }), 'someone joins (roster first)'],
        ['alone', w({ roster: [me], transportPeers: [] }), w({ roster: [me], transportPeers: [2] }), 'someone connects (media first)'],
        ['alone', w({ roster: [me], transportPeers: [] }), w({ roster: [me], transportPeers: [], socketUp: false }), 'our socket drops'],
        ['alone', w({ roster: [me], transportPeers: [] }), w({ roster: [me], transportPeers: null }), 'the SFU starts reconnecting'],
        ['all-deafened', w({ roster: [me, deaf(2)] }), base, 'the deafened peer undeafens'],
        ['all-deafened', w({ roster: [me, deaf(2)] }), w({ roster: [me, deaf(2), hearing(3)], transportPeers: [2] }), 'a hearing peer joins'],
        ['all-deafened', w({ roster: [me, deaf(2)] }), w({ roster: [me, deaf(2)], transportPeers: [2, 3] }), 'an unknown media peer appears'],
    ];
    for (const [cond, on, off, offEvent] of flips) {
        it(`${cond}: on, then off (${offEvent}), then on again`, () => {
            expect(decideDfPause(on).reasons).toContain(cond);
            expect(decideDfPause(off)).toEqual({ paused: false, reasons: [] });
            expect(decideDfPause(on).reasons).toContain(cond);
        });
    }
});

describe('decideDfPause: combinations clear one at a time', () => {
    it('mic closed + alone: clearing either keeps it paused, clearing both resumes', () => {
        const both = w({ micOpen: false, roster: [me], transportPeers: [] });
        expect(decideDfPause(both).paused).toBe(true);
        // someone joins, still muted
        expect(decideDfPause({ ...both, roster: [me, hearing(2)], transportPeers: [2] })).toEqual({ paused: true, reasons: ['mic-closed'] });
        // unmuted, still alone
        expect(decideDfPause({ ...both, micOpen: true })).toEqual({ paused: true, reasons: ['alone'] });
        // both cleared
        expect(decideDfPause({ ...both, micOpen: true, roster: [me, hearing(2)], transportPeers: [2] }).paused).toBe(false);
    });

    it('mic closed + everyone deafened: an undeafen leaves the mute; the unmute then resumes', () => {
        const both = w({ micOpen: false, roster: [me, deaf(2)] });
        expect(decideDfPause(both).reasons).toEqual(['mic-closed', 'all-deafened']);
        const undeafened = { ...both, roster: [me, hearing(2)] };
        expect(decideDfPause(undeafened)).toEqual({ paused: true, reasons: ['mic-closed'] });
        expect(decideDfPause({ ...undeafened, micOpen: true }).paused).toBe(false);
    });

    it('a deafened room becomes "alone" when the last peer leaves, and resumes on the next join', () => {
        const deafened = w({ roster: [me, deaf(2)] });
        expect(decideDfPause(deafened).reasons).toEqual(['all-deafened']);
        const left = { ...deafened, roster: [me], transportPeers: [] };
        expect(decideDfPause(left).reasons).toEqual(['alone']);
        expect(decideDfPause({ ...left, roster: [me, hearing(3)] }).paused).toBe(false);
    });
});
