/**
 * Chat hands its root (`.chat-container`) to bars mounted outside it that
 * must be stacked among its layers (components/chatRoot.ts): on a phone that
 * element is a stacking context holding every dialog Chat opens, and the way
 * back to a minimised remote-control session, drawn beside it at z 250, was
 * over all of them (the review of 2026-11-22; DeviceStageReturn.tsx draws it
 * inside the root now, deviceStageReturn.test.tsx pins that half). This pins
 * Chat's half: the root is handed over while Chat is mounted, taken back when
 * it goes, and anyone listening hears both. The rig is chatDropZone.test.tsx's.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { currentChatRoot, useChatRoot } from '../components/chatRoot';

const ME = 1;

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

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [{ id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff }]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

/** What a bar outside Chat sees: the root as useChatRoot reports it, render by render. */
const seen: Array<HTMLElement | null> = [];
function Listener() {
    seen.push(useChatRoot());
    return null;
}

describe("Chat hands its root to the bars drawn among its layers", () => {
    it('the root is .chat-container while Chat is mounted, a listener outside Chat hears it, and both are taken back when Chat goes', async () => {
        seen.length = 0;
        expect(currentChatRoot(), 'no Chat yet: no root').toBeNull();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const tree = (withChat: boolean) => (
            <QueryClientProvider client={qc}><MemoryRouter>
                <Listener />
                {withChat && <Chat onLogout={() => {}} />}
            </MemoryRouter></QueryClientProvider>
        );
        await act(async () => { root!.render(tree(true)); });
        for (let i = 0; i < 40 && !document.querySelector('.chat-container'); i++) await settle();
        const container = document.querySelector<HTMLElement>('.chat-container');
        expect(container, 'Chat drew its root').toBeTruthy();
        expect(currentChatRoot(), "Chat's root is handed over").toBe(container);
        expect(seen[seen.length - 1], 'and a listener outside Chat re-rendered with it').toBe(container);
        await act(async () => { root!.render(tree(false)); });
        await settle();
        expect(document.querySelector('.chat-container'), 'Chat gone').toBeNull();
        expect(currentChatRoot(), 'the root is taken back').toBeNull();
        expect(seen[seen.length - 1], 'and the listener heard that too').toBeNull();
    });
});
