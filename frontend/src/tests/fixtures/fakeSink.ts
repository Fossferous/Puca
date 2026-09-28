/**
 * A setSinkId target that behaves the way Edge 154 (the WebView2 engine) was
 * MEASURED to behave on both <audio> elements and AudioContexts, in a silent
 * headless probe (no source connected, --mute-audio, --disable-audio-output):
 *
 *   - calls are processed strictly in order, and the last one wins;
 *   - `sinkId` reads the OLD sink until a call resolves;
 *   - an unknown device id rejects NotFoundError and leaves `sinkId` alone;
 *   - asking for the sink it is already on resolves at once (0 ms measured),
 *     judged when the call is PROCESSED, not when it is made;
 *   - '' is always accepted and means the platform default.
 *
 * Nothing is processed until `settle()`, so a test can hold a switch in flight
 * and interleave requests the way a settingsChanged/devicechange burst does.
 * A fake that resolved instantly could not see the ordering bugs this exists
 * to pin.
 */
export class FakeSink {
    sinkId = '';
    /** Every id ever requested, in call order. */
    readonly calls: string[] = [];
    private queue: Array<{ id: string; resolve: () => void; reject: (e: unknown) => void }> = [];
    /** The devices that exist right now; mutate it to unplug / replug. */
    readonly devices: Set<string>;

    constructor(devices: Set<string>) {
        this.devices = devices;
    }

    setSinkId(id: string): Promise<void> {
        this.calls.push(id);
        return new Promise((resolve, reject) => { this.queue.push({ id, resolve, reject }); });
    }

    /** True while a request is queued and unanswered. */
    get busy(): boolean { return this.queue.length > 0; }

    /**
     * Answer every queued request in order. Handlers run between requests, so
     * a fallback issued from a rejection lands BEHIND anything already queued —
     * exactly where the browser puts it.
     */
    async settle(): Promise<void> {
        for (let guard = 0; this.queue.length > 0 && guard < 100; guard++) {
            const op = this.queue.shift()!;
            if (op.id === this.sinkId || op.id === '' || this.devices.has(op.id)) {
                this.sinkId = op.id;
                op.resolve();
            } else {
                op.reject(new DOMException('Requested device not found', 'NotFoundError'));
            }
            await flushMicrotasks();
        }
    }
}

export async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Give every HTMLMediaElement a FakeSink (jsdom has no setSinkId at all).
 * Returns the per-element lookup and an uninstall for afterEach — the
 * prototype members must not leak into other tests.
 */
export function installElementSinks(devices: Set<string>): {
    sinkOf: (el: object) => FakeSink;
    uninstall: () => void;
} {
    const sinks = new WeakMap<object, FakeSink>();
    const sinkOf = (el: object) => {
        let s = sinks.get(el);
        if (!s) { s = new FakeSink(devices); sinks.set(el, s); }
        return s;
    };
    const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, 'setSinkId', {
        value(this: object, id: string) { return sinkOf(this).setSinkId(id); },
        configurable: true, writable: true,
    });
    Object.defineProperty(proto, 'sinkId', {
        get(this: object) { return sinkOf(this).sinkId; },
        configurable: true,
    });
    return {
        sinkOf,
        uninstall: () => { delete proto.setSinkId; delete proto.sinkId; },
    };
}

/**
 * navigator.mediaDevices in the shared setup is a plain object with no event
 * surface; give it one so a test can fire 'devicechange'.
 */
export function installDeviceChangeEvents(): { fire: () => void; uninstall: () => void } {
    const md = navigator.mediaDevices as unknown as Record<string, unknown>;
    const target = new EventTarget();
    md.addEventListener = target.addEventListener.bind(target);
    md.removeEventListener = target.removeEventListener.bind(target);
    return {
        fire: () => { target.dispatchEvent(new Event('devicechange')); },
        uninstall: () => { delete md.addEventListener; delete md.removeEventListener; },
    };
}

/** In-memory localStorage (the shared setup stubs it with no-op vi.fns). */
export function memoryLocalStorage(): Storage {
    let store: Record<string, string> = {};
    return {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { store = {}; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
    } as Storage;
}
