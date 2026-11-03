/**
 * A question about a mode, answered after the mode moved. On the desktop a question is in the
 * page and the page goes on running behind it (api/appDialogs.ts), so a ServerModeChanged frame
 * can land while it is open. PUT /modes/active names only what to turn on, and the server ends
 * whatever is on by then: the answer to "3 people are in Game Night" would disconnect everyone in
 * Movie Night, whom nobody warned about. A menu left open is the same on every platform, with no
 * question at all when the rooms it knows of are empty. Through the real Chat, its real menu, the
 * real question and the real frame handler; and the real Modes tab for the sibling, deleting a mode.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { mountAppDialogs } from './appDialogsHost';

const ME = 1;
const GAME_NIGHT = 3;
const MOVIE_NIGHT = 4;

const h = vi.hoisted(() => ({
    tauri: true,
    activeModeId: 3 as number | null,
    /** What was sent to the server that changes something. */
    sent: [] as { method: string; path: string; body: unknown }[],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
}));
vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
    currentUserIdFromToken: () => ME,
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const mode = (id: number, name: string, channelIds: number[]) => ({
    id, name, background_file_id: null, accent_color: null, home_channel_id: null, auto_off: false, channel_ids: channelIds,
});
const serverRow = () => ({ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z', active_mode_id: h.activeModeId });
const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && /\/modes/.test(u)) {
        h.sent.push({ method, path: u.slice(u.indexOf('/servers')), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return reply(200, { active_mode_id: null, disconnected: 0 });
    }
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [serverRow()]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [
        { id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, mode_ids: [] },
        { id: 21, name: 'Town Square', channel_type: 1, server_id: 's1', my_permissions: 0x7fffffff, mode_ids: [GAME_NIGHT] },
        { id: 22, name: 'Screening Room', channel_type: 1, server_id: 's1', my_permissions: 0x7fffffff, mode_ids: [MOVIE_NIGHT] },
    ]);
    if (/\/servers\/s1\/modes$/.test(u)) return reply(200, {
        active_mode_id: h.activeModeId,
        can_switch: true,
        can_edit: true,
        can_call_back: true,
        modes: [mode(GAME_NIGHT, 'Game Night', [21]), mode(MOVIE_NIGHT, 'Movie Night', [22])],
    });
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { ModesSettings } = await import('../components/modes/ModesSettings');
const { wsClient } = await import('../api/websocket');
const { globalVoiceUsers, upsertVoiceUser } = await import('../components/voiceState');
const { keys } = await import('../hooks/queries');
const { adoptModeFrame } = await import('../api/serverModes');
const { closeAppDialogs } = await import('../api/appDialogs');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let dialogs: ReturnType<typeof mountAppDialogs>;
let modeFrames: ((m: Frame) => void)[] = [];

beforeEach(() => {
    h.tauri = true;
    h.activeModeId = GAME_NIGHT;
    h.sent = [];
    modeFrames = [];
    dialogs = mountAppDialogs();
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        if (type === 'ServerModeChanged') modeFrames.push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
});
afterEach(() => {
    act(() => closeAppDialogs());
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    globalVoiceUsers.clear();
    dialogs.unmount();
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const question = () => document.querySelector<HTMLDialogElement>('dialog.app-question');
const answerOk = async () => {
    await act(async () => { question()!.querySelector<HTMLButtonElement>('.app-question-ok')!.click(); });
    await settle();
};
const said = (text: string) => document.body.textContent?.includes(text) ?? false;
const NOTHING_SWITCHED = 'The mode changed while you were deciding. Nothing was switched.';
const NOTHING_DELETED = 'The mode changed while you were deciding. Nothing was deleted.';

describe('a switch answered after the mode moved', () => {
    async function mountChat() {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await act(async () => {
            root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
        });
        for (let i = 0; i < 40 && !document.querySelector('[data-testid="mode-selector"]')?.textContent?.includes('Game Night'); i++) await settle();
        expect(document.querySelector('[data-testid="mode-selector"]')?.textContent, 'the mode is on screen').toContain('Game Night');
        // Three people in Game Night's room, so that turning it off has something to warn about.
        for (const id of [7, 8, 9]) upsertVoiceUser('voice_21', { id, username: `u${id}` });
    }
    const openMenu = () => act(async () => { document.querySelector<HTMLElement>('[data-testid="mode-selector"]')!.click(); });
    async function pressOffInMenu() {
        const off = [...document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item')].find(b => b.textContent === 'Off');
        expect(off, 'the menu offers Off').toBeTruthy();
        await act(async () => { off!.click(); });
        await settle();
    }
    /** The real selector, the real menu, the real item: what a person presses to get the question. */
    async function pressOff() {
        await openMenu();
        await pressOffInMenu();
    }
    const frame = async (active: number | null, previous: number | null) => {
        expect(modeFrames.length, 'Chat listens for the frame').toBeGreaterThan(0);
        // First: the frame is the server telling, and the refetch it starts reads the moved row.
        h.activeModeId = active;
        await act(async () => {
            modeFrames.at(-1)!({ type: 'ServerModeChanged', payload: { server_id: 's1', active_mode_id: active, previous_mode_id: previous, by: 2 } });
        });
        await settle();
    };

    it('another mode came on behind the question: OK switches nothing, and says so', async () => {
        await mountChat();
        await pressOff();
        expect(question()?.textContent, 'the warning names the mode that is on now').toContain('3 people are in the voice channels of Game Night');
        await frame(MOVIE_NIGHT, GAME_NIGHT);
        expect(question(), 'the question is still open over it').not.toBeNull();
        await answerOk();
        expect(h.sent, 'turning "off" now would end Movie Night, which nobody warned about').toEqual([]);
        expect(said(NOTHING_SWITCHED)).toBe(true);
    });

    it('someone turned it off behind the question: the same', async () => {
        await mountChat();
        await pressOff();
        await frame(null, GAME_NIGHT);
        await answerOk();
        expect(h.sent).toEqual([]);
        expect(said(NOTHING_SWITCHED)).toBe(true);
    });

    it('CONTROL: nothing moved, and OK switches', async () => {
        await mountChat();
        await pressOff();
        await answerOk();
        expect(h.sent).toEqual([{ method: 'PUT', path: '/servers/s1/modes/active', body: { mode_id: null } }]);
        expect(said(NOTHING_SWITCHED)).toBe(false);
    });

    it('it moved and came back: the warning is true again, so OK switches', async () => {
        await mountChat();
        await pressOff();
        await frame(MOVIE_NIGHT, GAME_NIGHT);
        await frame(GAME_NIGHT, MOVIE_NIGHT);
        await answerOk();
        expect(h.sent).toEqual([{ method: 'PUT', path: '/servers/s1/modes/active', body: { mode_id: null } }]);
        expect(said(NOTHING_SWITCHED)).toBe(false);
    });

    it('Chat tells its menu how it was pressed: a key goes in to Off, a pointer stops at the menu', async () => {
        await mountChat();
        const selector = document.querySelector<HTMLElement>('[data-testid="mode-selector"]')!;
        await act(async () => { selector.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
        expect(document.activeElement?.textContent).toBe('Off');
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(document.querySelector('.context-menu')).toBeNull();
        await act(async () => { selector.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
        expect(document.activeElement).toBe(document.querySelector('.context-menu'));
    });

    it('Cancel is still only Cancel', async () => {
        await mountChat();
        await pressOff();
        await frame(MOVIE_NIGHT, GAME_NIGHT);
        await act(async () => { [...question()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click(); });
        await settle();
        expect(h.sent).toEqual([]);
        expect(said(NOTHING_SWITCHED)).toBe(false);
        // Opened by a click no pointer counted, so as a key's: the menu's item was the last to have
        // the focus and it went with the menu, so the selector took it first, for a keyboard to go on.
        expect(document.activeElement, 'the focus is back on the selector').toBe(document.querySelector('[data-testid="mode-selector"]'));
    });

    it("a pointer's menu: Cancel leaves the focus on nothing, where a stray Space or Enter opens nothing", async () => {
        await mountChat();
        const selector = document.querySelector<HTMLElement>('[data-testid="mode-selector"]')!;
        selector.focus();
        await act(async () => { selector.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
        await pressOffInMenu();
        expect(question(), 'Off asks').not.toBeNull();
        await act(async () => { [...question()!.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click(); });
        await settle();
        expect(h.sent).toEqual([]);
        expect(document.activeElement, 'the focus is on nothing').toBe(document.body);
    });

    it('on the web a native confirm stops the page, so this path finds nothing and OK switches', async () => {
        h.tauri = false;
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        await mountChat();
        await pressOff();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(h.sent).toEqual([{ method: 'PUT', path: '/servers/s1/modes/active', body: { mode_id: null } }]);
        expect(said(NOTHING_SWITCHED)).toBe(false);
    });

    describe('with no question at all: a menu left open, and the rooms it knows of empty', () => {
        /** Game Night's rooms empty, so that turning it off asks nothing; Movie Night's are not. */
        async function mountWithPeopleInMovieNight() {
            await mountChat();
            globalVoiceUsers.clear();
            for (const id of [7, 8, 9]) upsertVoiceUser('voice_22', { id, username: `u${id}` });
        }

        for (const [platform, tauri] of [['the desktop', true], ['the web and Android', false]] as const) {
            it(`on ${platform}, another mode came on behind the menu: Off ends nothing, and says so`, async () => {
                h.tauri = tauri;
                const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
                await mountWithPeopleInMovieNight();
                await openMenu();
                await frame(MOVIE_NIGHT, GAME_NIGHT);
                expect(document.querySelector('.context-menu'), 'the frame leaves the menu open').not.toBeNull();
                expect(document.querySelector('[data-testid="mode-selector"]')?.textContent, 'the selector has moved on').toContain('Movie Night');
                await pressOffInMenu();
                expect(question(), 'it knows of no one to warn about').toBeNull();
                expect(confirm).not.toHaveBeenCalled();
                expect(h.sent, 'turning "off" now would end Movie Night, which nobody warned about').toEqual([]);
                expect(said(NOTHING_SWITCHED)).toBe(true);
            });

            it(`CONTROL: on ${platform}, nothing moved behind it: Off asks nothing and switches`, async () => {
                h.tauri = tauri;
                await mountWithPeopleInMovieNight();
                await openMenu();
                await settle();
                await pressOffInMenu();
                expect(question()).toBeNull();
                expect(h.sent).toEqual([{ method: 'PUT', path: '/servers/s1/modes/active', body: { mode_id: null } }]);
                expect(said(NOTHING_SWITCHED)).toBe(false);
            });
        }

        it('a menu built after the frame knows the mode has moved, and warns about the mode that is on', async () => {
            await mountWithPeopleInMovieNight();
            await frame(MOVIE_NIGHT, GAME_NIGHT);
            await pressOff();
            expect(question()?.textContent).toContain('3 people are in the voice channels of Movie Night');
            await answerOk();
            expect(h.sent).toEqual([{ method: 'PUT', path: '/servers/s1/modes/active', body: { mode_id: null } }]);
            expect(said(NOTHING_SWITCHED)).toBe(false);
        });
    });
});

describe('a delete answered after the mode moved', () => {
    let qc: QueryClient;

    async function mountModes() {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        qc.setQueryData(keys.servers, [serverRow()]);
        await act(async () => {
            root!.render(<QueryClientProvider client={qc}><ModesSettings serverId="s1" /></QueryClientProvider>);
        });
        await settle();
    }
    const pressDelete = async (name: string) => {
        const card = [...document.querySelectorAll<HTMLElement>('[data-testid="mode-card"]')]
            .find(c => c.querySelector<HTMLInputElement>('input[type="text"]')?.value === name);
        expect(card, `${name}'s card`).toBeTruthy();
        const button = [...card!.querySelectorAll('button')].find(b => /Delete mode/.test(b.textContent ?? ''));
        await act(async () => { button!.click(); });
        await settle();
    };
    const frame = async (active: number | null) => {
        await act(async () => { adoptModeFrame(qc, keys.servers, { server_id: 's1', active_mode_id: active }); });
        await settle();
    };

    it('off when asked, on by the answer: its calls would end after "its channels are kept"', async () => {
        await mountModes();
        await pressDelete('Movie Night');
        expect(question()?.textContent).not.toContain('disconnected');
        await frame(MOVIE_NIGHT);
        await answerOk();
        expect(h.sent).toEqual([]);
        expect(said(NOTHING_DELETED)).toBe(true);
    });

    it('on when asked, off by the answer: it is no longer what the warning said', async () => {
        await mountModes();
        await pressDelete('Game Night');
        expect(question()?.textContent).toContain('disconnected');
        await frame(null);
        await answerOk();
        expect(h.sent).toEqual([]);
        expect(said(NOTHING_DELETED)).toBe(true);
    });

    it('CONTROL: nothing moved, and OK deletes', async () => {
        await mountModes();
        await pressDelete('Movie Night');
        await answerOk();
        expect(h.sent).toEqual([{ method: 'DELETE', path: `/servers/s1/modes/${MOVIE_NIGHT}`, body: undefined }]);
        expect(said(NOTHING_DELETED)).toBe(false);
    });

    it('another mode moved, this one still off: what was said is still true, and OK deletes', async () => {
        await mountModes();
        await pressDelete('Movie Night');
        await frame(null);
        await answerOk();
        expect(h.sent).toEqual([{ method: 'DELETE', path: `/servers/s1/modes/${MOVIE_NIGHT}`, body: undefined }]);
        expect(said(NOTHING_DELETED)).toBe(false);
    });
});
