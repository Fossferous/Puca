/**
 * A sign-out never silently deletes what Púca Notes has not synced yet.
 *
 * Notes' own sign-out pushes colours/labels one last time and then asks
 * (NotesApp.tsx). Púca's sign-out deletes the same things (logout() scrubs
 * them from either tab), so Notes publishes the counts to a flag Púca's
 * sign-out reads (api/notesCacheScrub.ts). These pin the flag, the question
 * and the scrub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    NOTES_UNSYNCED_PREFIX, notesSignOutWarning, readNotesUnsynced, writeNotesUnsynced,
} from '../api/notesCacheScrub';
import { logout } from '../api/auth';

const store: Record<string, string> = {};
function useBackingStore(initial: Record<string, string>) {
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, initial);
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
}

describe('the unsynced flag and the sign-out question', () => {
    beforeEach(() => { vi.clearAllMocks(); useBackingStore({}); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('says nothing when nothing would be lost', () => {
        expect(notesSignOutWarning({ ops: 0, prefs: false })).toBeNull();
    });

    it('names unsynced colours/labels, queued edits, or both', () => {
        expect(notesSignOutWarning({ ops: 0, prefs: true })).toMatch(/colours, labels or archive/);
        expect(notesSignOutWarning({ ops: 1, prefs: false })).toMatch(/1 change made offline .* has not synced/);
        const both = notesSignOutWarning({ ops: 3, prefs: true })!;
        expect(both).toMatch(/3 changes made offline and colours/);
        expect(both).toMatch(/Sign out anyway\?$/);
    });

    it('is per account, and cleared once both are synced', () => {
        writeNotesUnsynced(5, { ops: 2, prefs: true });
        expect(readNotesUnsynced(5)).toEqual({ ops: 2, prefs: true });
        expect(readNotesUnsynced(6)).toEqual({ ops: 0, prefs: false });   // another account on this browser
        expect(readNotesUnsynced(null)).toEqual({ ops: 0, prefs: false });
        writeNotesUnsynced(5, { ops: 0, prefs: false });
        expect(store[`${NOTES_UNSYNCED_PREFIX}5`]).toBeUndefined();
        store[`${NOTES_UNSYNCED_PREFIX}5`] = 'not json';
        expect(readNotesUnsynced(5)).toEqual({ ops: 0, prefs: false });
    });

    it('goes with the sign-out it warned about (counts only, but still per-account state)', () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
        writeNotesUnsynced(5, { ops: 1, prefs: false });
        store.auth_token = 'x.y.z';
        // logout() enumerates storage with Object.keys(localStorage); the
        // setup file's mock is a plain object, so expose the key on it.
        const key = `${NOTES_UNSYNCED_PREFIX}5`;
        const ls = window.localStorage as unknown as Record<string, unknown>;
        ls[key] = store[key];
        try {
            logout();
        } finally {
            delete ls[key];
        }
        expect(window.localStorage.removeItem).toHaveBeenCalledWith(key);
        expect(store[key]).toBeUndefined();
    });
});
