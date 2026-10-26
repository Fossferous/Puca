/**
 * Devices view ▸ This device ▸ "Keep Púca up to date on this computer while
 * nobody is connected" — the switch for components/HostAutoUpdate.tsx.
 *
 * Rules pinned (a setting needs its UI in the same change):
 *  - it is shown on a computer set up for remote control — unattended access
 *    armed, or lock-screen access installed — and on no other, where it would
 *    do nothing (NEGATIVE CONTROL: neither switch on, no card);
 *  - it is ON by default and turning it off is stored where the updater reads
 *    it (settingsStore `hostAutoUpdate`), read back into the box;
 *  - it says, before it ever acts, that the sign-in-screen service is not
 *    updated this way — and says it only where there is such a service.
 *
 * Rig: devicesLidClosed.test.tsx's (lockScreen and unattendedHost mocked at
 * the module boundary; both are isTauri(), false under jsdom), with the real
 * settings store over a map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';

const store = vi.hoisted(() => new Map<string, string>());
const listDevices = vi.fn();
vi.mock('../api/devices', () => ({
    isThisDeviceRevoked: () => false,
    resetThisDeviceIdentity: async () => null,
    listDevices: (...a: unknown[]) => listDevices(...a),
    renameDevice: vi.fn(),
    revokeDevice: vi.fn(),
    currentUserId: () => 42,
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'thisDev' }));
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyCustody: () => 'os-protected' as const,
}));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn().mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));
vi.mock('../api/devices/session', () => ({ connectToDevice: vi.fn(), subscribeSessions: () => () => {} }));
vi.mock('../api/devices/tunnel', () => ({
    getTunnelPolicy: vi.fn().mockResolvedValue({ enabled: false, allowed: [] }),
    setTunnelForwarding: vi.fn().mockResolvedValue(null),
    tunnelSupported: () => false,
}));
let armed = false;
vi.mock('../api/devices/unattendedHost', () => ({
    armUnattended: vi.fn(),
    disarmUnattended: vi.fn(),
    unattendedState: async () => ({ armed, salt: null }),
    unattendedSupported: () => true,
}));
let serviceInstalled = false;
vi.mock('../api/devices/virtualScreen', () => ({
    virtualScreenState: async () => ({ installed: false, available: true, problem: null }),
    enableVirtualScreen: vi.fn(),
    disableVirtualScreen: vi.fn(),
}));
vi.mock('../api/devices/lockScreen', async () => {
    const real = await vi.importActual<typeof import('../api/devices/lockScreen')>('../api/devices/lockScreen');
    return {
        ...real,
        lockScreenSupported: () => true,
        lockScreenState: async () => ({ installed: serviceInstalled, running: serviceInstalled, available: true, problem: null }),
        unattendedAccessState: async () => ({
            serviceInstalled, enrolled: false, armed: false, deviceId: null, binsHash: null,
            linkAttestedAt: null, linkRefusedFirst: null, linkRefusedLast: null,
            linkRefusedCount: 0, linkRefusedStatus: null, error: null,
        }),
        bundledServiceFingerprint: async () => ({ hash: null, error: null }),
    };
});

const { DevicesView } = await import('../components/DevicesView');
const { loadSettings } = await import('../components/settingsStore');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function device(): VerifiedDevice {
    return {
        id: 'thisDev', device_pub: 'x25519:AAA', sign_pub: 'ed25519:BBB', name: 'Test-PC', platform: 'windows',
        auth_record: '{}', auth_sig: 'sig', host_enabled: false, host_policy: null, host_sig: null, lan_info: null,
        created_at: '2026-07-28T00:00:00Z', last_seen_at: null, online: true, verified: true,
    } as VerifiedDevice;
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    }
}

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DevicesView onClose={() => {}} />); });
    await settle();
    const banner = host.querySelector('.device-error');
    if (banner) throw new Error(`DevicesView failed to load, so nothing below is being tested: ${banner.textContent}`);
    const tabBtn = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'This device');
    if (!tabBtn) throw new Error('DevicesView rendered without a This-device tab');
    await act(async () => { tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    // PRECONDITION: the tab drew its host cards, so an absent switch below is
    // the rule's doing, not a tab that never rendered.
    expect(host.textContent, 'the unattended card must be on screen').toContain('Unattended access on');
}

const LABEL = 'Keep Púca up to date on this computer while nobody is connected';
const box = () => host?.querySelector<HTMLInputElement>('#device-host-updates') ?? null;
const card = () => box()?.closest('.dv-card') ?? null;

beforeEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { store.set(k, v); });
    listDevices.mockResolvedValue([device()]);
    armed = false;
    serviceInstalled = false;
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the host-updates switch', () => {
    it('POSITIVE CONTROL: on a computer armed for unattended access it is there, labelled, and ON', async () => {
        armed = true;
        await mount();
        expect(box(), 'the switch').toBeTruthy();
        expect(card()?.querySelector('label')?.textContent?.trim()).toBe(LABEL);
        expect(box()!.checked, 'on by default for a host').toBe(true);
        expect(card()?.textContent).toContain('nobody has used its keyboard or mouse for 10 minutes');
    });

    // Coordinator, round 3: the soak's rule, where the person deciding sees it.
    it('the card says how long it waits: a day behind, and the new version out 2 hours', async () => {
        armed = true;
        await mount();
        expect(card()?.textContent?.replace(/\s+/g, ' ')).toContain(
            'It waits until this computer has been behind for 24 hours and the new version has been out for 2 hours');
    });

    it('lock-screen access alone makes it a host, and then the card says the service is not updated this way', async () => {
        serviceInstalled = true;
        await mount();
        expect(box()).toBeTruthy();
        expect(card()?.textContent).toContain('It does not update the sign-in-screen service');
    });

    it('CONTROL: armed with no service, the card does not talk about a service there is not', async () => {
        armed = true;
        await mount();
        expect(card()?.textContent).not.toContain('sign-in-screen service');
    });

    it('NEGATIVE CONTROL: on a computer not set up for remote control there is no switch', async () => {
        await mount();
        expect(box()).toBeNull();
        expect(host?.textContent).not.toContain(LABEL);
    });

    it('turning it off is stored where the updater reads it, and on again', async () => {
        armed = true;
        await mount();
        expect(loadSettings().hostAutoUpdate).toBe(true);
        await act(async () => { box()!.click(); });
        expect(loadSettings().hostAutoUpdate, 'stored').toBe(false);
        expect(box()!.checked, 'read back').toBe(false);
        await act(async () => { box()!.click(); });
        expect(loadSettings().hostAutoUpdate).toBe(true);
        expect(box()!.checked).toBe(true);
    });

    it('a stored "off" is what the switch shows', async () => {
        store.set('sovereign_settings', JSON.stringify({ hostAutoUpdate: false }));
        armed = true;
        await mount();
        expect(box()!.checked).toBe(false);
    });
});
