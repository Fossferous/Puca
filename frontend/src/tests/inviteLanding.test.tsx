/**
 * `/invite/:code` (components/InviteLanding.tsx): the route that did not exist.
 *
 * Until 0.9.2 App's `*` route sent an invite link to `/`, discarding the code.
 * Now the code is stashed and the visitor is routed to sign in (signed out)
 * or to /chat (signed in), where Chat opens the join flow with it.
 *
 * In a desktop browser on Windows the page first OFFERS the Púca desktop app
 * (a `puca://` link the installer registers) beside that browser flow, with
 * an optional remembered choice — and nowhere else: not inside the desktop
 * app, not on a phone or in the Android apps, not on macOS or Linux, where
 * nothing registers the scheme.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const authed = vi.hoisted(() => ({ value: false }));
const shell = vi.hoisted(() => ({ tauri: false, mobile: false }));
vi.mock('../api/auth', () => ({ isAuthenticated: () => authed.value }));
vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => shell.tauri,
    isMobile: () => shell.mobile,
}));

const { InviteLanding } = await import('../components/InviteLanding');
const { peekPendingInvite } = await import('../api/pendingInvite');
const { appLauncher, __resetDeepLinksForTest } = await import('../api/deepLink');

const UA = {
    windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};
const REMEMBER_KEY = 'puca_invite_open_in_app_v1';

function Probe() {
    const loc = useLocation();
    return <div data-testid="where">{loc.pathname}</div>;
}

let container: HTMLDivElement;
let root: Root;

async function mountAt(path: string, { strict = false } = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const tree = (
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route path="/invite/:code" element={<InviteLanding />} />
                <Route path="*" element={<Probe />} />
            </Routes>
        </MemoryRouter>
    );
    await act(async () => { root.render(strict ? <StrictMode>{tree}</StrictMode> : tree); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return container.querySelector('[data-testid="where"]')?.textContent;
}
const openLink = () => container.querySelector<HTMLAnchorElement>('a.invite-landing-open');
const browserButton = () => [...container.querySelectorAll('button')].find(b => b.textContent === 'Continue in the browser');
const rememberBox = () => container.querySelector<HTMLInputElement>('.invite-landing-remember input[type="checkbox"]');
const help = () => container.querySelector('.invite-landing-help');

let uaSpy: { mockReturnValue: (v: string) => unknown };
let launched: string[];
/** A click on the app link must never reach jsdom's navigation (and nothing
 *  may try to launch anything): stop the default, keep React's handler. */
const noNavigation = (e: Event) => {
    if ((e.target as Element | null)?.closest?.('a[href^="puca:"]')) e.preventDefault();
};

// The global test setup replaces localStorage with bare vi.fn() stubs; the
// remembered choice needs a real backing store.
const stored = new Map<string, string>();
function realLocalStorage() {
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => stored.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { stored.set(k, String(v)); });
    vi.mocked(localStorage.removeItem).mockImplementation((k: string) => { stored.delete(k); });
    vi.mocked(localStorage.clear).mockImplementation(() => stored.clear());
}

beforeEach(() => {
    realLocalStorage();
    sessionStorage.clear();
    localStorage.clear();
    authed.value = false;
    shell.tauri = false;
    shell.mobile = false;
    __resetDeepLinksForTest();
    uaSpy = vi.spyOn(window.navigator, 'userAgent', 'get');
    uaSpy.mockReturnValue(UA.linux);
    launched = [];
    vi.spyOn(appLauncher, 'open').mockImplementation((url: string) => { launched.push(url); });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/app-version')
        ? new Response(JSON.stringify({ version: '9.9.9', download_url: 'https://download.example.com/' }), { status: 200 })
        : new Response('nope', { status: 404 }))));
    document.addEventListener('click', noNavigation, true);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.removeEventListener('click', noNavigation, true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as { userAgentData?: unknown }).userAgentData;
});

describe('InviteLanding', () => {
    it('signed out: stashes the code and goes to /login', async () => {
        expect(await mountAt('/invite/aBc123Xy')).toBe('/login');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('signed in: stashes the code and goes to /chat', async () => {
        authed.value = true;
        expect(await mountAt('/invite/aBc123Xy')).toBe('/chat');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('a malformed code stashes nothing and falls through to the landing route', async () => {
        expect(await mountAt('/invite/no%20such%20code')).toBe('/');
        expect(peekPendingInvite()).toBeNull();
    });
});

describe('InviteLanding: "Open in the Púca app", in a desktop browser on Windows', () => {
    beforeEach(() => { uaSpy.mockReturnValue(UA.windowsChrome); });

    it('offers the app link beside the browser flow, and goes nowhere by itself', async () => {
        expect(await mountAt('/invite/aBc123Xy')).toBeUndefined();   // still on the choice
        expect(openLink()?.getAttribute('href')).toBe(`puca://invite/aBc123Xy?host=${window.location.hostname}`);
        expect(openLink()?.textContent).toMatch('Open in the Púca app');
        expect(browserButton()).toBeTruthy();
        expect(rememberBox()?.checked).toBe(false);
        // Nothing is decided yet: no stash, no launch, no help text.
        expect(peekPendingInvite()).toBeNull();
        expect(launched).toEqual([]);
        expect(help()).toBeNull();
        // No wording about any particular program the link came from.
        expect(container.textContent).not.toMatch(/steam/i);
    });

    it('in Firefox too, and through userAgentData where the browser has it', async () => {
        uaSpy.mockReturnValue(UA.windowsFirefox);
        await mountAt('/invite/aBc123Xy');
        expect(openLink()).not.toBeNull();
        await act(async () => root.unmount());
        container.remove();
        // Client hints win over the UA string: "Windows" and not mobile.
        uaSpy.mockReturnValue(UA.linux);
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'Windows', mobile: false } });
        await mountAt('/invite/aBc123Xy');
        expect(openLink()).not.toBeNull();
    });

    it('"Continue in the browser" is the web flow: stash, then sign in', async () => {
        await mountAt('/invite/aBc123Xy');
        await act(async () => { browserButton()!.click(); });
        expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/login');
        expect(peekPendingInvite()).toBe('aBc123Xy');
        expect(launched).toEqual([]);
    });

    it('"Continue in the browser", signed in: straight to Chat', async () => {
        authed.value = true;
        await mountAt('/invite/aBc123Xy');
        await act(async () => { browserButton()!.click(); });
        expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/chat');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('clicking the app link says what to do if nothing opened, with the download page', async () => {
        await mountAt('/invite/aBc123Xy');
        await act(async () => { openLink()!.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(help()?.textContent).toMatch(/Nothing opened\?.*may not be installed/);
        expect(help()?.textContent).toMatch(/or continue in the browser/);
        const get = help()?.querySelector('a');
        expect(get?.getAttribute('href')).toBe('https://download.example.com/');
        expect(get?.textContent).toBe('Get the desktop app');
        // The browser flow is still right there, and nothing was stashed.
        expect(browserButton()).toBeTruthy();
        expect(peekPendingInvite()).toBeNull();
    });

    it('with no download page published, it still says what to do', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        await mountAt('/invite/aBc123Xy');
        await act(async () => { openLink()!.click(); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(help()?.textContent).toMatch(/Install it, or continue in the browser/);
        expect(help()?.querySelector('a')).toBeNull();
    });

    it('never tries the app by itself without the remembered choice', async () => {
        await mountAt('/invite/aBc123Xy', { strict: true });
        expect(launched).toEqual([]);
    });

    it('the remembered choice: tries the app link ONCE on arrival, browser flow one click away', async () => {
        localStorage.setItem(REMEMBER_KEY, '1');
        await mountAt('/invite/aBc123Xy', { strict: true });   // StrictMode runs effects twice
        expect(launched).toEqual([`puca://invite/aBc123Xy?host=${window.location.hostname}`]);
        expect(rememberBox()?.checked).toBe(true);
        expect(browserButton()).toBeTruthy();
        expect(help()?.textContent).toMatch(/Nothing opened\?/);
        expect(peekPendingInvite()).toBeNull();
    });

    it('the checkbox keeps the choice in this browser, and unticking forgets it', async () => {
        await mountAt('/invite/aBc123Xy');
        await act(async () => { rememberBox()!.click(); });
        expect(localStorage.getItem(REMEMBER_KEY)).toBe('1');
        expect(rememberBox()!.checked).toBe(true);
        await act(async () => { rememberBox()!.click(); });
        expect(localStorage.getItem(REMEMBER_KEY)).toBeNull();
        expect(launched).toEqual([]);   // ticking it is not a launch
    });

    it('a malformed code is still refused before anything is offered', async () => {
        expect(await mountAt('/invite/no%20such%20code')).toBe('/');
        expect(openLink()).toBeNull();
    });
});

describe('InviteLanding: no app link anywhere else', () => {
    const offered = async () => {
        await mountAt('/invite/aBc123Xy');
        return openLink() !== null;
    };

    it('not inside the Púca desktop app (it IS the app)', async () => {
        uaSpy.mockReturnValue(UA.windowsChrome);
        shell.tauri = true;
        expect(await offered()).toBe(false);
        expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/login');
        expect(peekPendingInvite()).toBe('aBc123Xy');
    });

    it('not in the Android apps, even if the WebView reported Windows', async () => {
        uaSpy.mockReturnValue(UA.windowsChrome);
        shell.mobile = true;
        expect(await offered()).toBe(false);
    });

    it('not on a phone browser', async () => {
        uaSpy.mockReturnValue(UA.android);
        expect(await offered()).toBe(false);
        await act(async () => root.unmount());
        container.remove();
        uaSpy.mockReturnValue(UA.iphone);
        expect(await offered()).toBe(false);
    });

    it('not on macOS or Linux, where no installer registers the scheme', async () => {
        uaSpy.mockReturnValue(UA.mac);
        expect(await offered()).toBe(false);
        await act(async () => root.unmount());
        container.remove();
        uaSpy.mockReturnValue(UA.linux);
        expect(await offered()).toBe(false);
    });

    it('not when client hints say mobile, whatever the UA string says', async () => {
        uaSpy.mockReturnValue(UA.windowsChrome);
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'Windows', mobile: true } });
        expect(await offered()).toBe(false);
    });

    it('with a remembered choice, still never launched off Windows', async () => {
        localStorage.setItem(REMEMBER_KEY, '1');
        uaSpy.mockReturnValue(UA.android);
        await mountAt('/invite/aBc123Xy');
        expect(launched).toEqual([]);
        expect(container.querySelector('[data-testid="where"]')?.textContent).toBe('/login');
    });
});
