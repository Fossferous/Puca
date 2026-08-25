/**
 * Tests for the custom join/leave clip overlap guard (playCustomUserSound).
 *
 * The guard exists so two people joining at once don't play two arbitrary
 * user-uploaded clips on top of each other. The first cut was check-then-act
 * ACROSS the fetch+decode awaits: both callers read clipPlayingUntil=0, both
 * loaded, both played — the failure landed exactly on first hearings, when
 * nothing was cached yet. It also anchored the deadline at entry time, so a
 * load slower than the clip left the guard already expired mid-playback.
 *
 * These tests drive the real module against fake AudioContext/fetch, so they
 * fail if the slot is ever released early or claimed after an await again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Number of BufferSources actually started — i.e. clips the user hears. */
let started = 0;
/** Resolvers for in-flight fetches, so a test can hold a load open. */
let pendingFetches: Array<() => void> = [];

class FakeAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => { this.state = 'running'; });
    createGain() { return { gain: { value: 0 }, connect: () => {} }; }
    createBufferSource() {
        return {
            buffer: null as unknown,
            connect: () => {},
            start: () => { started++; },
            stop: () => {},
        };
    }
    decodeAudioData = vi.fn(async () => ({ duration: 1.0 }) as unknown as AudioBuffer);
}

beforeEach(() => {
    started = 0;
    pendingFetches = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('localStorage', {
        getItem: () => null, setItem: () => {}, removeItem: () => {},
    });
    // Every fetch parks until the test releases it, modelling a real download.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
        pendingFetches.push(() => resolve({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        } as Response));
    })));
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Fresh module instance (module-level cache/guard state must not leak). */
async function loadModule() {
    const settings = await import('../components/settingsStore');
    vi.spyOn(settings, 'notifEnabled').mockReturnValue(true);
    vi.spyOn(settings, 'outputGain').mockReturnValue(1);
    return await import('../utils/audioFeedback');
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('playCustomUserSound overlap guard', () => {
    it('two simultaneous uncached clips play ONE, not both', async () => {
        const { playCustomUserSound } = await loadModule();

        // Both callers start while nothing is cached and nothing is playing —
        // the exact burst the guard exists for (two peers join together).
        const a = playCustomUserSound('https://x/files/clip-a');
        const b = playCustomUserSound('https://x/files/clip-b');
        await flush();

        // Release both downloads at the same moment.
        pendingFetches.forEach(done => done());
        const [okA, okB] = await Promise.all([a, b]);

        expect(started).toBe(1);           // exactly one clip audible
        expect(okA && okB).toBe(true);     // the swallowed one still reports handled,
                                           // so the caller does NOT add a fallback chime
    });

    it('a failed load releases the slot so the next clip is not silenced', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false } as Response)));
        const { playCustomUserSound } = await loadModule();

        const failed = await playCustomUserSound('https://x/files/gone');
        expect(failed).toBe(false);        // caller falls back to the synth chime

        // Slot must be free immediately — a 404 must not mute clips for 5s.
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, arrayBuffer: async () => new ArrayBuffer(8),
        } as Response)));
        const ok = await playCustomUserSound('https://x/files/good');
        expect(ok).toBe(true);
        expect(started).toBe(1);
    });

    it('a clip that follows a finished one still plays (guard is not sticky)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, arrayBuffer: async () => new ArrayBuffer(8),
        } as Response)));
        const { playCustomUserSound } = await loadModule();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            expect(await playCustomUserSound('https://x/files/one')).toBe(true);
            expect(started).toBe(1);
            // Clip is 1.0s long; once it has elapsed the slot must reopen.
            vi.advanceTimersByTime(1500);
            expect(await playCustomUserSound('https://x/files/two')).toBe(true);
            expect(started).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
