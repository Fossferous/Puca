/**
 * "Save to Notes" — the upload half: the anti-aliasing contract.
 *
 * A captured picture must become a NEW file of this account's own. Reusing the
 * sender's ref would look identical on screen and be wrong four ways: the
 * storage is billed to the uploader, the file dies when they delete it, a
 * later "delete note forever" would destroy a file the chat message still
 * names, and the note would depend on a capability minted for someone else's
 * upload. `copyRefsIntoMyNote` handing back a ref whose file id equals the
 * source's is the failure this file exists to catch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const deletedIds: string[][] = [];
const uploaded: File[] = [];
let failOnUpload: number | null = null;

vi.mock('../api/attachments', async (orig) => {
    const real = await orig<typeof import('../api/attachments')>();
    return {
        ...real,
        decryptToBlobUrl: vi.fn(async (id: string) => `blob:decrypted-${id}`),
        encryptAndUploadRef: vi.fn(async (file: File) => {
            uploaded.push(file);
            if (failOnUpload !== null && uploaded.length === failOnUpload) throw new Error('upload refused');
            const n = uploaded.length;
            return { href: `sovereign-enc:COPY${n}?k=NEWKEY${n}&m=${encodeURIComponent(file.type)}&c=NEWCAP${n}`, name: file.name, mime: file.type };
        }),
    };
});
vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, deleteFiles: vi.fn(async (ids: string[]) => { deletedIds.push(ids); }) };
});

// jsdom has no fetch for blob: URLs — the decrypted bytes are whatever this
// returns, which is all this test cares about.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('blob:')) return new Response(new Blob([url]), { status: 200 });
    return realFetch(input as RequestInfo);
}) as typeof fetch;

import { copyRefsIntoMyNote, discardCopies } from '../api/captureToNote';
import { parseEncAttachment } from '../api/attachments';
import { MAX_TASK_ATTACHMENTS } from '../api/tasks';

const src = (n: number) => ({ href: `sovereign-enc:SRC${n}?k=THEIRKEY${n}&m=image%2Fpng&c=THEIRCAP${n}`, name: `pic${n}.png` });

beforeEach(() => {
    deletedIds.length = 0;
    uploaded.length = 0;
    failOnUpload = null;
});

describe('copyRefsIntoMyNote', () => {
    it('hands back refs naming DIFFERENT files than the sources, under new keys', async () => {
        const out = await copyRefsIntoMyNote([src(1), src(2)]);
        expect(out).toHaveLength(2);
        for (let i = 0; i < 2; i++) {
            const from = parseEncAttachment(src(i + 1).href)!;
            const to = parseEncAttachment(out[i].href)!;
            expect(to.id).not.toBe(from.id);   // the contract
            expect(to.key).not.toBe(from.key); // a fresh key, not the sender's
            expect(to.cap).not.toBe(from.cap);
        }
        expect(deletedIds).toEqual([]); // positive control: nothing rolled back
    });

    it('keeps the file name and mime, so the note shows the same picture', async () => {
        await copyRefsIntoMyNote([src(1)]);
        expect(uploaded[0].name).toBe('pic1.png');
        expect(uploaded[0].type).toBe('image/png');
    });

    it('rolls back: when the 2nd of 3 fails, the 1st copy is deleted and nothing is returned', async () => {
        failOnUpload = 2;
        await expect(copyRefsIntoMyNote([src(1), src(2), src(3)])).rejects.toThrow('upload refused');
        expect(deletedIds).toEqual([['COPY1']]);
        expect(uploaded).toHaveLength(2); // it stopped, rather than uploading the 3rd
    });

    it('refuses before uploading anything when the note has no room', async () => {
        await expect(copyRefsIntoMyNote([src(1)], MAX_TASK_ATTACHMENTS)).rejects.toThrow(/at most/);
        expect(uploaded).toHaveLength(0);
    });
});

describe('discardCopies', () => {
    it('deletes exactly the files the refs name', async () => {
        await discardCopies([{ href: 'sovereign-enc:A1?k=K', name: 'a' }, { href: 'not-a-ref', name: 'b' }]);
        expect(deletedIds).toEqual([['A1']]);
    });
});
