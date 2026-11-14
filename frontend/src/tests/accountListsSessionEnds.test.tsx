/**
 * The lists a running app read as one account (the query cache and the voice roster, App.tsx
 * forgetAccountLists) are forgotten at the ends of a session that do not run logout(): a sign-out
 * in another tab, and a sign-in as somebody else after a soft expiry, here or in another tab. logout()'s own path is
 * signOutClearsSharedLists.test.ts. A sign-in reloads nothing, so before this the next account in
 * that tab was drawn the last one's servers, channel lists and calls (review of client-small).
 * Through the real App, with what it draws reduced to a name, as sessionEndClosesDialogs.test.tsx.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { wsClient } from '../api/websocket';
import { queryClient } from '../api/queryClient';
import { globalVoiceUsers, type VoiceUserStatus } from '../components/voiceState';

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

const SEED_KEY = 'e2ee_seed_v2';
const token = (sub: number) => `h.${btoa(JSON.stringify({ sub, username: 'me', exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;

let store: Record<string, string>;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
    store = { auth_token: token(7) };
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    vi.spyOn(wsClient, 'connect').mockImplementation(async () => {});
    h.onLoginSuccess = null;
    queryClient.clear();
    globalVoiceUsers.clear();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.restoreAllMocks();
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 10)); });
async function mountApp() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<MemoryRouter initialEntries={['/chat']}><App /></MemoryRouter>); });
    await settle();
    expect(document.body.textContent).toContain('the chat');
}
/** What account 7 read: its servers, and a call in a server that is not open. */
function seventhAccountsLists() {
    queryClient.setQueryData(['servers'], [{ id: 's7', name: 'Sevens' }]);
    globalVoiceUsers.set('voice_70', new Map([[71, { id: 71, username: 'dee' } as VoiceUserStatus]]));
}
const listsKept = () => queryClient.getQueryData(['servers']) !== undefined && globalVoiceUsers.size > 0;
const listsGone = () => queryClient.getQueryCache().getAll().length === 0 && globalVoiceUsers.size === 0;

async function tokenChangedElsewhere(next: string | null) {
    if (next === null) delete store.auth_token; else store.auth_token = next;
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: next })); });
    await settle();
}
async function signInHereAs(sub: number) {
    store.auth_token = token(sub);
    expect(h.onLoginSuccess, 'the login form is up').toBeTruthy();
    await act(async () => { h.onLoginSuccess!(); });
    await settle();
}

describe("the lists read as one account", () => {
    it('a sign-out in another tab forgets them', async () => {
        await mountApp();
        seventhAccountsLists();
        await tokenChangedElsewhere(null);
        expect(document.body.textContent).toContain('the login form');
        expect(listsGone()).toBe(true);
    });

    it('a soft expiry keeps them, and a sign-in here as somebody else forgets them', async () => {
        store[SEED_KEY] = 'kept';
        await mountApp();
        seventhAccountsLists();
        await tokenChangedElsewhere(null);
        expect(document.body.textContent).toContain('the login form');
        expect(listsKept(), 'kept for the same account signing back in').toBe(true);
        await signInHereAs(8);
        expect(listsGone()).toBe(true);
    });

    it('a soft expiry, then somebody else signing in in ANOTHER tab, forgets them here too', async () => {
        store[SEED_KEY] = 'kept';
        await mountApp();
        seventhAccountsLists();
        await tokenChangedElsewhere(null);
        expect(listsKept(), 'kept for the same account signing back in').toBe(true);
        await tokenChangedElsewhere(token(8));
        expect(listsGone()).toBe(true);
    });

    it('CONTROL: the same account signing back in in another tab after a soft expiry keeps them', async () => {
        store[SEED_KEY] = 'kept';
        await mountApp();
        seventhAccountsLists();
        await tokenChangedElsewhere(null);
        await tokenChangedElsewhere(token(7));
        expect(listsKept()).toBe(true);
    });

    it('CONTROL: the same account signing back in after a soft expiry keeps them', async () => {
        store[SEED_KEY] = 'kept';
        await mountApp();
        seventhAccountsLists();
        await tokenChangedElsewhere(null);
        await signInHereAs(7);
        expect(document.body.textContent).toContain('the chat');
        expect(listsKept()).toBe(true);
    });
});
