/**
 * Where someone lands when they chose no channel: entering a server, or the open channel
 * deleted. The sidebar leaves out a channel under a collection denied to this member
 * (sidebarChannels.ts hiddenWithCollection), though the server lists it, so landing in one
 * puts in front of them what the list keeps away, with no row to come back to. A server
 * holding nothing else still opens, and a #mention or a notification is a choice, which still
 * opens such a channel. Through the real Chat, with chatServerNotices.test.tsx's stand-ins.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 1;

const h = vi.hoisted(() => ({
    channels: [] as Record<string, unknown>[],
    rows: [] as Record<string, unknown>[],
    /** The target a notification tap leaves for Chat. */
    nav: null as string | null,
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async (_ch: number, _limit: number, before?: string) => (before ? [] : h.rows),
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
    currentUserIdFromToken: () => ME,
}));
vi.mock('../api/mobileApp', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/mobileApp')>()),
    consumePendingNav: () => { const target = h.nav; h.nav = null; return target; },
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
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

const row = (id: number, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, mode_ids: [], parent_mode_ids: [], ...extra });
/** Under collection 99, which is not in this member's list: they are denied it. */
const STAFF_PLANS = row(20, 'staff-plans', { parent_id: 99 });
const GENERAL = row(10, 'general');

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'DELETE') {
        const channel = /\/channels\/(\d+)$/.exec(u);
        if (channel) h.channels = h.channels.filter(c => c.id !== Number(channel[1]));
        return reply(200, {});
    }
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, h.channels);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    h.rows = [];
    h.nav = null;
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const headerText = () => document.querySelector('.chat-header')?.textContent ?? '';
const textRows = () => [...document.querySelectorAll('li.channel:not(.voice-channel)')].map(l => l.textContent);
const rowNamed = (name: string) => [...document.querySelectorAll<HTMLElement>('li.channel')].find(li => li.textContent?.includes(name));

async function enter(expected: RegExp) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 60 && !expected.test(headerText()); i++) await settle();
}

describe('where entering a server lands', () => {
    it('not in a channel the sidebar does not list, though it comes first', async () => {
        h.channels = [STAFF_PLANS, GENERAL];
        await enter(/staff-plans|general/);
        expect(headerText()).toContain('general');
        expect(headerText()).not.toContain('staff-plans');
        expect(textRows().join(), 'CONTROL: the sidebar has no row for it').not.toContain('staff-plans');
    });

    it('CONTROL: a channel under a collection the member CAN see is listed, and lands as ever', async () => {
        h.channels = [row(99, 'Open', { channel_type: 2 }), row(21, 'notes', { parent_id: 99 }), GENERAL];
        await enter(/notes|general/);
        expect(headerText()).toContain('notes');
    });

    it('a server with nothing else still opens', async () => {
        h.channels = [STAFF_PLANS];
        await enter(/staff-plans/);
        expect(headerText()).toContain('staff-plans');
    });

    it('a voice room is listed, so it comes before such a channel', async () => {
        h.channels = [STAFF_PLANS, row(15, 'Lounge', { channel_type: 1 })];
        await enter(/staff-plans|Lounge/);
        expect(headerText()).toContain('Lounge');
    });

    it('a collection is listed too, and opens as its row does', async () => {
        h.channels = [STAFF_PLANS, row(30, 'Open', { channel_type: 2 })];
        await enter(/staff-plans|Open/);
        expect(headerText()).toContain('Open');
    });
});

describe('a choice still opens such a channel', () => {
    it('a #mention', async () => {
        h.channels = [STAFF_PLANS, GENERAL];
        h.rows = [{ id: 'm1', channel_id: 10, user_id: ME + 1, username: 'bob', content: 'see #staff-plans', created_at: '2026-10-01T00:00:00Z' }];
        await enter(/general/);
        let mention: HTMLElement | null = null;
        for (let i = 0; i < 40 && !(mention = document.querySelector<HTMLElement>('.mention.channel')); i++) await settle();
        expect(mention, 'the mention is in the message').not.toBeNull();
        h.rows = [];
        await act(async () => { mention!.click(); });
        for (let i = 0; i < 40 && !headerText().includes('staff-plans'); i++) await settle();
        expect(headerText()).toContain('staff-plans');
    });

    it('a notification', async () => {
        h.channels = [STAFF_PLANS, GENERAL];
        await enter(/general/);
        h.nav = 'channel:s1:20';
        await act(async () => { window.dispatchEvent(new CustomEvent('sovereign-navigate')); });
        for (let i = 0; i < 40 && !headerText().includes('staff-plans'); i++) await settle();
        expect(headerText()).toContain('staff-plans');
    });
});

describe('deleting the open channel moves on the same way', () => {
    async function deleteOpen(name: string) {
        await act(async () => {
            rowNamed(name)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        });
        const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(el => /delete/i.test(el.textContent ?? ''));
        expect(item, 'the row\'s menu has Delete').toBeTruthy();
        await act(async () => { item!.click(); });
        for (let i = 0; i < 20; i++) await settle();
    }

    it('to a channel the sidebar lists, not one it does not', async () => {
        // The order in the server's list: the hidden one comes before the one to land on.
        h.channels = [GENERAL, STAFF_PLANS, row(12, 'after')];
        await enter(/general/);
        await deleteOpen('general');
        expect(headerText()).toContain('after');
    });

    it('with nothing else listed, to such a channel, as entering does', async () => {
        h.channels = [GENERAL, STAFF_PLANS];
        await enter(/general/);
        await deleteOpen('general');
        expect(headerText()).toContain('staff-plans');
    });
});
