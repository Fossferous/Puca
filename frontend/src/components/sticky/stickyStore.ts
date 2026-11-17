/**
 * Which notes are out on the desktop as sticky notes, on this device, for
 * this account (docs/STICKY_NOTES.md). Kept in local storage as note KEYS
 * only (`list:12`, `channel:5`) under `pucaStickyOpen:<user>` — never a
 * title or a word of a note — so the notes come back when Púca starts.
 * Signing out removes it (api/auth.ts clears every `pucaSticky` key).
 *
 * An entry has its own id (`wid`), apart from the note it shows, because the
 * note can change under it while its window stays: a new sticky note is a
 * draft (`new:<n>`, never stored) until its first words make the note, and a
 * note made offline has a temporary id until it is saved. The window follows
 * the entry, not the key.
 *
 * Also the one door to "make a new sticky note": the global shortcut and the
 * tray can ask before the layer that draws the windows exists (Notes mounts
 * on the first ask), so a request waits here until it does.
 */

import type { NoteColor } from '../../notes/model/notesModel';

/** The colour a new sticky note starts with: Microsoft's yellow. */
export const NEW_STICKY_COLOR: NoteColor = 'sand';

export interface StickyEntry {
    /** This window's own id, stable for its life. */
    wid: number;
    /** The note it shows: a Notes key, or `new:<wid>` for a draft. */
    key: string;
    /** Take the focus when its window opens (not a note reopened at start). */
    focus: boolean;
    /**
     * `draft`: a new sticky note nobody has typed in. `made`: this window
     * made its note (or the note's key moved) and the note may not be in
     * Notes' lists yet — its window stays as it is meanwhile. `note`: a note
     * Notes has; its window opens only once Notes has the note, and closes
     * when Notes no longer does.
     */
    state: 'draft' | 'made' | 'note';
}

const STORE_PREFIX = 'pucaStickyOpen:';

let userId: number | null = null;
let entries: StickyEntry[] = [];
let nextWid = 1;
let pendingNew = 0;
let layerAttached = false;
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) l();
}

function persist(): void {
    if (userId === null) return;
    const keys = entries.map(e => e.key).filter(k => !k.startsWith('new:'));
    try {
        if (keys.length === 0) localStorage.removeItem(STORE_PREFIX + userId);
        else localStorage.setItem(STORE_PREFIX + userId, JSON.stringify(keys));
    } catch { /* storage blocked: the notes just will not come back */ }
}

function isNoteKey(k: unknown): k is string {
    return typeof k === 'string' && /^(list:-?[1-9]\d{0,15}|channel:[1-9]\d{0,15})$/.test(k);
}

/** The keys this account had open last time, from storage. */
export function readStoredStickies(uid: number): string[] {
    try {
        const raw = localStorage.getItem(STORE_PREFIX + uid);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return [...new Set(parsed.filter(isNoteKey))];
    } catch {
        return [];
    }
}

/**
 * Load this account's open notes, once per account. `reopen` false starts
 * with none (Settings › Reopen sticky notes when Púca starts) and forgets the
 * stored set, so turning the setting back on does not bring back notes from
 * long ago.
 */
export function attachAccount(uid: number, reopen: boolean): void {
    if (userId === uid) return;
    userId = uid;
    entries = reopen
        ? readStoredStickies(uid).map(key => ({ wid: nextWid++, key, focus: false, state: 'note' as const }))
        : [];
    if (!reopen) persist();
    emit();
}

/** The account went (sign-out, expiry): its windows go, its stored set stays
 *  for a sign-out to scrub. */
export function detachAccount(): void {
    userId = null;
    entries = [];
    pendingNew = 0;
    emit();
}

export function stickyEntries(): readonly StickyEntry[] {
    return entries;
}

export function subscribeStickies(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Put a note out as a sticky note; one already out is answered as it is. */
export function openStickyNote(key: string): StickyEntry {
    const have = entries.find(e => e.key === key);
    if (have) return have;
    const e: StickyEntry = { wid: nextWid++, key, focus: true, state: 'note' };
    entries = [...entries, e];
    persist();
    emit();
    return e;
}

/** A new sticky note: a draft window, nothing saved until it is typed in. */
export function newStickyDraft(): StickyEntry {
    const wid = nextWid++;
    const e: StickyEntry = { wid, key: `new:${wid}`, focus: true, state: 'draft' };
    entries = [...entries, e];
    emit();
    return e;
}

/** Ask for a new sticky note from outside the layer (shortcut, tray, Ctrl+N
 *  in another window). Made at once if the layer is up, else when it comes. */
export function requestNewSticky(): void {
    if (layerAttached && userId !== null) newStickyDraft();
    else pendingNew++;
}

/** The layer is drawing the windows: anything asked for meanwhile is made. */
export function attachLayer(): () => void {
    layerAttached = true;
    while (pendingNew > 0 && userId !== null) { pendingNew--; newStickyDraft(); }
    pendingNew = 0;
    return () => { layerAttached = false; };
}

/**
 * The window went without anyone closing it — the shell destroyed it with
 * its page (a reload, Púca quitting, the main window going). Off the screen
 * here, but still in the stored set, so it comes back at the next start. A
 * person closing it is `closeSticky`, which the shell's close request, the X
 * and Ctrl+W lead to.
 */
export function stickyWindowGone(wid: number): void {
    const before = entries.length;
    entries = entries.filter(e => e.wid !== wid);
    if (entries.length !== before) emit();
}

export function closeSticky(wid: number): void {
    const before = entries.length;
    entries = entries.filter(e => e.wid !== wid);
    if (entries.length === before) return;
    persist();
    emit();
}

/** The note an entry shows got another key: a draft saved, or a note made
 *  offline now on the server. */
export function rekeySticky(wid: number, key: string): void {
    // Already out under that key in another window: this one closes.
    if (entries.some(e => e.wid !== wid && e.key === key)) { closeSticky(wid); return; }
    let changed = false;
    entries = entries.map(e => {
        if (e.wid !== wid || e.key === key) return e;
        changed = true;
        return { ...e, key, state: 'made' as const };
    });
    if (!changed) return;
    persist();
    emit();
}

/** A note moved key everywhere (Notes' outbox replayed an offline create). */
export function noteKeyMoved(from: string, to: string): void {
    const e = entries.find(x => x.key === from);
    if (e) rekeySticky(e.wid, to);
}

/** A `made` note Notes now has becomes an ordinary one. */
export function promoteMade(isPresent: (key: string) => boolean): void {
    if (!entries.some(e => e.state === 'made' && isPresent(e.key))) return;
    entries = entries.map(e => (e.state === 'made' && isPresent(e.key) ? { ...e, state: 'note' as const } : e));
    emit();
}

/** The notes out on the desktop, by key (what a prune weighs). A `made`
 *  note is weighed too: one that is real appears in the next fresh fetch and
 *  is never struck twice, and one deleted before Notes caught up with it
 *  would otherwise keep a window that can save nothing, for good. */
export function stickyNoteKeys(): Set<string> {
    return new Set(entries.filter(e => e.state !== 'draft').map(e => e.key));
}

/**
 * Take these notes off the desktop for good: Notes has gone without them
 * across fresh fetches (StickyNotesLayer, notesPrune.ts) — deleted, trashed,
 * their server left. Their windows were already off the screen.
 */
export function forgetStickies(keys: readonly string[]): void {
    const gone = new Set(keys);
    const keep = entries.filter(e => !(e.state !== 'draft' && gone.has(e.key)));
    if (keep.length === entries.length) return;
    entries = keep;
    persist();
    emit();
}

export function __resetStickiesForTests(): void {
    userId = null;
    entries = [];
    nextWid = 1;
    pendingNew = 0;
    layerAttached = false;
    listeners.clear();
}
