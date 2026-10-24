/**
 * The slice of IndexedDB that api/webPush.ts and public/sw.js use — open,
 * createObjectStore on upgrade, get / put / delete, transaction completion —
 * in memory and asynchronous like the real thing. Both sides of the push
 * config are tested against the SAME instance, so a key or store name that
 * drifts between the page and the worker fails a test.
 */
type Req = {
    result?: unknown;
    error?: unknown;
    onsuccess?: () => void;
    onerror?: () => void;
    onupgradeneeded?: () => void;
};

export interface FakeIndexedDb {
    open(name: string, version?: number): Req;
    /** db name -> store name -> key -> value */
    data: Map<string, Map<string, Map<unknown, unknown>>>;
}

export function makeFakeIndexedDb(): FakeIndexedDb {
    const data = new Map<string, Map<string, Map<unknown, unknown>>>();
    const later = (fn: () => void) => setTimeout(fn, 0);
    return {
        data,
        open(name: string) {
            const req: Req = {};
            later(() => {
                const fresh = !data.has(name);
                if (fresh) data.set(name, new Map());
                const stores = data.get(name)!;
                const db = {
                    createObjectStore(s: string) {
                        stores.set(s, new Map());
                    },
                    close() {},
                    transaction(s: string) {
                        const store = stores.get(s);
                        if (!store) throw new Error(`no object store ${s}`);
                        const tx: { oncomplete?: () => void; onerror?: () => void; error?: unknown; objectStore: () => unknown } = {
                            objectStore: () => ({
                                get(k: unknown) {
                                    const r: Req = {};
                                    later(() => {
                                        r.result = store.get(k);
                                        r.onsuccess?.();
                                    });
                                    return r;
                                },
                                put(v: unknown, k: unknown) {
                                    store.set(k, structuredClone(v));
                                },
                                delete(k: unknown) {
                                    store.delete(k);
                                },
                            }),
                        };
                        later(() => later(() => tx.oncomplete?.()));
                        return tx;
                    },
                };
                req.result = db;
                if (fresh) req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        },
    };
}
