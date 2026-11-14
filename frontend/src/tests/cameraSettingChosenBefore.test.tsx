/**
 * Settings > Voice & Video > Camera: a camera chosen before that today's list
 * does not name (unplugged, or the camera not allowed yet in this page, so no
 * names) is listed as a choice of its own. It vanished as soon as another
 * camera was picked here, so it could not be picked again, and the only way
 * back was Default (the camera-rear review's low).
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are (shareLadderSetting.test.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const touch = vi.hoisted(() => ({ on: false, canShare: true }));
vi.mock('../components/settingsModal.utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/settingsModal.utils')>()),
    isTouchDevice: () => touch.on,
    screenShareOffered: () => touch.canShare,
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
const enumerate = () => navigator.mediaDevices.enumerateDevices as unknown as Mock;

beforeEach(() => {
    touch.on = false;
    touch.canShare = true;
    store.clear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => store.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { store.set(k, String(v)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    enumerate().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'front', label: 'Front Camera', getCapabilities: () => ({ facingMode: ['user'] }) },
        { kind: 'videoinput', deviceId: 'back', label: 'Back Camera', getCapabilities: () => ({ facingMode: ['environment'] }) },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    enumerate().mockResolvedValue([]);
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
    return () => container.querySelector<HTMLSelectElement>('[data-testid="settings-camera"]')!;
}

async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
}

const options = (select: HTMLSelectElement) => Array.from(select.options).map(o => o.value);

describe('Settings > Camera: the camera chosen before', () => {
    const before = { deviceId: 'usb-cam', label: '', facing: null };

    it('is listed, and chosen, while the list of today does not name it', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ camera: before }));
        const camera = await openVoice();
        expect(options(camera())).toEqual(['default', 'front', 'back', 'usb-cam']);
        expect(camera().value).toBe('usb-cam');
        expect(camera().selectedOptions[0].textContent).toBe('The camera chosen before');
    });

    it('THE BUG: another camera picked, it is still there, and picking it again keeps it (it was Default)', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ camera: before }));
        const camera = await openVoice();
        await choose(camera(), 'back');
        expect((stored().camera as { deviceId: string }).deviceId).toBe('back');
        expect(options(camera()), 'gone once something else was picked').toContain('usb-cam');
        await choose(camera(), 'usb-cam');
        expect(stored().camera, 'picking it again forgot it (Default)').toEqual(before);
        expect(camera().value).toBe('usb-cam');
    });

    it('CONTROL: Default is still Default, and a listed camera is not listed twice', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ camera: { deviceId: 'front', label: 'Front Camera', facing: 'user' } }));
        const camera = await openVoice();
        expect(options(camera())).toEqual(['default', 'front', 'back']);
        await choose(camera(), 'default');
        expect(stored().camera).toBeNull();
        expect(camera().value).toBe('default');
    });
});
