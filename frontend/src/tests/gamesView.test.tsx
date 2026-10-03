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
import { attachGamesSocket, resetGamesStoreForTests, setGamesRoom } from '../api/games/gamesStore';
import { GAMES_DISCLOSURE } from '../api/games/gameWords';
import { gamesGate, type GamesGate } from '../api/games/gamesGate';
import { GamesView } from '../components/games/GamesView';
import { VoiceStage } from '../components/VoiceStage';
import { PERM } from '../api/permissionBits';
import { FakeGamesSocket, withVersion } from './gamesTestSocket';

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
        expect(document.querySelectorAll('.pcard-back').length).toBe(6);
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

describe('the Games entry point on the call\'s stage', () => {
    it('VoiceStage shows the Games button only when games are offered, with its label', async () => {
        const open = vi.fn();
        const stage = (onOpenGames?: () => void) => (
            <VoiceStage
                roomId={ROOM}
                channelName="Lounge"
                currentUserId={8}
                memberAvatars={new Map()}
                memberNames={new Map()}
                onBackToChat={() => {}}
                onWatchStream={() => {}}
                onOpenGames={onOpenGames}
                gamesLabel="Join the table"
            />
        );
        await act(async () => { root.render(stage(undefined)); });
        expect(document.querySelector('.voice-stage-games')).toBeNull();
        await act(async () => { root.render(stage(open)); });
        const b = document.querySelector('.voice-stage-games');
        expect(b?.textContent).toContain('Join the table');
        await click(b);
        expect(open).toHaveBeenCalledTimes(1);
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
