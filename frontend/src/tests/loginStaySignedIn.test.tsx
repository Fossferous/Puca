/**
 * Púca's own sign-in form: the "Stay signed in on this device" row.
 *
 * Reported 2026-10-15: a friend "has had to sign in 2 days in a row". The
 * main form always asked the server for the ordinary 24-hour session, which
 * renews only on use, so not opening Púca for a day meant the password again.
 * The long session (30 days, renewed on use for up to a year) was reachable
 * only from Púca Notes' form.
 *
 * Pinned here: the box is TICKED by default in the desktop and Android apps
 * and CLEAR in a browser; a stored answer wins over the default (and is
 * shared with Púca Notes - the same key); the choice is stored the moment it
 * is made; and the value reaches `login()` on sign-in AND on the automatic
 * sign-in after creating an account.
 *
 * Positive control: the unticked case is driven by a real click, and `login`
 * is a spy - a form that ignored the box and always passed true fails it, and
 * a form with no box fails the first expect of every test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const STAY_KEY = 'pucaStaySignedIn';

const loginSpy = vi.hoisted(() => vi.fn(async () => 'tok'));
const registerSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../api/auth', () => ({
    login: loginSpy, register: registerSpy, resetPasswordMigration: vi.fn(),
    REMEMBER_ME_KEY: 'sovereign_remember', STAY_SIGNED_IN_KEY: STAY_KEY,
}));
vi.mock('../api/publicConfig', () => ({
    fetchPublicConfig: vi.fn(async () => ({ invite_required: false })),
    getPublicConfig: vi.fn(async () => ({ invite_required: false })),
}));
vi.mock('../api/websocket', () => ({ wsClient: { connect: vi.fn(async () => undefined) } }));
// Login reads the platform once, at import: each case imports a fresh copy.
const platform = vi.hoisted(() => ({ tauri: false, mobile: false }));
vi.mock('../api/platform', () => ({ isTauri: () => platform.tauri, isMobile: () => platform.mobile }));

let store: Map<string, string>;
let container: HTMLDivElement;
let root: Root | null = null;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

async function mount() {
    vi.resetModules();
    const { Login } = await import('../components/Login');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(<MemoryRouter><Login onLoginSuccess={() => {}} /></MemoryRouter>);
    });
    await settle();
}
const box = () => container.querySelector<HTMLInputElement>('#stay-signed-in');
const set = (el: HTMLInputElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
async function submit() {
    await act(async () => {
        set(container.querySelector<HTMLInputElement>('#username')!, 'ash');
        set(container.querySelector<HTMLInputElement>('#password')!, 'Password123!');
    });
    await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
}
const lastOpts = () => (loginSpy.mock.calls.at(-1) as unknown[] | undefined)?.[2];

beforeEach(() => {
    store = new Map();
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    loginSpy.mockClear();
    registerSpy.mockClear();
    platform.tauri = false;
    platform.mobile = false;
});
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container?.remove();
});

describe('Púca sign-in: Stay signed in on this device', () => {
    it('is ticked by default in the desktop app, and the long session is asked for', async () => {
        platform.tauri = true;
        await mount();
        expect(box()?.checked).toBe(true);
        await submit();
        expect(lastOpts()).toEqual({ staySignedIn: true });
    });

    it('is ticked by default in the Android app', async () => {
        platform.mobile = true;
        await mount();
        expect(box()?.checked).toBe(true);
    });

    it('is ticked by default in an iPhone Home Screen app, but not in a Safari tab', async () => {
        // The download page and the User Guide say "sign in once" there; an
        // installed app is one person's, like the Android app.
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
        try {
            await mount();
            expect(box()?.checked).toBe(true);
            await submit();
            expect(lastOpts()).toEqual({ staySignedIn: true });
            await act(async () => root!.unmount());
            root = null;
            container.remove();
            Object.defineProperty(navigator, 'standalone', { value: false, configurable: true }); // a Safari tab
            await mount();
            expect(box()?.checked).toBe(false);
        } finally {
            delete (navigator as unknown as Record<string, unknown>).standalone;
        }
    });

    it('is clear by default in a browser, and the ordinary session is asked for', async () => {
        await mount();
        expect(box()?.checked).toBe(false);
        await submit();
        expect(lastOpts()).toEqual({ staySignedIn: false });
    });

    it("unticking it is stored at once and reaches login() (control: a form that always sent true fails)", async () => {
        platform.tauri = true;
        await mount();
        await act(async () => { box()!.click(); });
        expect(box()!.checked).toBe(false);
        expect(store.get(STAY_KEY)).toBe('false');
        await submit();
        expect(lastOpts()).toEqual({ staySignedIn: false });
    });

    it("a stored answer wins over the platform's default (the one Púca Notes stores too)", async () => {
        store.set(STAY_KEY, 'true');
        await mount(); // a browser, whose default is clear
        expect(box()?.checked).toBe(true);
    });

    it('the sign-in right after creating an account asks for it too', async () => {
        platform.tauri = true;
        await mount();
        const toggle = [...container.querySelectorAll('button')].find(b => /register|create|sign up/i.test(b.textContent ?? ''));
        expect(toggle, 'the form offers account creation').toBeTruthy();
        await act(async () => { toggle!.click(); });
        await submit();
        expect(registerSpy).toHaveBeenCalled();
        expect(lastOpts()).toEqual({ staySignedIn: true });
    });
});
