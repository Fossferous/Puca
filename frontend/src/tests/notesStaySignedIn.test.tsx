/**
 * Púca Notes' sign-in form: the "Stay signed in on this device" row.
 *
 * Three things, because each one has failed somewhere before in this codebase:
 * the box is ticked by DEFAULT (a session length nobody opts into is a session
 * length nobody gets); the choice is remembered on the DEVICE and survives a
 * sign-out (the remember-me blob was cleared by logout() and the box silently
 * re-armed itself); and the value actually reaches `login()` (a setting with
 * no wire is the "stored value with no control" failure in reverse).
 *
 * Positive control: the "unticked" case is asserted against a real click, and
 * `login` is a spy — a form that ignored the checkbox and always passed true
 * would fail it, and a form with no checkbox at all fails the first `expect`
 * in every test here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const STAY_KEY = 'pucaStaySignedIn';

const loginSpy = vi.hoisted(() => vi.fn(async () => 'tok'));
vi.mock('../api/auth', () => ({
    login: loginSpy,
    RetiredKeyFormatError: class RetiredKeyFormatError extends Error {},
    STAY_SIGNED_IN_KEY: STAY_KEY,
}));
vi.mock('../api/client', () => ({ isNetworkError: () => false }));
// A browser by default. NotesLogin reads isMobile() once, at import, so the
// phone-shell case below flips this and imports a FRESH copy of the module.
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('../api/platform', () => ({ isMobile: () => platform.mobile, isTauri: () => false }));

const { NotesLogin } = await import('../notes/components/NotesLogin');

// setup.ts replaces localStorage with bare vi.fn() stubs; this row is about
// what is STORED, so give them a real backing map for the duration.
let store: Map<string, string>;

let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

async function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<MemoryRouter><NotesLogin onSuccess={() => {}} /></MemoryRouter>);
    });
}
const box = () => container.querySelector<HTMLInputElement>('#stay-signed-in');

async function signIn() {
    const user = container.querySelector<HTMLInputElement>('#username')!;
    const pass = container.querySelector<HTMLInputElement>('#password')!;
    // React tracks the DOM value itself; set it through the native setter or
    // the change event is swallowed as a no-op and the form submits empty.
    const set = (el: HTMLInputElement, v: string) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => { set(user, 'ash'); set(pass, 'Password123!'); });
    await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
}

beforeEach(() => {
    store = new Map();
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { store.delete(k); });
    loginSpy.mockClear();
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

describe('NotesLogin: stay signed in on this device', () => {
    it('offers the row, CLEAR by default in a browser, with one line saying what it does', async () => {
        // A browser starts clear: the long session there is Púca's too, and
        // a browser is what gets shared. The phone app's default is the
        // opposite (below) — this is the control for that one.
        await mount();
        expect(box()).toBeTruthy();
        expect(box()!.checked).toBe(false);
        expect(container.textContent).toMatch(/Stay signed in on this device/);
        // What the server does: a year at most, and only while the device
        // keeps coming back — a 30-day token, renewed on use. The first copy
        // promised "a year without a check-in", which a month in a drawer
        // disproves.
        expect(container.textContent).toMatch(/for up to a year instead of a day, as long as it is used at least once a month\./);
        expect(container.textContent).not.toMatch(/without a check-in/);
        // ...and a screen reader hears that line with the box, not somewhere
        // after it: the input names the hint as its description.
        const hint = document.getElementById(box()!.getAttribute('aria-describedby') ?? '');
        expect(hint?.textContent).toMatch(/Sign out to end it early\./);
    });

    it('in a browser, says the long session is Púca\'s too', async () => {
        // One origin, one token: a Notes sign-in in a browser signs Púca in
        // there as well, for exactly as long. The line must not hide that.
        await mount();
        expect(document.getElementById('stay-signed-in-hint')?.textContent)
            .toMatch(/^This browser then stays signed in to Notes and to Púca /);
    });

    it('in the phone app, speaks of the device and does not mention Púca', async () => {
        // The Notes APK runs at its own origin: nothing is shared with the
        // Púca app, so naming it there would be wrong. A fresh import, since
        // the component decides at import time.
        platform.mobile = true;
        vi.resetModules();
        try {
            const { NotesLogin: PhoneLogin } = await import('../notes/components/NotesLogin');
            container = document.createElement('div');
            document.body.appendChild(container);
            root = createRoot(container);
            await act(async () => {
                root.render(<MemoryRouter><PhoneLogin onSuccess={() => {}} /></MemoryRouter>);
            });
            const hint = document.getElementById('stay-signed-in-hint')?.textContent ?? '';
            expect(hint).toMatch(/^This device then stays signed in for up to a year instead of a day, as long as Notes is used at least once a month\./);
            expect(hint).not.toMatch(/Púca/);
            // ...and on the phone the box starts TICKED: a phone is one
            // person's, and the owner's complaint was being asked to sign
            // in again after the phone had been off.
            expect(container.querySelector<HTMLInputElement>('#stay-signed-in')!.checked).toBe(true);
        } finally {
            platform.mobile = false;
        }
    });

    it('an untouched browser box reaches login() as false', async () => {
        await mount();
        await signIn();
        expect(loginSpy).toHaveBeenCalledWith('ash', 'Password123!', { staySignedIn: false });
    });

    it('ticking it is remembered on the device and reaches login() as true', async () => {
        await mount();
        await act(async () => { box()!.click(); });
        expect(box()!.checked).toBe(true);
        expect(store.get(STAY_KEY)).toBe('true');
        await signIn();
        expect(loginSpy).toHaveBeenCalledWith('ash', 'Password123!', { staySignedIn: true });
    });

    it('unticking it is remembered on the device and reaches login() as false', async () => {
        store.set(STAY_KEY, 'true');
        await mount();
        expect(box()!.checked).toBe(true);
        await act(async () => { box()!.click(); });
        expect(box()!.checked).toBe(false);
        expect(store.get(STAY_KEY)).toBe('false');
        await signIn();
        expect(loginSpy).toHaveBeenCalledWith('ash', 'Password123!', { staySignedIn: false });
    });

    it('a device that said no last time opens with the box clear', async () => {
        // Persisted BEFORE the mount: this is the next visit, not the same one.
        store.set(STAY_KEY, 'false');
        await mount();
        expect(box()!.checked).toBe(false);
    });

    it('a browser that said yes last time opens with the box ticked', async () => {
        // The stored answer beats the browser default — the control for the
        // "clear by default" test above.
        store.set(STAY_KEY, 'true');
        await mount();
        expect(box()!.checked).toBe(true);
    });

    it('a stored value that is neither answer falls back to the default', async () => {
        store.set(STAY_KEY, 'yes');
        await mount();
        expect(box()!.checked).toBe(false);
    });

    async function mountExpired() {
        // The message only appears when the router carried `expired`.
        await act(async () => {
            container = document.createElement('div');
            document.body.appendChild(container);
            root = createRoot(container);
            root.render(
                <MemoryRouter initialEntries={[{ pathname: '/', state: { expired: true } }]}>
                    <NotesLogin onSuccess={() => {}} />
                </MemoryRouter>,
            );
        });
    }
    const expiredMessage = () => container.querySelector('.login-message')?.textContent ?? '';

    it('tells an expired session with the box clear how to stop it happening again', async () => {
        store.set(STAY_KEY, 'false');
        await mountExpired();
        expect(expiredMessage()).toMatch(/^Your session expired\./);
        expect(expiredMessage()).toMatch(/Tick Stay signed in to avoid this\./);
    });

    it('does not tell a device that already ticked the box to tick it', async () => {
        // Exactly the case of a long session that went a month unused or
        // reached its year: the advice is already taken.
        store.set(STAY_KEY, 'true');
        await mountExpired();
        expect(box()!.checked).toBe(true);
        expect(expiredMessage()).toMatch(/^Your session expired\. Sign in again to continue/);
        expect(expiredMessage()).not.toMatch(/Tick Stay signed in/);
        // ...and it follows the box: clearing it brings the tip back.
        await act(async () => { box()!.click(); });
        expect(expiredMessage()).toMatch(/Tick Stay signed in to avoid this\./);
    });
});
