/**
 * Settings > Voice & Video > Output Device, for audio that is NOT voice.
 *
 * Found 2026-09-28 at 0.9.823: the chosen device was honoured for voice only.
 * Notification sounds (utils/audioFeedback) and watched-stream audio play
 * through an AudioContext, and both always went to the OS default — the wrong
 * device for anyone who picked one, and a leak to whatever the default was (a
 * game-streaming host that makes a virtual cable the default sent every ping
 * to the TV).
 *
 * The routing core is shared with the voice path, and building it exposed two
 * ordering bugs that path had too, both reproduced in real Edge 154:
 *   - switching back to Default while a switch was in flight was skipped,
 *     because `sinkId` still read '' — the target ended on the device being
 *     switched to;
 *   - a stale fallback to the default, issued after a NEWER request, landed
 *     last and overrode it.
 * FakeSink (fixtures/fakeSink.ts) models the measured semantics, so both are
 * visible here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    FakeSink, flushMicrotasks, installDeviceChangeEvents, memoryLocalStorage,
} from './fixtures/fakeSink';

type Store = typeof import('../components/settingsStore');

async function freshStore(): Promise<Store> {
    return import('../components/settingsStore');
}

function choose(store: Store, outputDeviceId: string) {
    store.saveSettings({ ...store.loadSettings(), outputDeviceId });
}

/** An AudioContext-shaped FakeSink. */
function fakeContext(devices: Set<string>, state: AudioContextState = 'running') {
    const sink = new FakeSink(devices);
    return Object.assign(sink, { state }) as unknown as FakeSink & AudioContext;
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('applyOutputDeviceToContext', () => {
    it('routes a context to the chosen device', async () => {
        const store = await freshStore();
        choose(store, 'headset-1');
        const ctx = fakeContext(new Set(['headset-1']));
        const done = store.applyOutputDeviceToContext(ctx);
        await ctx.settle();
        await done;
        expect(ctx.calls).toEqual(['headset-1']);
        expect(ctx.sinkId).toBe('headset-1');
    });

    it('leaves a context on the default alone when Settings say default', async () => {
        const store = await freshStore();
        const ctx = fakeContext(new Set());
        await store.applyOutputDeviceToContext(ctx);
        expect(ctx.calls).toEqual([]);
    });

    it('returns a routed context to the default sink when Settings go back to default', async () => {
        const store = await freshStore();
        const ctx = fakeContext(new Set(['headset-1']));
        ctx.sinkId = 'headset-1';
        const done = store.applyOutputDeviceToContext(ctx);
        await ctx.settle();
        await done;
        expect(ctx.calls).toEqual(['']);
        expect(ctx.sinkId).toBe('');
    });

    it('falls back to the default sink, and settles, when the chosen device is gone', async () => {
        const store = await freshStore();
        choose(store, 'gone');
        const ctx = fakeContext(new Set());
        const done = store.applyOutputDeviceToContext(ctx);
        await ctx.settle();
        await expect(done).resolves.toBeUndefined();
        expect(ctx.calls).toEqual(['gone', '']);
        expect(ctx.sinkId).toBe('');
    });

    it('is a no-op where AudioContext.setSinkId does not exist (today\'s behaviour)', async () => {
        const store = await freshStore();
        choose(store, 'headset-1');
        const ctx = { state: 'running' } as unknown as AudioContext;
        await expect(store.applyOutputDeviceToContext(ctx)).resolves.toBeUndefined();
    });

    it('never touches a closed context', async () => {
        const store = await freshStore();
        choose(store, 'headset-1');
        const ctx = fakeContext(new Set(['headset-1']), 'closed');
        await store.applyOutputDeviceToContext(ctx);
        expect(ctx.calls).toEqual([]);
    });
});

// Both orderings apply to every sink target — the element (voice) path and
// the context path share one core — so each is pinned on both.
describe.each([
    ['an <audio> element (the voice path)', 'element'],
    ['an AudioContext', 'context'],
] as const)('routing races on %s', (_label, kind) => {
    async function setup(devices: string[]) {
        const store = await freshStore();
        const target = fakeContext(new Set(devices));
        const apply = (): Promise<void> => kind === 'element'
            ? store.applyOutputDevice(target as unknown as HTMLMediaElement)
            : store.applyOutputDeviceToContext(target);
        return { store, target, apply };
    }

    it('back to Default while a switch is still in flight ends on the default', async () => {
        const { store, target, apply } = await setup(['headset-1']);
        choose(store, 'headset-1');
        void apply();
        // sinkId still reads '' — the switch has not landed yet.
        expect(target.sinkId).toBe('');
        choose(store, 'default');
        void apply();
        await target.settle();
        expect(target.calls).toEqual(['headset-1', '']);
        expect(target.sinkId).toBe('');
    });

    it('a stale fallback never overrides a newer request', async () => {
        const { store, target, apply } = await setup(['headset-1']);
        choose(store, 'gone');
        void apply();
        choose(store, 'headset-1');
        void apply();
        await target.settle();
        expect(target.sinkId).toBe('headset-1');
        expect(target.calls).toEqual(['gone', 'headset-1']);
    });
});

describe('positive control: the voice path still routes', () => {
    it('applyOutputDevice (what VoicePanel calls on every <audio>) sets the chosen sink', async () => {
        // Same fake, same setting, the known-good path: if this goes red the
        // fixture is broken, not the context routing.
        const store = await freshStore();
        choose(store, 'headset-1');
        const el = new FakeSink(new Set(['headset-1']));
        const done = store.applyOutputDevice(el as unknown as HTMLMediaElement);
        await el.settle();
        await done;
        expect(el.calls).toEqual(['headset-1']);
        expect(el.sinkId).toBe('headset-1');
    });
});

/* --------------------------------------------------------------------------
   Notification sounds (utils/audioFeedback)
   -------------------------------------------------------------------------- */

/** What the listener hears: each sound, tagged with the sink it started on. */
let heard: string[] = [];
let contexts: FakeNotifContext[] = [];
let devices = new Set<string>();

class FakeNotifContext extends FakeSink {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
        super(devices);
        contexts.push(this);
    }
    resume = vi.fn(async () => { this.state = 'running'; });
    createOscillator() {
        return {
            connect: () => {},
            frequency: { value: 0 },
            type: 'sine',
            start: () => { heard.push(`tone@${this.sinkId || 'default'}`); },
            stop: () => {},
        };
    }
    createGain() {
        return {
            connect: () => {},
            gain: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
        };
    }
    createBufferSource() {
        return {
            buffer: null as unknown,
            connect: () => {},
            start: () => { heard.push(`clip@${this.sinkId || 'default'}`); },
            stop: () => {},
        };
    }
    decodeAudioData = vi.fn(async () => ({ duration: 1 }) as unknown as AudioBuffer);
}

/** A runtime whose AudioContext predates setSinkId (Chromium < 110, Firefox, Safari). */
class SinklessContext {
    state: AudioContextState = 'running';
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => { this.state = 'running'; });
    createOscillator() {
        return {
            connect: () => {}, frequency: { value: 0 }, type: 'sine',
            start: () => { heard.push('tone@default'); }, stop: () => {},
        };
    }
    createGain() {
        return { connect: () => {}, gain: { value: 0, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} } };
    }
}

describe('notification sounds follow the chosen Output Device', () => {
    let deviceEvents: ReturnType<typeof installDeviceChangeEvents>;

    beforeEach(() => {
        heard = [];
        contexts = [];
        devices = new Set(['headset-1', 'speakers-2']);
        vi.stubGlobal('AudioContext', FakeNotifContext);
        deviceEvents = installDeviceChangeEvents();
    });

    afterEach(() => {
        deviceEvents.uninstall();
    });

    async function load() {
        const store = await freshStore();
        const fx = await import('../utils/audioFeedback');
        return { store, fx };
    }

    it('a ping plays on the chosen device — and not before the switch has landed', async () => {
        const { store, fx } = await load();
        choose(store, 'headset-1');
        fx.playMessageSound();
        const ctx = contexts[0];
        expect(ctx.calls).toEqual(['headset-1']);
        // Held in flight: the context is still on the OS default, so nothing
        // may sound yet — that is the leak.
        await flushMicrotasks();
        expect(heard).toEqual([]);
        await ctx.settle();
        await flushMicrotasks();
        expect(heard).toEqual(['tone@headset-1']);
    });

    it('a Settings change moves the next ping', async () => {
        const { store, fx } = await load();
        choose(store, 'headset-1');
        fx.playMessageSound();
        const ctx = contexts[0];
        await ctx.settle();
        await flushMicrotasks();
        heard = [];

        choose(store, 'speakers-2'); // saveSettings dispatches settingsChanged
        expect(ctx.calls).toEqual(['headset-1', 'speakers-2']);
        fx.playMessageSound();
        await ctx.settle();
        await flushMicrotasks();
        expect(heard).toEqual(['tone@speakers-2']);
    });

    it('chases a chosen device that was missing and comes back (devicechange)', async () => {
        const { store, fx } = await load();
        devices.delete('headset-1'); // headset off when the first ping plays
        choose(store, 'headset-1');
        fx.playMessageSound();
        const ctx = contexts[0];
        await ctx.settle();
        await flushMicrotasks();
        expect(heard).toEqual(['tone@default']); // fell back: keeps playing somewhere

        devices.add('headset-1');
        deviceEvents.fire();
        await ctx.settle();
        heard = [];
        fx.playMessageSound();
        await flushMicrotasks();
        expect(heard).toEqual(['tone@headset-1']);
    });

    it('a custom join clip waits for the chosen device too', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        }) as Response));
        const { store, fx } = await load();
        choose(store, 'headset-1');
        const played = fx.playCustomUserSound('https://example.test/clip.ogg');
        await flushMicrotasks();
        const ctx = contexts[0];
        expect(ctx.calls).toEqual(['headset-1']);
        expect(heard).toEqual([]);
        await ctx.settle();
        await expect(played).resolves.toBe(true);
        expect(heard).toEqual(['clip@headset-1']);
    });

    it('on the default device, pings play with no routing call at all', async () => {
        const { fx } = await load();
        fx.playMessageSound();
        await flushMicrotasks();
        expect(contexts[0].calls).toEqual([]);
        expect(heard).toEqual(['tone@default']);
    });

    it('still plays where AudioContext.setSinkId does not exist', async () => {
        vi.stubGlobal('AudioContext', SinklessContext);
        const { store, fx } = await load();
        choose(store, 'headset-1');
        fx.playMessageSound();
        await flushMicrotasks();
        expect(heard).toEqual(['tone@default']);
    });
});
