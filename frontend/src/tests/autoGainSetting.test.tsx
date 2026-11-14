/**
 * Settings > Voice & Video > Auto Gain Control in the WEB app: off by default,
 * with the reason beside the switch, and a switch that turns it on for good
 * (settingsStore.ts autoGainOnByDefault / migrateAutoGainDefaultOffInBrowser;
 * autoGainDefault.test.ts pins the store).
 *
 * Mounted with raw `react-dom/client` + `act`, as cameraSettingChosenBefore
 * does. jsdom is a browser here: no Tauri shell, no Capacitor bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
    store.clear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
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

async function openVoice() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(<QueryClientProvider client={qc}><SettingsModal isOpen onClose={() => {}} onLogout={() => {}} /></QueryClientProvider>);
    });
    await settle();
    const nav = Array.from(container.querySelectorAll('.settings-nav-item')).find(b => b.textContent?.includes('Voice & Video'));
    await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    await settle();
}

/** The Auto Gain Control row, found by its label (no data-testid: the
 *  `settings-` ids are the automation contract, docs/AUTOMATION.md). */
const row = () => Array.from(container.querySelectorAll('.settings-option'))
    .find(r => r.querySelector('label')?.textContent === 'Auto Gain Control')!;
const box = () => row().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const hintText = () => row().querySelector('.option-hint')!.textContent!.replace(/\s+/g, ' ');
const manualGainShown = () => Array.from(container.querySelectorAll('label')).some(l => l.textContent === 'Manual Gain');

async function reopen() {
    await act(async () => root.unmount());
    root = createRoot(container);
    await openVoice();
}

describe('Settings > Auto Gain Control in the web app', () => {
    it('is off on a new profile, says why, and shows Manual Gain', async () => {
        await openVoice();
        expect(box().checked).toBe(false);
        const hint = hintText();
        expect(hint).toContain('Off by default in the web app');
        expect(hint).toContain('it can lower your system microphone level');
        expect(manualGainShown()).toBe(true);
    });

    it('is off for a profile saved with the old default on', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true, theme: 'dark' }));
        await openVoice();
        expect(box().checked).toBe(false);
    });

    it('switched on, it is stored and still on the next time Settings opens', async () => {
        await openVoice();
        await act(async () => { box().click(); });
        await settle();
        expect(box().checked).toBe(true);
        expect(stored().autoGainControl).toBe(true);
        expect(manualGainShown(), 'Manual Gain only while auto gain is off').toBe(false);
        await reopen();
        expect(box().checked).toBe(true);
    });
});
