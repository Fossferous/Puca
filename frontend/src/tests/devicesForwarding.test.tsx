/**
 * Devices view ▸ This device ▸ "Allow port forwarding to this computer".
 *
 * A SEPARATE file from devicesSettings.test.tsx because this one must mock
 * `../api/devices/tunnel` to make the control render at all: `tunnelSupported()`
 * is `isTauri()`, which is false under jsdom, so in the main suite the toggle is
 * never mounted and would be silently untested — the same gap the autostart
 * toggle currently sits in.
 *
 * Why bother testing a checkbox: this one arms a LATERAL-MOVEMENT primitive. The
 * cases that matter are that it reflects stored state rather than assuming, that
 * a failed write surfaces instead of showing a lie, and that it reads back
 * rather than trusting its own write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';

const listDevices = vi.fn();
const currentUserId = vi.fn<() => number | null>(() => 42);
const thisDeviceId = vi.fn<() => string | null>(() => 'thisDev');

vi.mock('../api/devices', () => ({
    // Must mirror the real module's exports: DevicesView calls this during
    // refresh(), and a missing key makes refresh() throw, which the component
    // catches into an error banner — every assertion below then passes against a
    // component that rendered nothing. That is exactly what happened when
    // isThisDeviceRevoked was added.
    isThisDeviceRevoked: () => false,
    resetThisDeviceIdentity: async () => null,
    listDevices: (...a: unknown[]) => listDevices(...a),
    renameDevice: vi.fn(),
    revokeDevice: vi.fn(),
    currentUserId: () => currentUserId(),
    thisDeviceId: () => thisDeviceId(),
}));
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyCustody: () => 'os-protected' as const,
}));
// DevicesView prefetches the ICE config on mount to take a round trip off
// the first Control click. Unmocked it is a REAL fetch to API_BASE_URL from
// every test in this file — slow, noisy, and dependent on the machine's
// network. The component ignores its failure by design, so a stub is enough.
vi.mock('../api/iceConfig', () => ({
    fetchIceConfig: vi.fn().mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));
vi.mock('../api/devices/session', () => ({ connectToDevice: vi.fn(), subscribeSessions: () => () => {} }));

const getTunnelPolicy = vi.fn();
const setTunnelForwarding = vi.fn();
const tunnelSupported = vi.fn<() => boolean>(() => true);
vi.mock('../api/devices/tunnel', () => ({
    getTunnelPolicy: (...a: unknown[]) => getTunnelPolicy(...a),
    setTunnelForwarding: (...a: unknown[]) => setTunnelForwarding(...a),
    tunnelSupported: () => tunnelSupported(),
}));

const { DevicesView } = await import('../components/DevicesView');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function device(over: Partial<VerifiedDevice> = {}): VerifiedDevice {
    return {
        id: 'thisDev',
        device_pub: 'x25519:AAA',
        sign_pub: 'ed25519:BBB',
        name: 'Zeus-PC',
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
        ...over,
    } as VerifiedDevice;
}

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<DevicesView onClose={() => {}} />);
    });
    // Let the load effects settle.
    await act(async () => { await Promise.resolve(); });
    // PRECONDITION. The component catches anything refresh() throws into an
    // error banner and renders an empty list, so a broken mock produces a page
    // with none of the controls these tests look for — and every "not present"
    // assertion passes for the wrong reason. That happened to all 12 tests here
    // and in devicesUnattended the moment a new export was added to
    // ../api/devices and not mirrored in the mock below.
    const banner = host.querySelector('.device-error');
    if (banner) {
        throw new Error(
            `DevicesView failed to load, so nothing below is being tested: ${banner.textContent}`,
        );
    }
    // The forwarding control lives on the This-device tab; the device grid is
    // the default. Not finding the tab is a failure the same way the banner is.
    const tab = [...host.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === 'This device');
    if (!tab) throw new Error('DevicesView rendered without a This-device tab');
    await act(async () => {
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
    });
}

function toggle(): HTMLInputElement | null {
    return host?.querySelector<HTMLInputElement>('#device-forwarding') ?? null;
}

beforeEach(() => {
    vi.clearAllMocks();
    tunnelSupported.mockReturnValue(true);
    listDevices.mockResolvedValue([device()]);
    getTunnelPolicy.mockResolvedValue({ enabled: false, allowed: [] });
    setTunnelForwarding.mockResolvedValue(null);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('port forwarding toggle', () => {
    it('reflects the STORED policy rather than defaulting to a guess', async () => {
        getTunnelPolicy.mockResolvedValue({ enabled: true, allowed: [] });
        await mount();
        expect(toggle()?.checked).toBe(true);
    });

    it('is off when nothing is stored', async () => {
        // Fail-closed all the way to the pixel: if the stored policy says off,
        // or there is none, the box must not appear ticked.
        await mount();
        expect(toggle()?.checked).toBe(false);
    });

    it('is hidden entirely where forwarding cannot work', async () => {
        // A web device has no Rust side and no sockets. Showing a dead control
        // is worse than showing none.
        tunnelSupported.mockReturnValue(false);
        await mount();
        expect(toggle()).toBeNull();
    });

    it('writes the new value and then RE-READS it', async () => {
        await mount();
        getTunnelPolicy.mockResolvedValue({ enabled: true, allowed: [] });
        await act(async () => {
            toggle()!.click();
        });
        await act(async () => { await Promise.resolve(); });

        expect(setTunnelForwarding).toHaveBeenCalledWith(true);
        // Read back, not assumed: the decision is stored outside the webview
        // precisely so JS is not the authority, so JS must not trust its write.
        expect(getTunnelPolicy).toHaveBeenCalledTimes(2);
        expect(toggle()?.checked).toBe(true);
    });

    it('surfaces a failed write instead of showing it as on', async () => {
        // The dangerous failure: the box flips, the user believes forwarding is
        // armed (or disarmed) and it is not. The error must show AND the state
        // must not move.
        setTunnelForwarding.mockResolvedValue('permission denied');
        await mount();
        await act(async () => {
            toggle()!.click();
        });
        await act(async () => { await Promise.resolve(); });

        expect(host?.textContent).toContain('permission denied');
        expect(toggle()?.checked).toBe(false);
        // A failed write must NOT be followed by a re-read that could mask it.
        expect(getTunnelPolicy).toHaveBeenCalledTimes(1);
    });

    it('explains the loopback-only scope in the hint', async () => {
        // The plan requires the UI to state that this does not expose the wider
        // network. If that sentence disappears, the control starts implying a
        // broader grant than it makes.
        await mount();
        const hint = host?.querySelector('.device-option .option-hint')?.textContent ?? '';
        const forwardingHint = [...(host?.querySelectorAll('.device-option') ?? [])]
            .map(el => el.textContent ?? '')
            .find(t => t.includes('port forwarding')) ?? hint;
        expect(forwardingHint.toLowerCase()).toContain('does not open');
    });
});
