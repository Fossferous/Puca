/**
 * A search result must say WHERE it matched — including when the card cannot
 * show the thing that matched.
 *
 * `previewRows` folds every COMPLETED item away and caps open items at eight,
 * and a schedule's place is drawn as a bare pin icon with no text at all. So a
 * card could match "Butter", "Dublin" or the ninth item and render nothing
 * whatsoever to explain itself. Each of those has a test here, and each has a
 * positive control (the same word in a row the card DOES show), so none of
 * them can pass by rendering nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NoteCard } from '../notes/components/NoteCard';
import { buildNoteCards, type NoteSource } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import type { NoteActions } from '../notes/model/notesQueries';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';
import { type Task } from '../api/tasks';

const task = (id: number, o: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `item ${id}`, is_completed: false,
    position: id, created_at: '2026-09-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...o,
});

const actions = { togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(source: Partial<NoteSource>, tasks: Task[], query?: string) {
    const full: NoteSource = { ref: { kind: 'list', id: 7 }, title: 'Shopping', ...source };
    const card = buildNoteCards([full], new Map([['list:7', tasks]]), [], EMPTY_KEEP_PREFS)[0];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteCard
                card={card}
                actions={actions}
                now={Date.parse('2026-09-21T10:00:00Z')}
                compactTools={false}
                onOpen={() => {}}
                onMenu={() => {}}
                onPickColor={() => {}}
                onPickLabels={() => {}}
                onLabelClick={() => {}}
                onArchive={() => {}}
                registerEl={() => {}}
                query={query}
            />,
        );
    });
}

const marks = () => [...document.querySelectorAll('mark.notes-hl')].map(m => m.textContent);
const foundRows = () => [...document.querySelectorAll('.notes-card-found-row')].map(r => r.textContent ?? '');

afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('search highlighting on a card', () => {
    it('marks the title and the items it shows', () => {
        render({ title: 'Bread and butter' }, [task(1, { description: 'Sliced bread' })], 'bread');
        expect(marks()).toEqual(['Bread', 'bread']);
    });

    it('POSITIVE CONTROL: no query, no marks at all', () => {
        render({ title: 'Bread and butter' }, [task(1, { description: 'Sliced bread' })]);
        expect(marks()).toEqual([]);
        expect(foundRows()).toEqual([]);
    });

    it('marks accented text the search matched without one (no shifted offsets)', () => {
        render({ title: 'Café run' }, [task(1, { description: 'Crème brûlée' })], 'cafe creme');
        expect(marks()).toEqual(['Café', 'Crème']);
    });

    it('a match on a TICKED item is reported — the card never renders those rows', () => {
        render({}, [
            task(1, { description: 'Milk' }),
            task(2, { description: 'Butter', is_completed: true }),
        ], 'butter');
        // previewRows drops completed rows, so nothing in the item list says why.
        expect([...document.querySelectorAll('.notes-card-item-text')].map(e => e.textContent)).toEqual(['Milk']);
        expect(foundRows().length).toBe(1);
        expect(foundRows()[0]).toContain('ticked');
        expect(foundRows()[0]).toContain('Butter');
        expect(marks()).toEqual(['Butter']);
    });

    it('POSITIVE CONTROL: the same word on an OPEN item is shown in place, not reported', () => {
        render({}, [task(1, { description: 'Butter' })], 'butter');
        expect(foundRows()).toEqual([]);
        expect(marks()).toEqual(['Butter']);
    });

    it('a match on an item past the eighth is reported', () => {
        const items = [];
        for (let i = 1; i <= 8; i++) items.push(task(i, { description: `thing ${i}` }));
        items.push(task(9, { description: 'Butter last' }));
        render({}, items, 'butter');
        expect(document.querySelectorAll('.notes-card-item').length).toBe(8);
        expect(foundRows().length).toBe(1);
        expect(foundRows()[0]).toContain('further down');
        expect(foundRows()[0]).toContain('Butter last');
    });

    it('a match on a place is reported — the schedule chip draws a pin with no text', () => {
        const schedule = JSON.stringify({
            v: 1, kind: 'event', uid: 'u1', allDay: true, start: '2026-10-01', location: 'Dublin',
        });
        render({}, [task(1, { description: 'Catch the ferry', schedule })], 'dublin');
        expect(document.body.textContent).not.toContain('Catch the ferryDublin');
        expect(foundRows().length).toBe(1);
        expect(foundRows()[0]).toContain('a place');
        expect(marks()).toEqual(['Dublin']);
    });

    it('a match deep in a long note gets a snippet around it, not the first lines', () => {
        const body = 'opening words. ' + 'filler '.repeat(4_000) + 'the needle is here';
        render({ body }, [], 'needle');
        const shown = document.querySelector('.notes-card-body')!.textContent ?? '';
        expect(shown).toContain('needle');
        expect(shown).not.toContain('opening words');   // the window MOVED
        expect(shown.length).toBeLessThan(1_000);
        expect(marks()).toEqual(['needle']);
    });

    it('POSITIVE CONTROL: a match near the top leaves the text where it was', () => {
        const body = 'the needle is at the front. ' + 'filler '.repeat(4_000);
        render({ body }, [], 'needle');
        const shown = document.querySelector('.notes-card-body')!.textContent ?? '';
        expect(shown.startsWith('the needle is at the front.')).toBe(true);
    });

    it('never marks a decrypt-failure marker, in the title, the text or an item', () => {
        render(
            { title: TASK_DECRYPT_FAILED, body: TASK_DECRYPT_FAILED },
            [task(1, { description: TASK_DECRYPT_FAILED })],
            'decrypt unable',
        );
        expect(marks()).toEqual([]);
        expect(foundRows()).toEqual([]);
        // ...and the control: the same words, readable, ARE marked.
        act(() => { root?.unmount(); });
        host?.remove();
        render({ title: 'Unable to decrypt the backup' }, [], 'decrypt unable');
        expect(marks().join('|')).toContain('decrypt');
    });
});
