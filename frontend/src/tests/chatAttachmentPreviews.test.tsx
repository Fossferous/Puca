/**
 * Every place Chat RE-SHOWS a message's text, driven through the real Chat:
 * the reply snapshot on a message loaded from history, the "Replying to" bar,
 * the pinned list, search results, Quote and Edit.
 *
 * The owner's report: "when sending an image it shows [string of text]". The
 * composer has shown a thumbnail chip since the chip rework, but each of these
 * surfaces printed the decrypted markdown —
 * `![photo.png](sovereign-enc:<id>?k=<file key>&m=…&c=<fetch capability>)` —
 * and the pinned list and Edit printed the KEY. Reproduced in a live walk on 0.9.830.
 * Each must now show the file name,
 * and nothing that opens the file.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const KEY = 'y8PY2ErUIKyijmVzroOm6CWv9rqH0iHqDybKo1r3Gi8';
const CAP = 'CaPaBiLiTyToKeN42xyz';
const ID = '746bbec3-d7e1-4366-8854-429b2b874f00';
const IMG = `![photo.png](sovereign-enc:${ID}?k=${KEY}&m=image%2Fpng&c=${CAP})`;
const ME = 1;
const BOB = 2;

const h = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
    pins: [] as Array<Record<string, unknown>>,
    edits: [] as Array<{ channelId: number; messageId: string; content: string }>,
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async (_ch: number, _limit: number, before?: string) => (before ? [] : h.rows),
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    decryptChannelContent: async (_ch: number, content: string) => content,
    listPinnedMessages: async () => h.pins,
    editChannelMessageEncrypted: async (channelId: number, messageId: string, content: string) => {
        h.edits.push({ channelId, messageId, content });
    },
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
    if (/\/servers\/s1\/channels$/.test(u)) {
        return reply(200, [{ id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff }]);
    }
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

const row = (id: string, user_id: number, username: string, content: string, at: string, reply_to_id?: string) => ({
    id, channel_id: 10, user_id, username, content, created_at: at, ...(reply_to_id ? { reply_to_id } : {}), encState: 'secure',
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    h.rows = [
        row('m1', BOB, 'bob', `look ${IMG}`, '2026-10-01T10:00:00Z'),
        row('m2', ME, 'me', 'nice one', '2026-10-01T10:01:00Z', 'm1'),
        row('m3', ME, 'me', `my caption ${IMG}`, '2026-10-01T10:02:00Z'),
        // A ref BETWEEN words (typed around, or an old client's layout): the
        // edit box shows 'before after', so "unchanged" must not re-send it
        // rearranged as 'before after <ref>'.
        row('m4', ME, 'me', `before ${IMG} after`, '2026-10-01T10:03:00Z'),
    ];
    h.pins = [{ id: 'm1', channel_id: 10, user_id: BOB, username: 'bob', display_name: null, content: `look ${IMG}`, created_at: '2026-10-01T10:00:00Z' }];
    h.edits = [];
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    vi.restoreAllMocks();
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
    for (let i = 0; i < 20 && !document.getElementById('msg-m3'); i++) await settle();
    expect(document.getElementById('msg-m3'), 'the channel history rendered').not.toBeNull();
}

/** Nothing that opens or names the blob may be on screen. */
function expectNoRef(s: string | null | undefined, where: string) {
    expect(s ?? '', where).not.toMatch(/sovereign-enc/i);
    expect(s ?? '', where).not.toContain(KEY.slice(0, 10));
    expect(s ?? '', where).not.toContain(CAP);
    expect(s ?? '', where).not.toContain('](');
}

function toolbarButton(messageId: string, title: string): HTMLButtonElement {
    const btn = document.getElementById(`msg-${messageId}`)?.querySelector<HTMLButtonElement>(`.msg-action-btn[title="${title}"]`);
    expect(btn, `${title} button on ${messageId}`).toBeTruthy();
    return btn!;
}

describe('Chat preview surfaces never show a raw attachment ref', () => {
    it('the reply snapshot on a HISTORY message shows the file name', async () => {
        await mountChat();
        const ref = document.getElementById('msg-m2')?.querySelector('.message-reply-ref .reply-preview');
        expect(ref, 'reply snapshot rendered').toBeTruthy();
        expect(ref!.textContent).toContain('photo.png');
        expect(ref!.textContent).toContain('look');
        expectNoRef(ref!.textContent, 'history reply snapshot');
    });

    it('the "Replying to" bar shows the file name', async () => {
        await mountChat();
        await act(async () => { toolbarButton('m1', 'Reply').click(); });
        const bar = document.querySelector('.reply-preview-banner .reply-content-preview');
        expect(bar, 'reply banner rendered').toBeTruthy();
        expect(bar!.textContent).toContain('photo.png');
        expectNoRef(bar!.textContent, 'reply banner');
    });

    it('the pinned list shows the file name', async () => {
        await mountChat();
        const toggle = document.querySelector<HTMLButtonElement>('button[title="Pinned messages"]');
        expect(toggle).toBeTruthy();
        await act(async () => { toggle!.click(); });
        await settle();
        const item = document.querySelector('.pins-panel .pin-item-body');
        expect(item, 'pin rendered').toBeTruthy();
        expect(item!.textContent).toContain('photo.png');
        expectNoRef(item!.textContent, 'pinned list');
    });

    it('search results show the file name', async () => {
        await mountChat();
        const input = document.querySelector<HTMLInputElement>('.search-bar input');
        expect(input).toBeTruthy();
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, 'look');
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        for (let i = 0; i < 20 && !document.querySelector('.search-result-item'); i++) await settle();
        const hits = Array.from(document.querySelectorAll('.search-result-item'));
        expect(hits.length).toBeGreaterThan(0);
        for (const hit of hits) expectNoRef(hit.textContent, 'search result');
        expect(hits.map(x => x.textContent).join(' ')).toContain('photo.png');
    });

    it('Quote puts the file name in the composer, not a dead ref', async () => {
        await mountChat();
        await act(async () => { toolbarButton('m1', 'Quote').click(); });
        const box = document.querySelector<HTMLTextAreaElement>('.message-textarea');
        expect(box?.value).toContain('> look');
        expect(box?.value).toContain('photo.png');
        expectNoRef(box?.value, 'quoted composer text');
    });

    it('Edit shows only the text, and saving keeps the attachment (key included, in the envelope)', async () => {
        await mountChat();
        const prompt = vi.spyOn(window, 'prompt').mockReturnValue('edited caption');
        await act(async () => { toolbarButton('m3', 'Edit').click(); });
        await settle();
        expect(prompt).toHaveBeenCalledTimes(1);
        const shown = prompt.mock.calls[0][1];
        expect(shown).toBe('my caption');
        expectNoRef(shown, 'edit prompt');
        expect(h.edits).toEqual([{ channelId: 10, messageId: 'm3', content: `edited caption ${IMG}` }]);
    });

    it('an Edit that leaves the text alone sends nothing', async () => {
        await mountChat();
        const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('my caption').mockReturnValueOnce('before after');
        await act(async () => { toolbarButton('m3', 'Edit').click(); });
        await settle();
        await act(async () => { toolbarButton('m4', 'Edit').click(); });
        await settle();
        expect(prompt.mock.calls.map(c => c[1])).toEqual(['my caption', 'before after']);
        expect(h.edits).toEqual([]);
    });
});
