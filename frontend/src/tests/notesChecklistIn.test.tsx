/**
 * A step-by-step checklist from elsewhere — an assistant's answer above all
 * (the owner's ask: "if I ask for a step by step checklist, straight into my
 * notes") — lands in Notes AS a checklist.
 *
 * Before: a share opened one text note of raw Markdown ("1. **Unplug**…"),
 * and a paste kept the "1.", the "**", the "## Setup" heading and the
 * "Here's how:" intro as items. Now readChecklist (noteContent.ts) reads it
 * the way Notes writes a checklist out (noteToMarkdown: "# Title", then
 * "- [ ] item"), and share-in and paste open the composer on the result.
 * NEVER saved without Done: an app cannot write into the account by itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bodyToItems, plainInline, readChecklist } from '../notes/model/noteContent';
import { takeShare, type ComposeIntent } from '../notes/model/composeIntent';
import { QuickAdd } from '../notes/components/QuickAdd';

/** What an assistant typically answers "a checklist for setting up a router" with. */
const ASSISTANT = `Here's a checklist for setting up your new router:

1. **Unplug** the old router and wait 30 seconds
2. Connect the new router to the modem with the \`WAN\` port
   - Use the cable in the box
3. Log in at [the admin page](http://192.168.1.1)
4. Change the admin password

That's it — you're done!`;

describe('readChecklist', () => {
    it("reads an assistant's step-by-step answer: title from the intro, steps clean", () => {
        expect(readChecklist(ASSISTANT)).toEqual({
            title: 'Checklist for setting up your new router',
            items: [
                'Unplug the old router and wait 30 seconds',
                'Connect the new router to the modem with the WAN port',
                'Use the cable in the box',
                'Log in at the admin page (http://192.168.1.1)',
                'Change the admin password',
            ],
        });
    });

    it("reads Notes' own export back (the round trip)", () => {
        expect(readChecklist('# Groceries\n- [ ] Milk\n- [x] Bread\n  - [ ] Wholemeal')).toEqual({
            title: 'Groceries', items: ['Milk', 'Bread', 'Wholemeal'],
        });
    });

    it('keeps sections as items, drops one left empty at the end', () => {
        const text = '# Move house\n## Before\n- [ ] Book van\n- [ ] Pack\n\n## On the day\n- [ ] Load\n\n## Notes\n';
        expect(readChecklist(text)).toEqual({
            title: 'Move house', items: ['Before:', 'Book van', 'Pack', 'On the day:', 'Load'],
        });
    });

    it('a command under a step, and a wrapped line, join that step', () => {
        const text = 'Steps:\n1. Install it\n   ```\n   npm i puca\n   ```\n2. Run it\n   and wait for the prompt';
        expect(readChecklist(text)).toEqual({ title: 'Steps', items: ['Install it — npm i puca', 'Run it — and wait for the prompt'] });
    });

    it('strips the chat lead-in from a title', () => {
        expect(readChecklist('Sure! Here are the steps:\n- one\n- two')?.title).toBe('Steps');
        expect(readChecklist('- socks\n- charger')?.title).toBeNull();
    });

    it('a bare short line is an ITEM, not a title; a sentence is prose', () => {
        // The grocery paste the existing ask-first test uses: "Milk" is an item.
        expect(readChecklist('Milk\n- Bread\n[x] Eggs')).toEqual({ title: null, items: ['Milk', 'Bread', 'Eggs'] });
        // "Packing list" alone is ambiguous; only a heading or a colon makes a title.
        expect(readChecklist('Packing list\n- socks\n- charger')).toEqual({ title: null, items: ['Packing list', 'socks', 'charger'] });
        expect(readChecklist('Packing list:\n- socks\n- charger')?.title).toBe('Packing list');
        // A closing sentence is dropped, not boxed.
        expect(readChecklist('- a\n- b\nYou are all set now!')?.items).toEqual(['a', 'b']);
        // A colon line INSIDE the list is a section.
        expect(readChecklist('- a\n- b\nOptional extras:\n- c')?.items).toEqual(['a', 'b', 'Optional extras:', 'c']);
    });

    it('prose stays prose (not a checklist)', () => {
        expect(readChecklist('Just a thought about tomorrow.')).toBeNull();
        expect(readChecklist('Intro line.\n- the only bullet\nMore prose.')).toBeNull();
        // Two bullets, but outnumbered by prose around them.
        expect(readChecklist('I think we should go.\nThe weather looks fine.\nLet us decide tonight.\n- a\n- b')).toBeNull();
        expect(readChecklist('')).toBeNull();
    });

    it('drops inline Markdown without eating arithmetic or snake_case', () => {
        expect(plainInline('**bold** and *em* and ~~gone~~ and `code`')).toBe('bold and em and gone and code');
        expect(plainInline('2 * 3 * 4')).toBe('2 * 3 * 4');
        expect(plainInline('rename snake_case_name')).toBe('rename snake_case_name');
        expect(plainInline('[https://x.y](https://x.y)')).toBe('https://x.y');
        expect(plainInline('![a chart](c.png) here')).toBe('a chart here');
    });

    it('"Show checkboxes" and a plain paste lose numbers and heading marks too', () => {
        expect(bodyToItems('1. One\n2) Two\n# Head\n+ Plus\n- [ ] Box')).toEqual(['One', 'Two', 'Head', 'Plus', 'Box']);
        // Unchanged for what it already handled.
        expect(bodyToItems('Milk\n  - Bread\n* Eggs\n• Tea')).toEqual(['Milk', 'Bread', 'Eggs', 'Tea']);
    });
});

describe('a share opens a checklist', () => {
    const FULL = { text: true, pictures: true };
    function deps() {
        const open = vi.fn();
        return { open, deps: { ensureContent: async () => FULL, fallback: () => FULL, open, refusePicture: vi.fn() } };
    }

    it('when the native side already took the first line as the title', async () => {
        const { open, deps: d } = deps();
        const [first, ...rest] = ASSISTANT.split('\n');
        await takeShare({ title: first, body: rest.join('\n').trim(), files: [] }, d);
        expect(open).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'list', title: 'Checklist for setting up your new router',
        }));
        expect(open.mock.calls[0][0].items).toHaveLength(5);
    });

    it('a first line that is a step goes back into the list', async () => {
        const { open, deps: d } = deps();
        await takeShare({ title: '1. Unplug it', body: '2. Wait\n3. Plug in', files: [] }, d);
        expect(open.mock.calls[0][0]).toMatchObject({ mode: 'list', title: '', items: ['Unplug it', 'Wait', 'Plug in'] });
    });

    it('a plain first line the native side split off is the title', async () => {
        const { open, deps: d } = deps();
        await takeShare({ title: 'Packing list', body: '- socks\n- charger', files: [] }, d);
        expect(open.mock.calls[0][0]).toMatchObject({ mode: 'list', title: 'Packing list', items: ['socks', 'charger'] });
    });

    it('a heading beats the sharing app\'s subject; "# " never reaches the title', async () => {
        const { open, deps: d } = deps();
        await takeShare({ title: 'Claude', body: '# Trip\n- passport\n- tickets', files: [] }, d);
        expect(open.mock.calls[0][0]).toMatchObject({ mode: 'list', title: 'Trip', items: ['passport', 'tickets'] });
        await takeShare({ title: '# Router setup', body: '- [ ] a\n- [ ] b', files: [] }, d);
        expect(open.mock.calls[1][0]).toMatchObject({ title: 'Router setup' });
    });

    it('positive control: shared prose still opens a text note', async () => {
        const { open, deps: d } = deps();
        await takeShare({ title: 'Thought', body: 'Just some text.', files: [] }, d);
        expect(open.mock.calls[0][0]).toMatchObject({ mode: 'text', title: 'Thought', body: 'Just some text.' });
    });
});

describe('the composer', () => {
    const FULL = { text: true, pictures: true, camera: false };
    let root: Root;
    let host: HTMLDivElement;
    const onCreate = vi.fn(async (_t: string, _i: string[]) => true);

    beforeEach(() => {
        onCreate.mockClear();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    });

    const render = (initial: ComposeIntent | null) =>
        act(() => { root.render(<QuickAdd onCreate={onCreate} content={FULL} initial={initial} openSignal={initial ? 0 : 1} />); });
    const title = () => host.querySelector<HTMLInputElement>('input.notes-quickadd-title')!;
    const items = () => [...host.querySelectorAll<HTMLInputElement>('.notes-quickadd-item input')].map(i => i.value);
    const done = () => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Done') as HTMLButtonElement;
    function paste(el: Element, text: string) {
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: () => text } });
        act(() => { el.dispatchEvent(ev); });
        return ev;
    }
    function typeInto(el: HTMLInputElement, value: string) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
    }

    it('a shared checklist opens as one, and is saved only on Done', async () => {
        render({ seq: 1, mode: 'list', title: 'Trip', items: ['passport', 'tickets'] });
        expect(title().value).toBe('Trip');
        expect(items()).toEqual(['passport', 'tickets']);
        expect(onCreate).not.toHaveBeenCalled();
        await act(async () => { done().click(); });
        expect(onCreate).toHaveBeenCalledWith('Trip', ['passport', 'tickets'], undefined);
    });

    const addButton = (n: number) =>
        [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === `Add ${n} items`) as HTMLButtonElement | undefined;

    it('pasted into the TITLE: asks first (the clean steps shown), then the checklist becomes the note', async () => {
        render(null);
        const ev = paste(title(), ASSISTANT);
        expect(ev.defaultPrevented, 'not one long title line').toBe(true);
        // The prompt is a portal on document.body, outside `host`.
        expect(document.body.textContent).toContain('Add these as items?');
        expect(document.body.textContent).toContain('Unplug the old router and wait 30 seconds');
        expect(document.body.textContent).not.toContain('**');
        act(() => { addButton(5)!.click(); });
        expect(title().value).toBe('Checklist for setting up your new router');
        expect(items()).toHaveLength(5);
        expect(items()[0]).toBe('Unplug the old router and wait 30 seconds');
        expect(onCreate).not.toHaveBeenCalled();
        await act(async () => { done().click(); });
        expect(onCreate).toHaveBeenCalledWith('Checklist for setting up your new router', expect.arrayContaining(['Change the admin password']), undefined);
    });

    it('pasted into an item of a new note: the same one question, then title and steps', () => {
        render(null);
        const first = host.querySelector('.notes-quickadd-item input')!;
        paste(first, '# Trip\n- passport\n- tickets');
        act(() => { addButton(2)!.click(); });
        expect(title().value).toBe('Trip');
        expect(items()).toEqual(['passport', 'tickets']);
    });

    it('into a draft already being written, it asks first — and still fills the empty title', () => {
        render(null);
        const first = host.querySelector<HTMLInputElement>('.notes-quickadd-item input')!;
        typeInto(first, 'my own item');
        paste(first, '# Trip\n1. passport\n2. tickets');
        // The prompt is a portal on document.body, outside `host`.
        expect(document.body.textContent).toContain('Add these as items?');
        const add = [...document.querySelectorAll('button')].find(b => /Add 2 items/.test(b.textContent ?? ''))!;
        act(() => { add.click(); });
        expect(items()).toEqual(['my own item', 'passport', 'tickets']);
        expect(title().value).toBe('Trip');
    });

    it('positive control: an ordinary title paste is left alone', () => {
        render(null);
        const ev = paste(title(), 'Weekend plans');
        expect(ev.defaultPrevented).toBe(false);
    });
});
