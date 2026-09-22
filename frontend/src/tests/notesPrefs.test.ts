// Unit tests for the Notes prefs store (colour / labels / archived / the four
// reminder times / view). The global test setup replaces localStorage with vi.fn() stubs that
// STORE NOTHING, so a test that only asserted "no throw" would pass against
// a store that never persisted — these give the stubs a real backing map and
// assert on what lands in it.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

let uid: number | null = 42;
vi.mock('../api/auth', () => ({
    currentUserIdFromToken: () => uid,
}));

const {
    parseNotesPrefs, dedupeLabels, getNotesPrefs, subscribeNotesPrefs, invalidateNotesPrefs,
    setNoteColor, setNoteLabels, setNoteArchived, setNotesView, setReminderTimes, renameLabel, pruneNotesPrefs,
    EMPTY_KEEP_PREFS,
} = await import('../notes/model/notesPrefs');
import { DEFAULT_REMINDER_TIMES } from '../api/reminderTimes';

const backing = new Map<string, string>();

beforeEach(() => {
    backing.clear();
    uid = 42;
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { backing.set(k, v); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { backing.delete(k); });
    invalidateNotesPrefs();
});

describe('parseNotesPrefs', () => {
    it('degrades every malformed shape to the empty prefs', () => {
        expect(parseNotesPrefs(null)).toBe(EMPTY_KEEP_PREFS);
        expect(parseNotesPrefs('')).toBe(EMPTY_KEEP_PREFS);
        expect(parseNotesPrefs('nope {')).toBe(EMPTY_KEEP_PREFS);
        expect(parseNotesPrefs('[]')).toBe(EMPTY_KEEP_PREFS);
        expect(parseNotesPrefs('"str"')).toBe(EMPTY_KEEP_PREFS);
    });

    it('keeps only well-formed entries', () => {
        const raw = JSON.stringify({
            colors: { 'list:1': 'mint', 'list:2': 'neon', 'list:3': 'default', 'bogus': 'mint', 'channel:4': 'coral' },
            labels: { 'list:1': ['Home', ' home ', 'Work', 7, ''], 'list:9': [], 'x': ['a'] },
            archived: { 'list:1': true, 'list:2': 'yes', 'channel:5': true },
            view: 'list',
            extra: 'ignored',
        });
        expect(parseNotesPrefs(raw)).toEqual({
            colors: { 'list:1': 'mint', 'channel:4': 'coral' },
            labels: { 'list:1': ['Home', 'Work'] },
            archived: { 'list:1': true, 'channel:5': true },
            times: DEFAULT_REMINDER_TIMES,
            view: 'list',
            sort: 'puca',
        });
    });

    it('defaults an unknown view to grid and an unknown sort to puca', () => {
        expect(parseNotesPrefs('{"view":"carousel","sort":"random"}')).toMatchObject({ view: 'grid', sort: 'puca' });
        expect(parseNotesPrefs('{"sort":"created"}').sort).toBe('created');
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
        expect([...backing.keys()]).toEqual(['pucaNotesPrefs:42']);
        const a = getNotesPrefs();
        const b = getNotesPrefs();
        expect(a).toBe(b);
        expect(a.colors).toEqual({ 'list:1': 'sage' });
        // Re-read from storage (as a fresh page would) sees the same thing.
        invalidateNotesPrefs();
        expect(getNotesPrefs().colors).toEqual({ 'list:1': 'sage' });
    });

    it('a different account sees nothing of the first', () => {
        setNoteLabels('list:1', ['Secret']);
        uid = 7;
        expect(getNotesPrefs().labels).toEqual({});
        setNoteArchived('list:1', true);
        expect(backing.get('pucaNotesPrefs:7')).toContain('archived');
        expect(JSON.parse(backing.get('pucaNotesPrefs:42')!).archived).toEqual({});
    });

    it('signed out: reads are empty and writes drop', () => {
        uid = null;
        setNoteColor('list:1', 'mint');
        expect(backing.size).toBe(0);
        expect(getNotesPrefs()).toBe(EMPTY_KEEP_PREFS);
    });

    it('default colour and empty labels REMOVE the entry rather than storing it', () => {
        setNoteColor('list:1', 'mint');
        setNoteColor('list:1', 'default');
        setNoteLabels('list:2', ['a']);
        setNoteLabels('list:2', ['  ']);
        setNoteArchived('list:3', true);
        setNoteArchived('list:3', false);
        expect(JSON.parse(backing.get('pucaNotesPrefs:42')!)).toEqual({ colors: {}, labels: {}, archived: {}, times: DEFAULT_REMINDER_TIMES, view: 'grid', sort: 'puca' });
    });

    it('notifies subscribers on every write and on invalidation, not on reads', () => {
        const cb = vi.fn();
        const off = subscribeNotesPrefs(cb);
        getNotesPrefs();
        expect(cb).not.toHaveBeenCalled();
        setNotesView('list');
        expect(cb).toHaveBeenCalledTimes(1);
        setNotesView('list');   // unchanged → still a write call, still notifies (cheap, idempotent)
        invalidateNotesPrefs();
        expect(cb).toHaveBeenCalledTimes(3);
        off();
        setNotesView('grid');
        expect(cb).toHaveBeenCalledTimes(3);
        expect(getNotesPrefs().view).toBe('grid');
    });

    it('renameLabel rewrites every use, merges duplicates, and an empty name deletes', () => {
        setNoteLabels('list:1', ['Home', 'Work']);
        setNoteLabels('list:2', ['home']);
        setNoteLabels('list:3', ['Work', 'House']);
        renameLabel('home', 'House');
        expect(getNotesPrefs().labels).toEqual({ 'list:1': ['House', 'Work'], 'list:2': ['House'], 'list:3': ['Work', 'House'] });
        renameLabel('work', '');
        expect(getNotesPrefs().labels).toEqual({ 'list:1': ['House'], 'list:2': ['House'], 'list:3': ['House'] });
    });

    it('renameLabel is ONE write, however many notes carry the label', () => {
        setNoteLabels('list:1', ['Home']);
        setNoteLabels('list:2', ['Home']);
        setNoteLabels('list:3', ['Home']);
        (localStorage.setItem as Mock).mockClear();
        renameLabel('Home', 'House');
        // A per-note loop would be three writes — and three interleaving
        // pushes, one of which could lose a 409 replay (notesPrefsSync.ts).
        expect((localStorage.setItem as Mock).mock.calls.length).toBe(1);
    });

    it('renameLabel rewrites a pure respelling (same name, different case)', () => {
        setNoteLabels('list:1', ['home']);
        setNoteLabels('list:2', ['HOME']);
        renameLabel('home', 'Home');
        expect(getNotesPrefs().labels).toEqual({ 'list:1': ['Home'], 'list:2': ['Home'] });
    });

    it('a rename keeps the label in its own slot and never drops one at the cap', () => {
        // MAX_LABELS_PER_NOTE is 8: a saturated note must come out with 8.
        setNoteLabels('list:1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
        renameLabel('c', 'zzz');
        expect(getNotesPrefs().labels['list:1']).toEqual(['a', 'b', 'zzz', 'd', 'e', 'f', 'g', 'h']);
    });

    it('merging onto a label the note already carries leaves ONE entry, in the first slot', () => {
        setNoteLabels('list:1', ['Work', 'Home']);
        renameLabel('Home', 'Work');
        expect(getNotesPrefs().labels['list:1']).toEqual(['Work']);
    });

    it('pruneNotesPrefs forgets notes that are gone and is a no-op otherwise', () => {
        setNoteColor('list:1', 'mint');
        setNoteLabels('list:2', ['x']);
        setNoteArchived('channel:3', true);
        const before = getNotesPrefs();
        pruneNotesPrefs(new Set(['list:1', 'list:2', 'channel:3']));
        expect(getNotesPrefs()).toBe(before);   // untouched: no write, same object
        pruneNotesPrefs(new Set(['list:2']));
        expect(getNotesPrefs()).toEqual({ colors: {}, labels: { 'list:2': ['x'] }, archived: {}, times: DEFAULT_REMINDER_TIMES, view: 'grid', sort: 'puca' });
    });
});

// The four reminder times live in the same store and the same sealed document
// (notesPrefsSync.ts). A malformed one must fall back to ITS OWN default, not
// take the store down or leave a bad value where a preset will read it.
describe('reminder times', () => {
    it('parses per field and falls back to the default for anything that is not HH:mm', () => {
        const raw = JSON.stringify({ times: { morning: '07:30', afternoon: '25:00', evening: '9:00', default: 7 } });
        expect(parseNotesPrefs(raw).times).toEqual({
            morning: '07:30', afternoon: DEFAULT_REMINDER_TIMES.afternoon,
            evening: DEFAULT_REMINDER_TIMES.evening, default: DEFAULT_REMINDER_TIMES.default,
        });
        // Positive control: a whole valid object round-trips untouched.
        const good = { morning: '06:15', afternoon: '13:45', evening: '21:00', default: '08:00' };
        expect(parseNotesPrefs(JSON.stringify({ times: good })).times).toEqual(good);
    });

    it('a store with no times at all reads as the defaults', () => {
        expect(parseNotesPrefs(JSON.stringify({ colors: {} })).times).toEqual(DEFAULT_REMINDER_TIMES);
        expect(getNotesPrefs().times).toEqual(DEFAULT_REMINDER_TIMES);
    });

    it('setReminderTimes writes through to storage and notifies', () => {
        const cb = vi.fn();
        const off = subscribeNotesPrefs(cb);
        setReminderTimes({ morning: '07:30' });
        expect(JSON.parse(backing.get('pucaNotesPrefs:42')!).times).toEqual({ ...DEFAULT_REMINDER_TIMES, morning: '07:30' });
        expect(getNotesPrefs().times.morning).toBe('07:30');
        expect(cb).toHaveBeenCalledTimes(1);
        off();
    });

    it('ignores a half-typed or impossible value rather than storing it', () => {
        setReminderTimes({ morning: '07:30' });
        const before = getNotesPrefs();
        setReminderTimes({ morning: '' });        // <input type="time"> mid-edit
        setReminderTimes({ evening: '24:00' });
        expect(getNotesPrefs()).toBe(before);     // no write at all: same object
        expect(getNotesPrefs().times.morning).toBe('07:30');
    });
});
