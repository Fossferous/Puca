/**
 * What happens when the Wake button is PRESSED — the two defects that made
 * it "do nothing".
 *
 * Field report after 0.8.82: "selecting Wake did nothing", then after a
 * restart and a wait it appeared and "didn't work". Two real causes, both here:
 *
 *  1. a `failed` card swallowed every further press — `attemptInFlight`
 *     counted ANY stored state, and a failure stays stored until Dismiss;
 *  2. a Wake sent on a closed socket was reported as relayed — the frame was
 *     silently dropped, the card waited 180 s, and the result queue gained a
 *     ghost entry that shifted every LATER verdict onto the wrong card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let socketOpen = true;
const sent: object[] = [];
const wsHandlers = new Map<string, Array<(m: unknown) => void>>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        send: (m: object) => { if (!socketOpen) return false; sent.push(m); return true; },
        on: (t: string, h: (m: unknown) => void) => {
            wsHandlers.set(t, [...(wsHandlers.get(t) ?? []), h]);
        },
        off: () => {},
    },
}));

vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));

vi.mock('../api/devices/index', () => ({
    listDevices: () => Promise.resolve([]),
}));

vi.mock('../api/devices/session', () => ({
    connectToDevice: () => Promise.resolve(),
}));

import {
    wakeAndConnect,
    subscribeWakes,
    cancelWake,
    installWakeResultListener,
    timeoutMessage,
    __resetWakeSessionsForTests,
    type WakeState,
} from '../api/devices/wakeSession';
import type { VerifiedDevice } from '../api/devices';

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

const LAN = (mac: string, ip: string) =>
    JSON.stringify({ mac, ip, subnet: ip.split('.').slice(0, 3).join('.'), broadcast: '192.168.0.255' });

// A powered-off target with a MAC, and an online Linux waker on the same subnet.
const target = () => dev({ id: 'pc', name: 'PC', online: false, lan_info: LAN('AA:BB:CC:DD:EE:FF', '192.168.0.10') });
const waker = () => dev({ id: 'waker', name: 'Home Waker', platform: 'linux', lan_info: LAN('11:22:33:44:55:66', '192.168.0.30') });

let latest: ReadonlyMap<string, WakeState> = new Map();
subscribeWakes(s => { latest = s; });
installWakeResultListener();

function result(ok: boolean, message?: string): void {
    for (const h of wsHandlers.get('DeviceWakeResult') ?? []) h({ payload: { ok, message } });
}

beforeEach(() => {
    __resetWakeSessionsForTests();
    socketOpen = true;
    sent.length = 0;
    latest = new Map();
    subscribeWakes(s => { latest = s; });
});

describe('pressing Wake after a failure', () => {
    it('starts a NEW attempt instead of silently doing nothing', async () => {
        // First press: relayed, then refused by the server -> the card is failed.
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(sent).toHaveLength(1);
        result(false, "that device isn't online to send the wake packet");
        expect(latest.get('pc')?.phase).toBe('failed');

        // Second press, WITHOUT dismissing. This used to return at the top of
        // wakeAndConnect because a state existed, and the user saw nothing.
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(sent).toHaveLength(2);
        expect(latest.get('pc')?.phase).toBe('waiting');
        cancelWake('pc');
    });

    it('still refuses to double-start a wake that is genuinely in flight', async () => {
        // The positive control for the test above: the guard must still guard
        // the case it was written for, or two presses start two waits that
        // orphan each other's timers.
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(latest.get('pc')?.phase).toBe('waiting');
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(sent).toHaveLength(1);
        cancelWake('pc');
    });
});

describe('pressing Wake while the socket is down', () => {
    it('fails at once instead of waiting three minutes on a frame that never left', async () => {
        socketOpen = false;
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(sent).toHaveLength(0);
        expect(latest.get('pc')?.phase).toBe('failed');
        expect(latest.get('pc')?.message).toMatch(/not connected/i);
    });

    it('does not leave a ghost in the result queue that misfiles the next verdict', async () => {
        // Sent on a dead socket: dropped, and must NOT be queued.
        socketOpen = false;
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        cancelWake('pc');

        // Now a real wake for a DIFFERENT machine, refused by the server. Its
        // verdict must land on IT — not be swallowed by the ghost entry above.
        socketOpen = true;
        const other = dev({ id: 'other', name: 'Other', online: false, lan_info: LAN('01:02:03:04:05:06', '192.168.0.11') });
        await wakeAndConnect(other, [other, waker()], 'phone', 1);
        result(false, 'refused');
        expect(latest.get('other')?.phase).toBe('failed');
        expect(latest.get('other')?.message).toBe('refused');
    });

    it('a real relay still reaches the wait — the positive control', async () => {
        socketOpen = true;
        await wakeAndConnect(target(), [target(), waker()], 'phone', 1);
        expect(sent).toHaveLength(1);
        result(true);
        expect(latest.get('pc')?.phase).toBe('waiting');
        cancelWake('pc');
    });
});

describe('the three-minute verdict', () => {
    it('blames the wake only when a sign-in row was actually being watched', () => {
        // With sign-in access grouped in, a machine that boots to the login
        // screen is reachable at once — so silence really does mean it did not
        // wake, and saying so is honest.
        const watched = timeoutMessage('PC', true);
        expect(watched).toMatch(/did not wake it/);
        expect(watched).not.toMatch(/may have woken/);
    });

    it('admits it might have woken invisibly when no sign-in row was watched', () => {
        // THE OVERCLAIM THIS FIXES. Without a grouped sign-in row, a cold boot
        // stops at a login screen the wait cannot see. Telling the user "the
        // packet did not wake it" then sends them to reflash their BIOS over
        // a software gap. The message must point at enrolling sign-in access
        // instead.
        const unwatched = timeoutMessage('PC', false);
        expect(unwatched).toMatch(/may have woken/);
        expect(unwatched).toMatch(/Reach this computer after it restarts/);
        expect(unwatched).not.toMatch(/means the packet did not wake it/);
    });

    it('carries the firmware checklist in both cases', () => {
        // Whichever branch, the BIOS/NIC/Fast-Startup checklist stays: it is
        // the most likely real cause of a genuine non-wake, and it is the
        // part only the user can act on.
        for (const watched of [true, false]) {
            const m = timeoutMessage('PC', watched);
            expect(m).toMatch(/Fast Startup/);
            expect(m).toMatch(/BIOS/);
            expect(m).toContain('PC');
        }
    });
});
