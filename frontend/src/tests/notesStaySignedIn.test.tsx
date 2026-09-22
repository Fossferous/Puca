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
vi.mock('../api/platform', () => ({ isMobile: () => false, isTauri: () => false }));

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
    it('offers the row, ticked, with one line saying what it does', async () => {
        await mount();
        expect(box()).toBeTruthy();
        expect(box()!.checked).toBe(true);
        expect(container.textContent).toMatch(/Stay signed in on this device/);
        expect(container.textContent).toMatch(/lasts up to a year without a check-in, instead of a day/);
    });

    it('passes the tick to login()', async () => {
        await mount();
        await signIn();
        expect(loginSpy).toHaveBeenCalledWith('ash', 'Password123!', { staySignedIn: true });
    });

    it('unticking it is remembered on the device and reaches login() as false', async () => {
        await mount();
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

    it('anything other than a stored "false" means ticked', async () => {
        // A never-answered device, and a stored 'true', must both come up
        // ticked — the default is not "whatever is in storage".
        store.set(STAY_KEY, 'true');
        await mount();
        expect(box()!.checked).toBe(true);
    });

    it('tells an expired session how to stop it happening again', async () => {
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
        expect(container.querySelector('.login-message')?.textContent).toMatch(/Tick Stay signed in to avoid this\./);
    });
});
