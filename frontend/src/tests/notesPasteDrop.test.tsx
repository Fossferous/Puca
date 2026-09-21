/**
 * Pasting and dropping into a note (QuickAdd, NoteContentSection).
 *
 * The two things this has to prove, because both are invisible to a type
 * checker: a picture reaches the EXISTING seal-and-upload entry point (never a
 * second upload call site, and never split into batches around the sidecar
 * cap), and a multi-line paste creates NOTHING until the confirmation is
 * answered — items are removed one at a time with no Undo, so a silent
 * forty-item paste would be unrecoverable.
 *
 * Every case here dispatches a REAL event at a real element, so a handler
 * wired to the wrong node fails the test rather than passing vacuously (the
 * failure mode this repo has shipped before: a paste test green because the
 * event never reached the element).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, deleteFiles: vi.fn(async () => {}) };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, pendingOutboxCount: vi.fn(() => 0) };
});
vi.mock('../notes/model/notesQueries', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesQueries')>();
    return { ...real, useNoteTasks: () => ({ data: [], isPending: false, isFetching: false }) };
});
vi.mock('../api/taskFeatures', async (orig) => {
    const real = await orig<typeof import('../api/taskFeatures')>();
    return { ...real, useTaskFeature: () => false };
});
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));

import { QuickAdd } from '../notes/components/QuickAdd';
import { NoteContentSection } from '../notes/components/NoteContentSection';
import { NoteEditor } from '../notes/components/NoteEditor';
import { ONLY_PICTURES, PASTE_OFFLINE } from '../notes/model/pasteDrop';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

const LIST = { kind: 'list' as const, id: 1 };
const card = { key: 'list:1', ref: LIST, title: 'Shopping', body: '', noteAttachments: null, labels: [], pinned: false, archived: false } as unknown as NoteCard;

const png = (name = 'shot.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

/** A paste, as the browser delivers it: a real event carrying a transfer. */
function paste(el: Element, data: { text?: string; files?: File[] }) {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
        value: {
            files: data.files ?? [],
            items: [],
            types: data.files?.length ? ['Files'] : ['text/plain'],
            getData: () => data.text ?? '',
        },
    });
    act(() => { el.dispatchEvent(ev); });
    return ev;
}

/** An OS drop of files. */
function drop(el: Element, files: File[]) {
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { files, items: [], types: ['Files'] } });
    act(() => { el.dispatchEvent(ev); });
    return ev;
}

let root: Root;
let host: HTMLDivElement;
let toasts: string[];
let onLine = true;
let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    toasts = [];
    onLine = true;
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    setMessageToastSink(t => { toasts.push(t.title); });
    // jsdom has no object URLs; the composer's previews need one.
    if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:test';
    if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    setMessageToastSink(null);
    onLineSpy?.mockRestore();
    vi.restoreAllMocks();
});

// --- The composer -----------------------------------------------------------------

function composer() {
    const onCreate = vi.fn(async () => true);
    act(() => { root.render(<QuickAdd onCreate={onCreate} sheet content={{ text: true, pictures: true }} />); });
    return { onCreate };
}
const itemInputs = () => [...document.querySelectorAll<HTMLInputElement>('.notes-quickadd-item input')];
const dialog = () => document.querySelector('.notes-paste-dialog');
const dialogLines = () => [...document.querySelectorAll('.notes-paste-line')].map(l => l.textContent);
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.notes-paste-actions button')]
    .find(b => b.textContent === text)!;

describe('a multi-line paste asks before it creates anything', () => {
    it('shows every line it is about to add, and adds nothing yet', () => {
        composer();
        paste(itemInputs()[0], { text: 'Milk\nBread\nEggs' });
        expect(dialog()).not.toBeNull();
        expect(dialogLines()).toEqual(['Milk', 'Bread', 'Eggs']);
        expect(itemInputs()).toHaveLength(1);          // nothing created yet
        expect(itemInputs()[0].value).toBe('');
    });

    it('"Add 3 items" makes one item per line, in order', () => {
        composer();
        paste(itemInputs()[0], { text: 'Milk\n- Bread\n[x] Eggs' });
        act(() => { button('Add 3 items').click(); });
        expect(itemInputs().map(i => i.value)).toEqual(['Milk', 'Bread', 'Eggs']);
        expect(dialog()).toBeNull();
    });

    it('"Add as one item" makes exactly one, on one line', () => {
        composer();
        paste(itemInputs()[0], { text: 'Milk\nBread\nEggs' });
        act(() => { button('Add as one item').click(); });
        expect(itemInputs().map(i => i.value)).toEqual(['Milk Bread Eggs']);
    });

    it('Cancel creates nothing at all', () => {
        composer();
        paste(itemInputs()[0], { text: 'Milk\nBread\nEggs' });
        act(() => { button('Cancel').click(); });
        expect(dialog()).toBeNull();
        expect(itemInputs().map(i => i.value)).toEqual(['']);
    });

    it('a ONE-line paste is never intercepted — no dialog, no preventDefault', () => {
        composer();
        const ev = paste(itemInputs()[0], { text: 'Milk' });
        expect(dialog()).toBeNull();
        expect(ev.defaultPrevented).toBe(false);
        // POSITIVE CONTROL: the same field with two lines DOES ask.
        const two = paste(itemInputs()[0], { text: 'Milk\nBread' });
        expect(dialog()).not.toBeNull();
        expect(two.defaultPrevented).toBe(true);
    });
});

describe('a picture pasted or dropped into the composer', () => {
    it('previews in the composer, through the picker’s own entry point', () => {
        composer();
        paste(itemInputs()[0], { files: [png()] });
        expect(document.querySelectorAll('.notes-quickadd-media img')).toHaveLength(1);
    });

    it('a drop of two pictures adds both', () => {
        composer();
        drop(document.querySelector('.notes-quickadd')!, [png('a.png'), png('b.png')]);
        expect(document.querySelectorAll('.notes-quickadd-media img')).toHaveLength(2);
    });

    it('anything that is not a picture is reported, not silently dropped', () => {
        composer();
        drop(document.querySelector('.notes-quickadd')!, [new File(['x'], 'notes.pdf', { type: 'application/pdf' })]);
        expect(document.querySelectorAll('.notes-quickadd-media img')).toHaveLength(0);
        expect(toasts).toContain(ONLY_PICTURES);
    });
});

// --- The open note ----------------------------------------------------------------

function openNote(opts: { addOk?: boolean } = {}) {
    const addNoteMedia = vi.fn(async () => opts.addOk ?? true);
    const actions = {
        content: { features: { body: true, attachments: true }, addNoteMedia, setBody: vi.fn(async () => true) },
    } as unknown as NoteActions;
    act(() => { root.render(<NoteContentSection card={card} actions={actions} tasks={[]} tasksLoaded />); });
    return { addNoteMedia, content: host.querySelector('.notes-editor-content')! };
}

describe('a picture pasted or dropped onto the open note', () => {
    it('goes to addNoteMedia — the same shrink-then-seal path the picker feeds', async () => {
        const { addNoteMedia, content } = openNote();
        paste(content, { files: [png('screenshot.png')] });
        await flush();
        expect(addNoteMedia).toHaveBeenCalledTimes(1);
        const [listId, photos] = addNoteMedia.mock.calls[0] as unknown as [number, File[], unknown];
        expect(listId).toBe(1);
        expect(photos).toHaveLength(1);
        expect(photos[0].type).toBe('image/png');
    });

    it('offline it says so and uploads NOTHING — an upload never queues', async () => {
        onLine = false;
        const { addNoteMedia, content } = openNote();
        paste(content, { files: [png()] });
        await flush();
        expect(addNoteMedia).not.toHaveBeenCalled();
        expect(toasts).toContain(PASTE_OFFLINE);
        // POSITIVE CONTROL: back online, the same paste lands.
        onLine = true;
        paste(content, { files: [png()] });
        await flush();
        expect(addNoteMedia).toHaveBeenCalledTimes(1);
    });

    it('a drop of thirteen pictures is handed over as ONE batch, so the sidecar cap sees all of it', async () => {
        const { addNoteMedia, content } = openNote();
        drop(content, Array.from({ length: 13 }, (_, i) => png(`p${i}.png`)));
        await flush();
        expect(addNoteMedia).toHaveBeenCalledTimes(1);
        expect((addNoteMedia.mock.calls[0] as unknown as [number, File[]])[1]).toHaveLength(13);
    });

    it('a text paste into the note’s own text is NOT intercepted', () => {
        const { addNoteMedia, content } = openNote();
        const ev = paste(content, { text: 'Roses are red\nViolets are blue' });
        expect(ev.defaultPrevented).toBe(false);
        expect(addNoteMedia).not.toHaveBeenCalled();
    });
});

// --- The open note's "Add an item…" row ---------------------------------------------

describe('a multi-line paste into "Add an item…"', () => {
    function editor() {
        const added: string[] = [];
        const actions = {
            addTask: vi.fn(async (_n: unknown, text: string) => { added.push(text); return { id: added.length } as never; }),
            content: { features: { body: false, attachments: false }, setBody: vi.fn(async () => true) },
            toggleTask: vi.fn(), deleteTaskFrom: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
            reorderTaskIn: vi.fn(), setDue: vi.fn(), setAttachments: vi.fn(), refreshNote: vi.fn(), togglePin: vi.fn(),
        } as unknown as NoteActions;
        act(() => {
            root.render(
                <NoteEditor
                    card={card}
                    actions={actions}
                    onClose={() => {}}
                    onMenu={() => {}}
                    onPickColor={() => {}}
                    onPickLabels={() => {}}
                    onArchive={() => {}}
                    pucaHref={null}
                />,
            );
        });
        return { actions, added, input: document.querySelector<HTMLInputElement>('.notes-editor-add input')! };
    }

    it('asks first, then creates one item per line in order', async () => {
        const e = editor();
        paste(e.input, { text: 'Milk\nBread\nEggs' });
        expect(dialogLines()).toEqual(['Milk', 'Bread', 'Eggs']);
        expect(e.actions.addTask).not.toHaveBeenCalled();   // nothing yet
        act(() => { button('Add 3 items').click(); });
        await flush();
        expect(e.added).toEqual(['Milk', 'Bread', 'Eggs']);
    });

    it('Cancel creates nothing, and a one-line paste never asks', () => {
        const e = editor();
        paste(e.input, { text: 'Milk\nBread' });
        act(() => { button('Cancel').click(); });
        expect(e.actions.addTask).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
        const one = paste(e.input, { text: 'Milk' });
        expect(one.defaultPrevented).toBe(false);
        expect(dialog()).toBeNull();
    });
});
