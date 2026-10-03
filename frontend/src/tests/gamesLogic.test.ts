/**
 * The games' pure client logic, read off the server's views (never the rules
 * re-implemented): who is offered a table (gamesGate), the Hold'em action bar
 * and raise presets (holdemActions), the Blackjack bet range (blackjackActions),
 * the opener's form (openTableConfig) and the words for every code (gameWords).
 */
import { describe, it, expect } from 'vitest';
import seated from './fixtures/games/holdem-table-seated.json';
import spectator from './fixtures/games/holdem-table-spectator.json';
import blackjackTable from './fixtures/games/blackjack-table.json';
import holdemEvents from './fixtures/games/holdem-events.json';
import blackjackEvents from './fixtures/games/blackjack-events.json';
import refusals from './fixtures/games/refusals.json';
import ended from './fixtures/games/ended.json';
import { parseGameFrame, type BlackjackView, type HoldemView, type GameServerFrame } from '../api/games/protocol';
import { gamesGate, gamesRowContradicted } from '../api/games/gamesGate';
import { clampRaise, holdemBar, holdemBusted, raiseAction, raisePresets, stepRaise } from '../api/games/holdemActions';
import { betPresets, betRange, blackjackBusted, blackjackMyTurn, clampBet } from '../api/games/blackjackActions';
import { configFor, defaultForm, formProblem } from '../api/games/openTableConfig';
import { endText, eventLine, refusalText } from '../api/games/gameWords';
import { PERM } from '../api/permissionBits';

const frame = (raw: unknown): GameServerFrame => {
    const f = parseGameFrame(raw as { type: string; payload: unknown });
    if (!f) throw new Error('fixture did not parse');
    return f;
};
const holdem = (raw: unknown): HoldemView => {
    const f = frame(raw);
    if (!('view' in f) || f.view.game !== 'holdem') throw new Error('not holdem');
    return f.view;
};
const blackjack = (raw: unknown): BlackjackView => {
    const f = frame(raw);
    if (!('view' in f) || f.view.game !== 'blackjack') throw new Error('not blackjack');
    return f.view;
};

const PLAY = PERM.CONNECT | PERM.PLAY_GAMES;

describe('gamesGate', () => {
    const base = { feature: true, gamesEnabled: true, perms: PLAY, inCall: true, hasTable: false };

    it('offers opening and sitting only with the feature, the switch, the call and CONNECT + PLAY_GAMES', () => {
        expect(gamesGate(base)).toEqual({ available: true, launcher: true, canOpen: true, canSit: true, canModerate: false, why: null });
    });

    it.each([
        ['no `games` feature on this socket', { feature: false }, 'no_feature'],
        ['games switched off on the server', { gamesEnabled: false }, 'disabled'],
        ['a server that predates games', { gamesEnabled: undefined }, 'disabled'],
        ['this socket is not in the call', { inCall: false }, 'not_in_call'],
        ['no PLAY_GAMES', { perms: PERM.CONNECT }, 'no_permission'],
        ['no CONNECT', { perms: PERM.PLAY_GAMES }, 'no_permission'],
        ['no permission bits at all (never fail open for an action)', { perms: undefined }, 'no_permission'],
    ] as const)('off: %s', (_name, over, why) => {
        const g = gamesGate({ ...base, ...over });
        expect(g.available).toBe(false);
        expect(g.canOpen).toBe(false);
        expect(g.canSit).toBe(false);
        expect(g.why).toBe(why);
    });

    it('without PLAY_GAMES a person in the call can still WATCH an open table, but not sit', () => {
        const g = gamesGate({ ...base, perms: PERM.CONNECT, hasTable: true });
        expect(g).toMatchObject({ available: true, canOpen: false, canSit: false, why: 'no_permission' });
    });

    it('with a table open: join, not open', () => {
        expect(gamesGate({ ...base, hasTable: true })).toMatchObject({ canOpen: false, canSit: true });
    });

    // Found live (e2e/games-live.mjs): the server row is fetched once and no
    // frame refreshes it, so someone online when the owner switched games on
    // still holds games_enabled=false. The table the server sent for THIS call
    // is its own word that the call plays games (switching games off ends every
    // table), so it must not be hidden behind the stale row.
    it('a table the server sent for this call is offered even when the cached server row still says games are off', () => {
        expect(gamesGate({ ...base, gamesEnabled: false, hasTable: true })).toMatchObject({ available: true, canOpen: false, canSit: true, why: null });
        expect(gamesGate({ ...base, gamesEnabled: false, hasTable: true, perms: PERM.CONNECT })).toMatchObject({ available: true, canSit: false, why: 'no_permission' });
        // ...and with no table, the row still decides (nothing to open on a server with games off).
        expect(gamesGate({ ...base, gamesEnabled: false, hasTable: false }).why).toBe('disabled');
    });

    it('MOVE_MEMBERS moderates; ADMINISTRATOR implies everything', () => {
        expect(gamesGate({ ...base, perms: PLAY | PERM.MOVE_MEMBERS }).canModerate).toBe(true);
        expect(gamesGate({ ...base, perms: PERM.ADMINISTRATOR })).toMatchObject({ canOpen: true, canSit: true, canModerate: true });
    });
});

// Found live (e2e/games-live.mjs): nothing pushes a changed server row, so
// after the owner switched games OFF a member who loaded the row while they
// were on was still offered "Open a table" (and the reverse while switching
// ON). When the server's own frames contradict the cached row, Chat refetches
// the row; this is the decision.
describe('gamesRowContradicted', () => {
    const ROOM = 'voice_42';
    const at = 1;
    const tableHere = { table: { room_id: ROOM }, notice: null };
    const endedOff = { table: null, notice: { kind: 'ended' as const, room_id: ROOM, table_id: 5, reason: 'disabled' as const, at } };
    const refusedOff = { table: null, notice: { kind: 'refused' as const, room_id: ROOM, table_id: null, op: 'create' as const, refusal: { code: 'disabled' as const }, at } };

    it('a table in this call while the row says games are off (or predates them): refetch', () => {
        expect(gamesRowContradicted(false, tableHere, ROOM)).toBe(true);
        expect(gamesRowContradicted(undefined, tableHere, ROOM)).toBe(true);
        expect(gamesRowContradicted(true, tableHere, ROOM)).toBe(false);
    });

    it('the server saying games are off (an ending or a refusal) while the row says on: refetch', () => {
        expect(gamesRowContradicted(true, endedOff, ROOM)).toBe(true);
        expect(gamesRowContradicted(true, refusedOff, ROOM)).toBe(true);
        expect(gamesRowContradicted(false, endedOff, ROOM)).toBe(false);
        expect(gamesRowContradicted(false, refusedOff, ROOM)).toBe(false);
    });

    it('anything else agrees with the row: other reasons, other calls, no call', () => {
        expect(gamesRowContradicted(true, { table: null, notice: { ...endedOff.notice, reason: 'closed' as const } }, ROOM)).toBe(false);
        expect(gamesRowContradicted(true, { table: null, notice: { ...refusedOff.notice, refusal: { code: 'no_permission' as const } } }, ROOM)).toBe(false);
        expect(gamesRowContradicted(false, { table: { room_id: 'voice_7' }, notice: null }, ROOM)).toBe(false);
        expect(gamesRowContradicted(true, { ...endedOff, notice: { ...endedOff.notice, room_id: 'voice_7' } }, ROOM)).toBe(false);
        expect(gamesRowContradicted(false, tableHere, null)).toBe(false);
        expect(gamesRowContradicted(true, { table: null, notice: null }, ROOM)).toBe(false);
    });
});

describe('Hold\'em action bar', () => {
    it('the seat to act on the flop with nothing to call: Check, a Bet from the big blind to all-in', () => {
        const v = holdem(seated);
        expect(holdemBar(v)).toEqual({
            check: true,
            call: null,
            callIsAllIn: false,
            raise: { verb: 'Bet', min: 10, max: 990, onlyAllIn: false },
        });
    });

    it('no bar for a spectator, or for a seat whose turn it is not', () => {
        expect(holdemBar(holdem(spectator))).toBeNull();
        const v = holdem(seated);
        expect(holdemBar({ ...v, to_act: 0 })).toBeNull();
        expect(holdemBar({ ...v, legal: null })).toBeNull();
    });

    it('facing a bet: Call the amount, Raise from min to all-in', () => {
        const v = holdem(seated);
        const facing: HoldemView = {
            ...v,
            current_bet: 40,
            pot_total: 70,
            legal: { to_call: 40, can_check: false, call_amount: 40, can_raise: true, min_raise_to: 80, max_raise_to: 990 },
        };
        expect(holdemBar(facing)).toMatchObject({ check: false, call: 40, callIsAllIn: false, raise: { verb: 'Raise', min: 80, max: 990 } });
    });

    it('a call that takes the whole stack is an all-in call; a raise that cannot reopen is not offered', () => {
        const v = holdem(seated);
        const short: HoldemView = {
            ...v,
            current_bet: 2000,
            legal: { to_call: 2000, can_check: false, call_amount: 990, can_raise: false, min_raise_to: 990, max_raise_to: 990 },
        };
        expect(holdemBar(short)).toEqual({ check: false, call: 990, callIsAllIn: true, raise: null });
        expect(raisePresets(short)).toEqual([]);
    });

    it('a stack short of a full raise: the only raise is all-in', () => {
        const v = holdem(seated);
        const l = { to_call: 40, can_check: false, call_amount: 40, can_raise: true, min_raise_to: 60, max_raise_to: 60 };
        expect(holdemBar({ ...v, current_bet: 40, legal: l })?.raise).toMatchObject({ onlyAllIn: true });
        // …and it goes as all_in: bet_or_raise_to(60) would be below the minimum raise.
        expect(raiseAction(60, l)).toEqual({ type: 'all_in' });
    });
});

describe('raise presets (street TOTALS)', () => {
    it('flop, nothing bet, pot 30: min 10, half pot 15, pot 30, all-in 990', () => {
        expect(raisePresets(holdem(seated)).map(p => [p.id, p.amount])).toEqual([
            ['min', 10], ['half_pot', 15], ['pot', 30], ['all_in', 990],
        ]);
    });

    it('facing 40 into 70 (to_call 40): pot raise = 40 + (70 + 40) = 150, half = 40 + 55 = 95', () => {
        const v = holdem(seated);
        const facing: HoldemView = {
            ...v,
            current_bet: 40,
            pot_total: 70,
            legal: { to_call: 40, can_check: false, call_amount: 40, can_raise: true, min_raise_to: 80, max_raise_to: 990 },
        };
        expect(raisePresets(facing).map(p => p.amount)).toEqual([80, 95, 150, 990]);
    });

    it('an odd pot rounds the half down, and every preset is clamped to [min, all-in]', () => {
        const v = holdem(seated);
        const odd: HoldemView = {
            ...v, current_bet: 10, pot_total: 25,
            legal: { to_call: 10, can_check: false, call_amount: 10, can_raise: true, min_raise_to: 20, max_raise_to: 40 },
        };
        // half: 10 + floor(35/2)=27; pot: 10 + 35 = 45 -> clamped to 40
        expect(raisePresets(odd).map(p => p.amount)).toEqual([20, 27, 40, 40]);
        const tiny: HoldemView = { ...odd, pot_total: 0, legal: { ...odd.legal!, to_call: 0, min_raise_to: 20 } };
        // half: 10 + 0 = 10 -> clamped up to the minimum 20
        expect(raisePresets(tiny)[1].amount).toBe(20);
    });

    it('the stepper moves by one big blind and stays inside [min, all-in]', () => {
        const v = holdem(seated);
        expect(stepRaise(10, 1, v)).toBe(20);
        expect(stepRaise(10, -1, v)).toBe(10);
        expect(stepRaise(985, 1, v)).toBe(990);
        expect(clampRaise(Number.NaN, v.legal!)).toBe(10);
        expect(clampRaise(12.7, v.legal!)).toBe(12);
    });

    it('raiseAction: below all-in is bet_or_raise_to the total; the all-in total is all_in', () => {
        const l = holdem(seated).legal!;
        expect(raiseAction(30, l)).toEqual({ type: 'bet_or_raise_to', amount: 30 });
        expect(raiseAction(990, l)).toEqual({ type: 'all_in' });
        expect(raiseAction(5000, l)).toEqual({ type: 'all_in' });
        expect(raiseAction(1, l)).toEqual({ type: 'bet_or_raise_to', amount: 10 });
    });

    it('busted: no chips and no live hand', () => {
        const v = holdem(seated);
        expect(holdemBusted(v)).toBe(false);
        const seats = v.seats.map(s => (s && s.seat === 2 ? { ...s, stack: 0, status: 'waiting' as const, cards: null } : s));
        expect(holdemBusted({ ...v, in_hand: false, seats })).toBe(true);
        const allIn = v.seats.map(s => (s && s.seat === 2 ? { ...s, stack: 0, status: 'all_in' as const } : s));
        expect(holdemBusted({ ...v, seats: allIn })).toBe(false);
    });
});

describe('Blackjack controls', () => {
    it('the seat to act: its turn and hand', () => {
        const v = blackjack(blackjackTable);
        expect(blackjackMyTurn(v)).toEqual({ hand: 0 });
        expect(blackjackMyTurn({ ...v, viewer_seat: 1, legal: null })).toBeNull();
    });

    it('no bet mid-round; between rounds the range is [min_bet, min(max_bet, stack + pending)]', () => {
        const v = blackjack(blackjackTable);
        expect(betRange(v).open).toBe(false);
        const between: BlackjackView = { ...v, in_round: false };
        expect(betRange(between)).toEqual({ min: 10, max: 500, open: true });
        const poor = { ...between, seats: between.seats.map(s => (s && s.seat === 0 ? { ...s, stack: 100, pending_bet: 50 } : s)) };
        expect(betRange(poor)).toEqual({ min: 10, max: 150, open: true });
        expect(betPresets(poor)).toEqual([10, 50, 150]);
        expect(clampBet(9999, betRange(poor))).toBe(150);
        expect(betPresets(between)).toEqual([10, 50, 250, 500]);
    });

    it('busted below the minimum bet: rebuy offered, no bet', () => {
        const v = blackjack(blackjackTable);
        const broke: BlackjackView = { ...v, in_round: false, seats: v.seats.map(s => (s && s.seat === 0 ? { ...s, stack: 5, pending_bet: 0, hands: [] } : s)) };
        expect(blackjackBusted(broke)).toBe(true);
        expect(betRange(broke).open).toBe(false);
        expect(blackjackBusted({ ...broke, seats: v.seats })).toBe(false);
    });
});

describe('opening a table', () => {
    it('sends only the chosen game\'s fields (the other game\'s are refused, not ignored)', () => {
        const f = defaultForm();
        expect(configFor('holdem', f)).toEqual({ starting_stack: 1000, small_blind: 5, big_blind: 10 });
        expect(configFor('blackjack', f)).toEqual({ starting_stack: 1000, min_bet: 10, max_bet: 500 });
    });

    it('the defaults are valid; the engine\'s limits are said before the server refuses', () => {
        const f = defaultForm();
        expect(formProblem('holdem', f)).toBeNull();
        expect(formProblem('blackjack', f)).toBeNull();
        expect(formProblem('holdem', { ...f, big_blind: 4 })).toMatch(/big blind/);
        expect(formProblem('holdem', { ...f, starting_stack: 8 })).toMatch(/cover the big blind/);
        expect(formProblem('holdem', { ...f, small_blind: 0 })).toMatch(/small blind/);
        expect(formProblem('holdem', { ...f, starting_stack: 1_000_000_001 })).toMatch(/starting stack/);
        expect(formProblem('blackjack', { ...f, max_bet: 5 })).toMatch(/maximum bet/);
        expect(formProblem('blackjack', { ...f, starting_stack: 9 })).toMatch(/cover the minimum bet/);
        expect(formProblem('blackjack', { ...f, min_bet: Number.NaN })).toMatch(/minimum bet/);
        // A blackjack form is not judged on the blinds it does not send.
        expect(formProblem('blackjack', { ...f, small_blind: 0 })).toBeNull();
    });
});

describe('words', () => {
    it('every refusal in the contract has its own words, never the raw code', () => {
        const seen = new Set<string>();
        for (const r of refusals) {
            const f = frame(r);
            if (f.type !== 'GameRefused') throw new Error('refusal');
            const text = refusalText(f.op, f.refusal, null);
            expect(text.length, f.refusal.code).toBeGreaterThan(5);
            expect(text).not.toContain('_');
            seen.add(text);
        }
        // Distinct codes say distinct things (a copy-paste would collapse two).
        expect(seen.size).toBeGreaterThanOrEqual(refusals.length - 2);
    });

    it('one table per call says the owner\'s sentence', () => {
        expect(refusalText('create', { code: 'room_has_table', open_table_id: 5, kind: 'holdem' }, null))
            .toBe('A Poker table is already open in this call; it has to close before another game can start.');
        expect(refusalText('create', { code: 'room_has_table', open_table_id: 5, kind: 'blackjack' }, null)).toMatch(/^A Blackjack table/);
    });

    it('a minimum is worded per game', () => {
        expect(refusalText('act', { code: 'bet_below_minimum', min: 80 }, 'holdem')).toBe('The smallest raise here is to 80.');
        expect(refusalText('bet', { code: 'bet_below_minimum', min: 10 }, 'blackjack')).toBe('The minimum bet is 10.');
    });

    it('every end reason, and an unknown one, has words', () => {
        for (const e of ended) {
            const f = frame(e);
            if (f.type !== 'GameEnded') throw new Error('ended');
            expect(endText(f.reason)).toMatch(/\.$/);
        }
        expect(endText('other')).toBe('The table closed.');
    });

    it('the event fixtures word without a code leaking, and a showdown names categories, never cards', () => {
        const name = (s: number) => `P${s}`;
        for (const raw of [...holdemEvents, ...blackjackEvents]) {
            const f = frame(raw);
            if (f.type !== 'GameEvents') throw new Error('events');
            for (const e of f.events) {
                const line = eventLine(e, f.view.game, name, (u) => `U${u}`);
                if (line !== null) {
                    expect(line).not.toMatch(/_/);
                    expect(line).not.toMatch(/\b[2-9TJQKA][cdhs]\b/);
                }
            }
        }
        const sd = frame(holdemEvents[3]);
        if (sd.type !== 'GameEvents' || sd.view.game !== 'holdem') throw new Error('showdown');
        const showdown = (sd.events as { type: string }[]).find(e => e.type === 'showdown')!;
        expect(eventLine(showdown as never, 'holdem', name, String)).toMatch(/shows .+, P\d mucks\.$/);
    });
});
