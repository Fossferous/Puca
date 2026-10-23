/**
 * Signing in from an embedding host's own panel (Púca for Steam Deck):
 * `pucaEmbed.signIn` runs the sign-in form's own path, while the form is on
 * screen (docs/EMBEDDING.md, signIn).
 *
 * Pinned here: the SAME code as the form (login() with the stay choice, the
 * socket, the success hand-off); the answers a host can act on (invalid,
 * reset-required with the form switched to the security update, unavailable
 * once the form is gone, busy for a second try at once); arguments checked
 * before anything runs; "Stay signed in" ticked by default on an embedded
 * page, as in the desktop and phone apps; and the feature advertised in the
 * state, so an older page is told apart.
 *
 * Positive control: `login` is a spy and the success callback is counted, so
 * a signIn that answered ok without signing in fails the first test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { PucaEmbedApi } from '../api/embedApi';

const STAY_KEY = 'pucaStaySignedIn';

const loginSpy = vi.hoisted(() => vi.fn(async (_u: string, _p: string, _o?: unknown) => 'tok'));
vi.mock('../api/auth', () => ({
    login: loginSpy, register: vi.fn(async () => undefined), resetPasswordMigration: vi.fn(),
    REMEMBER_ME_KEY: 'sovereign_remember', STAY_SIGNED_IN_KEY: STAY_KEY,
}));
vi.mock('../api/publicConfig', () => ({
    fetchPublicConfig: vi.fn(async () => ({ invite_required: false })),
    getPublicConfig: vi.fn(async () => ({ invite_required: false })),
}));
const connectSpy = vi.hoisted(() => vi.fn(async (_t: string) => undefined));
vi.mock('../api/websocket', () => ({ wsClient: { connect: connectSpy } }));
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()), isTauri: () => false, isMobile: () => false,
}));

type Win = Window & { __PUCA_EMBED_HOST__?: unknown };
let store: Map<string, string>;
let container: HTMLDivElement;
let root: Root | null = null;
let api: PucaEmbedApi;
let getState: () => { features: string[] };
let embed: typeof import('../api/embedApi');
const success = vi.fn();
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

async function mount(withHost = true) {
    vi.resetModules();
    if (withHost) (window as Win).__PUCA_EMBED_HOST__ = { apiVersion: 1, name: 'Test host' };
    const { Login } = await import('../components/Login');
    embed = await import('../api/embedApi');
    api = embed.createEmbedApi();
    getState = embed.getEmbedState;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(<MemoryRouter><Login onLoginSuccess={success} /></MemoryRouter>);
    });
    await settle();
}
const unmount = async () => {
    await act(async () => { root?.unmount(); });
    root = null;
};

beforeEach(() => {
    store = new Map();
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    loginSpy.mockReset();
    loginSpy.mockImplementation(async () => 'tok');
    connectSpy.mockClear();
    success.mockClear();
});
afterEach(async () => {
    await unmount();
    container?.remove();
    delete (window as Win).__PUCA_EMBED_HOST__;
});

describe('pucaEmbed.signIn', () => {
    it("signs in through the form's own path: login(), the socket, the success hand-off", async () => {
        await mount();
        expect(await api.signIn('  ash  ', 'Password123!', true)).toEqual({ ok: true });
        expect(loginSpy).toHaveBeenCalledWith('ash', 'Password123!', { staySignedIn: true });
        expect(connectSpy).toHaveBeenCalledWith('tok');
        expect(success).toHaveBeenCalledTimes(1);
        expect(store.get(STAY_KEY)).toBe('true');
    });

    it('passes "stay signed in" through, and remembers the answer like the box does', async () => {
        await mount();
        await api.signIn('ash', 'Password123!', false);
        expect(loginSpy.mock.calls.at(-1)?.[2]).toEqual({ staySignedIn: false });
        expect(store.get(STAY_KEY)).toBe('false');
    });

    it('"Stay signed in" starts ticked on an embedded page, as in the apps', async () => {
        await mount();
        expect(container.querySelector<HTMLInputElement>('#stay-signed-in')!.checked).toBe(true);
    });

    it('a wrong password is "invalid", and nothing else happens', async () => {
        await mount();
        loginSpy.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 401 }));
        expect(await api.signIn('ash', 'wrong', true)).toEqual({ ok: false, error: 'invalid' });
        expect(connectSpy).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();
    });

    it('an account that needs the security update says so, and the form shows it', async () => {
        await mount();
        loginSpy.mockRejectedValueOnce(Object.assign(new Error('reset'), { status: 403 }));
        expect(await api.signIn('ash', 'old', true)).toEqual({ ok: false, error: 'reset-required' });
        await settle();
        // The reset screen itself, not only its message: it is where the
        // person finishes the update, with the username already in.
        expect(container.querySelector('input[placeholder="Enter new password (min 8 chars)"]')).not.toBeNull();
        expect(success).not.toHaveBeenCalled();
    });

    it('one at a time: a second try while the first runs is "busy"', async () => {
        await mount();
        let release!: (t: string) => void;
        loginSpy.mockImplementationOnce(() => new Promise<string>(r => { release = r; }));
        const first = api.signIn('ash', 'Password123!', true);
        expect(await api.signIn('ash', 'Password123!', true)).toEqual({ ok: false, error: 'busy' });
        release('tok');
        expect(await first).toEqual({ ok: true });
    });

    it('checks its arguments before anything runs', async () => {
        await mount();
        for (const [u, p] of [['', 'x'], ['   ', 'x'], ['ash', ''], [1, 2], ['a'.repeat(1025), 'x'], ['ash', 'p'.repeat(1025)]] as const) {
            expect(await api.signIn(u as string, p as string, true), JSON.stringify([u, p])).toEqual({ ok: false, error: 'missing' });
        }
        expect(loginSpy).not.toHaveBeenCalled();
    });

    it('with no sign-in form on screen it is "unavailable"', async () => {
        await mount();
        await unmount();
        expect(await api.signIn('ash', 'Password123!', true)).toEqual({ ok: false, error: 'unavailable' });
        expect(loginSpy).not.toHaveBeenCalled();
    });

    it('a page that is already signed in does not sign in again', async () => {
        await mount();
        embed.registerEmbedSession({
            user: () => ({ id: 1, username: 'ash' }), servers: () => [], currentServerId: () => null,
            voiceChannel: () => null, listVoiceChannels: async () => [], joinVoice: async () => ({ ok: true }),
        });
        expect(await api.signIn('ash', 'Password123!', true)).toEqual({ ok: false, error: 'signed-in' });
        expect(loginSpy).not.toHaveBeenCalled();
    });

    it('is advertised in the state, so a host can tell an older page apart', async () => {
        await mount();
        expect(getState().features).toEqual(expect.arrayContaining(['signIn', 'downloadSite']));
    });

    it('CONTROL: without a host the form registers nothing', async () => {
        await mount(false);
        expect(await api.signIn('ash', 'Password123!', true)).toEqual({ ok: false, error: 'unavailable' });
        expect(loginSpy).not.toHaveBeenCalled();
    });
});
