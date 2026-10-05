/**
 * The games wire contract, client side (src/api/games/protocol.ts), pinned to
 * the SAME fixtures the server's tests pin `ServerMessage` / `ClientMessage`
 * to (src/protocol.rs, games_frame_tests). The table fixtures are what a real
 * engine table dealt from a fixed seed serialises to, so these tests read
 * exactly what the server will send.
 */
import { describe, it, expect } from 'vitest';
import clientFrames from './fixtures/games/client-frames.json';
import seated from './fixtures/games/holdem-table-seated.json';
import spectator from './fixtures/games/holdem-table-spectator.json';
import holdemEvents from './fixtures/games/holdem-events.json';
import blackjackTable from './fixtures/games/blackjack-table.json';
import blackjackEvents from './fixtures/games/blackjack-events.json';
import refusals from './fixtures/games/refusals.json';
import ended from './fixtures/games/ended.json';
import {
    GAME_END_REASONS,
    GAME_OPS,
    GAMES_FEATURE,
    HIDDEN_CARD,
    PLAIN_REFUSAL_CODES,
    gameFrames,
    parseGameFrame,
    versionStep,
    type BlackjackEvent,
    type GameServerFrame,
    type HoldemEvent,
} from '../api/games/protocol';
import { CLIENT_CAPS } from '../api/websocket';

type Raw = { type: string; payload: Record<string, unknown> };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const parse = (raw: unknown) => parseGameFrame(raw as Raw);
const TABLE = 4503599627370497; // 2^52 + 1, as in the fixtures
const ROOM = 'voice_42';

/** Every real card code anywhere in a value ('??' excluded). */
function cardsIn(v: unknown, out = new Set<string>()): Set<string> {
    if (typeof v === 'string' && /^[2-9TJQKA][cdhs]$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach((x) => cardsIn(x, out));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => cardsIn(x, out));
    return out;
}

function must(f: GameServerFrame | null): GameServerFrame {
    expect(f).not.toBeNull();
    return f!;
}

/** A GameEvents frame's events (the view's `game` says which list it is). */
function holdemEventsOf(f: GameServerFrame): HoldemEvent[] {
    if (f.type !== 'GameEvents' || f.view.game !== 'holdem') throw new Error('not Hold\'em events');
    return f.events as HoldemEvent[];
}
function blackjackEventsOf(f: GameServerFrame): BlackjackEvent[] {
    if (f.type !== 'GameEvents' || f.view.game !== 'blackjack') throw new Error('not Blackjack events');
    return f.events as BlackjackEvent[];
}

describe('client frames are exactly what the server parses', () => {
    it('every builder produces its fixture entry', () => {
        const turn = { hand_no: 3, turn_seq: 7 };
        const built = [
            gameFrames.create(ROOM, 'holdem', { starting_stack: 1000, small_blind: 5, big_blind: 10 }),
            gameFrames.create(ROOM, 'blackjack', { starting_stack: 1000, min_bet: 10, max_bet: 500 }),
            gameFrames.create(ROOM, 'holdem'),
            gameFrames.sit(ROOM, TABLE, 2),
            gameFrames.stand(ROOM, TABLE),
            gameFrames.act(ROOM, TABLE, turn, { type: 'fold' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'check' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'call' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'bet_or_raise_to', amount: 60 }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'all_in' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'hit' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'stand' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'double' }),
            gameFrames.act(ROOM, TABLE, turn, { type: 'split' }),
            gameFrames.bet(ROOM, TABLE, 50),
            gameFrames.clearBet(ROOM, TABLE),
            gameFrames.sitOut(ROOM, TABLE),
            gameFrames.sitIn(ROOM, TABLE),
            gameFrames.rebuy(ROOM, TABLE),
            gameFrames.showCards(ROOM, TABLE),
            gameFrames.resync(ROOM, TABLE),
            gameFrames.close(ROOM, TABLE),
            gameFrames.removePlayer(ROOM, TABLE, 4),
        ];
        expect(built).toHaveLength(clientFrames.length);
        built.forEach((b, i) => expect(JSON.parse(JSON.stringify(b)), `#${i} ${b.type}`).toEqual(clientFrames[i]));
    });

    it('act sends only the TurnRef, not whatever else the view object carried', () => {
        const extra = { hand_no: 1, turn_seq: 2, extra: 'x' } as unknown as { hand_no: number; turn_seq: number };
        const f = gameFrames.act(ROOM, 5, extra, { type: 'call' });
        expect(f.payload).toEqual({ room_id: ROOM, table_id: 5, turn: { hand_no: 1, turn_seq: 2 }, action: { type: 'call' } });
    });

    it('the client announces games in its ONE caps list', () => {
        expect(CLIENT_CAPS).toContain(GAMES_FEATURE);
        expect(GAMES_FEATURE).toBe('games');
    });
});

describe('server frames parse from the fixtures', () => {
    it('a seated Hold\'em view: the viewer\'s own two cards, everyone else face down, and what it may do', () => {
        const f = must(parse(seated));
        expect(f.type).toBe('GameTable');
        if (f.type !== 'GameTable' || f.view.game !== 'holdem') throw new Error('not a holdem table');
        expect(f.table_id).toBe(TABLE);
        expect(f.room_id).toBe(ROOM);
        const me = f.view.viewer_seat!;
        expect(me).not.toBeNull();
        const mine = f.view.seats[me]!.cards!;
        expect(mine).toHaveLength(2);
        expect(mine.every((c) => c !== HIDDEN_CARD)).toBe(true);
        for (const s of f.view.seats) {
            if (s && s.seat !== me) expect(s.cards).toEqual([HIDDEN_CARD, HIDDEN_CARD]);
        }
        expect(f.view.to_act).toBe(me);
        expect(f.view.legal).not.toBeNull();
        expect(f.view.turn).toEqual({ hand_no: 1, turn_seq: 4 });
        expect(f.view.board).toHaveLength(3);
        expect(f.view.seats).toHaveLength(f.view.config.max_seats);
        expect(f.view.config).toMatchObject({ max_seats: 6, starting_stack: 1000, small_blind: 5, big_blind: 10 });
    });

    it('a spectator holds no card but the board', () => {
        const f = must(parse(spectator));
        if (f.type !== 'GameTable' || f.view.game !== 'holdem') throw new Error('not a holdem table');
        expect(f.view.viewer_seat).toBeNull();
        expect(f.view.legal).toBeNull();
        expect(cardsIn(f)).toEqual(new Set(f.view.board));
        expect(cardsIn(spectator)).toEqual(new Set(f.view.board)); // and so does the raw frame
        expect(f.view.seats.filter((s) => s?.away).map((s) => s!.seat)).toEqual([4]);
        // The same moment as the seated fixture.
        expect(f.version).toBe((seated as Raw).payload.version);
    });

    it('Hold\'em events, a showdown included, parse whole', () => {
        const frames = (holdemEvents as Raw[]).map((r) => must(parse(r)));
        frames.forEach((f, i) => {
            if (f.type !== 'GameEvents') throw new Error('not events');
            // No known event was dropped on the way.
            expect(f.events).toHaveLength(((holdemEvents as Raw[])[i].payload.events as unknown[]).length);
        });
        const all = frames.flatMap(holdemEventsOf);
        const showdown = all.find((e) => e.type === 'showdown');
        expect(showdown).toBeDefined();
        if (showdown?.type !== 'showdown') throw new Error('no showdown');
        expect(showdown.shown.length).toBeGreaterThan(0);
        expect(showdown.mucked.length).toBeGreaterThan(0);
        expect(showdown.shown.every((h) => h.cards.length === 2 && !h.cards.includes(HIDDEN_CARD))).toBe(true);
        expect(all.map((e) => e.type)).toEqual(
            expect.arrayContaining(['player_sat', 'hand_started', 'blind_posted', 'acted', 'board_dealt', 'showdown', 'pot_awarded', 'hand_ended', 'shown']),
        );
        // Versions climb.
        const versions = frames.map((f) => (f.type === 'GameEvents' ? f.version : -1));
        expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    });

    it('a Blackjack view keeps the hole card face down, and only the player to act sees what they may do', () => {
        const f = must(parse(blackjackTable));
        if (f.type !== 'GameTable' || f.view.game !== 'blackjack') throw new Error('not a blackjack table');
        expect(f.view.dealer).toHaveLength(2);
        expect(f.view.dealer[1]).toBe(HIDDEN_CARD);
        expect(f.view.dealer[0]).not.toBe(HIDDEN_CARD);
        expect(f.view.dealer_total).toBeNull();
        expect(f.view.viewer_seat).toBe(f.view.to_act!.seat);
        expect(f.view.legal).not.toBeNull();
        expect(f.view.config).toMatchObject({ decks: 6, dealer_hits_soft_17: false, blackjack_pays: [3, 2], max_hands: 4, resplit_aces: false });
    });

    it('Blackjack events parse whole, the hole card dealt as ?? and named only on the reveal', () => {
        const frames = (blackjackEvents as Raw[]).map((r) => must(parse(r)));
        const all = frames.flatMap(blackjackEventsOf);
        expect(all.length).toBe((blackjackEvents as Raw[]).reduce((n, r) => n + (r.payload.events as unknown[]).length, 0));
        const hole = all.find((e) => e.type === 'card_dealt' && e.seat === null && e.card === HIDDEN_CARD);
        expect(hole).toBeDefined();
        const revealed = all.find((e) => e.type === 'dealer_revealed');
        expect(revealed?.type === 'dealer_revealed' && revealed.card !== HIDDEN_CARD).toBe(true);
    });

    it('every refusal parses to its own code, and the fixture covers every code and every op', () => {
        const parsed = (refusals as Raw[]).map((r) => must(parse(r)));
        const codes = new Set<string>();
        const ops = new Set<string>();
        parsed.forEach((f, i) => {
            if (f.type !== 'GameRefused') throw new Error('not a refusal');
            expect(f.refusal.code, `#${i}`).toBe((refusals as Raw[])[i].payload.code);
            codes.add(f.refusal.code);
            ops.add(f.op);
        });
        expect(codes).toEqual(
            new Set([
                ...PLAIN_REFUSAL_CODES,
                'room_has_table',
                'bet_below_minimum',
                'cannot_check',
                'bet_above_stack',
                'bet_above_maximum',
                'insufficient_chips',
            ]),
        );
        expect(ops).toEqual(new Set(GAME_OPS));
        const roomHas = parsed.find((f) => f.type === 'GameRefused' && f.refusal.code === 'room_has_table');
        expect(roomHas).toEqual({
            type: 'GameRefused',
            room_id: ROOM,
            table_id: null,
            op: 'create',
            refusal: { code: 'room_has_table', open_table_id: TABLE, kind: 'holdem' },
        });
    });

    it('every ending parses, and the fixture covers every reason', () => {
        const reasons = (ended as Raw[]).map((r) => {
            const f = must(parse(r));
            if (f.type !== 'GameEnded') throw new Error('not an ending');
            return f.reason;
        });
        expect(new Set(reasons)).toEqual(new Set(GAME_END_REASONS));
    });
});

describe('junk is refused, and what a newer server may add is tolerated', () => {
    const holdem = () => clone(seated) as Raw & { payload: { view: Record<string, unknown> & { seats: (Record<string, unknown> | null)[] } } };

    it('positive control: the unmodified fixtures parse', () => {
        for (const f of [seated, spectator, blackjackTable, ...holdemEvents, ...blackjackEvents, ...refusals, ...ended]) {
            expect(parse(f)).not.toBeNull();
        }
    });

    it.each([
        ['a ten written 10', (f: ReturnType<typeof holdem>) => (f.payload.view.board as string[]).splice(0, 1, '10h')],
        ['a face-down card on the board', (f: ReturnType<typeof holdem>) => (f.payload.view.board as string[]).splice(0, 1, '??')],
        ['a lowercase rank', (f: ReturnType<typeof holdem>) => (f.payload.view.board as string[]).splice(0, 1, 'ah')],
        ['three hole cards', (f: ReturnType<typeof holdem>) => (f.payload.view.seats[2]!.cards as string[]).push('2c')],
        ['a table id beyond 2^53', (f: ReturnType<typeof holdem>) => (f.payload.table_id = 2 ** 53 + 2)],
        ['table id 0', (f: ReturnType<typeof holdem>) => (f.payload.table_id = 0)],
        ['a table id as a string', (f: ReturnType<typeof holdem>) => (f.payload.table_id = String(TABLE))],
        ['a fractional version', (f: ReturnType<typeof holdem>) => (f.payload.version = 1.5)],
        ['a negative version', (f: ReturnType<typeof holdem>) => (f.payload.version = -1)],
        ['no version', (f: ReturnType<typeof holdem>) => delete (f.payload as Record<string, unknown>).version],
        ['no view', (f: ReturnType<typeof holdem>) => delete (f.payload as Record<string, unknown>).view],
        ['an unknown game', (f: ReturnType<typeof holdem>) => (f.payload.view.game = 'omaha')],
        ['a text room', (f: ReturnType<typeof holdem>) => (f.payload.room_id = 'text_42')],
        ['a seat missing', (f: ReturnType<typeof holdem>) => f.payload.view.seats.pop()],
        ['a seat out of place', (f: ReturnType<typeof holdem>) => (f.payload.view.seats[2]!.seat = 3)],
        ['a viewer seat off the table', (f: ReturnType<typeof holdem>) => (f.payload.view.viewer_seat = 6)],
        ['an unknown seat status', (f: ReturnType<typeof holdem>) => (f.payload.view.seats[0]!.status = 'dancing')],
        ['a legal action set missing a field', (f: ReturnType<typeof holdem>) => delete (f.payload.view.legal as Record<string, unknown>).min_raise_to],
        ['a stack as a string', (f: ReturnType<typeof holdem>) => (f.payload.view.seats[0]!.stack = '990')],
        ['no payload', (f: ReturnType<typeof holdem>) => delete (f as { payload?: unknown }).payload],
    ])('refuses %s', (_why, mutate) => {
        const f = holdem();
        mutate(f);
        expect(parse(f)).toBeNull();
    });

    it('refuses a face-down card anywhere but a seat\'s hidden hand or the dealer\'s hole card', () => {
        const ev = clone(holdemEvents) as Raw[];
        const sd = (ev[3].payload.events as Record<string, unknown>[]).find((e) => e.type === 'showdown')!;
        ((sd.shown as Record<string, unknown>[])[0].cards as string[])[0] = '??';
        expect(parse(ev[3])).toBeNull();

        const bj = clone(blackjackEvents) as Raw[];
        const deal = bj[1].payload.events as Record<string, unknown>[];
        const toSeat = deal.find((e) => e.type === 'card_dealt' && e.seat !== null)!;
        toSeat.card = '??';
        expect(parse(bj[1])).toBeNull();

        const bj2 = clone(blackjackEvents) as Raw[];
        const last = bj2[bj2.length - 1].payload.events as Record<string, unknown>[];
        last.find((e) => e.type === 'dealer_revealed')!.card = '??';
        expect(parse(bj2[bj2.length - 1])).toBeNull();

        const table = clone(blackjackTable) as Raw & { payload: { view: { seats: { hands: { cards: string[] }[] }[] } } };
        table.payload.view.seats[0].hands[0].cards[0] = '??';
        expect(parse(table)).toBeNull();
    });

    it('a malformed KNOWN event drops the frame; an UNKNOWN event type is skipped', () => {
        const bad = clone(holdemEvents) as Raw[];
        (bad[1].payload.events as Record<string, unknown>[])[0].hand_no = 'one';
        expect(parse(bad[1])).toBeNull();

        const newer = clone(holdemEvents) as Raw[];
        const events = newer[1].payload.events as Record<string, unknown>[];
        events.push({ type: 'confetti', seat: 0 });
        const f = must(parse(newer[1]));
        if (f.type !== 'GameEvents') throw new Error('not events');
        expect(f.events).toHaveLength(events.length - 1);
        expect(f.events.map((e) => e.type)).not.toContain('confetti');
    });

    it('an unknown refusal code, op or end reason reads as other (the table still ends)', () => {
        const r = clone((refusals as Raw[])[0]);
        r.payload.code = 'too_much_fun';
        r.payload.op = 'juggle';
        const f = must(parse(r));
        expect(f.type === 'GameRefused' && f.refusal.code === 'other' && f.op === 'other').toBe(true);

        const e = clone((ended as Raw[])[0]);
        e.payload.reason = 'meteor';
        const g = must(parse(e));
        expect(g.type === 'GameEnded' && g.reason === 'other').toBe(true);

        // ...but a refusal or ending with no code / reason at all is junk.
        const noCode = clone((refusals as Raw[])[0]);
        delete noCode.payload.code;
        expect(parse(noCode)).toBeNull();
        const noReason = clone((ended as Raw[])[0]);
        delete noReason.payload.reason;
        expect(parse(noReason)).toBeNull();
    });

    it('a refusal echoes the refused frame\'s room, even one that is not a voice room', () => {
        const r = clone((refusals as Raw[]).find((x) => x.payload.code === 'not_a_voice_room')!);
        r.payload.room_id = 'text_5';
        const f = must(parse(r));
        expect(f.type === 'GameRefused' && f.room_id === 'text_5' && f.refusal.code === 'not_a_voice_room').toBe(true);
        r.payload.room_id = 5;
        expect(parse(r)).toBeNull();
    });

    it('a refusal\'s numbers are checked like any other', () => {
        const r = clone((refusals as Raw[]).find((x) => x.payload.code === 'bet_below_minimum')!);
        r.payload.min = -40;
        expect(parse(r)).toBeNull();
    });

    it('a frame that is not a games frame is not parsed', () => {
        expect(parse({ type: 'ServerFeatures', payload: { features: ['games'] } })).toBeNull();
        expect(parse({ type: 'Error', payload: { message: 'x' } })).toBeNull();
    });

    it('the live pots parse; an older server that sends none reads as no breakdown; a bad pot drops the frame', () => {
        const f = parse(seated) as Extract<GameServerFrame, { type: 'GameTable' }>;
        expect(f.view.game === 'holdem' && f.view.pots).toEqual([{ amount: 30, eligible: [0, 2, 4] }]);
        const old = holdem();
        delete (old.payload.view as Record<string, unknown>).pots;
        const parsed = parse(old) as Extract<GameServerFrame, { type: 'GameTable' }>;
        expect(parsed).not.toBeNull();
        expect(parsed.view.game === 'holdem' && parsed.view.pots).toEqual([]);
        for (const bad of [
            [{ amount: -1, eligible: [0] }],
            [{ amount: 10, eligible: [6] }], // max_seats is 6
            [{ amount: 10 }],
            { amount: 10, eligible: [0] },
        ]) {
            const b = holdem();
            (b.payload.view as Record<string, unknown>).pots = bad;
            expect(parse(b), JSON.stringify(bad)).toBeNull();
        }
    });

    it('unknown fields are ignored', () => {
        const f = holdem();
        (f.payload as Record<string, unknown>).later = true;
        f.payload.view.seats[0]!.mood = 'happy';
        expect(parse(f)).not.toBeNull();
    });
});

describe('versionStep', () => {
    it('applies the next version, ignores old ones, and flags a gap', () => {
        expect(versionStep(null, 7, 'GameEvents')).toBe('apply');
        expect(versionStep(null, 7, 'GameTable')).toBe('apply');
        expect(versionStep(7, 8, 'GameEvents')).toBe('apply');
        expect(versionStep(7, 7, 'GameEvents')).toBe('ignore');
        expect(versionStep(7, 3, 'GameEvents')).toBe('ignore');
        expect(versionStep(7, 10, 'GameEvents')).toBe('apply_after_gap');
        // A snapshot at the held version (a resync answer) still applies.
        expect(versionStep(7, 7, 'GameTable')).toBe('apply');
        expect(versionStep(7, 9, 'GameTable')).toBe('apply');
        expect(versionStep(7, 6, 'GameTable')).toBe('ignore');
    });
});
