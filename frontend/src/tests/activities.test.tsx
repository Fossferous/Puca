/**
 * Games as Discord-style ACTIVITIES (docs/GAMES.md, *Activities*; the owner,
 * 2026-10-03: "I want it to work similarly to discord's games"):
 *
 *  - the wire: who opened a table rides GameTable (`opened_by`), and the
 *    owner's switch is pushed live (`GamesEnabled`) - both parsed strictly;
 *  - the store: a table that appears in my call announces itself ("<name>
 *    started Poker - Join / Watch") unless THIS client started it (then the
 *    table opens for the starter and they are seated) or I am already seated;
 *    the announcement goes when it is dismissed or the table ends;
 *  - the launcher shows only to someone who may play here;
 *  - the pushed switch updates the cached server rows (no refetch, no reload);
 *  - the picker, the notice and the stage tile, rendered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import spectator from './fixtures/games/holdem-table-spectator.json';
import seated from './fixtures/games/holdem-table-seated.json';
import blackjackTable from './fixtures/games/blackjack-table.json';
import refusals from './fixtures/games/refusals.json';
import ended from './fixtures/games/ended.json';
import {
    attachGamesSocket,
    consumeJoinRequest,
    dismissActivityNotice,
    getGamesState,
    requestJoin,
    resetGamesStoreForTests,
    setGamesRoom,
    startActivity,
    START_ANSWER_MS,
} from '../api/games/gamesStore';
import { parseGameFrame, parseGamesEnabled } from '../api/games/protocol';
import { applyGamesEnabled, firstOpenSeat, seatedUserIds } from '../api/games/activities';
import { gamesGate } from '../api/games/gamesGate';
import { PERM } from '../api/permissionBits';
import { ActivityPicker } from '../components/games/ActivityPicker';
import { ActivityNotice } from '../components/games/ActivityNotice';
import { VoiceStage } from '../components/VoiceStage';
import { FakeGamesSocket, withVersion } from './gamesTestSocket';

const ROOM = 'voice_42';
const TABLE = 4503599627370497;
const PLAY = PERM.CONNECT | PERM.PLAY_GAMES;

/** A fixture GameTable with `opened_by` (and optionally another table id). */
function opened<T>(frame: T, by: number | undefined, tableId = TABLE): T {
    const f = JSON.parse(JSON.stringify(frame)) as { payload: Record<string, unknown> };
    if (by === undefined) delete f.payload.opened_by;
    else f.payload.opened_by = by;
    f.payload.table_id = tableId;
    return f as T;
}

let ws: FakeGamesSocket;
let detach: () => void;

beforeEach(() => {
    resetGamesStoreForTests();
    ws = new FakeGamesSocket();
    detach = attachGamesSocket(ws);
    ws.deliver({ type: 'ServerFeatures', payload: { features: ['games'] } });
    setGamesRoom(ROOM);
    ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
});

afterEach(() => {
    detach();
    vi.useRealTimers();
});

describe('the wire', () => {
    it('GameTable keeps who opened it; absent reads as null; junk there is a frame that does not parse', () => {
        const f = parseGameFrame(opened(spectator, 7));
        expect(f && f.type === 'GameTable' && f.opened_by).toBe(7);
        const g = parseGameFrame(opened(spectator, undefined));
        expect(g && g.type === 'GameTable' ? g.opened_by : 'no frame').toBeNull();
        expect(parseGameFrame(opened(spectator, 'seven' as unknown as number))).toBeNull();
    });

    it('GamesEnabled: exactly a server id and a boolean', () => {
        expect(parseGamesEnabled({ type: 'GamesEnabled', payload: { server_id: 's1', games_enabled: false } }))
            .toEqual({ server_id: 's1', games_enabled: false });
        expect(parseGamesEnabled({ type: 'GamesEnabled', payload: { server_id: 's1', games_enabled: 'no' } })).toBeNull();
        expect(parseGamesEnabled({ type: 'GamesEnabled', payload: { games_enabled: true } })).toBeNull();
        expect(parseGamesEnabled({ type: 'GameTable', payload: { server_id: 's1', games_enabled: true } })).toBeNull();
    });
});

describe('a table that appears in my call announces itself', () => {
    it('to someone watching: "<who> started <game>", with the table it names', () => {
        ws.deliver(opened(spectator, 7));
        expect(getGamesState().announce).toEqual({ room_id: ROOM, table_id: TABLE, kind: 'holdem', opened_by: 7 });
        // Later frames of the same table do not announce it again once dismissed.
        dismissActivityNotice();
        expect(getGamesState().announce).toBeNull();
        ws.deliver(withVersion(opened(spectator, 7), 9));
        expect(getGamesState().announce).toBeNull();
        // A NEW table does (watched: the fixture's seated view, as a spectator).
        const bj = opened(blackjackTable, 8, TABLE + 1) as { payload: { view: Record<string, unknown> } };
        bj.payload.view.viewer_seat = null;
        bj.payload.view.legal = null;
        ws.deliver(bj);
        expect(getGamesState().announce).toMatchObject({ table_id: TABLE + 1, kind: 'blackjack' });
    });

    it('not to someone already seated at it', () => {
        ws.deliver(opened(seated, 7));
        expect(getGamesState().table?.view.viewer_seat).toBe(2);
        expect(getGamesState().announce).toBeNull();
    });

    it('not for another call', () => {
        const f = opened(spectator, 7) as { payload: Record<string, unknown> };
        f.payload.room_id = 'voice_43';
        ws.deliver(f);
        expect(getGamesState().announce).toBeNull();
    });

    it('goes when the table ends', () => {
        ws.deliver(opened(spectator, 7));
        expect(getGamesState().announce).not.toBeNull();
        ws.deliver(ended.find(e => e.payload.reason === 'closed'));
        expect(getGamesState().table).toBeNull();
        expect(getGamesState().announce).toBeNull();
    });
});

describe('starting an activity', () => {
    it('sends GameCreate for the call; the table that answers opens for the STARTER and seats them - no announcement', () => {
        expect(startActivity(ROOM, 'holdem')).toBe(true);
        expect(getGamesState().starting).toBe('holdem'); // "Starting Poker…" until it answers
        // The owner's table, exactly: no settings of the starter's own.
        expect(ws.sentOf('GameCreate')).toEqual([{ type: 'GameCreate', payload: { room_id: ROOM, kind: 'holdem', config: {} } }]);
        const before = Date.now();
        ws.deliver(opened(spectator, 8));
        const s = getGamesState();
        expect(s.starting).toBeNull();
        expect(s.announce).toBeNull();
        expect(s.openViewAt).not.toBeNull();
        expect(s.openViewAt!).toBeGreaterThanOrEqual(before);
        expect(s.joinRequest).toEqual({ room_id: ROOM, table_id: TABLE });
        // The view takes the request once.
        expect(consumeJoinRequest(TABLE)).toBe(true);
        expect(consumeJoinRequest(TABLE)).toBe(false);
    });

    it('a table arriving long after the start is someone else\'s: announced', () => {
        vi.useFakeTimers();
        startActivity(ROOM, 'blackjack');
        vi.advanceTimersByTime(START_ANSWER_MS + 1);
        expect(getGamesState().starting).toBeNull(); // gave up waiting
        ws.deliver(opened(spectator, 7));
        expect(getGamesState().announce).not.toBeNull();
        expect(getGamesState().joinRequest).toBeNull();
    });

    it("someone else's table of ANOTHER game that wins the race is announced, not taken for mine", () => {
        // Two people start at once: their Poker reaches me before the server
        // refuses my Blackjack. I asked for Blackjack - I am not seated at Poker.
        startActivity(ROOM, 'blackjack');
        ws.deliver(opened(spectator, 7));
        expect(getGamesState().announce).toMatchObject({ kind: 'holdem', opened_by: 7 });
        expect(getGamesState().joinRequest).toBeNull();
        expect(getGamesState().openViewAt).toBeNull();
    });

    it('a refused start is no start: the next table is announced', () => {
        startActivity(ROOM, 'holdem');
        ws.deliver(refusals.find(r => r.payload.code === 'room_has_table' && r.payload.op === 'create'));
        expect(getGamesState().starting).toBeNull();
        ws.deliver(opened(spectator, 7));
        expect(getGamesState().announce).not.toBeNull();
        expect(getGamesState().openViewAt).toBeNull();
    });

    it('nothing is sent without the games feature', () => {
        ws.deliver({ type: 'ServerFeatures', payload: { features: [] } });
        expect(startActivity(ROOM, 'holdem')).toBe(false);
        expect(ws.sentOf('GameCreate')).toEqual([]);
    });

    it('Join from the notice or the tile asks the view to seat me at THAT table', () => {
        ws.deliver(opened(spectator, 7));
        requestJoin();
        expect(getGamesState().joinRequest).toEqual({ room_id: ROOM, table_id: TABLE });
        expect(getGamesState().announce).toBeNull(); // acting on it answers it
        expect(consumeJoinRequest(TABLE + 1)).toBe(false); // another table: not this request
        expect(consumeJoinRequest(TABLE)).toBe(true);
    });
});

describe('who is playing, and the pushed switch', () => {
    it('the seated players, and the first open seat', () => {
        const f = parseGameFrame(spectator);
        if (!f || f.type !== 'GameTable') throw new Error('fixture');
        expect(seatedUserIds(f.view)).toEqual([7, 8, 9]);
        expect(firstOpenSeat(f.view)).toBe(1);
        const b = parseGameFrame(blackjackTable);
        if (!b || b.type !== 'GameTable') throw new Error('fixture');
        expect(seatedUserIds(b.view)).toEqual([7, 8]);
        expect(firstOpenSeat(b.view)).toBe(2);
    });

    it('GamesEnabled flips that one server\'s cached row and nothing else', () => {
        const rows = [{ id: 's1', name: 'A', games_enabled: true }, { id: 's2', name: 'B', games_enabled: true }];
        const off = applyGamesEnabled(rows, { server_id: 's1', games_enabled: false });
        expect(off).toEqual([{ id: 's1', name: 'A', games_enabled: false }, { id: 's2', name: 'B', games_enabled: true }]);
        expect(rows[0].games_enabled).toBe(true); // a new array: react-query sees the change
        expect(applyGamesEnabled(off, { server_id: 's9', games_enabled: true })).toBe(off); // unknown server: unchanged
        expect(applyGamesEnabled(undefined, { server_id: 's1', games_enabled: true })).toBeUndefined();
    });
});

describe('the launcher', () => {
    const g = (over: Partial<Parameters<typeof gamesGate>[0]> = {}) =>
        gamesGate({ feature: true, gamesEnabled: true, perms: PLAY, inCall: true, hasTable: false, ...over });
    it('shows to someone in the call who may play, with games on and served', () => {
        expect(g().launcher).toBe(true);
        expect(g({ hasTable: true }).launcher).toBe(true); // the picker then offers Join
    });
    it('is absent otherwise: no feature, games off, not in the call, no Play Games (they can still watch a table)', () => {
        expect(g({ feature: false }).launcher).toBe(false);
        expect(g({ gamesEnabled: false }).launcher).toBe(false);
        expect(g({ inCall: false }).launcher).toBe(false);
        expect(g({ perms: PERM.CONNECT }).launcher).toBe(false);
        const watcher = g({ perms: PERM.CONNECT, hasTable: true });
        expect(watcher.launcher).toBe(false);
        expect(watcher.available).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Rendered

let container: HTMLDivElement;
let root: Root;
function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
}
function unmount() {
    act(() => root.unmount());
    container.remove();
}
const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => { (el as HTMLElement).click(); });
};
const button = (name: RegExp, scope: ParentNode = document) =>
    [...scope.querySelectorAll('button')].find(b => name.test(b.textContent ?? '') || name.test(b.getAttribute('aria-label') ?? ''));

describe('the picker', () => {
    beforeEach(mount);
    afterEach(unmount);

    it('with nothing running: Poker and Blackjack as cards with art; a card starts that game', async () => {
        const onStart = vi.fn();
        await act(async () => {
            root.render(
                <ActivityPicker isPhone={false} channelName="Lounge" running={null} canJoin seated={false}
                    onStart={onStart} onJoin={() => {}} onWatch={() => {}} onClose={() => {}} />,
            );
        });
        const cards = [...document.querySelectorAll('.activity-card')];
        expect(cards.map(c => c.getAttribute('data-kind'))).toEqual(['holdem', 'blackjack']);
        expect(cards.every(c => c.querySelector('svg'))).toBe(true); // art is SVG (suits from Icons.tsx)
        // ...and only a picture: nothing in it reads as a card in play (the
        // privacy walks count [data-card] in the DOM).
        expect(document.querySelectorAll('[data-card]').length).toBe(0);
        expect(cards.every(c => !(c as HTMLButtonElement).disabled)).toBe(true);
        expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Activities');
        await click(cards[1]);
        expect(onStart).toHaveBeenCalledWith('blackjack');
    });

    it('with one running: Join it (or Watch); the other game waits, and says why', async () => {
        const onJoin = vi.fn();
        const onStart = vi.fn();
        await act(async () => {
            root.render(
                <ActivityPicker isPhone={false} channelName="Lounge" running={{ kind: 'holdem', playing: 3 }} canJoin seated={false}
                    onStart={onStart} onJoin={onJoin} onWatch={() => {}} onClose={() => {}} />,
            );
        });
        const other = document.querySelector('.activity-card[data-kind="blackjack"]') as HTMLButtonElement;
        expect(other.disabled).toBe(true);
        expect(document.body.textContent).toContain('Poker is running in this call. One activity at a time.');
        expect(document.querySelector('.activity-card[data-kind="holdem"]')?.textContent).toContain('3 playing');
        await click(button(/^Join$/));
        expect(onJoin).toHaveBeenCalledTimes(1);
        expect(onStart).not.toHaveBeenCalled();
    });

    it('on a phone it is a sheet; Escape and the scrim close it', async () => {
        const onClose = vi.fn();
        await act(async () => {
            root.render(
                <ActivityPicker isPhone channelName="Lounge" running={null} canJoin seated={false}
                    onStart={() => {}} onJoin={() => {}} onWatch={() => {}} onClose={onClose} />,
            );
        });
        expect(document.querySelector('.activity-picker.activity-sheet')).not.toBeNull();
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await click(document.querySelector('.activity-scrim'));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

describe('the notice', () => {
    beforeEach(mount);
    afterEach(unmount);

    it('"<name> started Poker" with Join and Watch; not a dialog, takes no focus; dismissable', async () => {
        const onJoin = vi.fn();
        const onWatch = vi.fn();
        const onDismiss = vi.fn();
        const focused = document.activeElement;
        await act(async () => {
            root.render(<ActivityNotice name="Ann" kind="holdem" canJoin onJoin={onJoin} onWatch={onWatch} onDismiss={onDismiss} />);
        });
        const n = document.querySelector('.activity-notice');
        expect(n?.getAttribute('role')).toBe('status');
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(n?.textContent).toContain('Ann started Poker');
        expect(document.activeElement).toBe(focused);
        await click(button(/^Join$/, n!));
        await click(button(/^Watch$/, n!));
        await click(button(/^Dismiss$/, n!));
        expect([onJoin, onWatch, onDismiss].map(f => f.mock.calls.length)).toEqual([1, 1, 1]);
    });

    it('without Play Games: Watch only', async () => {
        await act(async () => {
            root.render(<ActivityNotice name="Ann" kind="blackjack" canJoin={false} onJoin={() => {}} onWatch={() => {}} onDismiss={() => {}} />);
        });
        expect(document.querySelector('.activity-notice')?.textContent).toContain('Ann started Blackjack');
        expect(button(/^Join$/)).toBeUndefined();
        expect(button(/^Watch$/)).toBeDefined();
    });
});

describe('the tile in the call grid', () => {
    beforeEach(mount);
    afterEach(unmount);

    const stage = (activity?: Parameters<typeof VoiceStage>[0]['activity']) => (
        <VoiceStage roomId={ROOM} channelName="Lounge" currentUserId={8} memberAvatars={new Map()} memberNames={new Map()}
            onBackToChat={() => {}} onWatchStream={() => {}} activity={activity} />
    );

    it('no activity, no tile', async () => {
        await act(async () => { root.render(stage(undefined)); });
        expect(document.querySelector('.activity-tile')).toBeNull();
    });

    it('the game, how many play, Join (may play) and Watch; the tile itself opens the table', async () => {
        const onJoin = vi.fn();
        const onWatch = vi.fn();
        const onOpen = vi.fn();
        await act(async () => {
            root.render(stage({ kind: 'holdem', playing: 3, seated: false, canJoin: true, onOpen, onJoin, onWatch }));
        });
        const t = document.querySelector('.activity-tile')!;
        expect(t.textContent).toContain('Poker');
        expect(t.textContent).toContain('3 playing');
        expect(t.querySelector('svg')).not.toBeNull();
        await click(button(/^Join$/, t));
        await click(button(/^Watch$/, t));
        expect(onJoin).toHaveBeenCalledTimes(1);
        expect(onWatch).toHaveBeenCalledTimes(1);
        expect(onOpen).not.toHaveBeenCalled(); // the buttons do not also open via the tile
        await click(t.querySelector('.activity-tile-body'));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('seated: "Open"; without Play Games: Watch only', async () => {
        await act(async () => {
            root.render(stage({ kind: 'blackjack', playing: 1, seated: true, canJoin: true, onOpen: () => {}, onJoin: () => {}, onWatch: () => {} }));
        });
        expect(button(/^Open$/)).toBeDefined();
        expect(button(/^Join$/)).toBeUndefined();
        expect(document.querySelector('.activity-tile')?.textContent).toContain('1 playing');
        await act(async () => {
            root.render(stage({ kind: 'blackjack', playing: 2, seated: false, canJoin: false, onOpen: () => {}, onJoin: () => {}, onWatch: () => {} }));
        });
        expect(button(/^Join$/)).toBeUndefined();
        expect(button(/^Watch$/)).toBeDefined();
    });
});
