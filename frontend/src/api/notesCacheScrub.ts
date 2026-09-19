/**
 * The names of Púca Notes' on-device databases (one per account), and the
 * sign-out scrub that deletes them.
 *
 * In the api layer, with no imports, because logout() has to call it from
 * EITHER page: a sign-out in the Púca tab must remove what the Notes tab
 * cached, and auth.ts must not import Notes. The databases hold decrypted
 * note content sealed under a key derived from the account's seed
 * (api/e2ee.ts sealLocal), so the seed's removal already retires them
 * cryptographically; deleting them is the second half of the same promise.
 */

export const NOTES_CACHE_DB_PREFIX = 'pucaNotesCache:';
/** localStorage list of the database names ever opened on this browser —
 *  `indexedDB.databases()` is not available everywhere. */
export const NOTES_CACHE_INDEX = 'pucaNotesCacheDbs';

function readIndex(): string[] {
    try {
        const raw = localStorage.getItem(NOTES_CACHE_INDEX);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.startsWith(NOTES_CACHE_DB_PREFIX)) : [];
    } catch {
        return [];
    }
}

function writeIndex(names: string[]): void {
    try {
        if (names.length === 0) localStorage.removeItem(NOTES_CACHE_INDEX);
        else localStorage.setItem(NOTES_CACHE_INDEX, JSON.stringify(names));
    } catch { /* private mode */ }
}

export function notesCacheDbName(sub: number): string {
    return `${NOTES_CACHE_DB_PREFIX}${sub}`;
}

/** Remember that this database exists, so a sign-out can find it. */
export function registerNotesCacheDb(name: string): void {
    const names = readIndex();
    if (!names.includes(name)) writeIndex([...names, name]);
}

/**
 * Delete every Notes database on this browser, or every one but `keep`
 * (a sign-in as a different account). Fire-and-forget: an open connection in
 * another tab closes itself on `versionchange` and the delete then completes.
 */
export function deleteNotesCaches(keep?: string): void {
    if (typeof indexedDB === 'undefined') return;
    const names = new Set(readIndex());
    const done = () => {
        for (const n of names) {
            if (n === keep) continue;
            try { indexedDB.deleteDatabase(n); } catch { /* blocked / private mode */ }
        }
        writeIndex(keep && names.has(keep) ? [keep] : []);
    };
    const list = (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof list === 'function') {
        list.call(indexedDB)
            .then(dbs => { for (const d of dbs) if (d.name?.startsWith(NOTES_CACHE_DB_PREFIX)) names.add(d.name); })
            .catch(() => { /* fall back to the index */ })
            .finally(done);
    } else {
        done();
    }
}
