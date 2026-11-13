/**
 * Android's BACK and a channel's pinned messages (Chat.tsx). The Friends/Tasks
 * dashboard (the rail's home button, its Tasks & notes, the bottom bar's
 * Tasks), Devices and Notes in the desktop app are drawn over the channel with
 * the channel still current; on a phone the chat panel slides away for another
 * one. Left open there, the pins held Back while nobody could see them, so Back
 * closed them and nothing visible happened (review finding). Dropping only
 * their Back layer while the dashboard was up was not enough: where the
 * desktop layout applies (an Android tablet wider than 1024 px) .pins-panel is
 * drawn OVER the dashboard, so the pins stayed on screen with no Back layer and
 * Back left the app. Now anything that takes the channel's place closes them,
 * and Back reaches whatever is under.
 *
 * The real Chat, as chatDropZone.test.tsx mounts it. interceptBack, the native
 * boundary under hooks/useBackClose.ts, is played as a stack the way
 * api/mobileApp.ts keeps it: the newest layer closes first. `under` stands for
 * a layer beneath the pins, so "Back reaches what is under" is a call to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const ME = 1;

const h = vi.hoisted(() => ({
    /** Held Back layers, oldest first (api/mobileApp.ts interceptBack). */
    layers: [] as Array<() => void>,
    /** The phone app (Capacitor): Chat's isMobile whatever the width. */
    native: false,
    /** mobile.css's gate, `(pointer: coarse) and (max-width: 1024px)`: a phone's width. */
    phoneWidth: false,
    /** The desktop app, where the rail's Tasks & notes opens Notes in the app. */
    tauri: false,
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isMobile: () => h.native,
    isTauri: () => h.tauri,
}));
vi.mock('../api/mobileApp', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/mobileApp')>()),
    interceptBack: (onBack: () => void) => {
        h.layers.push(onBack);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const i = h.layers.indexOf(onBack);
            if (i >= 0) h.layers.splice(i, 1);
        };
    },
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
// The views that take the channel's place, as stand-ins: what is under test is
// what opening them does to the pins, not the views.
vi.mock('../components/DevicesView', () => ({
    DevicesView: () => <div data-testid="devices-view" />,
}));
vi.mock('../components/NotesDesktopView', () => ({
    NotesDesktopView: ({ active }: { active: boolean }) => <div data-testid="notes-desktop" data-active={String(active)} />,
}));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
        matches: h.phoneWidth && /pointer: coarse/.test(q),
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
    if (/\/servers\/s1\/channels$/.test(u)) return reply(200, [{ id: 10, name: 'general', channel_type: 0, server_id: 's1', my_permissions: 0x7fffffff }]);
    if (/\/servers\/[^/]+\/unread$/.test(u)) return reply(200, { channels: [] });
    if (/\/dms$/.test(u)) return reply(200, []);
    return reply(200, /ice|features|version|keys|me$|settings|unread/.test(u) ? {} : []);
}));

const { Chat } = await import('../components/Chat');

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
    h.layers = [];
    h.native = false;
    h.phoneWidth = false;
    h.tauri = false;
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null; host = null;
    h.layers = [];
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
    for (let i = 0; i < 40 && !document.querySelector('.chat-header')?.textContent?.includes('general'); i++) await settle();
    expect(document.querySelector('.chat-header')?.textContent, 'the channel opened').toContain('general');
    await settle();
}

const click = async (el: Element | null, what: string) => {
    expect(el, what).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
const pins = () => document.querySelector('.pins-panel');
/** The Back gesture: the newest held layer closes. */
const back = async () => { await act(async () => { h.layers.at(-1)?.(); }); await settle(); };
const panel = () => document.querySelector<HTMLElement>('.chat-container')?.dataset.mobilePanel;
const navButton = (label: string) => [...document.querySelectorAll('.mobile-bottom-nav .mobile-nav-btn')]
    .find(b => b.querySelector('.nav-label')?.textContent === label) ?? null;

/** A layer beneath the pins, then the pins opened over it: their layer on top.
 *  `before` is the count with `under` and without the pins. */
async function openPinsOverUnder() {
    const under = vi.fn();
    h.layers.push(under);
    const before = h.layers.length;
    await click(document.querySelector('.pins-toggle-btn'), 'the pin button');
    expect(pins(), 'the pins are open').toBeTruthy();
    expect(h.layers.length, 'their Back layer is held').toBe(before + 1);
    return { under, before };
}

/** A quick, clearly horizontal one-finger swipe over the chat (chatServerMenuSwipe.test.tsx's). */
async function swipe(dx: number) {
    const el = document.querySelector('.chat-container')!;
    const touch = (x: number) => ({ clientX: x, clientY: 400, identifier: 1, target: el });
    const fire = (type: string, list: 'touches' | 'changedTouches', x: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'touches', { value: list === 'touches' ? [touch(x)] : [] });
        Object.defineProperty(ev, 'changedTouches', { value: [touch(x)] });
        el.dispatchEvent(ev);
    };
    // Both in ONE act: useSwipe drops a drag slower than 700 ms as a scroll.
    await act(async () => {
        fire('touchstart', 'touches', 300);
        fire('touchend', 'changedTouches', 300 + dx);
    });
    await settle();
}

describe("a channel's pinned messages close when something takes the channel's place", () => {
    it('positive control: with the pins open in the channel, Back closes them', async () => {
        await mountChat();
        const { under, before } = await openPinsOverUnder();
        await back();
        expect(pins()).toBeNull();
        expect(h.layers.length).toBe(before);
        expect(under, 'the pins took that Back, not the layer under them').not.toHaveBeenCalled();
    });

    it.each([
        { opener: "the rail's home button (the Friends dashboard)", sel: '.server-icon.home-button', view: '.friends-dashboard' },
        { opener: "the rail's Tasks & notes (the dashboard's Tasks, on the web)", sel: '.server-icon.notes-self', view: '.friends-dashboard' },
        { opener: "the rail's Devices", sel: '.server-icon.devices-button', view: '[data-testid="devices-view"]' },
    ])('$opener closes the pins, and Back then reaches what is under', async ({ sel, view }) => {
        await mountChat();
        const { under, before } = await openPinsOverUnder();
        await click(document.querySelector(sel), sel);
        expect(document.querySelector(view), 'the view is up').toBeTruthy();
        expect(pins(), 'the pins closed').toBeNull();
        expect(h.layers.length, 'their Back layer went with them').toBe(before);
        await back();
        expect(under, 'Back reached the layer under the pins').toHaveBeenCalledTimes(1);
    });

    it('closing the dashboard again does not bring the pins back', async () => {
        await mountChat();
        const { before } = await openPinsOverUnder();
        await click(document.querySelector('.server-icon.home-button'), "the rail's home button");
        expect(pins()).toBeNull();
        await click(document.querySelector('.friends-dashboard .close-btn[aria-label="Close"]'), "the dashboard's X");
        expect(document.querySelector('.friends-dashboard')).toBeNull();
        expect(document.querySelector('.chat-header')?.textContent, 'back in the channel').toContain('general');
        expect(pins()).toBeNull();
        expect(h.layers.length).toBe(before);
    });

    it('the desktop app: Notes opening in the app closes the pins', async () => {
        h.tauri = true;
        await mountChat();
        await openPinsOverUnder();
        await click(document.querySelector('.server-icon.notes-self'), "the rail's Tasks & notes");
        expect(document.querySelector('[data-testid="notes-desktop"]')?.getAttribute('data-active'), 'Notes is on screen').toBe('true');
        expect(pins(), 'the pins closed').toBeNull();
    });

    it('an Android tablet wider than 1024 px (the desktop layout): the pins open with mobilePanel at "channels", and the dashboard closes them', async () => {
        h.native = true;
        await mountChat();
        // The chat is on screen beside the channel list here, and mobilePanel rests at
        // 'channels' (the server auto-select puts it there): the pins must still open.
        expect(panel()).toBe('channels');
        const { under, before } = await openPinsOverUnder();
        await click(document.querySelector('.server-icon.home-button'), "the rail's home button");
        expect(document.querySelector('.friends-dashboard')).toBeTruthy();
        expect(pins(), 'the pins closed, not drawn over the dashboard').toBeNull();
        expect(h.layers.length).toBe(before);
        await back();
        expect(under).toHaveBeenCalledTimes(1);
    });

    describe('a phone: the chat panel giving way to another closes the pins', () => {
        async function phoneInTheChat() {
            h.native = true;
            h.phoneWidth = true;
            await mountChat();
            await click(navButton('Chat'), "the bottom bar's Chat");
            expect(panel()).toBe('chat');
        }

        it('positive control: in the chat panel the pins open and Back closes them', async () => {
            await phoneInTheChat();
            const { under } = await openPinsOverUnder();
            await back();
            expect(pins()).toBeNull();
            expect(under).not.toHaveBeenCalled();
        });

        it("a tap on the bottom bar's Channels", async () => {
            await phoneInTheChat();
            const { under, before } = await openPinsOverUnder();
            await click(navButton('Channels'), "the bottom bar's Channels");
            expect(panel()).toBe('channels');
            expect(pins(), 'the pins closed').toBeNull();
            expect(h.layers.length).toBe(before);
            await back();
            expect(under).toHaveBeenCalledTimes(1);
        });

        it('a swipe to the members panel', async () => {
            await phoneInTheChat();
            const { under, before } = await openPinsOverUnder();
            await swipe(-200);
            expect(panel()).toBe('members');
            expect(pins(), 'the pins closed').toBeNull();
            expect(h.layers.length).toBe(before);
            await back();
            expect(under).toHaveBeenCalledTimes(1);
        });

        it("the bottom bar's Tasks (the dashboard in the chat panel's place)", async () => {
            await phoneInTheChat();
            const { before } = await openPinsOverUnder();
            await click(navButton('Tasks'), "the bottom bar's Tasks");
            expect(document.querySelector('.friends-dashboard')).toBeTruthy();
            expect(pins(), 'the pins closed').toBeNull();
            expect(h.layers.length).toBe(before);
        });
    });
});
