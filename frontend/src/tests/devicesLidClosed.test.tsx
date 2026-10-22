/**
 * Devices view ▸ This device ▸ "Allow remote control with the lid closed".
 *
 * The switch on the PC that installs the virtual screen
 * (crates/puca-service/src/virtual_screen.rs). Rules pinned:
 *  - it appears only once the remote-access service is installed, because
 *    that service is what switches the screen on and off;
 *  - it reads the machine (virtual_screen_state), never a remembered flag,
 *    so a declined Windows prompt leaves it off by itself;
 *  - the reason a turn-on failed is shown IN its card, worded for a person;
 *  - it cannot be turned ON while the installed service is older than the app
 *    (that service has never heard of the virtual screen), but can always be
 *    turned OFF.
 *
 * Rig: devicesSignInRefused.test.tsx's, with lockScreen mocked at the module
 * boundary (lockScreenSupported() is isTauri(), false under jsdom) and the
 * virtual screen's own module mocked where the elevated calls would be.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';
import type { UnattendedAccessState } from '../api/devices/lockScreen';
import type { VirtualScreenState } from '../api/devices/virtualScreen';

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
vi.mock('../api/devices/unattendedHost', () => ({
    armUnattended: vi.fn(),
    disarmUnattended: vi.fn(),
    unattendedState: vi.fn().mockResolvedValue({ armed: false, salt: null }),
    unattendedSupported: () => false,
}));

const unattendedAccessState = vi.fn<() => Promise<UnattendedAccessState>>();
/** Is the remote-access service installed (lockScreenState), and what does
 *  this build bundle (bundledServiceFingerprint)? Per test. */
let serviceInstalled = true;
let bundledHash: string | null = null;

// The switch's own module: the machine's state, and the two elevated calls.
let vsState: VirtualScreenState = { installed: false, available: true, problem: null };
const enableVirtualScreen = vi.fn(async (): Promise<string | null> => null);
const disableVirtualScreen = vi.fn(async (): Promise<string | null> => null);
vi.mock('../api/devices/virtualScreen', () => ({
    virtualScreenState: async () => ({ ...vsState }),
    enableVirtualScreen: () => enableVirtualScreen(),
    disableVirtualScreen: () => disableVirtualScreen(),
}));
vi.mock('../api/devices/lockScreen', async () => {
    const real = await vi.importActual<typeof import('../api/devices/lockScreen')>('../api/devices/lockScreen');
    return {
        ...real,
        lockScreenSupported: () => true,
        lockScreenState: async () => ({ installed: serviceInstalled, running: serviceInstalled, available: true, problem: null }),
        unattendedAccessState: () => unattendedAccessState(),
        bundledServiceFingerprint: async () => ({ hash: bundledHash, error: null }),
    };
});

const { DevicesView } = await import('../components/DevicesView');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function device(): VerifiedDevice {
    return {
        id: 'thisDev',
        device_pub: 'x25519:AAA',
        sign_pub: 'ed25519:BBB',
        name: 'Test-PC',
        platform: 'windows',
        auth_record: '{}',
        auth_sig: 'sig',
        host_enabled: false,
        host_policy: null,
        host_sig: null,
        lan_info: null,
        created_at: '2026-07-28T00:00:00Z',
        last_seen_at: null,
        online: true,
        verified: true,
    } as VerifiedDevice;
}


/** Let every pending promise chain (the mocked state queries) land. */
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
    if (banner) {
        throw new Error(`DevicesView failed to load, so nothing below is being tested: ${banner.textContent}`);
    }
    const tabBtn = [...host.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === 'This device');
    if (!tabBtn) throw new Error('DevicesView rendered without a This-device tab');
    await act(async () => {
        tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    // PRECONDITION: the This-device tab rendered its service cards at all, so
    // an absent switch below is about the rule, not a tab that never drew.
    expect(host.textContent, 'the service card must be on screen')
        .toContain('Let me reach this computer');
}


function state(over: Partial<UnattendedAccessState>): UnattendedAccessState {
    return {
        serviceInstalled: true, enrolled: false, armed: false, deviceId: null, binsHash: null,
        linkAttestedAt: null, linkRefusedFirst: null, linkRefusedLast: null,
        linkRefusedCount: 0, linkRefusedStatus: null, error: null,
        ...over,
    };
}

const LABEL = 'Allow remote control with the lid closed';
const box = () => host?.querySelector<HTMLInputElement>('#device-lid-closed') ?? null;
const card = () => box()?.closest('.dv-card') ?? null;

async function click(el: HTMLElement) {
    await act(async () => { el.click(); });
    await settle();
}

beforeEach(() => {
    vi.clearAllMocks();
    listDevices.mockResolvedValue([device()]);
    unattendedAccessState.mockResolvedValue(state({ enrolled: false, armed: false }));
    serviceInstalled = true;
    bundledHash = null;
    vsState = { installed: false, available: true, problem: null };
    enableVirtualScreen.mockImplementation(async () => null);
    disableVirtualScreen.mockImplementation(async () => null);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the lid-closed switch', () => {
    it('POSITIVE CONTROL: with the service installed it is there, labelled, off and usable', async () => {
        await mount();
        expect(host!.textContent).toContain(LABEL);
        expect(box(), 'the switch must be on screen').toBeTruthy();
        expect(box()!.checked).toBe(false);
        expect(box()!.disabled).toBe(false);
        // Says what it installs, and that Windows asks in its own words.
        expect(card()!.textContent).toContain('Virtual Display Driver');
        expect(card()!.textContent).toContain('SignPath Foundation');
    });

    it('is absent until the remote-access service is installed', async () => {
        serviceInstalled = false;
        await mount();
        // Same tab, same rig: the service card IS there (mount checks it), ours is not.
        expect(box()).toBeNull();
        expect(host!.textContent).not.toContain(LABEL);
    });

    it('turning it on installs, and the switch then reads the machine', async () => {
        await mount();
        enableVirtualScreen.mockImplementation(async () => {
            vsState = { installed: true, available: true, problem: null };
            return null;
        });
        await click(box()!);
        expect(enableVirtualScreen).toHaveBeenCalledTimes(1);
        expect(box()!.checked).toBe(true);
        // ...and off again removes it.
        disableVirtualScreen.mockImplementation(async () => {
            vsState = { installed: false, available: true, problem: null };
            return null;
        });
        await click(box()!);
        expect(disableVirtualScreen).toHaveBeenCalledTimes(1);
        expect(box()!.checked).toBe(false);
    });

    it('a declined Windows prompt leaves it off and says so in its own card', async () => {
        await mount();
        enableVirtualScreen.mockResolvedValue(
            "You declined Windows' prompt to install the virtual screen driver, so nothing was installed.");
        await click(box()!);
        expect(box()!.checked, 'the machine still says not installed').toBe(false);
        expect(card()!.textContent).toContain('You declined Windows');
    });

    it('a PC that cannot have it says why, and cannot be switched on', async () => {
        vsState = {
            installed: false,
            available: false,
            problem: 'The virtual screen is only available on 64-bit Intel and AMD PCs.',
        };
        await mount();
        expect(box()!.disabled).toBe(true);
        expect(card()!.textContent).toContain('only available on 64-bit');
    });

    it('waits for a service update before it can be turned on, but never blocks turning it off', async () => {
        // The installed service is older than the bundled pair.
        unattendedAccessState.mockResolvedValue(state({ binsHash: 'old-pair' }));
        bundledHash = 'new-pair';
        await mount();
        expect(box()!.disabled).toBe(true);
        expect(card()!.textContent).toContain('Update the sign-in-screen service first');

        act(() => root?.unmount());
        host?.remove();
        // Already installed: removing it must stay possible.
        vsState = { installed: true, available: true, problem: null };
        await mount();
        expect(box()!.checked).toBe(true);
        expect(box()!.disabled).toBe(false);
        expect(card()!.textContent).not.toContain('Update the sign-in-screen service first');
    });
});
