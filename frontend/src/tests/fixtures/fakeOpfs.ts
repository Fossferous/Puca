/**
 * An in-memory origin-private file system with the calls api/cipherStore.ts
 * makes (jsdom has none), and Web Locks to go with it. The real one, on a
 * real disk: e2e/plaintext-disk-real-browser.mjs.
 */
export class FakeFileHandle {
    readonly kind = 'file';
    data = new Uint8Array(0);
    readonly name: string;
    constructor(name: string) { this.name = name; }
    async createWritable() {
        const parts: Uint8Array[] = [];
        return {
            write: async (d: Uint8Array) => { parts.push(new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))); },
            close: async () => {
                const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
                let o = 0;
                for (const p of parts) { out.set(p, o); o += p.length; }
                this.data = out;
            },
        };
    }
    async getFile() {
        const d = this.data;
        return { size: d.length, arrayBuffer: async () => d.slice().buffer } as unknown as File;
    }
}

export class FakeDir {
    readonly kind = 'directory';
    entries = new Map<string, FakeDir | FakeFileHandle>();
    readonly name: string;
    constructor(name: string) { this.name = name; }
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
        let d = this.entries.get(n);
        if (!d) { if (!o?.create) throw new DOMException('no such directory', 'NotFoundError'); d = new FakeDir(n); this.entries.set(n, d); }
        return d as FakeDir;
    }
    async getFileHandle(n: string, o?: { create?: boolean }) {
        let f = this.entries.get(n);
        if (!f) { if (!o?.create) throw new DOMException('no such file', 'NotFoundError'); f = new FakeFileHandle(n); this.entries.set(n, f); }
        return f as FakeFileHandle;
    }
    async removeEntry(n: string) {
        if (!this.entries.delete(n)) throw new DOMException('no such entry', 'NotFoundError');
    }
    async *keys() { for (const k of [...this.entries.keys()]) yield k; }
}

/** `navigator.storage` and `navigator.locks` over a fresh tree; `held` is
 *  the names of the locks held now. */
export function fakeOpfsNavigator(): { root: FakeDir; held: Set<string>; navigator: Pick<Navigator, 'storage' | 'locks'> } {
    const root = new FakeDir('');
    const held = new Set<string>();
    const nav = {
        storage: { getDirectory: async () => root },
        locks: {
            request: (name: string, cb: () => Promise<void>) => { held.add(name); return cb().then(() => { held.delete(name); }); },
            query: async () => ({ held: [...held].map((name) => ({ name })) }),
        },
    } as unknown as Pick<Navigator, 'storage' | 'locks'>;
    return { root, held, navigator: nav };
}

/** The attachment cache's directories under `root`, and the files in one. */
export const cacheDirOf = (root: FakeDir) => root.entries.get('puca-attachment-cache') as FakeDir | undefined;
export const sessionDirsOf = (root: FakeDir) => [...(cacheDirOf(root)?.entries.keys() ?? [])];
export const filesInOf = (root: FakeDir, name: string) => [...((cacheDirOf(root)?.entries.get(name) as FakeDir | undefined)?.entries.values() ?? [])] as FakeFileHandle[];
