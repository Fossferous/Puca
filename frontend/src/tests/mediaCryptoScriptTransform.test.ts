// @vitest-environment jsdom
/**
 * The two mesh frame-transform paths against each other.
 *
 * Chromium seals and opens frames on the page, through createEncodedStreams
 * (mediaCrypto.ts attachSenderTransform / attachReceiverTransform). Firefox
 * and Safari — the iPhone home-screen app included — do it in a worker,
 * through the standard RTCRtpScriptTransform (scriptTransformWorker.ts). A
 * call that mixes the two works only if both produce the same bytes and make
 * the same decisions, so everything here runs the REAL wiring of both paths
 * over real WHATWG streams and real WebCrypto, with stand-ins only for what
 * jsdom lacks (an RTCRtpSender to hand out the streams, a worker scope to fire
 * `rtctransform` on).
 *
 *  - Identical bytes: each known-answer vector (the cross-language contract
 *    in fixtures/media-aead-kat.json) is sealed by BOTH paths to the pinned
 *    ciphertext, IV stubbed as mediaCryptoKat.test.ts does.
 *  - Interop: what one path seals, the other opens, both ways.
 *  - State: the worker holds a COPY of each peer's state; a new session key,
 *    encryption switched on or off and "Require encryption" switched on or
 *    off mid-call each take effect on the next frame of a transform that is
 *    already running.
 *  - One path per engine: an engine with both APIs gets createEncodedStreams
 *    and never a `transform`; an engine with the standard one gets a
 *    `transform` built on the worker, after the worker has the state.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    attachReceiverTransform, attachSenderTransform, importMediaKey, mediaTransformApi,
    noteScriptTransformUnavailable, __resetScriptTransformAvailability, preferSealableVideoCodecs, firstVideoCodecByMid,
    sendSealableVideoCodec, newFrameCounts, type EncodedFrameLike, type FrameCounts, type MediaCryptoState,
} from '../api/rtc/mediaCrypto';
import { openIncoming, sealOutgoing } from '../api/rtc/frameCrypto';
import { serveScriptTransforms, type ScriptTransformScope, type ScriptTransformCommand, type ScriptTransformReport } from '../api/rtc/scriptTransformWorker';
import {
    PeerMediaCrypto, attachMediaReceiverTransform, attachMediaSenderTransform, onScriptTransformLost,
    __runFrameAudit, __setScriptTransformWorkerFactory, type TransformWorkerLike,
} from '../api/rtc/scriptTransform';

const HERE = dirname(fileURLToPath(import.meta.url));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const bytes = (f: EncodedFrameLike) => hex(new Uint8Array(f.data));

interface KatVector { name: string; frameType?: 'key' | 'delta'; keyHex: string; ivHex: string; plaintextHex: string; ciphertextHex: string }
let vectors: KatVector[] = [];
beforeAll(() => {
    vectors = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'media-aead-kat.json'), 'utf8')) as { vectors: KatVector[] }).vectors;
});

/** WebCrypto resolves on macrotasks: drain those. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Pin the IV, as mediaCryptoKat.test.ts does: the only randomness in a seal. */
async function withIv<T>(ivHex: string, fn: () => Promise<T>): Promise<T> {
    const iv = unhex(ivHex);
    const real = crypto.getRandomValues.bind(crypto);
    (crypto as unknown as { getRandomValues: (a: Uint8Array) => Uint8Array }).getRandomValues = (arr: Uint8Array) => {
        if (arr.length !== iv.length) return real(arr);
        arr.set(iv);
        return arr;
    };
    try { return await fn(); } finally {
        (crypto as unknown as { getRandomValues: typeof real }).getRandomValues = real;
    }
}

/** One transform's ends: frames put in come out (or not) into `out`. */
function lane() {
    const into = new TransformStream<EncodedFrameLike, EncodedFrameLike>();
    const outof = new TransformStream<EncodedFrameLike, EncodedFrameLike>();
    const out: EncodedFrameLike[] = [];
    void (async () => {
        const r = outof.readable.getReader();
        for (;;) {
            const { value, done } = await r.read();
            if (done) return;
            out.push(value);
        }
    })();
    const w = into.writable.getWriter();
    return {
        ends: { readable: into.readable, writable: outof.writable },
        out,
        put(frame: EncodedFrameLike) { void w.write(frame); },
        /** Wait until `n` frames have come out (a kept frame costs WebCrypto time). */
        async outputs(n: number): Promise<EncodedFrameLike[]> {
            const until = Date.now() + 3000;
            while (out.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
            return out;
        },
        /** Wait until a frame with these bytes has come out. Frames go through
         *  a transform one at a time, in order, so once a CONTROL put after the
         *  frame under test is out, that frame's fate is settled — a drop is
         *  then observed without guessing how long WebCrypto takes to refuse. */
        async through(controlHex: string): Promise<EncodedFrameLike[]> {
            const until = Date.now() + 3000;
            while (!out.some(f => bytes(f) === controlHex) && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
            expect(out.some(f => bytes(f) === controlHex), 'the control frame came through').toBe(true);
            return out.filter(f => bytes(f) !== controlHex);
        },
    };
}
type Lane = ReturnType<typeof lane>;

/** A frame sealed on the page under `key`, to use as a control on an open lane. */
async function sealedControl(key: CryptoKey, plainHex: string): Promise<EncodedFrameLike> {
    const l = onPage('seal', on(key));
    l.put(frame(plainHex));
    return (await l.outputs(1))[0];
}

/** The page path: a sender/receiver whose createEncodedStreams hands out the lane. */
function onPage(op: 'seal' | 'open', state: MediaCryptoState, counts?: FrameCounts): Lane {
    const l = lane();
    const target = { createEncodedStreams: () => l.ends };
    const ok = op === 'seal'
        ? attachSenderTransform(target as unknown as RTCRtpSender, state, counts)
        : attachReceiverTransform(target as unknown as RTCRtpReceiver, state, counts);
    expect(ok, 'the page transform attaches').toBe(true);
    return l;
}

let lanes = 0;
/** A worker scope serving script transforms, driven the way the engine and the page drive it. */
function worker() {
    const reports: ScriptTransformReport[] = [];
    const scope: ScriptTransformScope = { onmessage: null, onmessageerror: null, onrtctransform: null, postMessage: (m) => { reports.push(m); } };
    serveScriptTransforms(scope);
    return {
        reports,
        scope,
        send(msg: ScriptTransformCommand) { scope.onmessage!({ data: msg }); },
        state(slot: string, s: MediaCryptoState) { scope.onmessage!({ data: { type: 'state', slot, key: s.key, enabled: s.enabled, requireE2ee: s.requireE2ee, hold: !!s.hold } }); },
        /** The counts it last posted in answer to a `report`. */
        counts(): Array<{ id: string } & FrameCounts> {
            const last = [...reports].reverse().find((r) => r.type === 'counts' && r.seq !== null);
            return last?.type === 'counts' ? last.transforms : [];
        },
        transform(op: 'seal' | 'open', slot: string, options: unknown = { op, slot, id: `t-${op}-${slot}-${++lanes}` }): Lane {
            const l = lane();
            scope.onrtctransform!({ transformer: { options, readable: l.ends.readable, writable: l.ends.writable } });
            return l;
        },
    };
}

const frame = (h: string, type?: 'key' | 'delta'): EncodedFrameLike => ({ data: unhex(h).buffer as ArrayBuffer, type });
const on = (key: CryptoKey, requireE2ee = false): MediaCryptoState => ({ key, enabled: true, requireE2ee });
const KEY1 = '00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f';
const KEY2 = 'ffeeddccbbaa99887766554433221100f0edecdbcab9a897867564534231201f';

describe('identical bytes: both paths seal every known-answer vector to the pinned ciphertext', () => {
    it('the fixture is there to compare against', () => {
        expect(vectors.length).toBeGreaterThanOrEqual(6);
    });

    it('page and worker each produce the fixture bytes for every vector', async () => {
        for (const v of vectors) {
            const key = await importMediaKey(unhex(v.keyHex));
            const page = await withIv(v.ivHex, async () => {
                const l = onPage('seal', on(key));
                l.put(frame(v.plaintextHex, v.frameType));
                return (await l.outputs(1))[0];
            });
            const w = worker();
            w.state('peer-1', on(key));
            const inWorker = await withIv(v.ivHex, async () => {
                const l = w.transform('seal', 'peer-1');
                l.put(frame(v.plaintextHex, v.frameType));
                return (await l.outputs(1))[0];
            });
            expect(page && bytes(page), `${v.name}: page path`).toBe(v.ciphertextHex);
            expect(inWorker && bytes(inWorker), `${v.name}: worker path`).toBe(v.ciphertextHex);
        }
    });

    it('page and worker each open every vector back to its plaintext', async () => {
        for (const v of vectors) {
            const key = await importMediaKey(unhex(v.keyHex));
            const page = onPage('open', on(key, true));
            page.put(frame(v.ciphertextHex, v.frameType));
            const w = worker();
            w.state('peer-1', on(key, true));
            const l = w.transform('open', 'peer-1');
            l.put(frame(v.ciphertextHex, v.frameType));
            expect(bytes((await page.outputs(1))[0]), `${v.name}: page path`).toBe(v.plaintextHex);
            expect(bytes((await l.outputs(1))[0]), `${v.name}: worker path`).toBe(v.plaintextHex);
        }
    });
});

describe('interop: what one path seals the other opens (random IVs, every frame kind)', () => {
    const samples: Array<[string, 'key' | 'delta' | undefined]> = [
        ['5a' + 'ab'.repeat(90), undefined],               // Opus-sized audio
        ['9d012a' + '11'.repeat(7) + 'cd'.repeat(400), 'key'],
        ['b10000' + '42'.repeat(300), 'delta'],
        ['7f', undefined],                                 // header only
        ['00010203', 'key'],                               // shorter than its header
    ];

    it('worker-sealed frames open on the page, and page-sealed frames open in the worker', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', on(key, true));
        const sealW = w.transform('seal', 'peer-1');
        const openW = w.transform('open', 'peer-1');
        const sealP = onPage('seal', on(key, true));
        const openP = onPage('open', on(key, true));

        for (const [h, t] of samples) sealW.put(frame(h, t));
        const fromWorker = await sealW.outputs(samples.length);
        for (const f of fromWorker) openP.put({ data: f.data, type: f.type });
        for (const [h, t] of samples) sealP.put(frame(h, t));
        const fromPage = await sealP.outputs(samples.length);
        for (const f of fromPage) openW.put({ data: f.data, type: f.type });

        expect((await openP.outputs(samples.length)).map(bytes), 'the page opens the worker\'s frames').toEqual(samples.map(([h]) => h));
        expect((await openW.outputs(samples.length)).map(bytes), 'the worker opens the page\'s frames').toEqual(samples.map(([h]) => h));
        // Sealed, not passed through: each one carries the trailer.
        for (const f of [...fromWorker, ...fromPage]) expect(bytes(f).endsWith('5356524e')).toBe(true);
    });
});

describe('what each frame came to (both paths count the same outcomes)', () => {
    it('sealOutgoing: sealed with a key, passed on without one, dropped when required or held, and a crypto failure is no plaintext under enforcement', async () => {
        const key = await importMediaKey(unhex(KEY1));
        expect(await sealOutgoing(frame('5a01'), on(key))).toBe('sealed');
        expect(await sealOutgoing(frame('5a01'), { key: null, enabled: false, requireE2ee: false })).toBe('clear');
        expect(await sealOutgoing(frame('5a01'), { key: null, enabled: false, requireE2ee: true })).toBe('dropped');
        expect(await sealOutgoing(frame('5a01'), { ...on(key), hold: true }), 'a held peer was sent a sealed frame').toBe('dropped');
        expect(await sealOutgoing(frame('5a01'), { key: null, enabled: false, requireE2ee: false, hold: true }), 'a held peer was sent plaintext').toBe('dropped');
        // A key that cannot encrypt: WebCrypto throws.
        const signing = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) as CryptoKey;
        const f = frame('5a01');
        expect(await sealOutgoing(f, on(signing))).toBe('clear');
        expect(bytes(f), 'a frame that failed to seal was changed').toBe('5a01');
        expect(await sealOutgoing(frame('5a01'), on(signing, true))).toBe('dropped');
    });

    it('openIncoming: opened under the key; plaintext passed on, or dropped when required; a wrong key or a hold dropped', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const other = await importMediaKey(unhex(KEY2));
        const sealed = frame('5a' + '33'.repeat(20));
        expect(await sealOutgoing(sealed, on(key))).toBe('sealed');
        const copy = () => ({ data: sealed.data.slice(0) });
        expect(await openIncoming(copy(), on(key))).toBe('opened');
        expect(await openIncoming(copy(), on(other)), 'a frame under another key').toBe('dropped');
        expect(await openIncoming(frame('5a01'), on(key))).toBe('clear');
        expect(await openIncoming(frame('5a01'), on(key, true))).toBe('dropped');
        expect(await openIncoming(copy(), { ...on(key), hold: true }), 'a frame played from a held peer').toBe('dropped');
    });

    it('a hold that lands while a frame is on its way through still stops it (sealing failed; an unmarked frame arriving)', async () => {
        // `hold` reads false when the frame starts through and true after:
        // the substitution was found mid-frame, as the page path can see it.
        const lateHold = (base: MediaCryptoState): MediaCryptoState => {
            let reads = 0;
            return { ...base, get hold() { return reads++ > 0; } };
        };
        const signing = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) as CryptoKey;
        expect(await sealOutgoing(frame('5a01'), lateHold(on(signing))), 'a frame that failed to seal went out in the clear after the hold').toBe('dropped');
        const key = await importMediaKey(unhex(KEY1));
        expect(await openIncoming(frame('5a01'), lateHold(on(key))), 'an unmarked frame played after the hold').toBe('dropped');
        // CONTROL: the same frames with no hold at all pass as transport-only.
        expect(await sealOutgoing(frame('5a01'), on(signing))).toBe('clear');
        expect(await openIncoming(frame('5a01'), on(key))).toBe('clear');
    });

    it('the page path counts them as it goes', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const counts = newFrameCounts();
        const state: MediaCryptoState = { key: null, enabled: false, requireE2ee: false };
        const l = onPage('seal', state, counts);
        l.put(frame('5a01'));
        await l.outputs(1);
        state.key = key;
        state.enabled = true;
        l.put(frame('5a02'));
        await l.outputs(2);
        state.enabled = false;
        state.requireE2ee = true;
        l.put(frame('5a03'));
        await settle();
        expect(counts).toEqual({ seen: 3, done: 1, clear: 1, dropped: 1 });
    });
});

describe('the worker\'s copy of a peer\'s state follows the page\'s, mid-call', () => {
    it('a NEW session key takes effect on the next frame of a running transform', async () => {
        const k1 = await importMediaKey(unhex(KEY1));
        const k2 = await importMediaKey(unhex(KEY2));
        const w = worker();
        w.state('peer-1', on(k1));
        const seal = w.transform('seal', 'peer-1');
        seal.put(frame('5a' + 'aa'.repeat(40)));
        await seal.outputs(1);
        w.state('peer-1', on(k2)); // the page re-derived the key
        seal.put(frame('5a' + 'bb'.repeat(40)));
        const [first, second] = await seal.outputs(2);

        const CONTROL = '5a' + 'ee'.repeat(12);
        const opens = async (f: EncodedFrameLike, key: CryptoKey) => {
            const control = await sealedControl(key, CONTROL);
            const l = onPage('open', on(key, true));
            l.put({ data: f.data.slice(0) });
            l.put({ data: control.data });
            return (await l.through(CONTROL)).length === 1;
        };
        expect(await opens(first, k1), 'frame 1 is under key 1').toBe(true);
        expect(await opens(first, k2), 'frame 1 is NOT under key 2').toBe(false);
        expect(await opens(second, k2), 'frame 2 is under key 2: the change reached the worker').toBe(true);
        expect(await opens(second, k1), 'frame 2 is NOT under key 1').toBe(false);
    });

    it('a running open transform drops frames under the OLD key once the key changed', async () => {
        const k1 = await importMediaKey(unhex(KEY1));
        const k2 = await importMediaKey(unhex(KEY2));
        const sealedUnder1 = onPage('seal', on(k1));
        sealedUnder1.put(frame('5a' + 'cc'.repeat(30)));
        sealedUnder1.put(frame('5a' + 'dd'.repeat(30)));
        const [a, b] = await sealedUnder1.outputs(2);

        const w = worker();
        w.state('peer-1', on(k1, true));
        const open = w.transform('open', 'peer-1');
        open.put({ data: a.data });
        expect((await open.outputs(1)).length, 'precondition: the right key opens it').toBe(1);
        w.state('peer-1', on(k2, true));
        const CONTROL = '5a' + 'ef'.repeat(12);
        const control = await sealedControl(k2, CONTROL);
        open.put({ data: b.data });
        open.put({ data: control.data });
        expect((await open.through(CONTROL)).length, 'a frame under the old key was rendered after the key changed').toBe(1);
    });

    it('encryption switched OFF: plaintext passes when not required, nothing leaves when required', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', on(key));
        const seal = w.transform('seal', 'peer-1');
        seal.put(frame('5a01020304'));
        await seal.outputs(1);
        expect(bytes(seal.out[0]).endsWith('5356524e'), 'precondition: sealed while on').toBe(true);

        w.state('peer-1', { key: null, enabled: false, requireE2ee: false });
        seal.put(frame('5a05060708'));
        await seal.outputs(2);
        expect(bytes(seal.out[1]), 'transport-only, as the page path would').toBe('5a05060708');

        w.state('peer-1', { key: null, enabled: false, requireE2ee: true });
        seal.put(frame('5a090a0b0c'));
        await settle();
        expect(seal.out, 'plaintext left the worker while encryption was required').toHaveLength(2);
    });

    it('"Require encryption" switched ON mid-call drops plaintext arriving on a running open transform', async () => {
        const w = worker();
        w.state('peer-1', { key: null, enabled: false, requireE2ee: false });
        const open = w.transform('open', 'peer-1');
        open.put(frame('5a11223344'));
        await open.outputs(1);
        expect(open.out, 'precondition: plaintext plays while not required').toHaveLength(1);

        w.state('peer-1', { key: null, enabled: false, requireE2ee: true });
        open.put(frame('5a55667788'));
        await settle();
        expect(open.out, 'plaintext was rendered after enforcement went on').toHaveLength(1);
    });

    it('a slot the worker has no state for (not arrived yet, or forgotten) drops everything', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', on(key));
        const unknown = w.transform('seal', 'peer-9');
        unknown.put(frame('5a00'));
        const known = w.transform('seal', 'peer-1');
        known.put(frame('5a00'));
        await known.outputs(1);
        expect(known.out, 'control: the same frame on a known slot is sealed').toHaveLength(1);
        await settle();
        expect(unknown.out, 'a frame with no state behind it was sent').toHaveLength(0);

        w.send({ type: 'forget', slot: 'peer-1' });
        known.put(frame('5a01'));
        await settle();
        expect(known.out, 'a forgotten peer\'s transform kept sending').toHaveLength(1);
    });

    it('a transform with options that are not ours passes nothing', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', on(key));
        const odd = w.transform('seal', 'peer-1', { op: 'sideways', slot: 'peer-1', id: 't-odd' });
        odd.put(frame('5a00'));
        const unnamed = w.transform('seal', 'peer-1', { op: 'seal', slot: 'peer-1' });
        unnamed.put(frame('5a00'));
        await settle();
        expect(odd.out).toHaveLength(0);
        expect(unnamed.out, 'a transform the page cannot count was used').toHaveLength(0);
    });

    it('a HOLD stops everything both ways, sealed or not, required or not', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const control = onPage('seal', on(key));
        control.put(frame('5a' + '01'.repeat(20)));
        const sealedFrame = (await control.outputs(1))[0];
        const w = worker();
        w.state('peer-1', { key, enabled: true, requireE2ee: false, hold: true });
        const seal = w.transform('seal', 'peer-1');
        const open = w.transform('open', 'peer-1');
        seal.put(frame('5a' + '02'.repeat(20)));
        open.put({ data: sealedFrame.data });
        open.put(frame('5a03'));
        await settle();
        expect(seal.out, 'a frame went out over a held connection').toHaveLength(0);
        expect(open.out, 'a frame played from a held connection').toHaveLength(0);
        w.state('peer-1', on(key));
        seal.put(frame('5a' + '04'.repeat(20)));
        expect(await seal.outputs(1), 'control: the same transform seals once the hold is off').toHaveLength(1);
    });

    it('counts every frame by what became of it, and reports them when asked, by transform', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', on(key, true));
        const seal = w.transform('seal', 'peer-1', { op: 'seal', slot: 'peer-1', id: 'S' });
        const open = w.transform('open', 'peer-1', { op: 'open', slot: 'peer-1', id: 'O' });
        seal.put(frame('5a' + 'aa'.repeat(20)));
        seal.put(frame('5a' + 'bb'.repeat(20)));
        const [a] = await seal.outputs(2);
        const CONTROL = '5a' + 'cc'.repeat(12);
        const control = await sealedControl(key, CONTROL);
        open.put({ data: a.data });
        open.put(frame('5a0102')); // plaintext, under enforcement
        open.put({ data: control.data });
        await open.through(CONTROL);
        w.send({ type: 'report', seq: 7 });
        expect(w.reports.at(-1)).toEqual({
            type: 'counts', seq: 7, transforms: [
                { id: 'S', seen: 2, done: 2, clear: 0, dropped: 0 },
                { id: 'O', seen: 3, done: 2, clear: 0, dropped: 1 },
            ],
        });
        w.send({ type: 'forget', slot: 'peer-1' });
        w.send({ type: 'report', seq: 8 });
        expect(w.counts(), 'a forgotten peer\'s transforms were still reported').toEqual([]);
    });

    it('says at once, unasked, when a transform first seals or opens a frame (and only then)', async () => {
        const key = await importMediaKey(unhex(KEY1));
        const w = worker();
        w.state('peer-1', { key: null, enabled: false, requireE2ee: true });
        const seal = w.transform('seal', 'peer-1', { op: 'seal', slot: 'peer-1', id: 'S' });
        seal.put(frame('5a00'));
        await settle();
        expect(w.reports.filter((r) => r.type === 'counts'), 'a dropped frame was reported as the first sealed one').toEqual([]);
        w.state('peer-1', on(key, true));
        seal.put(frame('5a01'));
        seal.put(frame('5a02'));
        await seal.outputs(2);
        expect(w.reports.filter((r) => r.type === 'counts')).toEqual([
            { type: 'counts', seq: null, transforms: [{ id: 'S', seen: 2, done: 1, clear: 0, dropped: 1 }] },
        ]);
    });

    it('says it is running, and reports a message it could not read', () => {
        const w = worker();
        expect(w.reports, 'the page waits for this before trusting the worker').toEqual([{ type: 'ready' }]);
        w.scope.onmessageerror!({});
        expect(w.reports).toContainEqual({ type: 'unreadable' });
    });
});

/** A stand-in for the worker as the page sees it. */
class FakeWorker implements TransformWorkerLike {
    posted: ScriptTransformCommand[] = [];
    private fns: Record<string, Array<(ev: never) => void>> = { message: [], error: [] };
    terminated = false;
    throwOnPost = false;
    postMessage(m: ScriptTransformCommand) {
        if (this.throwOnPost) throw new DOMException('could not be cloned', 'DataCloneError');
        this.posted.push(m);
    }
    addEventListener(type: 'message' | 'error', fn: (ev: never) => void) { this.fns[type].push(fn); }
    terminate() { this.terminated = true; }
    emit(type: 'message' | 'error', ev: unknown) { for (const fn of this.fns[type]) fn(ev as never); }
}

describe('PeerMediaCrypto: every write reaches the worker', () => {
    beforeEach(() => __setScriptTransformWorkerFactory(null));
    afterEach(() => {
        vi.unstubAllGlobals();
        __setScriptTransformWorkerFactory(null);
    });

    it('posts nothing until bound, then the whole state, then every change in order', async () => {
        const w = new FakeWorker();
        const s = new PeerMediaCrypto(true);
        s.enabled = false;
        expect(w.posted).toEqual([]);
        s.bindTo(w);
        s.bindTo(w); // the second transform on the same peer
        const key = await importMediaKey(unhex(KEY1));
        s.key = key;
        s.enabled = true;
        s.requireE2ee = false;
        s.hold = true;
        expect(w.posted).toEqual([
            { type: 'state', slot: s.slot, key: null, enabled: false, requireE2ee: true, hold: false },
            { type: 'state', slot: s.slot, key, enabled: false, requireE2ee: true, hold: false },
            { type: 'state', slot: s.slot, key, enabled: true, requireE2ee: true, hold: false },
            { type: 'state', slot: s.slot, key, enabled: true, requireE2ee: false, hold: false },
            { type: 'state', slot: s.slot, key, enabled: true, requireE2ee: false, hold: true },
        ]);
        expect(s.key).toBe(key);
        expect(s.enabled).toBe(true);
        expect(s.requireE2ee).toBe(false);
        expect(s.hold).toBe(true);
    });

    it('dispose makes the worker forget the peer, and nothing is sent after', () => {
        const w = new FakeWorker();
        const s = new PeerMediaCrypto(false);
        s.bindTo(w);
        s.dispose();
        s.enabled = true;
        expect(w.posted.map(m => m.type)).toEqual(['state', 'forget']);
    });

    it('a state the worker cannot be sent takes the path down (it would keep a stale copy)', async () => {
        stubScriptEngine();
        const w = new FakeWorker();
        const lost = vi.fn();
        const off = onScriptTransformLost(lost);
        try {
            const s = new PeerMediaCrypto(true);
            s.bindTo(w);
            expect(mediaTransformApi()).toBe('script-transform');
            w.throwOnPost = true;
            s.key = await importMediaKey(unhex(KEY1));
            expect(mediaTransformApi(), 'still trusted after a copy failed to reach the worker').toBeNull();
            await settle();
            expect(lost).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });

    it('slots are never reused', () => {
        expect(new PeerMediaCrypto(false).slot).not.toBe(new PeerMediaCrypto(false).slot);
    });
});

class FakeScriptTransform {
    worker: unknown;
    options: unknown;
    /** What the worker had been sent when this transform was constructed. */
    sentBefore: ScriptTransformCommand[];
    static built: FakeScriptTransform[] = [];
    static failNext = false;
    constructor(worker: unknown, options: unknown) {
        if (FakeScriptTransform.failNext) { FakeScriptTransform.failNext = false; throw new Error('no'); }
        this.worker = worker;
        this.options = options;
        this.sentBefore = [...((worker as FakeWorker).posted ?? [])];
        FakeScriptTransform.built.push(this);
    }
}

/** An engine with only the standard API (Firefox, Safari). `transform` is an
 *  accessor on the real prototypes, which is where detection looks. */
function stubScriptEngine() {
    class Sender {}
    class Receiver {}
    for (const C of [Sender, Receiver]) (C.prototype as unknown as Record<string, unknown>).transform = null;
    vi.stubGlobal('RTCRtpSender', Sender);
    vi.stubGlobal('RTCRtpReceiver', Receiver);
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    vi.stubGlobal('Worker', class {});
    return { Sender, Receiver };
}

describe('one path per engine', () => {
    let fake: FakeWorker;
    let made = 0;
    beforeEach(() => {
        fake = new FakeWorker();
        made = 0;
        __setScriptTransformWorkerFactory(() => { made++; return fake; });
        FakeScriptTransform.built = [];
        FakeScriptTransform.failNext = false;
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        __setScriptTransformWorkerFactory(null);
    });

    it('detection: createEncodedStreams wins where both exist; the standard path needs every part', () => {
        expect(mediaTransformApi(), 'jsdom: neither').toBeNull();
        const { Sender, Receiver } = stubScriptEngine();
        expect(mediaTransformApi()).toBe('script-transform');
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        expect(mediaTransformApi(), 'Chromium has both: it keeps its own').toBe('encoded-streams');
        delete (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams;
        vi.stubGlobal('Worker', undefined);
        expect(mediaTransformApi(), 'no workers, no transforms').toBeNull();
        vi.stubGlobal('Worker', class {});
        vi.stubGlobal('RTCRtpReceiver', class {});
        expect(mediaTransformApi(), 'a sender-only transform would seal one direction').toBeNull();
        vi.stubGlobal('RTCRtpReceiver', Receiver);
        vi.stubGlobal('RTCRtpScriptTransform', undefined);
        expect(mediaTransformApi()).toBeNull();
    });

    it('detection: once the worker is known not to work, the standard path is gone (Chromium\'s is not)', () => {
        const { Sender } = stubScriptEngine();
        noteScriptTransformUnavailable();
        expect(mediaTransformApi()).toBeNull();
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        expect(mediaTransformApi()).toBe('encoded-streams');
        __resetScriptTransformAvailability();
    });

    it('an engine with BOTH APIs pipes through createEncodedStreams and never sets a transform', () => {
        const { Sender } = stubScriptEngine();
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        const l = lane();
        const sender = { transform: null as unknown, createEncodedStreams: vi.fn(() => l.ends) };
        const receiver = { transform: null as unknown, createEncodedStreams: vi.fn(() => lane().ends) };
        const state = new PeerMediaCrypto(true);
        expect(attachMediaSenderTransform(sender as unknown as RTCRtpSender, state)).toBe(true);
        expect(attachMediaReceiverTransform(receiver as unknown as RTCRtpReceiver, state)).toBe(true);
        expect(sender.createEncodedStreams).toHaveBeenCalledTimes(1);
        expect(receiver.createEncodedStreams).toHaveBeenCalledTimes(1);
        expect(sender.transform, 'a sender was given BOTH paths').toBeNull();
        expect(receiver.transform, 'a receiver was given BOTH paths').toBeNull();
        expect(made, 'no worker on the createEncodedStreams path').toBe(0);
    });

    it('an engine with the standard API gets a worker transform, after the worker has the state', () => {
        stubScriptEngine();
        const sender = { transform: null as unknown };
        const receiver = { transform: null as unknown };
        const state = new PeerMediaCrypto(true);
        expect(attachMediaSenderTransform(sender as unknown as RTCRtpSender, state)).toBe(true);
        expect(FakeScriptTransform.built[0]?.sentBefore, 'the copy is queued before the transform exists').toEqual([
            { type: 'state', slot: state.slot, key: null, enabled: false, requireE2ee: true, hold: false },
        ]);
        expect(attachMediaReceiverTransform(receiver as unknown as RTCRtpReceiver, state)).toBe(true);
        expect(sender.transform).toBe(FakeScriptTransform.built[0]);
        expect(receiver.transform).toBe(FakeScriptTransform.built[1]);
        expect(FakeScriptTransform.built.map(t => t.options)).toEqual([
            { op: 'seal', slot: state.slot, id: expect.any(String) }, { op: 'open', slot: state.slot, id: expect.any(String) },
        ]);
        const ids = FakeScriptTransform.built.map(t => (t.options as { id: string }).id);
        expect(new Set(ids).size, 'two transforms under one name: their counts would mix').toBe(2);
        expect(state.transforms.map(r => [r.id, r.op, r.path])).toEqual([[ids[0], 'seal', 'script-transform'], [ids[1], 'open', 'script-transform']]);
        expect(FakeScriptTransform.built.every(t => t.worker === fake), 'one worker serves every transform').toBe(true);
        expect(made).toBe(1);
        expect(fake.posted, 'binding the same state twice sends it once').toHaveLength(1);
    });

    it('neither API: nothing is attached', () => {
        vi.stubGlobal('RTCRtpSender', class {});
        const sender = { transform: null as unknown };
        expect(attachMediaSenderTransform(sender as unknown as RTCRtpSender, new PeerMediaCrypto(true))).toBe(false);
        expect(sender.transform).toBeNull();
        expect(made).toBe(0);
    });

    it('a worker that never ran (error before its first message) takes the path down', async () => {
        stubScriptEngine();
        const lost = vi.fn();
        const off = onScriptTransformLost(lost);
        try {
            attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true));
            fake.emit('error', new Event('error'));
            expect(mediaTransformApi()).toBeNull();
            expect(fake.terminated).toBe(true);
            await settle();
            expect(lost).toHaveBeenCalledTimes(1);
            expect(attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true)),
                'attached to a path already known dead').toBe(false);
        } finally {
            off();
        }
    });

    it('an error AFTER the worker said it is running takes the path down too (its transforms may be dead)', async () => {
        stubScriptEngine();
        const lost = vi.fn();
        const off = onScriptTransformLost(lost);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true));
            fake.emit('message', { data: { type: 'ready' } });
            await settle();
            expect(lost, 'control: ready alone is no loss').not.toHaveBeenCalled();
            expect(mediaTransformApi()).toBe('script-transform');
            fake.emit('error', new Event('error'));
            await settle();
            expect(mediaTransformApi(), 'a failed worker was still trusted').toBeNull();
            expect(fake.terminated).toBe(true);
            expect(lost).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls.some((c) => String(c[0]).includes('it failed'))).toBe(true);
        } finally {
            off();
            warn.mockRestore();
        }
    });

    it('a worker that could not read a state, a transform that would not construct, a worker that would not start: each takes the path down', async () => {
        stubScriptEngine();
        attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true));
        fake.emit('message', { data: { type: 'ready' } });
        fake.emit('message', { data: { type: 'unreadable' } });
        expect(mediaTransformApi(), 'unreadable').toBeNull();

        __setScriptTransformWorkerFactory(() => fake);
        FakeScriptTransform.failNext = true;
        expect(attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true))).toBe(false);
        expect(mediaTransformApi(), 'constructor threw').toBeNull();

        __setScriptTransformWorkerFactory(() => { throw new DOMException('blocked', 'SecurityError'); });
        expect(attachMediaSenderTransform({ transform: null } as unknown as RTCRtpSender, new PeerMediaCrypto(true))).toBe(false);
        expect(mediaTransformApi(), 'worker constructor threw').toBeNull();
    });
});

/** A worker that answers every `report` with the counts the test sets, as
 *  the real one does (synchronously: the page is already waiting). */
class CountingWorker extends FakeWorker {
    counts = new Map<string, FrameCounts>();
    answering = true;
    override postMessage(m: ScriptTransformCommand) {
        super.postMessage(m);
        if (m.type === 'report' && this.answering) {
            this.emit('message', { data: { type: 'counts', seq: m.seq, transforms: [...this.counts].map(([id, c]) => ({ id, ...c })) } });
        }
    }
}

/** A sender or receiver whose connection counters the test moves: audio
 *  packets, or video frames (encoded for a sender, received for a receiver). */
function wired(op: 'seal' | 'open', kind: 'audio' | 'video' = 'audio') {
    const t = {
        transform: null as unknown,
        media: 0,
        getStats: async () => new Map([['rtp', op === 'seal'
            ? { type: 'outbound-rtp', kind, ...(kind === 'video' ? { framesEncoded: t.media } : { packetsSent: t.media }) }
            : { type: 'inbound-rtp', kind, ...(kind === 'video' ? { framesReceived: t.media } : { packetsReceived: t.media }) }]]),
    };
    return t;
}

describe('the audit: on the worker path "encrypted" is shown, not assumed', () => {
    let w: CountingWorker;
    let lost: ReturnType<typeof vi.fn<() => void>>;
    let off: () => void;
    let key: CryptoKey;
    beforeAll(async () => { key = await importMediaKey(unhex(KEY1)); });
    beforeEach(() => {
        w = new CountingWorker();
        __setScriptTransformWorkerFactory(() => w);
        stubScriptEngine();
        FakeScriptTransform.built = [];
        FakeScriptTransform.failNext = false;
        lost = vi.fn();
        off = onScriptTransformLost(lost);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        off();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        __setScriptTransformWorkerFactory(null);
    });

    /** One peer with a sealed sender and an opened receiver, counted. */
    function peer(required = true, kinds: { send?: 'audio' | 'video'; receive?: 'audio' | 'video' } = {}) {
        const state = new PeerMediaCrypto(required);
        const sender = wired('seal', kinds.send);
        const receiver = wired('open', kinds.receive);
        expect(attachMediaSenderTransform(sender as unknown as RTCRtpSender, state)).toBe(true);
        expect(attachMediaReceiverTransform(receiver as unknown as RTCRtpReceiver, state)).toBe(true);
        const [S, O] = FakeScriptTransform.built.slice(-2).map(t => (t.options as { id: string }).id);
        const c = { S: newFrameCounts(), O: newFrameCounts() };
        w.counts.set(S, c.S);
        w.counts.set(O, c.O);
        return { state, sender, receiver, c, S, O };
    }
    type Peer = ReturnType<typeof peer>;
    /** A window's frames: through each transform, done (sealed/opened) or not, and on the wire. */
    function frames(p: Peer, n: number, how: { seal?: 'done' | 'dropped' | 'clear' | 'bypass'; open?: 'done' | 'dropped' | 'clear' | 'bypass' } = {}) {
        for (const [side, c, t] of [['seal', p.c.S, p.sender], ['open', p.c.O, p.receiver]] as const) {
            const what = how[side] ?? 'done';
            t.media += n;
            if (what === 'bypass') continue;
            c.seen += n;
            if (what === 'done') c.done += n;
            else if (what === 'clear') c.clear += n;
            else c.dropped += n;
        }
    }
    const encrypt = (p: Peer) => { p.state.key = key; p.state.enabled = true; };
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    it('not proven until a window shows every transform that carried frames sealing or opening them; inbound that stops opening un-proves it', async () => {
        const p = peer();
        encrypt(p);
        const changed = vi.fn();
        p.state.onChange = changed;
        await __runFrameAudit(); // the first look: nothing to compare with
        frames(p, 50);
        expect(p.state.proven, 'proven before any window was seen').toBe(false);
        await __runFrameAudit();
        expect(p.state.proven).toBe(true);
        expect(changed, 'told of the receiver\'s first opened frame, then of the proof').toHaveBeenCalledTimes(2);

        frames(p, 50, { open: 'dropped' });
        await __runFrameAudit();
        expect(p.state.proven, 'still proven while nothing it received opened').toBe(false);
        expect(lost, 'inbound that does not open is the peer\'s doing, not a reason to stop encrypting with everyone').not.toHaveBeenCalled();

        await __runFrameAudit(); // nothing moved: nothing learned
        expect(p.state.proven).toBe(false);
        frames(p, 50);
        await __runFrameAudit();
        expect(p.state.proven).toBe(true);
        expect(changed).toHaveBeenCalledTimes(4);
    });

    it('a direction that carries nothing is not held against the other (a listen-only peer)', async () => {
        const p = peer();
        encrypt(p);
        await __runFrameAudit();
        p.c.O.seen += 40; p.c.O.done += 40; p.receiver.media += 40;
        await __runFrameAudit();
        expect(p.state.proven).toBe(true);
    });

    it('frames that keep coming and never open, encryption on: "negotiating" turns into "stuck" after five windows', async () => {
        const p = peer();
        encrypt(p);
        await __runFrameAudit();
        for (let i = 1; i <= 5; i++) {
            expect(p.state.stuck, `stuck after ${i - 1} window(s)`).toBe(false);
            frames(p, 50, { open: 'dropped' });
            await __runFrameAudit();
        }
        expect(p.state.stuck).toBe(true);
        frames(p, 50);
        await __runFrameAudit();
        expect(p.state.stuck, 'still stuck once frames opened').toBe(false);
        expect(lost).not.toHaveBeenCalled();
    });

    it('SECURITY: a receiver whose connection took frames its transform never saw gives the path up, two windows running', async () => {
        const p = peer();
        await __runFrameAudit();
        frames(p, 100, { open: 'bypass' });
        await __runFrameAudit();
        await flush();
        expect(lost, 'one window is not yet proof').not.toHaveBeenCalled();
        frames(p, 100, { open: 'bypass' });
        await __runFrameAudit();
        await flush();
        expect(lost).toHaveBeenCalledTimes(1);
        expect(mediaTransformApi(), 'a transform frames go by was still trusted').toBeNull();
        expect(w.terminated).toBe(true);
    });

    it('SECURITY: the same for a sender: video frames encoded that its transform never saw', async () => {
        const p = peer(true, { send: 'video' });
        await __runFrameAudit();
        for (let i = 0; i < 2; i++) {
            frames(p, 20, { seal: 'bypass' });
            await __runFrameAudit();
        }
        await flush();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: the same packets WITH the transform seeing them, a bypass broken by a window it saw frames, and a trickle below the floor, give nothing up', async () => {
        const p = peer(false);
        await __runFrameAudit();
        for (let i = 0; i < 4; i++) {
            frames(p, 100, { seal: 'clear', open: 'clear' });
            await __runFrameAudit();
        }
        frames(p, 100, { open: 'bypass' });
        await __runFrameAudit();
        frames(p, 100, { seal: 'clear', open: 'clear' });
        await __runFrameAudit();
        frames(p, 100, { open: 'bypass' });
        await __runFrameAudit();
        for (let i = 0; i < 4; i++) {
            frames(p, 5, { open: 'bypass' }); // 5 audio packets: a floor of 10
            await __runFrameAudit();
        }
        await flush();
        expect(lost).not.toHaveBeenCalled();
        expect(mediaTransformApi()).toBe('script-transform');
    });

    it('SECURITY: frames passed on as they came while encryption is required, for a whole window, give the path up', async () => {
        const p = peer(true);
        await __runFrameAudit();
        frames(p, 10, { seal: 'clear', open: 'dropped' });
        await __runFrameAudit();
        await flush();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: frames passed on in the window the requirement came on are not held against it; the next window is', async () => {
        const p = peer(false);
        await __runFrameAudit();
        p.state.requireE2ee = true; // reaches the worker mid-window
        frames(p, 10, { seal: 'clear', open: 'clear' });
        await __runFrameAudit();
        await flush();
        expect(lost, 'a frame from before the change reached the worker was counted against it').not.toHaveBeenCalled();
        frames(p, 10, { seal: 'clear', open: 'dropped' });
        await __runFrameAudit();
        await flush();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('SECURITY: a sender whose frames reach its transform unsealed while encryption is on gives the path up; CONTROL: not while encryption is off', async () => {
        const off2 = peer(false);
        await __runFrameAudit();
        frames(off2, 50, { seal: 'clear', open: 'clear' });
        await __runFrameAudit();
        await flush();
        expect(lost, 'transport-only by design was taken for a fault').not.toHaveBeenCalled();
        encrypt(off2);
        await __runFrameAudit(); // the window the key arrived in
        frames(off2, 50, { seal: 'clear' });
        await __runFrameAudit();
        await flush();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('a worker that stops answering, the page awake, gives the path up after two missed answers', async () => {
        vi.useFakeTimers();
        peer();
        w.answering = false;
        const look = async () => { const t = __runFrameAudit(); await vi.advanceTimersByTimeAsync(5000); await t; await flush(); };
        await look();
        expect(lost, 'one missed answer').not.toHaveBeenCalled();
        await look();
        expect(lost).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: answers missed while the PAGE was asleep (its timer fired long after it was due) are not held against the worker', async () => {
        vi.useFakeTimers();
        peer();
        w.answering = false;
        for (let i = 0; i < 4; i++) {
            const t = __runFrameAudit();
            vi.setSystemTime(Date.now() + 60_000); // a locked phone, a frozen tab
            await vi.advanceTimersByTimeAsync(5000);
            await t;
            await flush();
        }
        expect(lost).not.toHaveBeenCalled();
        w.answering = true;
        await __runFrameAudit();
        expect(mediaTransformApi()).toBe('script-transform');
    });

    it('the first frame a receiver\'s transform opens is known at once (opened, onChange), not at the next look', async () => {
        const p = peer();
        const changed = vi.fn();
        p.state.onChange = changed;
        expect(p.state.opened(p.receiver as unknown as RTCRtpReceiver)).toBe(false);
        w.emit('message', { data: { type: 'counts', seq: null, transforms: [{ id: p.O, seen: 1, done: 1, clear: 0, dropped: 0 }] } });
        expect(p.state.opened(p.receiver as unknown as RTCRtpReceiver)).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(p.state.opened({} as RTCRtpReceiver), 'another receiver').toBe(false);
    });

    it('a peer that goes is no longer looked at, or reported into', async () => {
        const p = peer();
        p.state.dispose();
        const before = w.posted.length;
        await __runFrameAudit();
        expect(w.posted.slice(before).filter(m => m.type === 'report'), 'the audit asked about nobody').toEqual([]);
        w.emit('message', { data: { type: 'counts', seq: null, transforms: [{ id: p.O, seen: 9, done: 9, clear: 0, dropped: 0 }] } });
        expect(p.state.opened(p.receiver as unknown as RTCRtpReceiver)).toBe(false);
    });
});

describe('preferSealableVideoCodecs', () => {
    const caps = [
        { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-level-id=42e01f' },
        { mimeType: 'video/rtx', clockRate: 90000 },
        { mimeType: 'video/VP9', clockRate: 90000 },
        { mimeType: 'video/VP8', clockRate: 90000 },
        { mimeType: 'video/red', clockRate: 90000 },
    ];
    function transceiver(kind: 'audio' | 'video', mid: string | null = null) {
        return { mid, receiver: { track: { kind } }, setCodecPreferences: vi.fn() };
    }
    /** An offer whose video sections list these codecs first, by mid. */
    const offerSdp = (sections: Array<[string, 'H264' | 'VP8']>) => 'v=0\r\ns=-\r\n' + sections.map(([mid, first]) =>
        `m=video 9 UDP/TLS/RTP/SAVPF ${first === 'H264' ? '102 96' : '96 102'}\r\na=mid:${mid}\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\n`).join('');
    afterEach(() => vi.unstubAllGlobals());

    it('before an offer: VP8 first on video transceivers never negotiated, every other codec kept in order, once each', () => {
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: (k: string) => (k === 'video' ? { codecs: caps, headerExtensions: [] } : null) });
        const video = transceiver('video');
        const audio = transceiver('audio');
        const pc = { getTransceivers: () => [audio, video] } as unknown as RTCPeerConnection;
        preferSealableVideoCodecs(pc, { offer: true });
        preferSealableVideoCodecs(pc, { offer: true });
        expect(audio.setCodecPreferences).not.toHaveBeenCalled();
        expect(video.setCodecPreferences).toHaveBeenCalledTimes(1);
        expect(video.setCodecPreferences.mock.calls[0][0].map((c: { mimeType: string }) => c.mimeType))
            .toEqual(['video/VP8', 'video/H264', 'video/rtx', 'video/VP9', 'video/red']);
    });

    it('before an offer: nothing at all where the engine already lists VP8 first (Chromium, Firefox: a polite Firefox under glare breaks on any)', () => {
        const vp8First = [caps[3], caps[1], caps[2], caps[0], caps[4]];
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: vp8First, headerExtensions: [] }) });
        const fresh = transceiver('video', null);
        const pc = { getTransceivers: () => [fresh] } as unknown as RTCPeerConnection;
        preferSealableVideoCodecs(pc, { offer: true });
        expect(fresh.setCodecPreferences, 'preferences that change nothing, which Firefox mis-numbers after glare').not.toHaveBeenCalled();
        // rtx (or red, or FEC) at the head of the list is not a codec choice.
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [caps[1], caps[3], caps[0]], headerExtensions: [] }) });
        preferSealableVideoCodecs(pc, { offer: true });
        expect(fresh.setCodecPreferences).not.toHaveBeenCalled();
        // CONTROL: on that engine an answer to an H.264-first offer still puts VP8 first.
        const answering = transceiver('video', '0');
        preferSealableVideoCodecs({ getTransceivers: () => [answering] } as unknown as RTCPeerConnection, { answerTo: offerSdp([['0', 'H264']]) });
        expect(answering.setCodecPreferences).toHaveBeenCalledTimes(1);
    });

    it('before an offer: leaves a transceiver already negotiated alone (Firefox would write it an offer Chromium refuses)', () => {
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: caps, headerExtensions: [] }) });
        const negotiated = transceiver('video', '2');
        const fresh = transceiver('video', null);
        preferSealableVideoCodecs({ getTransceivers: () => [negotiated, fresh] } as unknown as RTCPeerConnection, { offer: true });
        expect(negotiated.setCodecPreferences, 'a negotiated transceiver was given preferences').not.toHaveBeenCalled();
        expect(fresh.setCodecPreferences, 'control: the fresh one is').toHaveBeenCalledTimes(1);
    });

    it('before an answer: only where the offer did not already put VP8 first', () => {
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: caps, headerExtensions: [] }) });
        const h264First = transceiver('video', '0');
        const vp8First = transceiver('video', '1');
        const notOffered = transceiver('video', '7');
        const sdp = offerSdp([['0', 'H264'], ['1', 'VP8']]);
        preferSealableVideoCodecs({ getTransceivers: () => [h264First, vp8First, notOffered] } as unknown as RTCPeerConnection, { answerTo: sdp });
        expect(h264First.setCodecPreferences, 'an H.264-first offer was answered in its own order').toHaveBeenCalledTimes(1);
        expect(vp8First.setCodecPreferences, 'a VP8-first offer needs nothing (and Firefox must not be given it)').not.toHaveBeenCalled();
        expect(notOffered.setCodecPreferences).not.toHaveBeenCalled();
    });

    it('reads the first codec of each video section by mid', () => {
        expect([...firstVideoCodecByMid(offerSdp([['0', 'H264'], ['x', 'VP8']]))]).toEqual([['0', 'H264'], ['x', 'VP8']]);
        expect(firstVideoCodecByMid('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n').size).toBe(0);
    });

    it('leaves the order alone when there is no VP8 to prefer, and survives a transceiver that refuses', () => {
        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: caps.filter(c => c.mimeType !== 'video/VP8'), headerExtensions: [] }) });
        const t = transceiver('video');
        preferSealableVideoCodecs({ getTransceivers: () => [t] } as unknown as RTCPeerConnection, { offer: true });
        expect(t.setCodecPreferences).not.toHaveBeenCalled();

        vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: caps, headerExtensions: [] }) });
        const refuses = transceiver('video');
        refuses.setCodecPreferences.mockImplementation(() => { throw new DOMException('stopped', 'InvalidStateError'); });
        const next = transceiver('video');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        preferSealableVideoCodecs({ getTransceivers: () => [refuses, next] } as unknown as RTCPeerConnection, { offer: true });
        expect(next.setCodecPreferences).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});

describe('sendSealableVideoCodec', () => {
    const H264 = { mimeType: 'video/H264', clockRate: 90000, payloadType: 102, sdpFmtpLine: 'profile-level-id=42e01f' };
    const VP8 = { mimeType: 'video/VP8', clockRate: 90000, payloadType: 96 };
    function sender(kind: 'audio' | 'video', codecs: object[], encodings: object[] = [{ active: true }]) {
        return {
            track: { kind },
            getParameters: vi.fn(() => ({ codecs, encodings: encodings.map(e => ({ ...e })), transactionId: 't', headerExtensions: [], rtcp: {} })),
            setParameters: vi.fn(async (_p: { encodings: Array<{ codec?: { mimeType: string } }> }) => {}),
        };
    }
    const pcOf = (...senders: unknown[]) => ({ getSenders: () => senders }) as unknown as RTCPeerConnection;

    it('makes a video sender whose negotiated default is another codec send VP8, keeping its other encoding fields', async () => {
        const s = sender('video', [H264, VP8], [{ active: true, maxBitrate: 8_000_000 }]);
        await sendSealableVideoCodec(pcOf(s));
        expect(s.setParameters).toHaveBeenCalledTimes(1);
        const enc = s.setParameters.mock.calls[0][0].encodings[0] as { codec?: { mimeType: string }; maxBitrate?: number };
        expect(enc.codec?.mimeType).toBe('video/VP8');
        expect(enc.maxBitrate, 'the share tuning on the same encoding was dropped').toBe(8_000_000);
    });

    it('leaves alone a sender already on VP8 (the ordinary call: no setParameters at all), audio, and one with no VP8', async () => {
        const already = sender('video', [VP8, H264]);
        const chosen = sender('video', [H264, VP8], [{ codec: VP8 }]);
        const audio = sender('audio', [{ mimeType: 'audio/opus', clockRate: 48000 }]);
        const noVp8 = sender('video', [H264]);
        await sendSealableVideoCodec(pcOf(already, chosen, audio, noVp8));
        for (const s of [already, chosen, audio, noVp8]) expect(s.setParameters).not.toHaveBeenCalled();
    });

    it('a sender that refuses keeps its default, logged, and the others are still set', async () => {
        const refuses = sender('video', [H264, VP8]);
        refuses.setParameters.mockRejectedValueOnce(new DOMException('no', 'InvalidModificationError'));
        const next = sender('video', [H264, VP8]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await sendSealableVideoCodec(pcOf(refuses, next));
        expect(next.setParameters).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
