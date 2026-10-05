/**
 * The attachment cache's CIPHERTEXT files (api/cipherStore.ts, through the
 * real api/attachments.ts): an OPFS file per copy kept, so that showing it
 * again needs no download. Two ways for them to outlive their use, each a
 * mutation no suite caught (review, 2026-10-05):
 *
 *  - a copy pushed out of the budget keeps its file: the disk grows until
 *    sign-out or the next page, past every budget the cache claims;
 *  - sign-out keeps the page's cache directory (and the Web Lock that stops
 *    the next page sweeping it), with the last account's files in it.
 *
 * jsdom has no OPFS: fixtures/fakeOpfs.ts stands in (the page writes, no
 * writer worker). The real one, on a real disk: e2e/plaintext-disk-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { acquireAttachmentUrl, clearBlobCache, attachmentCacheStats, __setRetainedAttachmentBudget } from '../api/attachments';
import { __setCipherStoreDisabled, __setCipherWriterFactory } from '../api/cipherStore';
import { type FakeDir, fakeOpfsNavigator, sessionDirsOf, filesInOf } from './fixtures/fakeOpfs';

let root: FakeDir;
let held: Set<string>;
let served: Map<string, Uint8Array>;
let requested: string[];
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
let seq = 0;

const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
async function seal(id: string): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new Uint8Array(1000).fill(7)));
    served.set(id, cat(nonce, ct));
    return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
/** Every cached ciphertext file this page has, by name. */
const files = () => sessionDirsOf(root).flatMap((d) => filesInOf(root, d).map((f) => f.name));

/** Each file's key, once served. */
const keys = new Map<string, string>();
/** Shown, then let go: its plaintext goes, its ciphertext file stays (or not). */
async function showAndLetGo(id: string): Promise<void> {
    if (!keys.has(id)) keys.set(id, await seal(id));
    const hold = await acquireAttachmentUrl(id, keys.get(id)!, 'image/png');
    await settle();
    hold.release();
    await settle();
}

beforeEach(() => {
    const opfs = fakeOpfsNavigator();
    root = opfs.root;
    held = opfs.held;
    vi.stubGlobal('navigator', { ...navigator, ...opfs.navigator });
    __setCipherStoreDisabled(null); // a new session directory per test
    __setCipherWriterFactory(() => null); // the page writes
    served = new Map();
    keys.clear();
    requested = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const id = String(input).split('/files/')[1];
        requested.push(id);
        const body = served.get(id);
        return body ? new Response(body.slice()) : new Response('', { status: 404 });
    });
    URL.createObjectURL = (() => `blob:cf-${++seq}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
});

afterEach(() => {
    clearBlobCache();
    __setRetainedAttachmentBudget(null);
    __setCipherWriterFactory(null);
    __setCipherStoreDisabled(null);
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('the cached ciphertext files', () => {
    it('POSITIVE CONTROL: a copy let go within the budget keeps its file, and showing it again downloads nothing', async () => {
        await showAndLetGo('a');
        expect(files()).toHaveLength(1);
        expect(attachmentCacheStats()).toMatchObject({ entries: 1, retainedBytes: 1000, plainBytes: 0 });
        await showAndLetGo('a');
        expect(requested).toEqual(['a']);
        expect(files()).toHaveLength(1);
    });

    it('a copy pushed out of the budget has its file removed', async () => {
        __setRetainedAttachmentBudget(1000); // room for one
        await showAndLetGo('a');
        expect(files()).toHaveLength(1);
        await showAndLetGo('b');
        expect(attachmentCacheStats()).toMatchObject({ entries: 1, retainedBytes: 1000 });
        expect(files()).toHaveLength(1);
        __setRetainedAttachmentBudget(0);
        await showAndLetGo('c');
        expect(attachmentCacheStats().entries).toBe(0);
        expect(files()).toEqual([]);
    });

    it('sign-out removes the page\'s cache directory with every file in it, and lets its lock go', async () => {
        await showAndLetGo('a');
        await showAndLetGo('b');
        const [dir] = sessionDirsOf(root);
        expect(files()).toHaveLength(2);
        expect(held.has(`puca-attachment-cache:${dir}`)).toBe(true);
        clearBlobCache();
        await settle();
        expect(sessionDirsOf(root)).toEqual([]);
        expect(held.size).toBe(0);
    });
});
