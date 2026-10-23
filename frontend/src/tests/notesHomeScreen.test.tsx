// @vitest-environment jsdom
/**
 * Púca Notes added to an iPhone's Home Screen (api/iosStandalone.ts):
 *  - its sign-in starts with "Stay signed in" TICKED, like the phone app (the
 *    download page and the User Guide tell people to sign in once there);
 *  - it offers no link back to Púca (`target=_blank` in a standalone window
 *    navigates the app itself): neither the rail's nor the account menu's.
 * Each case has its Safari-tab control, so a version that hid or ticked
 * everything for everyone cannot pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

const STAY_KEY = 'pucaStaySignedIn';
vi.mock('../api/auth', () => ({
    login: vi.fn(async () => 'tok'),
    RetiredKeyFormatError: class RetiredKeyFormatError extends Error {},
    STAY_SIGNED_IN_KEY: STAY_KEY,
}));
vi.mock('../api/client', () => ({ isNetworkError: () => false }));
// The real platform module: a browser (Capacitor reports no native platform in jsdom).

let container: HTMLDivElement;
let root: Root | null = null;

function setStandalone(v: boolean | undefined) {
    if (v === undefined) delete (navigator as unknown as Record<string, unknown>).standalone;
    else Object.defineProperty(navigator, 'standalone', { value: v, configurable: true });
}

beforeEach(() => {
    vi.mocked(window.localStorage.getItem).mockImplementation(() => null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root!.unmount());
    container.remove();
    setStandalone(undefined);
    vi.mocked(window.localStorage.getItem).mockReset();
});

/** A fresh copy of the modules: they read the platform once, at import. */
async function render(which: 'login' | 'rail' | 'menu') {
    vi.resetModules();
    const el = await (async () => {
        if (which === 'login') {
            const { NotesLogin } = await import('../notes/components/NotesLogin');
            return <MemoryRouter><NotesLogin onSuccess={() => {}} /></MemoryRouter>;
        }
        if (which === 'rail') {
            const { NotesRail } = await import('../notes/components/NotesRail');
            return (
                <MemoryRouter>
                    <NotesRail filter={{ kind: 'notes' } as never} labels={[]} reminderBadge={0} counts={{ notes: 0, archived: 0 }}
                        open onClose={() => {}} onNavigate={() => {}} version="1.0.0" />
                </MemoryRouter>
            );
        }
        const { AccountMenu } = await import('../notes/components/AccountMenu');
        return (
            <MemoryRouter>
                <AccountMenu username="ash" sort={'edited' as never} onSort={() => {}} times={{} as never} onTimes={() => {}}
                    onExportMarkdown={() => {}} onExportJson={() => {}} onHelp={() => {}} onSignOut={() => {}} onSignOutEverywhere={() => {}} />
            </MemoryRouter>
        );
    })();
    await act(async () => { root!.render(el); });
}
const openPuca = () => [...container.querySelectorAll('a')].filter((a) => a.textContent?.includes('Open Púca'));

describe('Púca Notes in a Home Screen app', () => {
    it('signs in with "Stay signed in" ticked, and in a Safari tab with it clear (control)', async () => {
        setStandalone(true);
        await render('login');
        expect(container.querySelector<HTMLInputElement>('#stay-signed-in')?.checked).toBe(true);
        await act(async () => root!.unmount());
        root = createRoot(container);
        setStandalone(false);
        await render('login');
        expect(container.querySelector<HTMLInputElement>('#stay-signed-in')?.checked).toBe(false);
    });

    it.each(['rail', 'menu'] as const)('the %s offers "Open Púca" in a Safari tab (control) and not in a Home Screen app', async (which) => {
        setStandalone(false);
        await render(which);
        expect(openPuca().length).toBeGreaterThan(0);
        await act(async () => root!.unmount());
        root = createRoot(container);
        setStandalone(true);
        await render(which);
        expect(openPuca()).toHaveLength(0);
    });
});
