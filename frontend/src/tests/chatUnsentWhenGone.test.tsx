/**
 * What is in the composer when the open conversation goes away and nobody asked to
 * leave it: a channel deleted, View taken away, a collection deleted, the server gone.
 * The composer belongs to no conversation, so what it holds would land in whichever
 * one opens next, one Enter from being sealed under that channel's key and posted
 * where everyone can read it. It goes in a notice instead, and the composer is empty.
 *
 * A person's own click on another channel keeps the words: that is theirs to do, and
 * it is the control here. So is a mode hiding the open channel, which moves nobody.
 * Through the real Chat with real frames, with chatServerNotices.test.tsx's stand-ins.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { mountAppDialogs } from './appDialogsHost';

const ME = 1;

const h = vi.hoisted(() => ({
    sent: [] as unknown[][],
    discarded: [] as string[],
    /** What the server would list now. */
    channels: [] as Record<string, unknown>[],
    servers: [] as Record<string, unknown>[],
    deleted: [] as string[],
    /** What the open channel's history holds. */
    rows: [] as Record<string, unknown>[],
    /** A leave or a delete still on its way, until this settles. */
    hold: null as null | Promise<void>,
    nav: null as string | null,
}));

vi.mock('../api/servers', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    markChannelRead: async () => {},
    getMessages: async (_ch: number, _limit: number, before?: string) => (before ? [] : h.rows),
    decryptChannelMessages: async (_ch: number, raw: unknown[]) => raw,
    listPinnedMessages: async () => [],
    sendChannelMessageEncrypted: async (...args: unknown[]) => { h.sent.push(args); return { id: 'm1' }; },
}));
vi.mock('../api/attachments', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/attachments')>()),
    encryptAndUploadRef: async (file: File) => ({ name: file.name, href: `sovereign-enc:up-${file.name}?k=key&m=text/plain` }),
}));
vi.mock('../api/uploads', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/uploads')>()),
    discardUpload: (id: string) => { h.discarded.push(id); },
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
    ({ id, name, channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff, ...extra });
const GENERAL = row(10, 'general');
const STAFF = row(11, 'staff-only');
const OTHER = row(12, 'other');

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === 'POST' && /\/servers\/[^/]+\/channels$/.test(u)) {
        const asked = JSON.parse(String(init.body));
        const made = row(77, asked.name, { channel_type: asked.channel_type, parent_id: asked.parent_id ?? null });
        h.channels = [...h.channels, made];
        return reply(200, made);
    }
    if (init?.method === 'DELETE' || (init?.method === 'POST' && /leave$/.test(u))) {
        if (h.hold) await h.hold;
        h.deleted.push(u.slice(u.indexOf('/', 8)));
        const channel = /\/channels\/(\d+)$/.exec(u);
        if (channel) h.channels = h.channels.filter(c => c.id !== Number(channel[1]));
        const server = /\/servers\/([^/]+)(\/leave)?$/.exec(u);
        if (server) h.servers = h.servers.filter(s => s.id !== server[1]);
        return reply(200, {});
    }
    if (/\/config$/.test(u)) return reply(200, { app_url: 'https://app.example.com', registration_invite_required: false, srp_version: 2 });
    if (/\/servers$/.test(u)) return reply(200, h.servers);
    const list = /\/servers\/([^/]+)\/channels$/.exec(u);
    if (list) return reply(200, h.channels.filter(c => c.server_id === list[1]));
    if (/\/servers\/s1\/modes$/.test(u)) return reply(200, {
        active_mode_id: h.servers[0]?.active_mode_id ?? null, can_switch: true, can_edit: true, can_call_back: true,
        modes: [{ id: 3, name: 'Game Night', background_file_id: null, accent_color: null, home_channel_id: null, auto_off: false, channel_ids: [11] }],
    });
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { wsClient } = await import('../api/websocket');
const { keys } = await import('../hooks/queries');

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let queryClient: QueryClient;
let frames: Record<string, ((m: Frame) => void)[]> = {};
let dialogs: ReturnType<typeof mountAppDialogs>;
/** Each time a collection's page asks for its feed. With no list to read it asks on every render,
 *  and that render's answer causes the next: stopped here, so that fails a test and hangs nothing. */
let feedLoads = 0;

beforeEach(() => {
    dialogs = mountAppDialogs();
    frames = {};
    h.sent = [];
    h.discarded = [];
    h.deleted = [];
    h.rows = [];
    h.hold = null;
    h.nav = null;
    feedLoads = 0;
    vi.spyOn(console, 'debug').mockImplementation((said: unknown) => {
        if (String(said).startsWith('[Chat] Loading collection messages') && ++feedLoads > 300) throw new Error('the feed is going round');
    });
    h.channels = [GENERAL, STAFF, OTHER];
    h.servers = [{ id: 's1', name: 'Srv', owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z' }];
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const on = wsClient.on.bind(wsClient);
    vi.spyOn(wsClient, 'on').mockImplementation((type, handler) => {
        (frames[type] ??= []).push(handler as unknown as (m: Frame) => void);
        return on(type, handler);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    dialogs.unmount();
    vi.restoreAllMocks();
});

const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const settled = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await settle(); };
const composer = () => document.querySelector<HTMLTextAreaElement>('textarea.message-textarea');
const headerText = () => document.querySelector('.chat-header')?.textContent ?? '';
const rowNamed = (name: string) => [...document.querySelectorAll<HTMLElement>('li.channel')].find(li => li.textContent?.includes(name));

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={queryClient}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    for (let i = 0; i < 60 && !rowNamed('general'); i++) await settle();
    for (let i = 0; i < 60 && !headerText().includes('general'); i++) await settle();
    expect(headerText(), 'the landing channel opened').toContain('general');
}

async function open(name: string) {
    const target = rowNamed(name);
    expect(target, `${name} is in the sidebar`).toBeTruthy();
    await act(async () => { target!.click(); });
    for (let i = 0; i < 40 && !headerText().includes(name); i++) await settle();
    expect(headerText()).toContain(name);
}

async function type(words: string) {
    const box = composer()!;
    box.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle();
}

/** Drop a file on the message list, and wait for its chip to be ready to send. */
async function dropReadyFile() {
    const dt = { types: ['Files'], files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })], dropEffect: 'copy' };
    const zone = document.querySelector('.messages-container')!;
    for (const kind of ['dragover', 'drop']) {
        const event = new Event(kind, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        await act(async () => { zone.dispatchEvent(event); });
    }
    for (let i = 0; i < 40 && !document.querySelector('.composer-chip-ready'); i++) await settle();
    expect(document.querySelector('.composer-chip-ready'), 'the chip is ready').not.toBeNull();
}

const pressEnter = async () => {
    await act(async () => { composer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settled(10);
};

/** The server's frame to every member after a delete, and the list without those rows. */
async function goneFromTheList(ids: number[], frame: 'ChannelUpdated' | 'ChannelPermsChanged' = 'ChannelUpdated') {
    h.channels = h.channels.filter(c => !ids.includes(c.id as number));
    await act(async () => { for (const f of frames[frame] ?? []) f({ type: frame, payload: { server_id: 's1' } }); });
    await settled();
}

describe('the conversation goes away while someone is writing in it', () => {
    it('CONTROL: another channel deleted: still here, nothing said, and Enter goes here', async () => {
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        await goneFromTheList([12]);
        expect(headerText()).toContain('staff-only');
        expect(composer()!.value).toBe('for the staff only');
        expect(dialogs.notices()).toEqual([]);
        await pressEnter();
        expect(h.sent[0]?.[0]).toBe(11);
    });

    it('the channel deleted: the box is empty, the notice has the words, and Enter posts nothing anywhere', async () => {
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        composer()!.style.height = '120px'; // it grew with what was written
        await goneFromTheList([11]);
        expect(headerText(), 'moved to where the list lands').toContain('general');
        expect(composer()!.value).toBe('');
        expect(composer()!.style.height).toBe('auto');
        const [said] = dialogs.notices();
        expect(said).toContain('#staff-only is no longer available');
        expect(said).toContain('What you wrote in #staff-only:\nfor the staff only');
        await pressEnter();
        expect(h.sent, 'nothing went to #general').toEqual([]);
    });

    it('View taken away is the same', async () => {
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        await goneFromTheList([11], 'ChannelPermsChanged');
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()[0]).toContain('for the staff only');
    });

    it('the channel\'s collection deleted is the same, and names the channel', async () => {
        h.channels = [
            GENERAL,
            row(20, 'Private', { channel_type: 2 }),
            row(21, 'inside', { parent_id: 20 }),
        ];
        await mountChat();
        await open('inside');
        await type('for inside');
        await goneFromTheList([20, 21]);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()[0]).toContain('What you wrote in #inside:\nfor inside');
    });

    it('a ready attachment does not go either: dropped, its upload given back, and it is said', async () => {
        await mountChat();
        await open('staff-only');
        await type('with a file');
        await dropReadyFile();
        await goneFromTheList([11]);
        expect(document.querySelector('.composer-chip-ready'), 'no chip on the next channel').toBeNull();
        expect(h.discarded).toEqual(['up-notes.txt']);
        const [said] = dialogs.notices();
        expect(said).toContain('Its attachments were not sent either.');
        expect(said).toContain('with a file');
        await pressEnter();
        expect(h.sent).toEqual([]);
    });

    it('an attachment with no words is said too, with nothing quoted', async () => {
        await mountChat();
        await open('staff-only');
        await dropReadyFile();
        await goneFromTheList([11]);
        const [said] = dialogs.notices();
        expect(said).toContain('#staff-only is no longer available');
        expect(said).toContain('Its attachments were not sent either.');
        expect(said).not.toContain('What you wrote');
    });

    it('the reply being written goes with it, and nothing goes out as a reply', async () => {
        h.rows = [{ id: 'm7', channel_id: 11, user_id: ME + 1, username: 'bob', content: 'the plan', created_at: '2026-10-01T00:00:00Z' }];
        await mountChat();
        await open('staff-only');
        for (let i = 0; i < 40 && !document.querySelector('.msg-action-btn[title="Reply"]'); i++) await settle();
        await act(async () => { document.querySelector<HTMLElement>('.msg-action-btn[title="Reply"]')!.click(); });
        await settle();
        expect(document.querySelector('.replying-to'), 'CONTROL: replying').not.toBeNull();
        await type('my answer');
        await goneFromTheList([11]);
        expect(document.querySelector('.replying-to')).toBeNull();
        expect(dialogs.notices()[0]).toContain('my answer');
        await pressEnter();
        expect(h.sent).toEqual([]);
    });

    it('whitespace alone says nothing', async () => {
        await mountChat();
        await open('staff-only');
        await type('  \n ');
        await goneFromTheList([11]);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()).toEqual([]);
    });

    it('nothing written says nothing', async () => {
        await mountChat();
        await open('staff-only');
        await goneFromTheList([11]);
        expect(headerText()).toContain('general');
        expect(dialogs.notices()).toEqual([]);
    });

    it('a half-typed mention does not leave its list open over the next channel', async () => {
        await mountChat();
        await open('staff-only');
        const box = composer()!;
        box.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '#gen');
        box.setSelectionRange(4, 4);
        await act(async () => { box.dispatchEvent(new Event('input', { bubbles: true })); });
        await settle();
        expect(document.querySelector('.ac-name'), 'CONTROL: the list opened').not.toBeNull();
        await goneFromTheList([11]);
        expect(document.querySelector('.ac-name')).toBeNull();
        await pressEnter();
        expect(composer()!.value, 'Enter picked nothing').toBe('');
    });

    it('words kept behind a collection\'s page do not appear when that page goes', async () => {
        h.channels = [GENERAL, row(20, 'Private', { channel_type: 2 })];
        await mountChat();
        await type('from general');
        // Their own click on the collection keeps the words, hidden: there is no composer on its page.
        await open('Private');
        expect(composer(), 'the page has no composer').toBeNull();
        await goneFromTheList([20]);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('Private is no longer available');
        expect(said).toContain('What you wrote:\nfrom general');
    });

    it('nor behind a checklist channel, whose page has no box either', async () => {
        h.channels = [GENERAL, row(22, 'chores', { has_checklist: true })];
        await mountChat();
        await type('from general');
        await open('chores');
        expect(composer(), 'the page has no composer').toBeNull();
        await goneFromTheList([22]);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('#chores is no longer available');
        expect(said, 'not said to be written there').toContain('What you wrote:\nfrom general');
    });

    it('removed from the server: the words are in the notice, and the next conversation\'s box is empty', async () => {
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        h.servers = [];
        await act(async () => { for (const f of frames.RemovedFromServer) f({ type: 'RemovedFromServer', payload: { server_id: 's1' } }); });
        await settled();
        expect(composer()!.value, 'the box stays mounted behind Friends, for the next conversation').toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('Srv is no longer available');
        expect(said).toContain('What you wrote in #staff-only:\nfor the staff only');
        expect(dialogs.notices()).toHaveLength(1);
    });

    it('a kick from a server NOT on screen leaves the words alone', async () => {
        h.servers = [
            { id: 's1', name: 'Srv', owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z' },
            { id: 's2', name: 'Far', owner_id: ME + 1, created_at: '2026-10-02T00:00:00Z' },
        ];
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        h.servers = [h.servers[0]];
        await act(async () => { for (const f of frames.RemovedFromServer) f({ type: 'RemovedFromServer', payload: { server_id: 's2' } }); });
        await settled();
        expect(headerText()).toContain('staff-only');
        expect(composer()!.value).toBe('for the staff only');
        expect(dialogs.notices()).toEqual([]);
    });

    it('the server gone from the list, with no frame (disbanded by its owner), is the same', async () => {
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        h.servers = [];
        await act(async () => { await queryClient.invalidateQueries({ queryKey: keys.servers }); });
        await settled();
        expect(composer()!.value).toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('Srv is no longer available');
        expect(said).toContain('for the staff only');
    });

    it('deleting the open channel yourself moves you on, and your words do not go with you', async () => {
        h.servers = [{ id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' }];
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        await act(async () => {
            rowNamed('staff-only')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        });
        const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(el => /delete/i.test(el.textContent ?? ''));
        expect(item, 'the row\'s menu has Delete').toBeTruthy();
        await act(async () => { item!.click(); });
        await settled();
        expect(h.deleted.some(path => path.endsWith('/channels/11')), 'the delete went').toBe(true);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        const [said] = dialogs.notices();
        expect(said).toContain('What you wrote in #staff-only:\nfor the staff only');
        expect(dialogs.notices()).toHaveLength(1);
        await pressEnter();
        expect(h.sent).toEqual([]);
    });

    it('leaving the server you are writing in, the next server\'s channel gets an empty box', async () => {
        h.servers = [
            { id: 's1', name: 'Srv', owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z' },
            { id: 's2', name: 'Far', owner_id: ME + 1, created_at: '2026-10-02T00:00:00Z' },
        ];
        h.channels = [GENERAL, STAFF, row(30, 'far-general', { server_id: 's2' })];
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        const icon = document.querySelector<HTMLElement>('.server-icon[title="Srv"]')!;
        await act(async () => { icon.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
        const leave = [...document.querySelectorAll<HTMLElement>('.context-menu-item, .server-context-menu *')].find(el => /^leave/i.test(el.textContent?.trim() ?? ''));
        expect(leave, 'the server\'s menu has Leave').toBeTruthy();
        await act(async () => { leave!.click(); });
        await settled();
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()[0]).toContain('for the staff only');
        await pressEnter();
        expect(h.sent).toEqual([]);
    });

    it('disbanding the server you are writing in is the same', async () => {
        h.servers = [
            { id: 's1', name: 'Srv', owner_id: ME, created_at: '2026-10-01T00:00:00Z' },
            { id: 's2', name: 'Far', owner_id: ME + 1, created_at: '2026-10-02T00:00:00Z' },
        ];
        h.channels = [GENERAL, STAFF, row(30, 'far-general', { server_id: 's2' })];
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        const icon = document.querySelector<HTMLElement>('.server-icon[title="Srv"]')!;
        await act(async () => { icon.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
        const disband = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(el => /disband/i.test(el.textContent ?? ''));
        expect(disband, 'the owner\'s menu has Disband').toBeTruthy();
        await act(async () => { disband!.click(); });
        await settled();
        for (let i = 0; i < 40 && !headerText().includes('far-general'); i++) await settle();
        expect(headerText()).toContain('far-general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()[0]).toContain('for the staff only');
    });
});

const SRV = { id: 's1', name: 'Srv', owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z' };
const FAR = { id: 's2', name: 'Far', owner_id: ME + 1, created_at: '2026-10-02T00:00:00Z' };
const PRIVATE = row(20, 'Private', { channel_type: 2 });
const FAR_GENERAL = row(30, 'far-general', { server_id: 's2' });
const FEW = 20;

const clickServer = async (name: string) => {
    await act(async () => { document.querySelector<HTMLElement>(`.server-icon[title="${name}"]`)!.click(); });
};
const landedOn = async (name: string) => {
    for (let i = 0; i < 60 && !headerText().includes(name); i++) await settle();
    await settled(5);
    expect(headerText()).toContain(name);
};
const pressInServerMenu = async (item: RegExp) => {
    const icon = document.querySelector<HTMLElement>('.server-icon[title="Srv"]')!;
    await act(async () => { icon.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const found = [...document.querySelectorAll<HTMLElement>('.context-menu-item, .server-context-menu *')].find(el => item.test(el.textContent?.trim() ?? ''));
    expect(found, `the server's menu has ${item}`).toBeTruthy();
    await act(async () => { found!.click(); });
};

describe('another server, from a collection\'s page with words kept behind it', () => {
    it('a click on one already visited: the words are there on its channel, and nothing is said', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, PRIVATE, FAR_GENERAL];
        await mountChat();
        await clickServer('Far');
        await landedOn('far-general');
        await clickServer('Srv');
        for (let i = 0; i < 60 && !rowNamed('Private'); i++) await settle();
        await settled(5);
        await type('from general');
        await open('Private');
        await clickServer('Far');
        await landedOn('far-general');
        expect(composer()!.value).toBe('from general');
        expect(dialogs.notices()).toEqual([]);
    });

    it('a click on one whose list has not come yet: the same, and the page does not go round waiting for it', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, PRIVATE, FAR_GENERAL];
        await mountChat();
        await type('from general');
        await open('Private');
        await clickServer('Far');
        await landedOn('far-general');
        expect(feedLoads).toBeLessThan(FEW);
        expect(composer()!.value).toBe('from general');
        expect(dialogs.notices()).toEqual([]);
    });
});

describe('the server goes from under a collection\'s page', () => {
    it('CONTROL: on the page, the feed is asked for a few times, not over and over', async () => {
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await open('Private');
        await settled();
        expect(feedLoads).toBeGreaterThan(0);
        expect(feedLoads).toBeLessThan(FEW);
    });

    it('removed from it: one notice, and nothing goes round afterwards', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, PRIVATE, FAR_GENERAL];
        await mountChat();
        await type('from general');
        await open('Private');
        h.servers = [FAR];
        await act(async () => { for (const f of frames.RemovedFromServer) f({ type: 'RemovedFromServer', payload: { server_id: 's1' } }); });
        await settled();
        expect(feedLoads).toBeLessThan(FEW);
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('Srv is no longer available');
        await clickServer('Far');
        await landedOn('far-general');
        expect(dialogs.notices(), 'the collection is not named on top of it').toHaveLength(1);
        expect(composer()!.value).toBe('');
    });

    it('gone from the list with no frame: the same', async () => {
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await type('from general');
        await open('Private');
        h.servers = [];
        await act(async () => { await queryClient.invalidateQueries({ queryKey: keys.servers }); });
        await settled();
        expect(feedLoads).toBeLessThan(FEW);
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('Srv is no longer available');
    });

    it('leaving your last server: the same', async () => {
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await open('Private');
        await pressInServerMenu(/^leave/i);
        await settled();
        expect(h.deleted.some(path => path.endsWith('/servers/s1/leave')), 'the leave went').toBe(true);
        expect(feedLoads).toBeLessThan(FEW);
    });

    it('disbanding your last server: the same', async () => {
        h.servers = [{ ...SRV, owner_id: ME }];
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await open('Private');
        await pressInServerMenu(/disband/i);
        await settled();
        expect(h.deleted.some(path => path.endsWith('/servers/s1')), 'the disband went').toBe(true);
        expect(feedLoads).toBeLessThan(FEW);
    });

    it('home from a notification or a shortcut, with the server still there: nothing goes round', async () => {
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await open('Private');
        h.nav = 'dms';
        await act(async () => { window.dispatchEvent(new CustomEvent('sovereign-navigate')); });
        await settled();
        expect(feedLoads).toBeLessThan(FEW);
    });
});

describe('a leave or a disband still on its way while they go somewhere else', () => {
    /** Press it, with the request held open; the returned function lets the answer come. */
    const pressHeld = async (item: RegExp) => {
        let answer!: () => void;
        h.hold = new Promise<void>(r => { answer = r; });
        await pressInServerMenu(item);
        await settled(3);
        expect(h.deleted, 'still on its way').toEqual([]);
        return async () => {
            h.hold = null;
            await act(async () => { answer(); });
            await settled();
        };
    };

    it('leaving, and on to the server that stays: its box keeps the words, and it is not said to be gone', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, FAR_GENERAL];
        await mountChat();
        await type('still writing');
        const answered = await pressHeld(/^leave/i);
        await clickServer('Far');
        await landedOn('far-general');
        expect(composer()!.value, 'their own click kept the words').toBe('still writing');
        await answered();
        expect(h.deleted.some(path => path.endsWith('/servers/s1/leave')), 'the leave went').toBe(true);
        expect(headerText()).toContain('far-general');
        expect(composer()!.value).toBe('still writing');
        expect(dialogs.notices()).toEqual([]);
    });

    it('disbanding is the same', async () => {
        h.servers = [{ ...SRV, owner_id: ME }, FAR];
        h.channels = [GENERAL, FAR_GENERAL];
        await mountChat();
        await type('still writing');
        const answered = await pressHeld(/disband/i);
        await clickServer('Far');
        await landedOn('far-general');
        await answered();
        expect(h.deleted.some(path => path.endsWith('/servers/s1')), 'the disband went').toBe(true);
        expect(composer()!.value).toBe('still writing');
        expect(dialogs.notices()).toEqual([]);
    });

    it('leaving, and on to home: no notice about "undefined", and home stays home', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, FAR_GENERAL];
        await mountChat();
        await type('still writing');
        const answered = await pressHeld(/^leave/i);
        h.nav = 'dms';
        await act(async () => { window.dispatchEvent(new CustomEvent('sovereign-navigate')); });
        await settled(5);
        await answered();
        expect(composer()!.value).toBe('still writing');
        expect(dialogs.notices()).toEqual([]);
        expect(document.querySelector('.server-header'), 'not pulled back into a server').toBeNull();
    });

    it('CONTROL: still on that server when the answer comes: the words go in a notice naming it', async () => {
        h.servers = [SRV, FAR];
        h.channels = [GENERAL, FAR_GENERAL];
        await mountChat();
        await type('still writing');
        const answered = await pressHeld(/^leave/i);
        await answered();
        await landedOn('far-general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('Srv is no longer available');
    });
});

describe('a channel made from a collection\'s page', () => {
    /** Create Subchannel on the open collection's row, through the real form. */
    const createInside = async (name: string) => {
        await act(async () => {
            rowNamed('Private')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
        });
        const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(el => /create subchannel/i.test(el.textContent ?? ''));
        expect(item, 'the row\'s menu has Create Subchannel').toBeTruthy();
        await act(async () => { item!.click(); });
        await settled(3);
        const field = [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')].find(i => i.closest('.form-group')?.textContent?.includes('Channel Name'))!;
        expect(field, 'the form is up').toBeTruthy();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, name);
        await act(async () => { field.dispatchEvent(new Event('input', { bubbles: true })); });
        await settle();
        await act(async () => { field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settled();
    };

    it('opens that channel, and a delete of both says the words once', async () => {
        h.servers = [{ ...SRV, owner_id: ME }];
        h.channels = [GENERAL, PRIVATE];
        await mountChat();
        await type('from general');
        await open('Private');
        await createInside('made-inside');
        expect(headerText(), 'the new channel, not the collection\'s page').toContain('made-inside');
        expect(composer()!.value, 'their own move keeps the words').toBe('from general');
        expect(dialogs.notices()).toEqual([]);
        await goneFromTheList([20, 77]);
        expect(headerText()).toContain('general');
        expect(composer()!.value).toBe('');
        expect(dialogs.notices()).toHaveLength(1);
        expect(dialogs.notices()[0]).toContain('#made-inside is no longer available');
        expect(dialogs.notices()[0]).toContain('from general');
    });
});

describe('what stays as it was', () => {
    it('CONTROL: their own click on another channel keeps the words', async () => {
        await mountChat();
        await open('staff-only');
        await type('still mine');
        await open('other');
        expect(composer()!.value).toBe('still mine');
        expect(dialogs.notices()).toEqual([]);
    });

    it('CONTROL: a mode that hides the open channel moves nobody, so nothing is taken', async () => {
        h.servers = [{ id: 's1', name: 'Srv', owner_id: ME + 1, created_at: '2026-10-01T00:00:00Z', active_mode_id: 3 }];
        h.channels = [GENERAL, { ...STAFF, mode_ids: [3] }];
        await mountChat();
        await open('staff-only');
        await type('for the staff only');
        h.servers = [{ ...h.servers[0], active_mode_id: null }];
        await act(async () => {
            for (const f of frames.ServerModeChanged ?? []) f({ type: 'ServerModeChanged', payload: { server_id: 's1', active_mode_id: null, previous_mode_id: 3, by: ME + 1 } });
        });
        await settled();
        expect(headerText()).toContain('staff-only');
        expect(composer()!.value).toBe('for the staff only');
        expect(dialogs.notices()).toEqual([]);
    });
});
