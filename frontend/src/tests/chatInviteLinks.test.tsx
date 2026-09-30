/**
 * An invite link to this server, CLICKED inside the app, opens Púca's own
 * join dialog — driven through the real Chat, the real JoinServerModal and
 * the real link router (api/linkRouter.ts).
 *
 * The report: "an invite link doesn't open in the desktop app". The desktop
 * handed every link to the system browser, so an invite to the server the
 * app was signed in to opened the WEB app in a browser tab, and the person
 * joined there. Now the dialog opens in place, code filled in and looked
 * up, in the desktop app and the web app alike, and only an ordinary link
 * leaves the app.
 *
 * Also pinned: an invite to a server you are ALREADY in — which is now one
 * click away in any message it was posted to — switches to that server. The
 * server answers it with a 200 whose body is the text "Already a member",
 * and that string used to be listed as a server of its own.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const APP = 'https://app.example.com';

const h = vi.hoisted(() => ({
    tauri: false,
    servers: [] as unknown[],
    invites: {} as Record<string, unknown>,
    /** What POST /invites/:code/join answers: a server, or the member text. */
    joinAnswer: null as unknown,
    requests: [] as string[],
    shell: [] as { cmd: string; args: unknown }[],
    viewActive: [] as boolean[],
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
}));
// The shell, as far as this test needs one: open_external is recorded and
// answered; anything else fails as it does with no shell under the page.
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: (cmd: string, args?: unknown) => {
        h.shell.push({ cmd, args });
        return cmd === 'open_external' ? Promise.resolve(null) : Promise.reject(new Error(`no shell: ${cmd}`));
    },
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
vi.mock('../components/NotesDesktopView', () => ({
    NotesDesktopView: ({ active }: { active: boolean }) => {
        h.viewActive.push(active);
        return <div data-testid="notes-desktop" data-active={String(active)} />;
    },
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
class NoObserver { observe() {} unobserve() {} disconnect() {} }
vi.stubGlobal('ResizeObserver', NoObserver);
vi.stubGlobal('IntersectionObserver', NoObserver);

const reply = (status: number, body: unknown) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text, headers: new Headers() } as unknown as Response;
};
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    h.requests.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
    if (/\/config$/.test(u)) return reply(200, { app_url: APP, registration_invite_required: false, srp_version: 2 });
    const join = /\/invites\/([^/]+)\/join$/.exec(u);
    if (join && method === 'POST') return reply(200, h.joinAnswer);
    const look = /\/invites\/([^/?]+)$/.exec(u);
    if (look) return look[1] in h.invites ? reply(200, h.invites[look[1]]) : reply(404, 'Invite not found or expired');
    const body = /\/servers$/.test(u) ? h.servers : /\/dms$/.test(u) ? [] : /\/servers\/[^/]+\/channels$/.test(u) ? []
        : /\/servers\/[^/]+\/unread$/.test(u) ? { channels: [] }
        : /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : [];
    return reply(200, body);
}));

const { Chat } = await import('../components/Chat');
const { installLinkRouter } = await import('../api/linkRouter');

let root: Root | null = null;
/** The page's query client: the server list lives in it. */
let qc: QueryClient;
let host: HTMLElement | null = null;
let uninstallRouter: () => void;
/** Clicks as the page's default would see them, then kept from navigating jsdom. */
let seen: boolean[] = [];
const stop = (e: Event) => { seen.push(e.defaultPrevented); e.preventDefault(); };

beforeAll(() => { uninstallRouter = installLinkRouter(); });
afterAll(() => { uninstallRouter(); });

async function mountChat() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><MemoryRouter><Chat onLogout={() => {}} /></MemoryRouter></QueryClientProvider>);
    });
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });
/** A link as a message renders one, clicked. */
async function clickLink(href: string) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'message-link';
    a.textContent = href;
    document.body.append(a);
    await act(async () => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await settle();
    a.remove();
    return seen[seen.length - 1];
}
const joinModal = () => document.querySelector<HTMLElement>('.join-modal');
const joinField = () => joinModal()?.querySelector<HTMLInputElement>('.invite-input-group input') ?? null;
const opened = () => h.shell.filter(c => c.cmd === 'open_external').map(c => (c.args as { url: string }).url);
const lookups = () => h.requests.filter(r => /^GET \/invites\//.test(r));

beforeEach(() => {
    h.tauri = false;
    h.servers = [];
    h.invites = {
        aBc123Xy: { code: 'aBc123Xy', server_id: 's2', server_name: 'Beta', member_count: 4 },
        dEf456Zw: { code: 'dEf456Zw', server_id: 's3', server_name: 'Gamma', member_count: 9 },
        mine1234: { code: 'mine1234', server_id: 's1', server_name: 'Alpha', member_count: 2 },
    };
    h.joinAnswer = null;
    h.requests = [];
    h.shell = [];
    h.viewActive = [];
    seen = [];
    window.addEventListener('click', stop);
});
afterEach(() => {
    window.removeEventListener('click', stop);
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = '';
});

describe('the desktop app', () => {
    beforeEach(() => { h.tauri = true; });

    it('an invite link to this server opens the join dialog, the code filled in and looked up — no browser', async () => {
        await mountChat();
        expect(joinModal()).toBeNull();
        const prevented = await clickLink(`${APP}/invite/aBc123Xy`);
        expect(prevented).toBe(true);
        expect(joinField()?.value).toBe('aBc123Xy');
        expect(lookups()).toEqual(['GET /invites/aBc123Xy']);
        expect(joinModal()!.querySelector('.invite-preview h3')?.textContent).toBe('Beta');
        expect(joinModal()!.querySelector('.join-btn.primary')?.textContent).toBe('Join Server');
        expect(opened()).toEqual([]);
    });

    it('an ordinary link leaves the app through open_external, once, and opens no dialog', async () => {
        await mountChat();
        await clickLink('https://example.org/page');
        expect(opened()).toEqual(['https://example.org/page']);
        expect(joinModal()).toBeNull();
    });

    it('another site\'s invite, and a look-alike of this one, open in the browser', async () => {
        await mountChat();
        await clickLink('https://example.org/invite/aBc123Xy');
        await clickLink('https://app.example.com.evil.test/invite/aBc123Xy');
        expect(opened()).toEqual(['https://example.org/invite/aBc123Xy', 'https://app.example.com.evil.test/invite/aBc123Xy']);
        expect(joinModal()).toBeNull();
        expect(lookups()).toEqual([]);
    });

    it('with Púca Notes on screen, the dialog opens over it and Notes is still there when it closes', async () => {
        await mountChat();
        await act(async () => { (document.querySelector('.server-icon.notes-self') as HTMLElement).click(); });
        await settle();
        expect(document.querySelector('[data-testid="notes-desktop"]')?.getAttribute('data-active')).toBe('true');
        await clickLink(`${APP}/invite/aBc123Xy`);
        expect(joinField()?.value).toBe('aBc123Xy');
        expect(document.querySelector('[data-testid="notes-desktop"]')?.getAttribute('data-active')).toBe('true');
        await act(async () => { (joinModal()!.querySelector('.join-modal-close') as HTMLElement).click(); });
        await settle();
        expect(joinModal()).toBeNull();
        expect(document.querySelector('[data-testid="notes-desktop"]')?.getAttribute('data-active')).toBe('true');
    });

    it('a second invite while the dialog is open replaces the code and looks it up', async () => {
        await mountChat();
        await clickLink(`${APP}/invite/aBc123Xy`);
        await clickLink(`${APP}/invite/dEf456Zw`);
        expect(joinField()?.value).toBe('dEf456Zw');
        expect(joinModal()!.querySelector('.invite-preview h3')?.textContent).toBe('Gamma');
        expect(lookups()).toEqual(['GET /invites/aBc123Xy', 'GET /invites/dEf456Zw']);
    });

    it('an invite to a server you are already in switches to it — and lists it once', async () => {
        h.servers = [{ id: 's1', name: 'Alpha', owner_id: 99, icon_file_id: null }];
        h.joinAnswer = 'Already a member';
        await mountChat();
        await act(async () => { (document.querySelector('.server-icon.home-button') as HTMLElement).click(); });
        await settle();
        expect(document.querySelector('.server-icon[title="Alpha"]')!.classList.contains('active')).toBe(false);
        await clickLink(`${APP}/invite/mine1234`);
        expect(joinModal()!.querySelector('.invite-preview h3')?.textContent).toBe('Alpha');
        await act(async () => { (joinModal()!.querySelector('.join-btn.primary') as HTMLElement).click(); });
        await settle();
        expect(h.requests).toContain('POST /invites/mine1234/join');
        expect(joinModal()).toBeNull();
        const rail = [...document.querySelectorAll('.server-icons .server-icon')].map(e => e.getAttribute('title'));
        expect(rail.filter(t => t === 'Alpha')).toHaveLength(1);
        expect(rail).not.toContain('Already a member');
        // The rail de-duplicates by id on its own, so read the list itself:
        // every other reader of it (pickers, counts) must not see Alpha twice.
        expect((qc.getQueryData<{ id: string }[]>(['servers']) ?? []).map(s => s.id)).toEqual(['s1']);
        expect(document.querySelector('.server-icon[title="Alpha"]')!.classList.contains('active')).toBe(true);
    });

    it('CONTROL: with no router installed the same click opens nothing — what the shell used to do', async () => {
        await mountChat();
        uninstallRouter();
        try {
            const prevented = await clickLink(`${APP}/invite/aBc123Xy`);
            expect(prevented).toBe(false);
            expect(joinModal()).toBeNull();
            expect(opened()).toEqual([]);
        } finally {
            uninstallRouter = installLinkRouter();
        }
    });
});

describe('the web app', () => {
    it('an invite link to this server opens the same dialog in place, not a new tab', async () => {
        await mountChat();
        const prevented = await clickLink(`${APP}/invite/aBc123Xy`);
        expect(prevented).toBe(true);
        expect(joinField()?.value).toBe('aBc123Xy');
        expect(joinModal()!.querySelector('.invite-preview h3')?.textContent).toBe('Beta');
    });

    it('an ordinary link is the browser\'s: not prevented, nothing opened by hand', async () => {
        await mountChat();
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        try {
            const prevented = await clickLink('https://example.org/page');
            expect(prevented).toBe(false);
            expect(open).not.toHaveBeenCalled();
            expect(joinModal()).toBeNull();
        } finally {
            open.mockRestore();
        }
    });
});
