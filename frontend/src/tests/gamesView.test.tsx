/**
 * The table on screen (components/games/*), rendered from the contract's
 * fixtures through the real store — what a real engine table serialises to.
 *
 *  - privacy: a spectator's DOM holds no card but the board; a seated
 *    viewer sees exactly their own two cards face up, everyone else's face
 *    down;
 *  - the action bar is the view's `legal`, and its buttons send exactly the
 *    contract's frames (the turn the view showed, street TOTALS);
 *  - a refusal is shown inline, never as an alert; an ending says why;
 *  - the disclosure comes before the first GameSit, once;
 *  - phone: the two-row bar, the amount edited in a sheet, and the CSS gate's
 *    44 px targets / 16 px field.
 *
 * Mounted with raw react-dom/client + act, as the repo's other component
 * tests are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import seated from './fixtures/games/holdem-table-seated.json';
import spectator from './fixtures/games/holdem-table-spectator.json';
import blackjackTable from './fixtures/games/blackjack-table.json';
import holdemEvents from './fixtures/games/holdem-events.json';
import refusals from './fixtures/games/refusals.json';
import ended from './fixtures/games/ended.json';
import { attachGamesSocket, getGamesState, requestJoin, resetGamesStoreForTests, setGamesRoom, startActivity } from '../api/games/gamesStore';
import { GAMES_DISCLOSURE } from '../api/games/gameWords';
import { gamesGate, type GamesGate } from '../api/games/gamesGate';
import { GamesView } from '../components/games/GamesView';
import { PERM } from '../api/permissionBits';
import { FakeGamesSocket, withVersion } from './gamesTestSocket';
import { playGameCues } from '../api/games/gameSounds';
import { loadSettings } from '../components/settingsStore';

// The table's sounds: recorded, never played (jsdom has no Web Audio, and
// nothing in a test may be audible anyway).
vi.mock('../api/games/gameSounds', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/games/gameSounds')>()),
    playGameCues: vi.fn(() => true),
}));

const ROOM = 'voice_42';
const TABLE = 4503599627370497;
const NAMES = new Map([[7, 'Ann'], [8, 'Ben'], [9, 'Cat']]);

const gate = (over: Partial<Parameters<typeof gamesGate>[0]> = {}): GamesGate =>
    gamesGate({ feature: true, gamesEnabled: true, perms: PERM.CONNECT | PERM.PLAY_GAMES, inCall: true, hasTable: true, ...over });

let ws: FakeGamesSocket;
let detach: () => void;
let container: HTMLDivElement;
let root: Root;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    resetGamesStoreForTests();
    // setup.ts stubs localStorage with no-op mocks; the disclosure needs one
    // that remembers, for this test only.
    const mem = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => mem.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { mem.set(k, String(v)); });
    ws = new FakeGamesSocket();
    detach = attachGamesSocket(ws);
    ws.deliver({ type: 'ServerFeatures', payload: { features: ['games'] } });
    setGamesRoom(ROOM);
    ws.deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    detach();
    alertSpy.mockRestore();
});

async function show(opts: { gate?: GamesGate; isPhone?: boolean; currentUserId?: number } = {}) {
    await act(async () => {
        root.render(
            <GamesView
                roomId={ROOM}
                serverId="s1"
                channelName="Lounge"
                currentUserId={opts.currentUserId ?? 8}
                memberNames={NAMES}
                gate={opts.gate ?? gate()}
                isPhone={opts.isPhone ?? false}
                onBack={() => {}}
            />,
        );
    });
}

async function deliver(msg: unknown) {
    await act(async () => { ws.deliver(msg); });
}

async function click(el: Element | null | undefined) {
    expect(el, 'the control to click must exist').toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

const button = (text: string | RegExp, scope: ParentNode = document) =>
    [...scope.querySelectorAll('button')].find(b => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));

/** Every face-up card code in the DOM. */
const faceUp = () => [...document.querySelectorAll('[data-card]')].map(e => e.getAttribute('data-card')).sort();

describe('privacy: what each viewer is shown', () => {
    it('a spectator sees the board and nothing else face up', async () => {
        await deliver(spectator);
        await show({ gate: gate(), currentUserId: 99 });
        expect(faceUp()).toEqual(['2d', '3d', 'Ah']);
        // Everyone in the hand shows two backs.
        expect(document.querySelectorAll('.gseat .pcard-back').length).toBe(6);
        // The two board cards not dealt yet are backs too - with NO card in
        // them: no code, no data, no name but "face-down card".
        const down = [...document.querySelectorAll('.gboard > .pcard-back')];
        expect(down).toHaveLength(2);
        for (const d of down) {
            expect(d.getAttribute('data-card')).toBeNull();
            expect(d.getAttribute('aria-label')).toBe('face-down card');
            expect(d.outerHTML).not.toMatch(/[2-9TJQKA][cdhs]/);
        }
        expect(document.querySelector('.games-actions')).toBeNull();
        expect(container.textContent).toContain('You are watching');
    });

    it('a seated viewer sees exactly their own two cards face up, everyone else face down', async () => {
        await deliver(seated);
        await show();
        expect(faceUp()).toEqual(['2d', '3d', '6c', '8h', 'Ah']);
        const mine = [...document.querySelectorAll('.games-me-cards [data-card]')].map(e => e.getAttribute('aria-label'));
        expect(mine).toEqual(['8 of hearts', '6 of clubs']);
        expect(document.querySelectorAll('.games-opps .pcard-back').length).toBe(4);
    });

    it('the strip shows the players first and the open seats after them', async () => {
        await deliver(spectator); // seats 0, 2, 4 taken
        await show({ currentUserId: 99 });
        const tiles = [...document.querySelectorAll('.games-opps .gseat')];
        expect(tiles.map(t => t.classList.contains('gseat-empty'))).toEqual([false, false, false, true, true, true]);
        expect(tiles.slice(0, 3).map(t => t.querySelector('.gseat-name')?.textContent)).toEqual(['Ann', 'Ben', 'Cat']);
    });

    it('names come from the member list; the seat to act has the clock', async () => {
        await deliver(spectator); // a spectator's strip holds every seat; seat 2 (Ben) is to act
        await show({ currentUserId: 99 });
        const turn = document.querySelector('.gseat-turn');
        expect(turn?.textContent).toContain('Ben');
        expect(turn?.querySelector('[role="timer"]')).toBeTruthy();
    });
});

describe('the Hold\'em action bar sends the contract\'s frames', () => {
    it('Check answers the turn the view showed', async () => {
        await deliver(seated);
        await show();
        await click(button('Check'));
        expect(ws.sentOf('GameAct')).toEqual([{
            type: 'GameAct',
            payload: { room_id: ROOM, table_id: TABLE, turn: { hand_no: 1, turn_seq: 4 }, action: { type: 'check' } },
        }]);
        // Answered: a second tap cannot send a second action for this turn.
        expect(button('Check')!.disabled).toBe(true);
        await click(button('Fold'));
        expect(ws.sentOf('GameAct')).toHaveLength(1);
    });

    it('a refused act re-enables the bar (and is shown inline, not as an alert)', async () => {
        await deliver(seated);
        await show();
        await click(button('Check'));
        const notYourTurn = refusals.find(r => r.payload.code === 'not_your_turn');
        await new Promise(r => setTimeout(r, 2)); // the refusal arrives after the send
        await deliver(notYourTurn);
        expect(document.querySelector('.games-notice')?.textContent).toContain('It isn’t your turn.');
        expect(button('Check')!.disabled).toBe(false);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('presets and the stepper set a street TOTAL; the bet button sends it', async () => {
        await deliver(seated);
        await show();
        expect(button('Bet to 10')).toBeTruthy();
        await click(document.querySelector('button[aria-label="Pot: 30"]'));
        expect(button('Bet to 30')).toBeTruthy();
        await click(document.querySelector('button[aria-label="Raise the raise"]'));
        await click(button('Bet to 40'));
        expect(ws.sentOf('GameAct').at(-1)!.payload.action).toEqual({ type: 'bet_or_raise_to', amount: 40 });
    });

    it('the desktop field takes a typed amount without clamping mid-typing, then sends it clamped', async () => {
        await deliver(seated);
        await show();
        const input = document.querySelector('.games-footer input.games-amount-input') as HTMLInputElement;
        const type = async (v: string) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            await act(async () => { setter.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })); });
        };
        await type('5'); // on the way to 50: below the minimum, must NOT snap to 10
        expect(input.value).toBe('5');
        await type('50');
        expect(input.value).toBe('50');
        expect(button('Bet to 50')).toBeTruthy();
        await type('99999'); // beyond the stack: the button says all-in
        expect(button('All-in 990')).toBeTruthy();
        await click(button('All-in 990'));
        expect(ws.sentOf('GameAct').at(-1)!.payload.action).toEqual({ type: 'all_in' });
    });

    it('All-in goes as all_in', async () => {
        await deliver(seated);
        await show();
        await click(document.querySelector('button[aria-label="All-in: 990"]'));
        await click(button('All-in 990'));
        expect(ws.sentOf('GameAct').at(-1)!.payload.action).toEqual({ type: 'all_in' });
    });

    it('a showdown: shown hands face up, the mucked hand never; your result worded; a voluntary show later', async () => {
        await deliver(withVersion(holdemEvents[2], 8));
        await deliver(withVersion(holdemEvents[3], 9)); // the showdown, in order
        await show({ currentUserId: 7 }); // Ann, viewer_seat 0 in the events fixture
        expect(faceUp()).toEqual(expect.arrayContaining(['8c', '5c', '8h', '6c']));
        // Seat 4 mucked: nothing of its hand is anywhere in the DOM.
        expect(faceUp()).not.toContain('4h');
        expect(faceUp()).not.toContain('7s');
        expect(container.querySelector('.games-me-result')?.textContent).toBe('Pair');
        expect(button('Show cards')).toBeFalsy(); // already shown at the showdown
        const log = container.querySelector('.games-log')?.textContent ?? '';
        expect(log).toContain('Ben shows pair, You show pair, Cat mucks.');
        expect(log).toContain('Ben wins 15, You win 15.');
        // Cat shows voluntarily afterwards: now, and only now, 4h 7s are face up.
        await deliver(withVersion(holdemEvents[4], 10));
        expect(faceUp()).toEqual(expect.arrayContaining(['4h', '7s']));
        expect(container.querySelector('.games-log')?.textContent).toContain('Cat shows their cards.');
    });
});

describe('Blackjack', () => {
    it('the dealer\'s hole card is face down; the legal buttons follow `legal`', async () => {
        await deliver(blackjackTable);
        await show({ currentUserId: 7 });
        expect(document.querySelectorAll('.bj-dealer .pcard-back').length).toBe(1);
        expect(document.querySelector('.bj-dealer [data-card="8s"]')).toBeTruthy();
        expect(button('Hit')!.disabled).toBe(false);
        expect(button('Double')!.disabled).toBe(false);
        expect(button('Split')!.disabled).toBe(true);
        await click(button('Hit'));
        expect(ws.sentOf('GameAct')[0].payload).toMatchObject({ turn: { hand_no: 1, turn_seq: 1 }, action: { type: 'hit' } });
    });

    it('between rounds: a bet sends GameBet with the chosen amount', async () => {
        const between = JSON.parse(JSON.stringify(blackjackTable));
        between.payload.view.in_round = false;
        between.payload.view.legal = null;
        between.payload.view.to_act = null;
        between.payload.view.turn = null;
        await deliver(between);
        await show({ currentUserId: 7 });
        await click(button('250'));
        await click(button('Bet 250'));
        expect(ws.sentOf('GameBet')).toEqual([{ type: 'GameBet', payload: { room_id: ROOM, table_id: TABLE, amount: 250 } }]);
    });
});

describe('notices and the disclosure', () => {
    it('GameEnded clears the table and says why; with PLAY_GAMES the open panel returns', async () => {
        await deliver(seated);
        await show({ gate: gate({ hasTable: false }) });
        await deliver(ended[0]);
        expect(document.querySelector('.games-notice')?.textContent).toContain('A moderator closed the table.');
        expect(document.querySelector('.gtable')).toBeNull();
        expect(button(/Open a Poker table/)).toBeTruthy();
    });

    it('opening a table sends GameCreate with ONLY the chosen game\'s settings', async () => {
        await show({ gate: gate({ hasTable: false }) });
        await click(document.querySelector('button[role="radio"][aria-checked="false"]'));
        await click(button(/Open a Blackjack table/));
        expect(ws.sentOf('GameCreate')).toEqual([{
            type: 'GameCreate',
            payload: { room_id: ROOM, kind: 'blackjack', config: { starting_stack: 1000, min_bet: 10, max_bet: 500 } },
        }]);
        expect(button(/Opening/)).toBeTruthy();
        // A refusal of the create is shown inline and ends "Opening…".
        await new Promise(r => setTimeout(r, 2));
        await deliver(refusals.find(r => r.payload.code === 'room_has_table'));
        expect(document.querySelector('.games-notice')?.textContent).toMatch(/already open in this call/);
        expect(button(/Opening/)).toBeFalsy();
    });

    // Found live (e2e/games-live.mjs): the moderator who opened a table, closed
    // it and wanted the other game found the button stuck on "Opening…" — the
    // view still waited for an answer to its FIRST create, which the table that
    // came (and went) had already given.
    it('the opener can open again once their table has ended: "Opening…" ends when the table arrives', async () => {
        await show({ gate: gate({ hasTable: false }) });
        await click(button(/Open a Poker table/));
        expect(button(/Opening/)).toBeTruthy();
        await new Promise(r => setTimeout(r, 2));
        await deliver(seated);
        await deliver(ended[0]);
        expect(document.querySelector('.games-notice')?.textContent).toContain('A moderator closed the table.');
        const again = button(/Open a Poker table/) as HTMLButtonElement | undefined;
        expect(again, 'the open button is back, not "Opening…"').toBeTruthy();
        expect(again!.disabled).toBe(false);
        // ...and it still holds after the person dismisses the ending.
        await click(document.querySelector('.games-notice-close'));
        expect(button(/Open a Poker table/)).toBeTruthy();
        await click(document.querySelector('button[role="radio"][aria-checked="false"]'));
        await click(button(/Open a Blackjack table/));
        expect(ws.sentOf('GameCreate').map(f => f.payload.kind)).toEqual(['holdem', 'blackjack']);
    });

    it('the disclosure comes before the FIRST sit, with the owner\'s words, and only once', async () => {
        await deliver(spectator);
        await show({ currentUserId: 99 });
        const sitButtons = () => [...document.querySelectorAll('.gseat-sit')];
        expect(sitButtons().length).toBe(3); // seats 1, 3, 5 are open
        await click(sitButtons()[0]);
        const dialog = document.querySelector('.games-disclosure');
        expect(dialog?.textContent).toContain(GAMES_DISCLOSURE);
        expect(ws.sentOf('GameSit')).toHaveLength(0);
        await click(button('Sit down', dialog!));
        expect(ws.sentOf('GameSit')).toEqual([{ type: 'GameSit', payload: { room_id: ROOM, table_id: TABLE, seat: 1 } }]);
        expect(document.querySelector('.games-disclosure')).toBeNull();
        expect(localStorage.setItem).toHaveBeenCalled();
        // A second sit (another table, later) goes straight through.
        await click(sitButtons()[1]);
        expect(document.querySelector('.games-disclosure')).toBeNull();
        expect(ws.sentOf('GameSit')).toHaveLength(2);
    });

    it('without PLAY_GAMES a spectator gets no seat to take', async () => {
        await deliver(spectator);
        await show({ gate: gate({ perms: PERM.CONNECT }), currentUserId: 99 });
        expect(document.querySelectorAll('.gseat-sit').length).toBe(0);
        expect(container.textContent).toContain('You are watching this table.');
    });

    it('MOVE_MEMBERS shows Close table and Remove; without it neither', async () => {
        await deliver(seated);
        await show();
        expect(button('Close table')).toBeFalsy();
        expect(document.querySelector('.gseat-remove')).toBeNull();
        await show({ gate: gate({ perms: PERM.CONNECT | PERM.PLAY_GAMES | PERM.MOVE_MEMBERS }) });
        expect(button('Close table')).toBeTruthy();
        expect(document.querySelectorAll('.gseat-remove').length).toBe(2);
    });
});


describe('the table: an oval with the seats around it', () => {
    it('the viewer sits at the bottom; every other seat has its own place; the dealer button is on its seat', async () => {
        await deliver(seated); // viewer seat 2 (Ben); seats 0, 2, 4 taken; button 0
        await show();
        const me = document.querySelector('.gseat-me');
        expect(me?.classList.contains('gseat-side-bottom')).toBe(true);
        expect(me?.querySelector('.gseat-name')?.textContent).toBe('You');
        // Your own cards are in the footer, not repeated on the table.
        expect(me?.querySelector('.pcard')).toBeNull();
        const places = [...document.querySelectorAll<HTMLElement>('.gtable-oval .gseat')].map(e => `${e.style.getPropertyValue('--gx')},${e.style.getPropertyValue('--gy')}`);
        expect(places).toHaveLength(6);
        expect(new Set(places).size).toBe(6);
        const dealer = [...document.querySelectorAll('.gseat')].find(e => e.querySelector('.gbadge-dealer'));
        expect(dealer?.querySelector('.gseat-name')?.textContent).toBe('Ann');
    });

    it('a seat with chips in front of it shows the bet on the felt side', async () => {
        await deliver(withVersion(holdemEvents[1], 7)); // the deal: blinds posted
        await show({ currentUserId: 7 });
        const bets = [...document.querySelectorAll('.gseat-bet')].map(b => b.textContent);
        expect(bets.sort()).toEqual(['10', '5']);
    });
});

describe('the board: five cards face down, turned as they are dealt', () => {
    it('the flop arriving turns its three cards one after another; the rest stay face down', async () => {
        await deliver(withVersion(holdemEvents[1], 7));
        await show({ currentUserId: 7 });
        expect(document.querySelectorAll('.gboard > .pcard-back')).toHaveLength(5);
        expect(document.querySelectorAll('.gboard [data-card]')).toHaveLength(0);
        await deliver(withVersion(holdemEvents[2], 8)); // a check and the flop
        const flips = [...document.querySelectorAll<HTMLElement>('.gboard .pflip')];
        expect(flips.map(f => f.querySelector('[data-card]')?.getAttribute('data-card'))).toEqual(['3d', 'Ah', '2d']);
        expect(flips.every(f => f.classList.contains('pflip-anim'))).toBe(true);
        const delays = flips.map(f => parseFloat(f.style.getPropertyValue('--pflip-delay')));
        expect(delays[0]).toBeGreaterThan(0);
        expect(delays[1]).toBeGreaterThan(delays[0]);
        expect(delays[2]).toBeGreaterThan(delays[1]);
        expect(document.querySelectorAll('.gboard > .pcard-back')).toHaveLength(2);
    });

    it('a board already on the table when it opens does not flip again', async () => {
        await deliver(seated);
        await show();
        expect(document.querySelectorAll('.gboard .pflip')).toHaveLength(3);
        expect(document.querySelectorAll('.gboard .pflip-anim')).toHaveLength(0);
    });

    it('between hands the slots are empty, not face down', async () => {
        await deliver(withVersion(holdemEvents[2], 8));
        await deliver(withVersion(holdemEvents[3], 9)); // the showdown ends the hand
        await show({ currentUserId: 7 });
        expect(document.querySelectorAll('.gboard > .pcard-back')).toHaveLength(0);
    });
});

describe('the pots: main pot and side pots, and who won them', () => {
    const withPots = (pots: { amount: number; eligible: number[] }[], total: number) => {
        const f = JSON.parse(JSON.stringify(seated));
        f.payload.view.pots = pots;
        f.payload.view.pot_total = total;
        return f;
    };

    it('two pots show as Main pot and Side pot; one the viewer did not cover is marked', async () => {
        await deliver(withPots([{ amount: 300, eligible: [0, 2, 4] }, { amount: 400, eligible: [0, 4] }], 750));
        await show(); // viewer seat 2 is only in the main pot
        const pills = [...document.querySelectorAll('.gpot-pill')];
        expect(pills.map(p => p.textContent)).toEqual(['Main pot 300', 'Side pot 400 (you are not in this pot)']);
        expect(pills[0].classList.contains('gpot-out')).toBe(false);
        expect(pills[1].classList.contains('gpot-out')).toBe(true);
        // 50 is still in front of the players this street.
        expect(document.querySelector('.gpot-total')?.textContent).toBe('Total 750');
    });

    it('three pots are numbered; one pot (or an older server that sends none) is just the pot', async () => {
        await deliver(withPots([{ amount: 300, eligible: [0, 2, 4] }, { amount: 200, eligible: [0, 2] }, { amount: 100, eligible: [2] }], 600));
        await show();
        expect([...document.querySelectorAll('.gpot-pill')].map(p => p.textContent)).toEqual(['Main pot 300', 'Side pot 1 200', 'Side pot 2 100']);
        await deliver(withVersion(withPots([], 30), 9));
        expect(document.querySelectorAll('.gpot-pill')).toHaveLength(0);
        expect(document.querySelector('.gpot')?.textContent).toBe('Pot 30');
    });

    it('after the hand, the felt says who won what', async () => {
        await deliver(withVersion(holdemEvents[2], 8));
        await deliver(withVersion(holdemEvents[3], 9));
        await show({ currentUserId: 7 }); // Ann, seat 0, split the pot with Ben
        expect(document.querySelector('.gpot')?.textContent).toBe('Pot 30 Ben, You');
        // A later hand that ended while frames were lost (a gap): its result
        // was never seen, and the older hand's must not stand in for it.
        const later = JSON.parse(JSON.stringify(holdemEvents[3]));
        later.type = 'GameTable';
        later.payload.version = 20;
        later.payload.view.hand_no = 2;
        delete later.payload.events;
        await deliver(later);
        expect(document.querySelector('.gpot')?.textContent).toBe('Pot 0');
    });
});

describe('sounds and the speaker button', () => {
    beforeEach(() => vi.mocked(playGameCues).mockClear());

    it('opening the table plays nothing; each new frame plays its own sounds', async () => {
        await deliver(withVersion(holdemEvents[1], 7));
        await show({ currentUserId: 7 });
        expect(playGameCues).not.toHaveBeenCalled();
        await deliver(withVersion(holdemEvents[2], 8));
        expect(playGameCues).toHaveBeenCalledTimes(1);
        const cues = vi.mocked(playGameCues).mock.calls[0][0].map(c => c.cue);
        expect(cues.slice(0, 4)).toEqual(['check', 'flip', 'flip', 'flip']);
        // The same frame again (a resync) is not news.
        await deliver(withVersion(holdemEvents[2], 8));
        expect(playGameCues).toHaveBeenCalledTimes(1);
    });

    it('a new decision of yours chimes once; someone else\'s turn does not', async () => {
        const waiting = JSON.parse(JSON.stringify(seated));
        waiting.payload.view.legal = null;
        waiting.payload.view.to_act = 0;
        waiting.payload.view.turn = { hand_no: 1, turn_seq: 3 };
        await deliver(withVersion(waiting, 7));
        await show(); // Ben, seat 2: Ann is to act
        await deliver(withVersion(waiting, 8));
        expect(playGameCues).not.toHaveBeenCalled();
        await deliver(withVersion(seated, 9)); // now it is Ben's turn
        expect(vi.mocked(playGameCues).mock.calls.map(c => c[0].map(q => q.cue))).toEqual([['turn']]);
        await deliver(withVersion(seated, 10)); // the same decision again (a resync)
        expect(playGameCues).toHaveBeenCalledTimes(1);
    });

    it('the speaker button turns the game sounds off and on (the setting Settings shows)', async () => {
        await deliver(seated);
        await show();
        const speaker = () => document.querySelector('.games-sound-btn') as HTMLButtonElement;
        expect(speaker().getAttribute('aria-pressed')).toBe('true');
        await click(speaker());
        expect(loadSettings().gameSounds).toBe(false);
        expect(speaker().getAttribute('aria-pressed')).toBe('false');
        expect(speaker().getAttribute('aria-label')).toBe('Game sounds');
        expect(speaker().getAttribute('title')).toBe('Turn game sounds on');
        await click(speaker());
        expect(loadSettings().gameSounds).toBe(true);
    });
});

describe('phone layout', () => {
    it('the bar is two rows, the amount is a button that opens the sheet with a numeric field', async () => {
        await deliver(seated);
        await show({ isPhone: true });
        expect(document.querySelector('.games-view-phone')).toBeTruthy();
        const rows = document.querySelectorAll('.games-footer .games-actions > .games-actions-row');
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toMatch(/Fold.*Check.*Bet to 10/);
        expect(rows[1].querySelectorAll('.gpreset').length).toBe(4);
        expect(document.querySelector('.games-footer input')).toBeNull();
        await click(document.querySelector('.games-amount-btn'));
        const sheet = document.querySelector('.games-sheet');
        expect(sheet?.getAttribute('role')).toBe('dialog');
        const input = sheet!.querySelector('input[type="number"]') as HTMLInputElement;
        expect(input.getAttribute('inputmode')).toBe('numeric');
        // The sheet rides on the visual viewport: a bottom offset is set inline.
        expect((sheet as HTMLElement).style.bottom).toMatch(/px$/);
        await click(button('Bet to 10', sheet!));
        expect(ws.sentOf('GameAct').at(-1)!.payload.action).toEqual({ type: 'bet_or_raise_to', amount: 10 });
        expect(document.querySelector('.games-sheet')).toBeNull();
    });

    it('desktop edits the amount inline', async () => {
        await deliver(seated);
        await show({ isPhone: false });
        expect(document.querySelector('.games-view-phone')).toBeNull();
        expect(document.querySelector('.games-footer input.games-amount-input')).toBeTruthy();
        expect(document.querySelector('.games-amount-btn')).toBeNull();
    });

    it('the coarse-pointer CSS makes every target 44 px, the field 16 px, and hover lives under a fine pointer', () => {
        const css = fs.readFileSync(path.resolve(__dirname, '../components/games/GamesView.css'), 'utf8');
        const phone = css.slice(css.indexOf('@media (pointer: coarse) and (max-width: 1024px)'));
        expect(phone.length).toBeGreaterThan(100);
        expect(phone).toMatch(/\.games-btn \{[^}]*min-height: 44px;[^}]*min-width: 44px;/);
        expect(phone).toMatch(/\.games-amount-input \{[^}]*font-size: 16px;/);
        expect(phone).toMatch(/\.games-opps \{[^}]*overflow-x: auto;/);
        // Every :hover rule sits inside a (pointer: fine) block.
        const hovers = [...css.matchAll(/:hover/g)].map(m => m.index!);
        const fine = css.indexOf('@media (pointer: fine)');
        expect(hovers.length).toBeGreaterThan(0);
        for (const h of hovers) expect(h).toBeGreaterThan(fine);
        expect(css.slice(fine, css.indexOf('}', css.indexOf('}', fine) + 1) + 1)).toMatch(/:hover/);
    });
});

describe('Join from the notice or the tile, and Back to call', () => {
    it('Join seats me at the first open seat - after the disclosure the first time', async () => {
        await deliver(spectator);
        await show({ currentUserId: 99 });
        await act(async () => { requestJoin(); });
        const dialog = document.querySelector('.games-disclosure');
        expect(dialog?.textContent).toContain(GAMES_DISCLOSURE);
        expect(ws.sentOf('GameSit')).toHaveLength(0);
        await click(button('Sit down', dialog!));
        expect(ws.sentOf('GameSit')).toEqual([{ type: 'GameSit', payload: { room_id: ROOM, table_id: TABLE, seat: 1 } }]);
        expect(getGamesState().joinRequest).toBeNull();
    });

    it('...and straight away once the disclosure was seen; once per request', async () => {
        const { markDisclosureSeen } = await import('../api/games/gamesDisclosure');
        markDisclosureSeen(99, 's1');
        await deliver(spectator);
        await show({ currentUserId: 99 });
        await act(async () => { requestJoin(); });
        expect(document.querySelector('.games-disclosure')).toBeNull();
        expect(ws.sentOf('GameSit')).toEqual([{ type: 'GameSit', payload: { room_id: ROOM, table_id: TABLE, seat: 1 } }]);
        await deliver(withVersion(spectator, 9)); // a later frame does not sit again
        expect(ws.sentOf('GameSit')).toHaveLength(1);
    });

    it('a join request waits for the view: made before it mounted, it is taken when it does', async () => {
        const { markDisclosureSeen } = await import('../api/games/gamesDisclosure');
        markDisclosureSeen(99, 's1');
        await deliver(spectator);
        await act(async () => { requestJoin(); });
        expect(ws.sentOf('GameSit')).toHaveLength(0);
        await show({ currentUserId: 99 });
        expect(ws.sentOf('GameSit')).toHaveLength(1);
    });

    it('without Play Games, or at a full table, a join request seats nobody', async () => {
        const { markDisclosureSeen } = await import('../api/games/gamesDisclosure');
        markDisclosureSeen(99, 's1');
        await deliver(spectator);
        await show({ currentUserId: 99, gate: gate({ perms: PERM.CONNECT }) });
        await act(async () => { requestJoin(); });
        expect(ws.sentOf('GameSit')).toHaveLength(0);
        expect(getGamesState().joinRequest).toBeNull();
        const full = JSON.parse(JSON.stringify(spectator));
        full.payload.version = 9;
        for (const i of [1, 3, 5]) full.payload.view.seats[i] = { ...full.payload.view.seats[0], seat: i, user_id: 100 + i, cards: null };
        await deliver(full);
        await show({ currentUserId: 99 });
        await act(async () => { requestJoin(); });
        expect(ws.sentOf('GameSit')).toHaveLength(0);
        expect(container.textContent).toContain('Every seat is taken');
    });

    it('a start from the launcher says "Starting Poker…" until its table arrives (no form in the way)', async () => {
        startActivity(ROOM, 'holdem');
        await show();
        expect(container.textContent).toContain('Starting Poker…');
        expect(document.querySelector('.games-open')).toBeNull();
        await deliver(spectator);
        expect(container.textContent).not.toContain('Starting Poker…');
        expect(document.querySelector('.gtable-holdem')).not.toBeNull();
    });

    it('"Back to call" on a desktop and on a phone; it never touches the call', async () => {
        const onBack = vi.fn();
        await deliver(spectator);
        await act(async () => {
            root.render(
                <GamesView roomId={ROOM} serverId="s1" channelName="Lounge" currentUserId={8} memberNames={NAMES}
                    gate={gate()} isPhone onBack={onBack} />,
            );
        });
        await click(button(/Back to call/));
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(ws.sent.filter(f => !f.type.startsWith('Game'))).toEqual([]);
        await show({ isPhone: false });
        expect(button(/Back to call/)).toBeDefined();
    });
});

describe('the disclosure is remembered per account AND per server', () => {
    it('another server, or another account on this device, sees it again', async () => {
        const { disclosureSeen, markDisclosureSeen } = await import('../api/games/gamesDisclosure');
        expect(disclosureSeen(8, 's1')).toBe(false);
        markDisclosureSeen(8, 's1');
        expect(disclosureSeen(8, 's1')).toBe(true);
        expect(disclosureSeen(8, 's2')).toBe(false); // a different operator
        expect(disclosureSeen(9, 's1')).toBe(false); // a different person
    });

    it('storage that throws or holds junk reads as "not seen" (show it again)', async () => {
        const { disclosureSeen } = await import('../api/games/gamesDisclosure');
        vi.mocked(localStorage.getItem).mockImplementation(() => '[1,2]');
        expect(disclosureSeen(8, 's1')).toBe(false);
        vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('denied'); });
        expect(disclosureSeen(8, 's1')).toBe(false);
    });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
/** A deep copy of a fixture frame at `version`, its view edited. */
function edited<T>(frame: T, version: number, edit: (v: Json) => void): T {
    const f = JSON.parse(JSON.stringify(frame)) as Json;
    f.payload.version = version;
    edit(f.payload.view);
    return f as T;
}

describe('a decision is never locked by a send that did not go out (review, 2026-10-03)', () => {
    it("Hold'em: a tap while the socket is down leaves the bar live; the resync of the same turn keeps it live", async () => {
        await deliver(seated);
        await show();
        ws.open = false;
        await click(button('Check'));
        expect(ws.sentOf('GameAct')).toHaveLength(0); // nothing reached the server
        expect(button('Check')!.disabled).toBe(false);
        ws.open = true;
        // The reconnect: RoomJoined -> GameResync -> the server answers the
        // SAME turn at the same version (it never got the action).
        await deliver({ type: 'RoomJoined', payload: { room_id: ROOM, members: [] } });
        await deliver(withVersion(seated, 8));
        expect(button('Check')!.disabled).toBe(false);
        await click(button('Check'));
        expect(ws.sentOf('GameAct')).toHaveLength(1);
        expect(button('Check')!.disabled).toBe(true); // answered: waits for the next view
    });

    it("Hold'em: a sent action whose answer was lost is retried after the resync answers the same turn", async () => {
        await deliver(seated);
        await show();
        await click(button('Check'));
        expect(button('Check')!.disabled).toBe(true);
        // A half-open socket: the frame was "sent" but never arrived; the
        // resync shows the very same decision again.
        await deliver(withVersion(seated, 8));
        expect(button('Check')!.disabled).toBe(false);
        await click(button('Check'));
        expect(ws.sentOf('GameAct')).toHaveLength(2); // a duplicate is a harmless stale_turn
    });

    it('Blackjack: a tap while the socket is down leaves Hit live', async () => {
        await deliver(blackjackTable);
        await show({ currentUserId: 7 });
        ws.open = false;
        await click(button('Hit'));
        expect(button('Hit')!.disabled).toBe(false);
        ws.open = true;
        await deliver(withVersion(blackjackTable, 6));
        await click(button('Hit'));
        expect(ws.sentOf('GameAct')).toHaveLength(1);
    });
});

describe('an amount sheet belongs to the decision it was opened for (review, 2026-10-03)', () => {
    it("Hold'em: a raise sheet left open when the turn passed does not come back by itself on the next turn", async () => {
        await deliver(seated);
        await show({ isPhone: true });
        await click(document.querySelector('.games-amount-btn'));
        expect(document.querySelector('.games-sheet')).not.toBeNull();
        // The clock checks for me: someone else's turn.
        await deliver(edited(seated, 9, v => { v.legal = null; v.to_act = 0; v.turn = { hand_no: 1, turn_seq: 5 }; }));
        expect(document.querySelector('.games-sheet')).toBeNull();
        // My next turn: no sheet, no focus grab (the phone's keyboard stays down).
        const before = document.activeElement;
        await deliver(edited(seated, 10, v => { v.turn = { hand_no: 1, turn_seq: 9 }; }));
        expect(document.querySelector('.games-sheet')).toBeNull();
        expect(document.activeElement).toBe(before);
        // Positive control: the button still opens it for THIS turn.
        await click(document.querySelector('.games-amount-btn'));
        expect(document.querySelector('.games-sheet')).not.toBeNull();
    });

    it('Blackjack: a bet sheet left open when the round was dealt does not come back at the next betting window', async () => {
        const betting = (version: number, round: number) => edited(blackjackTable, version, v => {
            v.in_round = false; v.round_no = round; v.legal = null; v.to_act = null; v.turn = null;
            v.seats[0].hands = [];
        });
        await deliver(betting(6, 1));
        await show({ isPhone: true, currentUserId: 7 });
        await click(document.querySelector('.games-amount-btn'));
        expect(document.querySelector('.games-sheet')).not.toBeNull();
        await deliver(edited(blackjackTable, 7, v => { v.round_no = 2; v.legal = null; v.to_act = { seat: 1, hand: 0 }; }));
        expect(document.querySelector('.games-sheet')).toBeNull();
        const before = document.activeElement;
        await deliver(betting(8, 2));
        expect(document.querySelector('.games-sheet')).toBeNull();
        expect(document.activeElement).toBe(before);
        await click(document.querySelector('.games-amount-btn'));
        expect(document.querySelector('.games-sheet')).not.toBeNull();
    });
});
