/**
 * The phone-side file server, tested against an in-memory filesystem — and,
 * at the end, against the REAL controller-side client over a paired fake
 * channel, because two ends that are each tested against an imagined peer
 * can drift apart while both stay green.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    FS_LIST_REPLY_BUDGET, FS_MAX_LIST, handleFsRequest, attachFilesServer, type GrantedRoot,
} from '../api/devices/hostFsServer';
import type { FsProvider } from '../api/devices/fsJail';

const ROOT = '/storage/emulated/0/Download';
const GRANT: GrantedRoot = { root: ROOT, canonRoot: ROOT };

function b64(s: string): string { return btoa(s); }

/** In-memory FsProvider rooted at ROOT. */
function memProvider(files: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(files));
    return {
        store,
        provider: {
            async stat(path: string) {
                if (store.has(path)) return { exists: true, is_dir: false, size: atob(store.get(path)!).length };
                const dir = [...store.keys()].some(k => k.startsWith(path + '/'));
                return { exists: dir, is_dir: dir, size: 0 };
            },
            async readdir(path: string) {
                const names = new Set<string>();
                for (const k of store.keys()) {
                    if (k.startsWith(path + '/')) names.add(k.slice(path.length + 1).split('/')[0]);
                }
                return [...names].map(name => ({
                    name,
                    is_dir: !store.has(`${path}/${name}`),
                    size: store.has(`${path}/${name}`) ? atob(store.get(`${path}/${name}`)!).length : 0,
                }));
            },
            async read(path: string, offset: number, length: number) {
                const bytes = atob(store.get(path) ?? '');
                return btoa(bytes.slice(offset, offset + length));
            },
            async writeReplace(path: string, dataB64: string) { store.set(path, dataB64); },
            async append(path: string, dataB64: string) {
                store.set(path, btoa(atob(store.get(path) ?? '') + atob(dataB64)));
            },
            async canonicalize(path: string) { return path; },
        } satisfies FsProvider,
    };
}

describe('handleFsRequest', () => {
    it('answers nothing without a grant', async () => {
        const { provider } = memProvider();
        const r = await handleFsRequest({ cmd: 'list_roots' }, null, provider);
        expect(r.ok).toBe('error');
        expect(String(r.message)).toContain('not been allowed');
    });

    it('list_roots names exactly the granted folder', async () => {
        const { provider } = memProvider();
        const r = await handleFsRequest({ cmd: 'list_roots' }, GRANT, provider);
        expect(r).toEqual({ ok: 'roots', roots: [ROOT] });
    });

    it('refuses a path outside the jail on every command', async () => {
        const { provider } = memProvider();
        for (const cmd of [
            { cmd: 'list', path: '/data/data' },
            { cmd: 'read', path: '../../secrets', offset: 0, len: 16 },
            { cmd: 'write', path: `${ROOT}/../x`, offset: 0, data: b64('hi') },
        ]) {
            const r = await handleFsRequest(cmd, GRANT, provider);
            expect(r.ok, JSON.stringify(cmd)).toBe('error');
        }
    });

    it('reads with EOF determinism: past-end is empty data, not an error', async () => {
        const { provider } = memProvider({ [`${ROOT}/a.txt`]: b64('hello') });
        const mid = await handleFsRequest({ cmd: 'read', path: 'a.txt', offset: 2, len: 16 }, GRANT, provider);
        expect(mid).toEqual({ ok: 'data', data: b64('llo') });
        const past = await handleFsRequest({ cmd: 'read', path: 'a.txt', offset: 5, len: 16 }, GRANT, provider);
        expect(past).toEqual({ ok: 'data', data: '' });
    });

    it('write state machine: replace at 0, append at end, refuse holes and mid-file', async () => {
        const { provider, store } = memProvider({ [`${ROOT}/f.bin`]: b64('OLDDATA') });
        const w0 = await handleFsRequest({ cmd: 'write', path: 'f.bin', offset: 0, data: b64('ab') }, GRANT, provider);
        expect(w0).toEqual({ ok: 'wrote', len: 2 });
        expect(atob(store.get(`${ROOT}/f.bin`)!), 'replace-at-0 kills the old tail').toBe('ab');

        const w2 = await handleFsRequest({ cmd: 'write', path: 'f.bin', offset: 2, data: b64('cd') }, GRANT, provider);
        expect(w2).toEqual({ ok: 'wrote', len: 2 });
        expect(atob(store.get(`${ROOT}/f.bin`)!)).toBe('abcd');

        const hole = await handleFsRequest({ cmd: 'write', path: 'f.bin', offset: 99, data: b64('x') }, GRANT, provider);
        expect(hole.ok).toBe('error');
        expect(String(hole.message)).toContain('write sequentially');

        const mid = await handleFsRequest({ cmd: 'write', path: 'f.bin', offset: 1, data: b64('x') }, GRANT, provider);
        expect(mid.ok).toBe('error');
    });

    it('caps a directory past FS_MAX_LIST and flags the cut', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < FS_MAX_LIST + 1; i++) {
            files[`${ROOT}/big/f${String(i).padStart(5, '0')}`] = b64('x');
        }
        const { provider } = memProvider(files);
        const r = await handleFsRequest({ cmd: 'list', path: 'big' }, GRANT, provider);
        expect(r.ok).toBe('list');
        expect((r.entries as unknown[]).length).toBe(FS_MAX_LIST);
        expect(r.truncated).toBe(true);
    });

    it('a directory at exactly the cap is complete and not truncated', async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < FS_MAX_LIST; i++) {
            files[`${ROOT}/big/f${String(i).padStart(5, '0')}`] = b64('x');
        }
        const { provider } = memProvider(files);
        const r = await handleFsRequest({ cmd: 'list', path: 'big' }, GRANT, provider);
        expect((r.entries as unknown[]).length).toBe(FS_MAX_LIST);
        expect(r.truncated).toBe(false);
    });

    it('refuses oversized reads and writes before any I/O', async () => {
        const { provider } = memProvider();
        const read = await handleFsRequest({ cmd: 'read', path: 'a', offset: 0, len: 65 * 1024 }, GRANT, provider);
        expect(String(read.message)).toContain('limit');
        const write = await handleFsRequest(
            { cmd: 'write', path: 'a', offset: 0, data: 'A'.repeat(Math.ceil((65 * 1024) / 3) * 4) },
            GRANT, provider,
        );
        expect(String(write.message)).toContain('limit');
    });
});

/** Chromium's SCTP maxMessageSize, which a Chromium controller advertises:
 *  `RTCDataChannel.send` THROWS for a longer message. Written out here so the
 *  test pins the external fact, not the product's own budget. */
const CHROMIUM_MAX_MESSAGE = 256 * 1024;

/** The UTF-8 size of a reply as `dc.send` would carry it — bytes, not
 *  UTF-16 code units, and with the widest id a session can produce. */
function wireBytes(reply: object): number {
    return new TextEncoder().encode(JSON.stringify({ ...reply, id: Number.MAX_SAFE_INTEGER })).length;
}

function bigFolder(n: number, name: (i: number) => string): Record<string, string> {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`${ROOT}/big/${name(i)}`] = b64('x');
    return files;
}

describe('a big folder listing is bounded in BYTES and pages', () => {
    // THE BUG: the cap was a COUNT (5,000 entries). With 40-character names a
    // capped reply is ~400 KB, past what a Chromium controller accepts in one
    // message; dc.send threw, the throw was swallowed, and the controller
    // waited 15 s for "the other computer did not answer".
    it('a capped listing of long names fits one data-channel message', async () => {
        const { provider } = memProvider(bigFolder(5_003, i => `${String(i).padStart(5, '0')}-${'n'.repeat(34)}`));
        const r = await handleFsRequest({ cmd: 'list', path: 'big' }, GRANT, provider);
        expect(r.ok).toBe('list');
        expect(wireBytes(r), 'over what the controller can ever receive').toBeLessThanOrEqual(CHROMIUM_MAX_MESSAGE);
        expect(wireBytes(r)).toBeLessThanOrEqual(FS_LIST_REPLY_BUDGET);
        expect(r.truncated).toBe(true);
    });

    it('counts multibyte names in bytes, not characters', async () => {
        const long = '長いファイル名'.repeat(11); // 77 chars, 231 UTF-8 bytes
        const { provider } = memProvider(bigFolder(2_000, i => `${String(i).padStart(4, '0')}${long}`));
        const r = await handleFsRequest({ cmd: 'list', path: 'big' }, GRANT, provider);
        expect(wireBytes(r)).toBeLessThanOrEqual(CHROMIUM_MAX_MESSAGE);
        expect(wireBytes(r)).toBeLessThanOrEqual(FS_LIST_REPLY_BUDGET);
        // Exact accounting, not a timid one: the page nearly fills the budget.
        expect(wireBytes(r)).toBeGreaterThan(FS_LIST_REPLY_BUDGET - 1024);
        expect(r.truncated).toBe(true);
    });

    it('a 10,000-entry folder pages through completely, following next', async () => {
        const { provider } = memProvider(bigFolder(10_000, i => `photo-${String(i).padStart(5, '0')}.jpg`));
        const seen: string[] = [];
        let cursor: number | undefined;
        let pages = 0;
        for (;;) {
            pages++;
            expect(pages, 'paging must terminate').toBeLessThan(100);
            const req: Record<string, unknown> = { cmd: 'list', path: 'big' };
            if (cursor !== undefined) req.cursor = cursor;
            const r = await handleFsRequest(req, GRANT, provider);
            expect(wireBytes(r)).toBeLessThanOrEqual(FS_LIST_REPLY_BUDGET);
            seen.push(...(r.entries as { name: string }[]).map(e => e.name));
            if (typeof r.next !== 'number') {
                expect(r.truncated, 'the last page completes the folder').toBe(false);
                break;
            }
            expect(r.truncated).toBe(true);
            expect(r.next).toBeGreaterThan(cursor ?? 0);
            cursor = r.next;
        }
        expect(pages).toBeGreaterThan(1);
        expect(seen.length).toBe(10_000);
        expect(new Set(seen).size).toBe(10_000);
    });

    it('is additive: no cursor is the first page; a small folder has no next', async () => {
        const { provider } = memProvider(bigFolder(3, i => `f${i}`));
        const r = await handleFsRequest({ cmd: 'list', path: 'big' }, GRANT, provider);
        expect((r.entries as unknown[]).length).toBe(3);
        expect(r.truncated).toBe(false);
        expect('next' in r).toBe(false);
        const past = await handleFsRequest({ cmd: 'list', path: 'big', cursor: 50 }, GRANT, provider);
        expect(past.entries).toEqual([]);
        expect(past.truncated).toBe(false);
        // A malformed cursor is the first page, never a crash.
        const junk = await handleFsRequest({ cmd: 'list', path: 'big', cursor: -4 }, GRANT, provider);
        expect((junk.entries as unknown[]).length).toBe(3);
    });
});

describe('a reply the channel refuses is still answered', () => {
    // dc.send THROWS for a message over the peer's maxMessageSize (and for a
    // channel that is closing). That throw used to be swallowed whole — the
    // request was never answered and the controller timed out 15 s later
    // with nothing in any log to say why.
    it('answers the same id with an error when the first send throws', async () => {
        const { provider } = memProvider({ [`${ROOT}/a.txt`]: b64('hello') });
        const sent: string[] = [];
        let throwNext = true;
        const dc = {
            readyState: 'open',
            onmessage: null as ((e: MessageEvent) => void) | null,
            send(data: string) {
                if (throwNext) {
                    throwNext = false;
                    throw new TypeError('message too large');
                }
                sent.push(data);
            },
        };
        attachFilesServer(dc as unknown as RTCDataChannel, () => GRANT, provider);
        dc.onmessage!(new MessageEvent('message', {
            data: JSON.stringify({ cmd: 'read', path: 'a.txt', offset: 0, len: 16, id: 77 }),
        }));
        await new Promise(r => setTimeout(r, 0));
        expect(sent.length, 'the request must be answered').toBe(1);
        const reply = JSON.parse(sent[0]) as { ok: string; id: number; message: string };
        expect(reply.ok).toBe('error');
        expect(reply.id).toBe(77);
        expect(reply.message).toMatch(/could not be sent/);
    });

    it('a send that works is sent once, unchanged (positive control)', async () => {
        const { provider } = memProvider({ [`${ROOT}/a.txt`]: b64('hello') });
        const sent: string[] = [];
        const dc = {
            readyState: 'open',
            onmessage: null as ((e: MessageEvent) => void) | null,
            send(data: string) { sent.push(data); },
        };
        attachFilesServer(dc as unknown as RTCDataChannel, () => GRANT, provider);
        dc.onmessage!(new MessageEvent('message', {
            data: JSON.stringify({ cmd: 'read', path: 'a.txt', offset: 0, len: 16, id: 5 }),
        }));
        await new Promise(r => setTimeout(r, 0));
        expect(sent).toEqual([JSON.stringify({ ok: 'data', data: b64('hello'), id: 5 })]);
    });
});

/** One end of the pair: the slice of RTCDataChannel both sides touch, plus
 *  the link to the other end. Named, because the end refers to its own type. */
interface FakeChannel {
    readyState: 'open';
    onmessage: ((e: MessageEvent) => void) | null;
    peer: FakeChannel | null;
    addEventListener(type: string, fn: (e: MessageEvent) => void): void;
    removeEventListener(type: string, fn: (e: MessageEvent) => void): void;
    send(data: string): void;
    deliver(ev: MessageEvent): void;
}

/** Paired in-memory RTCDataChannels: what one sends, the other receives. */
function channelPair() {
    const make = (): FakeChannel => {
        const listeners = new Map<string, Set<(e: MessageEvent) => void>>();
        return {
            readyState: 'open',
            onmessage: null,
            peer: null,
            addEventListener(type: string, fn: (e: MessageEvent) => void) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type)!.add(fn);
            },
            removeEventListener(type: string, fn: (e: MessageEvent) => void) {
                listeners.get(type)?.delete(fn);
            },
            send(data: string) {
                const ev = new MessageEvent('message', { data });
                queueMicrotask(() => {
                    this.peer!.onmessage?.(ev);
                    this.peer!.deliver(ev);
                });
            },
            deliver(ev: MessageEvent) {
                listeners.get('message')?.forEach(fn => fn(ev));
            },
        };
    };
    const a = make();
    const b = make();
    a.peer = b;
    b.peer = a;
    return [a, b] as const;
}

describe('the real client against the real server', () => {
    let grant: GrantedRoot | null = GRANT;

    beforeEach(() => {
        grant = GRANT;
        vi.resetModules();
    });

    async function rig(files: Record<string, string>) {
        const [controllerEnd, hostEnd] = channelPair();
        const { provider, store } = memProvider(files);
        attachFilesServer(hostEnd as unknown as RTCDataChannel, () => grant, provider);

        // The client reads the channel off the session snapshot.
        vi.doMock('../api/devices/session', () => ({
            activeSessions: () => [{ id: 'loop-test', filesChannel: controllerEnd }],
        }));
        const client = await import('../api/devices/fileTransfer');
        return { client, store };
    }

    it('lists, downloads and uploads end-to-end, ids and all', async () => {
        const content = 'The quick brown fox jumps over the lazy dog'.repeat(1000); // ~43 KB > 2 chunks
        const { client, store } = await rig({ [`${ROOT}/pic.bin`]: b64(content) });

        expect(await client.listRoots('loop-test')).toEqual([ROOT]);

        const { entries } = await client.listDir('loop-test', ROOT);
        expect(entries.map(e => e.name)).toEqual(['pic.bin']);

        const got: string[] = [];
        const n = await client.downloadFileTo(
            'loop-test', `${ROOT}/pic.bin`, content.length,
            b => { got.push(String.fromCharCode(...b)); },
        );
        expect(n).toBe(content.length);
        expect(got.join('')).toBe(content);

        const up = 'UPLOADED'.repeat(3000); // ~24 KB, crosses a chunk boundary
        const file = {
            size: up.length,
            slice(s: number, e: number) {
                const part = up.slice(s, e);
                return { arrayBuffer: async () => Uint8Array.from(part, c => c.charCodeAt(0)).buffer };
            },
        } as unknown as Blob;
        await client.uploadFile('loop-test', `${ROOT}/up.bin`, file);
        expect(atob(store.get(`${ROOT}/up.bin`)!)).toBe(up);
    });

    it('the real client pages a 10,000-entry folder through listDir cursors', async () => {
        const { client } = await rig(bigFolder(10_000, i => `photo-${String(i).padStart(5, '0')}.jpg`));
        const names = new Set<string>();
        let page = await client.listDir('loop-test', `${ROOT}/big`);
        page.entries.forEach(e => names.add(e.name));
        let pages = 1;
        while (page.next !== null) {
            expect(pages++).toBeLessThan(100);
            page = await client.listDir('loop-test', `${ROOT}/big`, page.next);
            page.entries.forEach(e => names.add(e.name));
        }
        expect(pages).toBeGreaterThan(1);
        expect(names.size).toBe(10_000);
        expect(page.truncated).toBe(false);
    });

    it('revocation mid-session takes effect on the next request', async () => {
        const { client } = await rig({ [`${ROOT}/a.txt`]: b64('x') });
        expect(await client.listRoots('loop-test')).toEqual([ROOT]);
        grant = null;
        await expect(client.listDir('loop-test', ROOT)).rejects.toThrow('not been allowed');
    });

    it('answers malformed JSON with an error frame instead of dying', async () => {
        const [controllerEnd, hostEnd] = channelPair();
        const { provider } = memProvider();
        attachFilesServer(hostEnd as unknown as RTCDataChannel, () => grant, provider);

        const replies: string[] = [];
        controllerEnd.addEventListener('message', e => replies.push(String(e.data)));
        hostEnd.deliver(new MessageEvent('message', { data: '{not json' }));
        // attachFilesServer answers via hostEnd.onmessage — drive it directly.
        hostEnd.onmessage?.(new MessageEvent('message', { data: '{not json' }));
        await new Promise(r => setTimeout(r, 0));
        expect(replies.some(r => r.includes('unparseable')), replies.join('|')).toBe(true);
    });
});
