/**
 * Following the OS default microphone mid-call (the owner's report,
 * 2026-10-07): Audio Hub moved the Windows default recording device from a
 * still-connected headset to a desk mic when another headset connected, and
 * the call kept recording the headset until he left and rejoined. Nothing
 * died, so the device-lost path never fired, and the devicechange check
 * skipped exactly this case: on Chromium desktop a capture of the OS default
 * reports deviceId 'default', and the old check only chased a capture whose
 * deviceId was concrete.
 *
 * Three layers:
 *   - checkDefaultMoved: what "the default moved" means, against device lists
 *     shaped like Chromium's on Windows ('default' and 'communications'
 *     pseudo-entries sharing a groupId with the device they alias, two inputs
 *     of one sound card sharing one group);
 *   - startMicDeviceWatchdog: bursts, the settle wait, the desktop shell's
 *     own notification, SPEAK, the once-per-default rule (which holds only
 *     while the call is still on what that follow gave it) and rate limits,
 *     every guard pinned by a test that fails without it, and what it logs —
 *     against a fake navigator.mediaDevices and fake timers;
 *   - MediaManager.reacquireAudioTrack({ keepOldOnFailure }): a new default
 *     that cannot be opened leaves the old, working mic in the call, and the
 *     new track carries the mute/PTT gate as it stands at the swap, including
 *     a mute pressed while the new device was opening.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    checkDefaultMoved, followedPseudo, plainLabel, startMicDeviceWatchdog, describeMicError,
    SETTLE_MS, SETTLE_MAX_MS, FOLLOW_MIN_GAP_MS, FOLLOW_RETRY_MS, MUTED_RESTART_MIN_GAP_MS,
    type InputEntry, type MicWatchdogDeps, type MicRestartOutcome, type NativeDefaultChange,
} from '../api/rtc/micDeviceWatchdog';
import { MediaManager, type RawMicState, type MicReacquireOptions } from '../api/rtc/media';

type Dev = { deviceId: string; groupId: string; label: string };
const ARCTIS: Dev = { deviceId: 'arctis-id', groupId: 'grp-arctis', label: 'Microphone (2- Arctis Nova Pro Wireless)' };
const FMA: Dev = { deviceId: 'fma-id', groupId: 'grp-fma', label: 'Microphone (FMA120)' };
const XM6: Dev = { deviceId: 'xm6-id', groupId: 'grp-xm6', label: 'Headset (WH-1000XM6 Hands-Free)' };

/** Chromium on Windows: the two pseudo-entries first, each with the groupId
 *  and a prefixed label of the device it aliases, then every device. */
function windowsList(def: Dev, comm: Dev = def, devices: Dev[] = [ARCTIS, FMA]): InputEntry[] {
    return [
        { deviceId: 'default', groupId: def.groupId, label: `Default - ${def.label}` },
        { deviceId: 'communications', groupId: comm.groupId, label: `Communications - ${comm.label}` },
        ...devices,
    ];
}
/** A capture of the 'default' pseudo-device as Chromium reports it. */
const defaultCapture = (d: Dev, pseudo: 'default' | 'communications' = 'default'): RawMicState => ({
    ended: false, muted: false, deviceId: pseudo, groupId: d.groupId,
    label: `${pseudo === 'default' ? 'Default' : 'Communications'} - ${d.label}`,
});

describe('checkDefaultMoved', () => {
    it("a capture of 'default' whose device is no longer the default has moved (the owner's case)", () => {
        const v = checkDefaultMoved(null, defaultCapture(ARCTIS), windowsList(FMA, FMA, [ARCTIS, FMA, XM6]));
        expect(v).toMatchObject({ moved: true, pseudo: 'default', from: ARCTIS.label, to: FMA.label });
    });

    it('the same default is not a move, whatever else was added or removed', () => {
        expect(checkDefaultMoved(null, defaultCapture(ARCTIS), windowsList(ARCTIS)).moved).toBe(false);
        expect(checkDefaultMoved(null, defaultCapture(ARCTIS), windowsList(ARCTIS, ARCTIS, [ARCTIS, FMA, XM6])).moved).toBe(false);
        expect(checkDefaultMoved(null, defaultCapture(ARCTIS), windowsList(ARCTIS, ARCTIS, [ARCTIS])).moved).toBe(false);
    });

    it('only the role the setting follows counts: a communications-only move is not a default move', () => {
        expect(checkDefaultMoved(null, defaultCapture(ARCTIS), windowsList(ARCTIS, FMA)).moved).toBe(false);
    });

    it("a member who picked Chromium's Communications entry follows the communications default", () => {
        const cap = defaultCapture(ARCTIS, 'communications');
        expect(checkDefaultMoved('communications', cap, windowsList(ARCTIS, FMA))).toMatchObject({ moved: true, pseudo: 'communications', to: FMA.label });
        expect(checkDefaultMoved('communications', cap, windowsList(FMA, ARCTIS)).moved).toBe(false);
    });

    it('a specific microphone never follows the default', () => {
        const cap: RawMicState = { ended: false, muted: false, deviceId: ARCTIS.deviceId, groupId: ARCTIS.groupId, label: ARCTIS.label };
        const v = checkDefaultMoved(ARCTIS.deviceId, cap, windowsList(FMA));
        expect(v).toEqual({ moved: false, why: 'a specific microphone is selected' });
    });

    it('an engine that opens the CONCRETE device for a default request is compared through the alias', () => {
        const cap: RawMicState = { ended: false, muted: false, deviceId: ARCTIS.deviceId, groupId: ARCTIS.groupId, label: ARCTIS.label };
        expect(checkDefaultMoved(null, cap, windowsList(FMA))).toMatchObject({ moved: true, to: FMA.label });
        expect(checkDefaultMoved(null, cap, windowsList(ARCTIS)).moved).toBe(false);
        // Two endpoints in one container: the capture is one of them, so no move.
        const twin: Dev = { deviceId: 'arctis-2', groupId: ARCTIS.groupId, label: 'Microphone (Arctis chat)' };
        expect(checkDefaultMoved(null, cap, windowsList(ARCTIS, ARCTIS, [twin, ARCTIS, FMA])).moved).toBe(false);
    });

    it('nothing to compare is never a move (no default entry, no groups and no labels)', () => {
        expect(checkDefaultMoved(null, defaultCapture(ARCTIS), [ARCTIS, FMA]).moved).toBe(false);
        const bare = { ended: false, muted: false, deviceId: 'default' };
        expect(checkDefaultMoved(null, bare, [{ deviceId: 'default', groupId: '', label: '' }, ARCTIS]).moved).toBe(false);
    });

    it('without groups, the labels decide', () => {
        const cap = { ...defaultCapture(ARCTIS), groupId: '' };
        const noGroups = windowsList(FMA).map(d => ({ ...d, groupId: '' }));
        expect(checkDefaultMoved(null, cap, noGroups).moved).toBe(true);
        expect(checkDefaultMoved(null, cap, windowsList(ARCTIS).map(d => ({ ...d, groupId: '' }))).moved).toBe(false);
    });

    it('two inputs of ONE sound card share a group, so the label tells them apart', () => {
        // Chromium gives an input the group of its controller's matching
        // output, so 'Microphone' and 'Line In' on one codec (or the inputs of
        // one USB interface) carry the same groupId.
        const MIC: Dev = { deviceId: 'rtk-mic', groupId: 'grp-rtk', label: 'Microphone (Realtek(R) Audio)' };
        const LINE: Dev = { deviceId: 'rtk-line', groupId: 'grp-rtk', label: 'Line In (Realtek(R) Audio)' };
        expect(checkDefaultMoved(null, defaultCapture(MIC), windowsList(LINE, LINE, [MIC, LINE])))
            .toMatchObject({ moved: true, from: MIC.label, to: LINE.label });
        expect(checkDefaultMoved(null, defaultCapture(MIC), windowsList(MIC, MIC, [MIC, LINE])).moved).toBe(false);
        expect(checkDefaultMoved('communications', defaultCapture(MIC, 'communications'), windowsList(MIC, LINE, [MIC, LINE])))
            .toMatchObject({ moved: true, pseudo: 'communications', to: LINE.label });
        // A CONCRETE capture: of the two endpoints in the default's group, the
        // one the default names decides.
        const onMic: RawMicState = { ended: false, muted: false, deviceId: MIC.deviceId, groupId: MIC.groupId, label: MIC.label };
        expect(checkDefaultMoved(null, onMic, windowsList(LINE, LINE, [MIC, LINE]))).toMatchObject({ moved: true, to: LINE.label });
        expect(checkDefaultMoved(null, onMic, windowsList(MIC, MIC, [MIC, LINE])).moved).toBe(false);
    });

    it('one device spelled with and without the pseudo-device prefix, in any language, is the same device', () => {
        // Chromium builds the entry's label as <localised "Default"> + " - " +
        // the device's name; the capture's label is the entry's label at open.
        const plain: RawMicState = { ...defaultCapture(ARCTIS), label: ARCTIS.label };
        expect(checkDefaultMoved(null, plain, windowsList(ARCTIS)).moved).toBe(false);
        const fr = (d: Dev): InputEntry[] => [{ deviceId: 'default', groupId: d.groupId, label: `Par défaut - ${d.label}` }, ARCTIS, FMA];
        const frCap: RawMicState = { ...defaultCapture(ARCTIS), label: `Par défaut - ${ARCTIS.label}` };
        expect(checkDefaultMoved(null, frCap, fr(ARCTIS)).moved).toBe(false);
        expect(checkDefaultMoved(null, plain, fr(ARCTIS)).moved).toBe(false);
        // ...and without groups the same rule decides.
        const noGrp = (l: InputEntry[]) => l.map(d => ({ ...d, groupId: '' }));
        expect(checkDefaultMoved(null, { ...plain, groupId: '' }, noGrp(windowsList(ARCTIS))).moved).toBe(false);
        expect(checkDefaultMoved(null, { ...plain, groupId: '' }, noGrp(windowsList(FMA))).moved).toBe(true);
        // A different device in one group is still a move, prefixed or not.
        const LINE: Dev = { deviceId: 'arctis-line', groupId: ARCTIS.groupId, label: 'Line In (2- Arctis Nova Pro Wireless)' };
        expect(checkDefaultMoved(null, frCap, fr(LINE)).moved).toBe(true);
        expect(checkDefaultMoved(null, plain, windowsList(LINE, LINE, [ARCTIS, LINE])).moved).toBe(true);
    });

    it('plainLabel / followedPseudo / describeMicError', () => {
        expect(plainLabel('Default - Microphone (FMA120)')).toBe('Microphone (FMA120)');
        expect(plainLabel('Communications - Headset (X)')).toBe('Headset (X)');
        expect(plainLabel('Microphone (FMA120)')).toBe('Microphone (FMA120)');
        expect(plainLabel('')).toBe('(unnamed)');
        expect(followedPseudo(null)).toBe('default');
        expect(followedPseudo('communications')).toBe('communications');
        expect(followedPseudo('arctis-id')).toBeNull();
        expect(describeMicError(new DOMException('Could not start audio source', 'NotReadableError')))
            .toBe('NotReadableError: Could not start audio source');
    });
});

// ── The watchdog ────────────────────────────────────────────────────────

class FakeMediaDevices extends EventTarget {
    inputs: InputEntry[] = windowsList(ARCTIS);
    enumerateDevices = vi.fn(async () => this.inputs.map(d => ({ ...d, kind: 'audioinput' as const, toJSON() { return d; } })));
    fire(n = 1) { for (let i = 0; i < n; i++) this.dispatchEvent(new Event('devicechange')); }
}

type Harness = {
    md: FakeMediaDevices;
    state: { inVoice: boolean; speakDenied: boolean; listenOnly: boolean; capture: RawMicState | null; selected: string | null };
    restarts: MicReacquireOptions[];
    lines: string[];
    rerouted: { n: number };
    native: { fire: (n: NativeDefaultChange) => void };
    /** What the next restart does. Default: open whatever 'default' names now. */
    onRestart: (o: MicReacquireOptions) => Promise<MicRestartOutcome | undefined>;
    stop: () => void;
};

function harness(): Harness {
    const md = new FakeMediaDevices();
    const h = {
        md,
        state: { inVoice: true, speakDenied: false, listenOnly: false, capture: defaultCapture(ARCTIS) as RawMicState | null, selected: null as string | null },
        restarts: [] as MicReacquireOptions[],
        lines: [] as string[],
        rerouted: { n: 0 },
        native: { fire: (_n: NativeDefaultChange) => { throw new Error('native not subscribed'); } },
        onRestart: async (): Promise<MicRestartOutcome | undefined> => {
            const def = md.inputs.find(d => d.deviceId === 'default')!;
            const dev = md.inputs.find(d => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.groupId === def.groupId)!;
            h.state.capture = defaultCapture(dev);
            return { ok: true, swapped: true };
        },
        stop: () => {},
    } as Harness;
    const deps: MicWatchdogDeps = {
        mediaDevices: md as unknown as MicWatchdogDeps['mediaDevices'],
        inVoice: () => h.state.inVoice,
        isSpeakDenied: () => h.state.speakDenied,
        isListenOnly: () => h.state.listenOnly,
        rawMic: () => h.state.capture,
        selectedInput: () => h.state.selected,
        restartMic: (o) => { h.restarts.push(o); return h.onRestart(o); },
        rerouteOutputs: () => { h.rerouted.n++; },
        log: (l) => { h.lines.push(l); },
        subscribeNative: (fn) => { h.native.fire = fn; return () => { h.native.fire = () => { throw new Error('unsubscribed'); }; }; },
    };
    h.stop = startMicDeviceWatchdog(deps);
    return h;
}

/** Let the settle timer fire and the async evaluate + restart finish. */
const settle = async (ms = SETTLE_MS) => { await vi.advanceTimersByTimeAsync(ms); };

let h: Harness;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { h?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the device watchdog follows a moved default', () => {
    it('a burst of devicechange events that moves the default: ONE re-acquire, after the settle wait, keeping the old mic on failure', async () => {
        h = harness();
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS, FMA, XM6]); // the XM6 arrives...
        h.md.fire(2);
        await vi.advanceTimersByTimeAsync(150);
        h.md.inputs = windowsList(FMA, FMA, [ARCTIS, FMA, XM6]); // ...and Audio Hub moves the default
        h.md.fire(3);
        await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
        expect(h.restarts).toHaveLength(0); // not before the burst has been quiet for SETTLE_MS
        await settle(1);
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        // Settled on the new device: more events, no more restarts.
        h.md.fire(4);
        await settle(SETTLE_MS * 3);
        expect(h.restarts).toHaveLength(1);
        expect(h.lines.some(l => l.includes('devicechange x5') && l.includes('the default moved, following it'))).toBe(true);
        expect(h.lines).toContain(`[mic] default input changed: ${ARCTIS.label} -> ${FMA.label}; re-acquired in 0 ms`);
        expect(h.rerouted.n).toBeGreaterThanOrEqual(2); // the output half runs on every settled burst
    });

    it('a device added or removed that is not the default: no re-acquire (and it says why)', async () => {
        h = harness();
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS, FMA, XM6]);
        h.md.fire(3);
        await settle();
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(0);
        expect(h.lines.filter(l => l.endsWith('still the same device'))).toHaveLength(2);
    });

    it('a specific microphone selected: the default moving is not followed', async () => {
        h = harness();
        h.state.selected = ARCTIS.deviceId;
        h.state.capture = { ended: false, muted: false, deviceId: ARCTIS.deviceId, groupId: ARCTIS.groupId, label: ARCTIS.label };
        h.md.inputs = windowsList(FMA);
        h.md.fire(3);
        await settle();
        expect(h.restarts).toHaveLength(0);
        expect(h.lines.some(l => l.includes('a specific microphone is selected'))).toBe(true);
    });

    it("the desktop shell's notification runs the same check, and with devicechange it is still ONE re-acquire", async () => {
        h = harness();
        h.md.inputs = windowsList(FMA);
        h.native.fire({ roles: ['console', 'communications'], console: FMA.label, communications: FMA.label });
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        expect(h.lines.some(l => l.includes(`windows default x1 (console+communications: ${FMA.label})`))).toBe(true);

        // Both sources for the next move: one restart between them.
        h.md.inputs = windowsList(ARCTIS);
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        h.native.fire({ roles: ['console'], console: ARCTIS.label });
        h.md.fire(2);
        await settle();
        expect(h.restarts).toHaveLength(2);
        expect(h.lines.some(l => l.includes('devicechange x2, windows default x1'))).toBe(true);
    });

    it('a native notification that changed nothing the page can see: no re-acquire', async () => {
        h = harness();
        h.native.fire({ roles: ['communications'], communications: FMA.label });
        await settle();
        expect(h.restarts).toHaveLength(0);
    });

    it('out of a call: nothing is evaluated and nothing is logged', async () => {
        h = harness();
        h.state.inVoice = false;
        h.md.inputs = windowsList(FMA);
        h.md.fire(3);
        h.native.fire({ roles: ['console'], console: FMA.label });
        await settle(SETTLE_MAX_MS * 2);
        expect(h.restarts).toHaveLength(0);
        expect(h.md.enumerateDevices).not.toHaveBeenCalled();
        expect(h.lines).toEqual([]);
    });

    it('without SPEAK the mic is never re-opened, but the outputs are still re-routed', async () => {
        h = harness();
        h.state.speakDenied = true;
        h.state.capture = null;
        h.state.listenOnly = true;
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind: 'ended' } }));
        await settle();
        expect(h.restarts).toHaveLength(0);
        expect(h.rerouted.n).toBe(1);
        expect(h.lines.some(l => l.includes('no SPEAK here'))).toBe(true);
    });

    it('never loops: a capture that cannot converge is followed once per default, not once per event', async () => {
        h = harness();
        // The restart "works" but the capture keeps reporting the old group
        // (an engine whose groups disagree, or a re-acquire that fell back).
        h.onRestart = async () => ({ ok: true, swapped: true });
        h.md.inputs = windowsList(FMA);
        for (let i = 0; i < 6; i++) {
            h.md.fire(2);
            await settle(FOLLOW_MIN_GAP_MS + SETTLE_MS);
        }
        expect(h.restarts).toHaveLength(1);
        expect(h.lines.filter(l => l.includes('already followed this default once'))).toHaveLength(5);
        // A DIFFERENT default is a new decision.
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(2);
    });

    it('two moves close together: the second follow waits for FOLLOW_MIN_GAP_MS, then re-checks and goes', async () => {
        h = harness();
        h.md.inputs = windowsList(FMA, FMA, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1);
        const firstAt = Date.now();
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1); // inside the gap
        expect(h.lines.some(l => l.includes('re-checking in'))).toBe(true);
        await vi.advanceTimersByTimeAsync(firstAt + FOLLOW_MIN_GAP_MS - Date.now() + 1);
        expect(h.restarts).toHaveLength(2);
        expect(h.state.capture?.groupId).toBe(XM6.groupId);
    });

    it('a stream of events that never goes quiet is still acted on within SETTLE_MAX_MS', async () => {
        h = harness();
        h.md.inputs = windowsList(FMA);
        for (let t = 0; t < SETTLE_MAX_MS + 1000; t += 500) {
            h.md.fire();
            await vi.advanceTimersByTimeAsync(500);
        }
        expect(h.restarts).toHaveLength(1);
    });

    it('a new default that cannot be opened is logged as kept, and retried only on a later event after FOLLOW_RETRY_MS', async () => {
        h = harness();
        h.onRestart = async () => ({ ok: false, error: 'NotReadableError: Could not start audio source', kept: true });
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.lines).toContain(`[mic] default input changed: ${ARCTIS.label} -> ${FMA.label}; could not open it (NotReadableError: Could not start audio source); kept ${ARCTIS.label}`);
        h.md.fire();
        await settle(FOLLOW_MIN_GAP_MS);
        expect(h.restarts).toHaveLength(1); // too soon
        expect(h.lines.some(l => l.includes('would not open') && l.includes(`retrying after ${FOLLOW_RETRY_MS / 1000} s`))).toBe(true);
        await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_MS);
        expect(h.restarts).toHaveLength(1); // no timer of its own: it waits for an event
        h.onRestart = async () => { h.state.capture = defaultCapture(FMA); return { ok: true, swapped: true }; };
        h.md.fire();
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }, { keepOldOnFailure: true }]);
        expect(h.lines).toContain(`[mic] default input changed: ${ARCTIS.label} -> ${FMA.label}; re-acquired in 0 ms`);
        // Converged: nothing more.
        h.md.fire();
        await settle(FOLLOW_RETRY_MS);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(2);
    });

    it('a failure AFTER the swap (publishing it) is not a reason to retry', async () => {
        h = harness();
        h.onRestart = async () => ({ ok: false, error: 'Error: publish failed', kept: false });
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.lines.some(l => l.includes('re-acquired but the restart then failed'))).toBe(true);
        await vi.advanceTimersByTimeAsync(FOLLOW_RETRY_MS);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1);
    });

    it('a device lost while a follow is running: the restarts are coalesced, and the queued one may not keep a dead mic', async () => {
        h = harness();
        let release!: () => void;
        h.onRestart = () => new Promise(r => { release = () => r({ ok: true, swapped: true }); });
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind: 'ended' } }));
        window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind: 'ended' } }));
        expect(h.restarts).toHaveLength(1); // queued behind the running one, not concurrent
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }, { keepOldOnFailure: false }]);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(2);
    });

    it('a follow queued behind a running restart, then a device lost: the ONE queued restart may not keep the old mic', async () => {
        h = harness();
        let release!: () => void;
        h.onRestart = () => new Promise(r => { release = () => r({ ok: true, swapped: true }); });
        window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind: 'ended' } }));
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }]);
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle(); // decides to follow; queued behind the running restart
        expect(h.restarts).toHaveLength(1);
        window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind: 'ended' } }));
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }, { keepOldOnFailure: false }]);
    });

    it('the existing recoveries still run: a dead capture, and the chosen device coming back', async () => {
        h = harness();
        h.state.capture = { ...defaultCapture(ARCTIS), ended: true };
        h.md.fire();
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }]);

        h.stop();
        h = harness();
        h.state.selected = FMA.deviceId;
        h.state.capture = defaultCapture(ARCTIS); // degraded to the default while the FMA was away
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(0);
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS, FMA]);
        h.md.fire();
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }]);
    });

    it('disposing stops everything', async () => {
        h = harness();
        h.stop();
        h.md.inputs = windowsList(FMA);
        h.md.fire(3);
        await settle(SETTLE_MAX_MS);
        expect(h.restarts).toHaveLength(0);
        expect(() => h.native.fire({})).toThrow('unsubscribed');
    });
});

const micLost = (kind: 'ended' | 'muted') =>
    window.dispatchEvent(new CustomEvent('sovereign:mic-device-lost', { detail: { kind } }));

/** Hold the next enumerateDevices() until released (a slow device list); the
 *  list it then returns is md.inputs at release time. */
function holdNextEnumerate(md: FakeMediaDevices): () => void {
    let release: (() => void) | null = null;
    md.enumerateDevices.mockImplementationOnce(() => new Promise(r => {
        release = () => r(md.inputs.map(d => ({ ...d, kind: 'audioinput' as const, toJSON() { return d; } })));
    }));
    return () => { release?.(); };
}

describe('the once-per-default rule holds only while the call is still on what that follow gave it', () => {
    it('followed, lost, back as the default: followed AGAIN (a Bluetooth headset out of range and back)', async () => {
        h = harness();
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]); // the XM6 connects and becomes the default
        h.md.fire(3);
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        expect(h.state.capture?.groupId).toBe(XM6.groupId);
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        // Out of range: its capture ends, Windows falls back to the Arctis,
        // and the device-lost restart re-opens the default there.
        h.md.inputs = windowsList(ARCTIS, ARCTIS, [ARCTIS, FMA]);
        micLost('ended');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(2);
        expect(h.state.capture?.groupId).toBe(ARCTIS.groupId);
        h.md.fire(2);
        await settle();
        expect(h.restarts).toHaveLength(2); // the removal's own events: nothing moved
        // Back in range, and Windows restores it as the default.
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire(3);
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }, { keepOldOnFailure: false }, { keepOldOnFailure: true }]);
        expect(h.state.capture?.groupId).toBe(XM6.groupId);
        expect(h.lines.some(l => l.includes('already followed'))).toBe(false);
        // Converged: more events change nothing.
        h.md.fire(3);
        await settle(FOLLOW_MIN_GAP_MS + SETTLE_MS);
        expect(h.restarts).toHaveLength(3);
    });

    it("followed, then the member's own Settings moved the capture (a specific mic, then Default again): followed AGAIN", async () => {
        h = harness();
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1);
        expect(h.state.capture?.groupId).toBe(FMA.groupId);
        // Settings: the Arctis picked by name, the default goes back to it,
        // then Default picked again. Those re-opens are the settings path, not
        // the watchdog's.
        h.state.selected = ARCTIS.deviceId;
        h.state.capture = { ended: false, muted: false, deviceId: ARCTIS.deviceId, groupId: ARCTIS.groupId, label: ARCTIS.label };
        h.md.inputs = windowsList(ARCTIS);
        h.md.fire();
        await settle();
        h.state.selected = null;
        h.state.capture = defaultCapture(ARCTIS);
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        h.md.inputs = windowsList(FMA);
        h.md.fire(3);
        await settle();
        expect(h.restarts).toHaveLength(2);
        expect(h.state.capture?.groupId).toBe(FMA.groupId);
    });

    it('a follow still opening (a slow Bluetooth open) is not started a second time by later events', async () => {
        h = harness();
        let release!: () => void;
        h.onRestart = () => new Promise(r => {
            release = () => { h.state.capture = defaultCapture(FMA); r({ ok: true, swapped: true }); };
        });
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1);
        for (let i = 0; i < 3; i++) {
            h.md.fire(2);
            await settle(FOLLOW_MIN_GAP_MS + SETTLE_MS);
        }
        expect(h.restarts).toHaveLength(1);
        expect(h.lines.some(l => l.includes('already following this default'))).toBe(true);
        release();
        await vi.advanceTimersByTimeAsync(0);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(1);
    });

    it('two follows queued behind a slow restart merge into the LATER one, and it counts as that follow', async () => {
        h = harness();
        let release!: () => void;
        h.onRestart = () => new Promise(r => { release = () => r({ ok: true, swapped: true }); });
        micLost('ended'); // a restart that hangs (a Bluetooth open)
        expect(h.restarts).toHaveLength(1);
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle(); // follow FMA: queued
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle(); // follow the XM6: merged into the queued one
        expect(h.restarts).toHaveLength(1);
        // The merged follow cannot open the XM6 (busy): it is the XM6's
        // follow that failed, so the XM6 waits out the retry time.
        h.onRestart = async () => ({ ok: false, error: 'NotReadableError: Could not start audio source', kept: true });
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }, { keepOldOnFailure: true }]);
        expect(h.lines).toContain(`[mic] default input changed: ${ARCTIS.label} -> ${XM6.label}; could not open it (NotReadableError: Could not start audio source); kept ${ARCTIS.label}`);
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(2);
        expect(h.lines.some(l => l.includes('would not open'))).toBe(true);
    });

    it('a follow merged away into a lost-device restart leaves no trace of an EARLIER follow behind', async () => {
        h = harness();
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.state.capture?.groupId).toBe(FMA.groupId); // followed the FMA
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        const held: Array<() => void> = [];
        h.onRestart = () => new Promise(r => { held.push(() => r({ ok: true, swapped: true })); });
        micLost('muted'); // the FMA wedges: a restart that hangs
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle(); // follow the XM6: queued
        micLost('ended'); // ...and merged away into a lost-device restart
        // The default flaps back to the FMA while those run, so they re-open
        // it: the call ends up on the same FMA capture the first follow gave.
        h.md.inputs = windowsList(FMA, FMA, [ARCTIS, FMA, XM6]);
        held.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        held.shift()?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.state.capture).toEqual(defaultCapture(FMA));
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }, { keepOldOnFailure: false }, { keepOldOnFailure: false }]);
        // The XM6 is the default again: its follow never ran, so it runs now.
        h.onRestart = async () => { h.state.capture = defaultCapture(XM6); return { ok: true, swapped: true }; };
        await vi.advanceTimersByTimeAsync(FOLLOW_MIN_GAP_MS);
        h.md.inputs = windowsList(XM6, XM6, [ARCTIS, FMA, XM6]);
        h.md.fire();
        await settle();
        expect(h.restarts).toHaveLength(4);
        expect(h.state.capture?.groupId).toBe(XM6.groupId);
    });

    it('two endpoints of one sound card: the move between them is followed', async () => {
        const MIC: Dev = { deviceId: 'rtk-mic', groupId: 'grp-rtk', label: 'Microphone (Realtek(R) Audio)' };
        const LINE: Dev = { deviceId: 'rtk-line', groupId: 'grp-rtk', label: 'Line In (Realtek(R) Audio)' };
        h = harness();
        h.state.capture = defaultCapture(MIC);
        h.onRestart = async () => { h.state.capture = defaultCapture(LINE); return { ok: true, swapped: true }; };
        h.md.inputs = windowsList(LINE, LINE, [MIC, LINE]);
        h.md.fire(3);
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        h.md.fire();
        await settle(FOLLOW_MIN_GAP_MS);
        expect(h.restarts).toHaveLength(1);
    });
});

describe('the watchdog guards (each one fails a test when removed)', () => {
    it("'muted' device-lost restarts are throttled to one per MUTED_RESTART_MIN_GAP_MS; 'ended' ones are not", async () => {
        h = harness();
        micLost('muted');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toEqual([{ keepOldOnFailure: false }]);
        await vi.advanceTimersByTimeAsync(5000);
        micLost('muted'); // a wedged device handing back another born-muted track
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(1);
        micLost('ended');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(MUTED_RESTART_MIN_GAP_MS);
        micLost('muted');
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(3);
    });

    it('a restart that lands while the device list is being read: the decision uses the capture as it is NOW', async () => {
        h = harness();
        const release = holdNextEnumerate(h.md);
        h.md.inputs = windowsList(FMA);
        h.md.fire();
        await settle();
        expect(h.md.enumerateDevices).toHaveBeenCalledTimes(1);
        h.state.capture = defaultCapture(FMA); // e.g. a noise-mode change re-opened 'default' meanwhile
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(0);
        expect(h.lines.some(l => l.endsWith('still the same device'))).toBe(true);
    });

    it('evaluations never overlap: events during one wait for it, and are then evaluated', async () => {
        h = harness();
        const release = holdNextEnumerate(h.md);
        h.md.fire();
        await settle();
        h.md.inputs = windowsList(FMA);
        h.md.fire(2);
        await settle();
        expect(h.md.enumerateDevices).toHaveBeenCalledTimes(1); // the second waits its turn
        release(); // the first one's list: the default moved by then
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        await settle(); // the deferred evaluation
        expect(h.md.enumerateDevices).toHaveBeenCalledTimes(2);
        expect(h.restarts).toHaveLength(1);
        expect(h.lines.some(l => l.includes('devicechange x2'))).toBe(true);
    });

    it('a restart queued behind a running one does not start once the member has left the call', async () => {
        h = harness();
        let release!: () => void;
        h.onRestart = () => new Promise(r => { release = () => r({ ok: true, swapped: true }); });
        micLost('ended');
        micLost('ended'); // queued
        expect(h.restarts).toHaveLength(1);
        h.state.inVoice = false;
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.restarts).toHaveLength(1);
    });

    it("on Chromium's Communications entry, a communications move is followed and a default-only move is not", async () => {
        h = harness();
        h.state.selected = 'communications';
        h.state.capture = defaultCapture(ARCTIS, 'communications');
        h.onRestart = async () => {
            const comm = h.md.inputs.find(d => d.deviceId === 'communications')!;
            const dev = [ARCTIS, FMA, XM6].find(d => d.groupId === comm.groupId)!;
            h.state.capture = defaultCapture(dev, 'communications');
            return { ok: true, swapped: true };
        };
        h.md.inputs = windowsList(FMA, ARCTIS); // the console default moved, communications did not
        h.md.fire(3);
        await settle();
        expect(h.restarts).toHaveLength(0);
        h.md.inputs = windowsList(FMA, FMA);
        h.md.fire(3);
        await settle();
        expect(h.restarts).toEqual([{ keepOldOnFailure: true }]);
        expect(h.state.capture?.groupId).toBe(FMA.groupId);
    });

    it('leaving the call, or losing SPEAK, while the device list is read: no restart, and no claim of one', async () => {
        for (const lose of ['left the call', 'SPEAK withdrawn'] as const) {
            h = harness();
            const release = holdNextEnumerate(h.md);
            h.md.inputs = windowsList(FMA);
            h.md.fire(3);
            await settle();
            if (lose === 'left the call') h.state.inVoice = false;
            else h.state.speakDenied = true;
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(h.restarts, lose).toHaveLength(0);
            expect(h.lines.some(l => l.includes('following it')), lose).toBe(false);
            h.stop();
        }
    });
});

// ── MediaManager: keep the old mic when the new default will not open ────

class FakeTrack extends EventTarget {
    kind = 'audio';
    enabled = true;
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    label: string;
    private settings: MediaTrackSettings;
    constructor(dev: Dev) {
        super();
        this.label = `Default - ${dev.label}`;
        this.settings = { deviceId: 'default', groupId: dev.groupId };
    }
    getSettings() { return this.settings; }
    stop() { this.readyState = 'ended'; }
}
class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return [] as FakeTrack[]; }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* not needed */ }
    removeEventListener() { /* not needed */ }
}
const notReadable = () => new DOMException('Could not start audio source', 'NotReadableError');

describe('MediaManager.reacquireAudioTrack({ keepOldOnFailure })', () => {
    let getUserMedia: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.useRealTimers();
        getUserMedia = vi.fn();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        localStorage.clear();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the new default will not open: the old mic stays in the call, live, and it rejects', async () => {
        const old = new FakeTrack(ARCTIS);
        getUserMedia.mockResolvedValueOnce(new FakeStream([old])).mockRejectedValueOnce(notReadable());
        const media = new MediaManager();
        const stream = await media.getLocalStream(true, false);
        await expect(media.reacquireAudioTrack({ keepOldOnFailure: true })).rejects.toMatchObject({ name: 'NotReadableError' });
        expect(stream.getAudioTracks()).toEqual([old]);
        expect(old.readyState).toBe('live');
        expect(media.isListenOnly()).toBe(false);
        expect(media.rawMicState()).toMatchObject({ ended: false, deviceId: 'default', groupId: ARCTIS.groupId, label: `Default - ${ARCTIS.label}` });
    });

    it('control: without the option the same failure goes listen-only, as a lost device should', async () => {
        getUserMedia.mockResolvedValueOnce(new FakeStream([new FakeTrack(ARCTIS)])).mockRejectedValueOnce(notReadable());
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        await expect(media.reacquireAudioTrack()).resolves.toBeNull();
        expect(media.isListenOnly()).toBe(true);
    });

    it('nothing to keep: if the old capture already died, the option does not hold on to it', async () => {
        const old = new FakeTrack(ARCTIS);
        getUserMedia.mockResolvedValueOnce(new FakeStream([old])).mockRejectedValueOnce(notReadable());
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        old.readyState = 'ended';
        await expect(media.reacquireAudioTrack({ keepOldOnFailure: true })).resolves.toBeNull();
        expect(media.isListenOnly()).toBe(true);
    });

    it('a muted member: the new default comes up muted, and the watch moves to it', async () => {
        const old = new FakeTrack(ARCTIS);
        const fresh = new FakeTrack(FMA);
        getUserMedia.mockResolvedValueOnce(new FakeStream([old])).mockResolvedValueOnce(new FakeStream([fresh]));
        const media = new MediaManager();
        const stream = await media.getLocalStream(true, false);
        old.enabled = false; // muted (setAudioEnabled(false))
        const res = await media.reacquireAudioTrack({ keepOldOnFailure: true });
        expect(res?.newTrack).toBe(fresh as unknown as MediaStreamTrack);
        expect(fresh.enabled).toBe(false);
        expect(old.readyState).toBe('ended');
        expect(stream.getAudioTracks()).toEqual([fresh]);
        expect(media.rawMicState()).toMatchObject({ groupId: FMA.groupId, label: `Default - ${FMA.label}` });
        // The swap re-opened the device with the call's own constraints.
        expect(getUserMedia.mock.calls[1][0]).toMatchObject({ audio: { channelCount: 1 } });
    });

    /** Start a re-acquire whose open is held until the returned function
     *  hands it `fresh` (or rejects with `err`). */
    async function heldReacquire(opts: MicReacquireOptions, gateOpenAtStart = true) {
        const old = new FakeTrack(ARCTIS);
        let settle!: (s: FakeStream | DOMException) => void;
        getUserMedia.mockResolvedValueOnce(new FakeStream([old]))
            .mockImplementationOnce(() => new Promise((res, rej) => { settle = (s) => (s instanceof FakeStream ? res(s) : rej(s)); }));
        const media = new MediaManager();
        const stream = await media.getLocalStream(true, false);
        old.enabled = gateOpenAtStart;
        const p = media.reacquireAudioTrack(opts);
        await new Promise(r => setTimeout(r, 0));
        expect(getUserMedia).toHaveBeenCalledTimes(2); // the new default is opening
        return { media, stream, old, p, finish: (s: FakeStream | DOMException) => settle(s) };
    }

    it('the member MUTES while the new default is opening: the new track comes up disabled', async () => {
        const { media, p, finish } = await heldReacquire({ keepOldOnFailure: true });
        // Mute / push-to-talk released: setAudioEnabled(false) reaches the
        // tracks in the local stream, which is still the OLD one.
        media.getLocalStreamSync()?.getAudioTracks().forEach(t => { t.enabled = false; });
        const fresh = new FakeTrack(FMA);
        finish(new FakeStream([fresh]));
        const res = await p;
        expect(res?.newTrack).toBe(fresh as unknown as MediaStreamTrack);
        // This is what replaceTrack puts on every mesh sender and the SFU
        // publishes, before VoicePanel re-asserts the gate.
        expect(fresh.enabled).toBe(false);
    });

    it('...and one who PRESSES push-to-talk while it opens gets an open track', async () => {
        const { media, p, finish } = await heldReacquire({ keepOldOnFailure: true }, false);
        media.getLocalStreamSync()?.getAudioTracks().forEach(t => { t.enabled = true; });
        const fresh = new FakeTrack(FMA);
        fresh.enabled = false;
        finish(new FakeStream([fresh]));
        await p;
        expect(fresh.enabled).toBe(true);
    });

    it('a capture replaced while the new default was opening is not "kept": the failure goes the usual way', async () => {
        const { media, p, finish } = await heldReacquire({ keepOldOnFailure: true });
        // Something else moved the device watch onto another capture
        // meanwhile; the one this follow would "keep" is no longer the call's.
        (media as unknown as { armMicDeviceWatch(t: unknown): void }).armMicDeviceWatch(new FakeTrack(XM6));
        finish(notReadable());
        await expect(p).resolves.toBeNull();
        expect(media.isListenOnly()).toBe(true);
    });

    it('already listen-only: a follow that cannot open does not claim to keep a mic', async () => {
        const old = new FakeTrack(ARCTIS);
        getUserMedia.mockResolvedValueOnce(new FakeStream([old]))
            .mockRejectedValueOnce(notReadable())
            .mockRejectedValueOnce(notReadable());
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        await expect(media.reacquireAudioTrack()).resolves.toBeNull(); // a restart found no mic
        expect(media.isListenOnly()).toBe(true);
        await expect(media.reacquireAudioTrack({ keepOldOnFailure: true })).resolves.toBeNull();
        expect(media.isListenOnly()).toBe(true);
    });
});
