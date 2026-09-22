/**
 * The label manager: rename, merge and delete a label across EVERY note.
 *
 * The point of the feature is the notes no other surface can reach — an
 * ARCHIVED note carrying the label. notesModel.filterNotes excludes archived
 * notes from a label view, and bulk selection is built from what the grid
 * shows, so "rename everywhere" was genuinely unreachable before this. Every
 * test here therefore seeds an archived note and asserts on it; a version of
 * this dialog that only rewrote the visible notes would go red.
 *
 * The global test setup stubs localStorage with vi.fn()s that STORE NOTHING
 * (see notesPrefs.test.ts), so these give them a real backing map — otherwise
 * every assertion would be about an empty store and would pass on a dialog
 * that wrote nothing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 42 }));

const { getNotesPrefs, invalidateNotesPrefs, setNoteLabels } = await import('../notes/model/notesPrefs');
const { restoreLabels } = await import('../notes/model/notesBulk');
const { LabelManager } = await import('../notes/components/LabelManager');

const backing = new Map<string, string>();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const changed = vi.fn();
const closed = vi.fn();

function counts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const ls of Object.values(getNotesPrefs().labels)) {
        for (const l of ls) m.set(l.toLocaleLowerCase(), (m.get(l.toLocaleLowerCase()) ?? 0) + 1);
    }
    return m;
}

function labelsInUse(): string[] {
    const seen = new Map<string, string>();
    for (const ls of Object.values(getNotesPrefs().labels)) {
        for (const l of ls) if (!seen.has(l.toLocaleLowerCase())) seen.set(l.toLocaleLowerCase(), l);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function render() {
    act(() => {
        root!.render(<LabelManager labels={labelsInUse()} counts={counts()} onClose={closed} onChanged={changed} />);
    });
}

const rows = () => [...document.querySelectorAll('.notes-labelmgr-row')];
const rowText = () => rows().map(r => (r as HTMLElement).textContent ?? '');
const click = (sel: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    act(() => { el.click(); });
};
const typeInto = (sel: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(sel);
    if (!input) throw new Error(`no input for ${sel}`);
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const submitRow = () => {
    const form = document.querySelector<HTMLFormElement>('.notes-labelmgr-row.editing');
    if (!form) throw new Error('no editing row');
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

/**
 * Escape as the browser delivers it: a real event on the focused element,
 * which bubbles to document and so reaches BOTH NotesDialog's capture-phase
 * listener and React's own (portal) listener, in that order. Dispatching on
 * the input rather than calling the React handler is the whole point — the
 * bug was the order, not the handler.
 */
const pressEscape = (sel = '.notes-dialog') => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
};

beforeEach(() => {
    backing.clear();
    changed.mockClear();
    closed.mockClear();
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
    (localStorage.setItem as Mock).mockImplementation((k: string, v: string) => { backing.set(k, v); });
    (localStorage.removeItem as Mock).mockImplementation((k: string) => { backing.delete(k); });
    invalidateNotesPrefs();

    // list:3 is the ARCHIVED note — the one no label view can reach.
    setNoteLabels('list:1', ['Errands']);
    setNoteLabels('list:2', ['Errands', 'Work']);
    setNoteLabels('list:3', ['Errands']);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    render();
});

afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('LabelManager', () => {
    it('lists every label with how many notes carry it, archived included', () => {
        expect(rows().length).toBe(2);
        const text = rowText().join(' | ');
        expect(text).toMatch(/Errands/);
        expect(text).toMatch(/3 notes/);          // 2 live + 1 archived
        expect(text).toMatch(/Work/);
        expect(text).toMatch(/1 note\b/);
    });

    it('a rename rewrites every note, the archived one included, in one write', () => {
        click('button[aria-label="Rename Errands"]');
        typeInto('.notes-labelmgr-row.editing input', 'Chores');
        (localStorage.setItem as Mock).mockClear();
        submitRow();
        expect(getNotesPrefs().labels).toEqual({
            'list:1': ['Chores'],
            'list:2': ['Chores', 'Work'],
            'list:3': ['Chores'],                 // the archived note followed
        });
        expect((localStorage.setItem as Mock).mock.calls.length).toBe(1);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0][0]).toBe('Errands');
        expect(changed.mock.calls[0][1]).toBe('Chores');
    });

    it('renaming onto an existing label asks first, and cancelling changes nothing', () => {
        const before = getNotesPrefs().labels;
        click('button[aria-label="Rename Errands"]');
        typeInto('.notes-labelmgr-row.editing input', 'work');
        submitRow();
        expect(rowText().join(' ')).toMatch(/Merge into/);
        expect(getNotesPrefs().labels).toBe(before);   // not written yet
        expect(changed).not.toHaveBeenCalled();
        click('.notes-labelmgr-row.confirm .notes-textbtn');   // Cancel is first
        expect(getNotesPrefs().labels).toBe(before);
    });

    it('confirming a merge folds the two together under the EXISTING spelling', () => {
        click('button[aria-label="Rename Errands"]');
        typeInto('.notes-labelmgr-row.editing input', 'work');   // lower case on purpose
        submitRow();
        const confirm = [...document.querySelectorAll<HTMLElement>('.notes-labelmgr-row.confirm .notes-textbtn')];
        act(() => { confirm[confirm.length - 1].click(); });
        // "Work", not "work": the label already in use keeps its own spelling,
        // so the account is not left with two casings of one label.
        expect(getNotesPrefs().labels).toEqual({
            'list:1': ['Work'],
            'list:2': ['Work'],                   // had both — one entry now
            'list:3': ['Work'],
        });
        expect(changed.mock.calls[0][1]).toBe('Work');
    });

    it('deleting asks first, then removes the label from every note; Undo puts it back', () => {
        click('button[aria-label="Delete Errands"]');
        expect(rowText().join(' ')).toMatch(/Remove “Errands” from 3 notes\?/);
        expect(getNotesPrefs().labels['list:1']).toEqual(['Errands']);
        const confirm = [...document.querySelectorAll<HTMLElement>('.notes-labelmgr-row.confirm .notes-textbtn')];
        act(() => { confirm[confirm.length - 1].click(); });
        expect(getNotesPrefs().labels).toEqual({ 'list:2': ['Work'] });
        expect(changed.mock.calls[0][1]).toBe(null);

        // The Undo the shell wires to this snapshot.
        const before = changed.mock.calls[0][2] as Record<string, string[]>;
        restoreLabels(before);
        expect(getNotesPrefs().labels).toEqual({
            'list:1': ['Errands'],
            'list:2': ['Errands', 'Work'],
            'list:3': ['Errands'],
        });
    });

    it('Escape while renaming cancels the ROW and leaves the dialog open', () => {
        click('button[aria-label="Rename Errands"]');
        typeInto('.notes-labelmgr-row.editing input', 'Nonsense');
        pressEscape('.notes-labelmgr-row.editing input');
        expect(closed).not.toHaveBeenCalled();
        expect(document.querySelectorAll('.notes-labelmgr-row.editing').length).toBe(0);
        expect(rows().length).toBe(2);                       // still listing both labels
        expect(getNotesPrefs().labels['list:3']).toEqual(['Errands']);
        expect(changed).not.toHaveBeenCalled();
    });

    it('Escape while a confirm row is showing cancels the confirm, not the dialog', () => {
        click('button[aria-label="Delete Errands"]');
        expect(rowText().join(' ')).toMatch(/Remove “Errands”/);
        pressEscape('.notes-labelmgr-row.confirm');
        expect(closed).not.toHaveBeenCalled();
        expect(rowText().join(' ')).not.toMatch(/Remove “Errands”/);
        expect(getNotesPrefs().labels['list:3']).toEqual(['Errands']);
    });

    // The control for the two above: with no row open the SAME event must
    // still close the dialog, or "Escape cancels the row" would be indis-
    // tinguishable from an Escape nobody handles at all.
    it('Escape with no row open closes the dialog', () => {
        pressEscape();
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('an empty new name cannot commit — deleting is the trash button, not a blank rename', () => {
        click('button[aria-label="Rename Errands"]');
        typeInto('.notes-labelmgr-row.editing input', '   ');
        const save = document.querySelector<HTMLButtonElement>('button[aria-label="Save Errands"]');
        expect(save?.disabled).toBe(true);
        submitRow();
        expect(getNotesPrefs().labels['list:3']).toEqual(['Errands']);
        expect(changed).not.toHaveBeenCalled();
    });
});
