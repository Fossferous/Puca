/**
 * The desktop-audio Channel's LIFECYCLE, through the REAL `Channel` class of
 * @tauri-apps/api (not a fake), against a stand-in for the page side of
 * Tauri's IPC that mirrors tauri-2.11.5 scripts/core.js: a callback map,
 * `runCallback`, and the `{ message, index }` / `{ end: true, index }`
 * envelopes ipc/channel.rs evaluates in the page.
 *
 * What it pins (nativeCaptureAudioWire.test.ts covers what a message DOES):
 *  - every start hands the shell a channel of its own, and once the shell
 *    drops its end (the capture thread ending after a stop, or a refused
 *    start dropping it at once) the page's callback is gone: restarting the
 *    buffer all evening registers nothing that outlives its capture;
 *  - the shell's messages are played in the order it SENT them. A silent
 *    run is only its header and packet table (24 + 8 bytes a packet: 56 for
 *    this file's four packets, 104 for the shell's usual ten), which tauri
 *    evaluates in the page directly,
 *    while a batch of sound is >= 1 KiB and goes eval -> fetch -> callback,
 *    so a silent run can overtake the batch before it; the Channel's index puts
 *    them back in order.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/platform', () => ({ isTauri: () => true }));

type Envelope = { message: unknown; index: number } | { end: true; index: number };

/** tauri-2.11.5 scripts/core.js, the parts a Channel touches, plus a shell
 *  that answers start/stop the way lib.rs does. */
class FakeIpc {
    callbacks = new Map<number, (data: unknown) => void>();
    next = 1;
    /** The channel id each start was handed, in order. */
    channels: number[] = [];
    /** Per channel: the next envelope index the shell will use. */
    sent = new Map<number, number>();
    refuse = false;
    /** The shell drops its end when the capture's thread ends (a stop). */
    dropOnStop = true;
    generation = 0;
    invokes: string[] = [];

    install(): void {
        // Arrow functions: `this` is the FakeIpc throughout.
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
            transformCallback: (cb: (data: unknown) => void, once = false) => {
                const id = this.next++;
                this.callbacks.set(id, (data) => { if (once) this.callbacks.delete(id); cb(data); });
                return id;
            },
            unregisterCallback: (id: number) => { this.callbacks.delete(id); },
            runCallback: (id: number, data: unknown) => { this.callbacks.get(id)?.(data); },
            invoke: async (cmd: string, args: Record<string, unknown>) => {
                this.invokes.push(cmd);
                if (cmd === 'start_clip_desktop_audio') {
                    const id = (args.onAudio as { id: number }).id;
                    this.channels.push(id);
                    this.sent.set(id, 0);
                    if (this.refuse) {
                        // A refused start drops the channel it was handed at once.
                        this.end(id);
                        throw 'Already capturing desktop audio';
                    }
                    return { device_name: 'Speakers', generation: ++this.generation };
                }
                if (cmd === 'stop_clip_desktop_audio') {
                    const id = this.channels[this.channels.length - 1];
                    if (this.dropOnStop) this.end(id);
                    return null;
                }
                throw new Error(`unexpected command ${cmd}`);
            },
        };
    }

    /** What ipc/channel.rs evaluates for one send, `at` a given index. */
    deliver(id: number, env: Envelope): void {
        (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, d: unknown) => void } })
            .__TAURI_INTERNALS__.runCallback(id, env);
    }
    send(id: number, message: ArrayBuffer): number {
        const index = this.sent.get(id)!;
        this.sent.set(id, index + 1);
        this.deliver(id, { message, index });
        return index;
    }
    /** ChannelInner's Drop: `{ end: true, index }`. */
    end(id: number): void {
        this.deliver(id, { end: true, index: this.sent.get(id)! });
    }
}

class StubAudioContext {
    static last: StubAudioContext | null = null;
    state = 'running';
    currentTime = 0;
    starts: number[] = [];
    constructor(_opts?: unknown) { StubAudioContext.last = this; }
    createMediaStreamDestination() { return { channelCount: 2, stream: { getAudioTracks: () => [{ kind: 'audio' }] } }; }
    createBuffer(_channels: number, frames: number, rate: number) { return { duration: frames / rate, copyToChannel: () => { } }; }
    createBufferSource() {
        const starts = this.starts;
        return { buffer: null, onended: null as null | (() => void), connect: () => { }, start: (when: number) => { starts.push(when); }, stop: () => { } };
    }
    async resume() { }
    async close() { }
}

/** A message as clip_audio_wire.rs audio_frame builds one: 40 ms of stereo
 *  sound in four packets read 10 ms apart or, `silent`, the same with no
 *  samples. */
function message(generation: number, silent = false): ArrayBuffer {
    const frames = 1920, at = 24 + 8 * 4;
    const b = new ArrayBuffer(at + (silent ? 0 : 2 * frames * 4));
    const v = new DataView(b);
    v.setUint8(0, 1); v.setUint8(1, silent ? 1 : 0);
    v.setBigUint64(2, BigInt(generation), true);
    v.setUint32(10, 48000, true); v.setUint16(14, 2, true);
    v.setUint32(16, frames, true); v.setUint32(20, 4, true);
    for (let k = 0; k < 4; k++) { v.setUint32(24 + 8 * k, 480, true); v.setUint32(28 + 8 * k, (3 - k) * 10_000, true); }
    return b;
}

let ipc: FakeIpc;
beforeEach(() => {
    ipc = new FakeIpc();
    ipc.install();
    (window as unknown as Record<string, unknown>).AudioContext = StubAudioContext;
});

describe('the desktop-audio channel lifecycle (the real tauri Channel)', () => {
    test('every start has its own channel, and a capture that ends leaves no callback behind', async () => {
        const { startNativeSystemAudioTrack } = await import('../api/clips/nativeCapture');
        const baseline = ipc.callbacks.size;
        for (let i = 0; i < 5; i++) {
            const h = await startNativeSystemAudioTrack(undefined, null);
            const id = ipc.channels[i];
            expect(ipc.callbacks.has(id), 'the channel is live while its capture runs').toBe(true);
            ipc.send(id, message(i + 1));
            ipc.send(id, message(i + 1, true));
            expect(StubAudioContext.last!.starts, `restart ${i}: its own messages play`).toEqual([0.05]);
            await h.stop();
        }
        expect(new Set(ipc.channels).size, 'a new channel per start, never a shared one').toBe(5);
        expect(ipc.callbacks.size, 'five restarts leave nothing registered').toBe(baseline);

        // POSITIVE CONTROL: the same count does see a channel the shell never
        // released (a capture thread that is still running).
        ipc.dropOnStop = false;
        const h = await startNativeSystemAudioTrack(undefined, null);
        await h.stop();
        expect(ipc.callbacks.size).toBe(baseline + 1);
    });

    test('a refused start releases its channel and stops nothing', async () => {
        const { startNativeSystemAudioTrack } = await import('../api/clips/nativeCapture');
        const baseline = ipc.callbacks.size;
        ipc.refuse = true;
        await expect(startNativeSystemAudioTrack(undefined, null)).rejects.toThrow('Already capturing');
        expect(ipc.callbacks.size).toBe(baseline);
        expect(ipc.invokes).toEqual(['start_clip_desktop_audio']);
    });

    test('a silent run that overtakes the batch before it is still played in the order the shell sent them', async () => {
        const { startNativeSystemAudioTrack } = await import('../api/clips/nativeCapture');
        const h = await startNativeSystemAudioTrack(undefined, null);
        const id = ipc.channels[0];
        const ctx = StubAudioContext.last!;
        // The shell sends: sound (index 0, >= 1 KiB: eval -> fetch), a silent
        // run (index 1, < 1 KiB: evaluated directly), sound (index 2). The
        // silent run lands first.
        ipc.deliver(id, { message: message(1, true), index: 1 });
        expect(ctx.starts, 'held until index 0 arrives').toEqual([]);
        ipc.deliver(id, { message: message(1), index: 0 });
        ipc.deliver(id, { message: message(1), index: 2 });
        // 0.05..0.09 sound, 0.09..0.13 silence, then sound at 0.13 — not the
        // silent run priming the timeline and the first batch landing after it.
        expect(ctx.starts.map(t => +t.toFixed(4))).toEqual([0.05, 0.13]);
        await h.stop();
    });
});
