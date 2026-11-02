/**
 * What the chat view says when nobody just pressed anything. A native alert()
 * takes the focus and stops the page's JavaScript until it is answered, which is
 * no way to reach someone in a call or a game, so these two are toasts: a generic
 * `Error` frame off the socket (the server sends one in answer to ANY frame the
 * client sent, background ones included), and the send that gives up ten seconds
 * after the person pressed Enter. Through the real Chat, with the same stand-ins
 * as chatHeicComposer.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 1;

const h = vi.hoisted(() => ({
    send: null as null | (() => Promise<unknown>),
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
    sendChannelMessageEncrypted: () => h.send!(),
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
const { wsClient } = await import('../api/websocket');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let alertSpy: ReturnType<typeof vi.spyOn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;
let frameListeners: ((m: Frame) => void)[] = [];

beforeEach(() => {
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        if (type === 'Error') frameListeners.push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    h.send = null;
    frameListeners = [];
    vi.restoreAllMocks();
    document.querySelectorAll('.app-toast').forEach(t => t.remove());
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const toastText = () => document.querySelector('.app-toast-text')?.textContent ?? null;

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

/** Type into the real composer and press Enter. */
async function pressSend(text: string) {
    const box = document.querySelector<HTMLTextAreaElement>('textarea.message-textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

describe('the chat view, when nobody just pressed anything', () => {
    it('a generic Error frame is a toast with the server\'s words, and no modal', async () => {
        await mountChat();
        expect(frameListeners, 'Chat listens for the frame').toHaveLength(1);
        await act(async () => { frameListeners[0]({ type: 'Error', payload: { message: 'Not in this room' } }); });
        expect(toastText()).toBe('Not in this room');
        expect(alertSpy).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('an Error frame with no message still says something', async () => {
        await mountChat();
        await act(async () => { frameListeners[0]({ type: 'Error', payload: {} }); });
        expect(toastText()).toBe('The server rejected that action.');
    });

    it('the send that gives up, ten seconds after the press, is a toast and takes the bubble down', async () => {
        // The grace is the code's own 10 s: not worth waiting for, and only that
        // one delay is shortened.
        const realTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: []) => realTimeout(fn, ms === 10_000 ? 0 : ms, ...rest)) as typeof setTimeout);
        h.send = async () => { throw new TypeError('Failed to fetch'); };
        await mountChat();
        await pressSend('hello there');
        await settle(50);
        expect(toastText()).toBe('Message failed to send. Check your connection and try again.');
        expect(alertSpy).not.toHaveBeenCalled();
        expect(document.querySelector('.messages-container')?.textContent).not.toContain('hello there');
    });

    it('POSITIVE CONTROL: a refusal the moment the person pressed Send stays what it was, a dialog they answer', async () => {
        h.send = async () => { throw new Error('the server refused it'); };
        await mountChat();
        await pressSend('hello there');
        await settle(50);
        expect(alertSpy).toHaveBeenCalledTimes(1);
        expect(toastText()).toBeNull();
    });
});
