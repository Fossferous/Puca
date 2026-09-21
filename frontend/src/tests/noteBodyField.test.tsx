/**
 * The note-text field Púca Notes and Púca's Tasks view share: it saves a
 * pause after typing (not per keystroke), a failed save KEEPS what was typed
 * and offers a retry, unreadable text is shown locked, never editable — an
 * edit there would seal the marker over the real ciphertext — and it has its
 * own undo and redo.
 *
 * The history has to be the field's own: a textarea's native stack is
 * destroyed the moment the sync branch writes the value programmatically,
 * which happens on every edit from another device and on every remount, and
 * a phone has no Ctrl key to reach it with anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NoteBodyField } from '../components/NoteBodyField';
import {
    TEXT_HISTORY_COALESCE_MS, TEXT_HISTORY_LIMIT, canRedoText, canUndoText, newTextHistory, pushText, redoText, undoText,
} from '../components/textHistory';
import { BODY_SAVE_DELAY_MS, flushBodySave } from '../api/listContent';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';

let root: Root;
let container: HTMLDivElement;

function type(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const area = () => container.querySelector('textarea') as HTMLTextAreaElement;
const histBtn = (label: 'Undo' | 'Redo') =>
    container.querySelector(`.nb-histbtn[aria-label="${label}"]`) as HTMLButtonElement | null;
/** Type, then let the coalescing window close so the next edit is its own step. */
function typeStep(el: HTMLTextAreaElement, value: string) {
    type(el, value);
    act(() => { vi.advanceTimersByTime(TEXT_HISTORY_COALESCE_MS); });
}
const flushPromises = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
});

describe('NoteBodyField', () => {
    it('saves once, a pause after the last keystroke', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        type(area(), 'H');
        type(area(), 'He');
        type(area(), 'Hello');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS - 1); });
        expect(onSave).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        await flushPromises();
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onSave).toHaveBeenCalledWith('Hello');
    });

    it('a failed save keeps the typed text and offers a retry that saves it', async () => {
        const onSave = vi.fn(async () => false);
        act(() => { root.render(<NoteBodyField value="old" onSave={onSave} />); });
        type(area(), 'new words');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        expect(area().value).toBe('new words');
        expect(container.textContent).toMatch(/Not saved/);
        onSave.mockImplementation(async () => true);
        const retry = container.querySelector('.nb-retry') as HTMLButtonElement;
        act(() => { retry.click(); });
        await flushPromises();
        expect(onSave).toHaveBeenLastCalledWith('new words');
        expect(container.textContent).not.toMatch(/Not saved/);
    });

    it('closing the note saves what was typed', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        type(area(), 'last thought');
        act(() => { root.render(<></>); });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('last thought');
    });

    it('a trash of the list waits for text typed inside the save pause (flushBodySave)', async () => {
        let resolveSave!: (ok: boolean) => void;
        const onSave = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
        act(() => { root.render(<NoteBodyField listId={41} value="" onSave={onSave} />); });
        type(area(), 'typed a moment ago');
        // No timer has fired: the save would still be 800 ms away.
        let flushed = false;
        const flushing = flushBodySave(41).then(() => { flushed = true; });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('typed a moment ago');
        expect(flushed).toBe(false);   // ...and it waits for the save to LAND
        await act(async () => { resolveSave(true); await flushing; });
        expect(flushed).toBe(true);
        // POSITIVE CONTROL: another list's flush has nothing to wait for.
        await flushBodySave(42);
    });

    it('...also when the field has already unmounted (closing the note is what a trash does)', async () => {
        let resolveSave!: (ok: boolean) => void;
        const onSave = vi.fn(() => new Promise<boolean>(r => { resolveSave = r; }));
        act(() => { root.render(<NoteBodyField listId={43} value="" onSave={onSave} />); });
        type(area(), 'last words');
        act(() => { root.render(<></>); });
        let flushed = false;
        const flushing = flushBodySave(43).then(() => { flushed = true; });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('last words');
        expect(flushed).toBe(false);
        await act(async () => { resolveSave(true); await flushing; });
        expect(flushed).toBe(true);
    });

    it('text from another device replaces the field only when nothing is being typed here', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="v1" onSave={onSave} />); });
        act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
        expect(area().value).toBe('v2');
        type(area(), 'mine');
        act(() => { root.render(<NoteBodyField value="v3" onSave={onSave} />); });
        expect(area().value).toBe('mine');
    });

    it('unreadable text is locked: no field to type into', () => {
        act(() => { root.render(<NoteBodyField value={TASK_DECRYPT_FAILED} onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).toBeNull();
        expect(container.querySelector('.nb-locked')).not.toBeNull();
        // POSITIVE CONTROL: readable text is editable.
        act(() => { root.render(<NoteBodyField value="fine" onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).not.toBeNull();
    });
});
/** Whether the field currently offers an enabled Undo. */
function canUndoWithButton(): boolean {
    const b = histBtn('Undo');
    return !!b && !b.disabled;
}


describe('textHistory', () => {
    it('makes a burst of single characters ONE step, and a paste its own', () => {
        let h = newTextHistory('');
        h = pushText(h, 'H', 1000);
        h = pushText(h, 'He', 1100);
        h = pushText(h, 'Hey', 1200);
        expect(h.stack).toEqual(['', 'Hey']);
        // A paste is not one character, so it starts a step of its own.
        h = pushText(h, 'Hey there, everyone', 1250);
        expect(h.stack).toEqual(['', 'Hey', 'Hey there, everyone']);
        // ...and so does a character typed after a pause.
        h = pushText(h, 'Hey there, everyone!', 1250 + TEXT_HISTORY_COALESCE_MS);
        expect(h.stack.length).toBe(4);
    });

    it('never extends the first entry, so the text as it arrived is always reachable', () => {
        let h = newTextHistory('from the server');
        h = pushText(h, 'from the serverX', 1000);
        expect(h.stack).toEqual(['from the server', 'from the serverX']);
        expect(undoText(h).stack[undoText(h).index]).toBe('from the server');
    });

    it('typing after an undo drops what was undone', () => {
        let h = newTextHistory('a');
        h = pushText(h, 'ab', 1000);
        h = pushText(h, 'abc', 1000 + TEXT_HISTORY_COALESCE_MS);
        h = undoText(h);
        expect(canRedoText(h)).toBe(true);
        h = pushText(h, 'abZ', 9000);
        expect(canRedoText(h)).toBe(false);
        expect(h.stack).toEqual(['a', 'ab', 'abZ']);
    });

    it('is bounded: the oldest steps go, and the index follows them', () => {
        let h = newTextHistory('0');
        for (let i = 1; i <= TEXT_HISTORY_LIMIT + 40; i++) h = pushText(h, `paste number ${i}`, i * 10_000);
        expect(h.stack.length).toBe(TEXT_HISTORY_LIMIT);
        expect(h.index).toBe(TEXT_HISTORY_LIMIT - 1);
        expect(h.stack[h.index]).toBe(`paste number ${TEXT_HISTORY_LIMIT + 40}`);
    });

    it('POSITIVE CONTROL: a fresh history has nothing to undo or redo, and an unchanged push is a no-op', () => {
        const h = newTextHistory('same');
        expect(canUndoText(h)).toBe(false);
        expect(canRedoText(h)).toBe(false);
        expect(pushText(h, 'same', 1000)).toBe(h);
        expect(undoText(h)).toBe(h);
        expect(redoText(h)).toBe(h);
    });
});

describe('NoteBodyField undo and redo', () => {
    it('undo puts the text back after a paste, and the save that follows writes THAT text', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        typeStep(area(), 'my shopping list');
        typeStep(area(), 'everything replaced by a paste');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        expect(onSave).toHaveBeenLastCalledWith('everything replaced by a paste');

        act(() => { histBtn('Undo')!.click(); });
        expect(area().value).toBe('my shopping list');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        expect(onSave).toHaveBeenLastCalledWith('my shopping list');

        act(() => { histBtn('Redo')!.click(); });
        expect(area().value).toBe('everything replaced by a paste');
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        expect(onSave).toHaveBeenLastCalledWith('everything replaced by a paste');
    });

    it('Ctrl+Z and Ctrl+Shift+Z drive the field’s own history', () => {
        act(() => { root.render(<NoteBodyField value="first" onSave={vi.fn(async () => true)} />); });
        typeStep(area(), 'second');
        const key = (init: KeyboardEventInit) => act(() => {
            area().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        });
        key({ key: 'z', ctrlKey: true });
        expect(area().value).toBe('first');
        key({ key: 'Z', ctrlKey: true, shiftKey: true });
        expect(area().value).toBe('second');
        // POSITIVE CONTROL: a plain z is typing, not a command.
        key({ key: 'z' });
        expect(area().value).toBe('second');
    });

    it('text arriving from another device RESETS the history — undo cannot resurrect it over their save', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="v1" onSave={onSave} />); });
        typeStep(area(), 'mine');
        expect(canUndoWithButton()).toBe(true);
        // Saved, so the field is clean; their v2 lands and replaces it.
        act(() => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS); });
        await flushPromises();
        act(() => { root.render(<NoteBodyField value="v2" onSave={onSave} />); });
        expect(area().value).toBe('v2');
        expect(histBtn('Undo')).toBeNull();
    });

    it('the buttons appear only once there is something to go back to, and never when read-only', () => {
        act(() => { root.render(<NoteBodyField value="a note" onSave={vi.fn(async () => true)} />); });
        expect(histBtn('Undo')).toBeNull();
        typeStep(area(), 'a note, edited');
        expect(histBtn('Undo')).not.toBeNull();
        expect(histBtn('Redo')!.disabled).toBe(true);
        act(() => { root.render(<NoteBodyField value="a note" onSave={vi.fn(async () => true)} readOnly />); });
        expect(histBtn('Undo')).toBeNull();
        expect(histBtn('Redo')).toBeNull();
    });
});
