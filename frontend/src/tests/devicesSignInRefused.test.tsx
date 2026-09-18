/**
 * Devices view ▸ This device ▸ "Reach this computer after it restarts" — the
 * server's side of the box.
 *
 * THE INCIDENT. The box showed ticked for ten days while the server refused
 * this machine's own key on every attempt; the only trace was a service log.
 * The box reads files on this machine, so it was not lying about them — it
 * just could not see the server. The warning pinned here is what can.
 *
 * Rules pinned: the warning appears only when enrolled AND the refusal is
 * persistent (two refusals ten minutes apart); a single refusal, or two close
 * together, shows nothing; the text names the two on-screen controls exactly,
 * so the owner can follow it; and it never says the device was revoked, since
 * the same refusal comes back for a server fault.
 *
 * Rig: devicesUnattended.test.tsx's, with lockScreen mocked at the module
 * boundary (lockScreenSupported() is isTauri(), false under jsdom, so the
 * card would otherwise never mount). The rule itself is the REAL one — the
 * linkHealth module is not mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VerifiedDevice } from '../api/devices';
import type { UnattendedAccessState } from '../api/devices/lockScreen';

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
vi.mock('../api/devices/lockScreen', async () => {
    const real = await vi.importActual<typeof import('../api/devices/lockScreen')>('../api/devices/lockScreen');
    return {
        ...real,
        lockScreenSupported: () => true,
        lockScreenState: async () => ({ installed: true, running: true, available: true, problem: null }),
        unattendedAccessState: () => unattendedAccessState(),
        bundledServiceFingerprint: async () => ({ hash: null, error: null }),
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

const T = 1_757_000_000; // a fixed unix time; only differences matter

function state(over: Partial<UnattendedAccessState>): UnattendedAccessState {
    return {
        serviceInstalled: true,
        enrolled: true,
        armed: true,
        deviceId: 'signin-row',
        binsHash: null,
        linkAttestedAt: null,
        linkRefusedFirst: null,
        linkRefusedLast: null,
        linkRefusedCount: 0,
        linkRefusedStatus: null,
        error: null,
        ...over,
    };
}

const PERSISTENT = {
    linkRefusedFirst: T, linkRefusedLast: T + 900, linkRefusedCount: 2, linkRefusedStatus: 400,
};

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DevicesView onClose={() => {}} />); });
    await act(async () => { await Promise.resolve(); });
    const banner = host.querySelector('.device-error');
    if (banner) {
        throw new Error(`DevicesView failed to load, so nothing below is being tested: ${banner.textContent}`);
    }
    const tabBtn = [...host.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === 'This device');
    if (!tabBtn) throw new Error('DevicesView rendered without a This-device tab');
    await act(async () => {
        tabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
    });
    // PRECONDITION: the card this warning lives in is on screen, so every
    // "no warning" below is about the rule and not about a card that never
    // rendered.
    expect(host.textContent, 'the enrolment card must be on screen')
        .toContain('Reach this computer after it restarts');
}

const notice = () => host?.querySelector('[data-testid="signin-refused"]') ?? null;

beforeEach(() => {
    vi.clearAllMocks();
    listDevices.mockResolvedValue([device()]);
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

describe('the sign-in-screen refusal warning', () => {
    it('shows for an enrolled machine the server has persistently refused', async () => {
        unattendedAccessState.mockResolvedValue(state({ ...PERSISTENT, linkAttestedAt: T - 86_400 }));
        await mount();
        const n = notice();
        expect(n, 'the warning must be shown').toBeTruthy();
        const text = n!.textContent ?? '';
        expect(text).toContain('is not accepting this computer at its sign-in screen');
        expect(text).toContain(`since ${new Date(T * 1000).toLocaleDateString()}`);
        // The exact labels of the two controls it tells the owner to use.
        expect(text).toContain('untick “Reach this computer after it restarts”');
        expect(text).toContain('“Passphrase for the sign-in screen”');
        expect(text).toContain(`It last connected on ${new Date((T - 86_400) * 1000).toLocaleDateString()}`);
        // It must not claim what it cannot know.
        expect(text.toLowerCase()).not.toContain('revoked');
        // An icon from Icons.tsx, not an emoji.
        expect(n!.querySelector('svg'), 'the warning carries the WarningIcon').toBeTruthy();
    });

    it('POSITIVE CONTROL: an enrolled machine with nothing refused shows no warning', async () => {
        unattendedAccessState.mockResolvedValue(state({}));
        await mount();
        expect(notice()).toBeNull();
    });

    it('a single refusal shows nothing', async () => {
        unattendedAccessState.mockResolvedValue(state({
            linkRefusedFirst: T, linkRefusedLast: T, linkRefusedCount: 1, linkRefusedStatus: 400,
        }));
        await mount();
        expect(notice()).toBeNull();
    });

    it('two refusals within ten minutes show nothing', async () => {
        unattendedAccessState.mockResolvedValue(state({
            linkRefusedFirst: T, linkRefusedLast: T + 599, linkRefusedCount: 2, linkRefusedStatus: 400,
        }));
        await mount();
        expect(notice()).toBeNull();
    });

    it('an unticked box has nothing to warn about', async () => {
        unattendedAccessState.mockResolvedValue(state({ ...PERSISTENT, enrolled: false, armed: false }));
        await mount();
        expect(notice()).toBeNull();
    });

    it('an older service, which reports none of it, shows nothing', async () => {
        const old = state({}) as Partial<UnattendedAccessState>;
        delete old.linkRefusedFirst;
        delete old.linkRefusedLast;
        delete old.linkRefusedCount;
        unattendedAccessState.mockResolvedValue(old as UnattendedAccessState);
        await mount();
        expect(notice()).toBeNull();
    });
});
