/**
 * An in-memory stand-in for @capacitor/filesystem that records every BRIDGE
 * call the way Android receives it: each writeFile/appendFile is one
 * `postMessage` whose `data` string the native side parses whole, so the
 * length of that string is what has to stay bounded (the clip-download crash
 * was one 128 MB string). writeFile truncates, appendFile extends, and each
 * call's base64 is decoded on its own — as FilesystemPlugin does — so the
 * file contents here are exactly what a phone would hold.
 */
export interface BridgeCall {
    op: 'writeFile' | 'appendFile' | 'deleteFile';
    path: string;
    /** Length of the `data` string that crossed the bridge (0 for delete). */
    chars: number;
    directory?: string;
    encoding?: string;
}

type WriteOpts = { path: string; data: string; directory?: string; encoding?: string; recursive?: boolean };

export function fakeCapacitorFs() {
    const files = new Map<string, Buffer[]>();
    const calls: BridgeCall[] = [];
    /** Return an Error to make the Nth (1-based) write/append call reject. */
    let failWrite: ((n: number, op: BridgeCall['op']) => Error | null) | null = null;
    let writes = 0;

    const decode = (o: WriteOpts): Buffer => {
        if (o.encoding) return Buffer.from(o.data, 'utf8');
        // Real base64, one call at a time: a slice that is not a whole
        // number of quads would decode wrong on the device.
        if (o.data.length % 4 !== 0) throw new Error(`not standalone base64 (${o.data.length} chars)`);
        return Buffer.from(o.data, 'base64');
    };
    const put = (op: 'writeFile' | 'appendFile', o: WriteOpts) => {
        calls.push({ op, path: o.path, chars: o.data.length, directory: o.directory, encoding: o.encoding });
        writes++;
        const err = failWrite?.(writes, op);
        if (err) throw err;
        const bytes = decode(o);
        if (op === 'writeFile') files.set(o.path, [bytes]);
        else {
            const f = files.get(o.path);
            if (f) f.push(bytes); else files.set(o.path, [bytes]);
        }
    };

    const api = {
        writeFile: async (o: WriteOpts) => { put('writeFile', o); return { uri: `file:///${o.path}` }; },
        appendFile: async (o: WriteOpts) => { put('appendFile', o); },
        deleteFile: async (o: { path: string; directory?: string }) => {
            calls.push({ op: 'deleteFile', path: o.path, chars: 0, directory: o.directory });
            if (!files.delete(o.path)) throw new Error(`deleteFile: ${o.path} does not exist`);
        },
    };

    return {
        api,
        files,
        calls,
        /** The whole file as one buffer, or undefined. */
        read(path: string): Buffer | undefined {
            const f = files.get(path);
            return f ? Buffer.concat(f) : undefined;
        },
        failOn(fn: ((n: number, op: BridgeCall['op']) => Error | null) | null) { failWrite = fn; },
        reset() { files.clear(); calls.length = 0; writes = 0; failWrite = null; },
        /** Longest `data` string any single bridge call carried. */
        maxChars(): number { return calls.reduce((m, c) => Math.max(m, c.chars), 0); },
    };
}

/** Deterministic, non-repeating-ish bytes so a dropped, duplicated or
 *  reordered slice cannot compare equal by accident. */
export function patternBytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(n);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < n; i++) {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        out[i] = x & 0xff;
    }
    return out;
}
