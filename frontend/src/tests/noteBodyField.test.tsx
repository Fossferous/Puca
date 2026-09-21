/**
 * The note-text field Púca Notes and Púca's Tasks view share: it saves a
 * pause after typing (not per keystroke), a failed save KEEPS what was typed
 * and offers a retry, and unreadable text is shown locked, never editable —
 * an edit there would seal the marker over the real ciphertext.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NoteBodyField } from '../components/NoteBodyField';
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
/** jsdom does no layout, so a real textarea's scrollHeight is always 0 and a
 *  height assertion could not tell "sized" from "never sized". Stand in for
 *  it with a height that grows with the text, the way a browser's does. */
const LINE_PX = 21;
const stubScrollHeight = () => Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) { return this.value.split('\n').length * LINE_PX; },
});
const flushPromises = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
    vi.useFakeTimers();
    stubScrollHeight();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    delete (HTMLTextAreaElement.prototype as Partial<HTMLTextAreaElement>).scrollHeight;
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

    it('a body with NO link never leaves the textarea', () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="Buy milk" onSave={onSave} />); });
        expect(container.querySelector('textarea')).not.toBeNull();
        act(() => { area().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(container.querySelector('textarea')).not.toBeNull();
        expect(container.querySelector('.nb-rendered')).toBeNull();
    });

    it('typing a URL and blurring SAVES it and then shows it as a link', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="" onSave={onSave} />); });
        type(area(), 'read https://example.com/a');
        // The blur flush must run BEFORE the read view replaces the textarea,
        // or the last words typed are the ones that get lost.
        act(() => { area().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        await flushPromises();
        expect(onSave).toHaveBeenCalledWith('read https://example.com/a');
        expect(container.querySelector('textarea')).toBeNull();
        const a = container.querySelector('.nb-rendered a.note-link') as HTMLAnchorElement;
        expect(a?.getAttribute('href')).toBe('https://example.com/a');
    });

    it('clicking the read view (not the link) puts a focused textarea back, with the text intact', async () => {
        const onSave = vi.fn(async () => true);
        act(() => { root.render(<NoteBodyField value="read https://example.com/a" onSave={onSave} />); });
        const read = container.querySelector('.nb-rendered') as HTMLElement;
        expect(read).not.toBeNull();
        act(() => { read.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(area()).not.toBeNull();
        expect(area().value).toBe('read https://example.com/a');
        expect(document.activeElement).toBe(area());
    });

    it('the textarea comes back at the HEIGHT of the text, not at two rows', () => {
        // The regression this pins: the read/edit swap mounts a FRESH
        // textarea without changing the text, so an auto-height effect keyed
        // on the text alone never fires for it — and `.nb-text` is
        // `overflow: hidden`, so a ten-line note would show two lines with
        // the rest clipped until the next keystroke.
        const body = ['read https://example.com/a', ...Array.from({ length: 9 }, (_, i) => `line ${i}`)].join('\n');
        act(() => { root.render(<NoteBodyField value={body} onSave={vi.fn(async () => true)} />); });
        const read = container.querySelector('.nb-rendered') as HTMLElement;
        expect(read).not.toBeNull();
        act(() => { read.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(area().style.height).toBe(`${10 * LINE_PX}px`);
        // POSITIVE CONTROL: the number tracks the CONTENT, so the assertion
        // above cannot be passing on a constant.
        type(area(), 'one line');
        expect(area().style.height).toBe(`${LINE_PX}px`);
    });

    it('unreadable text is locked: no field to type into', () => {
        act(() => { root.render(<NoteBodyField value={TASK_DECRYPT_FAILED} onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).toBeNull();
        expect(container.querySelector('.nb-locked')).not.toBeNull();
        // POSITIVE CONTROL: readable text is editable.
        act(() => { root.render(<NoteBodyField value="fine" onSave={vi.fn()} />); });
        expect(container.querySelector('textarea')).not.toBeNull();
        // …and a marker is never linkified, whatever it happens to contain.
        expect(container.querySelector('a.note-link')).toBeNull();
    });
});
