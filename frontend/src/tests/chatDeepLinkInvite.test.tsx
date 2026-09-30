/**
 * A `puca://` invite link from outside the app, through the REAL Chat and
 * Login: the desktop shell's warm-start event and its cold-start link both
 * end at Chat's Join a Server dialog with the code looked up — and there it
 * stops, because nothing joins until the person presses Join Server.
 *
 * The shell is faked at its two edges (api/deepLink.ts's `listen` for the
 * event, `invoke('deep_link_take')` for the cold link); everything between
 * the payload and the dialog is the shipping code. Negative controls: before
 * any link no dialog is open, a refused link and a link for another server
 * open none and look nothing up, and signed out the code waits for sign-in
 * instead of opening anything.
 *
 * Also pinned, because a link from outside makes each of them one click away:
 * a server that cannot be ASKED whether the link's host is its web app (GET
 * /config down) is not called "another server" — the person is told it could
 * not be checked and can try again; and pressing Join Server on an invite to
 * a server you are already in (the server answers 200 "Already a member", as
 * text) switches to it instead of crashing the rail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
    authed: true,
    listeners: new Map<string, (e: { payload: unknown }) => void>(),
    takes: [] as unknown[],
    requests: [] as { method: string; url: string }[],
    /** GET /config: its status, and the web app address it names (null: none). */
    configStatus: 200,
    appUrl: 'https://app.example.com' as string | null,
    /** GET /servers: the servers this account is in. */
    servers: [] as unknown[],
    /** POST /invites/:code/join: a server, or the server's plain-text answer. */
    joinAnswer: null as unknown,
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => true,
    isMobile: () => false,
}));
vi.mock('../api/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/auth')>()),
    isAuthenticated: () => h.authed,
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
        h.listeners.set(event, cb);
        return () => { h.listeners.delete(event); };
    },
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    // deep_link_take is the one command under test; anything else Chat asks
    // the (absent) shell fails as it does with no shell at all.
    invoke: async (cmd: string) => {
        if (cmd === 'deep_link_take') return h.takes.length ? h.takes.shift() : null;
        throw new Error(`no shell: ${cmd}`);
    },
}));
vi.mock('../components/NotesDesktopView', () => ({ NotesDesktopView: () => null }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const CODE = 'aBc123Xy';
const SERVER = 'Walk Server';
vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    h.requests.push({ method, url });
    const json = (body: unknown, status = 200) => ({
        ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers(),
    } as unknown as Response);
    /** A body that is not JSON, as the server's plain-text answers are. */
    const text = (body: string, status = 200) => ({
        ok: status < 400, status, json: async () => JSON.parse(body), text: async () => body, headers: new Headers(),
    } as unknown as Response);
    if (new RegExp(`/invites/${CODE}$`).test(url) && method === 'GET') {
        return json({ code: CODE, server_id: 's-walk', server_name: SERVER, member_count: 3 });
    }
    if (new RegExp(`/invites/${CODE}/join$`).test(url) && method === 'POST') {
        return typeof h.joinAnswer === 'string' ? text(h.joinAnswer) : json(h.joinAnswer);
    }
    if (/\/invites\//.test(url)) return json({ error: 'no such invite' }, 404);
    if (/\/config$/.test(url)) {
        return h.configStatus === 200
            ? json({ app_url: h.appUrl, registration_invite_required: false })
            : text('Service Unavailable', h.configStatus);
    }
    if (/\/servers$/.test(url) && method === 'GET') return json(h.servers);
    // Unread counts, the aggregate and the per-server shape alike: nothing unread.
    if (/unread/.test(url)) return json({ servers: [], channels: [] });
    // As chatNotesDesktop.test.tsx: objects where Chat expects one, lists elsewhere.
    return json(/ice|features|version|keys|me$|settings|unread/.test(url) ? {} : []);
}));

const { Chat } = await import('../components/Chat');
const { Login } = await import('../components/Login');
const { DeepLinkNotice } = await import('../components/DeepLinkNotice');
const { installDeepLinks, DEEP_LINK_EVENT, __resetDeepLinksForTest } = await import('../api/deepLink');
const { peekPendingInvite } = await import('../api/pendingInvite');
const { __resetPublicConfigForTest } = await import('../api/publicConfig');
const { API_BASE_URL } = await import('../api/config');
const API_HOST = new URL(API_BASE_URL).hostname;

let root: Root | null = null;
let host: HTMLElement | null = null;
/** The page's query client: the server list lives in it. */
let qc: QueryClient;
const settle = async (ms = 30) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };

async function mount(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
    });
    await settle();
}
async function unmount() {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
}
/** The shell's warm-start event, as deep_link.rs emits it. */
async function emit(payload: unknown) {
    const cb = h.listeners.get(DEEP_LINK_EVENT);
    expect(cb, 'the page listens for the shell\'s event').toBeTruthy();
    await act(async () => { cb!({ payload }); });
    await settle();
}
async function installed() {
    installDeepLinks();
    await vi.waitFor(() => expect(h.listeners.has(DEEP_LINK_EVENT)).toBe(true));
    await settle();
}
const joinDialog = () => document.querySelector('.join-modal');
const joinField = () => document.querySelector<HTMLInputElement>('.join-modal .invite-input-group input');
const lookedUp = () => document.querySelector('.join-modal .invite-preview h3')?.textContent ?? null;
const lookups = () => h.requests.filter(r => r.method === 'GET' && /\/invites\//.test(r.url));
const joins = () => h.requests.filter(r => r.method !== 'GET' && /\/invites\/.*\/join|\/servers\/.*\/join/.test(r.url));
const notice = () => document.querySelector<HTMLElement>('.deep-link-notice');
const noticeButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.deep-link-notice button')].find(b => b.textContent === label) ?? null;
const rail = () => [...document.querySelectorAll('.server-icons .server-icon')].map(e => e.getAttribute('title'));

beforeEach(() => {
    __resetDeepLinksForTest();
    // The real GET /config client caches an answer for the page's lifetime;
    // each test here is a fresh page.
    __resetPublicConfigForTest();
    sessionStorage.clear();
    h.authed = true;
    h.listeners.clear();
    h.takes = [];
    h.requests = [];
    h.configStatus = 200;
    h.appUrl = 'https://app.example.com';
    h.servers = [];
    h.joinAnswer = null;
});
afterEach(async () => {
    await unmount();
    document.body.innerHTML = '';
});

describe('a puca:// invite reaches Join a Server — and stops there', () => {
    it('WARM: the shell\'s event opens Join with the code looked up; nothing joins', async () => {
        await mount(<Chat onLogout={() => {}} />);
        await installed();
        expect(joinDialog()).toBeNull();                 // positive control: nothing open yet
        await emit(`puca://invite/${CODE}?host=${API_HOST}`);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
        expect(joinField()?.value).toBe(CODE);
        expect(lookups().map(r => new URL(r.url).pathname.split('/').pop())).toEqual([CODE]);
        expect(document.querySelector('.join-modal .join-btn.primary')?.textContent).toMatch('Join Server');
        await settle(100);
        expect(joins()).toEqual([]);                     // never joins by itself
    });

    it('COLD: the link the launch carried opens Join when Chat mounts', async () => {
        h.takes = [`puca://invite/${CODE}`];
        await installed();
        await vi.waitFor(() => expect(peekPendingInvite()).toBe(CODE));
        await mount(<Chat onLogout={() => {}} />);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
        expect(joinField()?.value).toBe(CODE);
        expect(peekPendingInvite()).toBeNull();          // consumed, once
        await settle(100);
        expect(joins()).toEqual([]);
    });

    it('signed out: the code waits through sign-in — Login says so, Chat opens it after', async () => {
        h.authed = false;
        await mount(<Login onLoginSuccess={() => {}} />);
        await installed();
        expect(document.querySelector('.login-invite-note')).toBeNull();
        await emit(`puca://invite/${CODE}?host=${API_HOST}`);
        // Login re-read the waiting invite the moment it arrived…
        expect(document.querySelector('.login-invite-note')?.textContent).toMatch(/invited to a server/);
        // …and nothing was looked up, let alone joined, before sign-in.
        expect(joinDialog()).toBeNull();
        expect(lookups()).toEqual([]);
        expect(peekPendingInvite()).toBe(CODE);
        // Signed in: Chat takes it.
        await unmount();
        h.authed = true;
        await mount(<Chat onLogout={() => {}} />);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
        expect(joinField()?.value).toBe(CODE);
        await settle(100);
        expect(joins()).toEqual([]);
    });

    it('a link for ANOTHER server: the message, and no dialog and no lookup here', async () => {
        await mount(<><Chat onLogout={() => {}} /><DeepLinkNotice /></>);
        await installed();
        await emit(`puca://invite/${CODE}?host=other.example.com`);
        await vi.waitFor(() => expect(document.querySelector('.deep-link-notice')).not.toBeNull());
        expect(document.querySelector('.deep-link-notice')?.textContent)
            .toMatch('This invite is for other.example.com, not the server this app is signed in to.');
        expect(joinDialog()).toBeNull();
        expect(lookups()).toEqual([]);
        expect(peekPendingInvite()).toBeNull();
        // OK dismisses it.
        const ok = [...document.querySelectorAll<HTMLButtonElement>('.deep-link-notice button')].find(b => b.textContent === 'OK');
        await act(async () => { ok!.click(); });
        expect(document.querySelector('.deep-link-notice')).toBeNull();
    });

    it('Escape closes that message and nothing under it', async () => {
        await mount(<><Chat onLogout={() => {}} /><DeepLinkNotice /></>);
        await installed();
        await emit(`puca://invite/${CODE}?host=other.example.com`);
        await vi.waitFor(() => expect(document.querySelector('.deep-link-notice')).not.toBeNull());
        // Whatever else listens for Escape (an open Settings dialog, say).
        const below = vi.fn();
        document.addEventListener('keydown', below);
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        document.removeEventListener('keydown', below);
        expect(document.querySelector('.deep-link-notice')).toBeNull();
        expect(below).not.toHaveBeenCalled();
        // Positive control: with the message gone, Escape reaches the page again.
        const again = vi.fn();
        document.addEventListener('keydown', again);
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.removeEventListener('keydown', again);
        expect(again).toHaveBeenCalledTimes(1);
    });

    it('the web app\'s own address (GET /config) is this server: looked up', async () => {
        await mount(<Chat onLogout={() => {}} />);
        await installed();
        await emit(`puca://invite/${CODE}?host=app.example.com`);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
    });

    it('the server cannot be ASKED (GET /config down): "could not check", never "another server" — and Try again looks it up once it answers', async () => {
        h.configStatus = 503;
        await mount(<><Chat onLogout={() => {}} /><DeepLinkNotice /></>);
        await installed();
        // This server's own web app address — but nothing can confirm it now.
        await emit(`puca://invite/${CODE}?host=app.example.com`);
        await vi.waitFor(() => expect(notice()).not.toBeNull());
        expect(notice()!.textContent).toMatch('This invite link comes from app.example.com');
        expect(notice()!.textContent).toMatch('could not get an answer from the server this app is signed in to');
        expect(notice()!.textContent).not.toMatch(/not the server this app|another server/i);
        expect(joinDialog()).toBeNull();
        expect(lookups()).toEqual([]);
        expect(peekPendingInvite()).toBeNull();

        // Still down: Try again asks again, says the same, looks nothing up.
        const configAsks = () => h.requests.filter(r => /\/config$/.test(r.url)).length;
        const asked = configAsks();
        await act(async () => { noticeButton('Try again')!.click(); });
        await settle(50);
        expect(configAsks()).toBeGreaterThan(asked);
        expect(notice()).not.toBeNull();
        expect(lookups()).toEqual([]);

        // Back up: this time the answer names the link's host — looked up.
        h.configStatus = 200;
        await act(async () => { noticeButton('Try again')!.click(); });
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
        expect(notice()).toBeNull();
        expect(joinField()?.value).toBe(CODE);
        await settle(100);
        expect(joins()).toEqual([]);
    });

    it('a server that publishes no web address: says it cannot check — never "another server" — and looks nothing up', async () => {
        h.appUrl = null;
        await mount(<><Chat onLogout={() => {}} /><DeepLinkNotice /></>);
        await installed();
        await emit(`puca://invite/${CODE}?host=app.example.com`);
        await vi.waitFor(() => expect(notice()).not.toBeNull());
        expect(notice()!.textContent).toMatch('does not say what its web address is');
        expect(notice()!.textContent).not.toMatch(/not the server this app|another server/i);
        // Asking again would change nothing, so it is not offered.
        expect(noticeButton('Try again')).toBeNull();
        expect(joinDialog()).toBeNull();
        expect(lookups()).toEqual([]);
        expect(peekPendingInvite()).toBeNull();
        // Positive control: the API's own host needs no web address to match.
        await act(async () => { noticeButton('OK')!.click(); });
        await emit(`puca://invite/${CODE}?host=${API_HOST}`);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
    });

    it('an invite to a server you are ALREADY in: Join Server switches to it, listed once — the app does not crash', async () => {
        h.servers = [{ id: 's-walk', name: SERVER, owner_id: 99, icon_file_id: null, created_at: '2026-01-01T00:00:00Z' }];
        h.joinAnswer = 'Already a member';
        await mount(<Chat onLogout={() => {}} />);
        await installed();
        await vi.waitFor(() => expect(rail()).toContain(SERVER));   // positive control: the rail lists it
        await act(async () => { (document.querySelector('.server-icon.home-button') as HTMLElement).click(); });
        await settle();
        expect(document.querySelector(`.server-icon[title="${SERVER}"]`)!.classList.contains('active')).toBe(false);

        await emit(`puca://invite/${CODE}?host=${API_HOST}`);
        await vi.waitFor(() => expect(lookedUp()).toBe(SERVER));
        await act(async () => { (document.querySelector('.join-modal .join-btn.primary') as HTMLElement).click(); });
        await settle(50);

        expect(joins().map(r => new URL(r.url).pathname)).toEqual([`/invites/${CODE}/join`]);
        expect(joinDialog()).toBeNull();
        expect(rail().filter(t => t === SERVER)).toHaveLength(1);
        expect(rail()).not.toContain('Already a member');
        // Every other reader of the list (pickers, counts) sees it once too.
        expect((qc.getQueryData<{ id: string }[]>(['servers']) ?? []).map(s => s.id)).toEqual(['s-walk']);
        expect(document.querySelector(`.server-icon[title="${SERVER}"]`)!.classList.contains('active')).toBe(true);
    });

    it('a refused link opens nothing and looks nothing up', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await mount(<><Chat onLogout={() => {}} /><DeepLinkNotice /></>);
        await installed();
        for (const bad of ['puca://invite/abc', `puca://invite/${CODE}?host=${API_HOST}&next=/x`, 'javascript:alert(1)', `https://${API_HOST}/invite/${CODE}`, { code: CODE }]) {
            await emit(bad);
        }
        await settle(100);
        expect(joinDialog()).toBeNull();
        expect(document.querySelector('.deep-link-notice')).toBeNull();
        expect(lookups()).toEqual([]);
        expect(peekPendingInvite()).toBeNull();
        vi.restoreAllMocks();
    });
});
