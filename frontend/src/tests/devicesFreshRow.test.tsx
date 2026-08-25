/**
 * The Devices list keeping up with a machine whose reachable ROW changes.
 *
 * A PC with sign-in-screen access is one card over two rows, and which row
 * answers flips at exactly the moments someone presses Control: the sign-in
 * row stands down the instant a PIN is typed, and the app row comes up some
 * seconds later. Field report after 0.8.85: "when I click Control ... it
 * takes a while to refresh" — the card was painted from a poll up to 15 s
 * old, Control went to the row that had just gone away, the server refused
 * it, and the user waited for the next poll.
 *
 * Three fixes, three tests: Control decides from a list fetched at click
 * time; a `DevicePresence` frame from the server refreshes the list at once;
 * one of our own sessions ending refreshes it too.
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
vi.mock('../api/devices/deviceKey', () => ({ deviceKeyCustody: () => 'os-protected' }));
vi.mock('../api/iceConfig', () => ({
    fetchIceConfig: vi.fn().mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));
// The fold decrypts each row's lan_info; with these the blob is the plaintext.
vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));
vi.mock('../api/devices/shares', () => ({
    listIncomingShares: vi.fn().mockResolvedValue([]),
    respondShare: vi.fn(),
    deleteShare: vi.fn(),
}));

const connectToDevice = vi.fn();
type SessionListener = (s: Array<{ id: string; role: string; phase: string }>) => void;
let sessionListener: SessionListener | null = null;
vi.mock('../api/devices/session', () => ({
    connectToDevice: (...a: unknown[]) => connectToDevice(...a),
    subscribeSessions: (l: SessionListener) => { sessionListener = l; l([]); return () => { sessionListener = null; }; },
}));

const wsHandlers = new Map<string, Array<(m: unknown) => void>>();
vi.mock('../api/websocket', () => ({
    wsClient: {
        send: () => true,
        on: (t: string, h: (m: unknown) => void) => {
            wsHandlers.set(t, [...(wsHandlers.get(t) ?? []), h]);
        },
        off: (t: string, h: (m: unknown) => void) => {
            wsHandlers.set(t, (wsHandlers.get(t) ?? []).filter(x => x !== h));
        },
    },
}));

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
const MAC = 'AA:BB:CC:DD:EE:FF';
const LAN = (role: 'app' | 'signin') =>
    JSON.stringify({ mac: MAC, ip: '192.168.0.77', subnet: '192.168.0', broadcast: '192.168.0.255', role });
const appRow = (online: boolean) => dev({ id: 'pc', name: 'PC', online, lan_info: LAN('app') });
const signInRow = (online: boolean) =>
    dev({ id: 'pc-signin', name: 'This PC (sign-in screen)', online, lan_info: LAN('signin') });

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
async function click(el: Element | undefined) {
    expect(el, 'expected the button to exist').toBeTruthy();
    await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
}

beforeEach(() => {
    listDevices.mockReset();
    connectToDevice.mockReset();
    connectToDevice.mockResolvedValue(undefined);
    wsHandlers.clear();
    sessionListener = null;
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

describe('Control on a two-row machine', () => {
    it('opens the row the FRESH list says is up, not the one the card was painted from', async () => {
        // Painted while the console was locked: the sign-in row is the way in.
        listDevices.mockResolvedValueOnce([appRow(false), signInRow(true)]);
        await mount();
        // One card, and it says which way in you have right now.
        expect(host!.querySelectorAll('.device-card').length).toBe(1);
        expect(host!.textContent).toContain('Sign-in screen');
        expect(buttonNamed('Control')).toBeTruthy();

        // The user signed in and the app came up. Control is pressed against
        // the card painted a moment ago.
        listDevices.mockResolvedValue([appRow(true), signInRow(false)]);
        await click(buttonNamed('Control'));

        expect(connectToDevice).toHaveBeenCalledTimes(1);
        expect(connectToDevice.mock.calls[0][0]).toBe('pc');
        // And the card now shows what the click learned.
        expect(host!.textContent).not.toContain('Sign-in screen');
    });

    it('positive control: with the list unchanged, the sign-in row is opened as before', async () => {
        listDevices.mockResolvedValue([appRow(false), signInRow(true)]);
        await mount();
        await click(buttonNamed('Control'));
        expect(connectToDevice.mock.calls[0][0]).toBe('pc-signin');
    });
});

describe('the list re-reads itself', () => {
    it('when the server announces a device attesting or dropping off (coalesced)', async () => {
        vi.useFakeTimers();
        try {
            listDevices.mockResolvedValue([appRow(true)]);
            await mount();
            const before = listDevices.mock.calls.length;
            // A burst of presence frames — a flapping device re-attesting — must
            // collapse to ONE refresh, not one per frame.
            await act(async () => {
                for (let i = 0; i < 5; i++) {
                    for (const h of wsHandlers.get('DevicePresence') ?? []) {
                        h({ payload: { device_id: 'pc', online: i % 2 === 0 } });
                    }
                }
            });
            // Before the debounce window elapses, nothing has fired.
            await act(async () => { await Promise.resolve(); });
            expect(listDevices.mock.calls.length).toBe(before);
            // After it, exactly one refresh for the whole burst.
            await act(async () => { await vi.advanceTimersByTimeAsync(900); });
            expect(listDevices.mock.calls.length).toBe(before + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('when one of our own device sessions ends', async () => {
        listDevices.mockResolvedValue([appRow(true)]);
        await mount();
        expect(sessionListener).toBeTruthy();
        const before = listDevices.mock.calls.length;

        // A controller session appears, then ends (any reason: handover,
        // failure, the user hanging up). Only the ENDING is a reason to look.
        await act(async () => { sessionListener!([{ id: 's1', role: 'controller', phase: 'active' }]); });
        await settle();
        expect(listDevices.mock.calls.length).toBe(before);
        await act(async () => { sessionListener!([{ id: 's1', role: 'controller', phase: 'ended' }]); });
        await settle();
        expect(listDevices.mock.calls.length).toBe(before + 1);
    });

    it('positive control: a host session of ours ending is not a reason (that is the other side\'s list)', async () => {
        listDevices.mockResolvedValue([appRow(true)]);
        await mount();
        const before = listDevices.mock.calls.length;
        await act(async () => { sessionListener!([{ id: 'h1', role: 'host', phase: 'active' }]); });
        await act(async () => { sessionListener!([]); });
        await settle();
        expect(listDevices.mock.calls.length).toBe(before);
    });
});
