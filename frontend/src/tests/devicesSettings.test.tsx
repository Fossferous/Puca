/**
 * Devices view behaviour (the device grid and its actions).
 *
 * Mounted the way the repo's other component tests do it — raw
 * `react-dom/client` + `act`, no @testing-library/react (not a dependency here).
 *
 * The load-bearing case is the unverified device: a row whose enrolment
 * signature did not check out means the server returned a device this account
 * never signed for. It must be SHOWN and flagged, never filtered — filtering
 * would turn a misbehaving server into an invisible one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';

const listDevices = vi.fn();
const renameDevice = vi.fn();
const revokeDevice = vi.fn();
const currentUserId = vi.fn<() => number | null>(() => 42);
const thisDeviceId = vi.fn<() => string | null>(() => 'thisDev');
const deviceKeyCustody = vi.fn<() => 'os-protected' | 'browser-storage'>(() => 'os-protected');

const isThisDeviceRevoked = vi.fn(() => false);
const resetThisDeviceIdentity = vi.fn(async () => null);
vi.mock('../api/devices', () => ({
    listDevices: (...a: unknown[]) => listDevices(...a),
    renameDevice: (...a: unknown[]) => renameDevice(...a),
    revokeDevice: (...a: unknown[]) => revokeDevice(...a),
    currentUserId: () => currentUserId(),
    thisDeviceId: () => thisDeviceId(),
    isThisDeviceRevoked: () => isThisDeviceRevoked(),
    resetThisDeviceIdentity: (...a: unknown[]) => resetThisDeviceIdentity(...a),
}));
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyCustody: () => deviceKeyCustody(),
}));
const connectToDevice = vi.fn();
// DevicesView prefetches the ICE config on mount to take a round trip off
// the first Control click. Unmocked it is a REAL fetch to API_BASE_URL from
// every test in this file — slow, noisy, and dependent on the machine's
// network. The component ignores its failure by design, so a stub is enough.
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn().mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' }),
}));
vi.mock('../api/devices/session', () => ({
    connectToDevice: (...a: unknown[]) => connectToDevice(...a),
    // The view watches for its sessions ending (to refresh the list); no
    // session ever exists in these tests.
    subscribeSessions: () => () => {},
}));

const { DevicesView } = await import('../components/DevicesView');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function device(over: Partial<VerifiedDevice> = {}): VerifiedDevice {
    return {
        id: 'dev1',
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
        online: false,
        verified: true,
        isThisDevice: false,
        ...over,
    };
}

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<DevicesView onClose={() => {}} />);
    });
    // Let the load effect's promise settle and re-render.
    await act(async () => { await Promise.resolve(); });
}

/** The key-custody card lives on the This-device tab; the grid is default. */
async function switchToThisDevice() {
    const tab = [...(host?.querySelectorAll('button') ?? [])]
        .find(b => b.textContent?.trim() === 'This device');
    expect(tab, 'expected the This-device tab to exist').toBeTruthy();
    await act(async () => {
        tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
    });
}

const text = () => host?.textContent ?? '';
const buttons = () => Array.from(host?.querySelectorAll('button') ?? []);
const buttonNamed = (label: string) =>
    buttons().find(b => b.textContent?.trim() === label);

async function click(el: Element | undefined) {
    expect(el, 'expected the button to exist').toBeTruthy();
    await act(async () => {
        el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
    });
}

/** Control re-reads the list and re-folds it before it picks a row — a few
 *  more promise hops than a plain click. Flush them without depending on
 *  timers, so this also works under fake timers. */
async function settle() {
    await act(async () => {
        for (let i = 0; i < 16; i++) await Promise.resolve();
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    currentUserId.mockReturnValue(42);
    thisDeviceId.mockReturnValue('thisDev');
    deviceKeyCustody.mockReturnValue('os-protected');
    listDevices.mockResolvedValue([]);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('Devices settings', () => {
    it('lists enrolled devices', async () => {
        listDevices.mockResolvedValue([
            device({ name: 'Zeus-PC' }),
            device({ id: 'd2', name: 'Phone', platform: 'android' }),
        ]);
        await mount();
        expect(text()).toContain('Zeus-PC');
        expect(text()).toContain('Phone');
    });

    it('shows AND flags a device that failed verification', async () => {
        listDevices.mockResolvedValue([device({ name: 'Unknown box', verified: false })]);
        await mount();
        expect(text()).toContain('Unknown box');
        expect(text()).toMatch(/could not verify this device was enrolled by you/i);
        expect(host!.querySelector('.device-row-unverified')).toBeTruthy();
    });

    it('does not flag a verified device', async () => {
        listDevices.mockResolvedValue([device({ verified: true })]);
        await mount();
        expect(text()).not.toMatch(/could not verify/i);
        expect(host!.querySelector('.device-row-unverified')).toBeNull();
    });

    it('states plainly when the key is only in browser storage', async () => {
        // Custody decides whether a device may ever act as an unattended host,
        // so the weaker case is spelled out rather than left to inference.
        deviceKeyCustody.mockReturnValue('browser-storage');
        await mount();
        await switchToThisDevice();
        expect(text()).toMatch(/browser storage/i);
        expect(text()).toMatch(/cannot be controlled themselves/i);
    });

    it('requires confirmation before revoking', async () => {
        listDevices.mockResolvedValue([device()]);
        await mount();
        await click(buttonNamed('Revoke'));
        // The first click only arms the confirmation.
        expect(revokeDevice).not.toHaveBeenCalled();

        await click(buttonNamed('Confirm revoke'));
        expect(revokeDevice).toHaveBeenCalledWith('dev1');
    });

    it('warns before you revoke the device you are using', async () => {
        listDevices.mockResolvedValue([device({ id: 'thisDev', isThisDevice: true })]);
        await mount();
        await click(buttonNamed('Revoke'));
        expect(text()).toMatch(/this is the device you are using/i);
        expect(buttonNamed('Sign this device out')).toBeTruthy();
    });

    it('renames on Enter', async () => {
        listDevices.mockResolvedValue([device()]);
        renameDevice.mockResolvedValue(device({ name: 'Study PC' }));
        await mount();
        await click(buttonNamed('Rename'));

        const input = host!.querySelector('input.device-name-input') as HTMLInputElement;
        expect(input).toBeTruthy();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(input, 'Study PC');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(renameDevice).toHaveBeenCalledWith('dev1', 'Study PC');
    });

    it('treats an all-whitespace rename as a cancel rather than sending it', async () => {
        // The server rejects an empty name; without this the user is stuck in an
        // edit box they cannot leave.
        listDevices.mockResolvedValue([device()]);
        await mount();
        await click(buttonNamed('Rename'));

        const input = host!.querySelector('input.device-name-input') as HTMLInputElement;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(input, '   ');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(renameDevice).not.toHaveBeenCalled();
        expect(host!.querySelector('input.device-name-input')).toBeNull();
    });

    it('surfaces a load failure instead of silently rendering an empty list', async () => {
        listDevices.mockRejectedValue(new Error('network down'));
        await mount();
        const alert = host!.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('network down');
    });

    describe('the Control action', () => {
        // Offering Control for a device that cannot take it produces a
        // connection that fails AFTER the user has committed to it — so the
        // button is gated on all three conditions, not just online.
        it('is offered for an online, verified, other device', async () => {
            listDevices.mockResolvedValue([device({ online: true, verified: true })]);
            await mount();
            expect(buttonNamed('Control')).toBeTruthy();
            await click(buttonNamed('Control'));
            await settle();
            expect(connectToDevice).toHaveBeenCalledWith('dev1', undefined);
        });

        it('decides the row from a FRESH list, not the one the card was painted from', async () => {
            // The card was painted with the device online. By the time
            // Control is pressed the machine has gone — the exact shape of
            // pressing Control right after a PC's sign-in row stood down.
            listDevices.mockResolvedValueOnce([device({ online: true, verified: true })]);
            await mount();
            expect(buttonNamed('Control')).toBeTruthy();
            listDevices.mockResolvedValue([device({ online: false, verified: true })]);
            await click(buttonNamed('Control'));
            await settle();
            // Not "that device isn't online" from the server after a
            // round trip: no connect at all, an honest line, and the card
            // repainted from what the click just learned.
            expect(connectToDevice).not.toHaveBeenCalled();
            expect(host!.querySelector('[role="alert"]')?.textContent).toContain('is not reachable right now');
            expect(buttonNamed('Control')).toBeFalsy();
        });

        it('is NOT offered for an offline device', async () => {
            listDevices.mockResolvedValue([device({ online: false, verified: true })]);
            await mount();
            expect(buttonNamed('Control')).toBeFalsy();
        });

        it('is NOT offered for an unverified device', async () => {
            listDevices.mockResolvedValue([device({ online: true, verified: false })]);
            await mount();
            expect(buttonNamed('Control')).toBeFalsy();
        });

        it('is NOT offered for the device you are sitting at', async () => {
            listDevices.mockResolvedValue([
                device({ id: 'thisDev', isThisDevice: true, online: true, verified: true }),
            ]);
            await mount();
            expect(buttonNamed('Control')).toBeFalsy();
        });

        it('surfaces a connect failure instead of failing silently', async () => {
            listDevices.mockResolvedValue([device({ online: true, verified: true })]);
            connectToDevice.mockRejectedValue(new Error('not enrolled yet'));
            await mount();
            await click(buttonNamed('Control'));
            await settle();
            expect(host!.querySelector('[role="alert"]')?.textContent).toContain('not enrolled yet');
        });
    });

    it('asks the user to sign in when there is no session', async () => {
        currentUserId.mockReturnValue(null);
        await mount();
        expect(host!.querySelector('[role="alert"]')?.textContent).toMatch(/sign in/i);
        expect(listDevices).not.toHaveBeenCalled();
    });
});

/**
 * The view polls presence every 15s, which is new — DevicesSettings loaded once
 * on mount. Everything below exists because that poll now runs CONCURRENTLY
 * with the user's own actions, and each of these was a real defect found by
 * reviewing the diff rather than a hypothetical.
 */
describe('the presence poll', () => {
    it('does not erase the error from an action the user just took', async () => {
        // `error` is the only surface for "Revoke failed" and friends. Clearing
        // it on every successful poll wiped the explanation within 15 seconds
        // of the user causing it — often before it could be read.
        //
        // FAKE TIMERS ARE THE POINT. An earlier version of this test only
        // awaited a couple of microtasks and passed with the fix REVERTED,
        // because a failed revoke never calls refresh() — so no successful poll
        // ever ran and there was nothing to erase the error. It has to advance
        // the real interval.
        vi.useFakeTimers();
        try {
            listDevices.mockResolvedValue([device({ online: true, verified: true })]);
            revokeDevice.mockRejectedValue(new Error('permission denied'));
            await mount();

            await click(buttonNamed('Revoke'));
            await click(buttonNamed('Confirm revoke'));
            expect(text()).toContain('permission denied');

            // Past one poll interval, with its promises flushed.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(16_000);
            });

            expect(listDevices.mock.calls.length, 'the poll must actually have run')
                .toBeGreaterThan(1);
            expect(
                text(),
                'a successful device list must not clear an action failure',
            ).toContain('permission denied');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the devices it has when a later load fails', async () => {
        // Wiping the grid on a blip turns transient network noise into "all my
        // machines vanished". Driven through the real path a mutation takes:
        // revoke succeeds, then its follow-up refresh fails.
        listDevices.mockResolvedValue([device({ name: 'Zeus-PC' })]);
        revokeDevice.mockResolvedValue(undefined);
        await mount();
        expect(text()).toContain('Zeus-PC');

        listDevices.mockRejectedValue(new Error('network down'));
        await click(buttonNamed('Revoke'));
        await click(buttonNamed('Confirm revoke'));
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });

        expect(revokeDevice).toHaveBeenCalled();
        expect(text()).toContain('network down');
        expect(
            text(),
            'a failed refresh must report, not destroy the list it already had',
        ).toContain('Zeus-PC');
    });

    /**
     * POSITIVE CONTROL for the test above. Without it, a component that never
     * rendered device names at all — or a mock that never rejected — would
     * satisfy "still contains Zeus-PC" while proving nothing about retention.
     */
    it('really does surface a first-load failure with no devices to keep', async () => {
        listDevices.mockRejectedValue(new Error('network down'));
        await mount();
        expect(host!.querySelector('[role="alert"]')?.textContent).toContain('network down');
        expect(text()).not.toContain('Zeus-PC');
    });
});


describe('a device that was signed out', () => {
    /**
     * Revocation now sticks: the client keeps its keypair, so it derives the same
     * id and gets the same 403 forever. That is the point — but it means a
     * machine revoked by mistake has no way back unless the UI provides one, and
     * "no way back" with only a console warning is a support call, not a
     * security property.
     */
    it('offers a deliberate way to add this machine again', async () => {
        isThisDeviceRevoked.mockReturnValue(true);
        listDevices.mockResolvedValue([device({ name: 'Zeus-PC' })]);

        await mount();

        expect(host!.textContent).toContain('This device was signed out');
        const again = [...host!.querySelectorAll('button')]
            .find(b => b.textContent?.includes('Add this device again'));
        expect(again, 'expected the re-add button to exist').toBeTruthy();

        await click(again);

        expect(resetThisDeviceIdentity).toHaveBeenCalled();
    });

    /**
     * The control must NOT appear otherwise, or it is an invitation to rotate a
     * healthy device's identity for no reason — which would orphan its entry in
     * everyone else's list.
     */
    it('shows nothing when this device is fine', async () => {
        isThisDeviceRevoked.mockReturnValue(false);
        listDevices.mockResolvedValue([device({ name: 'Zeus-PC' })]);

        await mount();

        expect(host!.textContent).not.toContain('This device was signed out');
    });
});
