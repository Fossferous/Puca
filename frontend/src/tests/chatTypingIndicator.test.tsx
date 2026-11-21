/**
 * "X is typing…" in the real Chat (components/typingIndicator.ts).
 *
 * The owner's report (2026-11-21): "when on mobile if i switch app and then
 * look at a chat it will usually say someone is still typing when they arent".
 * Reproduced on the real Android app: they type and send while the app is in the
 * background, the phone comes back on that message, and "<them> is typing..."
 * stays under their message for seconds more. A typing ping held its typer up for
 * five seconds whatever came next; their own message ended nothing. And the list
 * kept the previous channel's typers through a switch, named in the next channel.
 *
 * The real Chat as chatPinsBack.test.tsx mounts it; frames go through the real
 * client's dispatch (wsClient.handleMessage), the path a socket frame takes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 1;

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async () => [],
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    decryptChannelContent: async (_ch: number, content: string) => content,
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
        { id: 11, name: 'second', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, position: 1 },
    ]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { wsClient } = await import('../api/websocket');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    vi.useRealTimers();
});
beforeEach(() => {
    vi.useRealTimers();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const header = () => document.querySelector('.chat-header')?.textContent ?? '';

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 40 && !header().includes('general'); i++) await settle();
    expect(header(), 'the channel opened').toContain('general');
    await settle();
}

/** A frame as the socket hands it to the client. */
const frame = async (type: string, payload: unknown) => {
    await act(async () => {
        (wsClient as unknown as { handleMessage(m: unknown): void }).handleMessage({ type, payload });
    });
    await settle();
};
const typing = (room: string, id: number, username: string) =>
    frame('UserTyping', { room_id: room, user: { id, username } });
const message = (room: string, id: number, username: string, text: string, n: number) =>
    frame('ChatMessage', {
        room_id: room,
        sender: { id, username },
        content: text,
        timestamp: 1_795_000_000 + n,
        message_id: `m-${n}`,
    });
const indicator = () => document.querySelector('.typing-indicator')?.textContent ?? null;

async function openChannel(name: string) {
    const row = [...document.querySelectorAll('.channel-list .channel')].find(c => c.textContent?.includes(name));
    expect(row, `the #${name} row`).toBeTruthy();
    await act(async () => { (row as HTMLElement).click(); });
    for (let i = 0; i < 40 && !header().includes(name); i++) await settle();
    expect(header()).toContain(name);
    await settle();
}

describe('"is typing" names only people typing now', () => {
    it('their message ends it at once (it stayed up to five seconds under the message)', async () => {
        await mountChat();
        await typing('channel_10', 2, 'bob');
        expect(indicator(), 'POSITIVE CONTROL: a ping shows its typer').toContain('bob is typing');
        await message('channel_10', 2, 'bob', 'hi there', 1);
        expect(document.querySelector('.messages-container')?.textContent, 'the message is on screen').toContain('hi there');
        expect(indicator(), 'they sent it: nobody is typing').toBeNull();
    });

    it('a message from someone else leaves the typer up (CONTROL), and ends only its own sender', async () => {
        await mountChat();
        await typing('channel_10', 2, 'bob');
        await typing('channel_10', 3, 'cat');
        expect(indicator()).toContain('bob, cat are typing');
        await message('channel_10', 4, 'dan', 'unrelated', 2);
        expect(indicator(), 'dan was not typing: nothing changes').toContain('bob, cat are typing');
        await message('channel_10', 3, 'cat', 'done', 3);
        expect(indicator()).toContain('bob is typing');
    });

    it('a ping after their message (the next one) shows them again', async () => {
        await mountChat();
        await typing('channel_10', 2, 'bob');
        await message('channel_10', 2, 'bob', 'first', 4);
        expect(indicator()).toBeNull();
        await typing('channel_10', 2, 'bob');
        expect(indicator()).toContain('bob is typing');
    });

    it('someone typing in the channel just left is not named in the next one', async () => {
        await mountChat();
        await typing('channel_10', 2, 'bob');
        expect(indicator()).toContain('bob is typing');
        await openChannel('second');
        expect(indicator(), 'in #second nobody is typing').toBeNull();
        await typing('channel_11', 3, 'cat');
        expect(indicator(), "a ping in #second does show there").toContain('cat is typing');
        expect(indicator()).not.toContain('bob');
    });

    it('still goes by itself five seconds after the last ping', async () => {
        await mountChat();
        await typing('channel_10', 2, 'bob');
        expect(indicator()).toContain('bob is typing');
        // The 1 s prune, five seconds and a bit later.
        const t0 = Date.now();
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + 6_500);
        await settle(1_200);
        spy.mockRestore();
        expect(indicator()).toBeNull();
    });
});
