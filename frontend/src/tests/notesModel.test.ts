// Unit tests for the Púca Notes note model: the pure functions that turn
// lists + tasks + Púca's tab prefs + the device-local Notes prefs into cards,
// previews, search results and reminder groups. Every ordering/pin rule is
// delegated to api/tasks.ts, so these tests pin the DELEGATION (a favourited
// tab is a pinned card, the saved order is the card order) rather than
// re-testing those helpers.
import { describe, it, expect } from 'vitest';
import type { Task, TaskTabPref } from '../api/tasks';
import {
    buildNoteCards, filterNotes, splitPinned, searchNotes, noteMatches, previewRows,
    nearestDue, groupReminders, reminderBadgeCount, deriveQuickTitle, cleanQuickItems,
    allLabels, noteKey, parseNoteKey, normalizeLabel, normalizeForSearch, isNoteColor,
    moveNoteInOrder, applyVisibleOrder,
    countProgress, noteRoute, isLabelRoute, labelFromPath, MAX_LABEL_LENGTH, QUICK_TITLE_FROM_ITEM_LENGTH,
    type NoteSource, type NoteCard, type NotesNoteState,
} from '../notes/model/notesModel';

function task(id: number, overrides: Partial<Task> = {}): Task {
    return {
        id,
        channel_id: null,
        list_id: 1,
        parent_id: null,
        description: `task ${id}`,
        is_completed: false,
        position: id,
        created_at: '2026-09-01T10:00:00Z',
        created_by: 1,
        attachments: null,
        due_at: null,
        ...overrides,
    };
}

function source(kind: 'list' | 'channel', id: number, title: string, extra: Partial<NoteSource> = {}): NoteSource {
    return { ref: { kind, id }, title, ...extra };
}

const NO_LOCAL: NotesNoteState = { colors: {}, labels: {}, archived: {} };

function cards(
    sources: NoteSource[],
    tasks: Record<string, Task[]> = {},
    prefs: TaskTabPref[] = [],
    local: NotesNoteState = NO_LOCAL,
): NoteCard[] {
    return buildNoteCards(sources, new Map(Object.entries(tasks)), prefs, local);
}

describe('noteKey / parseNoteKey', () => {
    it('uses the Tasks-view tab key so prefs line up with Púca', () => {
        expect(noteKey({ kind: 'list', id: 7 })).toBe('list:7');
        expect(noteKey({ kind: 'channel', id: 12 })).toBe('channel:12');
    });

    it('round-trips and rejects junk', () => {
        expect(parseNoteKey('list:7')).toEqual({ kind: 'list', id: 7 });
        expect(parseNoteKey('channel:12')).toEqual({ kind: 'channel', id: 12 });
        expect(parseNoteKey('server:1')).toBeNull();
        expect(parseNoteKey('list:0')).toBeNull();
        expect(parseNoteKey('list:-3')).toBeNull();
        expect(parseNoteKey('list:1.5')).toBeNull();
        expect(parseNoteKey('')).toBeNull();
    });

    it('routes by kind and id', () => {
        expect(noteRoute({ kind: 'list', id: 3 })).toBe('/n/list/3');
    });
});

describe('buildNoteCards', () => {
    it('keeps the natural order with no prefs and reads progress from the list row until tasks load', () => {
        const out = cards([
            source('list', 1, 'Groceries', { totalTasks: 4, completedTasks: 1 }),
            source('channel', 9, 'sprint', { serverName: 'Work' }),
        ]);
        expect(out.map(c => c.key)).toEqual(['list:1', 'channel:9']);
        expect(out[0]).toMatchObject({ tasks: null, total: 4, completed: 1, pinned: false, color: 'default', labels: [], archived: false });
        expect(out[1]).toMatchObject({ serverName: 'Work', total: 0, completed: 0 });
    });

    it('follows the saved tab order and marks favourites as pinned (delegated to api/tasks)', () => {
        const prefs: TaskTabPref[] = [
            { kind: 'channel', ref_id: 9, is_favorite: true },
            { kind: 'list', ref_id: 2, is_favorite: false },
        ];
        const out = cards([source('list', 1, 'a'), source('list', 2, 'b'), source('channel', 9, 'c')], {}, prefs);
        expect(out.map(c => c.key)).toEqual(['channel:9', 'list:2', 'list:1']);
        expect(out.map(c => c.pinned)).toEqual([true, false, false]);
    });

    it('counts progress from loaded tasks, overriding the row counts', () => {
        const out = cards(
            [source('list', 1, 'a', { totalTasks: 99, completedTasks: 99 })],
            { 'list:1': [task(1), task(2, { is_completed: true }), task(3, { parent_id: 1 })] },
        );
        expect(out[0].total).toBe(3);
        expect(out[0].completed).toBe(1);
    });

    it('applies the device-local colour, labels and archived flag by key', () => {
        const local: NotesNoteState = {
            colors: { 'list:1': 'mint' },
            labels: { 'list:1': ['Home', 'Errands'] },
            archived: { 'channel:9': true },
        };
        const out = cards([source('list', 1, 'a'), source('channel', 9, 'c')], {}, [], local);
        expect(out[0]).toMatchObject({ color: 'mint', labels: ['Home', 'Errands'], archived: false });
        expect(out[1]).toMatchObject({ color: 'default', labels: [], archived: true });
    });
});

describe('filterNotes / splitPinned', () => {
    const local: NotesNoteState = {
        colors: {},
        labels: { 'list:1': ['Home'], 'list:3': ['home'] },
        archived: { 'list:2': true, 'list:3': true },
    };
    const all = cards(
        [source('list', 1, 'Groceries'), source('list', 2, 'Old'), source('list', 3, 'Older')],
        { 'list:1': [task(1, { description: 'milk' })], 'list:2': [task(2, { description: 'milk bottle' })] },
        [{ kind: 'list', ref_id: 2, is_favorite: true }],
        local,
    );

    it('all hides archived; archive shows only archived', () => {
        expect(filterNotes(all, { kind: 'all' }).map(c => c.key)).toEqual(['list:1']);
        expect(filterNotes(all, { kind: 'archive' }).map(c => c.key)).toEqual(['list:2', 'list:3']);
    });

    it('label view matches case-insensitively and still hides archived', () => {
        expect(filterNotes(all, { kind: 'label', label: 'HOME' }).map(c => c.key)).toEqual(['list:1']);
    });

    it('search looks everywhere, archived included', () => {
        expect(filterNotes(all, { kind: 'search', query: 'milk' }).map(c => c.key)).toEqual(['list:2', 'list:1']);
        // An empty query is the plain notes view.
        expect(filterNotes(all, { kind: 'search', query: '   ' }).map(c => c.key)).toEqual(['list:1']);
    });

    it('splitPinned keeps order within each half', () => {
        const { pinned, others } = splitPinned(all);
        expect(pinned.map(c => c.key)).toEqual(['list:2']);
        expect(others.map(c => c.key)).toEqual(['list:1', 'list:3']);
    });
});

describe('search', () => {
    const c = cards(
        [source('list', 1, 'Trip to Zürich', { serverName: undefined }), source('channel', 2, 'sprint', { serverName: 'Acme Work' })],
        { 'list:1': [task(1, { description: 'Book the Hotel' }), task(2, { description: 'pack   socks' })] },
        [], { colors: {}, labels: { 'list:1': ['Travel'] }, archived: {} },
    );

    it('normalises case, accents and whitespace', () => {
        expect(normalizeForSearch('  Zürich  Hotel ')).toBe('zurich hotel');
        expect(noteMatches(c[0], 'ZURICH')).toBe(true);
        expect(noteMatches(c[0], 'hotel book')).toBe(true);     // every term, any order
        expect(noteMatches(c[0], 'pack socks')).toBe(true);     // internal whitespace collapsed
        expect(noteMatches(c[0], 'hotel tent')).toBe(false);    // one term missing
    });

    it('matches labels and server names too', () => {
        expect(searchNotes(c, 'travel').map(x => x.key)).toEqual(['list:1']);
        expect(searchNotes(c, 'acme').map(x => x.key)).toEqual(['channel:2']);
    });

    it('a note whose tasks have not loaded still matches on its title', () => {
        expect(searchNotes(c, 'sprint').map(x => x.key)).toEqual(['channel:2']);
    });

    it('a voice note is found by its TRANSCRIPT, because the transcript is note text', () => {
        const withTranscript = cards([source('list', 9, 'Voice note', { body: 'milk and bread from the corner shop' })]);
        expect(noteMatches(withTranscript[0], 'bread')).toBe(true);
        expect(noteMatches(withTranscript[0], 'corner shop')).toBe(true);
    });

    it('a voice note with NO transcript is NOT findable by its clip name — recorded on purpose', () => {
        // noteMatches builds its haystack from title, body, server name, labels
        // and items; attachment names are not in it, which is exactly why the
        // transcript has to land in the note's TEXT. If someone later makes
        // attachment names searchable, this case is the one to come and change.
        const silent = cards([source('list', 10, 'Voice note', { noteAttachments: JSON.stringify([{ href: 'enc:x', name: 'voice-1.webm' }]) })]);
        expect(noteMatches(silent[0], 'voice')).toBe(true);      // positive control: the TITLE matches
        expect(noteMatches(silent[0], 'webm')).toBe(false);
        expect(noteMatches(silent[0], 'voice-1')).toBe(false);
    });
});

describe('previewRows', () => {
    it('lists open items in tree order with depth, folds completed away, caps the count', () => {
        const tasks = [
            task(1, { description: 'A' }),
            task(2, { description: 'A.1', parent_id: 1 }),
            task(3, { description: 'A.2 done', parent_id: 1, is_completed: true }),
            task(4, { description: 'B done', is_completed: true }),
            task(5, { description: 'C' }),
            task(6, { description: 'C.1', parent_id: 5 }),
            task(7, { description: 'C.1.a', parent_id: 6 }),
        ];
        const p = previewRows(tasks, 3);
        expect(p.rows.map(r => [r.task.description, r.depth])).toEqual([['A', 0], ['A.1', 1], ['C', 0]]);
        expect(p.moreOpen).toBe(2);           // C.1, C.1.a
        expect(p.completedCount).toBe(1);     // B (A.2 is nested — folded into A)
    });

    it('is empty for an empty list', () => {
        expect(previewRows([], 8)).toEqual({ rows: [], moreOpen: 0, completedCount: 0 });
    });
});

describe('due times', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    const iso = (offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString();

    it('nearestDue picks the earliest OPEN due task, overdue included', () => {
        const tasks = [
            task(1, { due_at: iso(60) }),
            task(2, { due_at: iso(-30) }),
            task(3, { due_at: iso(-120), is_completed: true }),
            task(4),
        ];
        expect(nearestDue(tasks)?.id).toBe(2);
        expect(nearestDue([task(4)])).toBeNull();
    });

    it('groupReminders buckets overdue / today / upcoming, sorted soonest first, archived notes included', () => {
        const c = cards(
            [source('list', 1, 'a'), source('list', 2, 'b')],
            {
                'list:1': [
                    task(1, { due_at: iso(-5) }),
                    task(2, { due_at: iso(5) }),
                    task(3, { due_at: iso(60 * 24 * 3) }),
                    task(4, { due_at: iso(-60), is_completed: true }),
                ],
                'list:2': [task(5, { due_at: iso(-60) })],
            },
            [],
            { colors: {}, labels: {}, archived: { 'list:2': true } },
        );
        const g = groupReminders(c, now);
        expect(g.overdue.map(i => i.task.id)).toEqual([5, 1]);
        expect(g.overdue[0].note.key).toBe('list:2');
        expect(g.today.map(i => i.task.id)).toEqual([2]);
        expect(g.upcoming.map(i => i.task.id)).toEqual([3]);
        expect(reminderBadgeCount(g)).toBe(3);
    });

    it('a due time just before local midnight is "today", one after is "upcoming"', () => {
        const local = new Date(2026, 8, 16, 12, 0, 0).getTime();
        const endOfDay = new Date(2026, 8, 16, 23, 59, 0).toISOString();
        const nextDay = new Date(2026, 8, 17, 0, 1, 0).toISOString();
        const c = cards([source('list', 1, 'a')], { 'list:1': [task(1, { due_at: endOfDay }), task(2, { due_at: nextDay })] });
        const g = groupReminders(c, local);
        expect(g.today.map(i => i.task.id)).toEqual([1]);
        expect(g.upcoming.map(i => i.task.id)).toEqual([2]);
    });
});

describe('quick add', () => {
    it('uses the typed title when there is one', () => {
        expect(deriveQuickTitle('  Weekend   plans ', ['x'])).toBe('Weekend plans');
    });

    it('borrows the first non-blank item, truncated with an ellipsis', () => {
        expect(deriveQuickTitle('', ['  ', 'Buy milk'])).toBe('Buy milk');
        const long = 'x'.repeat(QUICK_TITLE_FROM_ITEM_LENGTH + 20);
        const t = deriveQuickTitle('', [long]);
        expect(t.length).toBeLessThanOrEqual(QUICK_TITLE_FROM_ITEM_LENGTH);
        expect(t.endsWith('…')).toBe(true);
    });

    it('falls back to "Untitled note" and cleans items', () => {
        expect(deriveQuickTitle('', [])).toBe('Untitled note');
        expect(cleanQuickItems(['  a  b ', '', '   ', 'c'])).toEqual(['a b', 'c']);
    });
});

describe('note order', () => {
    // The FULL order the prefs hold, with two notes the current view hides
    // (archived, filtered out, or in the trash) sitting between visible ones.
    const full = ['list:1', 'list:H1', 'list:2', 'list:3', 'list:H2', 'list:4', 'list:5'];
    const vis = ['list:1', 'list:2', 'list:3', 'list:4', 'list:5'];
    /** What the visible notes ended up as, in order. */
    const visibleOf = (order: string[] | null) => (order === null ? null : order.filter(k => vis.includes(k)));

    it('moves a note to the top, up, down and to the BOTTOM', () => {
        expect(visibleOf(moveNoteInOrder(full, vis, 'list:4', 'top'))).toEqual(['list:4', 'list:1', 'list:2', 'list:3', 'list:5']);
        expect(visibleOf(moveNoteInOrder(full, vis, 'list:4', 'up'))).toEqual(['list:1', 'list:2', 'list:4', 'list:3', 'list:5']);
        expect(visibleOf(moveNoteInOrder(full, vis, 'list:2', 'down'))).toEqual(['list:1', 'list:3', 'list:2', 'list:4', 'list:5']);
        // The branch the menu could not reach until 'Move to bottom' existed.
        expect(visibleOf(moveNoteInOrder(full, vis, 'list:2', 'bottom'))).toEqual(['list:1', 'list:3', 'list:4', 'list:5', 'list:2']);
    });

    it('a hidden note keeps its EXACT index, whichever move is made', () => {
        for (const target of ['top', 'up', 'down', 'bottom'] as const) {
            const next = moveNoteInOrder(full, vis, 'list:4', target);
            expect(next).not.toBeNull();
            expect(next!.indexOf('list:H1')).toBe(1);
            expect(next!.indexOf('list:H2')).toBe(4);
            expect(next!.length).toBe(full.length);
        }
    });

    it('a move that changes nothing returns null (no needless full-replace PUT)', () => {
        expect(moveNoteInOrder(full, vis, 'list:1', 'top')).toBeNull();
        expect(moveNoteInOrder(full, vis, 'list:1', 'up')).toBeNull();
        expect(moveNoteInOrder(full, vis, 'list:5', 'down')).toBeNull();
        expect(moveNoteInOrder(full, vis, 'list:5', 'bottom')).toBeNull();
        expect(moveNoteInOrder(full, vis, 'list:nope', 'top')).toBeNull();
    });

    it('applyVisibleOrder splices a dragged order back, hidden notes in place', () => {
        const next = applyVisibleOrder(full, vis, ['list:5', 'list:1', 'list:2', 'list:3', 'list:4']);
        expect(next).toEqual(['list:5', 'list:H1', 'list:1', 'list:2', 'list:H2', 'list:3', 'list:4']);
    });

    it('applyVisibleOrder refuses anything that is not a rearrangement', () => {
        expect(applyVisibleOrder(full, vis, vis)).toBeNull();                                  // identity
        expect(applyVisibleOrder(full, vis, ['list:1', 'list:2', 'list:3', 'list:4'])).toBeNull();   // one dropped
        expect(applyVisibleOrder(full, vis, ['list:1', 'list:1', 'list:2', 'list:3', 'list:4'])).toBeNull();   // duplicated
        // A key the view has but the prefs do not (a note created a moment
        // ago elsewhere): saving would drop a real note from Puca's tab bar.
        expect(applyVisibleOrder(full, vis, ['list:9', 'list:2', 'list:3', 'list:4', 'list:5'])).toBeNull();
        // ...and a hidden key smuggled into the visible set is not visible.
        expect(applyVisibleOrder(full, vis, ['list:H1', 'list:2', 'list:3', 'list:4', 'list:5'])).toBeNull();
    });
});

describe('labels and colours', () => {
    it('normalizeLabel trims, collapses and caps; blank becomes null', () => {
        expect(normalizeLabel('  Home   office ')).toBe('Home office');
        expect(normalizeLabel('   ')).toBeNull();
        expect(normalizeLabel('y'.repeat(MAX_LABEL_LENGTH + 5))?.length).toBe(MAX_LABEL_LENGTH);
    });

    it('allLabels dedupes case-insensitively (first spelling wins) and sorts', () => {
        const c = cards([source('list', 1, 'a'), source('list', 2, 'b')], {}, [], {
            colors: {}, labels: { 'list:1': ['Work', 'home'], 'list:2': ['HOME', 'Errands'] }, archived: {},
        });
        expect(allLabels(c)).toEqual(['Errands', 'home', 'Work']);
    });

    it('isNoteColor accepts only the palette', () => {
        expect(isNoteColor('mint')).toBe(true);
        expect(isNoteColor('default')).toBe(true);
        expect(isNoteColor('#fff')).toBe(false);
        expect(isNoteColor(3)).toBe(false);
    });

    it('countProgress', () => {
        expect(countProgress([task(1), task(2, { is_completed: true })])).toEqual({ total: 2, completed: 1 });
    });
});

/**
 * "Which label am I looking at" is a question about the ROUTE. The grid's
 * NoteFilter cannot answer it: the moment the search box has text the filter
 * is kind 'search', even though the URL is still that label's — which is how
 * a rename made with a search active left the user on a dead route.
 */
describe('the label a route names', () => {
    it('reads the label out of the path, percent-decoded', () => {
        expect(labelFromPath('/label/Errands')).toBe('Errands');
        expect(labelFromPath(`/label/${encodeURIComponent('Work & home')}`)).toBe('Work & home');
        expect(labelFromPath(`/label/${encodeURIComponent('a/b')}`)).toBe('a/b');
        // A malformed escape (a truncated address) must not throw: it runs in
        // the filter's render, where a throw is the crash screen. The raw
        // segment comes back, which names no label. POSITIVE CONTROL: the
        // same escape really is malformed for decodeURIComponent.
        expect(() => decodeURIComponent('%E0%A4%A')).toThrow();
        expect(labelFromPath('/label/%E0%A4%A')).toBe('%E0%A4%A');
    });

    it('is null for every route that is not a label', () => {
        for (const p of ['/', '/archive', '/trash', '/reminders', '/calendar', '/label/']) {
            expect(labelFromPath(p), p).toBeNull();
        }
    });

    it('matches a label case-insensitively, as the label manager does', () => {
        expect(isLabelRoute('/label/Errands', 'errands')).toBe(true);
        expect(isLabelRoute('/label/errands', 'ERRANDS')).toBe(true);
        expect(isLabelRoute('/label/Errands', 'Work')).toBe(false);
        expect(isLabelRoute('/archive', 'Errands')).toBe(false);
    });
});
