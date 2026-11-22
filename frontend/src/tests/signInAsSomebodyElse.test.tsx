/**
 * What a sign-in as somebody else is shown of the account before it, through
 * the real App and its real sign-in path (review of fix-signout-left; the
 * harness is accountListsSessionEnds.test.tsx's, with what App draws reduced
 * to a name, and the real RecoveryCodeModal left in the authed layout).
 *
 *  - Notifications: an account whose session ran out, or whose app closed,
 *    with nobody signing out leaves its notifications where the OS keeps them
 *    (here, what the web app's push worker showed). Chat's unmount, the only
 *    thing that took any away, never ran: the app next started on its sign-in
 *    form, so Chat had not opened. Whoever signed in next found "alice sent
 *    you a message" in the list, and a click opened the last account's DM.
 *  - The recovery code: register() stashes the new account's code for the
 *    sign-in that follows. When that sign-in failed, the form stayed on
 *    screen with the code waiting, and the next person to sign in there, as
 *    anybody, was shown it: the code that unlocks the first account's keys.
 *    Kept from them, the code still left them the device-wide marker that
 *    some code was never saved: the next person was told THEIR code was never
 *    saved, and their "I already saved it" took the first account's only
 *    warning away.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { wsClient } from '../api/websocket';
import {
    consumePendingRecoveryCode, markRecoveryCodeUnacknowledged, recoveryCodeReminderDue, setPendingRecoveryCode,
} from '../api/recoveryPrompt';

const h = vi.hoisted(() => ({ onLoginSuccess: null as null | (() => void) }));
vi.mock('../components/Chat', () => ({ Chat: () => <div>the chat</div> }));
vi.mock('../components/Login', () => ({
    Login: ({ onLoginSuccess }: { onLoginSuccess: () => void }) => { h.onLoginSuccess = onLoginSuccess; return <div>the login form</div>; },
}));
vi.mock('../components/RcGlobals', () => ({ RcGlobals: () => null }));

Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));

const { default: App } = await import('../App');

const token = (sub: number, username: string) =>
    `h.${btoa(JSON.stringify({ sub, username, exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;
const ALICE = { sub: 7, name: 'Alice' };
const BOB = { sub: 8, name: 'bob' };
const ALICES_CODE = 'harbor velvet ostrich granite lunar maple ember quartz nimble tundra cobalt saffron';

let store: Record<string, string>;
let root: Root | null = null;
let host: HTMLElement | null = null;

/** What the push worker has up (public/sw.js shows them; a page can list and close them). */
let workerShown: { title: string; closed: boolean; close(): void }[] = [];
const workerOpen = () => workerShown.filter(n => !n.closed).map(n => n.title);

beforeEach(() => {
    store = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    vi.spyOn(wsClient, 'connect').mockImplementation(async () => {});
    h.onLoginSuccess = null;
    workerShown = [];
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistration: async (scope?: string) => (scope === '/' ? { getNotifications: async () => [...workerShown] } : undefined) },
    });
});
afterEach(() => {
    // A code left waiting for its account is the module's, and outlives a test.
    consumePendingRecoveryCode(ALICE.name);
    consumePendingRecoveryCode(BOB.name);
    sessionStorage.clear();
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.restoreAllMocks();
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

const settle = (ms = 10) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
async function startApp(at: '/chat' | '/login') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<MemoryRouter initialEntries={[at]}><App /></MemoryRouter>); });
    await settle();
}
/** The app closes: no sign-out, and nothing of the page survives but storage. */
async function appCloses() {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
}
async function signInHereAs(who: { sub: number; name: string }) {
    store.auth_token = token(who.sub, who.name);
    expect(h.onLoginSuccess, 'the login form is up').toBeTruthy();
    await act(async () => { h.onLoginSuccess!(); });
    await settle();
    expect(document.body.textContent).toContain('the chat');
}

/** Alice's run: signed in, a push shows one of her DMs, then her session runs
 *  out and the app is closed before anyone signs out. */
async function alicesRunEndsWithoutASignOut() {
    store.auth_token = token(ALICE.sub, ALICE.name);
    await startApp('/chat');
    expect(document.body.textContent).toContain('the chat');
    workerShown.push({ title: 'dee sent you a message', closed: false, close() { this.closed = true; } });
    await appCloses();
    delete store.auth_token;
}

describe('a sign-in as somebody else, before Chat has opened', () => {
    it('is not left the last account\'s notifications', async () => {
        await alicesRunEndsWithoutASignOut();
        await startApp('/login');
        expect(document.body.textContent).toContain('the login form');
        expect(workerOpen(), 'positive control: left in the list').toEqual(['dee sent you a message']);
        await signInHereAs(BOB);
        expect(workerOpen()).toEqual([]);
    });

    it('CONTROL: the same account signing back in keeps its own', async () => {
        await alicesRunEndsWithoutASignOut();
        await startApp('/login');
        await signInHereAs(ALICE);
        expect(workerOpen()).toEqual(['dee sent you a message']);
    });

    it('is not shown the recovery code of an account whose sign-in after registering failed', async () => {
        await startApp('/login');
        // What register('Alice', …) leaves for the sign-in that follows it, which failed.
        setPendingRecoveryCode(ALICES_CODE, ALICE.name);
        await signInHereAs(BOB);
        // The modal asks on mount and then once a second.
        await settle(1_200);
        expect(document.body.textContent).not.toContain('harbor');
        expect(document.body.textContent).not.toContain('Save your recovery code');
    });

    it('is not told that the recovery code of an account whose sign-in after registering failed was never saved', async () => {
        await startApp('/login');
        // What register('Alice', …) leaves for the sign-in that follows it, which failed:
        // her code, and the marker that she has not confirmed saving it.
        setPendingRecoveryCode(ALICES_CODE, ALICE.name);
        markRecoveryCodeUnacknowledged(ALICE.name);
        await signInHereAs(BOB);
        // The modal decides the reminder is owed 3 s after it mounts.
        await settle(3_300);
        expect(document.body.textContent).not.toContain('never saved');
        expect(document.body.textContent).not.toContain('harbor');
        expect(recoveryCodeReminderDue(ALICE.name), 'hers is kept for her own sign-in').toBe(true);
    });

    it('CONTROL: the account whose code was never saved is told so', async () => {
        markRecoveryCodeUnacknowledged(ALICE.name);
        await startApp('/login');
        await signInHereAs(ALICE);
        await settle(3_300);
        expect(document.body.textContent).toContain('Your recovery code was never saved');
    });

    it("an account's \"I already saved it\" answers for that account only", async () => {
        markRecoveryCodeUnacknowledged(ALICE.name);
        markRecoveryCodeUnacknowledged(BOB.name);
        await startApp('/login');
        await signInHereAs(ALICE);
        await settle(3_300);
        const saved = [...document.querySelectorAll('button')].find(b => b.textContent === 'I already saved it');
        expect(saved, 'the reminder is up').toBeTruthy();
        await act(async () => { saved!.click(); });
        expect(document.body.textContent).not.toContain('never saved');
        expect(recoveryCodeReminderDue(ALICE.name)).toBe(false);
        expect(recoveryCodeReminderDue(BOB.name), 'his warning is still his').toBe(true);
    });

    it('CONTROL: the account it was made for is shown it, whatever the case of its name', async () => {
        await startApp('/login');
        setPendingRecoveryCode(ALICES_CODE, 'alice');
        await signInHereAs(ALICE);
        await settle(50);
        expect(document.body.textContent).toContain('Save your recovery code');
        expect(document.body.textContent).toContain('harbor');
        expect(document.body.textContent).toContain('saffron');
    });
});
