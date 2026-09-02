/**
 * The host's escape hatches for a DEVICE control session.
 *
 * These existed and were armed for the legacy in-call path only, so on a device
 * session the two settings the user is shown — the kill-switch hotkey and "stop
 * when I touch my mouse or keyboard" — did nothing at all, and the only way out
 * was the on-screen Stop button that a controller driving the pointer can keep
 * you away from.
 *
 * What these pin is the part that was missing: that arming really reaches the
 * native hook, that the user's OWN setting decides the any-input half, that
 * either native event ends the session, and that the hook is not left running
 * (nor torn out from under the other control path) when a session ends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const invoke = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

/** The native events, captured so a test can fire them. */
const nativeListeners = new Map<string, () => void>();
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (name: string, cb: () => void) => {
        nativeListeners.set(name, cb);
        return () => nativeListeners.delete(name);
    },
}));

let isTauriNow = true;
vi.mock('../platform', () => ({ isTauri: () => isTauriNow, isMobile: () => false }));

/** The user's settings, exactly as the legacy path reads them. */
let settings: Record<string, unknown> = {};
vi.mock('../../components/settingsStore', () => ({ loadSettings: () => settings }));

/** Whether the LEGACY in-call control path is mid-session. */
let legacyControlled: unknown = null;
vi.mock('../remoteControl', () => ({
    getControlState: () => ({ controlledBy: legacyControlled }),
}));

import {
    armControlGuard,
    armedControlGuardIds,
    noteControlActivity,
    releaseControlGuard,
    DEVICE_CONTROL_IDLE_MS,
} from './controlGuard';

/** Drain the dynamic imports the guard does on the way to the invoke. */
async function settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

function startCalls(): Array<Record<string, unknown>> {
    return invoke.mock.calls
        .filter(c => c[0] === 'start_control_guard')
        .map(c => c[1] as Record<string, unknown>);
}

beforeEach(async () => {
    // Released and DRAINED before the counters are cleared: the release path
    // stops the native hook through a dynamic import, so a leftover
    // stop_control_guard would otherwise land in the next test's tally.
    for (const id of armedControlGuardIds()) releaseControlGuard(id);
    await settle();
    invoke.mockClear();
    isTauriNow = true;
    legacyControlled = null;
    settings = {
        remoteControlKillKey: { keyCode: 27, ctrl: true, alt: false, shift: true, label: 'Ctrl+Shift+Esc' },
        remoteControlAnyInputKill: false,
    };
});

afterEach(() => {
    vi.useRealTimers();
});

describe('arming the guard for a device control session', () => {
    it('starts the native hook with the user’s configured kill key', async () => {
        armControlGuard('s1', () => {}, null);
        await settle();

        const calls = startCalls();
        expect(calls, 'the device-session path must actually arm the hook').toHaveLength(1);
        // vk + a modifier bitmask of 1=Ctrl 2=Alt 4=Shift.
        expect(calls[0]).toEqual({ anyInput: false, killVk: 27, killMods: 5 });
    });

    it('leaves the ANY-INPUT half to the user, and never forces it on', async () => {
        // This is the rollout hazard, not a nicety: "any physical input ends
        // control" is off by default because a stray mouse nudge would kick a
        // friend out mid-game. Arming device sessions must respect that.
        armControlGuard('s1', () => {}, null);
        await settle();
        expect(startCalls()[0].anyInput).toBe(false);

        releaseControlGuard('s1');
        await settle();
        invoke.mockClear();
        settings.remoteControlAnyInputKill = true;
        armControlGuard('s2', () => {}, null);
        await settle();
        expect(startCalls()[0].anyInput, 'and must honour it when it IS on').toBe(true);
    });

    it('tells the hook there is no hotkey when the binding is cleared', async () => {
        settings.remoteControlKillKey = null;
        armControlGuard('s1', () => {}, null);
        await settle();
        expect(startCalls()[0]).toEqual({ anyInput: false, killVk: 0, killMods: 0 });
    });

    it('does nothing outside the desktop shell', async () => {
        isTauriNow = false;
        armControlGuard('s1', () => {}, null);
        await settle();
        expect(invoke).not.toHaveBeenCalled();
    });
});

describe('the two native events end the session', () => {
    it('revokes on physical host input', async () => {
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), null);
        await settle();
        expect(nativeListeners.has('host-input-detected'), 'the rig must have a listener to fire').toBe(true);

        nativeListeners.get('host-input-detected')!();
        expect(revoked).toHaveLength(1);
        expect(revoked[0]).toMatch(/took over/i);
        expect(armedControlGuardIds(), 'and the session stops being armed').toEqual([]);
    });

    it('revokes on the kill-switch hotkey', async () => {
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), null);
        await settle();

        nativeListeners.get('host-killswitch-hotkey')!();
        expect(revoked).toHaveLength(1);
        expect(revoked[0]).toMatch(/kill switch/i);
    });

    it('ends EVERY armed session, not just the first', async () => {
        const revoked: string[] = [];
        armControlGuard('s1', () => revoked.push('s1'), null);
        await settle();
        armControlGuard('s2', () => revoked.push('s2'), null);
        await settle();

        nativeListeners.get('host-killswitch-hotkey')!();
        expect(revoked.sort()).toEqual(['s1', 's2']);
    });

    it('NEGATIVE CONTROL: a released session is not revoked by a later event', async () => {
        // Otherwise "the event ends sessions" could be passing because the
        // module never forgets anything.
        const revoked: string[] = [];
        armControlGuard('s1', () => revoked.push('s1'), null);
        await settle();
        releaseControlGuard('s1');

        nativeListeners.get('host-killswitch-hotkey')!();
        expect(revoked).toEqual([]);
    });
});

describe('stopping the native hook', () => {
    it('stops it when the last device session ends', async () => {
        armControlGuard('s1', () => {}, null);
        await settle();
        armControlGuard('s2', () => {}, null);
        await settle();
        invoke.mockClear();

        releaseControlGuard('s1');
        await settle();
        expect(
            invoke.mock.calls.some(c => c[0] === 'stop_control_guard'),
            'one of two sessions ending must not disarm the other',
        ).toBe(false);

        releaseControlGuard('s2');
        await settle();
        expect(invoke.mock.calls.some(c => c[0] === 'stop_control_guard')).toBe(true);
    });

    it('leaves it running while the legacy in-call path holds a session', async () => {
        // stop_control_guard also releases every held key, so tearing it out
        // from under an in-call session would both disarm ITS kill switch and
        // drop whatever it is holding down.
        legacyControlled = { userId: 7, username: 'friend' };
        armControlGuard('s1', () => {}, null);
        await settle();
        invoke.mockClear();

        releaseControlGuard('s1');
        await settle();
        expect(invoke.mock.calls.some(c => c[0] === 'stop_control_guard')).toBe(false);
    });
});

describe('the inactivity revoke', () => {
    it('ends an unattended session after the idle budget with no input', async () => {
        vi.useFakeTimers();
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), DEVICE_CONTROL_IDLE_MS);

        vi.advanceTimersByTime(DEVICE_CONTROL_IDLE_MS - 1);
        expect(revoked, 'not a moment early').toEqual([]);
        vi.advanceTimersByTime(1);
        expect(revoked).toHaveLength(1);
        expect(armedControlGuardIds()).toEqual([]);
    });

    it('is pushed back by controller input', async () => {
        vi.useFakeTimers();
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), DEVICE_CONTROL_IDLE_MS);

        vi.advanceTimersByTime(DEVICE_CONTROL_IDLE_MS - 1000);
        noteControlActivity('s1');
        vi.advanceTimersByTime(DEVICE_CONTROL_IDLE_MS - 1);
        expect(revoked, 'an active session must never be cut off').toEqual([]);
        vi.advanceTimersByTime(1);
        expect(revoked).toHaveLength(1);
    });

    it('never fires for an ATTENDED session, which has a human at the keyboard', async () => {
        vi.useFakeTimers();
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), null);

        vi.advanceTimersByTime(DEVICE_CONTROL_IDLE_MS * 4);
        expect(revoked, 'a friend watching rather than typing must not be dropped').toEqual([]);
        expect(armedControlGuardIds()).toEqual(['s1']);
    });

    it('drops the timer when the session ends, so it cannot fire into the next one', async () => {
        vi.useFakeTimers();
        const revoked: string[] = [];
        armControlGuard('s1', r => revoked.push(r), DEVICE_CONTROL_IDLE_MS);
        releaseControlGuard('s1');

        vi.advanceTimersByTime(DEVICE_CONTROL_IDLE_MS * 2);
        expect(revoked).toEqual([]);
    });
});
