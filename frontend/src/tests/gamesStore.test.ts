/**
 * The games store (src/api/games/gamesStore.ts), fed the contract's own
 * fixtures (src/tests/fixtures/games, what real engine tables serialise to)
 * through a stand-in socket that dispatches like wsClient.
 *
 * Pinned here:
 *  - versions: the next GameEvents applies AND animates; a repeat or an
 *    older one is ignored; a GameTable at or above what is held replaces it;
 *  - a GAP (GameEvents that skipped versions) applies the complete view
 *    without animating, and sends NO resync — GAMES.md: "a dropped frame
 *    heals at the next one";
 *  - a games frame that does not parse, RoomJoined for the call we hold a
 *    table for, and a turn clock that ran out long ago all send GameResync,
 *    throttled to one a second and held until the server confirms `games`;
 *  - GameEnded drops the table and keeps its reason; GameRefused is a typed
 *    notice (never an alert), stale_turn is silent;
 *  - nothing is sent, and no table is kept, without the `games` feature;
 *  - leaving the call (RoomLeft, VoiceMoved, another call) drops the table.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import seated from './fixtures/games/holdem-table-seated.json';
import spectator from './fixtures/games/holdem-table-spectator.json';
import holdemEvents from './fixtures/games/holdem-events.json';
import blackjackTable from './fixtures/games/blackjack-table.json';
import refusals from './fixtures/games/refusals.json';
import ended from './fixtures/games/ended.json';
import {
    CLOCK_STALE_GRACE_MS,
    REFUSAL_NOTICE_MS,
    RESYNC_MIN_INTERVAL_MS,
    attachGamesSocket,
    getGamesState,
    handleGamesMessage,
    requestResync,
    resetGamesStoreForTests,
    sendGame,
    setGamesRoom,
} from '../api/games/gamesStore';
import { gameFrames } from '../api/games/protocol';
import { FakeGamesSocket, withVersion } from './gamesTestSocket';

const ROOM = 'voice_42';
const TABLE = 4503599627370497;
const FEATURES = { type: 'ServerFeatures', payload: { features: ['own_voice', 'games'] } };

let clock = 0;
let ws: FakeGamesSocket;
let detach: () => void;

/** A GameEvents frame from the fixture, re-versioned. */
const ev = (i: number, version: number) => withVersion(holdemEvents[i], version);

beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
    resetGamesStoreForTests(() => clock);
    ws = new FakeGamesSocket();
    detach = attachGamesSocket(ws);
    ws.deliver(FEATURES);
    setGamesRoom(ROOM);
    ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
});

afterEach(() => {
    detach();
    vi.useRealTimers();
});

const table = () => getGamesState().table;
/** The contract's refusal fixture for `code` (every code is in it once). */
function refusalOf(code: string) {
    const r = refusals.find(x => x.payload.code === code);
    if (!r) throw new Error(`no ${code} in refusals.json`);
    return r;
}

describe('versions', () => {
    it('a GameTable for the call applies; the next GameEvents applies and animates its events', () => {
        expect(handleGamesMessage(seated)).toBe('applied');
        expect(table()?.version).toBe(8);
        expect(table()?.view.game).toBe('holdem');
        expect(table()?.events).toEqual([]);

        expect(handleGamesMessage(ev(2, 9))).toBe('applied');
        expect(table()?.version).toBe(9);
        expect(table()?.events.map(e => e.type)).toEqual(['acted', 'board_dealt']);
        expect(table()?.eventsVersion).toBe(9);
        expect(table()?.log.map(e => e.type)).toEqual(['acted', 'board_dealt']);
        expect(ws.sentOf('GameResync')).toHaveLength(0);
    });

    it('a repeat or an older GameEvents is ignored; an older GameTable is ignored, the same version replaces', () => {
        handleGamesMessage(seated);
        handleGamesMessage(ev(2, 9));
        expect(handleGamesMessage(ev(2, 9))).toBe('ignored');
        expect(handleGamesMessage(ev(1, 4))).toBe('ignored');
        expect(table()?.version).toBe(9);
        expect(table()?.log).toHaveLength(2);

        expect(handleGamesMessage(withVersion(seated, 7))).toBe('ignored');
        expect(table()?.version).toBe(9);
        // A resync answer repeats the held version: it is a full snapshot.
        expect(handleGamesMessage(withVersion(seated, 9))).toBe('applied');
        expect(table()?.events).toEqual([]);
    });

    it('a GAP applies the complete view without animating and sends NO resync', () => {
        handleGamesMessage(seated); // v8
        expect(handleGamesMessage(ev(3, 17))).toBe('applied-after-gap');
        expect(table()?.version).toBe(17);
        const after = table()!.view;
        expect(after.game).toBe('holdem');
        expect(after.game === 'holdem' && after.in_hand).toBe(false); // the view after the showdown
        expect(table()?.events).toEqual([]); // nothing animated as if nothing was missed
        expect(table()?.log).toEqual([]); // and nothing logged that was not seen in order
        expect(ws.sentOf('GameResync')).toHaveLength(0);
        // The next frame in order animates again.
        expect(handleGamesMessage(ev(4, 18))).toBe('applied');
        expect(table()?.events.map(e => e.type)).toEqual(['shown']);
    });

    it('a different table id in the same call replaces the held one (a new table)', () => {
        handleGamesMessage(seated);
        const other = withVersion(blackjackTable, 1);
        other.payload.table_id = TABLE + 1;
        expect(handleGamesMessage(other)).toBe('applied');
        expect(table()?.table_id).toBe(TABLE + 1);
        expect(table()?.view.game).toBe('blackjack');
    });

    it('a spectator table applies with no hole cards anywhere but the board', () => {
        handleGamesMessage(spectator);
        const v = table()!.view;
        expect(v.game === 'holdem' && v.viewer_seat).toBe(null);
        if (v.game !== 'holdem') throw new Error('holdem');
        for (const s of v.seats) if (s?.cards) expect(s.cards).toEqual(['??', '??']);
        expect(v.legal).toBeNull();
    });
});

describe('resync', () => {
    it('a games frame that does not parse sends GameResync for the held table', () => {
        handleGamesMessage(seated);
        const junk = JSON.parse(JSON.stringify(seated));
        junk.payload.view.board = ['??'];
        expect(handleGamesMessage(junk)).toBe('junk');
        expect(table()?.version).toBe(8); // the junk changed nothing
        expect(ws.sentOf('GameResync')).toEqual([gameFrames.resync(ROOM, TABLE)]);
    });

    it('is throttled to one a second, and the held one goes out when the second is up', () => {
        handleGamesMessage(seated);
        requestResync();
        requestResync();
        requestResync();
        expect(ws.sentOf('GameResync')).toHaveLength(1);
        clock += RESYNC_MIN_INTERVAL_MS;
        vi.advanceTimersByTime(RESYNC_MIN_INTERVAL_MS);
        expect(ws.sentOf('GameResync')).toHaveLength(2);
        // Nothing more is owed.
        clock += 5_000;
        vi.advanceTimersByTime(5_000);
        expect(ws.sentOf('GameResync')).toHaveLength(2);
    });

    it('RoomJoined for the call we hold a table for resyncs (a reconnect is a new connection)', () => {
        handleGamesMessage(seated);
        expect(ws.sentOf('GameResync')).toHaveLength(0);
        ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
        expect(ws.sentOf('GameResync')).toEqual([gameFrames.resync(ROOM, TABLE)]);
        // Another room's RoomJoined (a text channel) says nothing about the table.
        clock += 2_000;
        ws.deliver({ type: 'RoomJoined', payload: { room_id: 'channel_7', members: [] } });
        expect(ws.sentOf('GameResync')).toHaveLength(1);
    });

    it('a resync wanted before the server confirmed games waits for ServerFeatures', () => {
        handleGamesMessage(seated);
        // The socket drops and comes back: the new one has not confirmed yet.
        window.dispatchEvent(new CustomEvent('wsClosed'));
        ws.features = new Set();
        ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
        expect(ws.sentOf('GameResync')).toHaveLength(0);
        ws.deliver(FEATURES);
        expect(ws.sentOf('GameResync')).toEqual([gameFrames.resync(ROOM, TABLE)]);
    });

    it('a turn clock that ran out long ago with no frame since resyncs, once', () => {
        handleGamesMessage(seated); // clock_ms 27500
        const due = 27_500 + CLOCK_STALE_GRACE_MS;
        vi.advanceTimersByTime(due - 1);
        expect(ws.sentOf('GameResync')).toHaveLength(0);
        clock += due;
        vi.advanceTimersByTime(1);
        expect(ws.sentOf('GameResync')).toHaveLength(1);
    });

    it('…but not when a frame arrived after the clock started', () => {
        handleGamesMessage(seated);
        vi.advanceTimersByTime(10_000);
        handleGamesMessage(ev(2, 9)); // its view has no clock (between turns)
        clock += 60_000;
        vi.advanceTimersByTime(60_000);
        expect(ws.sentOf('GameResync')).toHaveLength(0);
    });
});

describe('endings and refusals', () => {
    it('GameEnded drops the table and keeps the reason; an unknown reason still ends it', () => {
        handleGamesMessage(seated);
        expect(handleGamesMessage(ended[0])).toBe('ended');
        expect(table()).toBeNull();
        expect(getGamesState().notice).toMatchObject({ kind: 'ended', reason: 'closed', room_id: ROOM });

        handleGamesMessage(seated);
        const unknown = JSON.parse(JSON.stringify(ended[0]));
        unknown.payload.reason = 'meteor';
        expect(handleGamesMessage(unknown)).toBe('ended');
        expect(getGamesState().notice).toMatchObject({ kind: 'ended', reason: 'other' });
    });

    it('a GameEnded for a table we do not hold changes nothing', () => {
        handleGamesMessage(seated);
        const other = JSON.parse(JSON.stringify(ended[5]));
        other.payload.table_id = TABLE + 9;
        expect(handleGamesMessage(other)).toBe('ignored');
        expect(table()?.table_id).toBe(TABLE);
    });

    it('every refusal in the contract becomes a typed notice (stale_turn silently dropped)', () => {
        handleGamesMessage(seated);
        for (const r of refusals) {
            const out = handleGamesMessage(r);
            const code = r.payload.code;
            if (code === 'stale_turn') {
                expect(out).toBe('stale');
                continue;
            }
            if (r.payload.op === 'resync' && code === 'rate_limited') {
                expect(out).toBe('resync-throttled');
                continue;
            }
            // not_a_voice_room echoes a room that is not ours: not this call's notice.
            if (r.payload.room_id !== ROOM) {
                expect(out).toBe('ignored');
                continue;
            }
            expect(out, code).toBe('refused');
            const n = getGamesState().notice;
            expect(n?.kind).toBe('refused');
            if (n?.kind === 'refused') expect(n.refusal.code).toBe(code);
        }
        // The table survives every refusal.
        expect(table()?.version).toBe(8);
    });

    it('the words of a refusal fade after REFUSAL_NOTICE_MS; its time is kept; an ending stays', () => {
        handleGamesMessage(seated);
        handleGamesMessage(refusalOf('not_your_turn'));
        const at = getGamesState().lastRefusalAt;
        expect(getGamesState().notice?.kind).toBe('refused');
        expect(at).not.toBeNull();
        vi.advanceTimersByTime(REFUSAL_NOTICE_MS - 1);
        expect(getGamesState().notice?.kind).toBe('refused');
        vi.advanceTimersByTime(1);
        expect(getGamesState().notice).toBeNull();
        expect(getGamesState().lastRefusalAt).toBe(at);
        // An ending is not on that timer.
        handleGamesMessage(ended[0]);
        vi.advanceTimersByTime(REFUSAL_NOTICE_MS * 3);
        expect(getGamesState().notice?.kind).toBe('ended');
    });

    it('a newer refusal is not cleared by the timer of the older one', () => {
        handleGamesMessage(refusalOf('not_your_turn'));
        vi.advanceTimersByTime(REFUSAL_NOTICE_MS - 100);
        handleGamesMessage(refusalOf('seat_taken'));
        vi.advanceTimersByTime(200);
        const n = getGamesState().notice;
        expect(n?.kind === 'refused' && n.refusal.code).toBe('seat_taken');
    });

    it('an ending that arrives while a refusal is showing outlives the refusal timer', () => {
        handleGamesMessage(seated);
        handleGamesMessage(refusalOf('not_your_turn'));
        vi.advanceTimersByTime(1_000);
        handleGamesMessage(ended[0]);
        vi.advanceTimersByTime(REFUSAL_NOTICE_MS);
        expect(getGamesState().notice).toMatchObject({ kind: 'ended', reason: 'closed' });
    });

    it('a refusal code this client does not know reads as other', () => {
        const r = JSON.parse(JSON.stringify(refusals[0]));
        r.payload.code = 'new_rule';
        expect(handleGamesMessage(r)).toBe('refused');
        const n = getGamesState().notice;
        expect(n?.kind === 'refused' && n.refusal.code).toBe('other');
    });
});

describe('gating and the call', () => {
    it('nothing is sent without the games feature', () => {
        ws.deliver({ type: 'ServerFeatures', payload: { features: ['own_voice'] } });
        expect(getGamesState().feature).toBe(false);
        expect(sendGame(gameFrames.create(ROOM, 'holdem'))).toBe(false);
        expect(ws.sent).toHaveLength(0);
        ws.deliver(FEATURES);
        expect(sendGame(gameFrames.create(ROOM, 'holdem'))).toBe(true);
        expect(ws.sentOf('GameCreate')).toHaveLength(1);
    });

    it('a server that stops confirming games (an older host) drops the table', () => {
        handleGamesMessage(seated);
        ws.deliver({ type: 'ServerFeatures', payload: { features: ['own_voice'] } });
        expect(table()).toBeNull();
    });

    it('frames for another call are ignored', () => {
        const other = JSON.parse(JSON.stringify(seated));
        other.payload.room_id = 'voice_7';
        expect(handleGamesMessage(other)).toBe('ignored');
        expect(table()).toBeNull();
    });

    it('leaving the call drops the table silently: RoomLeft, VoiceMoved, another call', () => {
        handleGamesMessage(seated);
        ws.deliver({ type: 'RoomLeft', payload: { room_id: ROOM } });
        expect(table()).toBeNull();
        expect(getGamesState().joined).toBeNull();
        expect(getGamesState().notice).toBeNull();

        ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
        handleGamesMessage(seated);
        ws.deliver({ type: 'VoiceMoved', payload: { from_channel_id: 42, to_channel_id: 43 } });
        expect(table()).toBeNull();

        handleGamesMessage(seated);
        setGamesRoom('voice_43');
        expect(table()).toBeNull();
    });

    it('`joined` follows this socket: RoomJoined sets it, a closed socket clears it', () => {
        expect(getGamesState().joined).toBe(ROOM);
        window.dispatchEvent(new CustomEvent('wsClosed'));
        expect(getGamesState().joined).toBeNull();
        expect(getGamesState().feature).toBe(false);
    });
});
