/**
 * The activity reporter: what THIS device tells the server about the person
 * at it, and when.
 *
 * Owner's rules (2026-10-02): idle after 10 minutes with no input anywhere on
 * the PC — OS-wide, so someone in a game is NOT idle — and away after an hour.
 * The SERVER owns those two clocks (a backgrounded phone's timers are frozen
 * and could never report the second step itself); a device only reports
 * TRANSITIONS: "active", or "inactive, and has been for N seconds". So the
 * properties pinned here are:
 *
 *  - nothing is ever sent to a server that has not announced the capability
 *    on this socket (an older server alerts on an unknown frame);
 *  - one frame per transition, never one per poll;
 *  - the desktop's OS-wide probe wins over the page: a hidden Púca window
 *    with a game in front is still active;
 *  - a hidden page with no OS probe (web, Android) is inactive at once;
 *  - talking in a call counts as activity;
 *  - every new socket that announces the capability is told the CURRENT
 *    state once (a fresh session starts "active" server-side).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wsClient } from '../api/websocket';
import { startActivityReporter, decideReport, REPORT_AFTER_SECS } from '../api/activityReporter';
import { setUserSpeaking, clearSpeaking } from '../components/voiceState';

type Sock = { send: (d: string) => void; onmessage: ((e: { data: string }) => void) | null };
const sock = () => (wsClient as unknown as { ws: Sock }).ws;
let sent: Array<{ type: string; payload?: { inactive_secs?: number | null } }> = [];
const activity = () => sent.filter(f => f.type === 'SetActivity').map(f => f.payload?.inactive_secs ?? null);

async function openSocket(withFeature: boolean) {
    const p = wsClient.connect('tok');
    await vi.advanceTimersByTimeAsync(1); // MockWebSocket opens on a 0 ms timer
    await p;
    const s = sock();
    vi.spyOn(s, 'send').mockImplementation((d: string) => {
        const frame = JSON.parse(d);
        sent.push(frame);
        // A live server answers the 30 s heartbeat; without a Pong the client
        // closes a "stale" socket after 45 s, and these tests run for minutes.
        if (frame.type === 'Ping') s.onmessage?.({ data: JSON.stringify({ type: 'Pong' }) });
    });
    if (withFeature) {
        sock().onmessage!({ data: JSON.stringify({ type: 'ServerFeatures', payload: { features: ['presence'] } }) });
    }
    await vi.advanceTimersByTimeAsync(0);
}

function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}

let stop: (() => void) | null = null;
let osIdle: number | null = null;

beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    osIdle = null;
    wsClient.disconnect();
    setHidden(false);
    clearSpeaking();
});
afterEach(() => {
    stop?.();
    stop = null;
    wsClient.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const start = (probe: boolean) => {
    stop = startActivityReporter({ userId: 1, probe: probe ? async () => osIdle : async () => null, pollMs: 15_000 });
};

describe('decideReport (the pure rule)', () => {
    const now = 10_000_000;
    it('with an OS probe, the probe decides — page visibility does not', () => {
        expect(decideReport({ osIdleSecs: 3, lastLocalActivityMs: now - 3_600_000, hidden: true, nowMs: now })).toBeNull();
        expect(decideReport({ osIdleSecs: 700, lastLocalActivityMs: now - 3_600_000, hidden: false, nowMs: now })).toBe(700);
        expect(decideReport({ osIdleSecs: REPORT_AFTER_SECS - 1, lastLocalActivityMs: 0, hidden: false, nowMs: now })).toBeNull();
    });
    it('local activity (speech) newer than the OS probe wins', () => {
        expect(decideReport({ osIdleSecs: 900, lastLocalActivityMs: now - 2_000, hidden: false, nowMs: now })).toBeNull();
    });
    it('without a probe: a hidden page is inactive at once, a visible one after the report delay', () => {
        expect(decideReport({ osIdleSecs: null, lastLocalActivityMs: now - 1_000, hidden: true, nowMs: now })).toBe(1);
        expect(decideReport({ osIdleSecs: null, lastLocalActivityMs: now - 1_000, hidden: false, nowMs: now })).toBeNull();
        expect(decideReport({ osIdleSecs: null, lastLocalActivityMs: now - 61_000, hidden: false, nowMs: now })).toBe(61);
    });
    it('a hidden page stays active while its user is talking (a phone in a call, screen locked)', () => {
        const talking = { osIdleSecs: null, lastLocalActivityMs: now - 2_000, hidden: true, nowMs: now };
        expect(decideReport({ ...talking, lastSpeechMs: now - 2_000 })).toBeNull();
        // Positive control: the same page after a minute of silence is inactive.
        expect(decideReport({ ...talking, lastSpeechMs: now - 61_000 })).toBe(2);
        expect(decideReport({ ...talking, lastSpeechMs: 0 })).toBe(2);
    });
});

describe('startActivityReporter', () => {
    it('sends NOTHING to a server that never announced the capability', async () => {
        start(false);
        await openSocket(false);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        setHidden(true);
        await vi.advanceTimersByTimeAsync(60_000);
        window.dispatchEvent(new Event('pointerdown'));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(activity()).toEqual([]);
        // Positive control: the same socket did carry other traffic.
        wsClient.send({ type: 'Ping' });
        expect(sent.some(f => f.type === 'Ping')).toBe(true);
    });

    it('reports the current state on ServerFeatures, then one frame per transition', async () => {
        start(false);
        await openSocket(true);
        expect(activity()).toEqual([null]); // told once: active

        await vi.advanceTimersByTimeAsync(2 * 60_000); // no input for two minutes
        const afterQuiet = activity();
        expect(afterQuiet.length).toBe(2);
        expect(afterQuiet[1]).toBeGreaterThanOrEqual(REPORT_AFTER_SECS);

        await vi.advanceTimersByTimeAsync(10 * 60_000); // many more polls, still quiet
        expect(activity().length).toBe(2);

        window.dispatchEvent(new Event('keydown'));
        await vi.advanceTimersByTimeAsync(0);
        expect(activity()).toEqual([null, afterQuiet[1], null]); // back at once, not at the next poll

        window.dispatchEvent(new Event('pointermove'));
        await vi.advanceTimersByTimeAsync(30_000);
        expect(activity().length).toBe(3); // still active: nothing new
    });

    it('desktop: OS-wide input keeps a hidden window active; OS idle makes it inactive', async () => {
        osIdle = 2;
        start(true);
        await openSocket(true);
        setHidden(true); // Púca minimised to the tray, a game in front
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(activity()).toEqual([null]);

        osIdle = 700;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(activity()).toEqual([null, 700]);
    });

    it('web/Android: hiding the page reports inactive immediately, showing it reports active', async () => {
        start(false);
        await openSocket(true);
        setHidden(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(activity().length).toBe(2);
        expect(activity()[1]).not.toBeNull();
        setHidden(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(activity()[2]).toBeNull();
    });

    it('speaking in a call counts as activity', async () => {
        osIdle = 900;
        start(true);
        // The probe says idle (hands off the keyboard), but the local speaking
        // ring is lit, and stays lit across several polls.
        setUserSpeaking(1, true);
        await openSocket(true);
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(activity()).toEqual([null]);
        // Someone ELSE speaking is not this user's activity.
        setUserSpeaking(1, false);
        setUserSpeaking(2, true);
        osIdle = 900;
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(activity().slice(-1)[0]).toBeGreaterThanOrEqual(REPORT_AFTER_SECS);
    });

    it('a reconnect re-reports the current state once — and not at all to an older host', async () => {
        osIdle = 800;
        start(true);
        await openSocket(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(activity()).toEqual([800]); // the first report already carried the truth
        sent = [];
        await openSocket(true); // new socket, capability announced again
        expect(activity().length).toBe(1);
        expect(activity()[0]).toBeGreaterThanOrEqual(800);
        sent = [];
        await openSocket(false); // a rollback host without the feature
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(activity()).toEqual([]);
    });

    it('stop() removes every listener and timer', async () => {
        start(false);
        await openSocket(true);
        stop!();
        stop = null;
        sent = [];
        setHidden(true);
        window.dispatchEvent(new Event('keydown'));
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(activity()).toEqual([]);
    });
});
