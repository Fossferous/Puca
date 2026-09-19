/**
 * Púca Notes — text notes, photo/drawing notes: the pure pieces. The
 * checklist ⇄ text conversions, the composer's title, the gallery's pairing
 * of a drawing with its strokes, the drawing file format (total parser), the
 * photo shrink rules, and what search, copy-as-text and the exports do with
 * a note's text.
 */
import { describe, it, expect } from 'vitest';
import { bodyToItems, itemsToBody, conversionLosses, describeLosses, deriveContentTitle, readableBody, recreationOrder } from '../notes/model/noteContent';
import { galleryItems, withoutItem, nextDrawingName, heroItems, slotsNeeded, DRAWING_STROKES_MIME } from '../api/noteMedia';
import { emptyDrawing, parseDrawing, serializeDrawing, toCanvasPoint, DRAWING_WIDTH, MAX_DRAWING_SIDE } from '../notes/model/drawing';
import { fitWithin, shouldShrink } from '../api/imagePrep';
import { buildNoteCards, noteMatches, type NoteSource } from '../notes/model/notesModel';
import { noteToMarkdown, notesToJson } from '../notes/model/noteText';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import { type Task } from '../api/tasks';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';

function task(id: number, o: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    };
}
const ref = (id: string, mime: string, name: string) => ({ href: `sovereign-enc:${id}?k=K&m=${encodeURIComponent(mime)}`, name });

describe('Show checkboxes: text → items', () => {
    it('one item per non-blank line, bullets and boxes dropped', () => {
        expect(bodyToItems('Milk\n\n  - Bread\n* Eggs\n• Tea\n[ ] Jam\n- [x] Done thing\r\nLast')).toEqual(
            ['Milk', 'Bread', 'Eggs', 'Tea', 'Jam', 'Done thing', 'Last'],
        );
        expect(bodyToItems('  \n\n')).toEqual([]);
    });
});

describe('Hide checkboxes: items → text', () => {
    const tasks = [
        task(1, { description: 'Groceries' }),
        task(2, { description: 'Milk', parent_id: 1 }),
        task(3, { description: 'Paid bills', is_completed: true }),
        task(4, { description: 'Call mum' }),
    ];

    it('open items first in tree order, nested ones indented, then the completed', () => {
        expect(itemsToBody(tasks)).toBe('Groceries\n  Milk\nCall mum\nPaid bills');
    });

    it('says what would be lost, and nothing when nothing is', () => {
        const withDue = [...tasks, task(5, { due_at: '2026-10-01T09:00:00Z', attachments: '[]' })];
        const l = conversionLosses(withDue);
        expect(l).toEqual({ nested: true, due: 1, attachments: 1, completed: 1, unreadable: 0 });
        expect(describeLosses(l)).toMatch(/nesting, 1 due time, the attachments on 1 item and which item is done/);
        expect(describeLosses(conversionLosses([task(1), task(2)]))).toBeNull();
    });

    it('flags unreadable items, which must block the conversion', () => {
        expect(conversionLosses([task(1, { description: TASK_DECRYPT_FAILED })]).unreadable).toBe(1);
    });

    it('re-creates parents before children for Undo', () => {
        const order = recreationOrder([task(3, { parent_id: 2 }), task(2, { parent_id: 1 }), task(1)]);
        expect(order.map(t => t.id)).toEqual([1, 2, 3]);
    });
});

describe('the composer’s title when it is left blank', () => {
    it('prefers the typed title, then the first line of text, then the first item', () => {
        expect(deriveContentTitle('  Trip ', { body: 'x' })).toBe('Trip');
        expect(deriveContentTitle('', { body: '\n  Pack light\nsecond' })).toBe('Pack light');
        expect(deriveContentTitle('', { items: ['', 'Socks'] })).toBe('Socks');
    });
    it('names a picture-only note by what it is', () => {
        expect(deriveContentTitle('', { drawing: true })).toBe('Drawing');
        expect(deriveContentTitle('', { images: 2 })).toBe('Photo');
        expect(deriveContentTitle('', {})).toBe('Untitled note');
    });
});

describe('the gallery', () => {
    const png = ref('p1', 'image/png', 'drawing-1.png');
    const strokes = ref('s1', DRAWING_STROKES_MIME, 'drawing-1.json');
    const photo = ref('ph', 'image/jpeg', 'beach.jpg');
    const doc = ref('d', 'application/pdf', 'ticket.pdf');

    it('pairs a drawing’s PNG with its strokes and never shows the strokes alone', () => {
        const items = galleryItems(JSON.stringify([photo, png, strokes, doc]));
        expect(items.map(i => [i.ref.name, i.kind])).toEqual([['beach.jpg', 'image'], ['drawing-1.png', 'drawing'], ['ticket.pdf', 'file']]);
        expect(items[1].strokes).toEqual(strokes);
    });

    it('removing a drawing removes both halves', () => {
        const [, drawing] = galleryItems(JSON.stringify([photo, png, strokes]));
        expect(withoutItem([photo, png, strokes], drawing)).toEqual([photo]);
    });

    it('lists orphaned strokes as a file so they can be removed, and a locked sidecar as nothing', () => {
        expect(galleryItems(JSON.stringify([strokes])).map(i => i.kind)).toEqual(['file']);
        expect(galleryItems(TASK_DECRYPT_FAILED)).toEqual([]);
        expect(galleryItems(null)).toEqual([]);
    });

    it('cards lead with at most three pictures, files excluded', () => {
        const many = [photo, png, strokes, doc, ref('a', 'image/png', 'a.png'), ref('b', 'image/png', 'b.png')];
        expect(heroItems(JSON.stringify(many)).map(i => i.ref.name)).toEqual(['beach.jpg', 'drawing-1.png', 'a.png']);
    });

    it('names new drawings without colliding, and counts a drawing as two slots', () => {
        expect(nextDrawingName([png, strokes])).toBe('drawing-2');
        expect(nextDrawingName([])).toBe('drawing-1');
        expect(slotsNeeded(2, 1)).toBe(4);
    });
});

describe('the drawing file', () => {
    it('round-trips strokes', () => {
        const d = { ...emptyDrawing(), strokes: [{ tool: 'pen' as const, color: '#d93025', width: 10, points: [1.234, 2, 30, 40] }, { tool: 'eraser' as const, color: '#202124', width: 24, points: [5, 5] }] };
        const back = parseDrawing(serializeDrawing(d));
        expect(back).toEqual({ ...d, strokes: [{ ...d.strokes[0], points: [1.23, 2, 30, 40] }, d.strokes[1]] });
    });

    it('is TOTAL: garbage is "no drawing", hostile values are clamped or dropped', () => {
        expect(parseDrawing('not json')).toBeNull();
        expect(parseDrawing('{"v":2,"strokes":[]}')).toBeNull();
        const hostile = parseDrawing(JSON.stringify({
            v: 1, w: -5, h: 1e9,
            strokes: [
                { tool: 'laser', color: 'url(javascript:x)', width: 1e6, points: [1, 2, 3] },
                { tool: 'pen', color: '#000000', width: 4, points: ['a', 1] },
                'nope',
            ],
        }));
        expect(hostile).not.toBeNull();
        expect(hostile!.w).toBe(DRAWING_WIDTH);
        expect(hostile!.strokes).toHaveLength(1);
        expect(hostile!.strokes[0]).toMatchObject({ tool: 'pen', color: '#202124', width: 4, points: [1, 2] });
    });

    it('clamps the canvas size a strokes file asks for (the editor allocates it)', () => {
        const huge = parseDrawing(JSON.stringify({ v: 1, w: 10_000, h: 9_999, strokes: [] }))!;
        expect(huge.w).toBe(MAX_DRAWING_SIDE);
        expect(huge.h).toBe(MAX_DRAWING_SIDE);
        expect(MAX_DRAWING_SIDE).toBeLessThanOrEqual(2400);
        // POSITIVE CONTROL: an ordinary size is kept exactly.
        const normal = parseDrawing(JSON.stringify({ v: 1, w: 1200, h: 900, strokes: [] }))!;
        expect([normal.w, normal.h]).toEqual([1200, 900]);
    });

    it('bounds the total number of points', () => {
        const big = { v: 1, strokes: Array.from({ length: 30 }, () => ({ tool: 'pen', color: '#000000', width: 4, points: Array(20_000).fill(1) })) };
        const d = parseDrawing(JSON.stringify(big))!;
        expect(d.strokes.reduce((n, s) => n + s.points.length, 0)).toBeLessThanOrEqual(200_000);
    });

    it('maps a pointer onto the logical canvas, clamped', () => {
        const box = { left: 100, top: 50, width: 600, height: 450 };
        expect(toCanvasPoint(400, 275, box, { w: 1200, h: 900 })).toEqual([600, 450]);
        expect(toCanvasPoint(0, 0, box, { w: 1200, h: 900 })).toEqual([0, 0]);
        expect(toCanvasPoint(9999, 9999, box, { w: 1200, h: 900 })).toEqual([1200, 900]);
    });
});

describe('shrinking photos before they are sealed', () => {
    it('fits the long edge and keeps the aspect', () => {
        expect(fitWithin(4000, 3000)).toEqual({ w: 2048, h: 1536 });
        expect(fitWithin(1000, 800)).toEqual({ w: 1000, h: 800 });
    });
    it('leaves GIFs, SVGs and small images alone', () => {
        expect(shouldShrink('image/gif', 9e6, 4000, 4000)).toBe(false);
        expect(shouldShrink('image/svg+xml', 9e6, 4000, 4000)).toBe(false);
        expect(shouldShrink('image/jpeg', 200_000, 800, 600)).toBe(false);
        expect(shouldShrink('image/jpeg', 5e6, 800, 600)).toBe(true);
        expect(shouldShrink('image/png', 100_000, 3000, 100)).toBe(true);
    });
});

describe('a note’s text in search, copy-as-text and the export', () => {
    const source = (body: string | null): NoteSource => ({ ref: { kind: 'list', id: 7 }, title: 'Trip', body, noteAttachments: JSON.stringify([ref('ph', 'image/jpeg', 'beach.jpg')]) });
    const card = (body: string | null, tasks: Task[] = []) => buildNoteCards([source(body)], new Map([['list:7', tasks]]), [], EMPTY_KEEP_PREFS)[0];

    it('search finds words in the text, but not in an unreadable marker', () => {
        expect(noteMatches(card('Pack the snorkel'), 'snorkel')).toBe(true);
        expect(noteMatches(card(null), 'snorkel')).toBe(false);
        expect(noteMatches(card(TASK_DECRYPT_FAILED), 'decrypt')).toBe(false);
    });

    it('copy-as-text writes the text and names the pictures, and is not "(empty)"', () => {
        const md = noteToMarkdown(card('Line one\nLine two'));
        expect(md).toContain('Line one\nLine two');
        expect(md).toContain('- attachment: beach.jpg');
        expect(md).not.toContain('_(empty)_');
        expect(noteToMarkdown(buildNoteCards([{ ref: { kind: 'list', id: 8 }, title: 'Blank' }], new Map([['list:8', []]]), [], EMPTY_KEEP_PREFS)[0])).toContain('_(empty)_');
    });

    it('the JSON export carries the text and the picture names', () => {
        const doc = JSON.parse(notesToJson([card('hello')], '2026-09-19T00:00:00Z'));
        expect(doc.notes[0].text).toBe('hello');
        expect(doc.notes[0].textUnreadable).toBe(false);
        expect(doc.notes[0].pictures).toEqual(['beach.jpg']);
    });

    it('readableBody hides markers', () => {
        expect(readableBody(TASK_DECRYPT_FAILED)).toBe('');
        expect(readableBody('ok')).toBe('ok');
        expect(readableBody(null)).toBe('');
    });
});
