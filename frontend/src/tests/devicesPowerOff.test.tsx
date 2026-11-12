/**
 * The device card's Power off button (components/DevicesView.tsx): where it is
 * offered, the app's own question first (askConfirm, naming the PC and the
 * unsaved work), the PC decided at the press, and the line that says how it
 * went. The driver is a spy here; it is pinned in devicePowerOff.test.ts and
 * the session layer under it in devicePowerOffController.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';

const listDevices = vi.fn();
vi.mock('../api/devices', () => ({
    listDevices: (...a: unknown[]) => listDevices(...a),
    renameDevice: vi.fn(),
    revokeDevice: vi.fn(),
    currentUserId: () => 42,
    thisDeviceId: () => 'phone',
    isThisDeviceRevoked: () => false,
    resetThisDeviceIdentity: vi.fn(),
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'phone' }));
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyCustody: () => 'os-protected' }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn().mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));
const listIncomingShares = vi.fn();
vi.mock('../api/devices/shares', () => ({
    listIncomingShares: () => listIncomingShares(),
    respondShare: vi.fn(),
    deleteShare: vi.fn(),
}));
vi.mock('../api/devices/session', () => ({
    SHUTDOWN_REASON: 'the device is shutting down',
    POWER_OFF_TOO_OLD_REASON: 'power-off: that Púca is too old to know it',
    POWER_OFF_NOT_ALLOWED_REASON: 'power-off: this share does not include control',
    POWER_OFF_ATTENDED_REASON: 'power-off: someone there let this connection in',
    POWER_OFF_UNLOCKED_REASON: 'the console was unlocked',
    connectToDevice: vi.fn(),
    subscribeSessions: (l: (s: unknown[]) => void) => { l([]); return () => {}; },
    audioHubSessionFor: () => null,
    activeSessions: () => [],
    endSession: () => {},
}));
vi.mock('../api/websocket', () => ({
    wsClient: { send: () => true, on: () => {}, off: () => {} },
}));
const askConfirm = vi.fn<(m: string) => Promise<boolean>>();
vi.mock('../api/appDialogs', () => ({ askConfirm: (m: string) => askConfirm(m) }));

type Outcome = { kind: 'going' | 'unknown' | 'refused'; text: string };
const powerOffDevice = vi.fn<(t: Record<string, unknown>, onProgress?: (t: string) => void) => Promise<Outcome>>();
vi.mock('../api/devices/powerOff', async () => {
    const real = await vi.importActual<typeof import('../api/devices/powerOff')>('../api/devices/powerOff');
    return {
        ...real,
        powerOffDevice: (t: Record<string, unknown>, p?: (t: string) => void) => powerOffDevice(t, p),
    };
});

const { DevicesView } = await import('../components/DevicesView');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function dev(over: Partial<VerifiedDevice> & { id: string }): VerifiedDevice {
    return {
        device_pub: 'x25519:AAA', sign_pub: 'ed25519:BBB', name: over.id,
        platform: 'windows', auth_record: '{}', auth_sig: 's',
        host_enabled: false, host_policy: null, host_sig: null, lan_info: null,
        created_at: '2026-08-17T00:00:00Z', last_seen_at: null,
        online: true, verified: true, isThisDevice: false,
        ...over,
    } as VerifiedDevice;
}
const slimJim = (online = true) => dev({ id: 'pc', name: 'Slim-Jim', online });
const LAN = (role: 'app' | 'signin') =>
    JSON.stringify({ mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.0.77', subnet: '192.168.0', broadcast: '192.168.0.255', role });

async function settle() {
    await act(async () => {
        for (let i = 0; i < 24; i++) await Promise.resolve();
    });
}
async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DevicesView onClose={() => {}} />); });
    await settle();
}
const buttons = () => Array.from(host?.querySelectorAll('button') ?? []);
const buttonNamed = (label: string) => buttons().find(b => b.textContent?.trim() === label);
const cardOf = (name: string) => Array.from(host!.querySelectorAll('.device-card'))
    .find(c => c.querySelector('.device-name')?.textContent?.includes(name)) ?? null;
async function click(el: Element | undefined | null) {
    expect(el, 'expected the button to exist').toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
}

beforeEach(() => {
    listDevices.mockReset();
    listIncomingShares.mockReset();
    listIncomingShares.mockResolvedValue([]);
    askConfirm.mockReset();
    powerOffDevice.mockReset();
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

describe('where Power off is offered', () => {
    it('on an online, verified Windows PC that is not this device — with the power glyph, no emoji', async () => {
        listDevices.mockResolvedValue([slimJim(true)]);
        await mount();
        const btn = buttonNamed('Power off');
        expect(btn).toBeTruthy();
        expect(btn!.querySelector('svg'), 'the icon set\'s glyph').toBeTruthy();
        expect(btn!.title).toMatch(/Slim-Jim/);
    });

    it('not on an offline one (Wake & connect is there instead), a phone, this device, or an unverified row', async () => {
        listDevices.mockResolvedValue([
            dev({ id: 'off', name: 'Offline PC', online: false }),
            dev({ id: 'droid', name: 'Phone', platform: 'android' }),
            dev({ id: 'linux', name: 'Linux box', platform: 'linux' }),
            dev({ id: 'phone', name: 'Me', isThisDevice: true }),
            dev({ id: 'odd', name: 'Odd', verified: false }),
        ]);
        await mount();
        expect(host!.querySelectorAll('.device-card').length).toBe(5);
        expect(buttonNamed('Power off')).toBeUndefined();
    });
});

describe('pressing it', () => {
    it('asks first, in the app\'s question, naming the PC and the unsaved work — and Cancel does nothing', async () => {
        listDevices.mockResolvedValue([slimJim(true)]);
        askConfirm.mockResolvedValue(false);
        await mount();
        await click(buttonNamed('Power off'));
        expect(askConfirm).toHaveBeenCalledTimes(1);
        const q = askConfirm.mock.calls[0][0];
        expect(q.startsWith('Power off Slim-Jim now?')).toBe(true);
        expect(q).toMatch(/unsaved work on Slim-Jim will be lost/);
        expect(powerOffDevice).not.toHaveBeenCalled();
        expect(host!.querySelector('.device-power-status')).toBeNull();
        // The empty live region was mounted with the button.
        expect(cardOf('Slim-Jim')!.querySelector('[role="status"].device-power-live')?.textContent).toBe('');
    });

    it('two quick presses ask once and start one power-off', async () => {
        listDevices.mockResolvedValue([slimJim(true)]);
        let answer: (ok: boolean) => void = () => {};
        askConfirm.mockImplementation(() => new Promise<boolean>(r => { answer = r; }));
        powerOffDevice.mockResolvedValue({ kind: 'going', text: 'Slim-Jim is powering off.' });
        await mount();
        const btn = buttonNamed('Power off');
        await click(btn);
        await click(btn);
        expect(askConfirm, 'the second press, before the first is answered, asks nothing').toHaveBeenCalledTimes(1);
        await act(async () => { answer(true); });
        await settle();
        expect(powerOffDevice).toHaveBeenCalledTimes(1);
    });

    it('OK: the PC is decided NOW, each step is said, Control waits, and the outcome stays until dismissed', async () => {
        listDevices.mockResolvedValue([slimJim(true)]);
        askConfirm.mockResolvedValue(true);
        let finish: (o: Outcome) => void = () => {};
        powerOffDevice.mockImplementation((_t, onProgress) => {
            onProgress?.('Asking Slim-Jim to power off…');
            return new Promise<Outcome>(r => { finish = r; });
        });
        await mount();
        const listsBefore = listDevices.mock.calls.length;
        await click(buttonNamed('Power off'));
        expect(listDevices.mock.calls.length, 'a fresh list at the press').toBeGreaterThan(listsBefore);
        expect(powerOffDevice).toHaveBeenCalledTimes(1);
        expect(powerOffDevice.mock.calls[0][0]).toEqual({ hostDevice: 'pc', name: 'Slim-Jim', signIn: false });
        const status = () => cardOf('Slim-Jim')!.querySelector('.device-power-status');
        // In a live region that was there, empty, before the press — one
        // inserted together with its text is usually not announced.
        expect(status()?.parentElement?.getAttribute('role')).toBe('status');
        expect(status()?.textContent).toBe('Asking Slim-Jim to power off…');
        expect(buttonNamed('Power off')!.disabled, 'no second press while it runs').toBe(true);
        expect(buttonNamed('Control')!.disabled, 'Control would replace the power-off session').toBe(true);

        await act(async () => { finish({ kind: 'going', text: 'Slim-Jim is powering off.' }); });
        await settle();
        expect(status()?.textContent).toBe('Slim-Jim is powering off.');
        expect(status()?.classList.contains('device-wake-status-failed')).toBe(false);
        await click(host!.querySelector('button[aria-label="Dismiss the Power off message"]'));
        expect(status()).toBeNull();
    });

    it('a refusal is shown as one, in its own words', async () => {
        listDevices.mockResolvedValue([slimJim(true)]);
        askConfirm.mockResolvedValue(true);
        powerOffDevice.mockResolvedValue({
            kind: 'refused',
            text: 'Slim-Jim runs a Púca too old to be powered off from here. Update Púca on Slim-Jim, or open it with Control and use More, then Shut down.',
        });
        await mount();
        await click(buttonNamed('Power off'));
        const status = cardOf('Slim-Jim')!.querySelector('.device-power-status')!;
        expect(status.textContent).toMatch(/too old/);
        expect(status.classList.contains('device-wake-status-failed')).toBe(true);
    });

    it('a PC that went offline since the card was painted: said, and nothing is sent', async () => {
        listDevices.mockResolvedValueOnce([slimJim(true)]).mockResolvedValue([slimJim(false)]);
        askConfirm.mockResolvedValue(true);
        await mount();
        await click(buttonNamed('Power off'));
        expect(powerOffDevice).not.toHaveBeenCalled();
        expect(host!.querySelector('.device-power-status')?.textContent)
            .toBe('Slim-Jim is offline, so it cannot be powered off from here (it may already be off).');
    });
});

describe('a locked PC', () => {
    it('is reached through its SIGN-IN-SCREEN row, and the card knows it (its lock-screen service answers)', async () => {
        // Locked: the app row is down and the sign-in row is up — the row the
        // power-off must go to (machines.ts prefers it whenever it is up).
        listDevices.mockResolvedValue([
            dev({ id: 'pc', name: 'Slim-Jim', online: false, lan_info: LAN('app') }),
            dev({ id: 'pc-signin', name: 'Slim-Jim (sign-in screen)', online: true, lan_info: LAN('signin') }),
        ]);
        askConfirm.mockResolvedValue(true);
        powerOffDevice.mockResolvedValue({ kind: 'going', text: 'Slim-Jim is powering off.' });
        await mount();
        expect(host!.querySelectorAll('.device-card').length, 'one card for the machine').toBe(1);
        await click(buttonNamed('Power off'));
        expect(powerOffDevice.mock.calls[0][0]).toEqual({ hostDevice: 'pc-signin', name: 'Slim-Jim', signIn: true });
    });
});

describe('a friend\'s PC', () => {
    const share = (caps: string[]) => ({
        id: 5, status: 'accepted', host_device: 'their-pc', host_device_name: 'Box', host_platform: 'windows',
        owner_user: 9, owner_username: 'friend', capabilities: caps, ready: true, online: true,
    });

    it('with control: offered, and the share rides along', async () => {
        listDevices.mockResolvedValue([]);
        listIncomingShares.mockResolvedValue([share(['control', 'files'])]);
        askConfirm.mockResolvedValue(true);
        powerOffDevice.mockResolvedValue({ kind: 'going', text: 'Box is powering off.' });
        await mount();
        await click(buttonNamed('Power off'));
        expect(askConfirm.mock.calls[0][0].startsWith('Power off Box now?')).toBe(true);
        expect(powerOffDevice.mock.calls[0][0]).toEqual({
            hostDevice: 'their-pc',
            name: 'Box',
            signIn: false,
            share: { inviteId: 5, ownerUser: 9, ownerUsername: 'friend', capabilities: ['control', 'files'] },
        });
        expect(cardOf('Box')!.querySelector('.device-power-status')?.textContent).toBe('Box is powering off.');
    });

    it('view-only or files-only: not offered (the stage draws the same line for Lock and Shut down)', async () => {
        listDevices.mockResolvedValue([]);
        listIncomingShares.mockResolvedValue([share(['view_only', 'files']), { ...share(['files']), id: 6 }]);
        await mount();
        expect(host!.querySelectorAll('.device-card').length).toBe(2);
        expect(buttonNamed('Power off')).toBeUndefined();
    });
});
