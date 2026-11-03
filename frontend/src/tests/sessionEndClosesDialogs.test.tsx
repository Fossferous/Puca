/**
 * A session that ends some way other than logout() takes its questions and notices with
 * it, as logout() does. <AppDialogs/> sits beside the app (main.tsx, notes/main.tsx), so
 * nothing else clears it, a sign-in reloads nothing, and a notice can hold the words of a
 * message that did not go. Through the real App and the real Notes session gate, with
 * what they draw reduced to a name.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mountAppDialogs } from './appDialogsHost';
import { askConfirm, closeAppDialogs, leaveNotice } from '../api/appDialogs';
import { wsClient } from '../api/websocket';

vi.mock('../components/Chat', () => ({ Chat: () => <div>the chat</div> }));
vi.mock('../components/Login', () => ({ Login: () => <div>the login form</div> }));
vi.mock('../notes/components/NotesShell', () => ({ NotesShell: () => <div>the notes</div> }));
vi.mock('../notes/components/NotesLogin', () => ({ NotesLogin: () => <div>the login form</div> }));
vi.mock('../components/RcGlobals', () => ({ RcGlobals: () => null }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));

const { default: App } = await import('../App');
const { NotesApp } = await import('../notes/NotesApp');

const SEED_KEY = 'e2ee_seed_v2';
const WORDS = 'Message failed to send.\n\nWhat you wrote in #general:\nthe words';
const token = (sub: number) => `h.${btoa(JSON.stringify({ sub, username: 'me', exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;

let store: Record<string, string>;
let dialogs: ReturnType<typeof mountAppDialogs>;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    store = { auth_token: token(7) };
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    vi.spyOn(wsClient, 'connect').mockImplementation(async () => {});
    window.location.hash = '';
    dialogs = mountAppDialogs();
});
afterEach(() => {
    act(() => closeAppDialogs());
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    dialogs.unmount();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });

async function mount(tree: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(tree); });
    await settle();
}
const mountPuca = () => mount(<MemoryRouter initialEntries={['/chat']}><App /></MemoryRouter>);
const mountNotes = () => mount(<QueryClientProvider client={new QueryClient()}><NotesApp /></QueryClientProvider>);

/** A notice with someone's words in it, and a question, on the desktop, from this session.
 *  The answer in an object: an async function that returns a promise waits for it. */
async function leftOnTheScreen() {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    act(() => leaveNotice(WORDS));
    let answer!: Promise<boolean>;
    await act(async () => { answer = askConfirm('Kick Bob?'); });
    expect(dialogs.notices()).toEqual([WORDS]);
    expect(document.querySelector('dialog.app-question')).not.toBeNull();
    return { answer };
}

async function expectAllGone(answer: Promise<boolean>) {
    await settle();
    expect(document.body.textContent, 'the session did end').toContain('the login form');
    expect(dialogs.notices()).toEqual([]);
    expect(document.querySelector('dialog.app-question'), 'it would stay modal over the login form').toBeNull();
    await expect(answer, 'nothing asked of it may be answered yes later').resolves.toBe(false);
}

/** Another document on this origin changing the token, as `storage` tells this one. */
async function tokenChangedElsewhere(next: string | null) {
    if (next === null) delete store.auth_token; else store.auth_token = next;
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: next })); });
}

describe.each([
    { app: 'Púca', mountApp: mountPuca },
    { app: 'Púca Notes', mountApp: mountNotes },
])('in $app', ({ mountApp }) => {
    it('a token that lapsed takes them with it', async () => {
        await mountApp();
        const { answer } = await leftOnTheScreen();
        await act(async () => { window.dispatchEvent(new Event('auth-expired')); });
        await expectAllGone(answer);
    });

    it('so does a sign-out in another tab', async () => {
        await mountApp();
        const { answer } = await leftOnTheScreen();
        await tokenChangedElsewhere(null);
        await expectAllGone(answer);
    });

    it('so does a soft expiry in another tab, which keeps the keys', async () => {
        store[SEED_KEY] = 'kept';
        await mountApp();
        const { answer } = await leftOnTheScreen();
        await tokenChangedElsewhere(null);
        await expectAllGone(answer);
    });

    it('CONTROL: a renewed token is the same session, and they stay', async () => {
        await mountApp();
        const { answer } = await leftOnTheScreen();
        await tokenChangedElsewhere(token(7));
        await settle();
        expect(dialogs.notices()).toEqual([WORDS]);
        expect(document.querySelector('dialog.app-question')).not.toBeNull();
        act(() => closeAppDialogs());
        await answer;
    });

    it('CONTROL: what is said after it ended is still said', async () => {
        await mountApp();
        await act(async () => { window.dispatchEvent(new Event('auth-expired')); });
        await settle();
        act(() => leaveNotice('Your session has ended.'));
        expect(dialogs.notices()).toEqual(['Your session has ended.']);
    });
});
