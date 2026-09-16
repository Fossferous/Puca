/**
 * Púca Keep — the device-local note state: colour, labels, archived, and
 * the grid/list view choice.
 *
 * WHY DEVICE-LOCAL. Keep is a presentation of Púca's task data, and the ask
 * was that the INFORMATION and FUNCTIONALITY be what persists — the pin and
 * the card order already live server-side as Púca's own tab prefs
 * (task_tab_prefs), and the items, due times and attachments are the tasks
 * themselves. A card's tint, its labels and whether it is tucked into the
 * archive have no home in that schema, and inventing one means a migration
 * and a backend ship to both hosts. So they live here, in localStorage, the
 * same way saved places do (api/taskPlaces.ts) — and the honest cost is the
 * same: they do not follow the account to another device. The store is
 * shaped so a sealed-to-self server blob could replace it later without the
 * UI noticing.
 *
 * NAMESPACED PER ACCOUNT, deliberately, like taskPlaces: the key carries the
 * user id, so on a shared browser user B never sees user A's labels, and a
 * signed-out page reads empty and drops writes.
 *
 * One module-level snapshot, replaced on every write and re-read when another
 * tab (Púca in the next tab, say) writes the same key, so React can subscribe
 * with useSyncExternalStore and get a referentially stable object between
 * writes.
 */
import { currentUserIdFromToken } from '../../api/auth';
import { isNoteColor, normalizeLabel, type KeepNoteState, type NoteColor, MAX_LABELS_PER_NOTE } from './keepModel';

export type KeepViewMode = 'grid' | 'list';
/** `puca` = the saved tab order Púca's Tasks view uses (pins lead); the
 *  others are display-only sorts and disable the Move actions. */
export type KeepSortMode = 'puca' | 'title' | 'created';

export interface KeepPrefs extends KeepNoteState {
    view: KeepViewMode;
    sort: KeepSortMode;
}

const STORAGE_PREFIX = 'pucaKeepPrefs';

export const EMPTY_KEEP_PREFS: KeepPrefs = Object.freeze({
    colors: {},
    labels: {},
    archived: {},
    view: 'grid',
    sort: 'puca',
}) as KeepPrefs;

function storageKey(uid: string): string {
    return `${STORAGE_PREFIX}:${uid}`;
}

function currentUid(): string | null {
    const id = currentUserIdFromToken();
    return id === null ? null : String(id);
}

const NOTE_KEY = /^(list|channel):\d+$/;

/**
 * Parse a stored blob, degrading every malformed part to nothing rather than
 * throwing — a corrupt entry must not take the whole grid down. Exported for
 * tests (same discipline as parseStoredPlaces).
 */
export function parseKeepPrefs(raw: string | null): KeepPrefs {
    if (!raw) return EMPTY_KEEP_PREFS;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return EMPTY_KEEP_PREFS;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_KEEP_PREFS;
    const o = parsed as Record<string, unknown>;

    const colors: Record<string, NoteColor> = {};
    if (typeof o.colors === 'object' && o.colors !== null) {
        for (const [k, v] of Object.entries(o.colors as Record<string, unknown>)) {
            if (NOTE_KEY.test(k) && isNoteColor(v) && v !== 'default') colors[k] = v;
        }
    }

    const labels: Record<string, string[]> = {};
    if (typeof o.labels === 'object' && o.labels !== null) {
        for (const [k, v] of Object.entries(o.labels as Record<string, unknown>)) {
            if (!NOTE_KEY.test(k) || !Array.isArray(v)) continue;
            const cleaned = dedupeLabels(v.filter((x): x is string => typeof x === 'string'));
            if (cleaned.length > 0) labels[k] = cleaned;
        }
    }

    const archived: Record<string, true> = {};
    if (typeof o.archived === 'object' && o.archived !== null) {
        for (const [k, v] of Object.entries(o.archived as Record<string, unknown>)) {
            if (NOTE_KEY.test(k) && v === true) archived[k] = true;
        }
    }

    const view: KeepViewMode = o.view === 'list' ? 'list' : 'grid';
    const sort: KeepSortMode = o.sort === 'title' || o.sort === 'created' ? o.sort : 'puca';
    return { colors, labels, archived, view, sort };
}

/** Normalise, drop blanks, dedupe case-insensitively (first spelling wins),
 *  cap the count. */
export function dedupeLabels(raw: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
        const l = normalizeLabel(r);
        if (l === null) continue;
        const k = l.toLocaleLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(l);
        if (out.length >= MAX_LABELS_PER_NOTE) break;
    }
    return out;
}

// --- The live snapshot -------------------------------------------------------

let cachedUid: string | null | undefined;   // undefined = never read
let cached: KeepPrefs = EMPTY_KEEP_PREFS;
const listeners = new Set<() => void>();

function readFromStorage(uid: string | null): KeepPrefs {
    if (uid === null) return EMPTY_KEEP_PREFS;
    try {
        return parseKeepPrefs(localStorage.getItem(storageKey(uid)));
    } catch {
        return EMPTY_KEEP_PREFS;
    }
}

/**
 * The current account's prefs. Referentially stable until a write (or a
 * cross-tab storage event) replaces it, which is what lets React subscribe
 * to it with useSyncExternalStore.
 */
export function getKeepPrefs(): KeepPrefs {
    const uid = currentUid();
    if (cachedUid === undefined || cachedUid !== uid) {
        cachedUid = uid;
        cached = readFromStorage(uid);
    }
    return cached;
}

export function subscribeKeepPrefs(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function notify(): void {
    for (const cb of listeners) cb();
}

/** Drop the cached snapshot so the next read hits storage. Called on the
 *  cross-tab `storage` event and on sign-out (the uid changes anyway, but a
 *  sign-in as the SAME user in another tab must also re-read). */
export function invalidateKeepPrefs(): void {
    cachedUid = undefined;
    notify();
}

function write(next: KeepPrefs): void {
    const uid = currentUid();
    if (uid === null) return;   // signed out: nothing to file it under
    cachedUid = uid;
    cached = next;
    try {
        localStorage.setItem(storageKey(uid), JSON.stringify(next));
    } catch {
        // storage full / private mode: the in-memory snapshot still applies
        // for this page's lifetime.
    }
    notify();
}

function update(fn: (p: KeepPrefs) => KeepPrefs): void {
    write(fn(getKeepPrefs()));
}

// --- Mutations ---------------------------------------------------------------

export function setNoteColor(key: string, color: NoteColor): void {
    update(p => {
        const colors = { ...p.colors };
        if (color === 'default') delete colors[key];
        else colors[key] = color;
        return { ...p, colors };
    });
}

export function setNoteLabels(key: string, raw: string[]): void {
    update(p => {
        const labels = { ...p.labels };
        const cleaned = dedupeLabels(raw);
        if (cleaned.length === 0) delete labels[key];
        else labels[key] = cleaned;
        return { ...p, labels };
    });
}

export function setNoteArchived(key: string, archived: boolean): void {
    update(p => {
        const next = { ...p.archived };
        if (archived) next[key] = true;
        else delete next[key];
        return { ...p, archived: next };
    });
}

export function setKeepView(view: KeepViewMode): void {
    update(p => (p.view === view ? p : { ...p, view }));
}

export function setKeepSort(sort: KeepSortMode): void {
    update(p => (p.sort === sort ? p : { ...p, sort }));
}

/** Rename a label everywhere it is used (case-insensitive match). An empty
 *  new name deletes the label from every note. */
export function renameLabel(from: string, to: string): void {
    const fromKey = from.toLocaleLowerCase();
    const next = normalizeLabel(to);
    update(p => {
        const labels: Record<string, string[]> = {};
        for (const [k, ls] of Object.entries(p.labels)) {
            const mapped = dedupeLabels(ls.map(l => (l.toLocaleLowerCase() === fromKey ? (next ?? '') : l)));
            if (mapped.length > 0) labels[k] = mapped;
        }
        return { ...p, labels };
    });
}

/**
 * Forget state for notes that no longer exist (deleted list, left server).
 * Called after every successful load with the keys that are live; a note
 * temporarily missing because one server's channel query failed is NOT
 * pruned — the caller only passes a complete set.
 */
export function pruneKeepPrefs(liveKeys: ReadonlySet<string>): void {
    const p = getKeepPrefs();
    const keep = (o: Record<string, unknown>) => Object.keys(o).some(k => !liveKeys.has(k));
    if (!keep(p.colors) && !keep(p.labels) && !keep(p.archived)) return;
    const filter = <T,>(o: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(o).filter(([k]) => liveKeys.has(k)));
    write({ ...p, colors: filter(p.colors), labels: filter(p.labels), archived: filter(p.archived) });
}

// Another tab (Púca, or a second Keep window) wrote our key: re-read so the
// next render reflects it. Guarded for non-DOM test environments.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', e => {
        if (e.key === null || e.key.startsWith(STORAGE_PREFIX)) invalidateKeepPrefs();
    });
}
