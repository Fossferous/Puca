/**
 * The unlock handover's second half: after somebody signs in at a machine's
 * sign-in screen, the controller follows the picture to that machine's
 * desktop-app row.
 *
 * Field report after 0.8.85: "the unattended passphrase from a cold boot did
 * log me in from the lock screen but then again I had to manually reconnect".
 * The follow existed and gave up SILENTLY after ten seconds — fine for
 * unlocking a running desktop, hopeless for the first sign-in after a boot,
 * where the app has to start from nothing (20-60 s). And nothing on screen
 * said a wait was even happening.
 *
 * So the wait now lives beside the wake wait, on the machine's card, with a
 * countdown and a Stop button, for two minutes; and it looks early when the
 * server announces a device attesting. These pin all of that.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../api/e2ee', () => ({
    getActiveIdentity: () => ({ seed: 'test' }),
    openDeviceLan: (_id: unknown, blob: string) => Promise.resolve(blob),
    sealDeviceLan: (_id: unknown, plain: string) => Promise.resolve(plain),
}));

/** The list the poll sees. Tests mutate it between ticks. */
let devices: VerifiedDevice[] = [];
let listCalls = 0;
vi.mock('../api/devices/index', () => ({
    listDevices: () => { listCalls++; return Promise.resolve(devices); },
}));

const connected: string[] = [];
/** How many of the NEXT connect attempts should reject (the unlock-transition
 *  race: the target's first capture-open lands on the still-secure desktop). */
let connectFails = 0;
vi.mock('../api/devices/session', () => ({
    connectToDevice: (id: string) => {
        if (connectFails > 0) {
            connectFails--;
            return Promise.reject(new Error(
                'capture: Access is denied (that computer is showing a Windows security screen)'));
        }
        connected.push(id);
        return Promise.resolve();
    },
}));

import {
    followToDesktop,
    followToSignIn,
    subscribeWakes,
    cancelWake,
    wakePhaseIsLive,
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

const MAC = 'AA:BB:CC:DD:EE:FF';
const LAN = (role: 'app' | 'signin') =>
    JSON.stringify({ mac: MAC, ip: '192.168.0.77', subnet: '192.168.0', broadcast: '192.168.0.255', role });

/** One PC, two rows: the desktop app's (`pc`) and the sign-in service's. */
const appRow = (online: boolean) => dev({ id: 'pc', name: 'PC', online, lan_info: LAN('app') });
const signInRow = (online: boolean) =>
    dev({ id: 'pc-signin', name: 'This PC (sign-in screen)', online, lan_info: LAN('signin') });

let latest: ReadonlyMap<string, WakeState> = new Map();

function presence(): void {
    for (const h of wsHandlers.get('DevicePresence') ?? []) h({ payload: { device_id: 'pc', online: true } });
}

beforeEach(() => {
    vi.useFakeTimers();
    __resetWakeSessionsForTests();
    wsHandlers.clear();
    devices = [];
    listCalls = 0;
    connected.length = 0;
    connectFails = 0;
    latest = new Map();
    subscribeWakes(s => { latest = s; });
});

afterEach(() => {
    __resetWakeSessionsForTests();
    vi.useRealTimers();
});

describe('following a machine from its sign-in screen to its desktop', () => {
    it('reports on the machine\'s card, keyed by the APP row, and connects there when it attests', async () => {
        // The moment after the handover: the sign-in row is still listed as
        // online (its socket close lands a beat later), the app row is not
        // up yet — a first sign-in after a boot.
        devices = [appRow(false), signInRow(true)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);

        // pollNow fired an IMMEDIATE poll: one listDevices for the up-front
        // machine lookup, then a second from the first tick — without waiting
        // out a poll interval. (Delete `pollNow` and this is 1, not >=2.)
        expect(listCalls).toBeGreaterThanOrEqual(2);

        // The card is the PRIMARY (app) row's — that is what DevicesView keys
        // its status line on — not the sign-in row we just left.
        const state = latest.get('pc');
        expect(state, 'status appears on the app row\'s card').toBeTruthy();
        expect(state?.phase).toBe('following');
        expect(wakePhaseIsLive(state?.phase)).toBe(true);
        expect(state?.message).toMatch(/Signed in on PC/);
        expect(state?.secondsLeft).toBe(120);
        expect(latest.has('pc-signin')).toBe(false);
        // It looked at once (pollNow), and did NOT connect back to the
        // sign-in row just because it still reads online.
        expect(connected).toEqual([]);

        // Two polls later the app row attests.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(connected).toEqual([]);
        devices = [appRow(true), signInRow(false)];
        await vi.advanceTimersByTimeAsync(3_000);

        expect(connected).toEqual(['pc']);
        // The stage owns the screen now; the card's status is gone.
        expect(latest.has('pc')).toBe(false);
    });

    it('a transient connect failure RETRIES within the window instead of failing (the unlock-transition race)', async () => {
        // The exact live symptom: PIN accepted, unlock fires, the follow finds
        // the app row online and connects — but the desktop is momentarily
        // still the secure desktop, so the first capture-open is refused. The
        // old code surfaced that single stumble as a terminal "could not
        // connect"; a manual retry a few seconds later worked. Now the follow
        // itself retries.
        devices = [appRow(false), signInRow(true)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);

        // App row attests, but the first connect is refused (desktop settling).
        connectFails = 1;
        devices = [appRow(true), signInRow(false)];
        await vi.advanceTimersByTimeAsync(3_000);

        // NOT terminal — the whole point. Still following, nothing connected,
        // and the deadline is nowhere near spent.
        expect(connected).toEqual([]);
        expect(latest.get('pc')?.phase, 'a single stumble must not end the follow').toBe('following');

        // Next poll: the desktop has settled and the retry connects.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(connected).toEqual(['pc']);
        expect(latest.has('pc'), 'the live session takes over').toBe(false);
    });

    it('waits two minutes, not ten seconds, and then says what happened', async () => {
        devices = [appRow(false), signInRow(false)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);

        // Ten seconds in — the old, silent deadline — it is still waiting,
        // and the countdown has moved.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(latest.get('pc')?.phase).toBe('following');
        expect(latest.get('pc')?.secondsLeft).toBeLessThan(120);
        expect(connected).toEqual([]);

        // Ninety seconds in, still waiting.
        await vi.advanceTimersByTimeAsync(80_000);
        expect(latest.get('pc')?.phase).toBe('following');

        // At two minutes it gives up OUT LOUD, with the likely cause.
        await vi.advanceTimersByTimeAsync(30_000);
        const state = latest.get('pc');
        expect(state?.phase).toBe('failed');
        expect(state?.message).toMatch(/did not come online within two minutes/);
        expect(state?.message).toMatch(/start with Windows/);
        expect(connected).toEqual([]);

        // And it has stopped looking.
        const calls = listCalls;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(listCalls).toBe(calls);
    });

    it('looks early when the server announces a device attesting', async () => {
        devices = [appRow(false), signInRow(false)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);
        const before = listCalls;

        // The app row comes up and the server says so — well inside a poll
        // interval. The wait must not sit out the rest of the interval.
        devices = [appRow(true), signInRow(false)];
        presence();
        await vi.advanceTimersByTimeAsync(0);

        expect(listCalls).toBe(before + 1);
        expect(connected).toEqual(['pc']);
    });

    it('positive control: without the presence frame the same state waits for the poll', async () => {
        devices = [appRow(false), signInRow(false)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);

        devices = [appRow(true), signInRow(false)];
        // No presence frame, no advance: nothing has looked yet.
        await vi.advanceTimersByTimeAsync(0);
        expect(connected).toEqual([]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(connected).toEqual(['pc']);
    });

    it('can be stopped, and a stopped wait neither connects nor reports', async () => {
        devices = [appRow(false), signInRow(false)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(latest.get('pc')?.phase).toBe('following');

        cancelWake('pc');
        expect(latest.has('pc')).toBe(false);

        // The app row comes up afterwards; the cancelled wait must not
        // resurrect the card or open a session behind the user's back.
        devices = [appRow(true), signInRow(false)];
        presence();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(connected).toEqual([]);
        expect(latest.has('pc')).toBe(false);
        // Nor does its listener linger to fire tick() into the void.
        expect(wsHandlers.get('DevicePresence') ?? []).toHaveLength(0);
    });

    it('a timed-out follow card can be DISMISSED (cancelWake clears a failed card)', async () => {
        devices = [appRow(false), signInRow(false)];
        await followToDesktop('pc-signin', 1);
        await vi.advanceTimersByTimeAsync(120_001);
        expect(latest.get('pc')?.phase).toBe('failed');
        // Dismiss. The old guard made this a no-op on a failed card, so the
        // explanation sat there for the rest of the session.
        cancelWake('pc');
        expect(latest.has('pc')).toBe(false);
    });

    it('does nothing when the sign-in row has no other row to move to', async () => {
        // A sign-in row whose lan_info never got a MAC groups alone, so there
        // is no other row to move to and the fold will never grow one —
        // starting a wait could only ever time out, on a card named
        // "This PC (sign-in screen)". No card, no poll, no connect.
        devices = [
            dev({ id: 'lonely-signin', name: 'This PC (sign-in screen)', online: false }),
            appRow(true), // present, but not provably the same box
        ];
        await followToDesktop('lonely-signin', 1);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(latest.size).toBe(0);
        expect(connected).toEqual([]);
        expect(listCalls).toBe(1); // the one look-up, and no poll after it

        // Unknown row entirely: same.
        devices = [appRow(true)];
        await followToDesktop('never-heard-of-it', 1);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(latest.size).toBe(0);
        expect(connected).toEqual([]);
    });
});

/**
 * The MIRROR handover: the controller asked the desktop to LOCK. A user-token
 * host cannot capture the secure desktop, so the picture moves to the machine's
 * sign-in-screen row (the SYSTEM service). Follow it there — or, when there is
 * no such row, say so instead of waiting on nothing.
 */
describe('following a machine from its desktop to its sign-in screen (after Lock)', () => {
    it("reports on the machine's card and connects to the SIGN-IN row once it is online", async () => {
        // The moment after Lock: the app row still reads online for a beat,
        // the sign-in row is not up yet (the service brings it up as the
        // console locks).
        devices = [appRow(true), signInRow(false)];
        await followToSignIn('pc', 1);
        await vi.advanceTimersByTimeAsync(0);

        const state = latest.get('pc');
        expect(state, "status appears on the machine's card").toBeTruthy();
        expect(state?.phase).toBe('following');
        expect(state?.message).toMatch(/Locked PC/);
        // It must NOT reconnect to the app row just because it still reads
        // online — the app row cannot show a locked console.
        expect(connected).toEqual([]);

        await vi.advanceTimersByTimeAsync(3_000);
        devices = [appRow(false), signInRow(true)];
        await vi.advanceTimersByTimeAsync(3_000);

        expect(connected).toEqual(['pc-signin']);
        expect(latest.has('pc')).toBe(false);
    });

    it('a machine with NO sign-in row ends honestly instead of waiting two minutes', async () => {
        devices = [appRow(true)];
        await followToSignIn('pc', 1);
        await vi.advanceTimersByTimeAsync(0);
        const state = latest.get('pc');
        expect(state?.phase).toBe('failed');
        expect(state?.message).toMatch(/Sign-in-screen access is not set up/);
        await vi.advanceTimersByTimeAsync(130_000);
        expect(connected).toEqual([]);
    });

    it('positive control: the same machine with a sign-in row does NOT fail up front', async () => {
        devices = [appRow(true), signInRow(false)];
        await followToSignIn('pc', 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(latest.get('pc')?.phase).toBe('following');
    });
});
