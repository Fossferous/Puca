/**
 * Formatting in the note text field every front door shares (NoteBodyField;
 * docs/STICKY_NOTES.md): Microsoft Sticky Notes' keys write the marks into
 * the text, the button handle does the same, Enter carries a bullet on, and
 * the read view draws the formatting with the marks taken off — where a
 * click still lands on the right character of the TEXT.
 *
 * And the save registry a trash waits on: every field that shows a note
 * registers, so a note open in Notes' editor and as a sticky note at once
 * keeps both fields' last words safe from a delete in either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));

import { NoteBodyField, type NoteBodyHandle } from '../components/NoteBodyField';
import { NoteFormattedText } from '../components/NoteFormattedText';
import { offsetOfNode } from '../components/noteTextOffset';
import { BODY_SAVE_DELAY_MS, flushBodySave, registerBodyFlush } from '../api/listContent';

let root: Root;
let container: HTMLDivElement;
const area = () => container.querySelector('textarea') as HTMLTextAreaElement;
const press = (el: HTMLElement, init: KeyboardEventInit) => act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});

beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

function mount(value: string, opts: { readOnly?: boolean } = {}) {
    const onSave = vi.fn(async () => true as const);
    const handle = createRef<NoteBodyHandle>();
    act(() => root.render(<NoteBodyField ref={handle} value={value} onSave={onSave} readOnly={opts.readOnly} autoFocus />));
    return { onSave, handle };
}

describe('the formatting keys in a note’s text', () => {
    it('Ctrl+B wraps the selection, keeps it on the same words, and saves', async () => {
        const { onSave } = mount('buy milk now');
        const el = area();
        el.focus();
        el.setSelectionRange(4, 8);
        press(el, { key: 'b', ctrlKey: true });
        expect(area().value).toBe('buy **milk** now');
        expect([area().selectionStart, area().selectionEnd]).toEqual([6, 10]);
        await act(async () => { vi.advanceTimersByTime(BODY_SAVE_DELAY_MS + 10); });
        expect(onSave).toHaveBeenCalledWith('buy **milk** now', undefined);
    });

    it('Ctrl+I, Ctrl+U and Ctrl+T; Ctrl+Shift+L for bullets', () => {
        mount('one\ntwo');
        const el = area();
        el.focus();
        el.setSelectionRange(0, 3);
        press(el, { key: 'u', ctrlKey: true });
        expect(area().value).toBe('<u>one</u>\ntwo');
        area().setSelectionRange(0, area().value.length);
        press(area(), { key: 'L', ctrlKey: true, shiftKey: true });
        expect(area().value).toBe('- <u>one</u>\n- two');
        area().setSelectionRange(area().value.length - 3, area().value.length);
        press(area(), { key: 't', ctrlKey: true });
        expect(area().value).toBe('- <u>one</u>\n- ~~two~~');
    });

    it('Enter on a bullet starts the next one; on an empty bullet it ends the list', () => {
        mount('- milk');
        const el = area();
        el.focus();
        el.setSelectionRange(6, 6);
        press(el, { key: 'Enter' });
        expect(area().value).toBe('- milk\n- ');
        press(area(), { key: 'Enter' });
        expect(area().value).toBe('- milk\n');
    });

    it('a plain Enter, or one outside a bullet, is left to the field', () => {
        mount('plain');
        const el = area();
        el.focus();
        el.setSelectionRange(5, 5);
        const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        act(() => { el.dispatchEvent(e); });
        expect(e.defaultPrevented).toBe(false);
        expect(area().value).toBe('plain');
    });

    it('a press that changes nothing leaves no selection waiting to land on the next keystroke', () => {
        mount('a   b');
        const el = area();
        el.focus();
        el.setSelectionRange(1, 4);
        press(el, { key: 'b', ctrlKey: true });
        expect(area().value).toBe('a   b');
        // Typing next: the caret is where the typing left it, not the old range.
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        act(() => { setter.call(area(), 'a   bx'); area().setSelectionRange(6, 6); area().dispatchEvent(new Event('input', { bubbles: true })); });
        expect([area().selectionStart, area().selectionEnd]).toEqual([6, 6]);
    });

    it('CONTROL: read-only text takes no mark', () => {
        mount('buy milk', { readOnly: true });
        const el = area();
        el.setSelectionRange(0, 3);
        press(el, { key: 'b', ctrlKey: true });
        expect(area().value).toBe('buy milk');
    });

    it('the handle formats the selection, as a button keeping the focus would', () => {
        const { handle } = mount('a word');
        const el = area();
        el.focus();
        el.setSelectionRange(2, 6);
        act(() => handle.current!.format('italic'));
        expect(area().value).toBe('a *word*');
        act(() => handle.current!.format('italic'));
        expect(area().value).toBe('a word');
    });

    it('the toolbar marks the selected words in a text stored with CRLF line breaks', () => {
        const { handle } = mount('a\r\nb\r\nx yz');
        const el = area();
        el.focus();
        // The field counts each line break as one character.
        const at = el.value.indexOf('yz');
        el.setSelectionRange(at, at + 2);
        act(() => handle.current!.format('bold'));
        expect(area().value.endsWith('x **yz**')).toBe(true);
    });

    it('reads formatted when not being typed in: the marks are gone and the words are bold', () => {
        mount('buy **milk** now');
        act(() => { area().blur(); });
        expect(container.querySelector('textarea')).toBeNull();
        const read = container.querySelector('.nb-rendered') as HTMLElement;
        expect(read.textContent).toBe('buy milk now');
        expect(read.querySelector('strong')?.textContent).toBe('milk');
    });

    it('CONTROL: text with no formatting and no link never leaves the field', () => {
        mount('just words');
        act(() => { area().blur(); });
        expect(container.querySelector('textarea')).not.toBeNull();
    });
});

describe('where a click on formatted text lands in the TEXT', () => {
    it('maps a character inside a run back past the marks', () => {
        act(() => root.render(<p><NoteFormattedText text={'buy **milk** now\n- <u>eggs</u>'} /></p>));
        const strong = container.querySelector('strong')!;
        const textNode = strong.querySelector('span')!.firstChild!;
        // "l" of milk: offset 2 into the run that starts at 6.
        expect(offsetOfNode(textNode, 2)).toBe(8);
        const u = container.querySelector('u')!;
        expect(offsetOfNode(u.querySelector('span')!.firstChild!, 0)).toBe('buy **milk** now\n- <u>'.length);
        // The bullet's dot stands for the "- " it replaced.
        const dot = container.querySelector('.nf-bullet')!;
        expect(offsetOfNode(dot.firstChild!, 0)).toBe('buy **milk** now\n'.length + 2);
    });

    it('a click on a blank line lands on that line, not at the end of the note', () => {
        act(() => root.render(<p><NoteFormattedText text={'**one**\n\nthree'} /></p>));
        const breaks = [...container.querySelectorAll('span[data-at]')].filter(s => s.textContent === '\n');
        expect(breaks).toHaveLength(2);
        // After the first break: the start of the blank line (8); after the second, of "three" (9).
        expect(offsetOfNode(breaks[0].firstChild!, 1)).toBe(8);
        expect(offsetOfNode(breaks[1].firstChild!, 1)).toBe(9);
    });
});

describe('a trash waits for EVERY field showing the note', () => {
    it('two fields: both are waited for, and closing one keeps the other', async () => {
        const order: string[] = [];
        const offA = registerBodyFlush(901, async () => { order.push('sticky note'); });
        const offB = registerBodyFlush(901, async () => { order.push('editor'); });
        await flushBodySave(901);
        expect(order.sort()).toEqual(['editor', 'sticky note']);
        order.length = 0;
        // The editor closes; the sticky note's pending words must still be
        // waited for (with one slot per note they were not).
        offB();
        await flushBodySave(901);
        expect(order).toEqual(['sticky note']);
        offA();
        order.length = 0;
        await flushBodySave(901);
        expect(order).toEqual([]);
    });
});
