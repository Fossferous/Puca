/**
 * The download page's "Install Púca as an app" lands on `/?install=1`
 * (api/installPrompt.ts, components/InstallBanner.tsx). The cases that matter are
 * the ones where it must stay QUIET: an ordinary visit (the browser's own prompt
 * is left alone), an installed window, the desktop and Android shells, an iPhone,
 * a browser that never fires the event, and a dismissal. Each has its positive
 * control: the same page with the one thing changed does show.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { InstallBanner } from '../components/InstallBanner';
import {
    installInstallPrompt,
    getInstallState,
    ASK_TTL_MS,
    isInstalledWindow,
    isIosDevice,
    type BeforeInstallPromptEvent,
} from '../api/installPrompt';

let undo: () => void = () => {};

// The suite mounts with react-dom directly (no testing-library in this repo).
let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactElement) {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
        root = createRoot(host!);
        root.render(ui);
    });
    return { container: host };
}
function cleanup() {
    if (root) act(() => root!.unmount());
    root = null;
    host?.remove();
    host = null;
}
const screen = {
    queryByTestId: (id: string) => document.querySelector(`[data-testid="${id}"]`),
    getByTestId: (id: string) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) throw new Error(`no element with data-testid ${id}`);
        return el as HTMLElement;
    },
};
const fireEvent = {
    click: (el: Element) => {
        act(() => {
            (el as HTMLElement).click();
        });
    },
};

function at(search: string) {
    window.history.replaceState(null, '', '/' + search);
}

/** A cancelable beforeinstallprompt whose prompt() the test can see and settle. */
function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
    const ev = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
    const prompt = vi.fn(async () => {});
    Object.assign(ev, { prompt, userChoice: Promise.resolve({ outcome }) });
    return { ev, prompt };
}

function fire(ev: Event) {
    act(() => {
        window.dispatchEvent(ev);
    });
}

function start() {
    undo = installInstallPrompt(window);
}

function stubMatchMedia(matching: string[]) {
    vi.stubGlobal('matchMedia', (q: string) => ({
        matches: matching.some((m) => q.includes(m)),
        media: q,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
    }));
    window.matchMedia = globalThis.matchMedia;
}

// setup.ts replaces localStorage with bare mocks; give them a real memory behind them.
const store = new Map<string, string>();
type Fn = ReturnType<typeof vi.fn>;
function memoryStorage() {
    const ls = window.localStorage as unknown as Record<'getItem' | 'setItem' | 'removeItem' | 'clear', Fn>;
    store.clear();
    ls.getItem.mockImplementation((k: string) => (store.has(k) ? store.get(k)! : null));
    ls.setItem.mockImplementation((k: string, v: string) => void store.set(k, String(v)));
    ls.removeItem.mockImplementation((k: string) => void store.delete(k));
    ls.clear.mockImplementation(() => store.clear());
}

beforeEach(() => {
    memoryStorage();
    at('');
});

afterEach(() => {
    cleanup();
    undo();
    undo = () => {};
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    Object.defineProperty(window.navigator, 'standalone', { value: undefined, configurable: true });
});

describe('the marker asks; nothing else does', () => {
    it('an ordinary visit leaves the browser\'s own install prompt alone and shows nothing', () => {
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
        const { container } = render(<InstallBanner />);
        expect(container.firstChild).toBeNull();
    });

    it('?install=1 shows the banner once the browser offers the install, and drops the marker from the address', () => {
        at('?install=1&keep=2#frag');
        start();
        expect(window.location.search).toBe('?keep=2');
        expect(window.location.hash).toBe('#frag');
        render(<InstallBanner />);
        expect(screen.queryByTestId('install-banner-install')).toBeNull(); // no event yet: unsupported so far
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(screen.getByTestId('install-banner-install')).toBeTruthy();
    });

    it('the ask survives the marker being dropped (a sign-in reload, an event that fires late)', () => {
        at('?install=1');
        start();
        undo();
        at(''); // a fresh page load without the query string
        start();
        render(<InstallBanner />);
        fire(installEvent().ev);
        expect(screen.getByTestId('install-banner-install')).toBeTruthy();
    });

    it('an ask older than ten minutes is no ask: quiet, and the browser prompt is left alone', () => {
        store.set('puca-install-requested', String(Date.now() - ASK_TTL_MS - 1000));
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
        expect(store.has('puca-install-requested')).toBe(false);
    });

    it('the plain "1" an older build wrote is not a live ask either', () => {
        store.set('puca-install-requested', '1');
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
    });

    it('positive control: an ask a few minutes old still counts', () => {
        store.set('puca-install-requested', String(Date.now() - 5 * 60 * 1000));
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(getInstallState().visible).toBe(true);
    });

    it('a browser that never fires the event never shows a banner', () => {
        at('?install=1');
        start();
        const { container } = render(<InstallBanner />);
        expect(container.firstChild).toBeNull();
    });
});

describe('the tap', () => {
    it('Install calls the browser prompt and closes the banner when accepted', async () => {
        at('?install=1');
        start();
        render(<InstallBanner />);
        const { ev, prompt } = installEvent('accepted');
        fire(ev);
        await act(async () => {
            fireEvent.click(screen.getByTestId('install-banner-install'));
        });
        expect(prompt).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('install-banner-install')).toBeNull();
        expect(window.localStorage.getItem('puca-install-requested')).toBeNull();
        expect(window.localStorage.getItem('puca-install-dismissed')).toBeNull();
    });

    it('refusing the browser dialog counts as a dismissal', async () => {
        at('?install=1');
        start();
        render(<InstallBanner />);
        fire(installEvent('dismissed').ev);
        await act(async () => {
            fireEvent.click(screen.getByTestId('install-banner-install'));
        });
        expect(screen.queryByTestId('install-banner-install')).toBeNull();
        expect(window.localStorage.getItem('puca-install-dismissed')).toBe('1');
    });

    it('appinstalled closes it', () => {
        at('?install=1');
        start();
        render(<InstallBanner />);
        fire(installEvent().ev);
        expect(screen.getByTestId('install-banner-install')).toBeTruthy();
        fire(new Event('appinstalled'));
        expect(screen.queryByTestId('install-banner-install')).toBeNull();
    });
});

describe('a dismissal persists', () => {
    it('the X hides it, and a later plain visit stays quiet', () => {
        at('?install=1');
        start();
        render(<InstallBanner />);
        fire(installEvent().ev);
        fireEvent.click(screen.getByTestId('install-banner-dismiss'));
        expect(screen.queryByTestId('install-banner-install')).toBeNull();
        expect(window.localStorage.getItem('puca-install-dismissed')).toBe('1');

        cleanup();
        undo();
        at('');
        start();
        render(<InstallBanner />);
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(screen.queryByTestId('install-banner-install')).toBeNull();
    });

    it('asking again from the download page (the marker) is a fresh ask', () => {
        store.set('puca-install-dismissed', '1');
        at('?install=1');
        start();
        render(<InstallBanner />);
        fire(installEvent().ev);
        expect(screen.getByTestId('install-banner-install')).toBeTruthy();
        expect(window.localStorage.getItem('puca-install-dismissed')).toBeNull();
    });

    it('blocked storage does not break it', () => {
        const ls = window.localStorage as unknown as Record<'getItem' | 'setItem', Fn>;
        ls.getItem.mockImplementation(() => {
            throw new Error('blocked');
        });
        ls.setItem.mockImplementation(() => {
            throw new Error('blocked');
        });
        at('?install=1');
        start();
        render(<InstallBanner />);
        fire(installEvent().ev);
        expect(screen.getByTestId('install-banner-install')).toBeTruthy();
    });
});

describe('where it never shows, even when asked', () => {
    it('positive control: the plain browser case above shows (this block flips one thing each time)', () => {
        at('?install=1');
        start();
        fire(installEvent().ev);
        expect(getInstallState().visible).toBe(true);
    });

    it('in an installed window (display-mode standalone)', () => {
        stubMatchMedia(['display-mode: standalone']);
        expect(isInstalledWindow(window)).toBe(true);
        at('?install=1');
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
        const { container } = render(<InstallBanner />);
        expect(container.firstChild).toBeNull();
    });

    it('in fullscreen and minimal-ui installed windows too', () => {
        for (const mode of ['fullscreen', 'minimal-ui']) {
            stubMatchMedia([`display-mode: ${mode}`]);
            expect(isInstalledWindow(window)).toBe(true);
        }
    });

    it('in an iPhone Home Screen app (navigator.standalone)', () => {
        Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
        expect(isInstalledWindow(window)).toBe(true);
        at('?install=1');
        start();
        fire(installEvent().ev);
        expect(getInstallState().visible).toBe(false);
    });

    it('inside the Tauri desktop app', () => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
        at('?install=1');
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
        // and it does not even eat the marker from the address
        expect(window.location.search).toBe('?install=1');
    });

    it('inside the Capacitor Android app', () => {
        const spy = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
        at('?install=1');
        start();
        const { ev } = installEvent();
        fire(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(getInstallState().visible).toBe(false);
        spy.mockRestore();
    });

    it('on an iPhone or iPad (no install event there; the download page has its own route)', () => {
        const ua = vi.spyOn(window.navigator, 'userAgent', 'get');
        ua.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
        expect(isIosDevice(window)).toBe(true);
        at('?install=1');
        start();
        fire(installEvent().ev);
        expect(getInstallState().visible).toBe(false);
        ua.mockRestore();
    });

    it('a Mac that is not an iPad is not mistaken for one', () => {
        const ua = vi.spyOn(window.navigator, 'userAgent', 'get');
        ua.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15');
        expect(isIosDevice(window)).toBe(false);
        ua.mockRestore();
    });
});
