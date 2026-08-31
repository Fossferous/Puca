/**
 * Devices view ▸ This device ▸ Unattended access.
 *
 * The passphrase here is the only thing between an account compromise and
 * SYSTEM-level control of this machine, and it has NO remote recovery. So the
 * cases worth pinning are not cosmetic: that the warning is shown before arming
 * rather than after, that a weak passphrase is refused, that the passphrase is
 * not left sitting in component state, and that a failed arm does not report
 * success.
 *
 * Mocked at the module boundary (like devicesForwarding.test.tsx) because
 * unattendedSupported() is isTauri(), false under jsdom, so the control would
 * otherwise never mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';

const listDevices = vi.fn();
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
    currentUserId: () => 42,
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'thisDev' }));
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
vi.mock('../api/devices/tunnel', () => ({
    getTunnelPolicy: vi.fn().mockResolvedValue({ enabled: false, allowed: [] }),
    setTunnelForwarding: vi.fn().mockResolvedValue(null),
    tunnelSupported: () => false,
}));

const armUnattended = vi.fn();
const disarmUnattended = vi.fn();
const unattendedState = vi.fn();
const unattendedSupported = vi.fn<() => boolean>(() => true);
vi.mock('../api/devices/unattendedHost', () => ({
    armUnattended: (...a: unknown[]) => armUnattended(...a),
    disarmUnattended: (...a: unknown[]) => disarmUnattended(...a),
    unattendedState: (...a: unknown[]) => unattendedState(...a),
    unattendedSupported: () => unattendedSupported(),
}));

const { DevicesView } = await import('../components/DevicesView');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function device(): VerifiedDevice {
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
    } as VerifiedDevice;
}

/**
 * `tab`: the unattended CARD lives on the This-device tab ('setup', the
 * default here); the device LIST with its Armed badge is the grid tab
 * ('grid'). A test that asserts a control is ABSENT must be on the tab that
 * would show it, or the assertion passes vacuously.
 */
async function mount(tab: 'setup' | 'grid' = 'setup') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DevicesView onClose={() => {}} />); });
    await act(async () => { await Promise.resolve(); });
    // PRECONDITION. The component catches anything refresh() throws into an
    // error banner and renders an empty list, so a broken mock produces a page
    // with none of the controls these tests look for — and every "not present"
    // assertion then passes for the wrong reason. That is not hypothetical: it
    // happened to all 12 tests in this file and its sibling the moment a new
    // export was added to ../api/devices and not mirrored in the mock below.
    const banner = host.querySelector('.device-error');
    if (banner) {
        throw new Error(
            `DevicesView failed to load, so nothing below is being tested: ${banner.textContent}`,
        );
    }
    if (tab === 'setup') {
        const tabBtn = [...host.querySelectorAll('button')]
            .find(b => b.textContent?.trim() === 'This device');
        if (!tabBtn) throw new Error('DevicesView rendered without a This-device tab');
        await act(async () => {
            tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await Promise.resolve();
        });
    }
}

const q = <T extends Element>(sel: string) => host?.querySelector<T>(sel) ?? null;

/**
 * Type into a REACT-CONTROLLED input.
 *
 * Assigning `.value` directly does not work: React installs its own value setter
 * on the element prototype and tracks the last value it wrote, so a raw
 * assignment is seen as "no change" and onChange never fires. The component then
 * keeps its old state and the test asserts against a value the component never
 * received -- which is how an earlier version of this file "passed" while
 * actually submitting an empty passphrase.
 */
function typeInto(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonWith(text: string): HTMLButtonElement | undefined {
    return [...(host?.querySelectorAll('button') ?? [])].find(
        b => (b.textContent ?? '').trim() === text,
    ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
    vi.clearAllMocks();
    unattendedSupported.mockReturnValue(true);
    listDevices.mockResolvedValue([device()]);
    unattendedState.mockResolvedValue({ armed: false, salt: null });
    armUnattended.mockResolvedValue(null);
    disarmUnattended.mockResolvedValue(null);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('unattended access arming', () => {
    it('states the no-remote-recovery cost BEFORE anything is armed', async () => {
        // The one sentence people regret not reading. It must be on screen in
        // the disarmed state, not revealed after committing.
        await mount();
        const warning = q('.device-unattended-warning')?.textContent ?? '';
        expect(warning.toLowerCase()).toContain('no way to recover');
        expect(buttonWith('Set up')).toBeTruthy();
    });

    it('refuses a weak passphrase without arming', async () => {
        // Enforced in the API layer, so the UI cannot bypass it; here we assert
        // the refusal surfaces and nothing is stored.
        armUnattended.mockResolvedValue('Use at least 8 characters — this is the only thing protecting unattended access.');
        await mount();
        await act(async () => { buttonWith('Set up')!.click(); });
        const input = q<HTMLInputElement>('#device-ua-pass')!;
        await act(async () => { typeInto(input, 'short'); });
        await act(async () => { buttonWith('Arm')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(host?.textContent).toContain('at least 8 characters');
        // Still offering to arm, i.e. it did NOT flip to the armed state.
        expect(buttonWith('Turn off')).toBeFalsy();
    });

    it('arms, clears the passphrase from state, and re-reads', async () => {
        await mount();
        await act(async () => { buttonWith('Set up')!.click(); });
        const input = q<HTMLInputElement>('#device-ua-pass')!;
        await act(async () => { typeInto(input, 'a good long passphrase'); });
        unattendedState.mockResolvedValue({ armed: true, salt: 'AAAA' });
        await act(async () => { buttonWith('Arm')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(armUnattended).toHaveBeenCalledWith('a good long passphrase');
        // Re-read rather than trusting the write — the record lives outside the
        // webview precisely so JS is not the authority on it.
        expect(unattendedState).toHaveBeenCalledTimes(2);
        expect(buttonWith('Turn off')).toBeTruthy();
        // The passphrase must not still be sitting in the DOM.
        expect(q<HTMLInputElement>('#device-ua-pass')).toBeNull();
        expect(host?.textContent).not.toContain('a good long passphrase');
    });

    it('does not report success when arming fails', async () => {
        // The dangerous lie: the UI says armed, the machine is not, and the user
        // believes unattended access is protected when it is simply off.
        armUnattended.mockResolvedValue('could not write the record');
        await mount();
        await act(async () => { buttonWith('Set up')!.click(); });
        const input = q<HTMLInputElement>('#device-ua-pass')!;
        await act(async () => { typeInto(input, 'a good long passphrase'); });
        await act(async () => { buttonWith('Arm')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(host?.textContent).toContain('could not write the record');
        expect(buttonWith('Turn off')).toBeFalsy();
        expect(unattendedState).toHaveBeenCalledTimes(1);
    });

    it('shows the armed state and can turn it off', async () => {
        unattendedState.mockResolvedValue({ armed: true, salt: 'AAAA' });
        await mount();
        expect(buttonWith('Turn off')).toBeTruthy();

        unattendedState.mockResolvedValue({ armed: false, salt: null });
        await act(async () => { buttonWith('Turn off')!.click(); });
        await act(async () => { await Promise.resolve(); });

        expect(disarmUnattended).toHaveBeenCalled();
        expect(buttonWith('Set up')).toBeTruthy();
    });

    it('is hidden where unattended hosting cannot work', async () => {
        unattendedSupported.mockReturnValue(false);
        await mount();
        expect(q('.device-unattended')).toBeNull();
    });

    /**
     * WHICH MACHINE DOES THIS ARM? Arming is device-local — the record is written
     * to this computer's disk, and no code anywhere can arm another device — but
     * the card sat unlabelled above the list of every enrolled device, reading
     * like a setting for whichever one the user had in mind. Someone who armed
     * their laptop and then tried to reach their desktop got no passphrase
     * prompt and no explanation, because the desktop was never armed.
     */
    it('names the machine it arms, and says it arms only that one', async () => {
        await mount();
        const card = q('.device-unattended');
        expect(card?.textContent).toContain('Zeus-PC');
        expect(card?.textContent).toContain('this computer only');
    });

    it('marks THIS device as armed in the list, and never any other', async () => {
        listDevices.mockResolvedValue([
            device(),
            { ...device(), id: 'otherDev', name: 'Laptop', isThisDevice: false },
        ]);
        unattendedState.mockResolvedValue({ armed: true, salt: 'AAAA' });
        await mount('grid');

        const rows = [...(host?.querySelectorAll('.device-row') ?? [])];
        const armed = rows.filter(r => (r.textContent ?? '').includes('Armed'));
        expect(armed).toHaveLength(1);
        expect(armed[0].textContent).toContain('Zeus-PC');
        // The other machine's armed state lives on ITS disk and is never
        // reported to the server, so claiming to know it would be a guess.
        expect(rows.find(r => (r.textContent ?? '').includes('Laptop'))?.textContent)
            .not.toContain('Armed');
    });

    it('does not claim this device is armed when it is not', async () => {
        unattendedState.mockResolvedValue({ armed: false, salt: null });
        await mount('grid');
        expect(host?.querySelector('.device-row')?.textContent).not.toContain('Armed');
    });
});
