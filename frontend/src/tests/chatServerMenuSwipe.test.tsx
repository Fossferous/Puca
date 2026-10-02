/**
 * On a phone, a swipe while the server icon's context menu is open must not
 * change panels under it.
 *
 * The menu is portaled to <body> (inside the transformed, 72px-wide rail it
 * was cut down to the rail's width). Before that, a swipe slid it away WITH
 * the rail; as a body-level fixed element it would instead stay floating over
 * whatever panel the swipe brought in. So the panel swipe treats it like the
 * user context menu: while it is open, a swipe does nothing; the menu closes
 * first (tap outside, or pick an item).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 7;

const h = vi.hoisted(() => ({
    servers: [] as unknown[],
    channels: [] as unknown[],
    members: [] as unknown[],
    voiceUsers: [] as unknown[],
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    decryptChannelContent: async (_channel: number, content: string) => content,
    decryptChannelMessages: async () => [],
}));
vi.mock('../utils/audioFeedback', async importOriginal => ({
    ...(await importOriginal<typeof import('../utils/audioFeedback')>()),
    playMessageSound: () => {},
    playMentionSound: () => {},
}));

// A phone: mobile.css's gate, `(pointer: coarse) and (max-width: 1024px)`.
Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: /pointer: coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const body = /\/servers$/.test(u) ? h.servers
        : /\/servers\/[^/]+\/channels$/.test(u) ? h.channels
        : /\/servers\/[^/]+\/members-with-roles$/.test(u) ? h.members
        : /\/servers\/[^/]+\/voice-users$/.test(u) ? { voice_users: h.voiceUsers }
        : /\/servers\/[^/]+\/unread$/.test(u) ? { channels: [] }
        : /\/dms$/.test(u) ? []
        : /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() } as unknown as Response;
}));

const { Chat } = await import('../components/Chat');

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = `${b64url({ alg: 'HS256' })}.${b64url({ sub: ME, username: 'me', exp: 4102444800 })}.sig`;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 25)); });
}

/** A quick, clearly horizontal one-finger swipe to the left over the chat. */
async function swipeLeft() {
    const el = host!.querySelector('.chat-container')!;
    const touch = (x: number) => ({ clientX: x, clientY: 400, identifier: 1, target: el });
    const fire = (type: string, list: 'touches' | 'changedTouches', x: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: list === 'touches' ? [touch(x)] : [] });
        Object.defineProperty(ev, 'changedTouches', { value: [touch(x)] });
        el.dispatchEvent(ev);
    };
    // Both in ONE act: useSwipe drops a drag slower than 700 ms as a scroll,
    // and two separate act()s can take that long on a loaded machine.
    await act(async () => {
        fire('touchstart', 'touches', 300);
        fire('touchend', 'changedTouches', 100);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const panel = () => host!.querySelector<HTMLElement>('.chat-container')!.dataset.mobilePanel;

const store = new Map<string, string>();
beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, v); });
    vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    store.clear();
    store.set('auth_token', token);
    h.servers = [{ id: 's1', name: 'Alpha', owner_id: ME, icon_file_id: null }];
    h.channels = [{ id: 1, server_id: 's1', name: 'general', channel_type: 0, position: 0 }];
    h.members = [];
    h.voiceUsers = [];
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
    store.clear();
});

describe('phone: the server icon menu and the panel swipe', () => {
    it('positive control: with no menu open, a swipe changes the panel', async () => {
        await mountChat();
        const before = panel();
        expect(before).toBeTruthy();
        await swipeLeft();
        expect(panel()).not.toBe(before);
    });

    it('with the server menu open, a swipe leaves the panel (and the menu) where they are', async () => {
        await mountChat();
        const icon = host!.querySelector('.server-icon[title="Alpha"]');
        expect(icon).not.toBeNull();
        await act(async () => {
            icon!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 120 }));
        });
        expect(document.querySelector('.server-context-menu')).not.toBeNull();
        const before = panel();
        await swipeLeft();
        expect(panel()).toBe(before);
        expect(document.querySelector('.server-context-menu')).not.toBeNull();
    });
});
