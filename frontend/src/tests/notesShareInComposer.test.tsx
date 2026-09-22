/**
 * The composer when something else opened it: a share from another app, a
 * launcher shortcut, the quick tile or the home-screen widget.
 *
 * The rule that matters most is the one asserted first: NOTHING IS SAVED
 * until the user presses Done. A share that wrote itself into the account
 * would let any app on the phone put a note there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuickAdd } from '../notes/components/QuickAdd';
import type { ComposeIntent } from '../notes/model/composeIntent';

const FULL = { text: true, pictures: true, camera: false };

let root: Root | null = null;
let host: HTMLDivElement;
const onCreate = vi.fn(async () => true);
const onInitialUsed = vi.fn();

function render(initial: ComposeIntent | null, content = FULL) {
    act(() => { root!.render(<QuickAdd onCreate={onCreate} content={content} initial={initial} onInitialUsed={onInitialUsed} />); });
}

beforeEach(() => {
    onCreate.mockClear();
    onInitialUsed.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // jsdom has no rAF timing worth waiting on; the focus calls are harmless.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.unstubAllGlobals();
});

const title = () => host.querySelector<HTMLInputElement>('input.notes-quickadd-title');
const body = () => host.querySelector<HTMLTextAreaElement>('textarea.notes-quickadd-body');
const items = () => [...host.querySelectorAll<HTMLInputElement>('.notes-quickadd-item input')];
const pics = () => host.querySelectorAll('.notes-quickadd-media img');
/** React owns the input's value; assigning it directly is invisible to it. */
function typeInto(el: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('a share seeds the composer', () => {
    it('opens it with the title and the body already in (positive control)', () => {
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk\nBread' });
        expect(title()?.value).toBe('Errand');
        expect(body()?.value).toBe('Milk\nBread');
    });

    it('NOTHING is saved until Done is pressed', () => {
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk' });
        expect(onCreate).not.toHaveBeenCalled();
        act(() => { host.querySelector<HTMLButtonElement>('.notes-textbtn')!.click(); });
        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('a shared picture shows as a chip in the composer', () => {
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        render({ seq: 1, mode: 'text', title: 'Snap', body: '', files: [file] });
        expect(pics()).toHaveLength(1);
    });

    it('a second, different share replaces rather than appends', () => {
        render({ seq: 1, mode: 'text', title: 'First', body: 'one' });
        render({ seq: 2, mode: 'text', title: 'Second', body: 'two' });
        expect(title()?.value).toBe('Second');
        expect(body()?.value).toBe('two');
    });

    it('re-rendering with the SAME seq does not re-seed over what the user typed', () => {
        const intent: ComposeIntent = { seq: 7, mode: 'text', title: 'Errand', body: 'Milk' };
        render(intent);
        act(() => { typeInto(title()!, 'Typed by hand'); });
        render(intent);
        expect(title()?.value).toBe('Typed by hand');
    });
});

describe('handing the payload on', () => {
    // The phone mounts BOTH composers (the inline card is only hidden by CSS)
    // and the inline one SAVES on a click outside. Without this hand-back the
    // owner cannot clear the payload, and the shared note was created twice
    // the moment the sheet closed.
    it('says once that it has taken the payload', () => {
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk' });
        expect(onInitialUsed).toHaveBeenCalledTimes(1);
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk' });
        expect(onInitialUsed).toHaveBeenCalledTimes(1);
    });

    it('says it again for a new payload (positive control)', () => {
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk' });
        render({ seq: 2, mode: 'list' });
        expect(onInitialUsed).toHaveBeenCalledTimes(2);
    });

    it('never says it when nothing was handed over', () => {
        render(null);
        expect(onInitialUsed).not.toHaveBeenCalled();
    });
});

describe('a mode this server cannot store', () => {
    it('shared text on a server with no note body becomes checklist items, not a dead textarea', () => {
        render({ seq: 1, mode: 'text', title: 'Errand', body: 'Milk\nBread' }, { text: false, pictures: true, camera: false });
        expect(body()).toBeNull();
        expect(items().map(i => i.value)).toEqual(['Milk', 'Bread']);
    });

    it('the draw target on a server with no attachments opens a checklist instead of the canvas', () => {
        render({ seq: 1, mode: 'draw' }, { text: true, pictures: false, camera: false });
        expect(document.querySelector('.notes-draw-backdrop')).toBeNull();
        expect(items()).not.toHaveLength(0);
    });
});

describe('the widget and shortcut targets', () => {
    it('the list target opens a checklist', () => {
        render({ seq: 1, mode: 'list' });
        expect(items()).not.toHaveLength(0);
        expect(body()).toBeNull();
    });

    it('the note target opens the text composer', () => {
        render({ seq: 1, mode: 'text' });
        expect(body()).not.toBeNull();
    });

    it('the draw target opens the drawing editor straight away', () => {
        render({ seq: 1, mode: 'draw' });
        // It is a portal on document.body, not a child of the composer.
        expect(document.querySelector('.notes-draw-backdrop canvas')).not.toBeNull();
    });

    it('no initial at all leaves the composer collapsed, exactly as before', () => {
        render(null);
        expect(host.querySelector('.notes-quickadd-collapsed')).not.toBeNull();
        expect(title()).toBeNull();
    });
});
