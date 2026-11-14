/**
 * A channel's pinned messages whose answer comes late (Chat.tsx togglePins).
 * The pin button asks the server and decrypts every pin before the panel opens,
 * and the person can move on meanwhile: another channel, the Friends dashboard,
 * Devices. The answer used to open the panel wherever they had gone: over the
 * dashboard or Devices, and on a phone with a Back layer held for a panel
 * nobody could see (the cover-close only closed pins ALREADY open). A pins
 * panel left open across a channel switch also listed the old channel's pins
 * under the new one, and its Unpin asked the new channel to unpin a message of
 * the old one's.
 *
 * The real Chat, as chatPinsBack.test.tsx mounts it, with listPinnedMessages
 * answering only when the test says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PinnedMessage } from '../api/servers';

const ME = 1;

type Pending = { channelId: number; resolve: (pins: PinnedMessage[]) => void; reject: (e: unknown) => void };

const h = vi.hoisted(() => ({
    /** Held Back layers, oldest first (api/mobileApp.ts interceptBack). */
    layers: [] as Array<() => void>,
    /** Each listPinnedMessages call, waiting for the test to answer it. */
    pending: [] as Pending[],
    unpinned: [] as Array<{ channelId: number; messageId: string }>,
    told: [] as string[],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => false,
    isTauri: () => false,
}));
vi.mock('../api/mobileApp', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/mobileApp')>()),
    interceptBack: (onBack: () => void) => {
        h.layers.push(onBack);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const i = h.layers.indexOf(onBack);
            if (i >= 0) h.layers.splice(i, 1);
        };
    },
}));
vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    decryptChannelContent: async (_ch: number, content: string) => content,
    listPinnedMessages: (channelId: number) => new Promise<PinnedMessage[]>((resolve, reject) => {
        h.pending.push({ channelId, resolve, reject });
    }),
    unpinMessage: async (channelId: number, messageId: string) => { h.unpinned.push({ channelId, messageId }); },
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    getToken: () => `h.${btoa(JSON.stringify({ sub: ME, username: 'me' })).replace(/=+$/, '')}.s`,
}));
vi.mock('../api/appDialogs', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/appDialogs')>()),
    tellUser: (msg: string) => { h.told.push(msg); },
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));
vi.mock('../components/DevicesView', () => ({
    DevicesView: () => <div data-testid="devices-view" />,
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
        matches: false,
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [
        { id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, position: 0 },
        { id: 11, name: 'random', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, position: 1 },
    ]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    h.layers = [];
    h.pending = [];
    h.unpinned = [];
    h.told = [];
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('general'); i++) await settle();
    expect(document.querySelector('.chat-header')?.textContent, 'the channel opened').toContain('general');
    await settle();
}

const click = async (el: Element | null, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const pins = () => document.querySelector('.pins-panel');
const pinButton = () => document.querySelector('.pins-toggle-btn');
const pin = (channelId: number, id: string, words: string): PinnedMessage => ({
    id, channel_id: channelId, user_id: 2, username: 'bob', content: words,
    created_at: '2026-11-01T00:00:00Z', pinned_at: '2026-11-01T00:00:00Z',
});

async function answer(i: number, list: PinnedMessage[]) {
    expect(h.pending[i], `request ${i} was made`).toBeTruthy();
    await act(async () => { h.pending[i].resolve(list); });
    await settle();
}

async function openChannel(name: string) {
    const row = [...document.querySelectorAll<HTMLElement>('.channel-item, .channel-name, [data-channel-id]')]
        .find(el => el.textContent?.includes(name));
    await click(row ?? null, `the #${name} row`);
    expect(document.querySelector('.chat-header')?.textContent, `#${name} is open`).toContain(name);
}

describe("a channel's pinned messages that arrive after the person moved on", () => {
    it('positive control: an answer for the channel still open opens the panel with its pins and a Back layer', async () => {
        await mountChat();
        const before = h.layers.length;
        await click(pinButton(), 'the pin button');
        expect(h.pending).toHaveLength(1);
        expect(h.pending[0].channelId).toBe(10);
        expect(pins(), 'nothing yet: the answer has not come').toBeNull();
        await answer(0, [pin(10, 'm1', 'hello from general')]);
        expect(pins()?.textContent).toContain('hello from general');
        expect(h.layers.length, 'the panel holds Back').toBe(before + 1);
    });

    it.each([
        { opener: "the rail's home button (the Friends dashboard)", sel: '.server-icon.home-button', view: '.friends-dashboard' },
        { opener: "the rail's Devices", sel: '.server-icon.devices-button', view: '[data-testid="devices-view"]' },
    ])('an answer that lands after $opener opened stays closed and holds no Back', async ({ sel, view }) => {
        await mountChat();
        const before = h.layers.length;
        await click(pinButton(), 'the pin button');
        await click(document.querySelector(sel), sel);
        expect(document.querySelector(view), 'the view is up').toBeTruthy();
        const withView = h.layers.length;
        await answer(0, [pin(10, 'm1', 'hello from general')]);
        expect(pins(), 'not drawn over the view').toBeNull();
        expect(h.layers.length, 'no Back layer for a panel nobody can see').toBe(withView);
        expect(withView).toBeGreaterThanOrEqual(before);
    });

    it('an answer that lands after the dashboard opened and closed again does not open the panel', async () => {
        await mountChat();
        await click(pinButton(), 'the pin button');
        await click(document.querySelector('.server-icon.home-button'), "the rail's home button");
        await click(document.querySelector('.friends-dashboard .close-btn[aria-label="Close"]'), "the dashboard's X");
        expect(document.querySelector('.chat-header')?.textContent, 'back in the channel').toContain('general');
        await answer(0, [pin(10, 'm1', 'hello from general')]);
        expect(pins()).toBeNull();
    });

    it("an answer for the channel left behind does not open over the next channel, nor say it failed there", async () => {
        await mountChat();
        await click(pinButton(), 'the pin button');
        await openChannel('random');
        await answer(0, [pin(10, 'm1', 'hello from general')]);
        expect(pins(), "general's pins are not shown under #random").toBeNull();
        // A failure that comes late is not this channel's either.
        await click(pinButton(), 'the pin button in #random');
        await openChannel('general');
        await act(async () => { h.pending[1].reject(new Error('network')); });
        await settle();
        expect(h.told, 'no failure notice for a request nobody waits on').toEqual([]);
    });

    it('pins open in one channel close when another channel opens, and Unpin never reaches the wrong channel', async () => {
        await mountChat();
        await click(pinButton(), 'the pin button');
        await answer(0, [pin(10, 'm1', 'hello from general')]);
        expect(pins()?.textContent).toContain('hello from general');
        await openChannel('random');
        expect(pins(), "general's panel closed with general").toBeNull();
        // #random's own pins load for #random.
        await click(pinButton(), 'the pin button in #random');
        expect(h.pending[1].channelId).toBe(11);
        await answer(1, [pin(11, 'm2', 'hello from random')]);
        expect(pins()?.textContent).toContain('hello from random');
        expect(pins()?.textContent).not.toContain('hello from general');
        await click(document.querySelector('.pin-unpin-btn'), 'Unpin');
        expect(h.unpinned).toEqual([{ channelId: 11, messageId: 'm2' }]);
    });

    it('a second press while the first is loading wins: the first answer is dropped', async () => {
        await mountChat();
        await click(pinButton(), 'the pin button');
        // The panel is not open yet, so a second press asks again.
        await click(pinButton(), 'the pin button again');
        expect(h.pending).toHaveLength(2);
        await answer(1, [pin(10, 'm2', 'the newer answer')]);
        expect(pins()?.textContent).toContain('the newer answer');
        await answer(0, [pin(10, 'm1', 'the older answer')]);
        expect(pins()?.textContent, 'the older answer did not overwrite it').toContain('the newer answer');
        expect(pins()?.textContent).not.toContain('the older answer');
    });

    it('closing the panel while a reload is on its way keeps it closed', async () => {
        await mountChat();
        await click(pinButton(), 'the pin button');
        await answer(0, []);
        expect(pins(), 'open').toBeTruthy();
        await click(pinButton(), 'the pin button (closes)');
        expect(pins()).toBeNull();
        await click(pinButton(), 'the pin button (opens, loading)');
        await click(document.querySelector('.server-icon.home-button'), "the rail's home button");
        await answer(1, []);
        expect(pins()).toBeNull();
    });
});
