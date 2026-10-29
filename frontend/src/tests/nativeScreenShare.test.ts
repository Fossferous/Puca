// @vitest-environment jsdom
/**
 * Sharing the phone's screen from the Android app (api/nativeScreenShare.ts;
 * the native half is SovereignScreenSharePlugin.java + ScreenShareService.java,
 * its pure rules ScreenShareFramesTest.java).
 *
 * What a WebView-less test can pin: when Share is offered, how the plugin's
 * refusals read, what arrives on the port, how frames become pictures without
 * a backlog, and the track's life — stopped by the page (the phone told once,
 * no `ended`), ended by the phone (`ended`, the phone not told again), re-sized
 * live. The real thing (Android's consent, MediaProjection, a desktop viewer)
 * is proven on a headless emulator, not here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const h = vi.hoisted(() => {
    const listeners: Array<(e: { reason: string; shareId?: number }) => void> = [];
    const state = { platform: 'android', pluginPresent: true, hello: null as ((nonce: string) => void) | null };
    const plugin = {
        start: vi.fn(async (o: { width: number; height: number; fps: number; nonce: string }) => {
            state.hello?.(o.nonce);
            return { width: 576, height: 1280, fps: Math.min(30, o.fps), binary: true, shareId: 7 };
        }),
        resize: vi.fn(async (o: { width: number; height: number; fps: number }) => ({ width: 360, height: 800, fps: o.fps })),
        stop: vi.fn(async () => ({ stopped: true })),
        pageReady: vi.fn(async () => ({ endedShare: false, refusedStart: false })) as
            ((() => Promise<{ endedShare: boolean; refusedStart: boolean }>) & ReturnType<typeof vi.fn>) | undefined,
        status: vi.fn(async () => ({ available: true, reason: null as string | null, sdk: 36, sharing: false })),
        addListener: vi.fn(async (_e: string, cb: (e: { reason: string; shareId?: number }) => void) => {
            listeners.push(cb);
            return { remove: async () => { listeners.splice(listeners.indexOf(cb), 1); } };
        }),
    };
    return { listeners, state, plugin };
});
const { listeners, state, plugin } = h;

interface FakePort {
    onmessage: ((e: { data: unknown }) => void) | null;
    posted: unknown[];
    closed: boolean;
    postMessage(d: unknown): void;
    close(): void;
}
let port: FakePort;

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => h.state.platform,
        isPluginAvailable: (name: string) => h.state.pluginPresent && name === 'SovereignScreenShare',
    },
    registerPlugin: () => h.plugin,
}));

import {
    FramePump,
    REPEAT_MS,
    askedCapture,
    getNativeDisplayMedia,
    initNativeScreenShare,
    nativeScreenShareAvailable,
    readPortMessage,
    refusalAsDomException,
} from '../api/nativeScreenShare';

// ---- stand-ins for what jsdom lacks ---------------------------------------

const written: Array<{ bitmap: unknown; closed: boolean }> = [];

class FakeGenerator extends EventTarget {
    kind = 'video';
    readyState: 'live' | 'ended' = 'live';
    writable = new WritableStream<{ bitmap: unknown; closed: boolean }>({
        write: (f) => { written.push(f); },
    });
    stop() { this.readyState = 'ended'; }
    getSettings(): MediaTrackSettings { return { deviceId: 'gen' }; }
    async applyConstraints() { /* the generator's own: does nothing */ }
}
class FakeVideoFrame {
    closed = false;
    bitmap: unknown;
    constructor(bitmap: unknown) { this.bitmap = bitmap; }
    close() { this.closed = true; }
}
function newPort(): FakePort {
    return {
        onmessage: null,
        posted: [],
        closed: false,
        postMessage(d) { this.posted.push(d); },
        close() { this.closed = true; },
    };
}

/** What the plugin does once the capture runs: posts our end of the channel. */
function postHello(nonce: string, p: FakePort = port) {
    const e = new Event('message');
    Object.defineProperty(e, 'data', { value: JSON.stringify({ type: 'puca-screen-share', nonce, width: 576, height: 1280, binary: true }) });
    Object.defineProperty(e, 'ports', { value: [p] });
    window.dispatchEvent(e);
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const frame = (n: number) => new Uint8Array([0xff, 0xd8, n]).buffer;

beforeEach(() => {
    state.platform = 'android';
    state.pluginPresent = true;
    port = newPort();
    state.hello = (nonce) => postHello(nonce);
    written.length = 0;
    listeners.length = 0;
    plugin.start.mockClear();
    plugin.stop.mockClear();
    plugin.resize.mockClear();
    vi.stubGlobal('MediaStreamTrackGenerator', FakeGenerator);
    vi.stubGlobal('VideoFrame', FakeVideoFrame);
    vi.stubGlobal('createImageBitmap', async (blob: Blob) => ({ size: blob.size, type: blob.type, close: vi.fn() }));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('when Share is offered', () => {
    it('on the Android app with the plugin and a way to make a track', () => {
        expect(nativeScreenShareAvailable()).toBe(true);
    });
    it('not on the web, iOS, or an APK older than the plugin', () => {
        state.platform = 'web';
        expect(nativeScreenShareAvailable()).toBe(false);
        state.platform = 'ios';
        expect(nativeScreenShareAvailable()).toBe(false);
        state.platform = 'android';
        state.pluginPresent = false;
        expect(nativeScreenShareAvailable()).toBe(false);
    });
    it('not where the page can make no track from frames', () => {
        // jsdom's canvas has no captureStream, so without the generator: no.
        vi.stubGlobal('MediaStreamTrackGenerator', undefined);
        expect(nativeScreenShareAvailable()).toBe(false);
        // A canvas that captures is enough (the WebView without the generator).
        const proto = HTMLCanvasElement.prototype as unknown as { captureStream?: unknown };
        proto.captureStream = () => null;
        try {
            expect(nativeScreenShareAvailable()).toBe(true);
        } finally {
            delete proto.captureStream;
        }
    });
});

describe('askedCapture: the dialog constraints as the plugin reads them', () => {
    it('reads the max ceilings shareVideoConstraints writes', () => {
        expect(askedCapture({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } } }))
            .toEqual({ width: 1920, height: 1080, fps: 60 });
    });
    it('plain numbers and ideals too; defaults otherwise', () => {
        expect(askedCapture({ video: { width: 1280, height: { ideal: 720 } } })).toEqual({ width: 1280, height: 720, fps: 30 });
        expect(askedCapture({ video: true })).toEqual({ width: 1280, height: 720, fps: 30 });
        expect(askedCapture({})).toEqual({ width: 1280, height: 720, fps: 30 });
    });
});

describe("the plugin's refusals read like a browser picker's", () => {
    it.each([
        ['denied', 'NotAllowedError'],
        ['unsupported', 'NotSupportedError'],
        ['busy', 'InvalidStateError'],
        ['ended', 'AbortError'],
        ['failed', 'NotReadableError'],
        [undefined, 'NotReadableError'],
    ])('%s -> %s', (code, name) => {
        const e = refusalAsDomException({ code, message: 'why' });
        expect(e).toBeInstanceOf(DOMException);
        expect(e.name).toBe(name);
        expect(e.message).toBe('why');
    });
});

describe('readPortMessage', () => {
    it('binary is a frame', () => {
        const m = readPortMessage(new Uint8Array([1, 2, 3]).buffer);
        expect(m.kind).toBe('frame');
        expect(m.kind === 'frame' && Array.from(m.bytes)).toEqual([1, 2, 3]);
    });
    it('base64 text is a frame (a WebView that cannot post binary)', () => {
        const m = readPortMessage(btoa(String.fromCharCode(0xff, 0xd8, 0x07)));
        expect(m.kind === 'frame' && Array.from(m.bytes)).toEqual([0xff, 0xd8, 0x07]);
    });
    it('the end, with its reason', () => {
        expect(readPortMessage('{"type":"ended","reason":"Stopped from the notification"}'))
            .toEqual({ kind: 'ended', reason: 'Stopped from the notification' });
    });
    it('anything else is nothing', () => {
        expect(readPortMessage('{"type":"size"}').kind).toBe('other');
        expect(readPortMessage('{not json').kind).toBe('other');
        expect(readPortMessage('').kind).toBe('other');
        expect(readPortMessage(42).kind).toBe('other');
        expect(readPortMessage('!!not base64!!').kind).toBe('other');
    });
});

describe('FramePump: frames become pictures, newest first, never a backlog', () => {
    function rig() {
        let t = 0;
        const pending: Array<(p: { id: number; close: () => void; closed: boolean }) => void> = [];
        const shown: number[] = [];
        let acks = 0;
        const pics: Array<{ id: number; closed: boolean }> = [];
        const pump = new FramePump<{ id: number; close: () => void; closed: boolean }>(
            (bytes) => new Promise(res => pending.push(res)).then(p => { void bytes; return p as { id: number; close: () => void; closed: boolean }; }),
            (p) => shown.push(p.id),
            () => { acks++; },
            () => t,
        );
        const resolveNext = async (id: number) => {
            const pic = { id, closed: false, close() { this.closed = true; } };
            pics.push(pic);
            pending.shift()!(pic);
            await flush();
        };
        return { pump, shown, pics, acks: () => acks, resolveNext, setTime: (v: number) => { t = v; }, pending };
    }

    it('one frame: decoded, shown, acknowledged', async () => {
        const r = rig();
        r.pump.push(new Uint8Array([1]));
        expect(r.acks()).toBe(0);
        await r.resolveNext(1);
        expect(r.shown).toEqual([1]);
        expect(r.acks()).toBe(1);
    });

    it('a frame arriving mid-decode waits; a newer one replaces it and the replaced one is acknowledged at once', async () => {
        const r = rig();
        r.pump.push(new Uint8Array([1]));
        r.pump.push(new Uint8Array([2]));
        expect(r.acks()).toBe(0);
        r.pump.push(new Uint8Array([3]));
        expect(r.acks()).toBe(1); // 2 dropped, the phone may encode another
        expect(r.pump.shown.dropped).toBe(1);
        await r.resolveNext(1);
        expect(r.pending.length).toBe(1); // only 3 is decoded next
        await r.resolveNext(3);
        expect(r.shown).toEqual([1, 3]);
        expect(r.acks()).toBe(3); // every frame acknowledged exactly once
    });

    it('a failed decode is acknowledged and shows nothing', async () => {
        let acks = 0;
        const shown: unknown[] = [];
        const pump = new FramePump<{ close(): void }>(async () => { throw new Error('bad jpeg'); }, p => shown.push(p), () => { acks++; });
        pump.push(new Uint8Array([1]));
        await flush();
        expect(acks).toBe(1);
        expect(shown).toEqual([]);
        expect(pump.shown.failed).toBe(1);
    });

    it('the previous picture is released when a new one is shown', async () => {
        const r = rig();
        r.pump.push(new Uint8Array([1]));
        await r.resolveNext(1);
        r.pump.push(new Uint8Array([2]));
        await r.resolveNext(2);
        expect(r.pics[0].closed).toBe(true);
        expect(r.pics[1].closed).toBe(false); // kept: a still screen shows it again
    });

    it('a still screen shows its last picture again every REPEAT_MS, and only then', async () => {
        const r = rig();
        r.setTime(1000);
        r.pump.push(new Uint8Array([1]));
        await r.resolveNext(1);
        r.setTime(1000 + REPEAT_MS - 1);
        r.pump.tick();
        expect(r.shown).toEqual([1]);
        r.setTime(1000 + REPEAT_MS);
        r.pump.tick();
        expect(r.shown).toEqual([1, 1]);
        expect(r.pump.shown.repeats).toBe(1);
        expect(r.acks()).toBe(1); // a repeat is not a frame from the phone
    });

    it('nothing to repeat before the first picture; nothing at all once stopped', async () => {
        const r = rig();
        r.setTime(99_999);
        r.pump.tick();
        expect(r.shown).toEqual([]);
        r.pump.push(new Uint8Array([1]));
        await r.resolveNext(1);
        r.pump.stop();
        expect(r.pics[0].closed).toBe(true);
        r.setTime(999_999);
        r.pump.tick();
        r.pump.push(new Uint8Array([2]));
        expect(r.shown).toEqual([1]);
        expect(r.pending.length).toBe(0);
    });

    it('a picture decoded after stop is released, not shown', async () => {
        const r = rig();
        r.pump.push(new Uint8Array([1]));
        r.pump.stop();
        await r.resolveNext(1);
        expect(r.shown).toEqual([]);
        expect(r.pics[0].closed).toBe(true);
    });
});

describe('getNativeDisplayMedia: the share from start to end', () => {
    it("asks the phone for the dialog's box with a nonce, and answers with one video track", async () => {
        const stream = await getNativeDisplayMedia({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 } } });
        expect(plugin.start).toHaveBeenCalledTimes(1);
        const arg = plugin.start.mock.calls[0][0];
        expect(arg).toMatchObject({ width: 1920, height: 1080, fps: 60 });
        expect(arg.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(stream.getVideoTracks()).toHaveLength(1);
        expect(stream.getVideoTracks()[0]).toBeInstanceOf(FakeGenerator);
        stream.getVideoTracks()[0].stop();
    });

    it('a frame on the port reaches the track and is acknowledged', async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        port.onmessage!({ data: frame(1) });
        await flush();
        await new Promise(r => setTimeout(r, 0));
        expect(written).toHaveLength(1);
        expect(written[0]).toBeInstanceOf(FakeVideoFrame);
        expect(port.posted).toEqual(['ack']);
        stream.getVideoTracks()[0].stop();
    });

    it('stopping the track stops the phone once, closes the port, and fires no ended', async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        const ended = vi.fn();
        track.addEventListener('ended', ended);
        track.stop();
        track.stop();
        await flush();
        expect(plugin.stop).toHaveBeenCalledTimes(1);
        expect(track.readyState).toBe('ended');
        expect(port.closed).toBe(true);
        expect(ended).not.toHaveBeenCalled();
        // Frames after the end go nowhere.
        port.onmessage?.({ data: frame(2) });
        await flush();
        expect(written).toHaveLength(0);
    });

    it('the phone ending the share (notification, Android) ends the track with ended, without telling the phone again', async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        const ended = vi.fn();
        track.addEventListener('ended', ended);
        port.onmessage!({ data: JSON.stringify({ type: 'ended', reason: 'Stopped from the notification' }) });
        expect(ended).toHaveBeenCalledTimes(1);
        expect(track.readyState).toBe('ended');
        // The voice panel's stop flow then stops the track: nothing more happens.
        track.stop();
        await flush();
        expect(plugin.stop).not.toHaveBeenCalled();
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it("the plugin's shareEnded event ends it too (a port that died first says nothing)", async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        await flush();
        const ended = vi.fn();
        stream.getVideoTracks()[0].addEventListener('ended', ended);
        expect(listeners).toHaveLength(1);
        listeners[0]({ reason: 'Android ended the screen capture' });
        expect(ended).toHaveBeenCalledTimes(1);
        await flush();
        expect(listeners).toHaveLength(0); // its listener removed with the share
    });

    it('a no at the consent dialog is NotAllowedError, as a cancelled picker is, and its port listener goes with it', async () => {
        // Every 'message' listener the start adds must be gone once it is
        // refused: a listener left behind would take a later hello for a
        // start that no longer exists.
        const added: EventListenerOrEventListenerObject[] = [];
        const removed: EventListenerOrEventListenerObject[] = [];
        const add = vi.spyOn(window, 'addEventListener').mockImplementation(function (this: Window, type: string, l: EventListenerOrEventListenerObject | null) {
            if (type === 'message' && l) added.push(l);
        } as typeof window.addEventListener);
        const remove = vi.spyOn(window, 'removeEventListener').mockImplementation(function (this: Window, type: string, l: EventListenerOrEventListenerObject | null) {
            if (type === 'message' && l) removed.push(l);
        } as typeof window.removeEventListener);
        try {
            plugin.start.mockImplementationOnce(async () => { throw Object.assign(new Error('The screen share was not allowed'), { code: 'denied' }); });
            await expect(getNativeDisplayMedia({ video: true })).rejects.toMatchObject({ name: 'NotAllowedError' });
        } finally {
            add.mockRestore();
            remove.mockRestore();
        }
        expect(added).toHaveLength(1);
        expect(removed).toEqual(added);
        expect(plugin.stop).not.toHaveBeenCalled();
    });

    it("another share's end (an older one, replaced) leaves this share alone; its own end ends it", async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        await flush();
        const ended = vi.fn();
        stream.getVideoTracks()[0].addEventListener('ended', ended);
        listeners[0]({ reason: 'Replaced by a new share', shareId: 6 });
        expect(ended).not.toHaveBeenCalled();
        expect(stream.getVideoTracks()[0].readyState).toBe('live');
        listeners[0]({ reason: 'Stopped from the notification', shareId: 7 });
        expect(ended).toHaveBeenCalledTimes(1);
    });

    it('a port with the wrong nonce is never taken; the share gives up after 5 s and stops the phone', async () => {
        vi.useFakeTimers();
        state.hello = () => postHello('not-our-nonce');
        const p = getNativeDisplayMedia({ video: true });
        const outcome = p.then(() => 'resolved', (e: DOMException) => e.name);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await outcome).toBe('NotReadableError');
        expect(plugin.stop).toHaveBeenCalledTimes(1);
    });

    it('a live re-size asks the phone and the track reports what it now captures', async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        expect(track.getSettings()).toMatchObject({ width: 576, height: 1280, frameRate: 30, deviceId: 'gen' });
        await track.applyConstraints({ width: { max: 854 }, height: { max: 480 }, frameRate: { max: 15 } });
        expect(plugin.resize).toHaveBeenCalledWith({ width: 854, height: 480, fps: 15 });
        expect(track.getSettings()).toMatchObject({ width: 360, height: 800, frameRate: 15 });
        track.stop();
        await expect(track.applyConstraints({})).rejects.toMatchObject({ name: 'InvalidStateError' });
    });

    it('a refused re-size reads as a refused applyConstraints', async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        plugin.resize.mockImplementationOnce(async () => { throw Object.assign(new Error('Nothing is being shared'), { code: 'not-sharing' }); });
        await expect(stream.getVideoTracks()[0].applyConstraints({})).rejects.toBeInstanceOf(DOMException);
        stream.getVideoTracks()[0].stop();
    });
});

describe('initNativeScreenShare: at startup', () => {
    afterEach(async () => {
        // Back to a WebView that carries shares, for the tests after these.
        plugin.status.mockImplementation(async () => ({ available: true, reason: null, sdk: 36, sharing: false }));
        await initNativeScreenShare();
    });

    it("a WebView that cannot carry the frames hides Share", async () => {
        plugin.status.mockImplementation(async () => ({ available: false, reason: 'message channels', sdk: 36, sharing: false }));
        expect(nativeScreenShareAvailable()).toBe(true);
        await initNativeScreenShare();
        expect(nativeScreenShareAvailable()).toBe(false);
    });

    it('at startup the page tells the native side, which ends what an earlier page left (a share, or a start waiting on the dialog)', async () => {
        plugin.pageReady!.mockClear();
        plugin.status.mockImplementation(async () => ({ available: true, reason: null, sdk: 36, sharing: true }));
        await initNativeScreenShare();
        expect(plugin.pageReady).toHaveBeenCalledTimes(1);
        expect(plugin.stop).not.toHaveBeenCalled(); // pageReady did it
    });

    it('an APK without pageReady: a share an earlier page left running is stopped', async () => {
        const pageReady = plugin.pageReady;
        plugin.pageReady = undefined;
        try {
            plugin.status.mockImplementation(async () => ({ available: true, reason: null, sdk: 36, sharing: true }));
            await initNativeScreenShare();
            expect(plugin.stop).toHaveBeenCalledTimes(1);
        } finally {
            plugin.pageReady = pageReady;
        }
    });

    it("this page's own running share is left alone", async () => {
        const stream = await getNativeDisplayMedia({ video: true });
        plugin.stop.mockClear();
        plugin.pageReady!.mockClear();
        plugin.status.mockImplementation(async () => ({ available: true, reason: null, sdk: 36, sharing: true }));
        await initNativeScreenShare();
        expect(plugin.stop).not.toHaveBeenCalled();
        expect(plugin.pageReady).not.toHaveBeenCalled();
        stream.getVideoTracks()[0].stop();
    });

    it('nothing is asked off Android', async () => {
        state.platform = 'web';
        plugin.status.mockClear();
        await initNativeScreenShare();
        expect(plugin.status).not.toHaveBeenCalled();
        state.platform = 'android';
    });
});

// ---- the wiring, pinned in the source (as hostShareWiring.test.ts does) ----

const here = dirname(fileURLToPath(import.meta.url));
const source = (rel: string) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('the Share button and the sharing settings follow nativeScreenShareAvailable', () => {
    const vp = source('components/VoicePanel.tsx');
    const settings = source('components/SettingsModal.tsx');
    const panelOffers = (c: string) => c.includes('const nativeShare = nativeScreenShareAvailable();')
        && c.includes('const isMobile = !screenShareOffered() && !nativeShare;')
        && (c.match(/\{!isMobile && shareAvailable && \(/g) ?? []).length === 2;
    const settingsOffer = (c: string) => c.includes('{(screenShareOffered() || nativeScreenShareAvailable()) && (');

    it('holds in the source', () => {
        expect(panelOffers(vp)).toBe(true);
        expect(settingsOffer(settings)).toBe(true);
    });
    it.each([
        ['the phone gate back to the user agent alone', (c: string) => c.replace('!screenShareOffered() && !nativeShare', '!screenShareOffered()')],
        ['the arrow no longer behind the gate', (c: string) => c.replace('{!isMobile && shareAvailable && (', '{shareAvailable && (')],
    ])('the panel pin goes red when %s', (_l, mutate) => {
        expect(panelOffers(mutate(vp))).toBe(false);
    });
    it('the settings pin goes red when the sharing settings are web-only again', () => {
        expect(settingsOffer(settings.replace('(screenShareOffered() || nativeScreenShareAvailable())', 'screenShareOffered()'))).toBe(false);
    });
});
