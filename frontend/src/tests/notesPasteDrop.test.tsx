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
import { PACE_MS } from '../api/icsImport';
import { MAX_ITEM_LENGTH } from '../notes/model/notesModel';
import { MAX_TAKEN_ITEMS } from '../notes/model/noteContent';
import { setMessageToastSink } from '../components/messageToastBus';
import { LayerOnScreenContext } from '../components/portalTarget';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';
import {
    ASSISTANT_ADD, ASSISTANT_ANSWER, ASSISTANT_HTML, ASSISTANT_ITEMS, ASSISTANT_RENDERED_LINES, ASSISTANT_RENDERED_TEXT,
    ASSISTANT_SHOWN, ASSISTANT_TITLE,
} from './fixtures/assistantChecklist';

const LIST = { kind: 'list' as const, id: 1 };
const card = { key: 'list:1', ref: LIST, title: 'Shopping', body: '', noteAttachments: null, labels: [], pinned: false, archived: false } as unknown as NoteCard;

const png = (name = 'shot.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

/** A paste, as the browser delivers it: a real event carrying a transfer.
 *  `sidecar` is the image Chromium puts on the clipboard BESIDE rich text (a
 *  Word paragraph, an Excel range), reachable only through `items` — the way
 *  filesFromTransfer's fallback finds it. `html` is the `text/html` beside
 *  the text. */
function paste(el: Element, data: { text?: string; html?: string; files?: File[]; sidecar?: File }) {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    const items = data.sidecar ? [{ kind: 'file', type: data.sidecar.type, getAsFile: () => data.sidecar }] : [];
    Object.defineProperty(ev, 'clipboardData', {
        value: {
            files: data.files ?? [],
            items,
            types: [
                ...(data.files?.length || data.sidecar ? ['Files'] : []),
                ...(data.text ? ['text/plain'] : []),
                ...(data.html ? ['text/html'] : []),
            ],
            getData: (f: string) => (f === 'text/html' ? data.html ?? '' : data.text ?? ''),
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
/** A fan-out of creates is PACED (icsImport's PACE_MS): a paste of N lines
 *  takes N-1 pauses. Those pauses run on a FAKE clock (`pacedOnAFakeClock`),
 *  skipped here with room for one more: a create past the N-th, were there
 *  one, would go out too. Every create in this file is a mock that settles
 *  in microtasks, and the clock lets those run between the pauses.
 *
 *  Not real time. This slept PACE_MS × N + 60 ms of it while the product's
 *  N-1 pauses ran on real timers too, and on a loaded machine each of those
 *  fires late: 5 of 6 rows had landed (2026-10-02, twice in full runs). */
const paced = async (lines: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(PACE_MS * (lines + 1)); });
    await flush();
};
/** For a describe whose creates are paced: the clock is fake from before
 *  the first paste, so no pause is ever left on a real timer. */
const pacedOnAFakeClock = () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });
};

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

    it('an answer copied as RENDERED text: its HTML gives the title and the heading, not one line each', () => {
        composer();
        // POSITIVE CONTROL: the plain text alone, one item per line.
        paste(itemInputs()[0], { text: ASSISTANT_RENDERED_TEXT });
        expect(dialogLines()).toEqual(ASSISTANT_RENDERED_LINES);
        act(() => { button('Cancel').click(); });
        const ev = paste(itemInputs()[0], { text: ASSISTANT_RENDERED_TEXT, html: ASSISTANT_HTML });
        expect(ev.defaultPrevented).toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        act(() => { button(ASSISTANT_ADD).click(); });
        // Stored as it will be saved: the section a "## " row (a heading).
        expect(itemInputs().map(i => i.value)).toEqual(ASSISTANT_ITEMS);
        expect(document.querySelector<HTMLInputElement>('input.notes-quickadd-title')?.value).toBe(ASSISTANT_TITLE);
    });

    it('"Add 3 items" makes one item per line, in order', () => {
        composer();
        paste(itemInputs()[0], { text: 'Milk\n- Bread\n[x] Eggs' });
        act(() => { button('Add 3 items').click(); });
        expect(itemInputs().map(i => i.value)).toEqual(['Milk', 'Bread', 'Eggs']);
        expect(dialog()).toBeNull();
    });

    it('a pasted line longer than a typed one can be is truncated to the same limit', () => {
        // `maxLength` on the field refuses a 501st character by typing; a
        // paste must not be the one route that gets past it.
        composer();
        paste(itemInputs()[0], { text: `${'a'.repeat(800)}\nshort` });
        act(() => { button('Add 2 items').click(); });
        expect(itemInputs().map(i => i.value.length)).toEqual([MAX_ITEM_LENGTH, 'short'.length]);
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

    it('a TEXT paste that carries a picture beside it stays text — Excel, Word, a web page', () => {
        // Chromium puts an image/png on the clipboard next to the text for
        // any rich copy, so "there is an image" is not "a picture was
        // copied": a pasted table must arrive as the table's text.
        composer();
        const ev = paste(itemInputs()[0], { text: 'Apples\tBread\nMilk\tEggs', sidecar: png('table.png') });
        expect(document.querySelectorAll('.notes-quickadd-media img')).toHaveLength(0);
        // ...and the multi-line question is still asked, by the item field.
        expect(dialog()).not.toBeNull();
        expect(ev.defaultPrevented).toBe(true);
        // POSITIVE CONTROL: the same side-car with NO text IS a picture.
        act(() => { button('Cancel').click(); });
        paste(itemInputs()[0], { sidecar: png('shot.png') });
        expect(document.querySelectorAll('.notes-quickadd-media img')).toHaveLength(1);
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

    it('...not even when that text arrives with a picture side-car', async () => {
        const { addNoteMedia, content } = openNote();
        const ev = paste(content, { text: 'Apples\tBread\nMilk\tEggs', sidecar: png('table.png') });
        await flush();
        expect(ev.defaultPrevented).toBe(false);
        expect(addNoteMedia).not.toHaveBeenCalled();
        // POSITIVE CONTROL: the side-car alone, with no text, IS uploaded.
        paste(content, { sidecar: png('shot.png') });
        await flush();
        expect(addNoteMedia).toHaveBeenCalledTimes(1);
    });
});

// --- The open note's "Add an item…" row ---------------------------------------------

describe('a multi-line paste into "Add an item…"', () => {
    pacedOnAFakeClock();
    function editor(opts: { addOk?: (text: string) => boolean } = {}) {
        const added: string[] = [];
        const actions = {
            addTask: vi.fn(async (_n: unknown, text: string) => {
                added.push(text);
                if (opts.addOk && !opts.addOk(text)) return null as never;
                return { id: added.length } as never;
            }),
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
                    onSendToPuca={() => {}}
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
        await paced(3);
        expect(e.added).toEqual(['Milk', 'Bread', 'Eggs']);
    });

    it('stops at the first refusal and SAYS how many landed', async () => {
        const e = editor({ addOk: text => text !== 'Eggs' });
        paste(e.input, { text: 'Milk\nBread\nEggs\nFlour' });
        act(() => { button('Add 4 items').click(); });
        await paced(4);
        expect(e.added).toEqual(['Milk', 'Bread', 'Eggs']);   // Eggs was attempted and refused
        expect(toasts).toContain('Added 2 of 4 items');
        // POSITIVE CONTROL: nothing is said when every line lands.
        toasts.length = 0;
        const ok = editor();
        paste(ok.input, { text: 'Tea\nCoffee' });
        act(() => { button('Add 2 items').click(); });
        await paced(2);
        expect(ok.added).toEqual(['Tea', 'Coffee']);
        expect(toasts.join('|')).not.toMatch(/Added/);
    });

    it('a pasted line longer than a typed one can be is truncated to the same limit', async () => {
        const e = editor();
        paste(e.input, { text: `${'a'.repeat(800)}\nshort` });
        act(() => { button('Add 2 items').click(); });
        await paced(2);
        expect(e.added[0]).toHaveLength(MAX_ITEM_LENGTH);
        expect(e.added[1]).toBe('short');
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

/**
 * A pasted batch takes tens of seconds (paced, a round trip each), and when
 * it ends the add row takes the focus back for the next item. By then the
 * person may be somewhere else: renaming the note, or — Notes in the desktop
 * app — typing in one of Púca's dialogs over it, or in another view. Moving
 * the caret into the note then sent their next keystrokes, and an Enter,
 * into it. A typed item's create comes back the same way, sooner.
 */
describe('after a create, the add row takes the focus back only from where it was left', () => {
    pacedOnAFakeClock();
    function editor(onScreen = true, batch = true) {
        const actions = {
            addTask: vi.fn(async () => ({ id: 1 }) as never),
            content: { features: { body: false, attachments: false }, setBody: vi.fn(async () => true) },
            toggleTask: vi.fn(), deleteTaskFrom: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
            reorderTaskIn: vi.fn(), setDue: vi.fn(), setAttachments: vi.fn(), refreshNote: vi.fn(), togglePin: vi.fn(),
        } as unknown as NoteActions;
        const at = (on: boolean) => act(() => {
            root.render(
                <LayerOnScreenContext.Provider value={on}>
                    <NoteEditor card={card} actions={actions} onClose={() => {}} onMenu={() => {}} onPickColor={() => {}}
                        onPickLabels={() => {}} onArchive={() => {}} onSendToPuca={() => {}} pucaHref={null} />
                </LayerOnScreenContext.Provider>,
            );
        });
        at(onScreen);
        const input = document.querySelector<HTMLInputElement>('.notes-editor-add input')!;
        if (batch) {
            paste(input, { text: 'Milk\nBread\nEggs' });
            act(() => { button('Add 3 items').click(); });
        }
        return { input, at, actions, title: document.querySelector<HTMLInputElement>('input.notes-editor-title')! };
    }
    /** A field of one of Púca's own dialogs, outside Notes. */
    const pucaField = () => {
        const f = document.createElement('input');
        document.body.appendChild(f);
        return f;
    };

    it('POSITIVE CONTROL: left alone — the add row, or nowhere — it ends in the add row', async () => {
        const e = editor();
        (document.activeElement as HTMLElement).blur();
        await paced(3);
        expect(document.activeElement).toBe(e.input);
    });

    it('an item added with the + button: the add row takes the focus back', async () => {
        const e = editor(true, false);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(e.input, 'Milk'); e.input.dispatchEvent(new Event('input', { bubbles: true })); });
        const plus = document.querySelector<HTMLButtonElement>('button[aria-label="Add item"]')!;
        plus.focus();
        expect(document.activeElement).toBe(plus);
        await act(async () => { plus.click(); });
        await flush();
        expect(e.actions.addTask).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(e.input);
    });

    it('typing in one of Púca’s dialogs when it ends, the focus stays there', async () => {
        editor();
        const field = pucaField();
        field.focus();
        await paced(3);
        expect(document.activeElement).toBe(field);
    });

    it('renaming the note when it ends, the focus stays in the title', async () => {
        const e = editor();
        e.title.focus();
        await paced(3);
        expect(document.activeElement).toBe(e.title);
    });

    it('with one of Púca’s dialogs over the note and the focus nowhere, it stays out', async () => {
        const e = editor();
        const backdrop = document.createElement('div');
        document.body.appendChild(backdrop);
        // jsdom has no layout: the note gets a box, and a dialog is what is on top of it.
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} } as DOMRect);
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => backdrop });
        try {
            (document.activeElement as HTMLElement).blur();
            await paced(3);
            expect(document.activeElement).not.toBe(e.input);
        } finally {
            delete (document as { elementFromPoint?: unknown }).elementFromPoint;
        }
    });

    it('with Notes off the screen (another view of the app), it stays out', async () => {
        const e = editor();
        e.at(false);
        (document.activeElement as HTMLElement).blur();
        await paced(3);
        expect(document.activeElement).not.toBe(e.input);
    });
});

// --- A checklist from elsewhere, pasted into the open note -------------------------

describe('a step-by-step checklist pasted into an OPEN note', () => {
    pacedOnAFakeClock();
    /** The open note, with the two writes a paste can make recorded. */
    function openEditor(over: Partial<NoteCard> = {}) {
        const added: string[] = [];
        const renamed: Array<[unknown, string, number | undefined]> = [];
        const note = { ...card, ...over } as NoteCard;
        const actions = {
            addTask: vi.fn(async (_n: unknown, text: string) => { added.push(text); return { id: added.length } as never; }),
            renameNote: vi.fn(async (n: unknown, title: string, base?: number) => { renamed.push([n, title, base]); return true; }),
            content: { features: { body: false, attachments: false }, setBody: vi.fn(async () => true) },
            toggleTask: vi.fn(), deleteTaskFrom: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
            reorderTaskIn: vi.fn(), setDue: vi.fn(), setAttachments: vi.fn(), refreshNote: vi.fn(), togglePin: vi.fn(),
        } as unknown as NoteActions;
        act(() => {
            root.render(
                <NoteEditor card={note} actions={actions} onClose={() => {}} onMenu={() => {}} onPickColor={() => {}}
                    onPickLabels={() => {}} onArchive={() => {}} onSendToPuca={() => {}} pucaHref={null} />,
            );
        });
        return {
            actions, added, renamed,
            input: document.querySelector<HTMLInputElement>('.notes-editor-add input')!,
            title: document.querySelector<HTMLInputElement>('input.notes-editor-title')!,
        };
    }
    const addN = () => button(ASSISTANT_ADD);

    it('"Add an item…": the answer becomes its clean steps, in order — nothing before the answer', async () => {
        const e = openEditor();
        const ev = paste(e.input, { text: ASSISTANT_ANSWER });
        expect(ev.defaultPrevented).toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        expect(e.actions.addTask).not.toHaveBeenCalled();
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.added).toEqual(ASSISTANT_ITEMS);
        // An open note's add row never renames it: only its title does.
        expect(e.actions.renameNote).not.toHaveBeenCalled();
    });

    it('"Add an item…" and the title take an answer copied as RENDERED text from its HTML', async () => {
        const e = openEditor({ title: 'Untitled note', contentRev: 4 } as Partial<NoteCard>);
        // POSITIVE CONTROL: the plain text alone, one item per line.
        paste(e.input, { text: ASSISTANT_RENDERED_TEXT });
        expect(dialogLines()).toEqual(ASSISTANT_RENDERED_LINES);
        act(() => { button('Cancel').click(); });
        paste(e.input, { text: ASSISTANT_RENDERED_TEXT, html: ASSISTANT_HTML });
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.added).toEqual(ASSISTANT_ITEMS);
        // The title: without the HTML it is no checklist, and pastes as a title.
        expect(paste(e.title, { text: ASSISTANT_RENDERED_TEXT }).defaultPrevented).toBe(false);
        const ev = paste(e.title, { text: ASSISTANT_RENDERED_TEXT, html: ASSISTANT_HTML });
        expect(ev.defaultPrevented, 'not one long title line').toBe(true);
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.renamed).toEqual([[LIST, ASSISTANT_TITLE, 4]]);
    });

    it('the TITLE of an untitled personal note: asks, then adds the steps and takes the heading as its name', async () => {
        const e = openEditor({ title: 'Untitled note', contentRev: 4 } as Partial<NoteCard>);
        const ev = paste(e.title, { text: ASSISTANT_ANSWER });
        expect(ev.defaultPrevented, 'not one long title line').toBe(true);
        expect(dialogLines()).toEqual(ASSISTANT_SHOWN);
        expect(e.actions.renameNote).not.toHaveBeenCalled();   // asked first
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.added).toEqual(ASSISTANT_ITEMS);
        // Named against the revision the field stood on, like any rename.
        expect(e.renamed).toEqual([[LIST, ASSISTANT_TITLE, 4]]);
    });

    it('a title field the user emptied counts as untitled too', async () => {
        const e = openEditor({ title: 'Old name' });
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(e.title, ''); e.title.dispatchEvent(new Event('input', { bubbles: true })); });
        paste(e.title, { text: ASSISTANT_ANSWER });
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.renamed.map(r => r[1])).toEqual([ASSISTANT_TITLE]);
    });

    it('a note that has a name keeps it; the steps still arrive', async () => {
        const e = openEditor({ title: 'Home network' });
        paste(e.title, { text: ASSISTANT_ANSWER });
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.added).toEqual(ASSISTANT_ITEMS);
        expect(e.actions.renameNote).not.toHaveBeenCalled();
    });

    it('a CHANNEL checklist is never renamed from here, untitled or not', async () => {
        const e = openEditor({ ref: { kind: 'channel', id: 9 }, key: 'channel:9', title: 'Untitled note' } as Partial<NoteCard>);
        paste(e.title, { text: ASSISTANT_ANSWER });
        act(() => { addN().click(); });
        await paced(ASSISTANT_ITEMS.length);
        expect(e.added).toEqual(ASSISTANT_ITEMS);
        expect(e.actions.renameNote).not.toHaveBeenCalled();
    });

    it('Cancel creates and renames nothing; "Add as one item" only fills the add row; other text pastes as a title', () => {
        const e = openEditor({ title: 'Untitled note' });
        paste(e.title, { text: ASSISTANT_ANSWER });
        act(() => { button('Cancel').click(); });
        expect(dialog()).toBeNull();
        expect(e.actions.addTask).not.toHaveBeenCalled();
        expect(e.actions.renameNote).not.toHaveBeenCalled();

        paste(e.title, { text: ASSISTANT_ANSWER });
        act(() => { button('Add as one item').click(); });
        expect(e.actions.addTask).not.toHaveBeenCalled();
        expect(e.actions.renameNote).not.toHaveBeenCalled();
        expect(e.input.value).toBe(ASSISTANT_SHOWN.join(' '));

        // POSITIVE CONTROL: lines that are not a checklist are a title paste.
        const plain = paste(e.title, { text: 'Milk\nBread' });
        expect(plain.defaultPrevented).toBe(false);
        expect(dialog()).toBeNull();
    });

    it('the question says when it will also name the note, and only then', () => {
        const e = openEditor({ title: 'Untitled note' });
        paste(e.title, { text: ASSISTANT_ANSWER });
        expect(dialog()?.textContent).toContain(`Adding them as items also names this note “${ASSISTANT_TITLE}”.`);
        act(() => { button('Cancel').click(); });
        // POSITIVE CONTROL: a note with a name keeps it, and nothing says otherwise.
        const named = openEditor({ title: 'Home network' });
        paste(named.title, { text: ASSISTANT_ANSWER });
        expect(dialog()).not.toBeNull();
        expect(dialog()?.textContent).not.toContain('names this note');
        act(() => { button('Cancel').click(); });
        paste(named.input, { text: ASSISTANT_ANSWER });
        expect(dialog()?.textContent).not.toContain('names this note');
    });

    it('the question takes the focus; Cancel gives it back to the title it was pasted into', () => {
        const e = openEditor({ title: 'Untitled note' });
        e.title.focus();
        paste(e.title, { text: ASSISTANT_ANSWER });
        expect(document.activeElement?.closest('.notes-paste-dialog'), 'focus in the question').not.toBeNull();
        act(() => { button('Cancel').click(); });
        expect(document.activeElement).toBe(e.title);
    });

    it('Enter in "Add an item…" while the question is open adds nothing behind it', async () => {
        const e = openEditor();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => { setter.call(e.input, 'Milk'); e.input.dispatchEvent(new Event('input', { bubbles: true })); });
        paste(e.input, { text: ASSISTANT_ANSWER });
        const form = e.input.closest('form')!;
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await flush();
        expect(e.actions.addTask).not.toHaveBeenCalled();
        act(() => { button('Cancel').click(); });
        // POSITIVE CONTROL: answered, Enter adds what was typed.
        await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await flush();
        expect(e.added).toEqual(['Milk']);
    });

    it(`a paste of more than ${MAX_TAKEN_ITEMS} lines creates the first ${MAX_TAKEN_ITEMS}, and the prompt says so`, async () => {
        const e = openEditor();
        paste(e.input, { text: Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n') });
        expect(document.body.textContent).toContain('You pasted 250 lines');
        expect(document.body.textContent).toContain(`Only the first ${MAX_TAKEN_ITEMS} are added`);
        act(() => { button(`Add ${MAX_TAKEN_ITEMS} items`).click(); });
        await paced(MAX_TAKEN_ITEMS + 4);
        expect(e.added).toHaveLength(MAX_TAKEN_ITEMS);
        expect(e.added.at(-1)).toBe(`line ${MAX_TAKEN_ITEMS}`);
    });
});
