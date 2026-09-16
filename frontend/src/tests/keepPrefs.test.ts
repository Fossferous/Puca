// Unit tests for the device-local Keep store (colour / labels / archived /
// view). The global test setup replaces localStorage with vi.fn() stubs that
// STORE NOTHING, so a test that only asserted "no throw" would pass against
// a store that never persisted — these give the stubs a real backing map and
// assert on what lands in it.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

let uid: number | null = 42;
vi.mock('../api/auth', () => ({
    currentUserIdFromToken: () => uid,
}));

const {
    parseKeepPrefs, dedupeLabels, getKeepPrefs, subscribeKeepPrefs, invalidateKeepPrefs,
    setNoteColor, setNoteLabels, setNoteArchived, setKeepView, renameLabel, pruneKeepPrefs,
    EMPTY_KEEP_PREFS,
} = await import('../keep/model/keepPrefs');

const backing = new Map<string, string>();

beforeEach(() => {
    backing.clear();
    uid = 42;
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { backing.set(k, v); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { backing.delete(k); });
    invalidateKeepPrefs();
});

describe('parseKeepPrefs', () => {
    it('degrades every malformed shape to the empty prefs', () => {
        expect(parseKeepPrefs(null)).toBe(EMPTY_KEEP_PREFS);
        expect(parseKeepPrefs('')).toBe(EMPTY_KEEP_PREFS);
        expect(parseKeepPrefs('nope {')).toBe(EMPTY_KEEP_PREFS);
        expect(parseKeepPrefs('[]')).toBe(EMPTY_KEEP_PREFS);
        expect(parseKeepPrefs('"str"')).toBe(EMPTY_KEEP_PREFS);
    });

    it('keeps only well-formed entries', () => {
        const raw = JSON.stringify({
            colors: { 'list:1': 'mint', 'list:2': 'neon', 'list:3': 'default', 'bogus': 'mint', 'channel:4': 'coral' },
            labels: { 'list:1': ['Home', ' home ', 'Work', 7, ''], 'list:9': [], 'x': ['a'] },
            archived: { 'list:1': true, 'list:2': 'yes', 'channel:5': true },
            view: 'list',
            extra: 'ignored',
        });
        expect(parseKeepPrefs(raw)).toEqual({
            colors: { 'list:1': 'mint', 'channel:4': 'coral' },
            labels: { 'list:1': ['Home', 'Work'] },
            archived: { 'list:1': true, 'channel:5': true },
            view: 'list',
            sort: 'puca',
        });
    });

    it('defaults an unknown view to grid and an unknown sort to puca', () => {
        expect(parseKeepPrefs('{"view":"carousel","sort":"random"}')).toMatchObject({ view: 'grid', sort: 'puca' });
        expect(parseKeepPrefs('{"sort":"created"}').sort).toBe('created');
    });
});

describe('dedupeLabels', () => {
    it('normalises, dedupes case-insensitively keeping the first spelling, caps at 8', () => {
        expect(dedupeLabels(['  Home ', 'HOME', 'work', '', '   ', 'Work'])).toEqual(['Home', 'work']);
        expect(dedupeLabels(Array.from({ length: 12 }, (_, i) => `l${i}`))).toHaveLength(8);
    });
});

describe('the live store', () => {
    it('writes under a per-account key and reads back a stable snapshot', () => {
        setNoteColor('list:1', 'sage');
        expect([...backing.keys()]).toEqual(['pucaKeepPrefs:42']);
        const a = getKeepPrefs();
        const b = getKeepPrefs();
        expect(a).toBe(b);
        expect(a.colors).toEqual({ 'list:1': 'sage' });
        // Re-read from storage (as a fresh page would) sees the same thing.
        invalidateKeepPrefs();
        expect(getKeepPrefs().colors).toEqual({ 'list:1': 'sage' });
    });

    it('a different account sees nothing of the first', () => {
        setNoteLabels('list:1', ['Secret']);
        uid = 7;
        expect(getKeepPrefs().labels).toEqual({});
        setNoteArchived('list:1', true);
        expect(backing.get('pucaKeepPrefs:7')).toContain('archived');
        expect(JSON.parse(backing.get('pucaKeepPrefs:42')!).archived).toEqual({});
    });

    it('signed out: reads are empty and writes drop', () => {
        uid = null;
        setNoteColor('list:1', 'mint');
        expect(backing.size).toBe(0);
        expect(getKeepPrefs()).toBe(EMPTY_KEEP_PREFS);
    });

    it('default colour and empty labels REMOVE the entry rather than storing it', () => {
        setNoteColor('list:1', 'mint');
        setNoteColor('list:1', 'default');
        setNoteLabels('list:2', ['a']);
        setNoteLabels('list:2', ['  ']);
        setNoteArchived('list:3', true);
        setNoteArchived('list:3', false);
        expect(JSON.parse(backing.get('pucaKeepPrefs:42')!)).toEqual({ colors: {}, labels: {}, archived: {}, view: 'grid', sort: 'puca' });
    });

    it('notifies subscribers on every write and on invalidation, not on reads', () => {
        const cb = vi.fn();
        const off = subscribeKeepPrefs(cb);
        getKeepPrefs();
        expect(cb).not.toHaveBeenCalled();
        setKeepView('list');
        expect(cb).toHaveBeenCalledTimes(1);
        setKeepView('list');   // unchanged → still a write call, still notifies (cheap, idempotent)
        invalidateKeepPrefs();
        expect(cb).toHaveBeenCalledTimes(3);
        off();
        setKeepView('grid');
        expect(cb).toHaveBeenCalledTimes(3);
        expect(getKeepPrefs().view).toBe('grid');
    });

    it('renameLabel rewrites every use, merges duplicates, and an empty name deletes', () => {
        setNoteLabels('list:1', ['Home', 'Work']);
        setNoteLabels('list:2', ['home']);
        setNoteLabels('list:3', ['Work', 'House']);
        renameLabel('home', 'House');
        expect(getKeepPrefs().labels).toEqual({ 'list:1': ['House', 'Work'], 'list:2': ['House'], 'list:3': ['Work', 'House'] });
        renameLabel('work', '');
        expect(getKeepPrefs().labels).toEqual({ 'list:1': ['House'], 'list:2': ['House'], 'list:3': ['House'] });
    });

    it('pruneKeepPrefs forgets notes that are gone and is a no-op otherwise', () => {
        setNoteColor('list:1', 'mint');
        setNoteLabels('list:2', ['x']);
        setNoteArchived('channel:3', true);
        const before = getKeepPrefs();
        pruneKeepPrefs(new Set(['list:1', 'list:2', 'channel:3']));
        expect(getKeepPrefs()).toBe(before);   // untouched: no write, same object
        pruneKeepPrefs(new Set(['list:2']));
        expect(getKeepPrefs()).toEqual({ colors: {}, labels: { 'list:2': ['x'] }, archived: {}, view: 'grid', sort: 'puca' });
    });
});
