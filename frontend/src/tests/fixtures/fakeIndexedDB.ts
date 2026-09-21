/**
 * A very small in-memory IndexedDB, enough for notes/model/notesCache.ts.
 *
 * jsdom has no IndexedDB, and the thing worth testing here is the SCHEMA
 * UPGRADE: a database written by a shipped 0.9.816 at version 1 must open at
 * version 2 with its cached queries and its queued offline edits intact. A
 * shim is the only way to hold a version-1 fixture in a test — and it is
 * deliberately tiny: `open` with a version and `onupgradeneeded`,
 * `objectStoreNames`, `createObjectStore`, and get/put/delete/getAll/
 * getAllKeys on a transaction.
 *
 * NOT a general IndexedDB: no indexes, no cursors, no real transaction
 * isolation, and every request settles on a microtask.
 */

type Store = Map<IDBValidKey, unknown>;

interface Db {
    version: number;
    stores: Map<string, Store>;
}

const settle = <T>(result: T, req: FakeRequest<T>) => {
    queueMicrotask(() => {
        req.result = result;
        req.onsuccess?.(new Event('success') as Event);
    });
};

class FakeRequest<T> {
    result!: T;
    error: DOMException | null = null;
    onsuccess: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
}

class FakeObjectStore {
    constructor(private readonly store: Store) {}
    get(key: IDBValidKey) {
        const r = new FakeRequest<unknown>();
        settle(this.store.get(key), r);
        return r as unknown as IDBRequest<unknown>;
    }
    put(value: unknown, key: IDBValidKey) {
        const r = new FakeRequest<IDBValidKey>();
        this.store.set(key, value);
        settle(key, r);
        return r as unknown as IDBRequest<IDBValidKey>;
    }
    delete(key: IDBValidKey) {
        const r = new FakeRequest<undefined>();
        this.store.delete(key);
        settle(undefined, r);
        return r as unknown as IDBRequest<undefined>;
    }
    getAll() {
        const r = new FakeRequest<unknown[]>();
        settle([...this.store.values()], r);
        return r as unknown as IDBRequest<unknown[]>;
    }
    getAllKeys() {
        const r = new FakeRequest<IDBValidKey[]>();
        settle([...this.store.keys()], r);
        return r as unknown as IDBRequest<IDBValidKey[]>;
    }
}

class FakeTransaction {
    constructor(private readonly db: Db) {}
    objectStore(name: string) {
        const s = this.db.stores.get(name);
        if (!s) throw new DOMException(`no object store ${name}`, 'NotFoundError');
        return new FakeObjectStore(s) as unknown as IDBObjectStore;
    }
}

class FakeDatabase {
    onversionchange: (() => void) | null = null;
    constructor(private readonly db: Db) {}
    get version() { return this.db.version; }
    get objectStoreNames() {
        const names = [...this.db.stores.keys()];
        return { contains: (n: string) => names.includes(n), length: names.length } as unknown as DOMStringList;
    }
    createObjectStore(name: string) {
        const s: Store = new Map();
        this.db.stores.set(name, s);
        return new FakeObjectStore(s) as unknown as IDBObjectStore;
    }
    transaction(name: string) {
        if (!this.db.stores.has(name)) throw new DOMException(`no object store ${name}`, 'NotFoundError');
        return new FakeTransaction(this.db) as unknown as IDBTransaction;
    }
    close() { /* nothing to release */ }
}

export interface FakeIDB {
    factory: IDBFactory;
    /** Create (or replace) a database at `version` with these stores and rows
     *  — the fixture a test upgrades FROM. */
    seed(name: string, version: number, rows: Record<string, Record<string, string>>): void;
    /** Everything a store holds now. */
    dump(name: string, store: string): Record<string, unknown>;
    storeNames(name: string): string[];
    version(name: string): number;
}

export function makeFakeIndexedDB(): FakeIDB {
    const dbs = new Map<string, Db>();

    const factory = {
        open(name: string, version?: number) {
            const req = new FakeRequest<IDBDatabase>() as FakeRequest<IDBDatabase> & {
                onupgradeneeded: ((ev: Event) => void) | null;
                onblocked: ((ev: Event) => void) | null;
            };
            req.onupgradeneeded = null;
            req.onblocked = null;
            queueMicrotask(() => {
                let db = dbs.get(name);
                if (!db) {
                    db = { version: 0, stores: new Map() };
                    dbs.set(name, db);
                }
                const wanted = version ?? Math.max(1, db.version);
                const handle = new FakeDatabase(db) as unknown as IDBDatabase;
                req.result = handle;
                if (wanted > db.version) {
                    db.version = wanted;
                    req.onupgradeneeded?.(new Event('upgradeneeded'));
                }
                req.onsuccess?.(new Event('success'));
            });
            return req as unknown as IDBOpenDBRequest;
        },
        deleteDatabase(name: string) {
            const req = new FakeRequest<undefined>();
            dbs.delete(name);
            settle(undefined, req);
            return req as unknown as IDBOpenDBRequest;
        },
    } as unknown as IDBFactory;

    return {
        factory,
        seed(name, version, rows) {
            const stores = new Map<string, Store>();
            for (const [store, entries] of Object.entries(rows)) {
                const s: Store = new Map();
                for (const [k, v] of Object.entries(entries)) s.set(k, v);
                stores.set(store, s);
            }
            dbs.set(name, { version, stores });
        },
        dump(name, store) {
            const s = dbs.get(name)?.stores.get(store);
            return s ? Object.fromEntries(s.entries()) as Record<string, unknown> : {};
        },
        storeNames(name) {
            return [...(dbs.get(name)?.stores.keys() ?? [])];
        },
        version(name) {
            return dbs.get(name)?.version ?? 0;
        },
    };
}
