/**
 * The device file-transfer protocol: request ids, strict short-read handling,
 * and verified writes.
 *
 * Why these exist: the channel used to carry no ids, so "the next message is
 * my answer" was the whole matching rule. One reply arriving AFTER its
 * request's 15s timeout was consumed by the FOLLOWING request, every answer
 * shifted off by one, a mismatched Data reply decoded to zero bytes, zero
 * bytes read as EOF — and the download saved a TRUNCATED file under the real
 * filename with no error. Silent corruption, not failure. Each test here
 * pins one link of the chain that made that possible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeChannel extends EventTarget {
    readyState = 'open';
    sent: Array<Record<string, unknown>> = [];
    /** When set, every send is answered on a microtask with this. */
    autoRespond: ((req: Record<string, unknown>) => Record<string, unknown>) | null = null;

    send(msg: string) {
        const req = JSON.parse(msg) as Record<string, unknown>;
        this.sent.push(req);
        const responder = this.autoRespond;
        if (responder) queueMicrotask(() => this.reply(responder(req)));
    }

    reply(obj: Record<string, unknown>) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(obj) }));
    }
}

let channel: FakeChannel;

vi.mock('../api/devices/session', () => ({
    activeSessions: () => [{ id: 'fs-test', filesChannel: channel }],
}));

import {
    listDir,
    readFileChunk,
    downloadFileTo,
    uploadFile,
    FS_CHUNK,
} from '../api/devices/fileTransfer';

function b64of(len: number, fill = 65): string {
    return btoa(String.fromCharCode(...new Uint8Array(len).fill(fill)));
}

/** jsdom's Blob.slice() hands back a Blob without arrayBuffer(), so uploads
 *  need a stand-in that implements the two members uploadFile touches. */
function fakeFile(size: number): Blob {
    const buf = new Uint8Array(size);
    return {
        size,
        slice(start: number, end: number) {
            const part = buf.subarray(start, end);
            return { arrayBuffer: async () => part.slice().buffer };
        },
    } as unknown as Blob;
}

beforeEach(() => {
    channel = new FakeChannel();
});

describe('request ids', () => {
    it('every request carries an id, and the matching reply resolves it', async () => {
        channel.autoRespond = req => ({ ok: 'list', entries: [{ name: 'a', is_dir: false, size: 1 }], id: req.id });
        const { entries } = await listDir('fs-test', 'C:\\');
        expect(entries.map(e => e.name)).toEqual(['a']);
        expect(typeof channel.sent[0].id).toBe('number');
    });

    it('a reply wearing someone else\'s id is discarded, not consumed', async () => {
        const p = listDir('fs-test', 'C:\\');
        await Promise.resolve();
        const myId = channel.sent[0].id as number;

        // A straggler from some earlier request: must be ignored entirely.
        channel.reply({ ok: 'list', entries: [{ name: 'STALE', is_dir: false, size: 0 }], id: myId + 1000 });
        channel.reply({ ok: 'list', entries: [{ name: 'RIGHT', is_dir: false, size: 0 }], id: myId });

        expect((await p).entries.map(e => e.name)).toEqual(['RIGHT']);
    });

    it('a reply with NO id still resolves — an agent from before ids', async () => {
        const p = readFileChunk('fs-test', 'a.txt', 0, 16);
        await Promise.resolve();
        channel.reply({ ok: 'data', data: b64of(16) });
        expect((await p).length).toBeGreaterThan(0);
    });

    /**
     * THE DESYNC, replayed exactly: request A times out, request B goes out,
     * and A's late reply arrives first. Without ids B consumed A's answer and
     * every reply from then on was off by one — this is the test that goes
     * red if the id check is removed.
     */
    it('a late reply to a timed-out request cannot answer the next one', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const pa = listDir('fs-test', 'C:\\slow');
            // Attach the expectation BEFORE the clock runs the timeout, or the
            // rejection lands unobserved and vitest reports it as unhandled.
            const paRejected = expect(pa).rejects.toThrow('did not answer');
            await Promise.resolve();
            const idA = channel.sent[0].id as number;

            await vi.advanceTimersByTimeAsync(15_100);
            await paRejected;

            const pb = listDir('fs-test', 'C:\\fast');
            await Promise.resolve();
            const idB = channel.sent[1].id as number;
            expect(idB).not.toBe(idA);

            // A's answer finally limps in, THEN B's.
            channel.reply({ ok: 'list', entries: [{ name: 'FROM-A', is_dir: true, size: 0 }], id: idA });
            channel.reply({ ok: 'list', entries: [{ name: 'FROM-B', is_dir: true, size: 0 }], id: idB });

            expect((await pb).entries.map(e => e.name), 'B must get B\'s answer, never A\'s').toEqual(['FROM-B']);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('strict transfer accounting', () => {
    it('a short read mid-file is an ERROR, never silent truncation', async () => {
        channel.autoRespond = req => {
            const offset = req.offset as number;
            // First chunk full, second chunk empty — the shape a dropped or
            // mismatched reply used to decode to.
            return offset === 0
                ? { ok: 'data', data: b64of(FS_CHUNK), id: req.id }
                : { ok: 'data', data: '', id: req.id };
        };
        const got: number[] = [];
        await expect(
            downloadFileTo('fs-test', 'big.bin', FS_CHUNK * 2, b => { got.push(b.length); }),
        ).rejects.toThrow('ended early');
        expect(got).toEqual([FS_CHUNK]);
    });

    it('a zero-byte file downloads as empty without being an error', async () => {
        channel.autoRespond = req => ({ ok: 'data', data: '', id: req.id });
        const got: number[] = [];
        const n = await downloadFileTo('fs-test', 'empty.txt', 0, b => { got.push(b.length); });
        expect(n).toBe(0);
        expect(got).toEqual([]);
    });

    it('an upload whose reply wrote fewer bytes than sent aborts loudly', async () => {
        channel.autoRespond = req => ({ ok: 'wrote', len: 5, id: req.id });
        await expect(uploadFile('fs-test', 'up.bin', fakeFile(1000))).rejects.toThrow('wrote 5 of 1000');
    });

    it('an upload advances only on full-length confirmations', async () => {
        const written: number[] = [];
        channel.autoRespond = req => {
            const data = req.data as string;
            const len = atob(data).length;
            written.push(len);
            return { ok: 'wrote', len, id: req.id };
        };
        const size = FS_CHUNK + 100;
        const n = await uploadFile('fs-test', 'up.bin', fakeFile(size));
        expect(n).toBe(size);
        expect(written).toEqual([FS_CHUNK, 100]);
    });
});

describe('the chunk size honours the channel budget', () => {
    /**
     * str0m's send budget is 128 KiB across ALL streams and frees only on the
     * peer's SACK. A framed reply is base64-in-JSON; at 64 KiB chunks that was
     * ~87 KB per reply, so one in-flight reply plus one unacked predecessor
     * overflowed the budget and the agent dropped the reply on the floor —
     * every real download died at the first overlap. Two framed replies must
     * fit the budget with room to spare, or this regresses.
     */
    it('two framed replies fit inside the 128 KiB budget', () => {
        const framed = Math.ceil(FS_CHUNK / 3) * 4 + 200; // base64 + JSON envelope
        expect(framed * 2).toBeLessThan(128 * 1024 / 2);
    });
});
