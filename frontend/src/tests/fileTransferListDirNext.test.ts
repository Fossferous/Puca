/**
 * listDir's `next` guard, driven through the REAL listDir and sendCommand
 * against a stand-in files channel that answers with a scripted `next`.
 *
 * `next` is what the Load more button follows. A host that names a `next` which
 * does not move forward past the cursor it was asked for would loop the button
 * forever on the same page, and a malformed one would be sent straight back as
 * a cursor the host cannot read. Either way the only safe answer is "no further
 * page" — the folder then reads as cut ("the first N are listed") instead of
 * pretending a further page exists.
 */
import { describe, it, expect, vi } from 'vitest';

/** The `next` the stand-in host puts on its reply. */
let replyNext: unknown;
/** What the stand-in host was asked, for asserting the cursor went out. */
const asked: Array<Record<string, unknown>> = [];

const channel = (() => {
    const listeners = new Set<(e: MessageEvent) => void>();
    return {
        readyState: 'open' as const,
        addEventListener(type: string, fn: (e: MessageEvent) => void) {
            if (type === 'message') listeners.add(fn);
        },
        removeEventListener(type: string, fn: (e: MessageEvent) => void) {
            if (type === 'message') listeners.delete(fn);
        },
        send(data: string) {
            const req = JSON.parse(data) as Record<string, unknown>;
            asked.push(req);
            const reply: Record<string, unknown> = {
                ok: 'list',
                entries: [{ name: 'a', is_dir: false, size: 1 }],
                truncated: true,
                id: req.id,
            };
            if (replyNext !== undefined) reply.next = replyNext;
            queueMicrotask(() => {
                const ev = new MessageEvent('message', { data: JSON.stringify(reply) });
                listeners.forEach(fn => fn(ev));
            });
        },
    };
})();

vi.mock('../api/devices/session', () => ({
    activeSessions: () => [{ id: 'next-test', filesChannel: channel }],
}));

import { listDir } from '../api/devices/fileTransfer';

async function nextFor(next: unknown, cursor?: number) {
    replyNext = next;
    return (await listDir('next-test', 'C:\\big', cursor)).next;
}

describe('listDir only follows a next that moves forward', () => {
    it('a next past the cursor is followed (positive control)', async () => {
        expect(await nextFor(2000)).toBe(2000);
        expect(await nextFor(4000, 1983)).toBe(4000);
        expect(asked.at(-1)).toMatchObject({ cmd: 'list', path: 'C:\\big', cursor: 1983 });
    });

    it('a next equal to the cursor would repeat the same page forever', async () => {
        expect(await nextFor(1983, 1983)).toBeNull();
    });

    it('a next behind the cursor would walk backwards', async () => {
        expect(await nextFor(10, 1983)).toBeNull();
    });

    it('a first page whose next is 0 offers no further page', async () => {
        expect(await nextFor(0)).toBeNull();
    });

    it('a next that is not a whole number is not a cursor', async () => {
        expect(await nextFor(2000.5)).toBeNull();
        expect(await nextFor('2000')).toBeNull();
        expect(await nextFor(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
        expect(await nextFor(null)).toBeNull();
    });

    it('the first page asks with no cursor at all, as before paging', async () => {
        await nextFor(undefined);
        expect('cursor' in asked.at(-1)!).toBe(false);
    });
});
