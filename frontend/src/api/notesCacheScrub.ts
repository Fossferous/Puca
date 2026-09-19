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

// --- What a sign-out would lose ---------------------------------------------------------

/**
 * Púca Notes keeps two things on this browser that may not have reached the
 * server yet: queued offline edits (the outbox) and colours/labels/archive
 * not yet in the account's sealed document. A sign-out deletes both. Notes'
 * own sign-out asks first; this flag lets PÚCA's sign-out ask too, since a
 * sign-out in either tab scrubs what Notes kept. Notes writes it whenever
 * either count changes and clears it once both are synced; it holds counts
 * only, never content, and is scrubbed with the rest at sign-out.
 */
export const NOTES_UNSYNCED_PREFIX = 'pucaNotesUnsynced:';

export interface NotesUnsynced { ops: number; prefs: boolean }

export function writeNotesUnsynced(uid: number, u: NotesUnsynced): void {
    try {
        if (u.ops <= 0 && !u.prefs) localStorage.removeItem(`${NOTES_UNSYNCED_PREFIX}${uid}`);
        else localStorage.setItem(`${NOTES_UNSYNCED_PREFIX}${uid}`, JSON.stringify({ ops: Math.max(0, Math.floor(u.ops)), prefs: u.prefs }));
    } catch { /* private mode */ }
}

export function readNotesUnsynced(uid: number | null): NotesUnsynced {
    if (uid === null) return { ops: 0, prefs: false };
    try {
        const raw = localStorage.getItem(`${NOTES_UNSYNCED_PREFIX}${uid}`);
        const o = raw ? JSON.parse(raw) as Partial<NotesUnsynced> : {};
        return { ops: typeof o.ops === 'number' && o.ops > 0 ? Math.floor(o.ops) : 0, prefs: o.prefs === true };
    } catch {
        return { ops: 0, prefs: false };
    }
}

/** The sign-out question, or null when nothing would be lost. */
export function notesSignOutWarning(u: NotesUnsynced): string | null {
    const parts: string[] = [];
    if (u.ops > 0) parts.push(`${u.ops} change${u.ops === 1 ? '' : 's'} made offline`);
    if (u.prefs) parts.push('colours, labels or archive changes');
    if (parts.length === 0) return null;
    return `Púca Notes has ${parts.join(' and ')} on this device that ${u.ops === 1 && !u.prefs ? 'has' : 'have'} not synced yet. Signing out deletes them. Sign out anyway?`;
}
