/**
 * The dfPause controller: every pause condition entered and cleared through
 * the events that really carry it, with fake timers. What must hold:
 *  - a pause starts only after "nobody can hear" has held PAUSE_HOLD_MS;
 *  - a resume happens IN the event that clears the last condition (no timer
 *    has to run), for every flip-back trigger the call has;
 *  - two conditions at once: clearing one keeps it paused, clearing the last
 *    resumes;
 *  - an input that becomes unknown resumes;
 *  - nothing polls: with no events, nothing is evaluated and no timer runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/noiseFilter', () => ({
    setDeepFilterPaused: vi.fn(),
    setDfPauseDiagnosticsSource: vi.fn(),
}));

import { attachDfPause, dfPauseDiagnostics, PAUSE_HOLD_MS, type Probe } from '../api/dfPause';
import { globalVoiceUsers, notifyVoiceUsersChange, applyVoiceStatus, type VoiceUserStatus } from '../components/voiceState';
import type { DfPauseReason } from '../api/dfPauseDecision';

const ROOM = 'voice_7';
const SELF = 1;

class FakeProbe<T> implements Probe<T> {
    private listeners = new Set<() => void>();
    value: T;
    constructor(value: T) { this.value = value; }
    read() { return this.value; }
    subscribe(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
    /** Change the value AND announce it, as the real source does. */
    set(v: T) { this.value = v; this.listeners.forEach(cb => cb()); }
    get subscribers() { return this.listeners.size; }
}

const row = (id: number, isDeafened = false): VoiceUserStatus => ({ id, username: `u${id}`, isMuted: false, isDeafened });
/** Replace the room's roster and announce it (what every roster writer does). */
function roster(...users: VoiceUserStatus[]) {
    globalVoiceUsers.set(ROOM, new Map(users.map(u => [u.id, u])));
    notifyVoiceUsersChange();
}

let mic: FakeProbe<boolean | null>;
let socket: FakeProbe<boolean>;
let transport: FakeProbe<ReadonlyArray<number> | null>;
/** Each media connection's session key, per user, as the wiring reports
 *  them: by default one stable key per transport peer (`s<id>`); a test
 *  gives someone a NEW session by changing `sessionKey`, or lists sessions
 *  outright in `sessionsOverride` (two at once). Announced through the
 *  transport probe, as the real sources do. */
let sessionKey: Map<number, string>;
let sessionsOverride: Array<readonly [number, string]> | null;
let applied: Array<[boolean, DfPauseReason | null]>;
let detach: () => void;
const paused = () => applied.length > 0 && applied[applied.length - 1][0];
const reason = () => applied[applied.length - 1]?.[1] ?? null;

/** A call with one other person (2) who hears us, over a live socket. */
function startCall() {
    mic = new FakeProbe<boolean | null>(true);
    socket = new FakeProbe(true);
    transport = new FakeProbe<ReadonlyArray<number> | null>([2]);
    sessionKey = new Map();
    sessionsOverride = null;
    const sessions = () => sessionsOverride ?? (transport.value ?? []).map(id => [id, sessionKey.get(id) ?? `s${id}`] as const);
    globalVoiceUsers.set(ROOM, new Map([[SELF, row(SELF)], [2, row(2)]]));
    const sink: Array<[boolean, DfPauseReason | null]> = [];
    applied = sink;
    detach = attachDfPause({ roomId: ROOM, selfId: SELF, mic, socket, transport, sessions, apply: (p, r) => sink.push([p, r]) });
}

beforeEach(() => {
    vi.useFakeTimers();
    globalVoiceUsers.clear();
    startCall();
});
afterEach(() => {
    detach();
    globalVoiceUsers.clear();
    vi.useRealTimers();
});

/** Hold the condition just short of PAUSE_HOLD_MS (still running), then the
 *  last millisecond (paused). */
function holdUntilPaused(expected: DfPauseReason) {
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(PAUSE_HOLD_MS - 1);
    expect(paused()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(paused()).toBe(true);
    expect(reason()).toBe(expected);
}

// Every condition, with every event that ends it. `enter` makes it true from
// the starting call; `exit` is the real-world flip-back trigger.
type Case = { cond: string; reason: DfPauseReason; enter: () => void; exit: () => void; trigger: string };
const CASES: Case[] = [
    { cond: 'muted', reason: 'mic-closed', enter: () => mic.set(false), exit: () => mic.set(true), trigger: 'unmute' },
    { cond: 'push-to-talk released', reason: 'mic-closed', enter: () => mic.set(false), exit: () => mic.set(true), trigger: 'push-to-talk pressed' },
    { cond: 'push-to-mute held', reason: 'mic-closed', enter: () => mic.set(false), exit: () => mic.set(true), trigger: 'push-to-mute released' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => roster(row(SELF), row(3)), trigger: 'someone joins (roster first)' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => transport.set([3]), trigger: 'someone connects (media first)' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => transport.set([SELF]), trigger: 'our own other device joins' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => socket.set(false), trigger: 'our socket drops (roster unknown)' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => transport.set(null), trigger: 'the SFU starts reconnecting (transport unknown)' },
    { cond: 'alone', reason: 'alone', enter: () => { transport.set([]); roster(row(SELF)); }, exit: () => { globalVoiceUsers.delete(ROOM); notifyVoiceUsersChange(); }, trigger: 'the roster is dropped (unknown)' },
    { cond: 'everyone else deafened', reason: 'all-deafened', enter: () => roster(row(SELF), row(2, true)), exit: () => roster(row(SELF), row(2, false)), trigger: 'the deafened peer undeafens' },
    { cond: 'everyone else deafened', reason: 'all-deafened', enter: () => roster(row(SELF), row(2, true)), exit: () => roster(row(SELF), row(2, true), row(3)), trigger: 'a peer who hears joins' },
    { cond: 'everyone else deafened', reason: 'all-deafened', enter: () => roster(row(SELF), row(2, true)), exit: () => transport.set([2, 4]), trigger: 'a media peer with no roster row appears' },
    { cond: 'everyone else deafened', reason: 'all-deafened', enter: () => roster(row(SELF), row(2, true)), exit: () => socket.set(false), trigger: 'our socket drops' },
];

describe('dfPause: every condition pauses after the hold and resumes AT ONCE when it clears', () => {
    for (const c of CASES) {
        it(`${c.cond} -> paused; ${c.trigger} -> resumed in the same event`, () => {
            c.enter();
            holdUntilPaused(c.reason);
            c.exit();
            // No timer advanced: the resume is synchronous with the event.
            expect(paused()).toBe(false);
            expect(reason()).toBe(null);
        });

        it(`${c.cond}: cleared before the hold ends (${c.trigger}) -> never paused`, () => {
            c.enter();
            vi.advanceTimersByTime(PAUSE_HOLD_MS - 1);
            c.exit();
            vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
            expect(applied.some(([p]) => p)).toBe(false);
        });
    }
});

describe('dfPause: deafen mutes the mic, so it is the mic-closed condition', () => {
    it('deafen -> paused; undeafen leaves the mic muted -> still paused; unmute -> resumed', () => {
        mic.set(false); // toggleDeafen: applyMicGate(true) + setIsMuted(true)
        holdUntilPaused('mic-closed');
        // toggleDeafen(false) does not unmute: no gate change, nothing to do.
        vi.advanceTimersByTime(10_000);
        expect(paused()).toBe(true);
        mic.set(true);
        expect(paused()).toBe(false);
    });
});

describe('dfPause: two conditions at once', () => {
    it('muted AND alone: unmute keeps it paused (now alone); a join resumes', () => {
        mic.set(false);
        transport.set([]);
        roster(row(SELF));
        holdUntilPaused('mic-closed');
        mic.set(true);
        expect(paused()).toBe(true);
        expect(reason()).toBe('alone');
        roster(row(SELF), row(5));
        expect(paused()).toBe(false);
    });

    it('muted AND alone: a join keeps it paused (still muted); the unmute resumes', () => {
        mic.set(false);
        transport.set([]);
        roster(row(SELF));
        holdUntilPaused('mic-closed');
        roster(row(SELF), row(5));
        transport.set([5]);
        expect(paused()).toBe(true);
        mic.set(true);
        expect(paused()).toBe(false);
    });

    it('muted AND everyone deafened: an undeafen keeps it paused; the unmute resumes', () => {
        mic.set(false);
        roster(row(SELF), row(2, true));
        holdUntilPaused('mic-closed');
        roster(row(SELF), row(2, false));
        expect(paused()).toBe(true);
        mic.set(true);
        expect(paused()).toBe(false);
    });

    it('everyone deafened, then the last peer leaves, media first: still paused (now alone), no resume in between', () => {
        roster(row(SELF), row(2, true));
        holdUntilPaused('all-deafened');
        transport.set([]); // their peer connection closes...
        roster(row(SELF)); // ...then their roster row goes
        expect(paused()).toBe(true);
        expect(applied.filter(([p]) => !p)).toEqual([]);
        expect(reason()).toBe('alone');
    });

    it('everyone deafened, then the last peer leaves, roster first: a media peer with no row may hear, so it resumes, then pauses again once they are gone', () => {
        // VoicePanel's StreamStopped handler deletes the row (and notifies)
        // BEFORE it closes the peer connection: for that instant someone we
        // know nothing about is connected. Conservative: run.
        roster(row(SELF), row(2, true));
        holdUntilPaused('all-deafened');
        roster(row(SELF));
        expect(paused()).toBe(false);
        transport.set([]);
        holdUntilPaused('alone');
    });
});

/**
 * A deafen status describes the media SESSION it was sent from. The roster
 * has one row per user and keeps their flags across every replay, so when
 * someone deafened moves the call to another device ("Move here"), reloads,
 * or rejoins, their row still says deafened while the new session hears us
 * (review finding 2026-10-04, reproduced live: A stayed paused while B's
 * second device received A's audio, and no event ever ended it). A NEW media
 * session for someone (a key not seen for them before) makes their deafen
 * unknown - they hear - until a status arrives after it.
 */
describe('dfPause: a new media session makes an old deafen status unknown', () => {
    /** Their status ping, applied as VoicePanel applies it, and announced. */
    function status(id: number, deafened: boolean) {
        expect(applyVoiceStatus(ROOM, id, { muted: deafened, deafened, buffering: false })).toBe(true);
        notifyVoiceUsersChange();
    }
    function deafenedPeer() {
        status(2, true);
        holdUntilPaused('all-deafened');
    }

    it('Move here, mesh shape: the peer connection is replaced under the same user -> resumed at once, and stays running', () => {
        deafenedPeer();
        sessionKey.set(2, 's2-phone');
        transport.set([2]);
        expect(paused()).toBe(false);
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 20);
        expect(paused()).toBe(false);
    });

    it('Move here, SFU shape: the old session leaves, then the new one connects -> resumed when it connects', () => {
        deafenedPeer();
        transport.set([]); // the old device's participant goes; their row stays
        expect(paused()).toBe(true);
        expect(reason()).toBe('all-deafened');
        sessionKey.set(2, 'u2#phone');
        transport.set([2]);
        expect(paused()).toBe(false);
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 20);
        expect(paused()).toBe(false);
    });

    it('a status from the new session ends the doubt: deafened pauses again after the hold, undeafened keeps it running', () => {
        deafenedPeer();
        sessionKey.set(2, 's2-new');
        transport.set([2]);
        expect(paused()).toBe(false);
        status(2, false); // the new device states itself: not deafened
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(paused()).toBe(false);
        status(2, true); // ...and later deafens there
        holdUntilPaused('all-deafened');
    });

    it('a status that arrived BEFORE the new session appeared does not vouch for it', () => {
        deafenedPeer();
        status(2, true); // a late repeat from the OLD session
        sessionKey.set(2, 's2-new');
        transport.set([2]);
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(paused()).toBe(false);
    });

    it('a roster row rebuilt without its stamp is not a fresh status', () => {
        deafenedPeer();
        sessionKey.set(2, 's2-new');
        transport.set([2]);
        roster(row(SELF), row(2, true)); // a writer that dropped statusSeq
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(paused()).toBe(false);
    });

    it('two sessions of the same person at once: one row cannot say which is deafened -> runs', () => {
        deafenedPeer();
        sessionsOverride = [[2, 's2'], [2, 's2-phone']];
        transport.set([2]);
        expect(paused()).toBe(false);
        status(2, true); // even a fresh status cannot say which device sent it
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(paused()).toBe(false);
        sessionsOverride = [[2, 's2-phone']]; // the old one goes
        transport.set([2]);
        status(2, true);
        holdUntilPaused('all-deafened');
    });

    it('the first session seen for someone is trusted: joining a call where everyone is deafened still pauses', () => {
        // Their status can arrive before their media connects (our own join).
        transport.set([]);
        roster(row(SELF), row(2));
        status(2, true);
        transport.set([2]);
        holdUntilPaused('all-deafened');
    });

    it('our own other device starting a session is not a deafen question (it already counts as hearing)', () => {
        deafenedPeer();
        sessionsOverride = [[2, 's2'], [SELF, 'me-phone']];
        transport.set([2, SELF]);
        expect(paused()).toBe(false); // hearing: our other device
        sessionsOverride = [[2, 's2']];
        transport.set([2]);
        holdUntilPaused('all-deafened'); // no doubt left over about member 2
    });

    it('positive control: the same session announced again changes nothing', () => {
        deafenedPeer();
        transport.set([2]);
        transport.set([2]);
        expect(paused()).toBe(true);
        expect(applied.filter(([p]) => !p)).toEqual([]);
    });
});

describe('dfPause: unknown inputs and missed events', () => {
    it('alone with the socket down never pauses; the socket coming back starts the hold', () => {
        socket.set(false);
        transport.set([]);
        roster(row(SELF));
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 10);
        expect(paused()).toBe(false);
        socket.set(true);
        holdUntilPaused('alone');
    });

    it('the hold re-reads every input when it ends: a change nobody announced still cancels the pause', () => {
        transport.set([]);
        roster(row(SELF));
        vi.advanceTimersByTime(PAUSE_HOLD_MS / 2);
        transport.value = [9]; // changed without an event
        vi.advanceTimersByTime(PAUSE_HOLD_MS);
        expect(paused()).toBe(false);
    });

    it('a roster read before our own row exists (not this call yet) is not "alone"', () => {
        transport.set([]);
        globalVoiceUsers.set(ROOM, new Map());
        notifyVoiceUsersChange();
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(paused()).toBe(false);
    });
});

describe('dfPause: event-driven, never polled', () => {
    it('with no events, nothing is evaluated and no timer is pending', () => {
        const before = dfPauseDiagnostics().evaluations as number;
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(60 * 60_000); // an hour of a quiet call
        expect(dfPauseDiagnostics().evaluations).toBe(before);
        expect(applied).toEqual([]);
    });

    it('one evaluation per event, and exactly one timer only while holding', () => {
        const before = dfPauseDiagnostics().evaluations as number;
        mic.set(false);
        expect(dfPauseDiagnostics().evaluations).toBe(before + 1);
        expect(vi.getTimerCount()).toBe(1);
        mic.set(false); // a repeat: evaluated, but the hold is not restarted
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(PAUSE_HOLD_MS);
        expect(vi.getTimerCount()).toBe(0);
        expect(paused()).toBe(true);
    });
});

describe('dfPause: detach', () => {
    it('resumes, unsubscribes everything, and ignores later events', () => {
        mic.set(false);
        holdUntilPaused('mic-closed');
        detach();
        expect(paused()).toBe(false);
        expect(mic.subscribers + socket.subscribers + transport.subscribers).toBe(0);
        const n = applied.length;
        mic.set(true);
        mic.set(false);
        roster(row(SELF));
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 4);
        expect(applied.length).toBe(n);
        detach = () => { /* already detached */ };
    });

    it('a detach during the hold cancels it, and still tells the graph to run', () => {
        mic.set(false);
        vi.advanceTimersByTime(PAUSE_HOLD_MS / 2);
        detach();
        vi.advanceTimersByTime(PAUSE_HOLD_MS * 2);
        expect(applied).toEqual([[false, null]]);
        detach = () => { /* already detached */ };
    });

    it('attaching a second watch replaces the first (one call at a time)', () => {
        const first = applied;
        mic.set(false);
        startCall(); // a new call: the first watch is detached and resumes
        expect(first[first.length - 1]).toEqual([false, null]);
        mic.set(false);
        holdUntilPaused('mic-closed');
    });
});
