/**
 * Settings › Voice & Video › Screen Sharing › "Send my screen at several sizes".
 *
 * A setting needs its UI, and this one's states are the ones that matter:
 *  - it lives under Voice & Video (no longer Advanced), and reads Automatic
 *    for a profile that never chose;
 *  - a profile that had turned the old on/off switch ON reads Always, so
 *    nobody who opted in loses the ladder (rememberedShareLadder);
 *  - a choice is saved in both fields, so the old flag never contradicts it;
 *  - it is not offered on a phone, which cannot share a screen.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const touch = vi.hoisted(() => ({ on: false }));
vi.mock('../components/settingsModal.utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/settingsModal.utils')>()),
    isTouchDevice: () => touch.on,
}));
vi.mock('../api/profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/profile')>()),
    getProfile: async () => ({ id: 1, username: 'me', display_name: null, email: null }),
}));
vi.mock('../components/blockStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/blockStore')>()),
    fetchBlockedUsers: async () => [],
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: async () => ({}) } };
});
// The Clips card under Voice & Video lists the servers (useServers).
vi.mock('../api/servers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/servers')>()),
    listServers: async () => [],
}));

const { SettingsModal } = await import('../components/SettingsModal');

const SETTINGS_KEY = 'sovereign_settings';
const store = new Map<string, string>();
let container: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const stored = () => JSON.parse(store.get(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
    touch.on = false;
    store.clear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    (localStorage.getItem as Mock).mockReset();
    (localStorage.setItem as Mock).mockReset();
});

async function openSection(label: string) {
    // Voice & Video reads server data through react-query (its Clips card).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(<QueryClientProvider client={qc}><SettingsModal isOpen onClose={() => {}} onLogout={() => {}} /></QueryClientProvider>);
    });
    await settle();
    const nav = Array.from(container.querySelectorAll('.settings-nav-item')).find(b => b.textContent?.includes(label));
    expect(nav, `the ${label} section exists`).toBeTruthy();
    await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    return () => container.querySelector<HTMLSelectElement>('#share-ladder-mode');
}

async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
}

describe('"Send my screen at several sizes"', () => {
    it('is under Voice & Video and reads Automatic for a profile that never chose', async () => {
        const control = await openSection('Voice & Video');
        expect(control(), 'the control is in Voice & Video').not.toBeNull();
        expect(control()!.value).toBe('auto');
        expect(Array.from(control()!.options).map(o => o.value)).toEqual(['auto', 'always', 'never']);
        expect(container.textContent).toContain('Screen Sharing');
    });

    it('is no longer under Advanced', async () => {
        const control = await openSection('Advanced');
        // Positive control: this IS the Advanced section.
        expect(container.textContent).toContain('Diagnostics');
        expect(control()).toBeNull();
    });

    it('keeps the ladder for someone who had turned the old switch on', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ shareSimulcast: true }));
        const control = await openSection('Voice & Video');
        expect(control()!.value).toBe('always');
    });

    it('saves a choice in both fields, so the old flag never contradicts it', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ shareSimulcast: true }));
        const control = await openSection('Voice & Video');
        await choose(control()!, 'never');
        expect(stored()).toMatchObject({ shareLadder: 'never', shareSimulcast: false });
        expect(control()!.value).toBe('never');
        await choose(control()!, 'always');
        expect(stored()).toMatchObject({ shareLadder: 'always', shareSimulcast: true });
        await choose(control()!, 'auto');
        expect(stored()).toMatchObject({ shareLadder: 'auto', shareSimulcast: false });
        expect(control()!.value).toBe('auto');
    });

    it('tells a running share at once: every save is announced', async () => {
        // sfuManager.followLadderSetting listens for this event.
        const seen: unknown[] = [];
        const on = (e: Event) => seen.push((e as CustomEvent).detail?.shareLadder);
        window.addEventListener('settingsChanged', on);
        try {
            const control = await openSection('Voice & Video');
            await choose(control()!, 'never');
            expect(seen.at(-1)).toBe('never');
        } finally {
            window.removeEventListener('settingsChanged', on);
        }
    });

    it('is not offered on a phone, which cannot share a screen', async () => {
        touch.on = true;
        const control = await openSection('Voice & Video');
        // Positive control: the section itself rendered.
        expect(container.textContent).toContain('Voice Settings');
        expect(control()).toBeNull();
        expect(container.textContent).not.toContain('Screen Sharing');
    });
});
