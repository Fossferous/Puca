/**
 * The games wire contract, client side: Poker and Blackjack in a voice call
 * (docs/GAMES.md, *Frames*).
 *
 * The server is the source of truth (src/games_wire.rs and the Game* variants
 * of src/protocol.rs). Both sides are pinned to the SAME files,
 * src/tests/fixtures/games/*.json: the server's tests serialise real engine
 * tables and compare them with the fixtures, and gamesProtocol.test.ts parses
 * the same fixtures here and checks the builders produce client-frames.json.
 *
 * Field names stay exactly as on the wire (snake_case): one spelling per
 * field across Rust, JSON and TypeScript, nothing to translate.
 *
 * Parsing is strict about what the server must get right and lenient about
 * what a NEWER server may add:
 *   - a frame with a missing or ill-typed field, a malformed card code, a
 *     hidden card where none can be, or a table id that is not a safe
 *     integer parses to `null` (drop it; GameResync if it mattered);
 *   - an event `type` this client does not know is skipped, a refusal `code`,
 *     `op` or end `reason` it does not know reads as `'other'` (a newer
 *     server's ending must still end the table here), unknown fields are
 *     ignored.
 *
 * Send nothing from here until `wsClient.hasServerFeature(GAMES_FEATURE)`:
 * an older server answers an unknown frame with an Error, which the chat view
 * shows as an alert.
 */

/** The capability name in `/ws?caps=` and `ServerFeatures`. */
export const GAMES_FEATURE = 'games';

/** A face-down card. Two characters, like every card code. */
export const HIDDEN_CARD = '??';

export type GameKind = 'holdem' | 'blackjack';
/** `Ah`, `Td`, `2c` (ten is `T`), or {@link HIDDEN_CARD}. */
export type CardCode = string;

export interface TurnRef {
    hand_no: number;
    turn_seq: number;
}

// ---------------------------------------------------------------------------
// Client -> server

/** The opener's settings; everything omitted is the server's default. */
export interface GameConfigInput {
    starting_stack?: number;
    /** Hold'em only. */
    small_blind?: number;
    /** Hold'em only. */
    big_blind?: number;
    /** Blackjack only. */
    min_bet?: number;
    /** Blackjack only. */
    max_bet?: number;
}

export type HoldemAction =
    | { type: 'fold' }
    | { type: 'check' }
    | { type: 'call' }
    /** The street TOTAL ("raise to 60"), never an increment. */
    | { type: 'bet_or_raise_to'; amount: number }
    | { type: 'all_in' };
/** `stand` here is the Blackjack action, NOT the GameStand frame. */
export type BlackjackAction = { type: 'hit' } | { type: 'stand' } | { type: 'double' } | { type: 'split' };
export type GameAction = HoldemAction | BlackjackAction;

interface TableRef {
    room_id: string;
    table_id: number;
}

export type GameClientFrame =
    | { type: 'GameCreate'; payload: { room_id: string; kind: GameKind; config: GameConfigInput } }
    | { type: 'GameSit'; payload: TableRef & { seat: number } }
    | { type: 'GameStand'; payload: TableRef }
    | { type: 'GameAct'; payload: TableRef & { turn: TurnRef; action: GameAction } }
    | { type: 'GameBet'; payload: TableRef & { amount: number } }
    | { type: 'GameClearBet'; payload: TableRef }
    | { type: 'GameSitOut'; payload: TableRef }
    | { type: 'GameSitIn'; payload: TableRef }
    | { type: 'GameRebuy'; payload: TableRef }
    | { type: 'GameShowCards'; payload: TableRef }
    | { type: 'GameResync'; payload: TableRef }
    | { type: 'GameClose'; payload: TableRef }
    | { type: 'GameRemovePlayer'; payload: TableRef & { seat: number } };

/** Builders for every client frame, exactly as the server parses them. */
export const gameFrames = {
    /** Open a table in this call (`voice_<channel_id>`). */
    create: (room_id: string, kind: GameKind, config: GameConfigInput = {}): GameClientFrame => ({
        type: 'GameCreate',
        payload: { room_id, kind, config: { ...config } },
    }),
    sit: (room_id: string, table_id: number, seat: number): GameClientFrame => ({
        type: 'GameSit',
        payload: { room_id, table_id, seat },
    }),
    /** Get up from the table. */
    stand: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameStand', payload: { room_id, table_id } }),
    /** Answer the decision `turn` (the view's `turn`, as shown). */
    act: (room_id: string, table_id: number, turn: TurnRef, action: GameAction): GameClientFrame => ({
        type: 'GameAct',
        payload: { room_id, table_id, turn: { hand_no: turn.hand_no, turn_seq: turn.turn_seq }, action: { ...action } },
    }),
    /** Blackjack: bet on the next round. */
    bet: (room_id: string, table_id: number, amount: number): GameClientFrame => ({
        type: 'GameBet',
        payload: { room_id, table_id, amount },
    }),
    clearBet: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameClearBet', payload: { room_id, table_id } }),
    sitOut: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameSitOut', payload: { room_id, table_id } }),
    sitIn: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameSitIn', payload: { room_id, table_id } }),
    rebuy: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameRebuy', payload: { room_id, table_id } }),
    /** Hold'em, after the hand. */
    showCards: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameShowCards', payload: { room_id, table_id } }),
    resync: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameResync', payload: { room_id, table_id } }),
    /** MOVE_MEMBERS. */
    close: (room_id: string, table_id: number): GameClientFrame => ({ type: 'GameClose', payload: { room_id, table_id } }),
    /** MOVE_MEMBERS. */
    removePlayer: (room_id: string, table_id: number, seat: number): GameClientFrame => ({
        type: 'GameRemovePlayer',
        payload: { room_id, table_id, seat },
    }),
};

// ---------------------------------------------------------------------------
// Server -> client: views

export type HoldemStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type HoldemSeatStatus = 'waiting' | 'sitting_out' | 'in_hand' | 'folded' | 'all_in';

export interface HoldemConfig {
    max_seats: number;
    starting_stack: number;
    small_blind: number;
    big_blind: number;
    turn_clock_secs: number;
    timeouts_before_sit_out: number;
    allow_rebuy: boolean;
}

export interface HoldemSeat {
    seat: number;
    user_id: number;
    stack: number;
    status: HoldemSeatStatus;
    street_commit: number;
    hand_commit: number;
    /** null: not in the live hand. `['??','??']`: in it, face down. Real
     *  codes: the viewer's own hand, or a shown one. */
    cards: CardCode[] | null;
    sitting_out: boolean;
    leaving: boolean;
    /** Dropped out of the call; inside the disconnect grace. */
    away: boolean;
}

export interface HoldemLegal {
    to_call: number;
    can_check: boolean;
    call_amount: number;
    can_raise: boolean;
    min_raise_to: number;
    max_raise_to: number;
}

/** A live pot: pot 0 is the main pot, every one after it a side pot. */
export interface HoldemPot {
    amount: number;
    /** The seats that can still win it, in seat order. */
    eligible: number[];
}

export interface HoldemView {
    game: 'holdem';
    viewer_seat: number | null;
    config: HoldemConfig;
    hand_no: number;
    in_hand: boolean;
    street: HoldemStreet | null;
    button: number | null;
    small_blind_seat: number | null;
    big_blind_seat: number | null;
    /** `config.max_seats` entries; null is an empty seat. */
    seats: (HoldemSeat | null)[];
    board: CardCode[];
    /** Everything put in this hand, this street's bets included. */
    pot_total: number;
    /** The main pot and the side pots from the streets that have closed
     *  (this street's bets are each seat's `street_commit`); empty between
     *  hands. An older server sends none: read as `[]` (show the total). */
    pots: HoldemPot[];
    current_bet: number;
    to_act: number | null;
    turn: TurnRef | null;
    /** Only when it is the viewer's turn. */
    legal: HoldemLegal | null;
    /** Milliseconds left on the current turn's clock. */
    clock_ms: number | null;
    /** Milliseconds until the next deal, when one is scheduled. */
    next_deal_in_ms: number | null;
}

export type BlackjackOutcome = 'blackjack' | 'win' | 'push' | 'lose';

export interface BlackjackConfig {
    max_seats: number;
    starting_stack: number;
    min_bet: number;
    max_bet: number;
    decks: number;
    penetration_percent: number;
    dealer_hits_soft_17: boolean;
    blackjack_pays: [number, number];
    double_after_split: boolean;
    max_hands: number;
    resplit_aces: boolean;
    turn_clock_secs: number;
    timeouts_before_sit_out: number;
    allow_rebuy: boolean;
}

export interface BlackjackHand {
    cards: CardCode[];
    bet: number;
    doubled: boolean;
    from_split: boolean;
    total: number;
    soft: boolean;
    done: boolean;
    outcome: BlackjackOutcome | null;
    returned: number | null;
}

export interface BlackjackSeat {
    seat: number;
    user_id: number;
    stack: number;
    pending_bet: number;
    hands: BlackjackHand[];
    sitting_out: boolean;
    leaving: boolean;
    away: boolean;
}

export interface BlackjackLegal {
    can_hit: boolean;
    can_stand: boolean;
    can_double: boolean;
    can_split: boolean;
}

export interface BlackjackView {
    game: 'blackjack';
    viewer_seat: number | null;
    config: BlackjackConfig;
    round_no: number;
    in_round: boolean;
    seats: (BlackjackSeat | null)[];
    /** The face-down hole card is `'??'`. */
    dealer: CardCode[];
    dealer_total: number | null;
    to_act: { seat: number; hand: number } | null;
    turn: TurnRef | null;
    shoe_remaining: number;
    shoe_size: number;
    reshuffle_due: boolean;
    legal: BlackjackLegal | null;
    clock_ms: number | null;
    next_deal_in_ms: number | null;
}

export type GameView = HoldemView | BlackjackView;

// ---------------------------------------------------------------------------
// Server -> client: events

export type SitOutReason = 'requested' | 'timeouts' | 'busted';
export type ActReason = 'player' | 'timeout' | 'left';
export type HandCategory =
    | 'high_card'
    | 'one_pair'
    | 'two_pair'
    | 'three_of_a_kind'
    | 'straight'
    | 'flush'
    | 'full_house'
    | 'four_of_a_kind'
    | 'straight_flush';

export type HoldemEvent =
    | { type: 'player_sat'; seat: number; user_id: number; stack: number }
    | { type: 'player_left'; seat: number; user_id: number; stack: number }
    | { type: 'sat_out'; seat: number; reason: SitOutReason }
    | { type: 'sat_in'; seat: number }
    | { type: 'rebought'; seat: number; stack: number }
    | { type: 'hand_started'; hand_no: number; button: number; small_blind: number | null; big_blind: number; dealt: number[] }
    | { type: 'blind_posted'; seat: number; amount: number; all_in: boolean }
    | {
          type: 'acted';
          seat: number;
          kind: 'fold' | 'check' | 'call' | 'bet' | 'raise';
          added: number;
          street_commit: number;
          all_in: boolean;
          reason: ActReason;
      }
    | { type: 'board_dealt'; street: HoldemStreet; cards: CardCode[] }
    | { type: 'uncalled_returned'; seat: number; amount: number }
    | { type: 'showdown'; shown: { seat: number; cards: CardCode[]; category: HandCategory }[]; mucked: number[] }
    | { type: 'pot_awarded'; pot: number; amount: number; eligible: number[]; shares: { seat: number; amount: number }[] }
    | { type: 'shown'; seat: number; cards: CardCode[] }
    | { type: 'hand_ended'; hand_no: number };

export type BlackjackEvent =
    | { type: 'player_sat'; seat: number; user_id: number; stack: number }
    | { type: 'player_left'; seat: number; user_id: number; stack: number }
    | { type: 'sat_out'; seat: number; reason: SitOutReason }
    | { type: 'sat_in'; seat: number }
    | { type: 'rebought'; seat: number; stack: number }
    | { type: 'bet_placed'; seat: number; amount: number }
    | { type: 'bet_cleared'; seat: number; amount: number }
    | { type: 'shoe_shuffled'; cards_in_shoe: number; mid_round: boolean }
    | { type: 'round_started'; round_no: number; seats: number[] }
    /** `seat`/`hand` null: a card to the dealer (the hole card is `'??'`). */
    | { type: 'card_dealt'; seat: number | null; hand: number | null; card: CardCode }
    | { type: 'dealer_peeked'; blackjack: boolean }
    | { type: 'acted'; seat: number; hand: number; action: 'hit' | 'stand' | 'double' | 'split'; reason: ActReason }
    | { type: 'dealer_revealed'; card: CardCode }
    | { type: 'hand_settled'; seat: number; hand: number; outcome: BlackjackOutcome; bet: number; returned: number }
    | { type: 'round_ended'; round_no: number; dealer_total: number; dealer_bust: boolean };

// ---------------------------------------------------------------------------
// Server -> client: refusals and endings

/** Codes that carry nothing but themselves. */
export const PLAIN_REFUSAL_CODES = [
    'disabled',
    'no_permission',
    'not_in_call',
    'not_a_voice_room',
    'too_many_tables',
    'rate_limited',
    'wrong_game',
    'not_seated',
    'invalid_config',
    'config_locked',
    'seat_out_of_range',
    'seat_taken',
    'seat_empty',
    'already_seated',
    'not_your_turn',
    'stale_turn',
    'no_chips',
    'not_busted',
    'rebuy_not_allowed',
    'hand_in_progress',
    'no_hand_in_progress',
    'not_enough_players',
    'nothing_to_call',
    'raise_not_reopened',
    'nobody_to_raise',
    'not_showable',
    'round_in_progress',
    'no_round_in_progress',
    'no_bets',
    'sitting_out',
    'cannot_hit',
    'cannot_double',
    'cannot_split',
] as const;
export type PlainRefusalCode = (typeof PLAIN_REFUSAL_CODES)[number];

export type GameRefusal =
    | { code: PlainRefusalCode }
    | { code: 'room_has_table'; open_table_id: number; kind: GameKind }
    /** Hold'em: the smallest legal raise-to total. Blackjack: the minimum bet. */
    | { code: 'bet_below_minimum'; min: number }
    | { code: 'cannot_check'; to_call: number }
    | { code: 'bet_above_stack'; max: number }
    | { code: 'bet_above_maximum'; max: number }
    | { code: 'insufficient_chips'; stack: number }
    /** A code this client does not know (a newer server). */
    | { code: 'other' };

export const GAME_OPS = [
    'create',
    'sit',
    'stand',
    'act',
    'bet',
    'clear_bet',
    'sit_out',
    'sit_in',
    'rebuy',
    'show_cards',
    'resync',
    'close',
    'remove_player',
] as const;
export type GameOp = (typeof GAME_OPS)[number];

export const GAME_END_REASONS = ['closed', 'call_ended', 'idle', 'disabled', 'channel_deleted', 'gone'] as const;
export type GameEndReason = (typeof GAME_END_REASONS)[number];

interface FrameBase {
    room_id: string;
    table_id: number;
}

export type GameEventsFrame =
    | (FrameBase & { type: 'GameEvents'; version: number; view: HoldemView; events: HoldemEvent[] })
    | (FrameBase & { type: 'GameEvents'; version: number; view: BlackjackView; events: BlackjackEvent[] });

export type GameServerFrame =
    /** `opened_by`: who opened the table (the user id of its GameCreate),
     *  for "<name> started Poker"; null when the server did not say. */
    | (FrameBase & { type: 'GameTable'; version: number; view: GameView; opened_by: number | null })
    | GameEventsFrame
    /** `reason: 'other'` is an ending this client does not know: still drop the table. */
    | (FrameBase & { type: 'GameEnded'; reason: GameEndReason | 'other' })
    | {
          type: 'GameRefused';
          room_id: string;
          /** null for a refused GameCreate. */
          table_id: number | null;
          op: GameOp | 'other';
          refusal: GameRefusal;
      };

export const GAME_SERVER_FRAME_TYPES = ['GameTable', 'GameEvents', 'GameEnded', 'GameRefused'] as const;

// ---------------------------------------------------------------------------
// Parsing

type Obj = Record<string, unknown>;
const CARD_RE = /^[2-9TJQKA][cdhs]$/;

/** Thrown inside the parser only; `parseGameFrame` turns it into `null`. */
class Junk extends Error {}

function obj(v: unknown): Obj {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Junk('not an object');
    return v as Obj;
}
function nat(v: unknown): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Junk('not a safe non-negative integer');
    return v;
}
function optNat(v: unknown): number | null {
    return v === null ? null : nat(v);
}
function int(v: unknown): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Junk('not a safe integer');
    return v;
}
function bool(v: unknown): boolean {
    if (typeof v !== 'boolean') throw new Junk('not a boolean');
    return v;
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T {
    if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw new Junk(`not one of ${list.join('|')}`);
    return v as T;
}
function arr(v: unknown): unknown[] {
    if (!Array.isArray(v)) throw new Junk('not an array');
    return v;
}
/** A real card; `hidden` allows '??' too. */
function card(v: unknown, hidden = false): CardCode {
    if (typeof v === 'string' && (CARD_RE.test(v) || (hidden && v === HIDDEN_CARD))) return v;
    throw new Junk('not a card code');
}
function cardList(v: unknown, hidden = false, len?: number): CardCode[] {
    const out = arr(v).map((c) => card(c, hidden));
    if (len !== undefined && out.length !== len) throw new Junk('wrong number of cards');
    return out;
}
function seatList(v: unknown): number[] {
    return arr(v).map(nat);
}
function tableId(v: unknown): number {
    const id = nat(v);
    if (id < 1) throw new Junk('table ids start at 1');
    return id;
}
function roomId(v: unknown): string {
    if (typeof v !== 'string' || !/^voice_\d+$/.test(v)) throw new Junk('not a voice room');
    return v;
}
function turn(v: unknown): TurnRef | null {
    if (v === null) return null;
    const t = obj(v);
    return { hand_no: nat(t.hand_no), turn_seq: nat(t.turn_seq) };
}
/** `seats` must have one entry per configured seat, each at its own index. */
function seats<T extends { seat: number }>(v: unknown, maxSeats: number, one: (s: Obj) => T): (T | null)[] {
    const list = arr(v);
    if (list.length !== maxSeats) throw new Junk('seats do not match max_seats');
    return list.map((s, i) => {
        if (s === null) return null;
        const seat = one(obj(s));
        if (seat.seat !== i) throw new Junk('a seat out of place');
        return seat;
    });
}
function viewerSeat(v: unknown, maxSeats: number): number | null {
    const s = optNat(v);
    if (s !== null && s >= maxSeats) throw new Junk('viewer seat out of range');
    return s;
}

const STREETS: readonly HoldemStreet[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const SEAT_STATUSES: readonly HoldemSeatStatus[] = ['waiting', 'sitting_out', 'in_hand', 'folded', 'all_in'];
const OUTCOMES: readonly BlackjackOutcome[] = ['blackjack', 'win', 'push', 'lose'];
const SIT_OUT: readonly SitOutReason[] = ['requested', 'timeouts', 'busted'];
const ACT_REASONS: readonly ActReason[] = ['player', 'timeout', 'left'];
const CATEGORIES: readonly HandCategory[] = [
    'high_card',
    'one_pair',
    'two_pair',
    'three_of_a_kind',
    'straight',
    'flush',
    'full_house',
    'four_of_a_kind',
    'straight_flush',
];

function holdemView(v: Obj): HoldemView {
    const c = obj(v.config);
    const config: HoldemConfig = {
        max_seats: nat(c.max_seats),
        starting_stack: nat(c.starting_stack),
        small_blind: nat(c.small_blind),
        big_blind: nat(c.big_blind),
        turn_clock_secs: nat(c.turn_clock_secs),
        timeouts_before_sit_out: nat(c.timeouts_before_sit_out),
        allow_rebuy: bool(c.allow_rebuy),
    };
    const l = v.legal === null ? null : obj(v.legal);
    return {
        game: 'holdem',
        viewer_seat: viewerSeat(v.viewer_seat, config.max_seats),
        config,
        hand_no: nat(v.hand_no),
        in_hand: bool(v.in_hand),
        street: v.street === null ? null : oneOf(v.street, STREETS),
        button: optNat(v.button),
        small_blind_seat: optNat(v.small_blind_seat),
        big_blind_seat: optNat(v.big_blind_seat),
        seats: seats(v.seats, config.max_seats, (s) => ({
            seat: nat(s.seat),
            user_id: int(s.user_id),
            stack: nat(s.stack),
            status: oneOf(s.status, SEAT_STATUSES),
            street_commit: nat(s.street_commit),
            hand_commit: nat(s.hand_commit),
            cards: s.cards === null ? null : cardList(s.cards, true, 2),
            sitting_out: bool(s.sitting_out),
            leaving: bool(s.leaving),
            away: bool(s.away),
        })),
        board: cardList(v.board),
        pot_total: nat(v.pot_total),
        // Absent from a server older than side-pot display: no breakdown.
        pots: v.pots === undefined ? [] : arr(v.pots).map((p0) => {
            const p = obj(p0);
            const eligible = seatList(p.eligible);
            if (eligible.some((s) => s >= config.max_seats)) throw new Junk('a pot names a seat out of range');
            return { amount: nat(p.amount), eligible };
        }),
        current_bet: nat(v.current_bet),
        to_act: optNat(v.to_act),
        turn: turn(v.turn),
        legal:
            l === null
                ? null
                : {
                      to_call: nat(l.to_call),
                      can_check: bool(l.can_check),
                      call_amount: nat(l.call_amount),
                      can_raise: bool(l.can_raise),
                      min_raise_to: nat(l.min_raise_to),
                      max_raise_to: nat(l.max_raise_to),
                  },
        clock_ms: optNat(v.clock_ms),
        next_deal_in_ms: optNat(v.next_deal_in_ms),
    };
}

function blackjackView(v: Obj): BlackjackView {
    const c = obj(v.config);
    const pays = arr(c.blackjack_pays).map(nat);
    if (pays.length !== 2) throw new Junk('blackjack_pays is [num, den]');
    const config: BlackjackConfig = {
        max_seats: nat(c.max_seats),
        starting_stack: nat(c.starting_stack),
        min_bet: nat(c.min_bet),
        max_bet: nat(c.max_bet),
        decks: nat(c.decks),
        penetration_percent: nat(c.penetration_percent),
        dealer_hits_soft_17: bool(c.dealer_hits_soft_17),
        blackjack_pays: [pays[0], pays[1]],
        double_after_split: bool(c.double_after_split),
        max_hands: nat(c.max_hands),
        resplit_aces: bool(c.resplit_aces),
        turn_clock_secs: nat(c.turn_clock_secs),
        timeouts_before_sit_out: nat(c.timeouts_before_sit_out),
        allow_rebuy: bool(c.allow_rebuy),
    };
    const l = v.legal === null ? null : obj(v.legal);
    const toAct = v.to_act === null ? null : obj(v.to_act);
    return {
        game: 'blackjack',
        viewer_seat: viewerSeat(v.viewer_seat, config.max_seats),
        config,
        round_no: nat(v.round_no),
        in_round: bool(v.in_round),
        seats: seats(v.seats, config.max_seats, (s) => ({
            seat: nat(s.seat),
            user_id: int(s.user_id),
            stack: nat(s.stack),
            pending_bet: nat(s.pending_bet),
            hands: arr(s.hands).map((h0) => {
                const h = obj(h0);
                return {
                    cards: cardList(h.cards),
                    bet: nat(h.bet),
                    doubled: bool(h.doubled),
                    from_split: bool(h.from_split),
                    total: nat(h.total),
                    soft: bool(h.soft),
                    done: bool(h.done),
                    outcome: h.outcome === null ? null : oneOf(h.outcome, OUTCOMES),
                    returned: optNat(h.returned),
                };
            }),
            sitting_out: bool(s.sitting_out),
            leaving: bool(s.leaving),
            away: bool(s.away),
        })),
        dealer: cardList(v.dealer, true),
        dealer_total: optNat(v.dealer_total),
        to_act: toAct === null ? null : { seat: nat(toAct.seat), hand: nat(toAct.hand) },
        turn: turn(v.turn),
        shoe_remaining: nat(v.shoe_remaining),
        shoe_size: nat(v.shoe_size),
        reshuffle_due: bool(v.reshuffle_due),
        legal:
            l === null
                ? null
                : { can_hit: bool(l.can_hit), can_stand: bool(l.can_stand), can_double: bool(l.can_double), can_split: bool(l.can_split) },
        clock_ms: optNat(v.clock_ms),
        next_deal_in_ms: optNat(v.next_deal_in_ms),
    };
}

function view(v: unknown): GameView {
    const o = obj(v);
    if (o.game === 'holdem') return holdemView(o);
    if (o.game === 'blackjack') return blackjackView(o);
    throw new Junk('unknown game');
}

/** One Hold'em event, `undefined` for a type this client does not know. */
function holdemEvent(e: Obj): HoldemEvent | undefined {
    switch (e.type) {
        case 'player_sat':
        case 'player_left':
            return { type: e.type, seat: nat(e.seat), user_id: int(e.user_id), stack: nat(e.stack) };
        case 'sat_out':
            return { type: 'sat_out', seat: nat(e.seat), reason: oneOf(e.reason, SIT_OUT) };
        case 'sat_in':
            return { type: 'sat_in', seat: nat(e.seat) };
        case 'rebought':
            return { type: 'rebought', seat: nat(e.seat), stack: nat(e.stack) };
        case 'hand_started':
            return {
                type: 'hand_started',
                hand_no: nat(e.hand_no),
                button: nat(e.button),
                small_blind: optNat(e.small_blind),
                big_blind: nat(e.big_blind),
                dealt: seatList(e.dealt),
            };
        case 'blind_posted':
            return { type: 'blind_posted', seat: nat(e.seat), amount: nat(e.amount), all_in: bool(e.all_in) };
        case 'acted':
            return {
                type: 'acted',
                seat: nat(e.seat),
                kind: oneOf(e.kind, ['fold', 'check', 'call', 'bet', 'raise'] as const),
                added: nat(e.added),
                street_commit: nat(e.street_commit),
                all_in: bool(e.all_in),
                reason: oneOf(e.reason, ACT_REASONS),
            };
        case 'board_dealt':
            return { type: 'board_dealt', street: oneOf(e.street, STREETS), cards: cardList(e.cards) };
        case 'uncalled_returned':
            return { type: 'uncalled_returned', seat: nat(e.seat), amount: nat(e.amount) };
        case 'showdown':
            return {
                type: 'showdown',
                shown: arr(e.shown).map((h0) => {
                    const h = obj(h0);
                    return { seat: nat(h.seat), cards: cardList(h.cards, false, 2), category: oneOf(h.category, CATEGORIES) };
                }),
                mucked: seatList(e.mucked),
            };
        case 'pot_awarded':
            return {
                type: 'pot_awarded',
                pot: nat(e.pot),
                amount: nat(e.amount),
                eligible: seatList(e.eligible),
                shares: arr(e.shares).map((s0) => {
                    const s = obj(s0);
                    return { seat: nat(s.seat), amount: nat(s.amount) };
                }),
            };
        case 'shown':
            return { type: 'shown', seat: nat(e.seat), cards: cardList(e.cards, false, 2) };
        case 'hand_ended':
            return { type: 'hand_ended', hand_no: nat(e.hand_no) };
        default:
            if (typeof e.type !== 'string') throw new Junk('an event without a type');
            return undefined;
    }
}

function blackjackEvent(e: Obj): BlackjackEvent | undefined {
    switch (e.type) {
        case 'player_sat':
        case 'player_left':
            return { type: e.type, seat: nat(e.seat), user_id: int(e.user_id), stack: nat(e.stack) };
        case 'sat_out':
            return { type: 'sat_out', seat: nat(e.seat), reason: oneOf(e.reason, SIT_OUT) };
        case 'sat_in':
            return { type: 'sat_in', seat: nat(e.seat) };
        case 'rebought':
            return { type: 'rebought', seat: nat(e.seat), stack: nat(e.stack) };
        case 'bet_placed':
        case 'bet_cleared':
            return { type: e.type, seat: nat(e.seat), amount: nat(e.amount) };
        case 'shoe_shuffled':
            return { type: 'shoe_shuffled', cards_in_shoe: nat(e.cards_in_shoe), mid_round: bool(e.mid_round) };
        case 'round_started':
            return { type: 'round_started', round_no: nat(e.round_no), seats: seatList(e.seats) };
        case 'card_dealt': {
            const seat = optNat(e.seat);
            const hand = optNat(e.hand);
            if ((seat === null) !== (hand === null)) throw new Junk('a card to a seat names its hand');
            // Only the dealer's hole card is ever dealt face down.
            return { type: 'card_dealt', seat, hand, card: card(e.card, seat === null) };
        }
        case 'dealer_peeked':
            return { type: 'dealer_peeked', blackjack: bool(e.blackjack) };
        case 'acted':
            return {
                type: 'acted',
                seat: nat(e.seat),
                hand: nat(e.hand),
                action: oneOf(e.action, ['hit', 'stand', 'double', 'split'] as const),
                reason: oneOf(e.reason, ACT_REASONS),
            };
        case 'dealer_revealed':
            return { type: 'dealer_revealed', card: card(e.card) };
        case 'hand_settled':
            return {
                type: 'hand_settled',
                seat: nat(e.seat),
                hand: nat(e.hand),
                outcome: oneOf(e.outcome, OUTCOMES),
                bet: nat(e.bet),
                returned: nat(e.returned),
            };
        case 'round_ended':
            return { type: 'round_ended', round_no: nat(e.round_no), dealer_total: nat(e.dealer_total), dealer_bust: bool(e.dealer_bust) };
        default:
            if (typeof e.type !== 'string') throw new Junk('an event without a type');
            return undefined;
    }
}

function refusal(p: Obj): GameRefusal {
    const code = p.code;
    if (typeof code !== 'string') throw new Junk('a refusal without a code');
    switch (code) {
        case 'room_has_table':
            return { code, open_table_id: tableId(p.open_table_id), kind: oneOf(p.kind, ['holdem', 'blackjack'] as const) };
        case 'bet_below_minimum':
            return { code, min: nat(p.min) };
        case 'cannot_check':
            return { code, to_call: nat(p.to_call) };
        case 'bet_above_stack':
        case 'bet_above_maximum':
            return { code, max: nat(p.max) };
        case 'insufficient_chips':
            return { code, stack: nat(p.stack) };
        default:
            return (PLAIN_REFUSAL_CODES as readonly string[]).includes(code)
                ? { code: code as PlainRefusalCode }
                : { code: 'other' };
    }
}

/**
 * A server frame of the games contract, checked; `null` for any other frame
 * type and for a games frame that is not well formed. Pass the socket's
 * `{ type, payload }` as it arrived.
 */
export function parseGameFrame(msg: { type: string; payload?: unknown }): GameServerFrame | null {
    try {
        const p = obj(msg.payload);
        switch (msg.type) {
            case 'GameTable':
                return {
                    type: 'GameTable',
                    room_id: roomId(p.room_id),
                    table_id: tableId(p.table_id),
                    version: nat(p.version),
                    view: view(p.view),
                    // Absent (an older server, the contract fixtures): null.
                    opened_by: p.opened_by === undefined || p.opened_by === null ? null : int(p.opened_by),
                };
            case 'GameEvents': {
                const base = { type: 'GameEvents' as const, room_id: roomId(p.room_id), table_id: tableId(p.table_id), version: nat(p.version) };
                const v = view(p.view);
                const raw = arr(p.events).map(obj);
                if (v.game === 'holdem') {
                    return { ...base, view: v, events: raw.map(holdemEvent).filter((e): e is HoldemEvent => e !== undefined) };
                }
                return { ...base, view: v, events: raw.map(blackjackEvent).filter((e): e is BlackjackEvent => e !== undefined) };
            }
            case 'GameEnded': {
                const reason = typeof p.reason === 'string' ? p.reason : undefined;
                if (reason === undefined) throw new Junk('an ending without a reason');
                return {
                    type: 'GameEnded',
                    room_id: roomId(p.room_id),
                    table_id: tableId(p.table_id),
                    reason: (GAME_END_REASONS as readonly string[]).includes(reason) ? (reason as GameEndReason) : 'other',
                };
            }
            case 'GameRefused': {
                const op = typeof p.op === 'string' ? p.op : undefined;
                if (op === undefined) throw new Junk('a refusal without an op');
                // The refused frame's own room_id, echoed: `not_a_voice_room`
                // is precisely a room that is not `voice_<id>`, so any string.
                if (typeof p.room_id !== 'string') throw new Junk('a refusal without a room');
                return {
                    type: 'GameRefused',
                    room_id: p.room_id,
                    table_id: p.table_id === null ? null : tableId(p.table_id),
                    op: (GAME_OPS as readonly string[]).includes(op) ? (op as GameOp) : 'other',
                    refusal: refusal(p),
                };
            }
            default:
                return null;
        }
    } catch (e) {
        if (e instanceof Junk) return null;
        throw e;
    }
}

/** The owner switched games on or off for a server (server -> client). */
export interface GamesEnabledFrame {
    server_id: string;
    games_enabled: boolean;
}

/**
 * `GamesEnabled`, checked; `null` for any other frame or a malformed one.
 * Sent only to a socket that announced `games` (docs/GAMES.md, *Activities*),
 * after the owner's switch committed; switching off has already ended every
 * table of the server (`GameEnded { disabled }`).
 */
export function parseGamesEnabled(msg: { type: string; payload?: unknown }): GamesEnabledFrame | null {
    if (msg.type !== 'GamesEnabled') return null;
    try {
        const p = obj(msg.payload);
        if (typeof p.server_id !== 'string' || p.server_id === '') throw new Junk('no server id');
        return { server_id: p.server_id, games_enabled: bool(p.games_enabled) };
    } catch (e) {
        if (e instanceof Junk) return null;
        throw e;
    }
}

/**
 * What to do with a frame's `version`, given the version of the table this
 * client holds (`null`: none yet).
 *
 * - `'ignore'`: older than what is held (or the same events again).
 * - `'apply'`: take the frame's view; for GameEvents, also animate/log its
 *   events (they are exactly the next change).
 * - `'apply_after_gap'`: GameEvents that skipped versions (the socket dropped
 *   frames under backpressure). The view is still exact - every frame
 *   carries the whole view - so take it, but do not animate events as if
 *   nothing was missed.
 *
 * A GameTable is a full snapshot: any version at or above the held one
 * applies (a resync answer repeats the held version).
 */
export function versionStep(held: number | null, incoming: number, frame: 'GameTable' | 'GameEvents'): 'ignore' | 'apply' | 'apply_after_gap' {
    if (held === null) return 'apply';
    if (frame === 'GameTable') return incoming >= held ? 'apply' : 'ignore';
    if (incoming <= held) return 'ignore';
    return incoming === held + 1 ? 'apply' : 'apply_after_gap';
}
