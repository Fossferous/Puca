/**
 * The folded Voice Channels section keeps the room whose page is open
 * (Chat.tsx, sidebarChannels.ts keptVoiceWhenCollapsed). A server with no text
 * channel opens on its first room's page, and folding the section took that
 * room's row away with nobody in it and nobody joined: the page stayed open
 * with nothing in the list saying which room it was (0.9.859 review, sidebar
 * lows). keptVoiceWhenCollapsed took an `openId` all along; Chat did not pass it.
 *
 * The real Chat, as chatPinsBack.test.tsx mounts it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { memoryLocalStorage } from './fixtures/fakeSink';

const ME = 1;

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => false,
    isTauri: () => false,
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
// Two voice rooms and no text channel: the server opens on Lounge's page.
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [
        { id: 30, name: 'Lounge', channel_type: 1, server_id: 's1', my_permissions: 0x7fffffff, position: 0 },
        { id: 31, name: 'Studio', channel_type: 1, server_id: 's1', my_permissions: 0x7fffffff, position: 1 },
    ]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;
// The fold is stored (sidebarCollapseStore.ts); the suite's own localStorage stores nothing.
beforeEach(() => { vi.stubGlobal('localStorage', memoryLocalStorage()); });
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const voiceRows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="voice-channel"]')]
    .map(r => r.dataset.channelId);

describe('a folded Voice Channels section', () => {
    it("keeps the room whose page is open, and folds the other empty one away", async () => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await act(async () => {
            root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
        });
        for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('Lounge'); i++) await settle();
        expect(document.querySelector('.chat-header')?.textContent, "the server opened on Lounge's page").toContain('Lounge');
        expect(voiceRows(), 'positive control: both rooms listed while unfolded').toEqual(['30', '31']);
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="toggle-voice-channels"]')!.click(); });
        await settle();
        expect(document.querySelector('[data-testid="toggle-voice-channels"]')?.getAttribute('aria-expanded'), 'folded').toBe('false');
        expect(voiceRows(), 'the open room stays; the other empty one is folded away').toEqual(['30']);
    });
});
