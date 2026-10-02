/**
 * The chat's file drop zone (`.messages-container`, Chat.tsx) may only take a
 * file where the composer could SEND it.
 *
 * A dropped file is encrypted and uploaded at once (enqueueUpload ->
 * settleUpload). Where the composer is hidden (a checklist channel, a
 * collection, the All-checklists board) or sending is denied (no
 * SEND_MESSAGES), that upload landed against the user's quota with a chip
 * that was invisible or could not be sent. Reachable on the web all along,
 * and newly in the desktop app now that Tauri's native drop handler is off.
 * Refusing the drag there also lets the app-wide guard (fileDropGuard.ts)
 * refuse the drop, so it cannot navigate the page either.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PERM } from '../api/permissionBits';

const ME = 1;

const h = vi.hoisted(() => ({
    channel: {} as Record<string, unknown>,
    uploads: [] as string[],
}));

vi.mock('../api/attachments', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/attachments')>()),
    // Never resolves: the test only cares whether an upload STARTED.
    encryptAndUploadRef: (file: File) => { h.uploads.push(file.name); return new Promise(() => {}); },
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
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }]);
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [h.channel]);
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
    h.uploads = [];
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function mountChat(channel: Record<string, unknown>) {
    h.channel = { id: 10, name: 'general', channel_type: 0, server_id: 's1', ...channel };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    // The channel is open once its name is in the header.
    for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('general'); i++) await settle();
    expect(document.querySelector('.chat-header')?.textContent, 'the channel opened').toContain('general');
    await settle();
}

/** Drag a file over the message list and drop it, as Chromium would. */
async function dropFile(): Promise<{ overClaimed: boolean; dropClaimed: boolean }> {
    const zone = document.querySelector('.messages-container');
    expect(zone, 'message list rendered').toBeTruthy();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const dt = { types: ['Files'], files: [file], dropEffect: 'copy' };
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(over, 'dataTransfer', { value: dt });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: dt });
    await act(async () => { zone!.dispatchEvent(over); });
    await act(async () => { zone!.dispatchEvent(drop); });
    await settle();
    return { overClaimed: over.defaultPrevented, dropClaimed: drop.defaultPrevented };
}

const ALL = 0x7fffffff;

describe('the chat drop zone', () => {
    it('positive control: a channel you can send in takes the file and uploads it', async () => {
        await mountChat({ my_permissions: ALL });
        expect(document.querySelector('.message-textarea'), 'composer shown').toBeTruthy();
        expect(await dropFile()).toEqual({ overClaimed: true, dropClaimed: true });
        expect(h.uploads).toEqual(['notes.txt']);
    });

    it('a channel without SEND_MESSAGES refuses the drop and uploads nothing', async () => {
        await mountChat({ my_permissions: ALL & ~PERM.SEND_MESSAGES & ~PERM.ADMINISTRATOR });
        expect(document.querySelector('.message-form.composer-disabled'), 'composer disabled').toBeTruthy();
        expect(await dropFile()).toEqual({ overClaimed: false, dropClaimed: false });
        expect(h.uploads).toEqual([]);
    });

    it('a checklist channel (no composer) refuses the drop and uploads nothing', async () => {
        await mountChat({ my_permissions: ALL, has_checklist: true });
        expect(document.querySelector('.message-textarea'), 'no composer on a checklist').toBeNull();
        expect(await dropFile()).toEqual({ overClaimed: false, dropClaimed: false });
        expect(h.uploads).toEqual([]);
    });
});
