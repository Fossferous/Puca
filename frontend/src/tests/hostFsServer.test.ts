/**
 * The phone-side file server, tested against an in-memory filesystem — and,
 * at the end, against the REAL controller-side client over a paired fake
 * channel, because two ends that are each tested against an imagined peer
 * can drift apart while both stay green.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FS_MAX_LIST, handleFsRequest, attachFilesServer, type GrantedRoot } from '../api/devices/hostFsServer';
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

/** Paired in-memory RTCDataChannels: what one sends, the other receives. */
function channelPair() {
    const make = () => {
        const listeners = new Map<string, Set<(e: MessageEvent) => void>>();
        return {
            readyState: 'open' as const,
            onmessage: null as ((e: MessageEvent) => void) | null,
            peer: null as ReturnType<typeof make> | null,
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
